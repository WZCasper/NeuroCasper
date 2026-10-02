// YouTube has no free push notification for "went live" specifically — only
// the RSS/Atom feed (new video entries, including live broadcasts, since
// YouTube creates the video resource the moment a broadcast starts) and,
// optionally, the Data API v3 for a reliable live/not-live flag. Both paths
// are implemented; the Data API is used only if YOUTUBE_API_KEY is set.
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export interface YoutubeLatestVideo {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
}

interface RssEntry {
  "yt:videoId"?: string;
  title?: string;
  "media:group"?: {
    "media:thumbnail"?: { "@_url"?: string };
  };
}

export async function fetchLatestVideo(channelId: string): Promise<YoutubeLatestVideo | null> {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
  if (!res.ok) {
    if (res.status === 404) return null; // channel has no videos / feed not found
    throw new Error(`YouTube RSS fetch failed: ${res.status}`);
  }
  const xml = await res.text();
  const parsed = parser.parse(xml) as { feed?: { entry?: RssEntry | RssEntry[] } };

  const rawEntries = parsed.feed?.entry;
  const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : [];
  const first = entries[0];
  if (!first) return null;

  const videoId = first["yt:videoId"];
  if (!videoId) return null;

  return {
    videoId,
    title: typeof first.title === "string" ? first.title : "",
    thumbnailUrl: first["media:group"]?.["media:thumbnail"]?.["@_url"] ?? null,
  };
}

export interface YoutubeLiveNow {
  videoId: string;
  title: string;
}

/** Checks whether a channel is live RIGHT NOW, bypassing the RSS feed
 * entirely. Every YouTube channel has a permanent redirect at
 * /channel/{id}/live that goes straight to the current broadcast's watch
 * page while one is active (this is the same URL YouTube itself uses for
 * the "Watch live" links on a channel page), or to the channel's streams
 * tab otherwise. The RSS feed used by fetchLatestVideo() is fine for
 * catching new *videos*, but YouTube can take anywhere from a few minutes
 * up to roughly half an hour to list a just-started broadcast there --
 * this redirect reflects the live status immediately, so calling this
 * first is what actually gets a "went live" notification out quickly.
 * Costs no API quota and needs no YOUTUBE_API_KEY. */
export async function checkChannelLiveNow(channelId: string): Promise<YoutubeLiveNow | null> {
  let res: Response;
  try {
    res = await fetch(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`, {
      redirect: "follow",
    });
  } catch (err) {
    console.error("YouTube /live redirect check failed", err);
    return null;
  }
  if (!res.ok) return null;

  // If the channel is live, the redirect lands on /watch?v=<id>. If it
  // isn't, it lands on the channel's own streams/about page instead --
  // never on a /watch URL -- so checking the final URL's path is enough on
  // its own, without needing to also re-check the page body.
  const finalUrl = new URL(res.url);
  const videoId = finalUrl.pathname === "/watch" ? finalUrl.searchParams.get("v") : null;
  if (!videoId) return null;

  const html = await res.text();
  const isActuallyLive = /"isLiveNow":\s*true/.test(html) || /"liveBroadcastContent":\s*"live"/.test(html);
  if (!isActuallyLive) return null;

  const titleMatch = /<title>([^<]*)<\/title>/.exec(html);
  const rawTitle = titleMatch?.[1] ?? "";
  // The <title> tag is HTML-entity-encoded and YouTube appends " - YouTube".
  const title = rawTitle
    .replace(/\s*-\s*YouTube$/, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

  return { videoId, title };
}

/** With YOUTUBE_API_KEY set: one videos.list call, reading the official
 * liveBroadcastContent flag — reliable. Without a key: a best-effort regex
 * check on the watch page's embedded player state, which is not officially
 * documented and can stop matching if YouTube changes their page markup. */
export async function checkIsCurrentlyLive(videoId: string | null, apiKey: string | undefined): Promise<boolean> {
  if (!videoId) return false;

  if (apiKey) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`,
      );
      if (res.ok) {
        const json = (await res.json()) as { items?: Array<{ snippet?: { liveBroadcastContent?: string } }> };
        const content = json.items?.[0]?.snippet?.liveBroadcastContent;
        if (content) return content === "live";
      } else {
        console.error(`YouTube Data API request failed (${res.status}), falling back to heuristic check`);
      }
    } catch (err) {
      console.error("YouTube Data API live check failed, falling back to heuristic", err);
    }
  }

  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    if (!res.ok) return false;
    const html = await res.text();
    return /"isLiveNow":\s*true/.test(html) || /"liveBroadcastContent":\s*"live"/.test(html);
  } catch (err) {
    console.error("YouTube live-status heuristic check failed", err);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same question as checkIsCurrentlyLive, but for content that was JUST
 * discovered this same poll (i.e. this is the very first time we've seen
 * this videoId). A negative answer here is ambiguous in a way it isn't for
 * already-known content: YouTube can take anywhere from a few seconds up
 * to a couple of minutes, after a broadcast starts, before either the
 * official liveBroadcastContent flag or the embedded "isLiveNow" marker on
 * the watch page actually flips to true -- the video resource and its
 * watch URL both exist and work immediately, only the flag lags. Treating
 * that lag as "it's a regular video" is how a genuine live stream gets
 * mis-announced as "new video" (see src/lib/publish.ts's buildCaption),
 * and once that first, wrong post exists, a later correct re-check of the
 * SAME videoId is suppressed by contentAlreadyPosted (src/db.ts) -- so if a
 * second poll happens after the video-post merge window has closed, it
 * creates a second, separate Telegram message instead of nothing at all.
 * A single delayed re-check here is what actually prevents both of those
 * downstream symptoms, rather than papering over either one after the
 * fact. Ordinary videos (uploaded, not streamed) stay firmly "not live" on
 * both the first and the second check, so this adds one extra fetch only
 * for the rare case that matters and never changes the outcome for a real
 * upload. */
export async function checkIsCurrentlyLiveForNewContent(
  videoId: string | null,
  apiKey: string | undefined,
): Promise<boolean> {
  if (!videoId) return false;
  if (await checkIsCurrentlyLive(videoId, apiKey)) return true;
  await sleep(LIVE_FLAG_RECHECK_DELAY_MS);
  return checkIsCurrentlyLive(videoId, apiKey);
}

/** How long to wait before the one re-check in
 * checkIsCurrentlyLiveForNewContent. Long enough for YouTube's live flag to
 * have caught up in the vast majority of cases observed in practice, short
 * enough to stay well inside the Cron Trigger's execution budget even when
 * several accounts hit this path in the same run (each account's check
 * already runs through src/lib/concurrency.ts's pool, so this delay on one
 * account doesn't block any other account's check from proceeding). */
export const LIVE_FLAG_RECHECK_DELAY_MS = 8_000;
