// Mirrors src/lib/buttons.ts, returning plain Telegram API JSON instead of a
// grammY InlineKeyboard (this script doesn't depend on grammY — see
// scripts/lib/telegram.ts). Keep the two files' labels/colors in sync if you
// change one.
import type { InlineButton } from "./telegram.js";
import type { Platform } from "./types.js";

export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: "\u{1F534} YouTube",
  tiktok: "⚫ TikTok",
};

export const PLATFORM_BRAND_COLORS: Record<Platform, string> = {
  youtube: "#FF0000",
  tiktok: "#000000",
};

export interface PlatformLink {
  platform: Platform;
  url: string;
}

// Known styling for common extra_links labels (Twitch lives here now — see
// schema.sql). Matched case-insensitively; anything else falls back to a
// generic link icon plus whatever label the user typed.
const KNOWN_LINK_STYLES: Record<string, string> = {
  twitch: "\u{1F7E3} Twitch",
  discord: "\u{1F4AC} Discord",
  instagram: "\u{1F4F7} Instagram",
  telegram: "✈️ Telegram",
  x: "⚫ X",
  twitter: "⚫ X",
  vk: "\u{1F535} VK",
  boosty: "\u{1F7E0} Boosty",
};

function formatLinkLabel(label: string): string {
  const key = label.trim().toLowerCase();
  return KNOWN_LINK_STYLES[key] ?? `\u{1F517} ${label}`;
}

/** One button per platform/link, one per row. Monitored platforms first,
 * then extra links. */
export function buildKeyboard(
  platformLinks: PlatformLink[],
  extraLinks: Array<{ label: string; url: string }> = [],
): InlineButton[][] {
  return [
    ...platformLinks.map((link) => [{ text: PLATFORM_LABELS[link.platform], url: link.url }]),
    ...extraLinks.map((link) => [{ text: formatLinkLabel(link.label), url: link.url }]),
  ];
}
