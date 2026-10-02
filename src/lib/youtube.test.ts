import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIsCurrentlyLiveForNewContent, LIVE_FLAG_RECHECK_DELAY_MS } from "./youtube.js";

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
