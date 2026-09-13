import { webhookCallback } from "grammy";
import { createBot } from "./bot.js";
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
        // Log with enough detail to diagnose from the dashboard's
        // Observability -> Logs tab (a bad/missing BOT_TOKEN is the most
        // likely cause of a throw here, since grammY validates the token
        // format when constructing Bot).
        console.error("Telegram webhook error:", err instanceof Error ? err.stack ?? err.message : err);
        // Ack with 200 anyway so Telegram doesn't retry-storm a request that
        // already failed once; the error is still logged above.
        return new Response("OK", { status: 200 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
