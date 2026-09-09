// Mirrors src/lib/buttons.ts, returning plain Telegram API JSON instead of a
// grammY InlineKeyboard (this script doesn't depend on grammY — see
// scripts/lib/telegram.ts). Keep the two files' labels/colors in sync if you
// change one.
import type { InlineButton } from "./telegram.js";
import type { Platform } from "./types.js";

export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: "\u{1F534} YouTube",
  twitch: "\u{1F7E3} Twitch",
  tiktok: "⚫ TikTok",
};

export const PLATFORM_BRAND_COLORS: Record<Platform, string> = {
  youtube: "#FF0000",
  twitch: "#9146FF",
  tiktok: "#000000",
};

export interface PlatformLink {
  platform: Platform;
  url: string;
}

/** One button per platform, one per row. */
export function buildPlatformButtons(links: PlatformLink[]): InlineButton[][] {
  return links.map((link) => [{ text: PLATFORM_LABELS[link.platform], url: link.url }]);
}
