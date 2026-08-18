import { Bot } from "grammy";

interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  ENVIRONMENT: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ ok: true, service: "NeuroCasper", environment: env.ENVIRONMENT });
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/telegram/webhook") {
      if (!env.BOT_TOKEN) return new Response("BOT_TOKEN is not configured", { status: 500 });
      const bot = new Bot(env.BOT_TOKEN);
      bot.command("start", async (ctx) => {
        await ctx.reply("NeuroCasper online.");
      });
      await bot.handleUpdate(await request.json());
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  },
};
