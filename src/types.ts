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
  /** 1/0: greet new group members (see src/lib/moderation-settings.ts). */
  welcome_enabled: number;
  /** NULL = the built-in default welcome text. */
  welcome_template: string | null;
  /** Seconds until a welcome message is auto-deleted; 0 = never. Default 600. */
  welcome_delete_after_seconds: number;
  /** 1/0: check a new member's bio against spam_phrases. */
  spam_filter_enabled: number;
  /** JSON array of strings; NULL = the built-in default phrase list. */
  spam_phrases: string | null;
  /** 1/0: announce when a member leaves/is removed from the group (see
   * src/lib/moderation-settings.ts). */
  leave_enabled: number;
  /** NULL = the built-in default leave-announcement text. */
  leave_template: string | null;
  /** 1/0: delete any message in the group containing a link whose host
   * isn't on antilink_whitelist (see src/lib/antilink.ts). Defaults to 0
   * (off) -- unlike welcome/spam-filter, this deletes ordinary members'
   * messages, which is disruptive enough that it should be an explicit
   * opt-in rather than on by default for every existing chat. */
  antilink_enabled: number;
  /** JSON array of whitelisted hostnames; NULL/"[]" both mean "nothing
   * whitelisted" (every link gets deleted while antilink_enabled is on) --
   * there is no built-in default list the way spam_phrases has one, since
   * which domains are legitimate is entirely chat-specific. */
  antilink_whitelist: string | null;
  /** 1/0: delete any group message linking to a specific blacklisted
   * channel/page (see src/lib/antilink.ts). Independent of
   * antilink_enabled above -- works even with AntiLink itself off.
   * Defaults to 0 (off), same reasoning as antilink_enabled. */
  url_blacklist_enabled: number;
  /** JSON array of {hostname, path, display} entries; NULL/"[]" both
   * mean nothing is blacklisted yet. No built-in default here either. */
  url_blacklist: string | null;
  /** 1/0: delete Telegram's OWN "X joined/left the group" service message
   * (see src/lib/service-messages.ts). Independent of welcome_enabled/
   * leave_enabled above, which are this bot's own announcement text, not
   * Telegram's. Defaults to 0 (off). */
  hide_service_messages: number;
  /** 1/0: post a daily Call of Duty stats summary for every member
   * authorized in this chat (see CodAuthorizationRow, src/lib/cod-client.ts).
   * Defaults to 0 (off). */
  cod_summary_enabled: number;
  /** Game-specific `title` code to send to Activision's stats API (see
   * DEFAULT_COD_TITLE_CODE in src/lib/cod-client.ts). NULL means "use the
   * default" -- see that constant's own comment for why there isn't a
   * confirmed one yet for current titles. */
  cod_title_code: string | null;
  created_at: string;
}

/** One group member who went through the 2-question "authorization" at
 * join time (see src/lib/cod-onboarding.ts) -- stored forever, as the
 * owner asked, independent of whether the bot can currently fetch stats
 * for the tag at all. */
export interface CodAuthorizationRow {
  id: number;
  channel_id: number;
  telegram_user_id: number;
  /** Answer to question 1 ("как ваше имя?") -- free text, not
   * necessarily the member's real Telegram name. */
  display_name: string;
  /** Answer to question 2 -- the Activision tag, stored exactly as typed
   * (no case/whitespace normalization), e.g. "亗 Casper#7378333". */
  activision_tag: string;
  created_at: string;
  updated_at: string;
}

/** One member's in-progress join-time "authorization" for one chat --
 * exists only between question 1 and the final answer to question 2 (see
 * src/lib/cod-onboarding.ts); once both answers are in, this row is
 * deleted and a real CodAuthorizationRow is created instead. */
export interface CodOnboardingProgressRow {
  id: number;
  channel_id: number;
  telegram_user_id: number;
  step: "awaiting_name" | "awaiting_tag";
  /** Filled once step moves to "awaiting_tag"; null while still waiting
   * for the very first answer. */
  display_name: string | null;
  created_at: string;
}

/** The bot's OWN Activision account session -- singleton (id is always 1),
 * not tied to any channel/streamer. See schema.sql's own comment on
 * activision_session for why this lives in the database rather than as
 * Worker Secrets. */
export interface ActivisionSessionRow {
  id: 1;
  /** Stored for a possible future, separate integration only -- today's
   * code (src/lib/cod-session.ts) never reads email/password, only
   * cookie_value below. See schema.sql's own comment on this table. */
  email: string | null;
  password: string | null;
  /** The manually-obtained ACT_SSO_COOKIE value -- the ONLY login method
   * actually used today (see src/lib/cod-session.ts/cod-client.ts). */
  cookie_value: string | null;
  updated_at: string;
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
  | { step: "awaiting_link_url_edit"; data: { streamer_id: number; link_id: number } }
  | { step: "awaiting_template"; data: { channel_id: number } }
  | { step: "awaiting_welcome_template"; data: { channel_id: number } }
  | { step: "awaiting_leave_template"; data: { channel_id: number } }
  | { step: "awaiting_welcome_delete_after"; data: { channel_id: number } }
  | { step: "awaiting_spam_phrases"; data: { channel_id: number } }
  | { step: "awaiting_antilink_whitelist"; data: { channel_id: number } }
  | { step: "awaiting_url_blacklist"; data: { channel_id: number } }
  // Ввод служебной Activision-cookie -- БЕЗ channel_id: activision_session
  // единственная на весь бот, не привязана к конкретному каналу (см.
  // schema.sql's comment on activision_session). return_to_channel_id --
  // какой экран показать после сохранения (откуда именно владелец зашёл
  // в этот ввод), а не часть самих данных сессии Activision.
  | { step: "awaiting_cod_cookie"; data: { return_to_channel_id: number } }
  | { step: "awaiting_cod_title_code"; data: { channel_id: number } };

export const IDLE_SESSION: SessionState = { step: "idle" };

/** A Telegram message queued for deletion once delete_at has passed
 * (currently only welcome messages). See migrations/007. */
export interface PendingMessageDeletionRow {
  id: number;
  telegram_chat_id: number;
  message_id: number;
  delete_at: string;
}
