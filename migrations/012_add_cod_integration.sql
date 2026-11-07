-- Migration: Call of Duty / Activision daily-stats integration.
-- See schema.sql for the full rationale behind every column/table below --
-- this file only repeats what's needed to apply it to a live database.
--
-- activision_session.cookie_value is the ONLY login method actually used
-- by the code (src/lib/cod-session.ts) -- email/password are stored for a
-- possible future, separate integration only, see schema.sql's own
-- comment on this table for why.
--
-- Run once, manually, against a live database:
--   npx wrangler d1 execute neurocasper-db --remote --file=./migrations/012_add_cod_integration.sql
--
-- Additive, safe with real data: cod_summary_enabled defaults to 0 (off)
-- for every existing chat, cod_title_code defaults to NULL (falls back
-- to DEFAULT_COD_TITLE_CODE in src/lib/cod-client.ts), and both new
-- tables start empty -- nothing changes for any existing chat/user until
-- the owner deliberately sets up Activision auth and turns this on.

ALTER TABLE channels ADD COLUMN cod_summary_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN cod_title_code TEXT;

CREATE TABLE IF NOT EXISTS cod_authorizations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  telegram_user_id  INTEGER NOT NULL,
  display_name      TEXT NOT NULL,
  activision_tag    TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS activision_session (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  email         TEXT,
  password      TEXT,
  cookie_value  TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cod_onboarding_progress (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  telegram_user_id  INTEGER NOT NULL,
  step              TEXT NOT NULL CHECK (step IN ('awaiting_name', 'awaiting_tag')),
  display_name      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel_id, telegram_user_id)
);
