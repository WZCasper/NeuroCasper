-- Migration: add Kick as a third monitored platform.
--
-- Additive migration -- run ONCE against a live database with:
--   npx wrangler d1 execute neurocasper-db --remote --file=./migrations/001_add_kick.sql
-- (drop --remote to test against the local dev database first, which is
-- strongly recommended before running this against --remote).
--
-- Already applied to this project's own production database (its
-- original, broken version -- see below) -- do NOT re-run this file
-- against it. The damage that version did was repaired directly, by
-- hand, once found; this corrected version exists so a FRESH deploy
-- starting from an old (pre-Kick) database never hits the same bug.
--
-- Unlike schema.sql, this file does NOT drop and recreate everything --
-- it only touches what's needed to add Kick, and preserves all existing
-- rows (streamers, social_accounts, posts, post_platforms, etc).
--
-- Why social_accounts must be rebuilt: SQLite has no `ALTER TABLE ... ADD
-- CONSTRAINT` or any way to widen an existing CHECK constraint in place --
-- the CHECK on the `platform` column only allows 'youtube' and 'tiktok'.
-- The standard SQLite-documented way to change a CHECK constraint is:
-- rename the old table out of the way, create a new one with the same
-- name and the updated CHECK, copy every row across preserving its
-- original `id` (critical -- post_platforms.social_account_id and other
-- foreign keys point at these ids and must keep resolving correctly),
-- then drop the renamed-away original. wrangler d1 execute wraps an
-- entire --file in one implicit transaction, so if any statement below
-- fails, nothing in this file is applied -- see the "Cloudflare D1 has no
-- BEGIN TRANSACTION" note in Cloudflare's own D1 docs.
--
-- Why post_platforms is copied out to a plain staging table (with NO
-- foreign key of its own) and dropped BEFORE social_accounts is touched
-- at all, rather than being renamed like social_accounts is -- this is
-- the actual fix, confirmed by reproducing the failure, several
-- different ways, against a local SQLite database running inside an
-- explicit BEGIN/COMMIT (D1 always runs inside an implicit transaction,
-- so this is the behavior that matters, not what a bare, no-transaction
-- .exec() shows):
--   * post_platforms.social_account_id is declared
--     `REFERENCES social_accounts(id) ON DELETE CASCADE`. The instant
--     `ALTER TABLE social_accounts RENAME TO social_accounts_old;` runs,
--     SQLite rewrites that reference, in place, to point at
--     "social_accounts_old" -- confirmed directly via
--     `PRAGMA foreign_key_list(post_platforms)` immediately before and
--     after the rename. This happens regardless of whether
--     post_platforms itself has also been renamed by that point: the
--     rewrite is driven entirely by social_accounts' own rename, not by
--     post_platforms' name.
--   * The later `DROP TABLE social_accounts_old;` then triggers that
--     CASCADE for real -- not a dangling-reference error, an actual
--     enforced delete -- wiping every row in whatever table currently
--     holds that rewritten reference. This is what emptied
--     post_platforms in production.
--   * `PRAGMA foreign_keys = OFF` cannot prevent this on D1: D1's own
--     docs (Reference / Foreign keys) state outright that because every
--     query runs inside an implicit transaction, this pragma cannot be
--     changed mid-migration -- confirmed here too, reproduced locally
--     inside an explicit transaction.
--   * `PRAGMA defer_foreign_keys` doesn't help either: it only postpones
--     the CHECK for dangling references until commit, it does not stop
--     ON DELETE CASCADE from firing the moment the DROP runs -- also
--     reproduced locally, with the same rows-go-to-zero result.
--   * The only sequence that actually preserves the rows: copy
--     post_platforms into a plain `CREATE TABLE ... AS SELECT *` staging
--     table (no column constraints, no foreign key of any kind) and drop
--     the real post_platforms BEFORE social_accounts is renamed. With no
--     table named post_platforms in existence at all while
--     social_accounts gets rebuilt, there is nothing left for that
--     CASCADE to find and empty when social_accounts_old is dropped.
--     post_platforms is then recreated, pointed at the new
--     social_accounts, and refilled from the staging table.
--
-- This is also the confirmed root cause of a real production incident:
-- post_platforms has been permanently empty since this migration's
-- original, broken run, so no live-stream or new-video notification has
-- been posted since -- every attempt failed to record its
-- post_platforms row (a foreign-key violation against the dangling
-- "social_accounts_old" name, in the FIRST broken version of this file;
-- a silent CASCADE-to-zero in a second attempted fix that used
-- PRAGMA foreign_keys/defer_foreign_keys), the failure was only logged,
-- and the Telegram message had already gone out by that point
-- regardless.
PRAGMA foreign_keys = ON;

-- Moved out of post_platforms' way BEFORE social_accounts is touched at
-- all -- see the long comment above for why the order matters here, not
-- just the destination shape.
CREATE TABLE _staging_post_platforms AS SELECT * FROM post_platforms;
DROP TABLE post_platforms;

ALTER TABLE social_accounts RENAME TO social_accounts_old;

CREATE TABLE social_accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id         INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL CHECK (platform IN ('youtube','tiktok','kick')),
  platform_user_id    TEXT,   -- YouTube channel ID (UC...) / Kick broadcaster_user_id; unused for tiktok
  platform_username   TEXT NOT NULL,
  last_video_id       TEXT,   -- last seen video/room id, for de-duping
  last_checked_at     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(streamer_id, platform)
);

INSERT INTO social_accounts (
  id, streamer_id, platform, platform_user_id, platform_username,
  last_video_id, last_checked_at, created_at
)
SELECT
  id, streamer_id, platform, platform_user_id, platform_username,
  last_video_id, last_checked_at, created_at
FROM social_accounts_old;

DROP TABLE social_accounts_old;

CREATE INDEX idx_social_streamer ON social_accounts(streamer_id);
CREATE INDEX idx_social_platform ON social_accounts(platform);

-- Now that the new social_accounts exists under its real name, rebuild
-- post_platforms pointed at it and refill it from the staging copy.
CREATE TABLE post_platforms (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id             INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  social_account_id   INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL,
  content_id          TEXT,
  url                 TEXT NOT NULL,
  ended               INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(post_id, social_account_id)
);

INSERT INTO post_platforms (
  id, post_id, social_account_id, platform, content_id, url, ended, created_at
)
SELECT
  id, post_id, social_account_id, platform, content_id, url, ended, created_at
FROM _staging_post_platforms;

DROP TABLE _staging_post_platforms;

CREATE INDEX idx_post_platforms_post ON post_platforms(post_id, ended);
CREATE INDEX idx_post_platforms_acct ON post_platforms(social_account_id, ended);

-- One row per Kick channel the bot has been authorized for. Unlike
-- YouTube (public RSS feed) and TikTok (public profile page), Kick's
-- events:subscribe webhook is per-authorized-user: the broadcaster (the
-- streamer themself, not whoever runs this bot) must complete Kick's
-- OAuth flow once so the bot can subscribe to their livestream.status.
-- updated event. See src/lib/kick.ts for the OAuth + webhook-subscribe
-- flow that fills this table.
CREATE TABLE kick_tokens (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  social_account_id     INTEGER NOT NULL UNIQUE REFERENCES social_accounts(id) ON DELETE CASCADE,
  broadcaster_user_id   INTEGER NOT NULL,
  access_token          TEXT NOT NULL,
  refresh_token         TEXT NOT NULL,
  expires_at            TEXT NOT NULL,  -- ISO datetime; refresh before this
  event_subscription_id TEXT,           -- Kick's id for the livestream.status.updated subscription, for cleanup
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_kick_tokens_broadcaster ON kick_tokens(broadcaster_user_id);

-- Short-lived CSRF-protection row for Kick's OAuth flow: created right
-- before redirecting the streamer to Kick's authorization page, read back
-- (and deleted) when Kick redirects back to /kick/oauth/callback with this
-- same `state` value. Ties the callback to the streamer_id and the
-- Telegram user who started the flow, since the OAuth round trip happens
-- in the streamer's own browser, outside any Telegram session. Also carries
-- the PKCE code_verifier generated alongside `state`, since the token
-- exchange at the callback step needs the exact same value used to derive
-- the code_challenge in the authorization URL. Rows older than a few
-- minutes are treated as expired regardless of whether they're deleted
-- (see src/lib/kick.ts).
CREATE TABLE kick_oauth_states (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  streamer_id   INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  requested_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
