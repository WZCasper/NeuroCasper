// Node counterpart of src/lib/preview-image.ts — same hand-written SVG +
// @resvg/resvg-wasm rendering, verified working in an earlier smoke test
// (see project notes), but loading the wasm module and font from disk via
// `fs` instead of a bundler import, since this runs as a plain Node script
// rather than inside the Worker's bundle. Keep the visual design in sync
// with the Worker version if you change one.
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Platform, PostKind } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "..", "node_modules", "@resvg", "resvg-wasm", "index_bg.wasm");
const FONT_PATH = path.join(__dirname, "..", "assets", "Inter-Bold.ttf");

const CARD_WIDTH = 1280;
const CARD_HEIGHT = 720;

const GRADIENTS: Record<Platform, [string, string]> = {
  youtube: ["#FF0000", "#8B0000"],
  tiktok: ["#1A1A1A", "#000000"],
};

const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: "YOUTUBE",
  tiktok: "TIKTOK",
};

let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = readFile(WASM_PATH).then((bytes) => initWasm(bytes));
  }
  return wasmReady;
}

let cachedFontBytes: Uint8Array | null = null;
async function getFontBytes(): Promise<Uint8Array> {
  if (!cachedFontBytes) cachedFontBytes = await readFile(FONT_PATH);
  return cachedFontBytes;
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
  // The "● live dot" is drawn as an SVG shape, not a Unicode glyph — see
  // the matching comment in src/lib/preview-image.ts for why.
  const status = escapeXml(
    kind === "live" ? `LIVE · ${PLATFORM_NAMES[platform]}` : `NEW VIDEO · ${PLATFORM_NAMES[platform]}`,
  );
  const liveDot = kind === "live" ? `<circle cx="390" cy="400" r="8" fill="#ffffff"/>` : "";
  const statusX = kind === "live" ? 410 : 382;
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

export async function generateFallbackPreview(
  platform: Platform,
  displayName: string,
  kind: PostKind,
): Promise<Uint8Array> {
  await ensureWasm();
  const fontBytes = await getFontBytes();
  const svg = buildFallbackSvg(platform, displayName, kind);
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontBuffers: [fontBytes],
      defaultFontFamily: "Inter",
    },
  });
  return resvg.render().asPng();
}
