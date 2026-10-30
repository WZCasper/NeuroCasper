import { test } from "node:test";
import assert from "node:assert/strict";
import type { BotError } from "grammy";
import { notifyUserOfError } from "./bot.js";
import type { BotContext } from "./handlers/telegram.js";

// ---------------------------------------------------------------------------
// notifyUserOfError
//
// Regression coverage for a real, traced bug: bot.on("callback_query:data")
// (src/handlers/telegram.ts) used to unconditionally answer every callback
// query in a `finally` block, win or lose. Telegram only honors the FIRST
// answerCallbackQuery call for a given callback_query_id -- a second call
// still reports success but has no visible effect -- so by the time an
// error from a failed handler reached bot.catch, that one answer had
// already been spent on an empty, silent one. The person pressing the
// button saw nothing: no error, no change, just the button's spinner
// clearing as if it had worked. notifyUserOfError is what bot.catch
// (src/bot.ts) now calls instead -- these tests check it actually reaches
// the person, through whichever channel fits the kind of update that
// failed, with wording that doesn't leak internal error detail, and that a
// failure in the notification attempt itself can never throw back out
// (this runs inside the bot's own last line of defense; it must not be
// able to defeat that defense).
// ---------------------------------------------------------------------------

function fakeBotError(ctx: Partial<BotContext>, error: unknown): BotError<BotContext> {
  return { ctx: ctx as BotContext, error } as BotError<BotContext>;
}

test("a failed callback_query (button press) gets a real alert, not just a log line", async () => {
  const calls: Array<{ method: string; args: unknown }> = [];
  const ctx: Partial<BotContext> = {
    update: { update_id: 1 } as BotContext["update"],
    callbackQuery: { id: "cbq-1", data: "set:atg:123" } as BotContext["callbackQuery"],
    chat: undefined,
    answerCallbackQuery: (async (opts: unknown) => {
      calls.push({ method: "answerCallbackQuery", args: opts });
      return true;
    }) as BotContext["answerCallbackQuery"],
    reply: (async () => {
      throw new Error("must not call reply for a callback_query failure");
    }) as unknown as BotContext["reply"],
  };

  await notifyUserOfError(fakeBotError(ctx, new Error("no such column: antilink_enabled")));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "answerCallbackQuery");
  const args = calls[0]?.args as { text?: string; show_alert?: boolean };
  assert.equal(args.show_alert, true, "a toast the person might not notice defeats the point; this must be a real alert");
  assert.ok(args.text && args.text.length > 0, "must have user-facing text, not an empty answer");
  assert.ok(
    !args.text?.toLowerCase().includes("antilink_enabled") && !args.text?.toLowerCase().includes("column"),
    "must not leak the underlying error's internal detail (a DB column name, here) to an ordinary user",
  );
});

test("a failed ordinary message (not a button press) gets a reply, not answerCallbackQuery", async () => {
  const calls: Array<{ method: string; args: unknown }> = [];
  const ctx: Partial<BotContext> = {
    update: { update_id: 2 } as BotContext["update"],
    callbackQuery: undefined,
    chat: { id: -1001 } as BotContext["chat"],
    answerCallbackQuery: (async () => {
      throw new Error("must not call answerCallbackQuery when there is no callback_query to answer");
    }) as unknown as BotContext["answerCallbackQuery"],
    reply: (async (text: string) => {
      calls.push({ method: "reply", args: text });
      return true;
    }) as unknown as BotContext["reply"],
  };

  await notifyUserOfError(fakeBotError(ctx, new Error("some other failure")));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "reply");
  assert.ok(typeof calls[0]?.args === "string" && (calls[0]?.args as string).length > 0);
});

test("neither callback_query nor chat present: logs only, calls nothing (nothing to notify through)", async () => {
  const ctx: Partial<BotContext> = {
    update: { update_id: 3 } as BotContext["update"],
    callbackQuery: undefined,
    chat: undefined,
    answerCallbackQuery: (async () => {
      throw new Error("must not be called");
    }) as unknown as BotContext["answerCallbackQuery"],
    reply: (async () => {
      throw new Error("must not be called");
    }) as unknown as BotContext["reply"],
  };

  // Must not throw -- this is the "nothing to notify through" case, not a
  // failure case; see the next test for an ACTUAL failed-notification-attempt.
  await notifyUserOfError(fakeBotError(ctx, new Error("some failure")));
});

test("a failure in the notification attempt itself is swallowed, never thrown back out", async () => {
  const ctx: Partial<BotContext> = {
    update: { update_id: 4 } as BotContext["update"],
    callbackQuery: { id: "cbq-4" } as BotContext["callbackQuery"],
    chat: undefined,
    answerCallbackQuery: (async () => {
      throw new Error("Bad Request: query is too old and response timeout expired or query ID is invalid");
    }) as unknown as BotContext["answerCallbackQuery"],
    reply: (async () => true) as unknown as BotContext["reply"],
  };

  // The real assertion here is simply that this resolves at all, rather
  // than rejecting -- this runs inside bot.catch, grammY's own last
  // resort, so a throw here would be exactly the kind of "FATAL: grammY
  // unable to handle" situation bot.catch exists to prevent.
  await notifyUserOfError(fakeBotError(ctx, new Error("original failure")));
});
