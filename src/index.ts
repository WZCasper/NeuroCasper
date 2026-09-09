import { webhookCallback } from "grammy";
import { createBot } from "./bot.js";
import { handleTwitchWebhook } from "./handlers/twitch.js";
import type { Env } from "./types.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("NeuroCasper is running.", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/webhook/telegram") {
      const bot = createBot(env);
      const handleUpdate = webhookCallback(bot, "cloudflare-mod", { secretToken: env.WEBHOOK_SECRET });
      try {
        return await handleUpdate(request);
      } catch (err) {
        console.error("Telegram webhook error", err);
        // Ack with 200 anyway so Telegram doesn't retry-storm a request that
        // already failed once; the error is still logged above.
        return new Response("OK", { status: 200 });
      }
    }

    if (request.method === "POST" && url.pathname === "/webhook/twitch") {
      return handleTwitchWebhook(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
