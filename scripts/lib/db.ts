import { d1Query, d1QueryOne, d1Run } from "./d1-client.js";
import type { D1Config } from "./d1-client.js";
import type { ChannelRow, ExtraLinkRow, PostKind, PostPlatformRow, PostRow, SocialAccountWithStreamer } from "./types.js";

export const VIDEO_POST_MERGE_WINDOW_MINUTES = 15;

export async function listExtraLinksByStreamer(config: D1Config, streamerId: number): Promise<ExtraLinkRow[]> {
  return d1Query<ExtraLinkRow>(config, "SELECT * FROM extra_links WHERE streamer_id = ? ORDER BY created_at ASC", [
    streamerId,
  ]);
}

export async function listSocialAccountsByPlatform(
  config: D1Config,
  platform: "youtube" | "tiktok",
): Promise<SocialAccountWithStreamer[]> {
  return d1Query<SocialAccountWithStreamer>(
    config,
    `SELECT sa.*, s.display_name AS streamer_display_name, s.channel_id AS streamer_channel_id
     FROM social_accounts sa
     JOIN streamers s ON s.id = sa.streamer_id
     WHERE sa.platform = ?`,
    [platform],
  );
}

export async function getChannelById(config: D1Config, id: number): Promise<ChannelRow | null> {
  return d1QueryOne<ChannelRow>(config, "SELECT * FROM channels WHERE id = ?", [id]);
}

export async function findOpenPost(config: D1Config, streamerId: number, kind: PostKind): Promise<PostRow | null> {
  if (kind === "live") {
    return d1QueryOne<PostRow>(
      config,
      "SELECT * FROM posts WHERE streamer_id = ? AND kind = 'live' AND is_open = 1 ORDER BY created_at DESC LIMIT 1",
      [streamerId],
    );
  }
  return d1QueryOne<PostRow>(
    config,
    `SELECT * FROM posts
     WHERE streamer_id = ? AND kind = 'video' AND is_open = 1
       AND created_at >= datetime('now', ?)
     ORDER BY created_at DESC LIMIT 1`,
    [streamerId, `-${VIDEO_POST_MERGE_WINDOW_MINUTES} minutes`],
  );
}

export async function getPostById(config: D1Config, id: number): Promise<PostRow | null> {
  return d1QueryOne<PostRow>(config, "SELECT * FROM posts WHERE id = ?", [id]);
}

export async function createPost(
  config: D1Config,
  streamerId: number,
  channelId: number,
  kind: PostKind,
  telegramChatId: number,
  telegramMessageId: number,
): Promise<PostRow> {
  const row = await d1QueryOne<PostRow>(
    config,
    `INSERT INTO posts (streamer_id, channel_id, kind, telegram_chat_id, telegram_message_id)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
    [streamerId, channelId, kind, telegramChatId, telegramMessageId],
  );
  if (!row) throw new Error("Failed to create post");
  return row;
}

export async function addPostPlatform(
  config: D1Config,
  postId: number,
  socialAccountId: number,
  platform: string,
  contentId: string | null,
  url: string,
): Promise<PostPlatformRow> {
  const row = await d1QueryOne<PostPlatformRow>(
    config,
    `INSERT INTO post_platforms (post_id, social_account_id, platform, content_id, url)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
    [postId, socialAccountId, platform, contentId, url],
  );
  if (!row) throw new Error("Failed to add post platform");
  return row;
}

export async function listPostPlatforms(config: D1Config, postId: number): Promise<PostPlatformRow[]> {
  return d1Query<PostPlatformRow>(config, "SELECT * FROM post_platforms WHERE post_id = ? ORDER BY created_at ASC", [
    postId,
  ]);
}

export async function listOpenPostPlatforms(config: D1Config, postId: number): Promise<PostPlatformRow[]> {
  return d1Query<PostPlatformRow>(
    config,
    "SELECT * FROM post_platforms WHERE post_id = ? AND ended = 0 ORDER BY created_at ASC",
    [postId],
  );
}

export async function findOpenPostPlatformForAccount(
  config: D1Config,
  socialAccountId: number,
): Promise<PostPlatformRow | null> {
  return d1QueryOne<PostPlatformRow>(
    config,
    "SELECT * FROM post_platforms WHERE social_account_id = ? AND ended = 0 ORDER BY created_at DESC LIMIT 1",
    [socialAccountId],
  );
}

export async function contentAlreadyPosted(
  config: D1Config,
  socialAccountId: number,
  contentId: string,
): Promise<boolean> {
  const row = await d1QueryOne<{ id: number }>(
    config,
    "SELECT id FROM post_platforms WHERE social_account_id = ? AND content_id = ? LIMIT 1",
    [socialAccountId, contentId],
  );
  return row !== null;
}

export async function closePostPlatform(config: D1Config, id: number): Promise<void> {
  await d1Run(config, "UPDATE post_platforms SET ended = 1 WHERE id = ?", [id]);
}

export async function closePost(config: D1Config, id: number): Promise<void> {
  await d1Run(config, "UPDATE posts SET is_open = 0, closed_at = datetime('now') WHERE id = ?", [id]);
}

export async function updateLastVideoId(config: D1Config, socialAccountId: number, videoId: string): Promise<void> {
  await d1Run(config, "UPDATE social_accounts SET last_video_id = ?, last_checked_at = datetime('now') WHERE id = ?", [
    videoId,
    socialAccountId,
  ]);
}

export async function touchLastCheckedAt(config: D1Config, socialAccountId: number): Promise<void> {
  await d1Run(config, "UPDATE social_accounts SET last_checked_at = datetime('now') WHERE id = ?", [socialAccountId]);
}
