// TikTok has no public API for live status or a channel's video list, so this
// is best-effort screen-scraping of the public profile page — the only
// option without one. It fails closed (returns "not live, no new video")
// rather than throwing when the page doesn't match, since TikTok's markup is
// undocumented and can change without notice. Treat this module as the
// weakest link of the two platforms and expect it may need updating.
export interface TiktokStatus {
  isLive: boolean;
  roomId: string | null;
  latestVideoId: string | null;
  latestVideoUrl: string | null;
  /** Best-effort live-room cover image, extracted from the same page this
   * already downloads to find roomId -- see extractLiveCoverUrl's own
   * comment for exactly how reliable this is expected to be in practice
   * (not very, by design: this is read from the same kind of undocumented
   * embedded JSON as roomId, just a different field in it). null when not
   * live, or when the page didn't contain a recognizable cover field. */
  coverUrl: string | null;
}

/** TikTok's server-rendered pages embed a big JSON state blob
 * (historically under a `SIGI_STATE` script tag, more recently
 * `__UNIVERSAL_DATA_FOR_REHYDRATION__`) that the page's own React app
 * hydrates from, and roomId above is already read out of that same blob.
 * TikTok represents essentially every image anywhere in their product --
 * avatars, video covers, live-room covers -- with the same recurring
 * shape: an object with a `url_list` array of equivalent CDN URLs. This
 * looks for that shape specifically inside a `"cover":{...}` field, which
 * is the key TikTok's own official client libraries also use for a live
 * room's cover image (not, for instance, an avatar field, which uses
 * different key names like `avatarLarger` -- scoping to `"cover"`
 * specifically is what keeps this from accidentally grabbing an unrelated
 * image elsewhere on the page).
 *
 * This is unavoidably a guess about undocumented, unversioned markup --
 * exactly the same category of fragility checkTiktokStatus's own module
 * comment already describes for the roomId extraction right above it, not
 * a new or different risk. It was not possible to verify this against a
 * real, currently-live TikTok room while writing this (there is no way to
 * reliably reach one for testing), so treat a working match here as a
 * bonus rather than a guarantee: generateFallbackPreview
 * (src/lib/publish.ts) is what actually covers TikTok whenever this
 * returns null, which in practice may be most or all of the time. */
function extractLiveCoverUrl(html: string): string | null {
  const match = html.match(/"cover"\s*:\s*\{\s*"url_list"\s*:\s*\[\s*"([^"]+)"/);
  if (!match?.[1]) return null;
  try {
    // The matched URL sits inside a JSON string literal, so it carries
    // JSON string escapes (\u0026 for &, \/ for /, etc.) -- decoding it by
    // parsing it AS a JSON string, rather than only unescaping the
    // couple of sequences that happen to be common, is what actually
    // reverses exactly the same escaping the embedding JSON applied, in
    // one step, whatever form it took.
    const decoded: unknown = JSON.parse(`"${match[1]}"`);
    return typeof decoded === "string" && decoded.length > 0 ? decoded : null;
  } catch {
    return null; // malformed match (unlikely, but this is still a guess) -- fail closed, not a thrown error
  }
}

export async function checkTiktokStatus(username: string): Promise<TiktokStatus> {
  const empty: TiktokStatus = { isLive: false, roomId: null, latestVideoId: null, latestVideoUrl: null, coverUrl: null };
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
      // Only meaningful while actually live -- a cover field matched on a
      // not-live page would be some other, unrelated image (a past
      // video's cover, most likely), not a live-room cover that doesn't
      // exist.
      coverUrl: roomId !== null ? extractLiveCoverUrl(html) : null,
    };
  } catch (err) {
    console.error(`TikTok check failed for @${username}`, err);
    return empty;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
