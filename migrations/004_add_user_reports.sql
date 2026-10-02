-- Migration: add the user_reports table, backing the /report command and
-- the auto-ban-after-2-reports behavior (see this repo's own README/task
-- notes for the exact rules this enforces).
--
-- Run once, manually, against a live database with:
--   npx wrangler d1 execute neurocasper-db --remote --file=./migrations/004_add_user_reports.sql
-- (drop --remote to test against the local dev database first, which is
-- strongly recommended before running this against --remote).
--
-- Additive and safe to run against a database that already has real
-- streamers/posts/etc in it -- it only adds one new, empty table, nothing
-- existing is dropped, rebuilt, or backfilled.
--
-- Deliberately NOT foreign-keyed to channels/streamers/users: a reported
-- person and the chat a report came from are arbitrary Telegram entities
-- (any group member, any group the bot is in), not necessarily anyone who
-- has ever registered anything with /start or /add_channel. reported_user_id
-- and reporter_user_id are raw Telegram user IDs; chat_telegram_id is a raw
-- Telegram chat ID.
--
-- The UNIQUE(reported_user_id, chat_telegram_id) constraint is the actual
-- collusion guard, not application logic layered on top of an unconstrained
-- table: it caps how much a single group's reports of one person can count
-- toward that person's GLOBAL (bot-wide) report total at exactly one row,
-- no matter how many different members of that one group each run
-- /report on the same target. Reaching the ban threshold therefore
-- requires reports to have landed from at least two DIFFERENT groups, not
-- just two different reporters within one group. See listDistinctReportingChats
-- (src/db.ts) and handleReportCommand (src/handlers/telegram.ts) for how
-- this is read and enforced.
CREATE TABLE IF NOT EXISTS user_reports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reported_user_id  INTEGER NOT NULL,
  reporter_user_id  INTEGER NOT NULL,
  chat_telegram_id  INTEGER NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (reported_user_id, chat_telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_user_reports_reported ON user_reports (reported_user_id);
