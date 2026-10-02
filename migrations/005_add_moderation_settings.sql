-- Migration: per-chat settings for the new-member welcome message and the
-- bio spam filter, editable in the bot (/settings -> chat -> «👥 Модерация
-- группы»).
--
-- Run ONCE, manually, against a live database with:
--   npx wrangler d1 execute neurocasper-db --remote --file=./migrations/005_add_moderation_settings.sql
-- (drop --remote to try it against the local dev database first).
--
-- Unlike the CREATE ... IF NOT EXISTS migrations before it, SQLite has no
-- "ADD COLUMN IF NOT EXISTS": running this a second time fails with a
-- "duplicate column name" error. That is harmless (nothing is changed), but
-- it means there is nothing to re-run if it already succeeded.
--
-- Additive and safe on a database with real data: every existing chat gets
-- the welcome and the spam filter switched ON (the behavior the bot already
-- has today) and NULL for the two text columns, which means "use the
-- built-in defaults" -- so nothing changes for anyone until an owner edits
-- these in the bot.
ALTER TABLE channels ADD COLUMN welcome_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE channels ADD COLUMN welcome_template TEXT;
ALTER TABLE channels ADD COLUMN spam_filter_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE channels ADD COLUMN spam_phrases TEXT;
