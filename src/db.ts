import type {
  ChannelRow,
  Env,
  Platform,
  PostKind,
  PostPlatformRow,
  PostRow,
  SessionState,
  SocialAccountRow,
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
  await env.DB.prepare(`UPDATE channels SET ${flag} = 1 - ${flag} WHERE id = ?`).bind(channelId).run();
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

export async function getStreamerById(env: Env, id: number): Promise<StreamerRow | null> {
  const row = await env.DB.prepare("SELECT * FROM streamers WHERE id = ?").bind(id).first<StreamerRow>();
  return row ?? null;
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

// ---------------------------------------------------------------------------
// social_accounts
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

export async function createSocialAccount(
  env: Env,
  streamerId: number,
  platform: Platform,
  platformUsername: string,
  platformUserId: string | null,
  eventsubSubscriptionId: string | null,
): Promise<SocialAccountRow> {
  const row = await env.DB.prepare(
    `INSERT INTO social_accounts
       (streamer_id, platform, platform_username, platform_user_id, eventsub_subscription_id)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(streamerId, platform, platformUsername, platformUserId, eventsubSubscriptionId)
    .first<SocialAccountRow>();
  if (!row) throw new Error("Failed to create social account");
  return row;
}

export async function getSocialAccountsByTwitchUserId(
  env: Env,
  twitchUserId: string,
): Promise<SocialAccountRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM social_accounts WHERE platform = 'twitch' AND platform_user_id = ?",
  )
    .bind(twitchUserId)
    .all<SocialAccountRow>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// posts / post_platforms
// ---------------------------------------------------------------------------

/** Minutes a 'video' post stays eligible for another platform to merge into
 * (see schema.sql comment on `posts.kind`). 'live' posts don't need a
 * window: they stay open for as long as is_open=1, i.e. for as long as
 * something under them is still live. */
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

export async function getPostById(env: Env, id: number): Promise<PostRow | null> {
  const row = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<PostRow>();
  return row ?? null;
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

/** Finds the still-open post_platforms row for this account, if any — used
 * to locate what to close when a platform goes offline (or, for video
 * posts, is superseded). */
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

/** Idempotency guard: true if this exact piece of content (stream id / video
 * id) was already posted for this account, so a duplicate webhook delivery
 * or checker run doesn't double-post. */
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

// ---------------------------------------------------------------------------
// twitch_token cache
// ---------------------------------------------------------------------------

export async function getCachedTwitchToken(
  env: Env,
): Promise<{ access_token: string; expires_at: number } | null> {
  const row = await env.DB.prepare("SELECT access_token, expires_at FROM twitch_token WHERE id = 1").first<{
    access_token: string;
    expires_at: number;
  }>();
  return row ?? null;
}

export async function setCachedTwitchToken(env: Env, accessToken: string, expiresAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO twitch_token (id, access_token, expires_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at`,
  )
    .bind(accessToken, expiresAt)
    .run();
}
