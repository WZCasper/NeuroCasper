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
