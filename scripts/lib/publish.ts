// Node counterpart of src/lib/publish.ts — same "post or merge" rules,
// talking to D1 over REST and Telegram over raw fetch instead of the Worker
// bindings/grammY. Keep the two in sync if you change the merge behaviour.
import type { D1Config } from "./d1-client.js";
import {
  addPostPlatform,
  closePost,
  closePostPlatform,
  createPost,
  findOpenPost,
  findOpenPostPlatformForAccount,
  getChannelById,
  getPostById,
  listOpenPostPlatforms,
  listPostPlatforms,
} from "./db.js";
import { buildPlatformButtons } from "./buttons.js";
import { generateFallbackPreview } from "./preview-image.js";
import { editMessageReplyMarkup, pinChatMessage, sendPhotoBytes, sendPhotoUrl, unpinChatMessage } from "./telegram.js";
import type { ChannelRow, Platform, PostKind } from "./types.js";

export interface PublishInput {
  d1: D1Config;
  botToken: string;
  channel: ChannelRow;
  streamerId: number;
  streamerName: string;
  socialAccountId: number;
  platform: Platform;
  kind: PostKind;
  url: string;
  contentId: string | null;
  title: string;
  /** Real thumbnail URL from the platform, or null to render the fallback card. */
  thumbnailUrl: string | null;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] as string) : match,
  );
}

function buildCaption(channel: ChannelRow, kind: PostKind, streamerName: string, title: string): string {
  const header =
    kind === "live" ? `\u{1F534} ${streamerName} is live!` : `\u{1F3AC} New video from ${streamerName}!`;
  const body = renderTemplate(channel.message_template, {
    streamer: streamerName,
    platform: "",
    title,
    game: "",
    link: "",
  }).trim();
  return body ? `${header}\n\n${body}` : header;
}

/** Call when a platform goes live / publishes new content for a streamer.
 * Merges into an already-open post for the same streamer+kind if one
 * exists, otherwise creates a new Telegram message. */
export async function publishOrMerge(input: PublishInput): Promise<void> {
  const { d1, botToken, channel, streamerId, streamerName, socialAccountId, platform, kind, url, contentId } = input;

  const openPost = await findOpenPost(d1, streamerId, kind);

  if (openPost) {
    try {
      await addPostPlatform(d1, openPost.id, socialAccountId, platform, contentId, url);
    } catch (err) {
      console.error(`addPostPlatform failed for post ${openPost.id}`, err);
      return;
    }
    const platforms = await listPostPlatforms(d1, openPost.id);
    const buttons = buildPlatformButtons(
      platforms.filter((p) => !p.ended).map((p) => ({ platform: p.platform, url: p.url })),
    );
    try {
      await editMessageReplyMarkup(botToken, openPost.telegram_chat_id, openPost.telegram_message_id, buttons);
    } catch (err) {
      console.error(`Failed to update buttons on post ${openPost.id}`, err);
    }
    return;
  }

  const caption = buildCaption(channel, kind, streamerName, input.title);
  const buttons = buildPlatformButtons([{ platform, url }]);

  let messageId: number;
  try {
    if (input.thumbnailUrl) {
      const msg = await sendPhotoUrl(botToken, channel.telegram_chat_id, input.thumbnailUrl, caption, buttons);
      messageId = msg.message_id;
    } else {
      const png = await generateFallbackPreview(platform, streamerName, kind);
      const msg = await sendPhotoBytes(botToken, channel.telegram_chat_id, png, "preview.png", caption, buttons);
      messageId = msg.message_id;
    }
  } catch (err) {
    console.error(`Failed to post ${kind} alert for streamer ${streamerId}`, err);
    return;
  }

  if (kind === "live" && channel.auto_pin) {
    try {
      await pinChatMessage(botToken, channel.telegram_chat_id, messageId);
    } catch (err) {
      console.error(`Failed to pin message ${messageId}`, err);
    }
  }

  try {
    const post = await createPost(d1, streamerId, channel.id, kind, channel.telegram_chat_id, messageId);
    await addPostPlatform(d1, post.id, socialAccountId, platform, contentId, url);
  } catch (err) {
    console.error(`Failed to record post for streamer ${streamerId}`, err);
  }
}

/** Call when a platform's live session ends. No-op for 'video' posts, which
 * have no offline event and just age out of the merge window on their own. */
export async function closeLivePlatform(d1: D1Config, botToken: string, socialAccountId: number): Promise<void> {
  const platformRow = await findOpenPostPlatformForAccount(d1, socialAccountId);
  if (!platformRow) return;

  await closePostPlatform(d1, platformRow.id);

  const post = await getPostById(d1, platformRow.post_id);
  if (!post) return;

  const remaining = await listOpenPostPlatforms(d1, post.id);
  if (remaining.length > 0) {
    const buttons = buildPlatformButtons(remaining.map((p) => ({ platform: p.platform, url: p.url })));
    try {
      await editMessageReplyMarkup(botToken, post.telegram_chat_id, post.telegram_message_id, buttons);
    } catch (err) {
      console.error(`Failed to trim buttons on post ${post.id}`, err);
    }
    return;
  }

  const channel = await getChannelById(d1, post.channel_id);
  if (channel?.auto_unpin) {
    try {
      await unpinChatMessage(botToken, post.telegram_chat_id, post.telegram_message_id);
    } catch (err) {
      console.error(`Failed to unpin message ${post.telegram_message_id}`, err);
    }
  }
  await closePost(d1, post.id);
}
