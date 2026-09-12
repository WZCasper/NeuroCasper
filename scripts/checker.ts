// Entry point run by .github/workflows/3-checker.yml every 5 minutes. Polls
// YouTube (RSS + optional Data API) and TikTok (best-effort page check) for
// every tracked account, publishing or merging alerts exactly like
// scripts/lib/publish.ts describes (mirrors src/lib/publish.ts). Twitch is
// not monitored at all — registering a Twitch app needs 2FA that isn't
// available to every streamer, so it's handled as a static extra_links
// entry instead (see schema.sql), shown alongside whatever YouTube/TikTok
// activity actually triggers a post.
import { loadD1ConfigFromEnv } from "./lib/d1-client.js";
import {
  findOpenPostPlatformForAccount,
  getChannelById,
  listSocialAccountsByPlatform,
  touchLastCheckedAt,
  updateLastVideoId,
} from "./lib/db.js";
import type { D1Config } from "./lib/d1-client.js";
import { closeLivePlatform, publishOrMerge } from "./lib/publish.js";
import { checkTiktokStatus } from "./lib/tiktok.js";
import { checkIsCurrentlyLive, fetchLatestVideo } from "./lib/youtube.js";
import type { SocialAccountWithStreamer } from "./lib/types.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function checkYoutubeAccount(
  d1: D1Config,
  botToken: string,
  youtubeApiKey: string | undefined,
  account: SocialAccountWithStreamer,
): Promise<void> {
  if (!account.platform_user_id) return;

  // Re-check anything already tracked as live, in case it ended since the
  // last run (a live stream keeps the same video id for its whole duration,
  // so the RSS feed alone never signals "it ended").
  const openPlatformRow = await findOpenPostPlatformForAccount(d1, account.id);
  if (openPlatformRow) {
    const stillLive = await checkIsCurrentlyLive(openPlatformRow.content_id, youtubeApiKey);
    if (!stillLive) await closeLivePlatform(d1, botToken, account.id);
  }

  const latest = await fetchLatestVideo(account.platform_user_id);
  await touchLastCheckedAt(d1, account.id);
  if (!latest || latest.videoId === account.last_video_id) return;

  const channel = await getChannelById(d1, account.streamer_channel_id);
  if (!channel) return;

  const isLive = await checkIsCurrentlyLive(latest.videoId, youtubeApiKey);

  await publishOrMerge({
    d1,
    botToken,
    channel,
    streamerId: account.streamer_id,
    streamerName: account.streamer_display_name,
    socialAccountId: account.id,
    platform: "youtube",
    kind: isLive ? "live" : "video",
    url: `https://www.youtube.com/watch?v=${latest.videoId}`,
    contentId: latest.videoId,
    title: latest.title,
    thumbnailUrl: latest.thumbnailUrl,
  });

  await updateLastVideoId(d1, account.id, latest.videoId);
}

async function checkTiktokAccount(d1: D1Config, botToken: string, account: SocialAccountWithStreamer): Promise<void> {
  const status = await checkTiktokStatus(account.platform_username);
  await touchLastCheckedAt(d1, account.id);

  const openPlatformRow = await findOpenPostPlatformForAccount(d1, account.id);
  if (openPlatformRow && !status.isLive) {
    await closeLivePlatform(d1, botToken, account.id);
  }

  const channel = await getChannelById(d1, account.streamer_channel_id);
  if (!channel) return;

  if (status.isLive && !openPlatformRow) {
    await publishOrMerge({
      d1,
      botToken,
      channel,
      streamerId: account.streamer_id,
      streamerName: account.streamer_display_name,
      socialAccountId: account.id,
      platform: "tiktok",
      kind: "live",
      url: `https://www.tiktok.com/@${account.platform_username}/live`,
      contentId: status.roomId,
      title: "",
      thumbnailUrl: null,
    });
  }

  if (status.latestVideoId && status.latestVideoId !== account.last_video_id) {
    await publishOrMerge({
      d1,
      botToken,
      channel,
      streamerId: account.streamer_id,
      streamerName: account.streamer_display_name,
      socialAccountId: account.id,
      platform: "tiktok",
      kind: "video",
      url: status.latestVideoUrl ?? `https://www.tiktok.com/@${account.platform_username}`,
      contentId: status.latestVideoId,
      title: "",
      thumbnailUrl: null,
    });
    await updateLastVideoId(d1, account.id, status.latestVideoId);
  }
}

async function main(): Promise<void> {
  const d1 = loadD1ConfigFromEnv();
  const botToken = requireEnv("BOT_TOKEN");
  const youtubeApiKey = process.env.YOUTUBE_API_KEY; // optional — see README

  const [youtubeAccounts, tiktokAccounts] = await Promise.all([
    listSocialAccountsByPlatform(d1, "youtube"),
    listSocialAccountsByPlatform(d1, "tiktok"),
  ]);

  console.log(
    `Checking ${youtubeAccounts.length} YouTube account(s) and ${tiktokAccounts.length} TikTok account(s)…`,
  );

  for (const account of youtubeAccounts) {
    try {
      await checkYoutubeAccount(d1, botToken, youtubeApiKey, account);
    } catch (err) {
      console.error(`YouTube check failed for account ${account.id} (${account.platform_username})`, err);
    }
  }

  for (const account of tiktokAccounts) {
    try {
      await checkTiktokAccount(d1, botToken, account);
    } catch (err) {
      console.error(`TikTok check failed for account ${account.id} (${account.platform_username})`, err);
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Checker run failed:", err);
  process.exitCode = 1;
});
