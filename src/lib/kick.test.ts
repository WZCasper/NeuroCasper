import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizationUrl,
  extractWebhookHeaders,
  generatePkcePair,
  parseLivestreamStatusEvent,
  verifyWebhookSignature,
} from "./kick.js";

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

test("generatePkcePair produces a verifier in the RFC 7636 length range and a matching S256 challenge", async () => {
  const { codeVerifier, codeChallenge } = await generatePkcePair();

  assert.ok(codeVerifier.length >= 43 && codeVerifier.length <= 128, `unexpected verifier length ${codeVerifier.length}`);
  assert.match(codeVerifier, /^[A-Za-z0-9_-]+$/, "verifier must be unreserved base64url characters only");

  // Recompute the expected challenge independently and compare -- this is
  // the same S256 derivation Kick's authorization server performs when it
  // checks the verifier sent back at the token-exchange step.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const expected = base64UrlFromBytes(new Uint8Array(digest));
  assert.equal(codeChallenge, expected);
});

test("generatePkcePair returns a fresh value on every call", async () => {
  const a = await generatePkcePair();
  const b = await generatePkcePair();
  assert.notEqual(a.codeVerifier, b.codeVerifier);
});

// ---------------------------------------------------------------------------
// buildAuthorizationUrl
// ---------------------------------------------------------------------------

test("buildAuthorizationUrl includes every required OAuth/PKCE parameter", () => {
  const url = new URL(
    buildAuthorizationUrl({
      clientId: "client-123",
      redirectUri: "https://example.workers.dev/kick/oauth/callback",
      state: "state-abc",
      codeChallenge: "challenge-xyz",
    }),
  );
  assert.equal(url.origin, "https://id.kick.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.workers.dev/kick/oauth/callback");
  assert.equal(url.searchParams.get("state"), "state-abc");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-xyz");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("scope")?.includes("events:subscribe"));
});

// ---------------------------------------------------------------------------
// extractWebhookHeaders
// ---------------------------------------------------------------------------

test("extractWebhookHeaders reads all three Kick-Event-* headers", () => {
  const headers = extractWebhookHeaders(
    new Request("https://example.com/kick/webhook", {
      method: "POST",
      headers: {
        "Kick-Event-Message-Id": "msg-1",
        "Kick-Event-Message-Timestamp": "2026-01-01T00:00:00Z",
        "Kick-Event-Signature": "sig-1",
      },
    }),
  );
  assert.deepEqual(headers, { messageId: "msg-1", timestamp: "2026-01-01T00:00:00Z", signature: "sig-1" });
});

test("extractWebhookHeaders returns null when any header is missing", () => {
  const headers = extractWebhookHeaders(
    new Request("https://example.com/kick/webhook", {
      method: "POST",
      headers: { "Kick-Event-Message-Id": "msg-1", "Kick-Event-Message-Timestamp": "2026-01-01T00:00:00Z" },
    }),
  );
  assert.equal(headers, null);
});

// ---------------------------------------------------------------------------
// parseLivestreamStatusEvent
// ---------------------------------------------------------------------------

test("parseLivestreamStatusEvent parses a well-formed payload", () => {
  const event = parseLivestreamStatusEvent(
    JSON.stringify({ broadcaster: { user_id: 42 }, is_live: true, title: "Ranked grind" }),
  );
  assert.deepEqual(event, { broadcasterUserId: 42, isLive: true, title: "Ranked grind" });
});

test("parseLivestreamStatusEvent defaults a missing title to an empty string", () => {
  const event = parseLivestreamStatusEvent(JSON.stringify({ broadcaster: { user_id: 42 }, is_live: false }));
  assert.deepEqual(event, { broadcasterUserId: 42, isLive: false, title: "" });
});

test("parseLivestreamStatusEvent returns null for invalid JSON", () => {
  assert.equal(parseLivestreamStatusEvent("not json"), null);
});

test("parseLivestreamStatusEvent returns null when required fields are missing or mistyped", () => {
  assert.equal(parseLivestreamStatusEvent(JSON.stringify({ is_live: true })), null);
  assert.equal(
    parseLivestreamStatusEvent(JSON.stringify({ broadcaster: { user_id: "42" }, is_live: true })),
    null,
  );
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature -- real RSA sign/verify against a locally
// generated keypair, with Kick's public-key endpoint mocked. This is the
// most security-sensitive code in the project and the README notes it was
// never exercised against Kick's real infrastructure -- these tests give
// it real (offline) coverage: a genuine RSASSA-PKCS1-v1_5/SHA-256
// signature over "{messageId}.{timestamp}.{rawBody}" is computed and
// checked exactly the way verifyWebhookSignature checks it.
// ---------------------------------------------------------------------------

async function generateTestKeypair(): Promise<CryptoKeyPair> {
  // workers-types (unlike lib.dom.d.ts) gives generateKey a single
  // signature returning `CryptoKey | CryptoKeyPair` regardless of
  // algorithm, rather than overloads that narrow it per algorithm name --
  // RSA key generation always yields a pair, hence the assertion.
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function publicKeyToPem(key: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", key);
  const b64 = Buffer.from(spki).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

async function signWebhook(
  privateKey: CryptoKey,
  messageId: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const signed = `${messageId}.${timestamp}.${rawBody}`;
  const sigBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signed),
  );
  return Buffer.from(sigBytes).toString("base64");
}

/** Mocks the same endpoint src/lib/kick.ts's getKickPublicKey() fetches,
 * scoped to this test only (node:test auto-restores after the test). */
function mockKickPublicKeyEndpoint(t: import("node:test").TestContext, pem: string): void {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.kick.com/public/v1/public-key") {
      return new Response(JSON.stringify({ data: { public_key: pem } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
}

test("verifyWebhookSignature accepts a genuinely valid, fresh signature", async (t) => {
  const { publicKey, privateKey } = await generateTestKeypair();
  mockKickPublicKeyEndpoint(t, await publicKeyToPem(publicKey));

  const messageId = "msg-1";
  const timestamp = new Date().toISOString();
  const rawBody = JSON.stringify({ broadcaster: { user_id: 42 }, is_live: true, title: "Ranked grind" });
  const signature = await signWebhook(privateKey, messageId, timestamp, rawBody);

  const valid = await verifyWebhookSignature({ messageId, timestamp, signature }, rawBody);
  assert.equal(valid, true);
});

test("verifyWebhookSignature rejects a body that doesn't match what was signed", async (t) => {
  const { publicKey, privateKey } = await generateTestKeypair();
  mockKickPublicKeyEndpoint(t, await publicKeyToPem(publicKey));

  const timestamp = new Date().toISOString();
  const signedBody = JSON.stringify({ broadcaster: { user_id: 42 }, is_live: true });
  const tamperedBody = JSON.stringify({ broadcaster: { user_id: 42 }, is_live: false });
  const signature = await signWebhook(privateKey, "msg-1", timestamp, signedBody);

  const valid = await verifyWebhookSignature({ messageId: "msg-1", timestamp, signature }, tamperedBody);
  assert.equal(valid, false);
});

test("verifyWebhookSignature rejects a stale timestamp outside the replay window, without needing the public key", async (t) => {
  // Mocked to throw if called at all -- a stale timestamp must be rejected
  // before any public-key fetch, per verifyWebhookSignature's check order.
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("verifyWebhookSignature should not fetch the public key for a stale timestamp");
  });

  const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
  const rawBody = JSON.stringify({ broadcaster: { user_id: 42 }, is_live: true });
  const valid = await verifyWebhookSignature(
    { messageId: "msg-1", timestamp: staleTimestamp, signature: "irrelevant" },
    rawBody,
  );
  assert.equal(valid, false);
});

test("verifyWebhookSignature rejects a malformed (non-base64) signature", async (t) => {
  const { publicKey } = await generateTestKeypair();
  mockKickPublicKeyEndpoint(t, await publicKeyToPem(publicKey));

  const valid = await verifyWebhookSignature(
    { messageId: "msg-1", timestamp: new Date().toISOString(), signature: "not-valid-base64!!!" },
    "{}",
  );
  assert.equal(valid, false);
});

function base64UrlFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
