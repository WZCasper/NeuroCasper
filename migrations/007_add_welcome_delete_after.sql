-- Migration: per-chat auto-deletion of welcome messages.
--   * channels.welcome_delete_after_seconds: configurable in the bot
--     (/settings -> chat -> «👥 Модерация группы»), default 600 (10 minutes),
--     0 = never delete.
--   * pending_message_deletions: the queue the cron sweeps (src/scheduled.ts).
--
-- Run once, manually, against a live database:
--   npx wrangler d1 execute neurocasper-db --remote --file=./migrations/007_add_welcome_delete_after.sql
--
-- The ALTER TABLE has no IF NOT EXISTS (SQLite doesn't support it for ADD
-- COLUMN): running this twice fails on "duplicate column name" for that one
-- statement -- harmless, it just means it was already applied. The CREATE
-- TABLE / INDEX statements are safe to re-run.
--
-- Additive, safe with real data: every existing chat gets 600, so welcome
-- messages start disappearing after 10 minutes once the matching code ships,
-- unless the chat's owner changes it in /settings.
ALTER TABLE channels ADD COLUMN welcome_delete_after_seconds INTEGER NOT NULL DEFAULT 600;

CREATE TABLE IF NOT EXISTS pending_message_deletions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id  INTEGER NOT NULL,
  message_id        INTEGER NOT NULL,
  delete_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_message_deletions_delete_at ON pending_message_deletions (delete_at);
