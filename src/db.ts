// D1 query helpers for the Worker. Covers both the bot's configuration
// tables (users, channels, streamers, social_accounts, extra_links) and,
// since the YouTube/TikTok checker moved here from a separate GitHub
// Actions script (see src/scheduled.ts), the posts/post_platforms tables
// too.
import type {
  ChannelRow,
  Env,
  ExtraLinkRow,
  KickTokenRow,
  Platform,
  PostKind,
  PostPlatformRow,
  PostRow,
  SessionState,
  SocialAccountRow,
  SocialAccountWithStreamer,
  StreamerRow,
  UserRow,
} from "./types.js";
import { IDLE_SESSION } from "./types.js";

// ---------------------------------------------------------------------------
// users / session
// ---------------------------------------------------------------------------

export async function getOrCreateUser(
  env: Env,
  telegramUserId: number,
  username: string | undefined,
  firstName: string | undefined,
): Promise<UserRow> {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<UserRow>();

  if (existing) {
    if (existing.username !== (username ?? null) || existing.first_name !== (firstName ?? null)) {
      await env.DB.prepare(
        "UPDATE users SET username = ?, first_name = ?, updated_at = datetime('now') WHERE id = ?",
      )
        .bind(username ?? null, firstName ?? null, existing.id)
        .run();
    }
    return existing;
  }

  const inserted = await env.DB.prepare(
    "INSERT INTO users (telegram_user_id, username, first_name) VALUES (?, ?, ?) RETURNING *",
  )
    .bind(telegramUserId, username ?? null, firstName ?? null)
    .first<UserRow>();

  if (!inserted) throw new Error("Failed to create user");
  return inserted;
}

export async function getUserById(env: Env, id: number): Promise<UserRow | null> {
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  return row ?? null;
}

export async function getSession(env: Env, userId: number): Promise<SessionState> {
  const row = await env.DB.prepare("SELECT session_state FROM users WHERE id = ?")
    .bind(userId)
    .first<{ session_state: string | null }>();
  if (!row?.session_state) return IDLE_SESSION;
  try {
    return JSON.parse(row.session_state) as SessionState;
  } catch {
    return IDLE_SESSION;
  }
}

export async function setSession(env: Env, userId: number, state: SessionState): Promise<void> {
  const value = state.step === "idle" ? null : JSON.stringify(state);
  await env.DB.prepare("UPDATE users SET session_state = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(value, userId)
    .run();
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

export async function listChannelsByOwner(env: Env, ownerUserId: number): Promise<ChannelRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM channels WHERE owner_user_id = ? ORDER BY created_at ASC",
  )
    .bind(ownerUserId)
    .all<ChannelRow>();
  return results ?? [];
}

export async function getChannelById(env: Env, id: number): Promise<ChannelRow | null> {
  const row = await env.DB.prepare("SELECT * FROM channels WHERE id = ?").bind(id).first<ChannelRow>();
  return row ?? null;
}

export async function getChannelByOwnerAndChatId(
  env: Env,
  ownerUserId: number,
  telegramChatId: number,
): Promise<ChannelRow | null> {
  const row = await env.DB.prepare("SELECT * FROM channels WHERE owner_user_id = ? AND telegram_chat_id = ?")
    .bind(ownerUserId, telegramChatId)
    .first<ChannelRow>();
  return row ?? null;
}

export async function createChannel(
  env: Env,
  ownerUserId: number,
  telegramChatId: number,
  title: string | undefined,
): Promise<ChannelRow> {
  const row = await env.DB.prepare(
    "INSERT INTO channels (owner_user_id, telegram_chat_id, title) VALUES (?, ?, ?) RETURNING *",
  )
    .bind(ownerUserId, telegramChatId, title ?? null)
    .first<ChannelRow>();
  if (!row) throw new Error("Failed to create channel");
  return row;
}

export async function updateChannelTemplate(env: Env, channelId: number, template: string): Promise<void> {
  await env.DB.prepare("UPDATE channels SET message_template = ? WHERE id = ?").bind(template, channelId).run();
}

export async function toggleChannelFlag(
  env: Env,
  channelId: number,
  flag: "auto_pin" | "auto_unpin",
): Promise<ChannelRow | null> {
  // Literal SQL per flag rather than interpolating the column name into the
  // query string — `flag` is always a hardcoded literal from the call sites
  // in src/handlers/telegram.ts today, but this keeps the query text fixed
  // regardless, rather than relying on that staying true.
  const sql =
    flag === "auto_pin"
      ? "UPDATE channels SET auto_pin = 1 - auto_pin WHERE id = ?"
      : "UPDATE channels SET auto_unpin = 1 - auto_unpin WHERE id = ?";
  await env.DB.prepare(sql).bind(channelId).run();
  return getChannelById(env, channelId);
}

// ---------------------------------------------------------------------------
// streamers
// ---------------------------------------------------------------------------

export async function listStreamersByChannel(env: Env, channelId: number): Promise<StreamerRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM streamers WHERE channel_id = ? ORDER BY created_at ASC",
  )
    .bind(channelId)
    .all<StreamerRow>();
  return results ?? [];
}

export async function createStreamer(env: Env, channelId: number, displayName: string): Promise<StreamerRow> {
  const row = await env.DB.prepare(
    "INSERT INTO streamers (channel_id, display_name) VALUES (?, ?) RETURNING *",
  )
    .bind(channelId, displayName)
    .first<StreamerRow>();
  if (!row) throw new Error("Failed to create streamer");
  return row;
}

export async function getStreamerById(env: Env, id: number): Promise<StreamerRow | null> {
  const row = await env.DB.prepare("SELECT * FROM streamers WHERE id = ?").bind(id).first<StreamerRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// social_accounts (monitored platforms)
// ---------------------------------------------------------------------------

export async function listSocialAccountsByStreamer(
  env: Env,
  streamerId: number,
): Promise<SocialAccountRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM social_accounts WHERE streamer_id = ? ORDER BY created_at ASC",
  )
    .bind(streamerId)
    .all<SocialAccountRow>();
  return results ?? [];
}

/** All monitored accounts for a platform, joined with their streamer —
 * what the scheduled checker iterates over. */
export async function listSocialAccountsByPlatform(
  env: Env,
  platform: Platform,
): Promise<SocialAccountWithStreamer[]> {
  const { results } = await env.DB.prepare(
    `SELECT sa.*, s.display_name AS streamer_display_name, s.channel_id AS streamer_channel_id
     FROM social_accounts sa
     JOIN streamers s ON s.id = sa.streamer_id
     WHERE sa.platform = ?`,
  )
    .bind(platform)
    .all<SocialAccountWithStreamer>();
  return results ?? [];
}

export async function createSocialAccount(
  env: Env,
  streamerId: number,
  platform: Platform,
  platformUsername: string,
  platformUserId: string | null,
): Promise<SocialAccountRow> {
  const row = await env.DB.prepare(
    `INSERT INTO social_accounts (streamer_id, platform, platform_username, platform_user_id)
     VALUES (?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(streamerId, platform, platformUsername, platformUserId)
    .first<SocialAccountRow>();
  if (!row) throw new Error("Failed to create social account");
  return row;
}

export async function updateLastVideoId(env: Env, socialAccountId: number, videoId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE social_accounts SET last_video_id = ?, last_checked_at = datetime('now') WHERE id = ?",
  )
    .bind(videoId, socialAccountId)
    .run();
}

export async function touchLastCheckedAt(env: Env, socialAccountId: number): Promise<void> {
  await env.DB.prepare("UPDATE social_accounts SET last_checked_at = datetime('now') WHERE id = ?")
    .bind(socialAccountId)
    .run();
}

// ---------------------------------------------------------------------------
// Kick OAuth (streamer-authorized webhook subscription) — see schema.sql's
// comments on kick_oauth_states / kick_tokens and src/lib/kick.ts.
// ---------------------------------------------------------------------------

const KICK_OAUTH_STATE_TTL_MINUTES = 10;

export async function createKickOAuthState(
  env: Env,
  state: string,
  codeVerifier: string,
  streamerId: number,
  requestedByUserId: number,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kick_oauth_states (state, code_verifier, streamer_id, requested_by) VALUES (?, ?, ?, ?)",
  )
    .bind(state, codeVerifier, streamerId, requestedByUserId)
    .run();
}

/** Consumes (deletes) a Kick OAuth state row if it exists and hasn't
 * expired. Returns null for an unknown or expired state -- the caller
 * must treat that as "reject this callback", since an expired or reused
 * state is exactly the CSRF case this table exists to catch. */
export async function consumeKickOAuthState(
  env: Env,
  state: string,
): Promise<{ streamerId: number; requestedByUserId: number; codeVerifier: string } | null> {
  const row = await env.DB.prepare(
    `SELECT streamer_id, requested_by, code_verifier FROM kick_oauth_states
     WHERE state = ? AND created_at >= datetime('now', ?)`,
  )
    .bind(state, `-${KICK_OAUTH_STATE_TTL_MINUTES} minutes`)
    .first<{ streamer_id: number; requested_by: number; code_verifier: string }>();
  await env.DB.prepare("DELETE FROM kick_oauth_states WHERE state = ?").bind(state).run();
  if (!row) return null;
  return { streamerId: row.streamer_id, requestedByUserId: row.requested_by, codeVerifier: row.code_verifier };
}

export async function upsertKickToken(
  env: Env,
  socialAccountId: number,
  data: {
    broadcasterUserId: number;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    eventSubscriptionId: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO kick_tokens
       (social_account_id, broadcaster_user_id, access_token, refresh_token, expires_at, event_subscription_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(social_account_id) DO UPDATE SET
       broadcaster_user_id = excluded.broadcaster_user_id,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       event_subscription_id = excluded.event_subscription_id,
       updated_at = datetime('now')`,
  )
    .bind(
      socialAccountId,
      data.broadcasterUserId,
      data.accessToken,
      data.refreshToken,
      data.expiresAt,
      data.eventSubscriptionId,
    )
    .run();
}

export async function getKickTokenBySocialAccount(
  env: Env,
  socialAccountId: number,
): Promise<KickTokenRow | null> {
  const row = await env.DB.prepare("SELECT * FROM kick_tokens WHERE social_account_id = ?")
    .bind(socialAccountId)
    .first<KickTokenRow>();
  return row ?? null;
}

/** Looked up by Kick's broadcaster_user_id, the only identifier a webhook
 * payload carries — see src/lib/kick.ts's handleWebhook. */
export async function getSocialAccountByKickBroadcasterId(
  env: Env,
  broadcasterUserId: number,
): Promise<SocialAccountRow | null> {
  const row = await env.DB.prepare(
    `SELECT sa.* FROM social_accounts sa
     JOIN kick_tokens kt ON kt.social_account_id = sa.id
     WHERE kt.broadcaster_user_id = ?`,
  )
    .bind(broadcasterUserId)
    .first<SocialAccountRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// extra_links (unmonitored, always-shown links — Twitch lives here now)
// ---------------------------------------------------------------------------

export async function listExtraLinksByStreamer(env: Env, streamerId: number): Promise<ExtraLinkRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM extra_links WHERE streamer_id = ? ORDER BY created_at ASC",
  )
    .bind(streamerId)
    .all<ExtraLinkRow>();
  return results ?? [];
}

export async function createExtraLink(
  env: Env,
  streamerId: number,
  label: string,
  url: string,
): Promise<ExtraLinkRow> {
  const row = await env.DB.prepare(
    "INSERT INTO extra_links (streamer_id, label, url) VALUES (?, ?, ?) RETURNING *",
  )
    .bind(streamerId, label, url)
    .first<ExtraLinkRow>();
  if (!row) throw new Error("Failed to create extra link");
  return row;
}

// ---------------------------------------------------------------------------
// posts / post_platforms
// ---------------------------------------------------------------------------

/** Minutes a 'video' post stays eligible for another platform to merge into
 * (see schema.sql comment on `posts.kind`). 'live' posts don't need a
 * window: they stay open for as long as is_open=1. */
export const VIDEO_POST_MERGE_WINDOW_MINUTES = 15;

export async function findOpenPost(env: Env, streamerId: number, kind: PostKind): Promise<PostRow | null> {
  if (kind === "live") {
    const row = await env.DB.prepare(
      "SELECT * FROM posts WHERE streamer_id = ? AND kind = 'live' AND is_open = 1 ORDER BY created_at DESC LIMIT 1",
    )
      .bind(streamerId)
      .first<PostRow>();
    return row ?? null;
  }
  const row = await env.DB.prepare(
    `SELECT * FROM posts
     WHERE streamer_id = ? AND kind = 'video' AND is_open = 1
       AND created_at >= datetime('now', ?)
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(streamerId, `-${VIDEO_POST_MERGE_WINDOW_MINUTES} minutes`)
    .first<PostRow>();
  return row ?? null;
}

export async function getPostById(env: Env, id: number): Promise<PostRow | null> {
  const row = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<PostRow>();
  return row ?? null;
}

export async function createPost(
  env: Env,
  streamerId: number,
  channelId: number,
  kind: PostKind,
  telegramChatId: number,
  telegramMessageId: number,
): Promise<PostRow> {
  const row = await env.DB.prepare(
    `INSERT INTO posts (streamer_id, channel_id, kind, telegram_chat_id, telegram_message_id)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(streamerId, channelId, kind, telegramChatId, telegramMessageId)
    .first<PostRow>();
  if (!row) throw new Error("Failed to create post");
  return row;
}

export async function addPostPlatform(
  env: Env,
  postId: number,
  socialAccountId: number,
  platform: Platform,
  contentId: string | null,
  url: string,
): Promise<PostPlatformRow> {
  const row = await env.DB.prepare(
    `INSERT INTO post_platforms (post_id, social_account_id, platform, content_id, url)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(postId, socialAccountId, platform, contentId, url)
    .first<PostPlatformRow>();
  if (!row) throw new Error("Failed to add post platform");
  return row;
}

export async function listPostPlatforms(env: Env, postId: number): Promise<PostPlatformRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM post_platforms WHERE post_id = ? ORDER BY created_at ASC",
  )
    .bind(postId)
    .all<PostPlatformRow>();
  return results ?? [];
}

export async function listOpenPostPlatforms(env: Env, postId: number): Promise<PostPlatformRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM post_platforms WHERE post_id = ? AND ended = 0 ORDER BY created_at ASC",
  )
    .bind(postId)
    .all<PostPlatformRow>();
  return results ?? [];
}

export async function findOpenPostPlatformForAccount(
  env: Env,
  socialAccountId: number,
): Promise<PostPlatformRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM post_platforms WHERE social_account_id = ? AND ended = 0 ORDER BY created_at DESC LIMIT 1",
  )
    .bind(socialAccountId)
    .first<PostPlatformRow>();
  return row ?? null;
}

/** True if this exact piece of content (by platform content_id, e.g. a
 * YouTube video id) was already posted for this social account, in ANY
 * post -- live or video, open or closed. Was defined but unused; now used
 * by src/scheduled.ts as a guard against re-announcing the same stream
 * once it turns into a VOD: YouTube's RSS feed can briefly stop listing a
 * video as the latest entry while it's mid-transition from "live" to
 * "video", which can make last_video_id drift to an older id for one poll
 * and then "see" the same content_id again as if it were new when the feed
 * catches up. Checking post_platforms directly catches that regardless of
 * what last_video_id currently holds. */
export async function contentAlreadyPosted(
  env: Env,
  socialAccountId: number,
  contentId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM post_platforms WHERE social_account_id = ? AND content_id = ? LIMIT 1",
  )
    .bind(socialAccountId, contentId)
    .first<{ id: number }>();
  return row !== null;
}

export async function closePostPlatform(env: Env, id: number): Promise<void> {
  await env.DB.prepare("UPDATE post_platforms SET ended = 1 WHERE id = ?").bind(id).run();
}

export async function closePost(env: Env, id: number): Promise<void> {
  await env.DB.prepare("UPDATE posts SET is_open = 0, closed_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}
