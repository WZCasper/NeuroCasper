-- NeuroCasper D1 schema
-- Apply with:
--   npx wrangler d1 execute neurocasper-db --local  --file=./schema.sql
--   npx wrangler d1 execute neurocasper-db --remote --file=./schema.sql
--
-- Safe to re-run: drops and recreates everything. Fine while there's no
-- real user data yet; once this is live, switch to additive migrations
-- instead of touching this file directly.

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS post_platforms;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS extra_links;
DROP TABLE IF EXISTS social_accounts;
DROP TABLE IF EXISTS streamers;
DROP TABLE IF EXISTS channels;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS twitch_token;

-- Telegram users who have talked to the bot. `session_state` backs the
-- multi-step /add_channel, /add_social and /settings text-input flows
-- (JSON blob: {"step": "...", "data": {...}}), since Workers are stateless
-- between requests and can't hold conversation state in memory.
CREATE TABLE users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id  INTEGER NOT NULL UNIQUE,
  username          TEXT,
  first_name        TEXT,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  session_state     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Destination Telegram channels/groups. A row is created by an admin
-- running /add_channel *inside* the target chat (verified via
-- getChatMember), not by pasting a chat ID in DM.
CREATE TABLE channels (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_chat_id  INTEGER NOT NULL,
  title             TEXT,
  message_template  TEXT NOT NULL DEFAULT '{title}',
  auto_pin          INTEGER NOT NULL DEFAULT 1,
  auto_unpin        INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_user_id, telegram_chat_id)
);

-- A real-world streamer/creator tracked for a destination channel. Groups
-- one or more *monitored* platform accounts (YouTube/TikTok) that belong to
-- the same person, so simultaneous activity across platforms posts as ONE
-- Telegram message with one button per platform instead of duplicate
-- messages. See extra_links below for platforms that aren't monitored but
-- should still get a button (this is where Twitch lives now).
CREATE TABLE streamers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One *monitored* platform account belonging to a streamer — the bot
-- actively checks these for live/new-video activity.
CREATE TABLE social_accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id         INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL CHECK (platform IN ('youtube','tiktok')),
  platform_user_id    TEXT,   -- YouTube channel ID (UC...); unused for tiktok
  platform_username   TEXT NOT NULL,
  last_video_id       TEXT,   -- last seen video/room id, for de-duping
  last_checked_at     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(streamer_id, platform)
);

-- A static link attached to a streamer that ISN'T independently monitored
-- (Twitch — dropped as a monitored platform since registering a Twitch app
-- needs 2FA the streamer couldn't enable — or anything else: Discord,
-- Instagram, a second channel, etc). Shown as an extra button on every
-- alert for that streamer, live or video, regardless of which monitored
-- platform actually triggered the post. This is a deliberate trade: no
-- verification that e.g. Twitch is *actually* live at that moment, just an
-- assumption that a simulcasting streamer is live everywhere they usually
-- are whenever any one of their monitored platforms is.
CREATE TABLE extra_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id   INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,   -- e.g. "Twitch", "Discord"
  url           TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One posted Telegram message representing a streamer's "live now" session
-- or "new video" announcement. `kind` decides how it can be merged: a
-- 'live' post stays open for merging for as long as is_open=1 (i.e. for as
-- long as at least one monitored platform under it is still live); a
-- 'video' post is only open for merging for a short time window after
-- creation (see VIDEO_POST_MERGE_WINDOW_MINUTES in src/db.ts /
-- scripts/lib/db.ts), since uploads don't have a natural "end" event.
CREATE TABLE posts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id          INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  channel_id           INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('live','video')),
  telegram_chat_id     INTEGER NOT NULL,
  telegram_message_id  INTEGER NOT NULL,
  is_open              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at            TEXT
);

-- One row per *monitored* platform folded into a post. A single-platform
-- stream has one row; a YouTube+TikTok simulcast has two rows under the
-- same post_id. extra_links are NOT rows here — they're appended to the
-- button list at send time without being tracked as "live sessions" (see
-- src/lib/publish.ts).
CREATE TABLE post_platforms (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id             INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  social_account_id   INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL,
  content_id          TEXT,     -- YouTube video id / TikTok item id
  url                 TEXT NOT NULL,
  ended               INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(post_id, social_account_id)
);

CREATE INDEX idx_channels_owner       ON channels(owner_user_id);
CREATE INDEX idx_streamers_channel    ON streamers(channel_id);
CREATE INDEX idx_social_streamer      ON social_accounts(streamer_id);
CREATE INDEX idx_social_platform      ON social_accounts(platform);
CREATE INDEX idx_extra_links_streamer ON extra_links(streamer_id);
CREATE INDEX idx_posts_streamer_open  ON posts(streamer_id, kind, is_open);
CREATE INDEX idx_post_platforms_post  ON post_platforms(post_id, ended);
CREATE INDEX idx_post_platforms_acct  ON post_platforms(social_account_id, ended);
