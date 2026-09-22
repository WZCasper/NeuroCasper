// Shared "post or merge" logic: when a streamer's monitored platform goes
// live / posts a new video, either fold it into an already-open post for
// that streamer (adding a button) or create a fresh one. Every post also
// gets the streamer's extra_links (Twitch, Discord, etc.) appended as
// static buttons, regardless of which monitored platform triggered it.
// Called from src/scheduled.ts (Cloudflare Cron Trigger), which replaced
// the old GitHub Actions checker script for reliability -- GitHub's cron
// scheduling isn't precise enough for a 5-minute interval.
import { InputFile } from "grammy";
import type { Api } from "grammy";
import {
  addPostPlatform,
  closePost,
  closePostPlatform,
  createPost,
  findOpenPost,
  findOpenPostPlatformForAccount,
  getChannelById,
  getPostById,
  listExtraLinksByStreamer,
  listOpenPostPlatforms,
  listPostPlatforms,
} from "../db.js";
import { buildKeyboard } from "./buttons.js";
import { renderTemplate } from "./message-templates.js";
import { generateFallbackPreview } from "./preview-image.js";
import type { ChannelRow, Env, Platform, PostKind } from "../types.js";

export interface PublishInput {
  env: Env;
  api: Api;
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

/** Call when a monitored platform goes live / publishes new content for a
 * streamer. Merges into an already-open post for the same streamer+kind if
 * one exists, otherwise creates a new Telegram message. */
export async function publishOrMerge(input: PublishInput): Promise<void> {
  const { env, api, channel, streamerId, streamerName, socialAccountId, platform, kind, url, contentId } = input;

  // Known race, deliberately not fully closed: this read-then-decide is not
  // atomic with the INSERT further down, so two "went live" events for the
  // same streamer arriving close enough together (realistic case: a Kick
  // webhook lands while this same function is mid-call for that streamer's
  // YouTube/TikTok check on the 5-minute cron -- see src/scheduled.ts) can
  // both read "no open post" here before either has inserted one, each then
  // sending its own Telegram message. schema.sql's
  // idx_posts_one_open_live_per_streamer makes the second createPost() call
  // below fail loudly (caught and logged, not silent) instead of both
  // succeeding as two independently-tracked posts -- but by then the
  // losing request's Telegram message has typically already been sent, so
  // it stops the worse outcome (two posts silently drifting apart, e.g.
  // only one ever getting unpinned) without preventing a rare duplicate
  // message. Closing that fully would need claiming the post row (e.g. an
  // INSERT ... ON CONFLICT DO NOTHING) before calling the Telegram API,
  // which is a bigger restructure than this fix -- worth doing if
  // duplicate posts turn out to happen in practice.
  const openPost = await findOpenPost(env, streamerId, kind);

  if (openPost) {
    try {
      await addPostPlatform(env, openPost.id, socialAccountId, platform, contentId, url);
    } catch (err) {
      console.error(`addPostPlatform failed for post ${openPost.id}`, err);
      return;
    }
    const [platforms, extraLinks] = await Promise.all([
      listPostPlatforms(env, openPost.id),
      listExtraLinksByStreamer(env, streamerId),
    ]);
    const kb = buildKeyboard(
      platforms.filter((p) => !p.ended).map((p) => ({ platform: p.platform, url: p.url })),
      extraLinks,
    );
    try {
      await api.editMessageReplyMarkup(openPost.telegram_chat_id, openPost.telegram_message_id, {
        reply_markup: kb,
      });
    } catch (err) {
      console.error(`Failed to update buttons on post ${openPost.id}`, err);
    }
    return;
  }

  const extraLinks = await listExtraLinksByStreamer(env, streamerId);
  const caption = buildCaption(channel, kind, streamerName, input.title);
  const kb = buildKeyboard([{ platform, url }], extraLinks);

  let messageId: number;
  try {
    if (input.thumbnailUrl) {
      const msg = await api.sendPhoto(channel.telegram_chat_id, input.thumbnailUrl, {
        caption,
        reply_markup: kb,
      });
      messageId = msg.message_id;
    } else {
      const png = await generateFallbackPreview(platform, streamerName, kind);
      const msg = await api.sendPhoto(channel.telegram_chat_id, new InputFile(png, "preview.png"), {
        caption,
        reply_markup: kb,
      });
      messageId = msg.message_id;
    }
  } catch (err) {
    console.error(`Failed to post ${kind} alert for streamer ${streamerId}`, err);
    return;
  }

  if (kind === "live" && channel.auto_pin) {
    try {
      await api.pinChatMessage(channel.telegram_chat_id, messageId, { disable_notification: true });
    } catch (err) {
      console.error(`Failed to pin message ${messageId}`, err);
    }
  }

  try {
    const post = await createPost(env, streamerId, channel.id, kind, channel.telegram_chat_id, messageId);
    await addPostPlatform(env, post.id, socialAccountId, platform, contentId, url);
  } catch (err) {
    console.error(`Failed to record post for streamer ${streamerId}`, err);
  }
}

/** Call when a monitored platform goes offline for a streamer. Trims that
 * platform's button off the post (re-adding extra_links, since editing the
 * reply markup replaces the whole keyboard); unpins + closes the post once
 * every monitored platform under it has ended. No-op for 'video' posts,
 * which have no offline event and just age out of the merge window. */
export async function closeLivePlatform(env: Env, api: Api, socialAccountId: number): Promise<void> {
  const platformRow = await findOpenPostPlatformForAccount(env, socialAccountId);
  if (!platformRow) return;

  await closePostPlatform(env, platformRow.id);

  const post = await getPostById(env, platformRow.post_id);
  if (!post) return;

  const remaining = await listOpenPostPlatforms(env, post.id);
  if (remaining.length > 0) {
    const extraLinks = await listExtraLinksByStreamer(env, post.streamer_id);
    const kb = buildKeyboard(remaining.map((p) => ({ platform: p.platform, url: p.url })), extraLinks);
    try {
      await api.editMessageReplyMarkup(post.telegram_chat_id, post.telegram_message_id, { reply_markup: kb });
    } catch (err) {
      console.error(`Failed to trim buttons on post ${post.id}`, err);
    }
    return;
  }

  // No monitored platform is still live under this post. Its buttons would
  // otherwise keep pointing at a stream that's already over, so trim them
  // down to just the extra_links (Twitch etc. are never checked for
  // "still live" -- see schema.sql's comment on extra_links -- so those
  // stay valid and worth keeping clickable).
  const extraLinks = await listExtraLinksByStreamer(env, post.streamer_id);
  try {
    if (extraLinks.length > 0) {
      const kb = buildKeyboard([], extraLinks);
      await api.editMessageReplyMarkup(post.telegram_chat_id, post.telegram_message_id, { reply_markup: kb });
    } else {
      await api.editMessageReplyMarkup(post.telegram_chat_id, post.telegram_message_id);
    }
  } catch (err) {
    console.error(`Failed to clear buttons on post ${post.id}`, err);
  }

  const channel = await getChannelById(env, post.channel_id);
  if (channel?.auto_unpin) {
    try {
      await api.unpinChatMessage(post.telegram_chat_id, post.telegram_message_id);
    } catch (err) {
      console.error(`Failed to unpin message ${post.telegram_message_id}`, err);
    }
  }
  await closePost(env, post.id);
}
