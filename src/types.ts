// Cloudflare Worker bindings + secrets, declared in wrangler.toml / set via
// `wrangler secret put`.
export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TWITCH_EVENTSUB_SECRET: string;
  WORKER_URL: string;
}

export type Platform = "twitch" | "youtube" | "tiktok";
export type PostKind = "live" | "video";

export interface UserRow {
  id: number;
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  is_admin: number;
  session_state: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelRow {
  id: number;
  owner_user_id: number;
  telegram_chat_id: number;
  title: string | null;
  message_template: string;
  auto_pin: number;
  auto_unpin: number;
  created_at: string;
}

export interface StreamerRow {
  id: number;
  channel_id: number;
  display_name: string;
  created_at: string;
}

export interface SocialAccountRow {
  id: number;
  streamer_id: number;
  platform: Platform;
  platform_user_id: string | null;
  platform_username: string;
  eventsub_subscription_id: string | null;
  last_video_id: string | null;
  last_checked_at: string | null;
  created_at: string;
}

export interface PostRow {
  id: number;
  streamer_id: number;
  channel_id: number;
  kind: PostKind;
  telegram_chat_id: number;
  telegram_message_id: number;
  is_open: number;
  created_at: string;
  closed_at: string | null;
}

export interface PostPlatformRow {
  id: number;
  post_id: number;
  social_account_id: number;
  platform: Platform;
  content_id: string | null;
  url: string;
  ended: number;
  created_at: string;
}

// Persisted in users.session_state as JSON. Drives the multi-step
// /add_channel, /add_social and template-edit flows.
export type SessionState =
  | { step: "idle" }
  | { step: "awaiting_streamer_name"; data: { channel_id: number } }
  | { step: "awaiting_social_username"; data: { streamer_id: number; platform: Platform } }
  | { step: "awaiting_template"; data: { channel_id: number } };

export const IDLE_SESSION: SessionState = { step: "idle" };
