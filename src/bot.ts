import { Bot } from "grammy";
import { getOrCreateUser, getSession } from "./db.js";
import { registerHandlers } from "./handlers/telegram.js";
import type { BotContext } from "./handlers/telegram.js";
import type { Env } from "./types.js";

export function createBot(env: Env): Bot<BotContext> {
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

  return bot;
}
