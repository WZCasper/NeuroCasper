import { InlineKeyboard } from "grammy";
import type { Platform } from "../types.js";

// Telegram's Bot API gives inline buttons NO color/style control —
// InlineKeyboardButton only carries text + one action (url/callback_data/…),
// rendered by the client's own theme. A coloured emoji in the label is the
// closest honest approximation of "a red YouTube button / purple Twitch
// button / black TikTok button" that the platform actually allows.
export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: "\u{1F534} YouTube",
  twitch: "\u{1F7E3} Twitch",
  tiktok: "⚫ TikTok",
};

// Used only by the generated fallback preview image (src/lib/preview-image.ts),
// where we DO have full pixel control.
export const PLATFORM_BRAND_COLORS: Record<Platform, string> = {
  youtube: "#FF0000",
  twitch: "#9146FF",
  tiktok: "#000000",
};

export interface PlatformLink {
  platform: Platform;
  url: string;
}

/** One button per platform, one per row (keeps labels fully readable on
 * small screens instead of squeezing 2-3 across). */
export function buildPlatformKeyboard(links: PlatformLink[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const link of links) {
    kb.url(PLATFORM_LABELS[link.platform], link.url).row();
  }
  return kb;
}
