// YouTube has no free push notification for "went live" specifically.
// Three detection paths are implemented here:
//   - checkChannelLiveNow: "is this channel live RIGHT NOW" -- tries the
//     official Data API v3 (search.list) first when YOUTUBE_API_KEY is
//     set, since that's reliable and gives a real thumbnail; falls back
//     to scraping the /channel/{id}/live redirect otherwise.
//   - fetchLatestVideo: the RSS/Atom feed, for catching new *videos*
//     (including live broadcasts, since YouTube creates the video
//     resource the moment a broadcast starts), with real thumbnails of
//     its own (from the feed itself, no API key needed).
//   - checkIsCurrentlyLive / checkIsCurrentlyLiveForNewContent: "is this
//     ALREADY-KNOWN videoId live" -- the official Data API v3
//     (videos.list) when a key is set, else a page-scraping heuristic.
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
  /** Real thumbnail URL, or null when this came from the no-API-key HTML
   * fallback (checkChannelLiveNowViaScraping below), which never has one. */
  thumbnailUrl: string | null;
}

interface YoutubeSearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    liveBroadcastContent?: string;
    thumbnails?: { high?: { url?: string }; medium?: { url?: string }; default?: { url?: string } };
  };
}

/** The reliable half of checkChannelLiveNow below: one official Data API
 * v3 search.list call (part=snippet, eventType=live, type=video), which
 * asks YouTube directly "is this channel live right now" and gets back
 * videoId, title AND a real thumbnail in the same response -- no HTML
 * parsing, nothing that depends on page markup staying the same, and
 * (this is the part that actually matters for a server running on
 * Cloudflare Workers) no exposure to YouTube's anti-bot gate: that gate
 * applies to its ordinary web PAGES, not to api.googleapis.com,
 * because this is the access path Google wants server-side callers to
 * use, not one they're trying to keep server-side callers off of. See
 * checkChannelLiveNow's own comment for why that gate is the reason this
 * function exists at all rather than always scraping the /live redirect.
 *
 * Costs 100 quota units per call (search.list's documented cost -- most
 * other YouTube Data API calls, videos.list included, cost only 1), out of
 * a free default daily allowance of 10,000 units shared across a whole
 * API key. checkChannelLiveNow only calls this once per cron tick for a
 * channel that doesn't already have an open live post (see
 * src/scheduled.ts), so normal use stays affordable; a key shared with
 * many other call volumes, or watching a very large number of channels on
 * a short cron interval, could still exhaust it -- a thrown/non-OK
 * response here is caught by the caller and treated as "couldn't confirm
 * via the API", falling through to the scraping heuristic for that cycle
 * rather than failing the whole check. */
async function checkChannelLiveViaApi(channelId: string, apiKey: string): Promise<YoutubeLiveNow | null> {
  const url =
    `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}` +
    `&eventType=live&type=video&maxResults=1&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube search.list (live check) failed: ${res.status}`);

  const json = (await res.json()) as { items?: YoutubeSearchItem[] };
  const item = json.items?.[0];
  const videoId = item?.id?.videoId;
  if (!videoId) return null; // an empty items[] IS the documented "not live" answer, not an error

  const thumbnails = item?.snippet?.thumbnails;
  return {
    videoId,
    title: item?.snippet?.title ?? "",
    thumbnailUrl: thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url ?? null,
  };
}

/** The no-API-key fallback: YouTube channel has a permanent redirect at
 * /channel/{id}/live that goes straight to the current broadcast's watch
 * page while one is active (this is the same URL YouTube itself uses for
 * the "Watch live" links on a channel page), or to the channel's streams
 * tab otherwise.
 *
 * In principle this reflects live status immediately, with none of the
 * RSS feed's publishing lag -- but in practice, as of late 2025, YouTube
 * serves requests from datacenter/cloud IP ranges (which is what a
 * Cloudflare Workers fetch() always originates from) an interstitial
 * "Sign in to confirm you're not a bot" page instead of the real one,
 * HTTP 200 but with none of the markup this function looks for. This is
 * a widely documented anti-bot measure, not something specific to this
 * project or something a different regex could work around -- see this
 * project's README for sources. The practical effect: WITHOUT
 * YOUTUBE_API_KEY configured, this heuristic will often fail to detect a
 * stream that is genuinely live, which is why checkChannelLiveNow tries
 * the official API first whenever a key is available, and this is only
 * the fallback for when one isn't. */
async function checkChannelLiveNowViaScraping(channelId: string): Promise<YoutubeLiveNow | null> {
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

  // This path never has a real thumbnail: the page is already downloaded
  // here, but unlike the official API's response it doesn't carry a
  // ready-made thumbnail URL in a stable, documented field -- only the
  // same kind of embedded, undocumented JSON blob the isLiveNow check
  // above already depends on, and guessing a thumbnail field out of that
  // would be exactly one more unverifiable scraping assumption stacked on
  // the ones this function already has to make. generateFallbackPreview
  // (src/lib/publish.ts) covers this case.
  return { videoId, title, thumbnailUrl: null };
}

/** Checks whether a channel is live RIGHT NOW, bypassing the RSS feed
 * entirely (the RSS feed used by fetchLatestVideo() is fine for catching
 * new *videos*, but YouTube can take anywhere from a few minutes up to
 * roughly half an hour to list a just-started broadcast there -- calling
 * this first is what actually gets a "went live" notification out
 * quickly). Tries the official, reliable Data API path
 * (checkChannelLiveViaApi) whenever YOUTUBE_API_KEY is configured, and
 * only falls back to the HTML-scraping heuristic
 * (checkChannelLiveNowViaScraping) if no key is set, or if the API call
 * itself fails for any reason (network error, quota exhausted, YouTube
 * API outage) -- see checkChannelLiveViaApi's own comment on why a
 * failure there should degrade gracefully rather than abort the whole
 * check. */
export async function checkChannelLiveNow(channelId: string, apiKey: string | undefined): Promise<YoutubeLiveNow | null> {
  if (apiKey) {
    try {
      return await checkChannelLiveViaApi(channelId, apiKey);
    } catch (err) {
      console.error(`YouTube search.list live check failed for channel ${channelId}, falling back to scraping:`, err);
    }
  }
  return checkChannelLiveNowViaScraping(channelId);
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
