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
  claimPostSlot,
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
  releasePostSlot,
} from "../db.js";
import { buildKeyboard } from "./buttons.js";
import { renderTemplate } from "./message-templates.js";
import { generateFallbackPreview } from "./preview-image.js";
import type { ChannelRow, Env, Platform, PostKind, PostRow } from "../types.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How many times to back off and retry when another request already holds
 * the post_claims slot for this streamer+kind, and how long to wait between
 * retries -- see the comment on the retry loop in publishOrMerge. Five
 * retries at 400ms is up to ~2s of extra latency in the rare contended
 * case; a normal claim -> send Telegram message -> createPost -> release
 * cycle finishes in well under a second, so this is generous headroom, not
 * a tight budget. */
const MAX_CLAIM_RETRIES = 5;
const CLAIM_RETRY_DELAY_MS = 400;

async function mergeIntoOpenPost(input: PublishInput, openPost: PostRow): Promise<void> {
  const { env, api, streamerId, socialAccountId, platform, contentId, url } = input;
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
}

async function createNewPost(input: PublishInput): Promise<void> {
  const { env, api, channel, streamerId, streamerName, socialAccountId, platform, kind, url, contentId } = input;

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

/** Call when a monitored platform goes live / publishes new content for a
 * streamer. Merges into an already-open post for the same streamer+kind if
 * one exists, otherwise creates a new Telegram message.
 *
 * Safe to call concurrently for the same streamer+kind, from either of the
 * two places that can happen:
 *  - Two accounts of the SAME streamer checked in the SAME Worker
 *    invocation (e.g. one streamer tracked on both YouTube and TikTok, both
 *    going live in the same 5-minute cron run) -- prevented from ever
 *    reaching here concurrently in the first place by
 *    src/lib/streamer-serializer.ts, which src/scheduled.ts routes every
 *    call through.
 *  - Two genuinely SEPARATE invocations -- a Kick webhook (src/handlers/kick.ts)
 *    landing mid-cron-run, or two overlapping cron runs -- which an
 *    in-memory lock can't reach. This is what the claim/retry loop below
 *    guards against, via src/db.ts's claimPostSlot/releasePostSlot. */
export async function publishOrMerge(input: PublishInput): Promise<void> {
  const { env, streamerId, kind } = input;

  for (let attempt = 0; ; attempt++) {
    const openPost = await findOpenPost(env, streamerId, kind);
    if (openPost) {
      await mergeIntoOpenPost(input, openPost);
      return;
    }

    // No open post to merge into -- about to create a brand-new one. Claim
    // the right to do so BEFORE calling the Telegram API, so a concurrent
    // caller for this exact streamer+kind (see this function's own doc
    // comment for the two ways that happens) can't make this same "no open
    // post yet" read and independently send its own message too.
    const claimed = await claimPostSlot(env, streamerId, kind);
    if (claimed) {
      try {
        await createNewPost(input);
      } finally {
        await releasePostSlot(env, streamerId, kind);
      }
      return;
    }

    if (attempt < MAX_CLAIM_RETRIES) {
      // Another request is (very likely) mid-flight creating the first
      // post for this exact streamer+kind right now. Back off briefly and
      // re-check from the top -- by the time this runs, that request has
      // almost always already finished, so findOpenPost above will find
      // its post and this merges into it instead of racing it again.
      await sleep(CLAIM_RETRY_DELAY_MS);
      continue;
    }

    // Gave the claim holder up to MAX_CLAIM_RETRIES * CLAIM_RETRY_DELAY_MS
    // and its post still isn't visible -- far longer than a normal
    // claim/send/create/release cycle takes, so treat this as abnormal
    // rather than keep retrying forever. Proceed WITHOUT the claim rather
    // than silently dropping a genuine "went live" notification: a rare
    // duplicate message is a much better failure mode than a missed one.
    // (Not wrapped in a release call below -- we were never granted this
    // claim, so there is nothing of ours to release.)
    console.error(
      `publishOrMerge: post_claims still held for streamer ${streamerId}/${kind} after ${MAX_CLAIM_RETRIES} retries — publishing without the claim`,
    );
    await createNewPost(input);
    return;
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
