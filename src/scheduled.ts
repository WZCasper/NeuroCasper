// Cloudflare Cron Trigger handler (see wrangler.toml's [triggers] and
// src/index.ts's scheduled() export). Runs every 5 minutes, on Cloudflare's
// own infrastructure rather than a GitHub Actions runner -- the previous
// approach (scripts/checker.ts on a GitHub Actions cron) worked, but
// GitHub's scheduled-workflow timing isn't precise; delays of up to an hour
// are a known, documented GitHub Actions limitation for low-traffic repos,
// not a bug in the checker logic itself. Cloudflare Cron Triggers run on
// the same platform as the Worker and keep much tighter to schedule.
//
// Polls YouTube (fast /live redirect check + RSS + optional Data API) and
// TikTok (best-effort page check) for every tracked account, publishing or
// merging alerts via src/lib/publish.ts.
import { Api } from "grammy";
import {
  contentAlreadyPosted,
  findOpenPostPlatformForAccount,
  getChannelById,
  listSocialAccountsByPlatform,
  touchLastCheckedAt,
  updateLastVideoId,
} from "./db.js";
import { closeLivePlatform, publishOrMerge } from "./lib/publish.js";
import { checkTiktokStatus } from "./lib/tiktok.js";
import { checkChannelLiveNow, checkIsCurrentlyLive, fetchLatestVideo } from "./lib/youtube.js";
import type { Env, SocialAccountWithStreamer } from "./types.js";

async function checkYoutubeAccount(
  env: Env,
  api: Api,
  account: SocialAccountWithStreamer,
): Promise<void> {
  if (!account.platform_user_id) return;

  // Re-check anything already tracked as live, in case it ended since the
  // last run (a live stream keeps the same video id for its whole duration,
  // so the RSS feed alone never signals "it ended").
  const openPlatformRow = await findOpenPostPlatformForAccount(env, account.id);
  if (openPlatformRow) {
    const stillLive = await checkIsCurrentlyLive(openPlatformRow.content_id, env.YOUTUBE_API_KEY);
    if (!stillLive) await closeLivePlatform(env, api, account.id);
  }

  // Fast path: the channel's permanent /live redirect reflects live status
  // immediately, unlike the RSS feed below, which can take a long time
  // (minutes, sometimes tens of minutes) to list a just-started broadcast.
  // Only worth checking if nothing is already tracked as live for this
  // account -- otherwise the openPlatformRow re-check above already covers
  // it (findOpenPostPlatformForAccount is scoped to this social_account_id,
  // so a row found here is always this same YouTube account's own live
  // post, never some other platform's).
  if (!openPlatformRow) {
    const liveNow = await checkChannelLiveNow(account.platform_user_id);
    if (liveNow && !(await contentAlreadyPosted(env, account.id, liveNow.videoId))) {
      const channel = await getChannelById(env, account.streamer_channel_id);
      if (channel) {
        await publishOrMerge({
          env,
          api,
          channel,
          streamerId: account.streamer_id,
          streamerName: account.streamer_display_name,
          socialAccountId: account.id,
          platform: "youtube",
          kind: "live",
          url: `https://www.youtube.com/watch?v=${liveNow.videoId}`,
          contentId: liveNow.videoId,
          title: liveNow.title,
          thumbnailUrl: null,
        });
        await updateLastVideoId(env, account.id, liveNow.videoId);
        // Already posted this run via the fast path -- skip the RSS check
        // below so a still-lagging feed entry for the same video doesn't
        // get processed a second time in this same pass.
        return;
      }
    }
  }

  const latest = await fetchLatestVideo(account.platform_user_id);
  await touchLastCheckedAt(env, account.id);
  if (!latest || latest.videoId === account.last_video_id) return;

  // Belt-and-suspenders guard on top of the last_video_id check above:
  // YouTube's RSS feed can briefly stop listing a just-ended stream as the
  // latest entry while it's being converted to a VOD (see
  // contentAlreadyPosted's comment in src/db.ts), which can make
  // last_video_id drift to an older id for one poll. If that happens, the
  // feed later "reintroduces" the same video and the check above alone
  // would treat it as new. Skip (but still resync last_video_id) if this
  // exact video was already posted for this account, under either kind.
  if (await contentAlreadyPosted(env, account.id, latest.videoId)) {
    await updateLastVideoId(env, account.id, latest.videoId);
    return;
  }

  const channel = await getChannelById(env, account.streamer_channel_id);
  if (!channel) return;

  const isLive = await checkIsCurrentlyLive(latest.videoId, env.YOUTUBE_API_KEY);

  await publishOrMerge({
    env,
    api,
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

  await updateLastVideoId(env, account.id, latest.videoId);
}

async function checkTiktokAccount(env: Env, api: Api, account: SocialAccountWithStreamer): Promise<void> {
  const status = await checkTiktokStatus(account.platform_username);
  await touchLastCheckedAt(env, account.id);

  const openPlatformRow = await findOpenPostPlatformForAccount(env, account.id);
  if (openPlatformRow && !status.isLive) {
    await closeLivePlatform(env, api, account.id);
  }

  const channel = await getChannelById(env, account.streamer_channel_id);
  if (!channel) return;

  if (status.isLive && !openPlatformRow) {
    await publishOrMerge({
      env,
      api,
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
      env,
      api,
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
    await updateLastVideoId(env, account.id, status.latestVideoId);
  }
}

export async function runScheduledCheck(env: Env): Promise<void> {
  const api = new Api(env.BOT_TOKEN);

  const [youtubeAccounts, tiktokAccounts] = await Promise.all([
    listSocialAccountsByPlatform(env, "youtube"),
    listSocialAccountsByPlatform(env, "tiktok"),
  ]);

  console.log(`Checking ${youtubeAccounts.length} YouTube account(s) and ${tiktokAccounts.length} TikTok account(s)…`);

  for (const account of youtubeAccounts) {
    try {
      await checkYoutubeAccount(env, api, account);
    } catch (err) {
      console.error(`YouTube check failed for account ${account.id} (${account.platform_username})`, err);
    }
  }

  for (const account of tiktokAccounts) {
    try {
      await checkTiktokAccount(env, api, account);
    } catch (err) {
      console.error(`TikTok check failed for account ${account.id} (${account.platform_username})`, err);
    }
  }

  console.log("Scheduled check done.");
}
