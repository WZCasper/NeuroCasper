import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  closePostPlatform,
  countDistinctReportingChats,
  createAdBroadcast,
  createChannel,
  createPostWithPlatform,
  createSocialAccount,
  createStreamer,
  createPendingMessageDeletion,
  createUserReport,
  deleteAdBroadcast,
  deleteChannelById,
  deletePendingMessageDeletion,
  findOpenPostPlatformForAccount,
  getAdBroadcastById,
  getChannelByTelegramChatId,
  getKickTokenBySocialAccount,
  listAllChannels,
  listDistinctChannelOwners,
  listDueAdBroadcasts,
  listDuePendingMessageDeletions,
  listPendingAdBroadcasts,
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
// findOpenPostPlatformForAccount -- regression coverage for the reported bug
// "the new-video post's button disappears after a few minutes". Root cause:
// this query used to have no `posts.kind` filter, so it happily handed back
// a 'video' post's still-open post_platforms row as if it were a live
// stream to re-check. src/scheduled.ts then asked "is this still live?",
// got (correctly) "no" for a plain video, and closeLivePlatform trimmed the
// video post's button off, mistaking it for an ended stream. See the
// function's own doc comment in src/db.ts for the full trace.
// ---------------------------------------------------------------------------

test("a 'video' post's open post_platforms row is never returned (the exact bug: it used to be, and got mistaken for a live stream)", async () => {
  const env = createTestEnv();
  const { streamerId, socialAccountId } = await createTestStreamerWithAccount(env, -5001);
  await createPostWithPlatform(env, streamerId, 1, "video", -5001, 701, socialAccountId, "youtube", "new-video", "https://y/new-video");
  const found = await findOpenPostPlatformForAccount(env, socialAccountId);
  assert.equal(found, null, "a video post must never be treated as an open live stream to re-check");
});

test("an open 'live' post's row IS returned (the function must still do its actual job)", async () => {
  const env = createTestEnv();
  const { streamerId, socialAccountId } = await createTestStreamerWithAccount(env, -5002);
  const { postPlatform } = await createPostWithPlatform(
    env, streamerId, 1, "live", -5002, 702, socialAccountId, "youtube", "live-content", "https://y/live",
  );
  const found = await findOpenPostPlatformForAccount(env, socialAccountId);
  assert.ok(found);
  assert.equal(found?.id, postPlatform.id);
});

test("a video posted AFTER a live stream is already open: only the live post's row is found, never the newer video's", async () => {
  const env = createTestEnv();
  const { streamerId, socialAccountId } = await createTestStreamerWithAccount(env, -5003);
  const { post: livePost } = await createPostWithPlatform(
    env, streamerId, 1, "live", -5003, 703, socialAccountId, "youtube", "live-content", "https://y/live",
  );
  const { postPlatform: videoPlatform } = await createPostWithPlatform(
    env, streamerId, 1, "video", -5003, 704, socialAccountId, "youtube", "another-video", "https://y/video",
  );
  // Both rows get `datetime('now')` (second resolution) by default, so within
  // one fast test they can tie on created_at. Back-date the video row's
  // timestamp explicitly so it is unambiguously the MORE RECENT row --
  // exactly the real-world case (a video posted some time after a stream
  // went live) that the old, unscoped "ORDER BY created_at DESC LIMIT 1"
  // query would have picked, being newer, over the live row it should have
  // returned instead.
  await env.DB.prepare("UPDATE post_platforms SET created_at = datetime('now', '+1 hour') WHERE id = ?")
    .bind(videoPlatform.id)
    .run();
  const found = await findOpenPostPlatformForAccount(env, socialAccountId);
  assert.ok(found);
  assert.equal(found?.post_id, livePost.id, "the newer video row must never shadow the live post's own row");
});

test("once the live post's row is closed, it stops being returned -- the ended=0 filter still works after adding the kind JOIN", async () => {
  const env = createTestEnv();
  const { streamerId, socialAccountId } = await createTestStreamerWithAccount(env, -5004);
  const { postPlatform } = await createPostWithPlatform(
    env, streamerId, 1, "live", -5004, 705, socialAccountId, "youtube", "live-content", "https://y/live",
  );
  await closePostPlatform(env, postPlatform.id);
  const found = await findOpenPostPlatformForAccount(env, socialAccountId);
  assert.equal(found, null);
});

// ---------------------------------------------------------------------------
// deleteChannelById -- the manual "🗑 Удалить группу из бота" button in
// /settings. Unlike deleteChannelsByTelegramChatId (used when the bot itself
// is kicked or loses admin rights, which must wipe every owner's
// registration of that physical chat at once), this manual action must only
// ever touch the ONE row the person pressing the button actually owns.
// ---------------------------------------------------------------------------

test("deleteChannelById removes exactly the given channel and cascades to its own streamers", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -6001);
  await createStreamer(env, channel.id, "Streamer To Cascade");

  await deleteChannelById(env, channel.id);

  const remaining = await getChannelByTelegramChatId(env, -6001);
  assert.equal(remaining, null);
  const orphanedStreamers = await env.DB.prepare("SELECT id FROM streamers WHERE channel_id = ?")
    .bind(channel.id)
    .all<{ id: number }>();
  assert.deepEqual(orphanedStreamers.results, [], "ON DELETE CASCADE must remove streamers under the deleted channel");
});

test("deleteChannelById does NOT touch a different owner's registration of the same physical chat", async () => {
  const env = createTestEnv();
  const ownerA = await getOrCreateUser(env, 710001, undefined, "Owner A");
  const ownerB = await getOrCreateUser(env, 710002, undefined, "Owner B");
  const channelA = await createChannel(env, ownerA.id, -6002, "Owner A's setup");
  const channelB = await createChannel(env, ownerB.id, -6002, "Owner B's setup");

  await deleteChannelById(env, channelA.id);

  const stillThere = await getChannelByTelegramChatId(env, -6002);
  assert.ok(stillThere);
  assert.equal(stillThere?.id, channelB.id, "owner B's own row for the same chat must survive owner A's deletion");
});

// ---------------------------------------------------------------------------
// "📢 РЕКЛАМА" -- ad_broadcasts (migrations/013) and the two cross-tenant
// listing functions it needs (listAllChannels, listDistinctChannelOwners).
// ---------------------------------------------------------------------------

test("createAdBroadcast stores every field as given, including a photo-only post (null text)", async () => {
  const env = createTestEnv();
  const user = await getOrCreateUser(env, 810001, "advertiser", "Advertiser");
  const row = await createAdBroadcast(env, user.id, null, "AgACAgIAAxkBfile123", "groups", "2026-12-01 10:00:00");
  assert.equal(row.created_by_user_id, user.id);
  assert.equal(row.text, null);
  assert.equal(row.photo_file_id, "AgACAgIAAxkBfile123");
  assert.equal(row.target, "groups");
  assert.equal(row.send_at, "2026-12-01 10:00:00");
});

test("listPendingAdBroadcasts returns every row, soonest send_at first", async () => {
  const env = createTestEnv();
  const user = await getOrCreateUser(env, 810002, "advertiser", "Advertiser");
  await createAdBroadcast(env, user.id, "later", null, "groups", "2027-01-01 00:00:00");
  await createAdBroadcast(env, user.id, "sooner", null, "groups", "2026-06-01 00:00:00");
  const pending = await listPendingAdBroadcasts(env);
  assert.equal(pending.length, 2);
  assert.equal(pending[0]?.text, "sooner");
  assert.equal(pending[1]?.text, "later");
});

test("listDueAdBroadcasts returns only rows whose send_at has already passed", async () => {
  const env = createTestEnv();
  const user = await getOrCreateUser(env, 810003, "advertiser", "Advertiser");
  await createAdBroadcast(env, user.id, "already due", null, "groups", "2000-01-01 00:00:00"); // far in the past
  await createAdBroadcast(env, user.id, "far future", null, "groups", "2099-01-01 00:00:00");
  const due = await listDueAdBroadcasts(env);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.text, "already due");
});

test("deleteAdBroadcast removes exactly the given row", async () => {
  const env = createTestEnv();
  const user = await getOrCreateUser(env, 810004, "advertiser", "Advertiser");
  const row = await createAdBroadcast(env, user.id, "to be cancelled", null, "admins", "2099-01-01 00:00:00");
  await deleteAdBroadcast(env, row.id);
  assert.equal(await getAdBroadcastById(env, row.id), null);
});

test("listAllChannels returns every channel regardless of owner (unlike listChannelsByOwner)", async () => {
  const env = createTestEnv();
  await createTestChannel(env, -8101);
  await createTestChannel(env, -8102); // a different owner, auto-created by createTestChannel
  const all = await listAllChannels(env);
  assert.equal(all.length, 2);
});

test("listDistinctChannelOwners returns one row per distinct owner, not one per channel", async () => {
  const env = createTestEnv();
  const owner = await getOrCreateUser(env, 810005, "multi_owner", "Multi Owner");
  await createChannel(env, owner.id, -8201, "First group");
  await createChannel(env, owner.id, -8202, "Second group"); // same owner, second channel
  await createTestChannel(env, -8203); // a different owner entirely

  const owners = await listDistinctChannelOwners(env);
  assert.equal(owners.length, 2, "the owner of two channels must appear once, not twice");
  const multiOwnerRow = owners.find((u) => u.id === owner.id);
  assert.ok(multiOwnerRow);
  assert.equal(multiOwnerRow?.username, "multi_owner");
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
