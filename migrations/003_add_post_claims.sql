-- Migration: add the post_claims table, closing the "duplicate post" race
-- from a different angle than 002_add_live_post_unique_constraint.sql.
--
-- Run once, manually, against a live database with:
--   npx wrangler d1 execute neurocasper-db --remote --file=./migrations/003_add_post_claims.sql
-- (drop --remote to test against the local dev database first, which is
-- strongly recommended before running this against --remote).
--
-- Additive and safe to run against a database that already has real
-- streamers/posts/etc in it -- it only adds one new, empty table, nothing
-- existing is dropped, rebuilt, or backfilled.
--
-- Why this table: see its comment in schema.sql and the comments on
-- claimPostSlot/releasePostSlot in src/db.ts and on publishOrMerge in
-- src/lib/publish.ts. In short: 002_add_live_post_unique_constraint.sql
-- made a duplicate-post race loud instead of silent, but didn't prevent
-- the duplicate Telegram message itself -- by the time that migration's
-- unique index rejected the second INSERT, the losing request had
-- typically already sent its own Telegram message, since publishOrMerge
-- only checked for an open post BEFORE sending, with nothing stopping a
-- second concurrent caller from making the exact same "no open post yet"
-- read in the gap before the first caller's INSERT lands. This table
-- closes that gap: publishOrMerge now claims a row here BEFORE calling the
-- Telegram API, so a second concurrent caller finds the claim already
-- taken and backs off to retry the merge instead of sending its own
-- message at all.
CREATE TABLE IF NOT EXISTS post_claims (
  streamer_id  INTEGER NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('live','video')),
  claimed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (streamer_id, kind)
);
