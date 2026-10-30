import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTiktokStatus } from "./tiktok.js";

// ---------------------------------------------------------------------------
// checkTiktokStatus
//
// TikTok has no official API (see this module's own comment), so every
// case here mocks fetch with a hand-built fragment of the kind of embedded
// JSON TikTok's real pages carry, matching exactly what the regex-based
// extraction in src/lib/tiktok.ts looks for -- these tests exercise that
// real extraction code, not a re-implementation of it.
// ---------------------------------------------------------------------------

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status });
}

test("a live page: isLive true, roomId read out, cover URL decoded from its JSON string escapes", async (t) => {
  // \u0026 is how TikTok's embedded JSON actually escapes "&" in a URL
  // (seen verbatim in real captured examples); if this were only
  // string-replaced for "\u0026" specifically rather than properly
  // JSON-decoded, an escape this test doesn't anticipate would silently
  // come through wrong instead of failing loudly.
  const html =
    '"roomId":"7123456789012345678","cover":{"url_list":["https://p16-sign.tiktokcdn.com/cover.jpeg?x-expires=123\\u0026x-signature=abc"]}';
  t.mock.method(globalThis, "fetch", async () => htmlResponse(html));

  const result = await checkTiktokStatus("teststreamer");

  assert.equal(result.isLive, true);
  assert.equal(result.roomId, "7123456789012345678");
  assert.equal(result.coverUrl, "https://p16-sign.tiktokcdn.com/cover.jpeg?x-expires=123&x-signature=abc");
});

test("a live page with no recognizable cover field: isLive/roomId still correct, coverUrl is null (not an error)", async (t) => {
  const html = '"roomId":"7123456789012345678"'; // no "cover" field at all -- the realistic "TikTok changed their markup" case
  t.mock.method(globalThis, "fetch", async () => htmlResponse(html));

  const result = await checkTiktokStatus("teststreamer");

  assert.equal(result.isLive, true);
  assert.equal(result.roomId, "7123456789012345678");
  assert.equal(result.coverUrl, null);
});

test("roomId of literal 0 means not live, the same as no roomId at all, and coverUrl is not even attempted", async (t) => {
  const html = '"roomId":"0","cover":{"url_list":["https://p16-sign.tiktokcdn.com/should-be-ignored.jpeg"]}';
  t.mock.method(globalThis, "fetch", async () => htmlResponse(html));

  const result = await checkTiktokStatus("teststreamer");

  assert.equal(result.isLive, false);
  assert.equal(result.roomId, null);
  assert.equal(result.coverUrl, null, "a cover matched on a not-live page would be unrelated content, not a live-room cover");
});

test("a not-live page (no roomId at all): everything live-related is null/false", async (t) => {
  const html = "<html>ordinary profile page, nothing live-related here</html>";
  t.mock.method(globalThis, "fetch", async () => htmlResponse(html));

  const result = await checkTiktokStatus("teststreamer");

  assert.deepEqual(result, { isLive: false, roomId: null, latestVideoId: null, latestVideoUrl: null, coverUrl: null });
});

test("finds the latest video id and builds its URL from the username, independent of live status", async (t) => {
  const html = '<a href="/@teststreamer/video/7234567890123456789">watch</a>';
  t.mock.method(globalThis, "fetch", async () => htmlResponse(html));

  const result = await checkTiktokStatus("teststreamer");

  assert.equal(result.latestVideoId, "7234567890123456789");
  assert.equal(result.latestVideoUrl, "https://www.tiktok.com/@teststreamer/video/7234567890123456789");
});

test("a username containing regex-special characters doesn't throw or corrupt the video-id match", async (t) => {
  // "." is valid in a TikTok handle and is also a regex metacharacter --
  // this is exactly what escapeRegExp (src/lib/tiktok.ts) exists to guard
  // against.
  const html = '<a href="/@test.streamer/video/7234567890123456789">watch</a>';
  t.mock.method(globalThis, "fetch", async () => htmlResponse(html));

  const result = await checkTiktokStatus("test.streamer");

  assert.equal(result.latestVideoId, "7234567890123456789");
});

test("a non-OK HTTP response fails closed to the empty status, not a thrown error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => htmlResponse("", 503));

  const result = await checkTiktokStatus("teststreamer");

  assert.deepEqual(result, { isLive: false, roomId: null, latestVideoId: null, latestVideoUrl: null, coverUrl: null });
});

test("a network-level fetch failure fails closed to the empty status, not a thrown error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("simulated network failure");
  });

  const result = await checkTiktokStatus("teststreamer");

  assert.deepEqual(result, { isLive: false, roomId: null, latestVideoId: null, latestVideoUrl: null, coverUrl: null });
});
