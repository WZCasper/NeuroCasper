-- Migration: ad_broadcasts table for "📢 РЕКЛАМА" (ad-broadcast) feature.
-- See schema.sql for the full rationale behind every column -- this file
-- only repeats what's needed to apply it to a live database.
--
-- Run once, manually, against a live database:
--   npx wrangler d1 execute neurocasper-db --remote --file=./migrations/013_add_ad_broadcasts.sql
--
-- Purely additive, safe with real data: a brand-new table, starts empty,
-- and nothing in the bot writes to it until the two hardcoded super-admin
-- usernames (src/lib/super-admins.ts) actually schedule a delayed ad post.
-- Immediate ("🚀 Отправить сейчас") posts never touch this table at all.

CREATE TABLE ad_broadcasts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text                 TEXT,
  photo_file_id        TEXT,
  target               TEXT NOT NULL CHECK (target IN ('groups', 'admins')),
  send_at              TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (text IS NOT NULL OR photo_file_id IS NOT NULL)
);

CREATE INDEX idx_ad_broadcasts_send_at ON ad_broadcasts (send_at);
