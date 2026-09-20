// Kick, unlike YouTube (public RSS feed) and TikTok (public profile page),
// has no way to check a channel's live status anonymously or on a poll --
// its events:subscribe API only pushes a webhook for a channel the calling
// app has been AUTHORIZED for via OAuth. That means each streamer being
// tracked on Kick must personally complete a one-time OAuth approval (see
// buildAuthorizationUrl / exchangeCodeForToken in src/handlers/telegram.ts's
// Kick OAuth callback route), unlike adding a YouTube or TikTok account,
// which only needs a public username typed into the bot.
//
// Once authorized, Kick pushes a signed webhook to /kick/webhook on every
// livestream.status.updated event for that channel -- this is a real push,
// not a poll, so a "went live" notification arrives in seconds rather than
// however long YouTube's RSS feed takes to catch up (see src/lib/youtube.ts).
//
// Reference docs (confirmed directly against docs.kick.com — the pages
// below were screenshotted and checked field-for-field, including Kick's
// own Go signature-verification example, which matches this file's scheme
// exactly: header names, the "{messageId}.{timestamp}.{body}" signed
// string, and RSASSA-PKCS1-v1_5 with SHA-256 over the public key served at
// the exact URL used in getKickPublicKey below):
//   - OAuth + API base URLs, scopes:  https://docs.kick.com/getting-started
//   - Event subscriptions:            https://docs.kick.com/events/subscribe-to-events
//   - Webhook payloads:               https://docs.kick.com/events/webhook-payloads
//   - Webhook signature verification: https://docs.kick.com/events/webhooks
//   - Public key endpoint:            https://docs.kick.com/apis/public-key
//
// IMPORTANT operational note from that page: "If an app's webhook doesn't
// process an event within 24 hours, Kick automatically unsubscribes the
// app from that event" (paraphrased from the Russian original) -- i.e. if
// /kick/webhook is unreachable or erroring for a full day (Worker outage,
// bad deploy, D1 down), Kick silently drops the livestream.status.updated
// subscription for every affected streamer, with no separate error
// delivered anywhere else. There's no code-level mitigation for this yet;
// if "went live" notifications for a Kick streamer quietly stop, re-running
// that streamer's /add_social Kick authorization re-subscribes them.
//
// NOTE on token refresh: refreshAccessToken() below exists but nothing
// calls it yet -- receiving webhooks needs no access token at all (Kick
// keeps the subscription active server-side once granted), so this hasn't
// blocked anything so far. It would matter if this file's API-calling
// functions (fetchOwnChannel, subscribeToLivestreamEvents, unsubscribe
// FromEvents) are ever called again long after the original OAuth grant --
// at that point, check kick_tokens.expires_at first and refresh if needed
// before using access_token. Kick's docs page for token endpoints wasn't
// checked directly for the exact expires_in value; treat that number as
// unconfirmed until read from a real token response.

const KICK_ID_BASE_URL = "https://id.kick.com";
const KICK_API_BASE_URL = "https://api.kick.com";

// From https://docs.kick.com/getting-started/scopes, via the Go SDK's
// OAuthScope constants.
const REQUIRED_SCOPES = ["user:read", "channel:read", "events:subscribe"];

export interface KickTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number; // seconds
  scope: string;
}

export interface KickChannel {
  broadcasterUserId: number;
  slug: string;
  streamTitle: string | null;
}

/** Builds the URL to send the streamer to so they can approve this app.
 * `state` must be a fresh random value stored server-side (see
 * createKickOAuthState in src/db.ts) and re-checked when Kick redirects
 * back, to prevent a forged callback from linking a Kick channel the
 * requesting Telegram user doesn't actually control. PKCE's code_verifier
 * doesn't need server-side storage the same way -- it's sent again by the
 * client at the token-exchange step -- but it MUST be the same value used
 * to derive codeChallenge here, so callers should persist it alongside
 * `state` (e.g. in the same kick_oauth_states row) rather than regenerate it. */
export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: REQUIRED_SCOPES.join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${KICK_ID_BASE_URL}/oauth/authorize?${params.toString()}`;
}

/** Random PKCE code_verifier (43-128 chars of unreserved URL characters,
 * per RFC 7636) and its S256 code_challenge. Kick's OAuth requires PKCE. */
export async function generatePkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  const codeVerifier = base64UrlEncode(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

export async function exchangeCodeForToken(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<KickTokenResponse> {
  const res = await fetch(`${KICK_ID_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
      code_verifier: input.codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Kick token exchange failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<KickTokenResponse>;
}

export async function refreshAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<KickTokenResponse> {
  const res = await fetch(`${KICK_ID_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Kick token refresh failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<KickTokenResponse>;
}

/** Looks up the authenticated user's own channel -- used right after
 * exchangeCodeForToken to learn their broadcaster_user_id and current
 * slug/stream title, since the OAuth token alone doesn't carry those. */
export async function fetchOwnChannel(accessToken: string): Promise<KickChannel> {
  const res = await fetch(`${KICK_API_BASE_URL}/public/v1/channels`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Kick channels lookup failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as {
    data?: Array<{ broadcaster_user_id: number; slug: string; stream_title?: string }>;
  };
  const channel = json.data?.[0];
  if (!channel) throw new Error("Kick channels lookup returned no channel for this token");
  return {
    broadcasterUserId: channel.broadcaster_user_id,
    slug: channel.slug,
    streamTitle: channel.stream_title ?? null,
  };
}

/** Subscribes to livestream.status.updated for the authenticated user's
 * own channel. Returns Kick's subscription id (store it -- it's needed to
 * unsubscribe later, e.g. if the streamer is ever removed from the bot). */
export async function subscribeToLivestreamEvents(accessToken: string): Promise<string> {
  const res = await fetch(`${KICK_API_BASE_URL}/public/v1/events/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      method: "webhook",
      events: [{ name: "livestream.status.updated", version: 1 }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Kick event subscription failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ subscription_id?: string; error?: string }>;
  };
  const result = json.data?.[0];
  if (!result || result.error || !result.subscription_id) {
    throw new Error(`Kick event subscription rejected: ${result?.error ?? "no subscription_id in response"}`);
  }
  return result.subscription_id;
}

export async function unsubscribeFromEvents(accessToken: string, subscriptionId: string): Promise<void> {
  const res = await fetch(
    `${KICK_API_BASE_URL}/public/v1/events/subscriptions?id=${encodeURIComponent(subscriptionId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) console.error(`Kick unsubscribe failed (${res.status}): ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Incoming webhook: signature verification + payload parsing
// ---------------------------------------------------------------------------

export interface KickWebhookHeaders {
  messageId: string;
  timestamp: string;
  signature: string;
}

/** Reads the three Kick-Event-* headers a webhook request carries. Returns
 * null if any is missing -- an incomplete header set can never verify, so
 * callers should reject the request immediately rather than attempt it. */
export function extractWebhookHeaders(request: Request): KickWebhookHeaders | null {
  const messageId = request.headers.get("Kick-Event-Message-Id");
  const timestamp = request.headers.get("Kick-Event-Message-Timestamp");
  const signature = request.headers.get("Kick-Event-Signature");
  if (!messageId || !timestamp || !signature) return null;
  return { messageId, timestamp, signature };
}

let cachedPublicKey: { pem: string; key: Promise<CryptoKey> } | null = null;

async function importKickPublicKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(body);
  return crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

/** Fetches (and process-lifetime-caches) Kick's RSA public key used to
 * verify webhook signatures. Cheap to call on every webhook -- the fetch
 * only happens once per warm isolate. Path/response shape cross-checked
 * against five independent third-party SDKs (Go x2, Rust, Kotlin, C#) that
 * all agree on GET {base}/public-key returning {"data":{"public_key":"..."}}
 * under the api.kick.com/public/v1 base -- still worth a live check before
 * relying on it, since none of them are Kick's own code. */
async function getKickPublicKey(): Promise<CryptoKey> {
  const res = await fetch(`${KICK_API_BASE_URL}/public/v1/public-key`);
  if (!res.ok) throw new Error(`Kick public-key fetch failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { data?: { public_key?: string } };
  const pem = json.data?.public_key;
  if (!pem) throw new Error("Kick public-key response had no data.public_key");

  if (cachedPublicKey?.pem === pem) return cachedPublicKey.key;
  const key = importKickPublicKey(pem);
  cachedPublicKey = { pem, key };
  return key;
}

const REPLAY_WINDOW_MINUTES = 5;

/** Full verification of an incoming Kick webhook: checks the RSA signature
 * over `{messageId}.{timestamp}.{rawBody}` (see the module comment above
 * for why this exact scheme, and its one caveat), AND rejects timestamps
 * older or newer than REPLAY_WINDOW_MINUTES -- a valid signature on a
 * captured, replayed request should still be rejected once it's stale.
 * `rawBody` must be the exact bytes Kick sent, read before any JSON
 * parsing -- re-serializing a parsed object can change whitespace and
 * break the signature check even for a genuine request. */
export async function verifyWebhookSignature(headers: KickWebhookHeaders, rawBody: string): Promise<boolean> {
  const eventTimeMs = Date.parse(headers.timestamp);
  if (Number.isNaN(eventTimeMs)) return false;
  const driftMs = Math.abs(Date.now() - eventTimeMs);
  if (driftMs > REPLAY_WINDOW_MINUTES * 60 * 1000) return false;

  let publicKey: CryptoKey;
  try {
    publicKey = await getKickPublicKey();
  } catch (err) {
    console.error("Failed to fetch Kick public key for webhook verification", err);
    return false;
  }

  const signedData = `${headers.messageId}.${headers.timestamp}.${rawBody}`;
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64ToBytes(headers.signature);
  } catch {
    return false;
  }

  try {
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signatureBytes,
      new TextEncoder().encode(signedData),
    );
  } catch (err) {
    console.error("Kick webhook signature verification threw", err);
    return false;
  }
}

export interface KickLivestreamStatusEvent {
  broadcasterUserId: number;
  isLive: boolean;
  title: string;
}

/** Parses a livestream.status.updated payload. Returns null if the body
 * doesn't have the expected shape -- callers should ignore (not crash on)
 * a payload that doesn't parse, since a webhook endpoint returning an
 * error triggers Kick's retry logic for something that will never parse. */
export function parseLivestreamStatusEvent(rawBody: string): KickLivestreamStatusEvent | null {
  try {
    const json = JSON.parse(rawBody) as {
      broadcaster?: { user_id?: number };
      is_live?: boolean;
      title?: string;
    };
    const broadcasterUserId = json.broadcaster?.user_id;
    if (typeof broadcasterUserId !== "number" || typeof json.is_live !== "boolean") return null;
    return { broadcasterUserId, isLive: json.is_live, title: json.title ?? "" };
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
