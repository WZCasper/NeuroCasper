// Cloudflare Worker bindings + secrets, declared in wrangler.toml / set via
// the Worker's Settings -> Variables and Secrets in the Cloudflare dashboard.
export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  // Optional: without it, YouTube live detection falls back to a
  // best-effort page-scrape heuristic (see src/lib/youtube.ts).
  YOUTUBE_API_KEY?: string;
  // Required only if Kick is used as a monitored platform (see
  // src/lib/kick.ts). From the app registered at
  // https://kick.com/settings/developer.
  KICK_CLIENT_ID?: string;
  KICK_CLIENT_SECRET?: string;
  // The Worker's own public HTTPS URL, no trailing slash. Not a secret --
  // set as a plain [vars] entry in wrangler.toml. Needed to build the Kick
  // OAuth redirect_uri at runtime.
  WORKER_URL?: string;
}

export type Platform = "youtube" | "tiktok" | "kick";
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
  last_video_id: string | null;
  last_checked_at: string | null;
  created_at: string;
}

// Joined with its parent streamer, since the scheduled checker always needs both.
export interface SocialAccountWithStreamer extends SocialAccountRow {
  streamer_display_name: string;
  streamer_channel_id: number;
}

// A static, unmonitored link (Twitch, Discord, etc.) always shown as an
// extra button on every alert for its streamer — see schema.sql's comment
// on this table for why this exists instead of monitoring Twitch for real.
export interface ExtraLinkRow {
  id: number;
  streamer_id: number;
  label: string;
  url: string;
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

// One row per Kick channel the bot has been authorized for via OAuth --
// see schema.sql's comment on this table for why Kick needs this and
// YouTube/TikTok don't.
export interface KickTokenRow {
  id: number;
  social_account_id: number;
  broadcaster_user_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  event_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

// Persisted in users.session_state as JSON. Drives the multi-step
// /add_channel, /add_social and template-edit flows.
export type SessionState =
  | { step: "idle" }
  | { step: "awaiting_streamer_name"; data: { channel_id: number } }
  | { step: "awaiting_social_username"; data: { streamer_id: number; platform: Platform } }
  | { step: "awaiting_link_label"; data: { streamer_id: number } }
  | { step: "awaiting_link_url"; data: { streamer_id: number; label: string } }
  | { step: "awaiting_template"; data: { channel_id: number } };

export const IDLE_SESSION: SessionState = { step: "idle" };
