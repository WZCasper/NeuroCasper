// Standalone copy of the row shapes this script needs, kept independent from
// src/types.ts on purpose: this script runs under plain Node in GitHub
// Actions (scripts/tsconfig.json has no @cloudflare/workers-types), while
// src/types.ts's Env interface references Workers-only ambient types. Keeping
// the two projects' type-checking fully decoupled avoids one side's tsconfig
// leaking into the other's.
export type Platform = "twitch" | "youtube" | "tiktok";
export type PostKind = "live" | "video";

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

// Joined with its parent streamer, since the checker always needs both.
export interface SocialAccountWithStreamer {
  id: number;
  streamer_id: number;
  platform: Platform;
  platform_user_id: string | null;
  platform_username: string;
  eventsub_subscription_id: string | null;
  last_video_id: string | null;
  last_checked_at: string | null;
  streamer_display_name: string;
  streamer_channel_id: number;
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
