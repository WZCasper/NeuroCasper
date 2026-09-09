// TikTok has no public API for live status or a channel's video list, so this
// is best-effort screen-scraping of the public profile page — the only
// option without one. It fails closed (returns "not live, no new video")
// rather than throwing when the page doesn't match, since TikTok's markup is
// undocumented and can change without notice. Treat this module as the
// weakest link of the three platforms and expect it may need updating.
export interface TiktokStatus {
  isLive: boolean;
  roomId: string | null;
  latestVideoId: string | null;
  latestVideoUrl: string | null;
}

export async function checkTiktokStatus(username: string): Promise<TiktokStatus> {
  const empty: TiktokStatus = { isLive: false, roomId: null, latestVideoId: null, latestVideoUrl: null };
  try {
    const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
      headers: {
        // A browser-like UA; TikTok's server-rendered HTML (and the embedded
        // state JSON this relies on) can differ for obviously non-browser clients.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    if (!res.ok) return empty;
    const html = await res.text();

    const roomMatch = html.match(/"roomId":"(\d+)"/);
    const roomId = roomMatch?.[1] && roomMatch[1] !== "0" ? roomMatch[1] : null;

    const videoMatch = html.match(new RegExp(`/@${escapeRegExp(username)}/video/(\\d+)`));
    const latestVideoId = videoMatch?.[1] ?? null;

    return {
      isLive: roomId !== null,
      roomId,
      latestVideoId,
      latestVideoUrl: latestVideoId ? `https://www.tiktok.com/@${username}/video/${latestVideoId}` : null,
    };
  } catch (err) {
    console.error(`TikTok check failed for @${username}`, err);
    return empty;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
