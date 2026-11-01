import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  countDistinctReportingChats,
  createChannel,
  createPostWithPlatform,
  createSocialAccount,
  createStreamer,
  createPendingMessageDeletion,
  createUserReport,
  deletePendingMessageDeletion,
  getChannelByTelegramChatId,
  getKickTokenBySocialAccount,
  listDuePendingMessageDeletions,
  getOrCreateUser,
  toggleChannelFlag,
  upsertKickToken,
  updateChannelAntilinkWhitelist,
  updateChannelLeaveTemplate,
  updateChannelSpamPhrases,
  updateChannelUrlBlacklist,
  updateChannelWelcomeDeleteAfter,
  updateChannelWelcomeTemplate,
} from "./db.js";
import type { Env } from "./types.js";

// ---------------------------------------------------------------------------
// createUserReport / countDistinctReportingChats
//
// Cloudflare D1 isn't available outside Workers, so these run the real
// functions against an in-memory SQLite database (node:sqlite -- the same
// engine D1 is built on) created from the repo's REAL schema.sql, not a
// hand-copied table definition. That matters here specifically: the
// collusion guard (at most one report per reported person per chat) is a
// UNIQUE constraint in the schema, not application logic, so a test that
// re-declared the table itself could stay green while the real schema
// drifted. FakeD1 below implements only the small slice of D1's API that
// these two functions use (prepare().bind().run()/first()).
// ---------------------------------------------------------------------------

class FakeD1Statement {
  // db/sql/params are readable so fakeD1Batch() below can run a batch's
  // statements itself, inside one real transaction.
  constructor(
    readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): FakeD1Statement {
    return new FakeD1Statement(this.db, this.sql, params);
  }

  async run(): Promise<{ success: true }> {
    this.db.prepare(this.sql).run(...(this.params as Array<string | number | null>));
    return { success: true };
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.params as Array<string | number | null>));
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.db.prepare(this.sql).all(...(this.params as Array<string | number | null>));
    return { results: rows as T[] };
  }
}

/** A real SQLite transaction (BEGIN / statements / COMMIT, ROLLBACK on any
 * failure) -- what D1's batch() documents. A loop of independent writes
 * would let the rollback test below pass for the wrong reason. */
async function fakeD1Batch<T>(db: DatabaseSync, statements: FakeD1Statement[]): Promise<Array<{ results: T[] }>> {
  db.exec("BEGIN");
  try {
    const out = statements.map((stmt) => ({
      results: db.prepare(stmt.sql).all(...(stmt.params as Array<string | number | null>)) as T[],
    }));
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function createTestEnv(): Env {
  const db = new DatabaseSync(":memory:");
  // fileURLToPath(string) rather than passing a URL object straight to
  // readFileSync: tsconfig.test.json resolves the global URL type to
  // Cloudflare Workers' definition, which node:fs's overloads reject.
  const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url).href);
  db.exec(readFileSync(schemaPath, "utf8"));
  const fakeD1 = {
    prepare: (sql: string) => new FakeD1Statement(db, sql),
    batch: <T>(statements: FakeD1Statement[]) => fakeD1Batch<T>(db, statements),
  };
  return { DB: fakeD1 } as unknown as Env;
}

test("a first report against a person is recorded as created", async () => {
  const env = createTestEnv();
  assert.equal(await createUserReport(env, 111, 222, -1001), "created");
  assert.equal(await countDistinctReportingChats(env, 111), 1);
});

test("a second report against the same person from the SAME chat is rejected, even from a different reporter (collusion guard)", async () => {
  const env = createTestEnv();
  assert.equal(await createUserReport(env, 111, 222, -1001), "created");
  // A different member of the same group tries to add a second report.
  assert.equal(await createUserReport(env, 111, 333, -1001), "already_reported_from_this_chat");
  // The count must not have been inflated by the rejected attempt.
  assert.equal(await countDistinctReportingChats(env, 111), 1);
});

test("the same reporter repeating /report on the same person in the same chat is also rejected", async () => {
  const env = createTestEnv();
  assert.equal(await createUserReport(env, 111, 222, -1001), "created");
  assert.equal(await createUserReport(env, 111, 222, -1001), "already_reported_from_this_chat");
  assert.equal(await countDistinctReportingChats(env, 111), 1);
});

test("reports from two DIFFERENT chats against the same person both count, reaching 2", async () => {
  const env = createTestEnv();
  assert.equal(await createUserReport(env, 111, 222, -1001), "created");
  assert.equal(await createUserReport(env, 111, 444, -1002), "created");
  assert.equal(await countDistinctReportingChats(env, 111), 2);
});

test("reports against different people do not affect each other's counts", async () => {
  const env = createTestEnv();
  await createUserReport(env, 111, 222, -1001);
  await createUserReport(env, 111, 444, -1002);
  await createUserReport(env, 999, 222, -1001);
  assert.equal(await countDistinctReportingChats(env, 111), 2);
  assert.equal(await countDistinctReportingChats(env, 999), 1);
});

test("a person nobody has reported has a count of zero", async () => {
  const env = createTestEnv();
  assert.equal(await countDistinctReportingChats(env, 12345), 0);
});

test("a non-uniqueness database error is rethrown rather than swallowed as 'already reported'", async () => {
  const env = createTestEnv();
  // Break the table out from under the function so the INSERT fails for a
  // reason that is NOT a UNIQUE violation -- createUserReport must not
  // misreport that as a duplicate report.
  await env.DB.prepare("DROP TABLE user_reports").run();
  await assert.rejects(() => createUserReport(env, 111, 222, -1001), /no such table/);
});

// ---------------------------------------------------------------------------
// Per-chat moderation settings: getChannelByTelegramChatId,
// updateChannelWelcomeTemplate, updateChannelSpamPhrases, and the two new
// toggleChannelFlag flags. Same rationale as above for testing against the
// real schema.sql rather than a hand-copied table shape -- the new columns'
// defaults (welcome_enabled/spam_filter_enabled = 1, the two text columns =
// NULL) are declared in the schema, not in application code, so a test that
// re-declared the table could stay green while the real schema drifted.
// ---------------------------------------------------------------------------

/** owner_user_id must reference an existing users row (foreign keys are
 * enforced, matching D1's real behavior -- see this repo's own notes on
 * that in the my_chat_member handling), so every moderation-settings test
 * needs a real user before it can create a channel. */
async function createTestChannel(env: Env, telegramChatId: number): Promise<Awaited<ReturnType<typeof createChannel>>> {
  const owner = await getOrCreateUser(env, 900000 + telegramChatId, undefined, "Test Owner");
  return createChannel(env, owner.id, telegramChatId, "Test Chat");
}

test("a freshly-created channel defaults to welcome, leave-announcement and spam-filter all enabled, AntiLink OFF, no custom text", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2001);
  assert.equal(channel.welcome_enabled, 1);
  assert.equal(channel.spam_filter_enabled, 1);
  assert.equal(channel.welcome_template, null);
  assert.equal(channel.spam_phrases, null);
  // leave_enabled defaults to 1 (on), same reasoning as welcome_enabled --
  // see that column's own comment in schema.sql.
  assert.equal(channel.leave_enabled, 1);
  assert.equal(channel.leave_template, null);
  // antilink_enabled defaults to 0 (OFF), deliberately UNLIKE the three
  // flags above -- see that column's own comment in schema.sql for why
  // (it deletes ordinary members' own messages, so it must be an explicit
  // opt-in rather than on by default for every existing chat).
  assert.equal(channel.antilink_enabled, 0);
  assert.equal(channel.antilink_whitelist, null);
  // url_blacklist_enabled defaults to 0 (OFF), same reasoning as
  // antilink_enabled -- see that column's own comment in schema.sql.
  assert.equal(channel.url_blacklist_enabled, 0);
  assert.equal(channel.url_blacklist, null);
});

test("getChannelByTelegramChatId finds a registered chat by its Telegram chat ID", async () => {
  const env = createTestEnv();
  const created = await createTestChannel(env, -2002);
  const found = await getChannelByTelegramChatId(env, -2002);
  assert.ok(found);
  assert.equal(found.id, created.id);
});

test("getChannelByTelegramChatId returns null for a chat nobody has registered", async () => {
  const env = createTestEnv();
  assert.equal(await getChannelByTelegramChatId(env, -999999), null);
});

test("toggleChannelFlag flips welcome_enabled independently of spam_filter_enabled", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2003);

  const afterFirstToggle = await toggleChannelFlag(env, channel.id, "welcome_enabled");
  assert.ok(afterFirstToggle);
  assert.equal(afterFirstToggle.welcome_enabled, 0);
  assert.equal(afterFirstToggle.spam_filter_enabled, 1); // untouched

  const afterSecondToggle = await toggleChannelFlag(env, channel.id, "welcome_enabled");
  assert.ok(afterSecondToggle);
  assert.equal(afterSecondToggle.welcome_enabled, 1); // back to on
});

test("toggleChannelFlag flips spam_filter_enabled independently of welcome_enabled", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2004);

  const afterToggle = await toggleChannelFlag(env, channel.id, "spam_filter_enabled");
  assert.ok(afterToggle);
  assert.equal(afterToggle.spam_filter_enabled, 0);
  assert.equal(afterToggle.welcome_enabled, 1); // untouched
});

test("updateChannelWelcomeTemplate stores a custom template, and null resets it back", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2005);

  const withCustom = await updateChannelWelcomeTemplate(env, channel.id, "Привет, {name}!");
  assert.ok(withCustom);
  assert.equal(withCustom.welcome_template, "Привет, {name}!");

  const reset = await updateChannelWelcomeTemplate(env, channel.id, null);
  assert.ok(reset);
  assert.equal(reset.welcome_template, null);
});

test("updateChannelSpamPhrases stores a custom phrase list as JSON, and null resets it back", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2006);

  const withCustom = await updateChannelSpamPhrases(env, channel.id, JSON.stringify(["продам гараж"]));
  assert.ok(withCustom);
  assert.equal(withCustom.spam_phrases, '["продам гараж"]');

  const reset = await updateChannelSpamPhrases(env, channel.id, null);
  assert.ok(reset);
  assert.equal(reset.spam_phrases, null);
});

test("toggleChannelFlag flips leave_enabled independently of the other flags", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2007);

  const afterToggle = await toggleChannelFlag(env, channel.id, "leave_enabled");
  assert.ok(afterToggle);
  assert.equal(afterToggle.leave_enabled, 0);
  assert.equal(afterToggle.welcome_enabled, 1); // untouched
  assert.equal(afterToggle.spam_filter_enabled, 1); // untouched

  const afterSecondToggle = await toggleChannelFlag(env, channel.id, "leave_enabled");
  assert.ok(afterSecondToggle);
  assert.equal(afterSecondToggle.leave_enabled, 1); // back to on
});

test("toggleChannelFlag flips antilink_enabled independently of the other flags", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2008);

  const afterToggle = await toggleChannelFlag(env, channel.id, "antilink_enabled");
  assert.ok(afterToggle);
  assert.equal(afterToggle.antilink_enabled, 1); // was 0 by default, now on
  assert.equal(afterToggle.welcome_enabled, 1); // untouched
  assert.equal(afterToggle.leave_enabled, 1); // untouched

  const afterSecondToggle = await toggleChannelFlag(env, channel.id, "antilink_enabled");
  assert.ok(afterSecondToggle);
  assert.equal(afterSecondToggle.antilink_enabled, 0); // back to off
});

test("updateChannelLeaveTemplate stores a custom template, and null resets it back", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2009);

  const withCustom = await updateChannelLeaveTemplate(env, channel.id, "Пока, {name}!");
  assert.ok(withCustom);
  assert.equal(withCustom.leave_template, "Пока, {name}!");

  const reset = await updateChannelLeaveTemplate(env, channel.id, null);
  assert.ok(reset);
  assert.equal(reset.leave_template, null);
});

test("updateChannelAntilinkWhitelist stores a custom hostname list as JSON, and null resets it back", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2010);

  const withCustom = await updateChannelAntilinkWhitelist(env, channel.id, JSON.stringify(["youtube.com", "vk.com"]));
  assert.ok(withCustom);
  assert.equal(withCustom.antilink_whitelist, '["youtube.com","vk.com"]');

  const reset = await updateChannelAntilinkWhitelist(env, channel.id, null);
  assert.ok(reset);
  assert.equal(reset.antilink_whitelist, null);
});

test("toggleChannelFlag flips url_blacklist_enabled independently of the other flags, including antilink_enabled", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2014);

  const afterToggle = await toggleChannelFlag(env, channel.id, "url_blacklist_enabled");
  assert.ok(afterToggle);
  assert.equal(afterToggle.url_blacklist_enabled, 1); // was 0 by default, now on
  assert.equal(afterToggle.antilink_enabled, 0); // untouched -- the whole point is this works independently of AntiLink
  assert.equal(afterToggle.welcome_enabled, 1); // untouched

  const afterSecondToggle = await toggleChannelFlag(env, channel.id, "url_blacklist_enabled");
  assert.ok(afterSecondToggle);
  assert.equal(afterSecondToggle.url_blacklist_enabled, 0); // back to off
});

test("updateChannelUrlBlacklist stores a custom entry list as JSON, and null resets it back", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2015);

  const entries = JSON.stringify([{ hostname: "t.me", path: "/badchannel", display: "t.me/badchannel" }]);
  const withCustom = await updateChannelUrlBlacklist(env, channel.id, entries);
  assert.ok(withCustom);
  assert.equal(withCustom.url_blacklist, entries);

  const reset = await updateChannelUrlBlacklist(env, channel.id, null);
  assert.ok(reset);
  assert.equal(reset.url_blacklist, null);
});

test("getKickTokenBySocialAccount returns null when no token has been stored yet", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2011);
  const streamer = await createStreamer(env, channel.id, "TestStreamer");
  const socialAccount = await createSocialAccount(env, streamer.id, "kick", "teststreamer", "kick-broadcaster-1");

  const result = await getKickTokenBySocialAccount(env, socialAccount.id);
  assert.equal(result, null);
});

test("upsertKickToken stores a new token, readable back by social_account_id", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2012);
  const streamer = await createStreamer(env, channel.id, "TestStreamer");
  const socialAccount = await createSocialAccount(env, streamer.id, "kick", "teststreamer", "kick-broadcaster-1");

  await upsertKickToken(env, socialAccount.id, {
    broadcasterUserId: 123456,
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: "2026-01-01T00:00:00.000Z",
    eventSubscriptionId: "sub-1",
  });

  const stored = await getKickTokenBySocialAccount(env, socialAccount.id);
  assert.ok(stored);
  assert.equal(stored.broadcaster_user_id, 123456);
  assert.equal(stored.access_token, "access-token-1");
  assert.equal(stored.refresh_token, "refresh-token-1");
  assert.equal(stored.expires_at, "2026-01-01T00:00:00.000Z");
  assert.equal(stored.event_subscription_id, "sub-1");
});

test("upsertKickToken called again for the same social account REPLACES the token rather than duplicating it", async () => {
  // This is exactly the path getValidKickAccessToken (src/handlers/kick.ts)
  // relies on after a refresh: the UNIQUE(social_account_id) + ON CONFLICT
  // DO UPDATE in the real schema (not reproduced here -- this runs the
  // real schema.sql, see createTestEnv above) is what makes this an
  // update rather than a second row.
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2013);
  const streamer = await createStreamer(env, channel.id, "TestStreamer");
  const socialAccount = await createSocialAccount(env, streamer.id, "kick", "teststreamer", "kick-broadcaster-1");

  await upsertKickToken(env, socialAccount.id, {
    broadcasterUserId: 123456,
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    expiresAt: "2026-01-01T00:00:00.000Z",
    eventSubscriptionId: "sub-1",
  });
  await upsertKickToken(env, socialAccount.id, {
    broadcasterUserId: 123456,
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    expiresAt: "2026-06-01T00:00:00.000Z",
    eventSubscriptionId: "sub-1",
  });

  const stored = await getKickTokenBySocialAccount(env, socialAccount.id);
  assert.ok(stored);
  assert.equal(stored.access_token, "new-access-token");
  assert.equal(stored.refresh_token, "new-refresh-token");
  assert.equal(stored.expires_at, "2026-06-01T00:00:00.000Z");

  const { results: allTokenRows } = await env.DB.prepare(
    "SELECT * FROM kick_tokens WHERE social_account_id = ?",
  )
    .bind(socialAccount.id)
    .all();
  assert.equal(allTokenRows.length, 1, "must still be exactly one row, not two");
});

// ---------------------------------------------------------------------------
// createPostWithPlatform -- the fix for the orphaned-open-post incident
// described on the function itself (src/db.ts). The rollback test is the one
// that matters: it forces the SECOND statement to fail and asserts the FIRST
// one's row did not survive.
// ---------------------------------------------------------------------------

async function createTestStreamerWithAccount(env: Env, chatId: number): Promise<{ streamerId: number; socialAccountId: number }> {
  const channel = await createTestChannel(env, chatId);
  const streamer = await createStreamer(env, channel.id, "Test Streamer");
  const account = await createSocialAccount(env, streamer.id, "youtube", "testhandle", "UC123");
  return { streamerId: streamer.id, socialAccountId: account.id };
}

test("createPostWithPlatform creates the post and its platform row, correctly linked", async () => {
  const env = createTestEnv();
  const { streamerId, socialAccountId } = await createTestStreamerWithAccount(env, -3001);
  const { post, postPlatform } = await createPostWithPlatform(
    env, streamerId, 1, "live", -3001, 555, socialAccountId, "youtube", "vid-1", "https://youtube.com/watch?v=vid-1",
  );
  assert.equal(post.kind, "live");
  assert.equal(post.is_open, 1);
  assert.equal(postPlatform.post_id, post.id);
  assert.equal(postPlatform.social_account_id, socialAccountId);
});

test("createPostWithPlatform leaves no orphaned post when the second insert fails", async () => {
  const env = createTestEnv();
  const { streamerId } = await createTestStreamerWithAccount(env, -3002);
  // A nonexistent social_account_id violates post_platforms' foreign key.
  await assert.rejects(() =>
    createPostWithPlatform(env, streamerId, 1, "live", -3002, 556, 999999, "youtube", "vid-2", "https://youtube.com/watch?v=vid-2"),
  );
  const orphans = await env.DB.prepare(
    "SELECT p.id FROM posts p WHERE p.streamer_id = ? AND NOT EXISTS (SELECT 1 FROM post_platforms pp WHERE pp.post_id = p.id)",
  )
    .bind(streamerId)
    .all<{ id: number }>();
  assert.deepEqual(orphans.results, []);
  const posts = await env.DB.prepare("SELECT id FROM posts WHERE streamer_id = ?").bind(streamerId).all<{ id: number }>();
  assert.deepEqual(posts.results, [], "the failed batch must not leave any posts row behind");
});

test("two createPostWithPlatform calls link their own rows (LAST_INSERT_ROWID does not leak across calls)", async () => {
  const env = createTestEnv();
  const { streamerId, socialAccountId } = await createTestStreamerWithAccount(env, -3003);
  const a = await createPostWithPlatform(env, streamerId, 1, "live", -3003, 601, socialAccountId, "youtube", "v1", "https://y/1");
  const b = await createPostWithPlatform(env, streamerId, 1, "video", -3003, 602, socialAccountId, "youtube", "v2", "https://y/2");
  assert.notEqual(a.post.id, b.post.id);
  assert.equal(a.postPlatform.post_id, a.post.id);
  assert.equal(b.postPlatform.post_id, b.post.id);
});

// ---------------------------------------------------------------------------
// Welcome-message auto-deletion: channels.welcome_delete_after_seconds and
// the pending_message_deletions queue (migrations/007).
// ---------------------------------------------------------------------------

test("a new channel defaults to deleting welcome messages after 600 seconds", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -4001);
  assert.equal(channel.welcome_delete_after_seconds, 600);
});

test("updateChannelWelcomeDeleteAfter stores the new delay, including 0 for never", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -4002);
  assert.equal((await updateChannelWelcomeDeleteAfter(env, channel.id, 120))?.welcome_delete_after_seconds, 120);
  assert.equal((await updateChannelWelcomeDeleteAfter(env, channel.id, 0))?.welcome_delete_after_seconds, 0);
});

test("a freshly queued deletion is not due yet", async () => {
  const env = createTestEnv();
  await createPendingMessageDeletion(env, -4003, 900, 600);
  assert.deepEqual(await listDuePendingMessageDeletions(env), []);
});

test("a queued deletion whose delete_at has passed is listed as due, oldest first, and can be removed", async () => {
  const env = createTestEnv();
  await env.DB.prepare("INSERT INTO pending_message_deletions (telegram_chat_id, message_id, delete_at) VALUES (?, ?, datetime('now', '-1 minutes'))")
    .bind(-4004, 1)
    .run();
  await env.DB.prepare("INSERT INTO pending_message_deletions (telegram_chat_id, message_id, delete_at) VALUES (?, ?, datetime('now', '-10 minutes'))")
    .bind(-4004, 2)
    .run();
  await createPendingMessageDeletion(env, -4004, 3, 600); // not due

  const due = await listDuePendingMessageDeletions(env);
  assert.deepEqual(due.map((r) => r.message_id), [2, 1], "oldest-due first, and the not-yet-due row is excluded");

  const first = due[0];
  assert.ok(first);
  await deletePendingMessageDeletion(env, first.id);
  assert.deepEqual((await listDuePendingMessageDeletions(env)).map((r) => r.message_id), [1]);
});
