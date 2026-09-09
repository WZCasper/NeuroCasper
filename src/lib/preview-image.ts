// Fallback preview card, generated when a platform doesn't hand us a usable
// thumbnail (this is the normal case for TikTok, which has no public API to
// fetch one from; it's also a safety net if a Twitch/YouTube thumbnail fetch
// ever fails). Renders a hand-written SVG to PNG with @resvg/resvg-wasm —
// pure WASM, no native bindings, verified to bundle and run under Cloudflare
// Workers. No layout engine (Satori) is used since the card is simple enough
// to position by hand; text is a single-line, character-count truncation
// rather than measured, which is the one real limitation of that choice.
import { Resvg, initWasm } from "@resvg/resvg-wasm";
// Typed via src/wasm.d.ts; wrangler's bundler resolves this to a WebAssembly.Module.
import RESVG_WASM_MODULE from "@resvg/resvg-wasm/index_bg.wasm";
import { INTER_BOLD_TTF_BASE64 } from "../assets/fonts.js";
import { PLATFORM_BRAND_COLORS } from "./buttons.js";
import type { Platform, PostKind } from "../types.js";

const CARD_WIDTH = 1280;
const CARD_HEIGHT = 720;

const GRADIENTS: Record<Platform, [string, string]> = {
  youtube: ["#FF0000", "#8B0000"],
  twitch: ["#9146FF", "#4B2380"],
  tiktok: ["#1A1A1A", "#000000"],
};

const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: "YOUTUBE",
  twitch: "TWITCH",
  tiktok: "TIKTOK",
};

let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  // Memoized with no `await` between the check and the assignment, so this
  // is safe against concurrent calls within the same isolate; a fresh
  // isolate (cold start) simply re-initializes once.
  if (!wasmReady) wasmReady = initWasm(RESVG_WASM_MODULE);
  return wasmReady;
}

let cachedFontBytes: Uint8Array | null = null;
function getFontBytes(): Uint8Array {
  if (!cachedFontBytes) cachedFontBytes = base64ToBytes(INTER_BOLD_TTF_BASE64);
  return cachedFontBytes;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildFallbackSvg(platform: Platform, displayName: string, kind: PostKind): string {
  const [c1, c2] = GRADIENTS[platform];
  const name = escapeXml(truncate(displayName, 22));
  // The "● live dot" is drawn as an SVG shape, not a Unicode glyph — the
  // embedded Inter subset is Latin-only and doesn't include geometric-shape
  // characters like U+25CF (confirmed by rendering and inspecting the PNG:
  // it came out as a tofu box). Shapes have no font-coverage risk at all.
  const status = escapeXml(
    kind === "live" ? `LIVE · ${PLATFORM_NAMES[platform]}` : `NEW VIDEO · ${PLATFORM_NAMES[platform]}`,
  );
  const liveDot = kind === "live" ? `<circle cx="390" cy="400" r="8" fill="#ffffff"/>` : "";
  const statusX = kind === "live" ? 410 : 382;
  // TikTok's real brand accent (cyan/pink) as a thin corner flourish, kept
  // subtle so the card still reads as "black", matching what was asked for.
  const tiktokAccent =
    platform === "tiktok"
      ? '<rect x="0" y="0" width="14" height="720" fill="#25F4EE"/><rect x="14" y="0" width="14" height="720" fill="#FE2C55"/>'
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#bg)"/>
  ${tiktokAccent}
  <circle cx="220" cy="360" r="110" fill="rgba(255,255,255,0.14)"/>
  <path d="M 185 305 L 185 415 L 275 360 Z" fill="#ffffff"/>
  <text x="380" y="345" font-family="Inter" font-weight="700" font-size="64" fill="#ffffff">${name}</text>
  ${liveDot}
  <text x="${statusX}" y="410" font-family="Inter" font-weight="700" font-size="30" letter-spacing="2" fill="rgba(255,255,255,0.88)">${status}</text>
</svg>`;
}

/** Renders the branded fallback card and returns raw PNG bytes, ready to
 * hand to `new InputFile(bytes, "preview.png")`. */
export async function generateFallbackPreview(
  platform: Platform,
  displayName: string,
  kind: PostKind,
): Promise<Uint8Array> {
  await ensureWasm();
  const svg = buildFallbackSvg(platform, displayName, kind);
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontBuffers: [getFontBytes()],
      defaultFontFamily: "Inter",
    },
  });
  return resvg.render().asPng();
}
