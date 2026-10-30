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
 * then extra links.
 *
 * new InlineKeyboard() already starts with one empty row built in (see
 * grammY's own InlineKeyboard constructor: `inline_keyboard = [[]]`), and
 * .row() always pushes a NEW empty row regardless of whether the current
 * one has anything in it -- it has no way to know this is meant to be
 * the last one. Calling .row() after every single button, including the
 * very last one, therefore always left one trailing empty row at the end
 * of inline_keyboard: harmless (Telegram simply doesn't render an empty
 * row), but still a real defect this function was producing on every
 * call, confirmed by literally reconstructing the array (see this
 * project's git history for the reproduction). The fix is to call .row()
 * only BETWEEN buttons -- i.e. before every button except the first
 * overall -- so a row break is only ever inserted where there is in fact
 * another row following it. */
export function buildKeyboard(
  platformLinks: PlatformLink[],
  extraLinks: Array<{ label: string; url: string }> = [],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  let isFirst = true;
  for (const link of platformLinks) {
    if (!isFirst) kb.row();
    kb.url(PLATFORM_LABELS[link.platform], link.url);
    isFirst = false;
  }
  for (const link of extraLinks) {
    if (!isFirst) kb.row();
    kb.url(formatLinkLabel(link.label), link.url);
    isFirst = false;
  }
  // Only reached with zero buttons added (realistically never happens --
  // publishOrMerge always has at least the platform that just went live
  // -- but still worth getting right): new InlineKeyboard() on its own
  // starts with one empty row already in it (see this function's main
  // comment above), which the loops above never got a chance to fill, so
  // without this check this case would return that one leftover empty
  // row instead of a genuinely empty keyboard.
  return isFirst ? new InlineKeyboard([]) : kb;
}
