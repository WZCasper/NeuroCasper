import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  countDistinctReportingChats,
  createChannel,
  createUserReport,
  getChannelByTelegramChatId,
  getOrCreateUser,
  toggleChannelFlag,
  updateChannelSpamPhrases,
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
  private params: unknown[] = [];
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async run(): Promise<{ success: true }> {
    this.db.prepare(this.sql).run(...(this.params as Array<string | number | null>));
    return { success: true };
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.params as Array<string | number | null>));
    return (row as T | undefined) ?? null;
  }
}

function createTestEnv(): Env {
  const db = new DatabaseSync(":memory:");
  // fileURLToPath(string) rather than passing a URL object straight to
  // readFileSync: tsconfig.test.json resolves the global URL type to
  // Cloudflare Workers' definition, which node:fs's overloads reject.
  const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url).href);
  db.exec(readFileSync(schemaPath, "utf8"));
  const fakeD1 = { prepare: (sql: string) => new FakeD1Statement(db, sql) };
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

test("a freshly-created channel defaults to welcome and spam-filter both enabled, with no custom text", async () => {
  const env = createTestEnv();
  const channel = await createTestChannel(env, -2001);
  assert.equal(channel.welcome_enabled, 1);
  assert.equal(channel.spam_filter_enabled, 1);
  assert.equal(channel.welcome_template, null);
  assert.equal(channel.spam_phrases, null);
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
