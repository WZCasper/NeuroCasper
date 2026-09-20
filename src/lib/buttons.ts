import { InlineKeyboard } from "grammy";
import type { Platform } from "../types.js";

// Telegram's Bot API gives inline buttons NO color/style control — a
// coloured emoji in the label is the closest honest approximation the
// platform actually allows.
export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: "\u{1F534} YouTube",
  tiktok: "⚫ TikTok",
  kick: "\u{1F7E2} Kick",
};

// Used only by the generated fallback preview image (src/lib/preview-image.ts).
export const PLATFORM_BRAND_COLORS: Record<Platform, string> = {
  youtube: "#FF0000",
  tiktok: "#000000",
  kick: "#3DB414",
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
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const link of platformLinks) {
    kb.url(PLATFORM_LABELS[link.platform], link.url).row();
  }
  for (const link of extraLinks) {
    kb.url(formatLinkLabel(link.label), link.url).row();
  }
  return kb;
}
