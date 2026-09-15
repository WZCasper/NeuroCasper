import { webhookCallback } from "grammy";
import { createBot } from "./bot.js";
import { runScheduledCheck } from "./scheduled.js";
import type { Env } from "./types.js";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("NeuroCasper is running.", { status: 200 });
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

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledCheck(env));
  },
};
