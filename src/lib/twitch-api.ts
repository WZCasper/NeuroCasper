import { getCachedTwitchToken, setCachedTwitchToken } from "../db.js";
import type { Env } from "../types.js";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const HELIX_URL = "https://api.twitch.tv/helix";

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

export interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_name: string;
  title: string;
  thumbnail_url: string;
  started_at: string;
}

/** Returns a cached app access token (client-credentials grant), refreshing
 * it a minute before expiry. Cached in D1 so it survives across Worker
 * invocations without re-authenticating on every request. */
export async function getAppAccessToken(env: Env): Promise<string> {
  const cached = await getCachedTwitchToken(env);
  const nowSec = Math.floor(Date.now() / 1000);
  if (cached && cached.expires_at - 60 > nowSec) {
    return cached.access_token;
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Twitch token request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  await setCachedTwitchToken(env, json.access_token, nowSec + json.expires_in);
  return json.access_token;
}

async function helixFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const token = await getAppAccessToken(env);
  return fetch(`${HELIX_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Client-Id": env.TWITCH_CLIENT_ID,
      "Content-Type": "application/json",
    },
  });
}

export async function getTwitchUserByLogin(env: Env, login: string): Promise<TwitchUser | null> {
  const res = await helixFetch(env, `/users?login=${encodeURIComponent(login.toLowerCase())}`);
  if (!res.ok) throw new Error(`Twitch users lookup failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: TwitchUser[] };
  return json.data[0] ?? null;
}

export async function getStreamByUserId(env: Env, userId: string): Promise<TwitchStream | null> {
  const res = await helixFetch(env, `/streams?user_id=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`Twitch streams lookup failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: TwitchStream[] };
  return json.data[0] ?? null;
}

/** Creates a stream.online/stream.offline EventSub webhook subscription.
 * Idempotent from Twitch's side: creating a duplicate (same type + condition
 * + callback) subscription returns a 409, which we treat as success. */
export async function subscribeEventSub(
  env: Env,
  type: "stream.online" | "stream.offline",
  broadcasterUserId: string,
): Promise<string | null> {
  const res = await helixFetch(env, "/eventsub/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      type,
      version: "1",
      condition: { broadcaster_user_id: broadcasterUserId },
      transport: {
        method: "webhook",
        callback: `${env.WORKER_URL}/webhook/twitch`,
        secret: env.TWITCH_EVENTSUB_SECRET,
      },
    }),
  });

  if (res.status === 409) return null; // subscription already exists
  if (!res.ok) {
    throw new Error(`Twitch EventSub subscribe (${type}) failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { data: Array<{ id: string }> };
  return json.data[0]?.id ?? null;
}

/** Rewrites Twitch's {width}x{height} thumbnail template into concrete pixels. */
export function resolveThumbnailUrl(template: string, width = 640, height = 360): string {
  return template.replace("{width}", String(width)).replace("{height}", String(height));
}
