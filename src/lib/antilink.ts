// AntiLink: delete group messages whose links aren't on the chat's own
// whitelist. This file holds the pure logic only -- link extraction from
// Telegram message entities, hostname normalization/matching, and parsing
// the owner's free-text whitelist input. src/handlers/telegram.ts owns
// everything that needs the live Bot API or the database: checking
// whether the sender is an admin (exempt from the filter), the actual
// deleteMessage call, reading/writing the whitelist column, and all UI.
//
// Scope, matching exactly what was asked: AntiLink applies to GROUPS and
// SUPERGROUPS only ("удалять ссылки только из группы"), not channels.
// Channel posts arrive as a different Bot API update type (channel_post),
// which this bot doesn't listen for at all, so there's nothing to extend
// here for channels even in principle without also changing the webhook
// subscription.

import type { Message, MessageEntity } from "grammy/types";

// ---------------------------------------------------------------------------
// Extracting links out of a message
// ---------------------------------------------------------------------------

/** Pulls every link out of one block of text + its entities (either
 * message.text + message.entities, or message.caption +
 * message.caption_entities for a photo/video/document sent with a link in
 * its caption -- a common spam posting style, so both are checked by the
 * caller below).
 *
 * Two entity types carry an actual link destination:
 *  - "text_link": a hyperlink hidden behind arbitrary display text, with
 *    the real destination in entity.url. This is exactly the mechanism a
 *    spammer uses to disguise a link as innocent-looking text (e.g. a
 *    button-like "Подробнее здесь" that actually points at a scam site),
 *    so it must be checked the same way as a visible "url" entity below
 *    -- skipping it would make the whole filter trivial to bypass.
 *  - "url": plain autodetected text -- the link IS the visible text,
 *    Telegram just marks where it starts/ends (offset/length), so the
 *    destination has to be read out of the text itself.
 *
 * MessageEntity.offset/length are UTF-16 code units (Telegram Bot API
 * docs). JavaScript strings are UTF-16 internally, so a plain
 * `text.slice(offset, offset + length)` lines up with them correctly --
 * including surrogate-pair characters such as emoji -- with no separate
 * decoding step needed. */
function extractLinksFrom(text: string | undefined, entities: MessageEntity[] | undefined): string[] {
  if (!text || !entities || entities.length === 0) return [];
  const links: string[] = [];
  for (const entity of entities) {
    if (entity.type === "text_link") {
      links.push(entity.url);
    } else if (entity.type === "url") {
      links.push(text.slice(entity.offset, entity.offset + entity.length));
    }
  }
  return links;
}

/** Every link in a message: its text and, separately, its caption (both
 * checked -- see extractLinksFrom's own comment on why the caption
 * matters too). Takes a narrowed Pick of Message rather than the whole
 * type so tests can pass a plain object without constructing a full
 * Telegram Message. */
export function extractMessageLinks(
  message: Pick<Message, "text" | "entities" | "caption" | "caption_entities">,
): string[] {
  return [
    ...extractLinksFrom(message.text, message.entities),
    ...extractLinksFrom(message.caption, message.caption_entities),
  ];
}

// ---------------------------------------------------------------------------
// Parsing a link/domain into the hostname it's matched by
// ---------------------------------------------------------------------------

/** Telegram recognizes a "url" entity even for a bare domain with no
 * scheme at all ("example.com", "vk.com/club123"), which the WHATWG URL
 * parser `new URL(...)` refuses on its own (it requires a scheme to parse
 * anything as an absolute URL). Retrying with an assumed "https://" prefix
 * is the standard, correct way to robustly parse this kind of
 * loosely-recognized link; returns null only for input that still isn't a
 * usable link either way (e.g. empty text, or text with no host-like
 * structure at all). */
export function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    // fall through to the https:// retry below
  }
  try {
    return new URL(`https://${raw}`);
  } catch {
    return null;
  }
}

/** Canonical hostname form used both when storing a whitelist entry and
 * when matching a link against the whitelist: lowercase, with one leading
 * "www." stripped. Stripping "www." means a whitelist entry of
 * "example.com" matches both "example.com" and "www.example.com" links,
 * AND -- just as importantly -- a whitelist entry typed as
 * "www.example.com" still matches a bare "example.com" link, rather than
 * the two being treated as unrelated hosts depending on which form the
 * owner happened to type. Only ONE leading "www." is stripped (not
 * repeated): more than one is never really "the same site" alias. */
export function normalizeHostname(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/** True if `hostname` is exactly a whitelisted host, or a subdomain of
 * one -- whitelisting "example.com" also allows "cdn.example.com",
 * matching how domain allowlisting conventionally works elsewhere (e.g.
 * cookie/HSTS scoping). Both sides are run through normalizeHostname
 * first, so the www-alias rule above applies symmetrically here too. */
export function hostnameIsWhitelisted(hostname: string, whitelist: readonly string[]): boolean {
  const host = normalizeHostname(hostname);
  return whitelist.some((entry) => {
    const allowed = normalizeHostname(entry);
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

/** A link (as found in a message) is "allowed" if it parses to a hostname
 * that's on the whitelist. A link that can't be parsed into any
 * identifiable hostname at all -- e.g. a non-http scheme with no
 * traditional host, such as some `tg://` deep links -- is treated as NOT
 * allowed: there is no way to confirm it matches anything on the
 * whitelist, and the safer default for an unrecognized destination is to
 * block it rather than let an unverifiable link through. */
export function isLinkAllowed(rawUrl: string, whitelist: readonly string[]): boolean {
  const parsed = safeParseUrl(rawUrl);
  if (!parsed || !parsed.hostname) return false;
  return hostnameIsWhitelisted(parsed.hostname, whitelist);
}

/** The one check src/handlers/telegram.ts needs to decide whether to
 * delete a group message: true if the message contains at least one link
 * that ISN'T on the whitelist. A message with no links at all, or whose
 * links are all whitelisted, returns false. Whether the SENDER is exempt
 * (e.g. a group admin) is not this function's concern -- that needs a
 * live getChatMember call, so the caller checks it separately before
 * ever reaching this function. */
export function messageHasDisallowedLink(
  message: Pick<Message, "text" | "entities" | "caption" | "caption_entities">,
  whitelist: readonly string[],
): boolean {
  return extractMessageLinks(message).some((url) => !isLinkAllowed(url, whitelist));
}

// ---------------------------------------------------------------------------
// Whitelist storage
// ---------------------------------------------------------------------------

/** Reads the stored whitelist. NULL/undefined, or anything that isn't a
 * JSON array of strings (corrupted, hand-edited), both resolve to an
 * empty list -- unlike spam_phrases in moderation-settings.ts, there is
 * no built-in default list to fall back to here, since which domains are
 * legitimate is entirely specific to each chat. */
export function resolveAntilinkWhitelist(stored: string | null | undefined): string[] {
  if (stored === null || stored === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    // fall through to empty
  }
  return [];
}

export function serializeAntilinkWhitelist(hostnames: readonly string[]): string {
  return JSON.stringify(hostnames);
}

/** How many entries buildAntilinkWhitelistView (src/handlers/telegram.ts)
 * shows per page. Same reasoning and the same numeric value as
 * SPAM_PHRASE_PAGE_SIZE in moderation-settings.ts: there is no cap on how
 * many hostnames a chat can whitelist (addWhitelistEntries below never
 * refuses for "too many"), so the list screen paginates instead -- that's
 * what actually keeps it within Telegram's 100-buttons-per-message limit
 * regardless of how large the whitelist grows. */
export const ANTILINK_WHITELIST_PAGE_SIZE = 20;

/** A real DNS hostname is at most 253 characters. The owner may paste a
 * full URL rather than a bare domain; normalizeWhitelistEntry below
 * reduces that to just its hostname before this bound is checked, so the
 * limit is on the EXTRACTED hostname, not on however long the pasted URL
 * happened to be. */
const WHITELIST_HOSTNAME_MAX_LENGTH = 253;

export type WhitelistEntryValidation = { ok: true; hostname: string } | { ok: false; error: string };

/** Parses one line of owner input -- "youtube.com", "https://youtube.com/",
 * "www.vk.com/club123" -- into the canonical hostname it will be matched
 * against (see hostnameIsWhitelisted). Runs the input through the exact
 * same parsing (safeParseUrl) and normalization (normalizeHostname) a
 * link found IN a message goes through, so "whitelisted" means precisely
 * the same thing on both sides of the comparison. */
export function normalizeWhitelistEntry(input: string): WhitelistEntryValidation {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "пустая строка" };
  const parsed = safeParseUrl(trimmed);
  if (!parsed || !parsed.hostname) return { ok: false, error: "не похоже на домен или ссылку" };
  const hostname = normalizeHostname(parsed.hostname);
  if (hostname.length > WHITELIST_HOSTNAME_MAX_LENGTH) {
    return { ok: false, error: `слишком длинный домен (максимум ${WHITELIST_HOSTNAME_MAX_LENGTH} символов)` };
  }
  return { ok: true, hostname };
}

export type WhitelistSkipReason = "invalid" | "duplicate";

export interface AddWhitelistEntriesResult {
  /** The full whitelist after adding. */
  whitelist: string[];
  /** Hostnames actually added, in canonical form. */
  added: string[];
  /** Lines that were refused, with why. Blank lines are ignored, not
   * listed -- the same convention addSpamPhrases in
   * moderation-settings.ts uses. */
  skipped: Array<{ input: string; reason: WhitelistSkipReason; error?: string }>;
}

/** Adds whitelist entries from free text, one per line -- the same
 * one-line-per-entry convention as addSpamPhrases in
 * moderation-settings.ts. Each line is parsed and checked independently,
 * so one bad line doesn't reject the rest. There is deliberately no cap
 * on the total number of entries, for the same reason spam phrases no
 * longer have one -- see ANTILINK_WHITELIST_PAGE_SIZE above. */
export function addWhitelistEntries(current: readonly string[], rawInput: string): AddWhitelistEntriesResult {
  const whitelist = [...current];
  const added: string[] = [];
  const skipped: AddWhitelistEntriesResult["skipped"] = [];

  for (const line of rawInput.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const checked = normalizeWhitelistEntry(line);
    if (!checked.ok) {
      skipped.push({ input: line.trim(), reason: "invalid", error: checked.error });
      continue;
    }
    if (whitelist.includes(checked.hostname)) {
      skipped.push({ input: checked.hostname, reason: "duplicate" });
      continue;
    }
    whitelist.push(checked.hostname);
    added.push(checked.hostname);
  }
  return { whitelist, added, skipped };
}

/** Returns the whitelist without the entry at `index`, or null if `index`
 * isn't a valid position (e.g. a stale button pressed after the list
 * changed). Position-based for exactly the same reason removeSpamPhraseAt
 * in moderation-settings.ts is -- see that function's own comment for the
 * full reasoning (callback_data's 64-byte cap ruling out the value
 * itself, and the single-owner risk window this carries). */
export function removeWhitelistEntryAt(current: readonly string[], index: number): string[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
  return current.filter((_, i) => i !== index);
}
