-- Migration: add Kick as a third monitored platform.
--
-- Additive migration -- run ONCE against a live database with:
--   npx wrangler d1 execute neurocasper-db --remote --file=./migrations/001_add_kick.sql
-- (drop --remote to test against the local dev database first, which is
-- strongly recommended before running this against --remote).
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
PRAGMA foreign_keys = ON;

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
