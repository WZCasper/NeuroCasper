import { Bot } from "grammy";
import { getOrCreateUser, getSession } from "./db.js";
import { registerHandlers } from "./handlers/telegram.js";
import type { BotContext } from "./handlers/telegram.js";
import type { Env } from "./types.js";

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

  bot.catch((err) => {
    console.error(`Error handling update ${err.ctx.update.update_id}:`, err.error);
  });

  cached = { token: env.BOT_TOKEN, bot };
  return bot;
}
