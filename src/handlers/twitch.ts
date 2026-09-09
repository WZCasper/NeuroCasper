import { Api } from "grammy";
import { contentAlreadyPosted, getChannelById, getSocialAccountsByTwitchUserId, getStreamerById } from "../db.js";
import { hmacSha256Hex, timingSafeEqual } from "../lib/crypto.js";
import { closeLivePlatform, publishOrMerge } from "../lib/publish.js";
import { getStreamByUserId, resolveThumbnailUrl } from "../lib/twitch-api.js";
import type { Env } from "../types.js";

const REPLAY_WINDOW_MS = 10 * 60 * 1000; // Twitch guidance: reject messages older than 10 minutes

interface TwitchNotificationBody {
  subscription: { type: string };
  event: Record<string, unknown>;
  challenge?: string;
}

interface StreamOnlineEvent {
  id: string; // stream id
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
  type: string; // "live" | "playlist" | "watch_party" | "premiere" | "rerun"
}

interface StreamOfflineEvent {
  broadcaster_user_id: string;
}

export async function handleTwitchWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const messageId = request.headers.get("Twitch-Eventsub-Message-Id");
  const timestamp = request.headers.get("Twitch-Eventsub-Message-Timestamp");
  const signature = request.headers.get("Twitch-Eventsub-Message-Signature");
  const messageType = request.headers.get("Twitch-Eventsub-Message-Type");
  const rawBody = await request.text();

  if (!messageId || !timestamp || !signature || !messageType) {
    return new Response("Missing EventSub headers", { status: 400 });
  }

  const ageMs = Date.now() - new Date(timestamp).getTime();
  if (Number.isNaN(ageMs) || ageMs > REPLAY_WINDOW_MS) {
    return new Response("Message too old", { status: 403 });
  }

  const expectedHex = await hmacSha256Hex(env.TWITCH_EVENTSUB_SECRET, messageId + timestamp + rawBody);
  if (!timingSafeEqual(`sha256=${expectedHex}`, signature)) {
    return new Response("Invalid signature", { status: 403 });
  }

  const body = JSON.parse(rawBody) as TwitchNotificationBody;

  switch (messageType) {
    case "webhook_callback_verification":
      return new Response(body.challenge ?? "", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });

    case "revocation":
      console.error("Twitch revoked an EventSub subscription", body.subscription);
      return new Response(null, { status: 200 });

    case "notification":
      // Ack Twitch immediately; do the Telegram + D1 work in the background
      // so delivery isn't held up waiting on outbound API calls.
      ctx.waitUntil(processNotification(env, body));
      return new Response(null, { status: 200 });

    default:
      return new Response("Unknown message type", { status: 400 });
  }
}

async function processNotification(env: Env, body: TwitchNotificationBody): Promise<void> {
  const api = new Api(env.BOT_TOKEN);
  try {
    if (body.subscription.type === "stream.online") {
      await handleStreamOnline(env, api, body.event as unknown as StreamOnlineEvent);
    } else if (body.subscription.type === "stream.offline") {
      await handleStreamOffline(env, api, body.event as unknown as StreamOfflineEvent);
    }
  } catch (err) {
    console.error("Twitch notification processing failed", err);
  }
}

async function handleStreamOnline(env: Env, api: Api, event: StreamOnlineEvent): Promise<void> {
  if (event.type !== "live") return; // skip reruns / premieres / watch parties

  const accounts = await getSocialAccountsByTwitchUserId(env, event.broadcaster_user_id);
  if (accounts.length === 0) return;

  const stream = await getStreamByUserId(env, event.broadcaster_user_id);
  const contentId = stream?.id ?? event.id;
  const url = `https://twitch.tv/${event.broadcaster_user_login}`;

  for (const account of accounts) {
    if (await contentAlreadyPosted(env, account.id, contentId)) continue; // duplicate delivery

    const streamer = await getStreamerById(env, account.streamer_id);
    if (!streamer) continue;
    const channel = await getChannelById(env, streamer.channel_id);
    if (!channel) continue;

    await publishOrMerge({
      env,
      api,
      channel,
      streamerId: streamer.id,
      streamerName: streamer.display_name,
      socialAccountId: account.id,
      platform: "twitch",
      kind: "live",
      url,
      contentId,
      title: stream?.title ?? "",
      game: stream?.game_name ?? "",
      thumbnailUrl: stream ? resolveThumbnailUrl(stream.thumbnail_url) : null,
    });
  }
}

async function handleStreamOffline(env: Env, api: Api, event: StreamOfflineEvent): Promise<void> {
  const accounts = await getSocialAccountsByTwitchUserId(env, event.broadcaster_user_id);
  for (const account of accounts) {
    await closeLivePlatform(env, api, account.id);
  }
}
