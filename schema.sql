-- NeuroCasper D1 schema
-- Apply with:
--   npx wrangler d1 execute neurocasper-db --local  --file=./schema.sql
--   npx wrangler d1 execute neurocasper-db --remote --file=./schema.sql

PRAGMA foreign_keys = ON;

-- Telegram users who have talked to the bot. `session_state` backs the
-- multi-step /add_channel, /add_social and /settings text-input flows
-- (JSON blob: {"step": "...", "data": {...}}), since Workers are stateless
-- between requests and can't hold conversation state in memory.
CREATE TABLE IF NOT EXISTS users (
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
CREATE TABLE IF NOT EXISTS channels (
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
-- one or more platform accounts (Twitch/YouTube/TikTok) that belong to the
-- same person, so simultaneous activity across platforms can be posted as
-- ONE Telegram message with one button per platform instead of duplicate
-- messages.
CREATE TABLE IF NOT EXISTS streamers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One platform account belonging to a streamer.
CREATE TABLE IF NOT EXISTS social_accounts (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_id               INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  platform                  TEXT NOT NULL CHECK (platform IN ('twitch','youtube','tiktok')),
  platform_user_id          TEXT,   -- Twitch broadcaster_user_id / YouTube channel ID (UC...)
  platform_username         TEXT NOT NULL,
  eventsub_subscription_id  TEXT,   -- Twitch only: EventSub subscription UUID
  last_video_id             TEXT,   -- YouTube/TikTok: last seen video/room id, for de-duping
  last_checked_at           TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(streamer_id, platform)
);

-- One posted Telegram message representing a streamer's "live now" session
-- or "new video" announcement. `kind` decides how it can be merged: a
-- 'live' post stays open for merging for as long as is_open=1 (i.e. for as
-- long as at least one platform under it is still live); a 'video' post is
-- only open for merging for a short time window after creation (see
-- POST_MERGE_WINDOW_MINUTES in src/lib/posts.ts / scripts/lib/posts.ts),
-- since uploads don't have a natural "end" event.
CREATE TABLE IF NOT EXISTS posts (
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

-- One row per platform folded into a post. A single-platform stream has one
-- row; a Twitch+YouTube simulcast has two rows under the same post_id, and
-- the message shows one button per row.
CREATE TABLE IF NOT EXISTS post_platforms (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id             INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  social_account_id   INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL,
  content_id          TEXT,     -- Twitch stream id / YouTube video id / TikTok item id
  url                 TEXT NOT NULL,
  ended               INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(post_id, social_account_id)
);

-- Cached Twitch app access token (client-credentials grant), shared across
-- Worker requests so we don't re-authenticate on every EventSub call.
CREATE TABLE IF NOT EXISTS twitch_token (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  access_token  TEXT NOT NULL,
  expires_at    INTEGER NOT NULL -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_channels_owner       ON channels(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_streamers_channel     ON streamers(channel_id);
CREATE INDEX IF NOT EXISTS idx_social_streamer        ON social_accounts(streamer_id);
CREATE INDEX IF NOT EXISTS idx_social_platform        ON social_accounts(platform);
CREATE INDEX IF NOT EXISTS idx_posts_streamer_open     ON posts(streamer_id, kind, is_open);
CREATE INDEX IF NOT EXISTS idx_post_platforms_post     ON post_platforms(post_id, ended);
CREATE INDEX IF NOT EXISTS idx_post_platforms_account  ON post_platforms(social_account_id, ended);
