// HTTP handlers for Kick's OAuth callback and incoming webhook, routed from
// src/index.ts. See src/lib/kick.ts for the underlying OAuth/webhook logic
// and why Kick needs this per-streamer-authorized flow, unlike YouTube's
// RSS feed or TikTok's public profile page.
import { Api } from "grammy";
import {
  consumeKickOAuthState,
  createSocialAccount,
  getChannelById,
  getSocialAccountByKickBroadcasterId,
  getStreamerById,
  getUserById,
  listSocialAccountsByStreamer,
  upsertKickToken,
} from "../db.js";
import { closeLivePlatform, publishOrMerge } from "../lib/publish.js";
import {
  exchangeCodeForToken,
  extractWebhookHeaders,
  fetchOwnChannel,
  parseLivestreamStatusEvent,
  subscribeToLivestreamEvents,
  verifyWebhookSignature,
} from "../lib/kick.js";
import type { Env } from "../types.js";

export async function handleKickOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET || !env.WORKER_URL) {
    return new Response("Kick integration is not configured on this server.", { status: 500 });
  }

  // Always consume the state row, even on Kick's own "error" callback or a
  // missing code -- an unconsumed row is a state value an attacker could
  // still try to replay, and consumeKickOAuthState deletes it either way.
  const consumed = state ? await consumeKickOAuthState(env, state) : null;

  if (error) {
    return htmlResponse(`Kick declined authorization: ${escapeHtml(error)}. You can close this tab.`, 200);
  }
  if (!code || !state) {
    return htmlResponse("Missing code or state in Kick's callback.", 400);
  }
  if (!consumed) {
    return htmlResponse(
      "This authorization link has expired or was already used. Go back to the bot and try again.",
      400,
    );
  }

  const { streamerId, requestedByUserId, codeVerifier } = consumed;
  const api = new Api(env.BOT_TOKEN);
  const notifyUser = getUserById(env, requestedByUserId);

  try {
    const tokens = await exchangeCodeForToken({
      clientId: env.KICK_CLIENT_ID,
      clientSecret: env.KICK_CLIENT_SECRET,
      redirectUri: `${env.WORKER_URL}/kick/oauth/callback`,
      code,
      codeVerifier,
    });

    const channel = await fetchOwnChannel(tokens.access_token);

    // Reuse the existing social_accounts row if this streamer already has
    // one for Kick (e.g. re-authorizing after revoking access on Kick's
    // side) -- social_accounts has a UNIQUE(streamer_id, platform)
    // constraint, so a second createSocialAccount call would otherwise
    // fail outright instead of updating the token in place.
    const existingAccounts = await listSocialAccountsByStreamer(env, streamerId);
    const existing = existingAccounts.find((a) => a.platform === "kick");
    const socialAccount =
      existing ?? (await createSocialAccount(env, streamerId, "kick", channel.slug, String(channel.broadcasterUserId)));

    const subscriptionId = await subscribeToLivestreamEvents(tokens.access_token);

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    await upsertKickToken(env, socialAccount.id, {
      broadcasterUserId: channel.broadcasterUserId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      eventSubscriptionId: subscriptionId,
    });

    const streamer = await getStreamerById(env, streamerId);
    const user = await notifyUser;
    if (user && streamer) {
      await api
        .sendMessage(
          user.telegram_user_id,
          `\u2705 Kick-аккаунт «${channel.slug}» подключён для ${streamer.display_name}.`,
        )
        .catch((err) => console.error("Failed to notify user of Kick auth success", err));
    }

    return htmlResponse(
      `Kick channel "${escapeHtml(channel.slug)}" connected. You can close this tab and return to Telegram.`,
      200,
    );
  } catch (err) {
    console.error("Kick OAuth callback failed", err);
    const user = await notifyUser;
    if (user) {
      await api
        .sendMessage(user.telegram_user_id, "\u274C Не удалось подключить Kick — попробуйте ещё раз через /add_social.")
        .catch((notifyErr) => console.error("Failed to notify user of Kick auth failure", notifyErr));
    }
    return htmlResponse("Something went wrong connecting your Kick account. You can close this tab and retry from Telegram.", 500);
  }
}

export async function handleKickWebhook(request: Request, env: Env): Promise<Response> {
  const headers = extractWebhookHeaders(request);
  // Read the raw body once, before any parsing -- verifyWebhookSignature
  // needs the exact bytes Kick sent, and re-serializing a parsed object can
  // change whitespace and break the signature check even for a genuine
  // request (see src/lib/kick.ts's module comment).
  const rawBody = await request.text();

  if (!headers) return new Response("Missing signature headers", { status: 400 });

  const valid = await verifyWebhookSignature(headers, rawBody);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  const event = parseLivestreamStatusEvent(rawBody);
  // Return 200 even for a payload that doesn't parse: a webhook endpoint
  // returning an error triggers Kick's retry logic for something that will
  // never parse differently on retry (see parseLivestreamStatusEvent's
  // comment in src/lib/kick.ts).
  if (!event) return new Response("OK (unrecognized payload)", { status: 200 });

  const socialAccount = await getSocialAccountByKickBroadcasterId(env, event.broadcasterUserId);
  if (!socialAccount) return new Response("OK (unknown broadcaster)", { status: 200 });

  const api = new Api(env.BOT_TOKEN);

  if (!event.isLive) {
    await closeLivePlatform(env, api, socialAccount.id);
    return new Response("OK", { status: 200 });
  }

  const streamer = await getStreamerById(env, socialAccount.streamer_id);
  if (!streamer) return new Response("OK (streamer not found)", { status: 200 });
  const channel = await getChannelById(env, streamer.channel_id);
  if (!channel) return new Response("OK (channel not found)", { status: 200 });

  await publishOrMerge({
    env,
    api,
    channel,
    streamerId: streamer.id,
    streamerName: streamer.display_name,
    socialAccountId: socialAccount.id,
    platform: "kick",
    kind: "live",
    url: `https://kick.com/${socialAccount.platform_username}`,
    contentId: `kick-live-${event.broadcasterUserId}`,
    title: event.title,
    thumbnailUrl: null,
  });

  return new Response("OK", { status: 200 });
}

function htmlResponse(message: string, status: number): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>NeuroCasper</title></head>` +
      `<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;">` +
      `<p>${message}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
