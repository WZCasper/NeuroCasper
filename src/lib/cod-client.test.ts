import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthHeaders,
  buildWarzoneProfileUrl,
  CodApiError,
  DEFAULT_COD_TITLE_CODE,
  fetchWarzoneProfile,
  resolveCodTitleCode,
} from "./cod-client.js";

// ---------------------------------------------------------------------------
// resolveCodTitleCode (чистая функция, без сети)
// ---------------------------------------------------------------------------

test("resolveCodTitleCode falls back to DEFAULT_COD_TITLE_CODE when the chat has no override", () => {
  assert.equal(resolveCodTitleCode(null), DEFAULT_COD_TITLE_CODE);
});

test("resolveCodTitleCode uses the chat's own override when one is set", () => {
  assert.equal(resolveCodTitleCode("mw4"), "mw4");
});

test("resolveCodTitleCode treats a blank/whitespace-only override the same as no override at all", () => {
  assert.equal(resolveCodTitleCode(""), DEFAULT_COD_TITLE_CODE);
  assert.equal(resolveCodTitleCode("   "), DEFAULT_COD_TITLE_CODE);
});

test("resolveCodTitleCode trims surrounding whitespace off a real override", () => {
  assert.equal(resolveCodTitleCode("  bo7  "), "bo7");
});

// ---------------------------------------------------------------------------
// buildWarzoneProfileUrl (чистая функция, без сети)
// ---------------------------------------------------------------------------

test("buildWarzoneProfileUrl produces the documented papi-client stats URL shape", () => {
  const url = buildWarzoneProfileUrl("mw", "Gazreyn#2546");
  assert.equal(url, "https://my.callofduty.com/api/papi-client/stats/cod/v1/title/mw/platform/acti/gamer/Gazreyn%232546/profile/type/wz");
});

test("buildWarzoneProfileUrl URL-encodes a tag containing '#' so it doesn't get truncated as a URL fragment", () => {
  const url = buildWarzoneProfileUrl("bo7", "亗 Casper#7378333");
  assert.ok(!url.includes("#7378333"), "the raw '#7378333' must not survive unencoded in the URL");
  assert.ok(url.includes(encodeURIComponent("亗 Casper#7378333")), "the whole tag must be encoded as one unit");
});

test("buildWarzoneProfileUrl mode is always wz (Warzone), never mp -- that's the whole point of this function", () => {
  const url = buildWarzoneProfileUrl("bo7", "SomeTag#1234");
  assert.ok(url.endsWith("/profile/type/wz"));
});

// ---------------------------------------------------------------------------
// buildAuthHeaders (чистая функция, без сети)
// ---------------------------------------------------------------------------

test("buildAuthHeaders carries the ssoToken in both the atkn header and inside the assembled cookie string", () => {
  const headers = buildAuthHeaders({ ssoToken: "test-token-abc" });
  assert.equal(headers["atkn"], "test-token-abc");
  assert.ok(headers["cookie"], "a cookie header must be present at all");
  assert.ok(headers["cookie"]?.includes("ACT_SSO_COOKIE=test-token-abc;"), "cookie string must embed the same token");
});

test("buildAuthHeaders sets a non-empty user-agent (Activision has been observed to reject requests with no/blank one)", () => {
  const headers = buildAuthHeaders({ ssoToken: "x" });
  assert.ok(headers["user-agent"] && headers["user-agent"].length > 10);
});

// ---------------------------------------------------------------------------
// fetchWarzoneProfile -- мокирует fetch на том же "шве", что и
// checkIsCurrentlyLive в youtube.ts (см. youtube.test.ts для образца этого
// паттерна в проекте), чтобы проверить реальный код обработки ответа без
// обращения в сеть.
// ---------------------------------------------------------------------------

const SESSION = { ssoToken: "fake-sso-token" };

test("fetchWarzoneProfile returns the parsed data on a successful {status:'success'} envelope", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ status: "success", data: { some: "stats" } }), { status: 200 }),
  );
  const result = await fetchWarzoneProfile(SESSION, "bo7", "Casper#1234");
  assert.deepEqual(result, { status: "success", data: { some: "stats" } });
});

test("fetchWarzoneProfile throws CodApiError('unauthenticated') on HTTP 401", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Unauthorized", { status: 401 }));
  await assert.rejects(
    () => fetchWarzoneProfile(SESSION, "bo7", "Casper#1234"),
    (err: unknown) => err instanceof CodApiError && err.reason === "unauthenticated" && err.httpStatus === 401,
  );
});

test("fetchWarzoneProfile throws CodApiError('unauthenticated') on HTTP 403 too (not just 401)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Forbidden", { status: 403 }));
  await assert.rejects(
    () => fetchWarzoneProfile(SESSION, "bo7", "Casper#1234"),
    (err: unknown) => err instanceof CodApiError && err.reason === "unauthenticated" && err.httpStatus === 403,
  );
});

test("fetchWarzoneProfile throws CodApiError('not_found_or_unknown_title') on HTTP 404", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Not found", { status: 404 }));
  await assert.rejects(
    () => fetchWarzoneProfile(SESSION, "unknown-title", "Casper#1234"),
    (err: unknown) => err instanceof CodApiError && err.reason === "not_found_or_unknown_title",
  );
});

test("fetchWarzoneProfile throws CodApiError('profile_private') when Activision answers HTTP 200 but status !== 'success'", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ status: "not found" }), { status: 200 }));
  await assert.rejects(
    () => fetchWarzoneProfile(SESSION, "bo7", "Casper#1234"),
    (err: unknown) => err instanceof CodApiError && err.reason === "profile_private" && err.httpStatus === 200,
  );
});

test("fetchWarzoneProfile throws CodApiError('unexpected_response') when the 200 body isn't even JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>not json</html>", { status: 200 }));
  await assert.rejects(
    () => fetchWarzoneProfile(SESSION, "bo7", "Casper#1234"),
    (err: unknown) => err instanceof CodApiError && err.reason === "unexpected_response",
  );
});

test("fetchWarzoneProfile throws CodApiError('unexpected_response') on an unrelated server error like 500", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Internal Server Error", { status: 500 }));
  await assert.rejects(
    () => fetchWarzoneProfile(SESSION, "bo7", "Casper#1234"),
    (err: unknown) => err instanceof CodApiError && err.reason === "unexpected_response" && err.httpStatus === 500,
  );
});

test("fetchWarzoneProfile never swallows an error silently and returns a falsy/empty result instead of throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
  let threw = false;
  try {
    await fetchWarzoneProfile(SESSION, "bo7", "Casper#1234");
  } catch (err) {
    threw = true;
    assert.ok(err instanceof CodApiError);
  }
  assert.equal(threw, true, "a 401 must throw, never resolve to some placeholder value");
});
