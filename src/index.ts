import { webhookCallback } from "grammy";
import { createBot } from "./bot.js";
import { handleKickOAuthCallback, handleKickWebhook } from "./handlers/kick.js";
import { runScheduledCheck } from "./scheduled.js";
import { runDailyCodSummary } from "./scheduled-cod-summary.js";
import type { Env } from "./types.js";

// Код cron-расписания, вызывающего ежедневную сводку CoD -- должен
// совпадать с его записью в wrangler.toml's crons слово в слово;
// ScheduledEvent.cron несёт именно ТУ строку, что сработала, так что
// этим и различаются два настроенных триггера ниже.
const DAILY_COD_SUMMARY_CRON = "0 8 * * *";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("NeuroINFO is running.", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/webhook/telegram") {
      try {
        const bot = createBot(env);
        const handleUpdate = webhookCallback(bot, "cloudflare-mod", { secretToken: env.WEBHOOK_SECRET });
        return await handleUpdate(request);
      } catch (err) {
        console.error("Telegram webhook error:", err instanceof Error ? err.stack ?? err.message : err);
        return new Response("OK", { status: 200 });
      }
    }

    if (request.method === "GET" && url.pathname === "/kick/oauth/callback") {
      return handleKickOAuthCallback(request, env);
    }

    if (request.method === "POST" && url.pathname === "/kick/webhook") {
      return handleKickWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === DAILY_COD_SUMMARY_CRON) {
      ctx.waitUntil(runDailyCodSummary(env));
      return;
    }
    // Любой другой cron (сегодня — только "*/5 * * * *") — обычная
    // проверка новых стримов, как и раньше.
    ctx.waitUntil(runScheduledCheck(env));
  },
};
