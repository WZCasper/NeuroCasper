import { test } from "node:test";
import assert from "node:assert/strict";
import { checkChannelLiveNow, checkIsCurrentlyLiveForNewContent, LIVE_FLAG_RECHECK_DELAY_MS } from "./youtube.js";

// ---------------------------------------------------------------------------
// checkIsCurrentlyLiveForNewContent
//
// checkIsCurrentlyLive() itself already has real, working logic (Data API
// call, then a regex fallback on the watch page) -- these tests don't
// re-verify that, they only verify the NEW re-check behavior layered on top
// of it for content seen for the first time this poll. Every case here
// mocks fetch at the same seam checkIsCurrentlyLive uses (global fetch to
// googleapis.com / youtube.com), so the assertions exercise the real
// production code path end to end, not a re-implementation of it.
// ---------------------------------------------------------------------------

function heuristicWatchPageResponse(isLive: boolean): Response {
  // No YOUTUBE_API_KEY is passed in any test below, so checkIsCurrentlyLive
  // always falls through to this regex-matched watch-page path -- matches
  // how the bot actually behaves for anyone who hasn't set the key yet.
  const html = isLive ? '"isLiveNow": true' : '"isLiveNow": false';
  return new Response(html, { status: 200 });
}

/** Mocked fetch resolves via a real Promise chain (its own body is async),
 * which node:test's mocked setTimeout does not automatically drain before
 * mock.timers.tick() runs. setImmediate fires on the event loop's next
 * turn, after every microtask already queued has run, so awaiting it is a
 * deterministic way to make sure a preceding mocked-fetch call has fully
 * resolved before advancing the mocked clock -- no fixed number of
 * `await Promise.resolve()` guesses, which would be one microtask-queue
 * depth away from correct the moment the implementation's await chain
 * changes shape. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("returns true immediately when the first check already says live, without waiting for the recheck delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    return heuristicWatchPageResponse(true);
  });

  const result = await checkIsCurrentlyLiveForNewContent("video-1", undefined);

  assert.equal(result, true);
  assert.equal(fetchCalls, 1, "a confirmed-live first check must not trigger a second fetch");
});

test("re-checks once after the delay when the first check says not-live, and returns true if the recheck now says live", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    // First call (the immediate check) sees the pre-flag-flip state; the
    // recheck after the delay sees YouTube's live flag having caught up --
    // exactly the race this function exists to ride out.
    return heuristicWatchPageResponse(fetchCalls >= 2);
  });

  const resultPromise = checkIsCurrentlyLiveForNewContent("video-1", undefined);

  await flushMicrotasks();
  assert.equal(fetchCalls, 1, "should not re-check before the delay elapses");

  t.mock.timers.tick(LIVE_FLAG_RECHECK_DELAY_MS);
  const result = await resultPromise;

  assert.equal(result, true);
  assert.equal(fetchCalls, 2, "exactly one recheck, not a retry loop");
});

test("returns false when both the immediate check and the recheck say not-live (an ordinary uploaded video)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    return heuristicWatchPageResponse(false);
  });

  const resultPromise = checkIsCurrentlyLiveForNewContent("video-1", undefined);

  await flushMicrotasks();
  t.mock.timers.tick(LIVE_FLAG_RECHECK_DELAY_MS);
  const result = await resultPromise;

  assert.equal(result, false);
  assert.equal(fetchCalls, 2, "a genuine non-live video still gets exactly the one recheck, never announced as live");
});

test("returns false without any fetch when videoId is null", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch when videoId is null");
  });

  const result = await checkIsCurrentlyLiveForNewContent(null, undefined);
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// checkChannelLiveNow
//
// With an API key, this must go through the official search.list endpoint
// (googleapis.com) and never touch the HTML-scraping fallback at all --
// that's the whole point of having the official path. Without a key, or
// when the official call itself fails, it must fall back to the scraping
// heuristic exactly as before this function grew the API-first path.
// ---------------------------------------------------------------------------

function searchListResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });
}

function liveSearchItem(overrides: { videoId?: string; title?: string; thumbUrl?: string } = {}) {
  return {
    id: { videoId: overrides.videoId ?? "yt-video-1" },
    snippet: {
      title: overrides.title ?? "Live now",
      liveBroadcastContent: "live",
      thumbnails: { high: { url: overrides.thumbUrl ?? "https://i.ytimg.com/vi/yt-video-1/hqdefault_live.jpg" } },
    },
  };
}

test("with an API key: a live channel is found via search.list, with no fetch to youtube.com at all", async (t) => {
  const fetchedUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetchedUrls.push(url);
    return searchListResponse([liveSearchItem()]);
  });

  const result = await checkChannelLiveNow("UC123", "test-api-key");

  assert.deepEqual(result, {
    videoId: "yt-video-1",
    title: "Live now",
    thumbnailUrl: "https://i.ytimg.com/vi/yt-video-1/hqdefault_live.jpg",
  });
  assert.equal(fetchedUrls.length, 1);
  assert.match(fetchedUrls[0] ?? "", /googleapis\.com\/youtube\/v3\/search/);
  assert.match(fetchedUrls[0] ?? "", /channelId=UC123/);
  assert.match(fetchedUrls[0] ?? "", /eventType=live/);
});

test("with an API key: an empty items[] is the documented not-live answer, not an error -- no scraping fallback triggered", async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetchCalls++;
    assert.match(url, /googleapis\.com/, "must not fall through to scraping when the API itself says not-live");
    return searchListResponse([]);
  });

  const result = await checkChannelLiveNow("UC123", "test-api-key");

  assert.equal(result, null);
  assert.equal(fetchCalls, 1);
});

test("prefers the high-resolution thumbnail, falling back to medium then default when high is absent", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    searchListResponse([
      {
        id: { videoId: "v1" },
        snippet: {
          title: "x",
          liveBroadcastContent: "live",
          thumbnails: { medium: { url: "https://i.ytimg.com/medium.jpg" }, default: { url: "https://i.ytimg.com/default.jpg" } },
        },
      },
    ]),
  );

  const result = await checkChannelLiveNow("UC123", "test-api-key");
  assert.equal(result?.thumbnailUrl, "https://i.ytimg.com/medium.jpg");
});

test("falls back to HTML scraping when the search.list call itself fails (network error)", async (t) => {
  const fetchedUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetchedUrls.push(url);
    if (url.includes("googleapis.com")) throw new Error("simulated network failure");
    // The scraping fallback's very first fetch is the /live redirect check;
    // responding with a non-ok status here is enough to prove the fallback
    // path was actually reached, without needing to fake YouTube's full
    // HTML/redirect behavior.
    return new Response("", { status: 503 });
  });

  const result = await checkChannelLiveNow("UC123", "test-api-key");

  assert.equal(result, null);
  assert.equal(fetchedUrls.length, 2, "exactly one API attempt, then exactly one scraping attempt");
  assert.match(fetchedUrls[0] ?? "", /googleapis\.com/);
  assert.match(fetchedUrls[1] ?? "", /youtube\.com\/channel\/UC123\/live/);
});

test("falls back to HTML scraping when the search.list call returns a non-OK response", async (t) => {
  const fetchedUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetchedUrls.push(url);
    if (url.includes("googleapis.com")) return new Response("quota exceeded", { status: 403 });
    return new Response("", { status: 503 });
  });

  const result = await checkChannelLiveNow("UC123", "test-api-key");

  assert.equal(result, null);
  assert.equal(fetchedUrls.length, 2);
});

test("without an API key: goes straight to HTML scraping, never attempting the official API", async (t) => {
  const fetchedUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    fetchedUrls.push(url);
    return new Response("", { status: 503 });
  });

  const result = await checkChannelLiveNow("UC123", undefined);

  assert.equal(result, null);
  assert.equal(fetchedUrls.length, 1);
  assert.match(fetchedUrls[0] ?? "", /youtube\.com\/channel\/UC123\/live/);
});

test("HTML scraping fallback: a live channel is detected from the /live redirect landing on /watch", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    const html = '<title>My Stream - YouTube</title>"isLiveNow": true';
    // The redirect's final URL is read from Response.url; the Response
    // constructor doesn't let that be set directly from a plain string
    // body, so this mirrors it the same way the implementation reads it
    // (via `res.url`) by constructing a Response and assigning `url`,
    // which Node's fetch-compatible Response allows.
    const res = new Response(html, { status: 200 });
    Object.defineProperty(res, "url", { value: "https://www.youtube.com/watch?v=scraped-video-1" });
    return res;
  });

  const result = await checkChannelLiveNow("UC123", undefined);

  assert.deepEqual(result, { videoId: "scraped-video-1", title: "My Stream", thumbnailUrl: null });
});
