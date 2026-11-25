import { test } from "node:test";
import assert from "node:assert/strict";
import { GrammyError } from "grammy";
import type { Api } from "grammy";
import {
  broadcastAd,
  formatAdBroadcastSummary,
  formatUtcSendAtAsMinsk,
  isAdBroadcastContentValid,
  parseAdScheduleTime,
} from "./ad-broadcast.js";
import type { ChannelRow, Env, UserRow } from "../types.js";

// ---------------------------------------------------------------------------
// isAdBroadcastContentValid
// ---------------------------------------------------------------------------

test("text only is valid", () => {
  assert.equal(isAdBroadcastContentValid({ text: "Привет!", photoFileId: null }), true);
});

test("photo only (no caption) is valid -- an image-only ad is a legitimate post", () => {
  assert.equal(isAdBroadcastContentValid({ text: null, photoFileId: "AgACfile" }), true);
});

test("both text and photo is valid", () => {
  assert.equal(isAdBroadcastContentValid({ text: "Привет!", photoFileId: "AgACfile" }), true);
});

test("neither text nor photo is invalid", () => {
  assert.equal(isAdBroadcastContentValid({ text: null, photoFileId: null }), false);
});

test("whitespace-only text with no photo is invalid -- an empty-looking post must not slip through", () => {
  assert.equal(isAdBroadcastContentValid({ text: "   ", photoFileId: null }), false);
});

// ---------------------------------------------------------------------------
// parseAdScheduleTime
// ---------------------------------------------------------------------------

test("a well-formed future date/time converts Minsk (UTC+3) to the exact UTC storage string", () => {
  const now = new Date("2026-11-24T00:00:00Z");
  const result = parseAdScheduleTime("25.11.2026 18:00", now);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.utcSendAt, "2026-11-25 15:00:00");
    assert.equal(result.value.displayMinsk, "25.11.2026 18:00 (Минск, UTC+3)");
  }
});

test("single-digit day/month/hour are accepted and zero-padded back in the display string", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const result = parseAdScheduleTime("5.3.2027 9:05", now);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.displayMinsk, "05.03.2027 09:05 (Минск, UTC+3)");
  }
});

test("an unrecognizable format is rejected with the example format in the error", () => {
  const result = parseAdScheduleTime("tomorrow at 6pm", new Date());
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.includes("25.11.2026 18:00"));
});

test("month 13 is rejected", () => {
  const result = parseAdScheduleTime("01.13.2027 10:00", new Date("2026-01-01T00:00:00Z"));
  assert.equal(result.ok, false);
});

test("hour 24 is rejected", () => {
  const result = parseAdScheduleTime("01.06.2027 24:00", new Date("2026-01-01T00:00:00Z"));
  assert.equal(result.ok, false);
});

test("a day that does not exist (31 February) is rejected, not silently rolled into March", () => {
  const result = parseAdScheduleTime("31.02.2027 10:00", new Date("2026-01-01T00:00:00Z"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.includes("не существует"));
});

test("a time in the past (relative to the given `now`) is rejected", () => {
  const now = new Date("2026-11-24T12:00:00Z"); // 2026-11-24 15:00 Minsk
  const result = parseAdScheduleTime("24.11.2026 10:00", now); // 2026-11-24 07:00 UTC -- already passed
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.includes("прошлом"));
});

test("formatUtcSendAtAsMinsk is the exact reverse of parseAdScheduleTime's conversion", () => {
  const parsed = parseAdScheduleTime("25.11.2026 18:00", new Date("2026-01-01T00:00:00Z"));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(formatUtcSendAtAsMinsk(parsed.value.utcSendAt), "25.11.2026 18:00 (Минск, UTC+3)");
  }
});

test("formatUtcSendAtAsMinsk handles a UTC time that rolls into the next Minsk day", () => {
  // 23:30 UTC + 3 hours = 02:30 the next day in Minsk.
  assert.equal(formatUtcSendAtAsMinsk("2026-11-25 23:30:00"), "26.11.2026 02:30 (Минск, UTC+3)");
});

// ---------------------------------------------------------------------------
// broadcastAd -- per-recipient isolation and target resolution. Uses a
// minimal hand-written fake env.DB (routed by which table the SQL
// mentions) rather than the full SQLite harness in db.test.ts: the real
// SQL behaviour of listAllChannels/listDistinctChannelOwners is already
// proven there against the real schema; what's being tested here is
// ad-broadcast.ts's own orchestration logic on top of it.
// ---------------------------------------------------------------------------

function fakeEnv(options: { channels?: Partial<ChannelRow>[]; owners?: Partial<UserRow>[] }): Env {
  return {
    DB: {
      prepare: (sql: string) => ({
        all: async () => {
          if (sql.includes("FROM channels")) return { results: options.channels ?? [] };
          if (sql.includes("FROM users")) return { results: options.owners ?? [] };
          throw new Error(`fakeEnv: unexpected SQL: ${sql}`);
        },
      }),
    },
  } as unknown as Env;
}

interface FakeApiCall {
  method: "sendMessage" | "sendPhoto";
  chatId: number;
}

function fakeApi(failingChatIds: ReadonlySet<number>): { api: Api; calls: FakeApiCall[] } {
  const calls: FakeApiCall[] = [];
  const impl = {
    sendMessage: async (chatId: number) => {
      calls.push({ method: "sendMessage", chatId });
      if (failingChatIds.has(chatId)) throw new Error(`simulated failure for ${chatId}`);
      return {};
    },
    sendPhoto: async (chatId: number) => {
      calls.push({ method: "sendPhoto", chatId });
      if (failingChatIds.has(chatId)) throw new Error(`simulated failure for ${chatId}`);
      return {};
    },
  };
  return { api: impl as unknown as Api, calls };
}

test("broadcastAd 'groups': sends to every channel's telegram_chat_id, text-only via sendMessage", async () => {
  const env = fakeEnv({ channels: [{ telegram_chat_id: -100, title: "Group A" }, { telegram_chat_id: -200, title: "Group B" }] });
  const { api, calls } = fakeApi(new Set());
  const outcome = await broadcastAd(env, api, "groups", { text: "Новость!", photoFileId: null });
  assert.equal(outcome.totalTargets, 2);
  assert.equal(outcome.succeeded, 2);
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["sendMessage", "sendMessage"],
  );
  assert.deepEqual(
    calls.map((c) => c.chatId).sort((a, b) => a - b), // numeric sort -- Array.sort()'s default is lexicographic and mis-orders negative numbers
    [-200, -100],
  );
});

test("broadcastAd with a photo uses sendPhoto, not sendMessage", async () => {
  const env = fakeEnv({ channels: [{ telegram_chat_id: -100, title: "Group A" }] });
  const { api, calls } = fakeApi(new Set());
  await broadcastAd(env, api, "groups", { text: "Подпись", photoFileId: "AgACfile" });
  assert.equal(calls[0]?.method, "sendPhoto");
});

test("broadcastAd 'admins': sends to each distinct owner's telegram_user_id", async () => {
  const env = fakeEnv({ owners: [{ telegram_user_id: 555, username: "owner_one" }] });
  const { api, calls } = fakeApi(new Set());
  const outcome = await broadcastAd(env, api, "admins", { text: "Для админов", photoFileId: null });
  assert.equal(outcome.totalTargets, 1);
  assert.equal(calls[0]?.chatId, 555);
});

test("one recipient failing does not stop the others, and is reported with its own label", async () => {
  const env = fakeEnv({
    channels: [
      { telegram_chat_id: -100, title: "Group A" },
      { telegram_chat_id: -200, title: "Group B (will fail)" },
      { telegram_chat_id: -300, title: "Group C" },
    ],
  });
  const { api, calls } = fakeApi(new Set([-200]));
  const outcome = await broadcastAd(env, api, "groups", { text: "Новость!", photoFileId: null });
  assert.equal(calls.length, 3, "all three must be attempted, not stopped at the failure");
  assert.equal(outcome.succeeded, 2);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0]?.label, "Group B (will fail)");
});

test("a channel with no title falls back to its numeric chat id as the label", async () => {
  const env = fakeEnv({ channels: [{ telegram_chat_id: -100, title: null }] });
  const { api } = fakeApi(new Set([-100]));
  const outcome = await broadcastAd(env, api, "groups", { text: "x", photoFileId: null });
  assert.equal(outcome.failures[0]?.label, "-100");
});

test("a GrammyError for 'bot can't initiate conversation' is translated into a plain-Russian reason", async () => {
  const env = fakeEnv({ owners: [{ telegram_user_id: 555, username: "owner_one" }] });
  const grammyErr = new GrammyError(
    "boom",
    { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" },
    "sendMessage",
    {},
  );
  const impl = {
    sendMessage: async () => {
      throw grammyErr;
    },
    sendPhoto: async () => ({}),
  };
  const outcome = await broadcastAd(env, impl as unknown as Api, "admins", { text: "x", photoFileId: null });
  assert.equal(outcome.failures[0]?.reason, "бот не может написать первым -- этот человек никогда не открывал личный диалог с ботом");
});

// ---------------------------------------------------------------------------
// formatAdBroadcastSummary
// ---------------------------------------------------------------------------

test("a fully successful broadcast's summary has no failures section", () => {
  const text = formatAdBroadcastSummary({ target: "groups", totalTargets: 3, succeeded: 3, failures: [] });
  assert.ok(text.includes("Доставлено: 3 из 3."));
  assert.ok(!text.includes("Не доставлено"));
});

test("a partially failed broadcast lists each failure with its reason", () => {
  const text = formatAdBroadcastSummary({
    target: "admins",
    totalTargets: 2,
    succeeded: 1,
    failures: [{ label: "@someone", reason: "бот не может написать первым" }],
  });
  assert.ok(text.includes("Доставлено: 1 из 2."));
  assert.ok(text.includes("@someone: бот не может написать первым"));
});

test("more than 20 failures are capped, with a count of the remainder", () => {
  const failures = Array.from({ length: 25 }, (_, i) => ({ label: `target-${i}`, reason: "ошибка" }));
  const text = formatAdBroadcastSummary({ target: "groups", totalTargets: 25, succeeded: 0, failures });
  assert.ok(text.includes("target-19:"));
  assert.ok(!text.includes("target-20:"));
  assert.ok(text.includes("…и ещё 5."));
});
