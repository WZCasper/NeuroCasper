// D1 query helpers for the Worker's bot. The Worker only manages
// configuration (users, channels, streamers, monitored accounts, extra
// links) — it never touches posts/post_platforms, since all live/video
// detection and posting now happens in the checker script (scripts/,
// via GitHub Actions) rather than a Worker-side Twitch webhook. See
// scripts/lib/db.ts for the posts/post_platforms equivalents.
import type {
  ChannelRow,
  Env,
  ExtraLinkRow,
  Platform,
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
