import { Bot, type BotError } from "grammy";
import { getOrCreateUser, getSession } from "./db.js";
import { registerHandlers } from "./handlers/telegram.js";
import type { BotContext } from "./handlers/telegram.js";
import type { Env } from "./types.js";

const GENERIC_ERROR_TEXT = "Произошла ошибка при обработке. Попробуйте ещё раз через минуту.";

/** Always logs first (unchanged from before this function existed), then
 * makes one best-effort attempt to tell the actual person something went
 * wrong -- a real alert for a button press (see the "first answer only"
 * reasoning at this error's call site in src/handlers/telegram.ts for why
 * this can still be the first one to reach Telegram), or an ordinary
 * reply for anything else that has a chat to reply into. Deliberately
 * generic wording: `err.error` could be anything a handler threw,
 * including internal detail (a SQL error naming a column, say) that
 * shouldn't surface to whoever happened to be using the bot at the time.
 * Wrapped in its own try/catch so a failure IN this notification attempt
 * (the chat became inaccessible, Telegram itself is down, whatever) is
 * only ever logged, never thrown back out -- bot.catch calling this is
 * grammY's last line of defense for the whole update, so this must not
 * be the thing that defeats it. */
export async function notifyUserOfError(err: BotError<BotContext>): Promise<void> {
  console.error(`Error handling update ${err.ctx.update.update_id}:`, err.error);
  try {
    if (err.ctx.callbackQuery) {
      await err.ctx.answerCallbackQuery({ text: GENERIC_ERROR_TEXT, show_alert: true });
    } else if (err.ctx.chat) {
      await err.ctx.reply(GENERIC_ERROR_TEXT);
    }
  } catch (notifyErr) {
    console.error(`Also failed to notify the user about the above error (update ${err.ctx.update.update_id}):`, notifyErr);
  }
}

// Module-level cache, keyed by BOT_TOKEN. src/index.ts's fetch() calls
// createBot(env) on every incoming webhook request; without this cache a
// fresh `new Bot(...)` has no botInfo, so grammY's webhookCallback calls
// Telegram's getMe to fill it in on every single update that touches
// ctx.me (see src/handlers/telegram.ts: /add_channel, forwarded channel
// posts) -- one wasted round-trip per message. A Worker isolate can stay
// warm across many requests, so caching here (reused for as long as the
// isolate lives) removes that round-trip for every request after the
// first. Keyed by token rather than a bare singleton so a BOT_TOKEN
// rotation without a redeploy can't serve stale botInfo from a warm
// isolate.
let cached: { token: string; bot: Bot<BotContext> } | null = null;

export function createBot(env: Env): Bot<BotContext> {
  if (cached && cached.token === env.BOT_TOKEN) return cached.bot;

  const bot = new Bot<BotContext>(env.BOT_TOKEN);

  // Attach the D1-backed user row + session state to every update before any
  // command/handler runs. Workers are stateless between requests, so this
  // (not in-memory state) is what carries multi-step flows across messages.
  bot.use(async (ctx, next) => {
    if (!ctx.from) {
      await next();
      return;
    }
    const user = await getOrCreateUser(env, ctx.from.id, ctx.from.username, ctx.from.first_name);
    ctx.dbUser = user;
    ctx.session = await getSession(env, user.id);
    await next();
  });

  registerHandlers(bot, env);

  // Real, traced example this was written against: a moderation toggle
  // (e.g. "Включить АнтиСсылку") throws when its underlying column
  // doesn't exist yet in a database a pending migration hadn't been
  // applied to -- without this, the person pressing the button saw
  // nothing happen at all (the spinner on the button briefly appeared and
  // went away, same as any ordinary successful press, because
  // bot.on("callback_query:data")'s own answerCallbackQuery call in
  // src/handlers/telegram.ts had ALREADY fired before this ever ran --
  // see that call site's own comment), and the actual error only ever
  // reached `console.error` here, nowhere the person could see it.
  //
  // grammY awaits this handler (confirmed against the installed
  // package's own source) before index.ts's fetch() returns a Response,
  // so the notification attempt below is not fire-and-forget racing the
  // Worker's response -- it genuinely completes first, same as any other
  // awaited call in this codebase.
  bot.catch((err) => notifyUserOfError(err));

  cached = { token: env.BOT_TOKEN, bot };
  return bot;
}
