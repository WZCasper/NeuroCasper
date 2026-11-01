// Two related, but independent, link-moderation features live here:
//
//   - AntiLink: delete group messages whose links aren't on the chat's own
//     WHITELIST, while AntiLink itself is on (channels.antilink_enabled).
//     Matches by HOSTNAME only -- whitelisting "youtube.com" allows every
//     page on that whole domain. See hostnameIsWhitelisted, isLinkAllowed,
//     messageHasDisallowedLink and the whitelist-storage section below.
//
//   - URL blacklist: delete group messages linking to a specific
//     BLACKLISTED resource (a particular channel, a particular video),
//     always, independent of whether AntiLink/the whitelist is on at all
//     (channels.url_blacklist_enabled). Matches the FULL path, not just
//     the hostname -- blacklisting "t.me/somechannel" blocks links into
//     that one Telegram channel, never every t.me link in existence. This
//     is deliberately the opposite granularity from the whitelist above:
//     the whitelist's job is "allow this whole site", the blacklist's job
//     is "block this one specific channel/page", and conflating the two
//     into one hostname-only mechanism would make the blacklist unable to
//     do the one thing it was asked for -- blocking one bad channel
//     without blocking its entire platform for everyone. See
//     normalizePathForBlacklist, urlMatchesBlacklistEntry,
//     messageHasBlacklistedLink and the blacklist-storage section below.
//
// This file holds the pure logic only for both -- link extraction from
// Telegram message entities, hostname/path normalization and matching, and
// parsing the owner's free-text list input. src/handlers/telegram.ts owns
// everything that needs the live Bot API or the database: checking
// whether the sender is an admin (exempt from both filters), the actual
// deleteMessage call, reading/writing these columns, and all UI.
//
// Scope, matching exactly what was asked: both apply to GROUPS and
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
// URL blacklist -- matches the FULL path, not just the hostname. See the
// top-of-file comment for why this is a separate mechanism from the
// whitelist above rather than the same one reused.
// ---------------------------------------------------------------------------

/** A blacklisted resource, as both stored and matched against: a
 * normalized hostname (same normalizeHostname as the whitelist uses, so
 * "the same site" means the same thing in both features) plus a
 * normalized path. `path` is never empty -- see normalizeBlacklistEntry's
 * own comment on why a bare domain with no path is refused outright
 * rather than being allowed to mean "the whole site", which is exactly
 * what this feature was asked NOT to do. */
export interface BlacklistEntry {
  hostname: string;
  path: string;
}

/** Lowercase, with a trailing slash stripped (so "/channel" and
 * "/channel/" are the same entry) and collapsed to "/" if the result
 * would otherwise be empty. Lowercased deliberately, unlike how a URL
 * path is treated by the spec by default (paths are case-sensitive in
 * general): Telegram usernames and YouTube's @handles -- the two
 * platforms this feature was specifically asked to cover -- are both
 * case-insensitive on the platforms themselves, so matching them
 * case-insensitively here is what actually tracks "is this the same
 * channel", not the generic URL-spec default. A path that happens to be
 * case-sensitive on some other site is a much smaller risk than silently
 * failing to block a channel link pasted in different capitalization. */
function normalizePathForBlacklist(path: string): string {
  const lower = path.toLowerCase();
  const trimmed = lower.length > 1 && lower.endsWith("/") ? lower.slice(0, -1) : lower;
  return trimmed === "" ? "/" : trimmed;
}

/** True if `url` identifies the same resource as `entry`, or something
 * "underneath" it: same normalized hostname, and the path either equals
 * entry.path exactly or continues on from it at a "/" boundary (so
 * blacklisting "t.me/badchannel" also blocks "t.me/badchannel/123", a
 * link to one specific post inside that channel, while "t.me/badchannel2"
 * -- a different channel whose name merely starts with the same
 * characters -- correctly does NOT match: this is the same
 * exact-or-"dot"-boundary pattern hostnameIsWhitelisted above uses for
 * subdomains, applied to path segments with "/" as the separator
 * instead). Query strings and fragments are deliberately ignored on both
 * sides -- a tracking parameter appended to an otherwise-identical link
 * (e.g. "?utm_source=...") doesn't change which channel/page it points
 * at, so it must not be able to defeat a block by accident. */
export function urlMatchesBlacklistEntry(url: string, entry: BlacklistEntry): boolean {
  const parsed = safeParseUrl(url);
  if (!parsed || !parsed.hostname) return false;
  const host = normalizeHostname(parsed.hostname);
  if (host !== entry.hostname) return false;
  const path = normalizePathForBlacklist(parsed.pathname);
  return path === entry.path || path.startsWith(`${entry.path === "/" ? "" : entry.path}/`);
}

/** True if the message contains at least one link matching any entry on
 * the blacklist -- the one check src/handlers/telegram.ts needs for this
 * feature, mirroring messageHasDisallowedLink above but for the opposite
 * list shape (block-if-matches rather than block-unless-matches). A
 * message with no links, or whose links match nothing on the blacklist,
 * returns false. Whether the SENDER is exempt is, as with the whitelist
 * feature, not this function's concern. */
export function messageHasBlacklistedLink(
  message: Pick<Message, "text" | "entities" | "caption" | "caption_entities">,
  blacklist: readonly BlacklistEntry[],
): boolean {
  const links = extractMessageLinks(message);
  return links.some((url) => blacklist.some((entry) => urlMatchesBlacklistEntry(url, entry)));
}

/** Same bound as WHITELIST_HOSTNAME_MAX_LENGTH -- a real DNS hostname is
 * at most 253 characters -- plus generous room for the path itself. */
const BLACKLIST_ENTRY_MAX_LENGTH = 253 + 1024;

export type BlacklistEntryValidation = { ok: true; entry: BlacklistEntry; display: string } | { ok: false; error: string };

/** Parses one line of owner input -- "https://t.me/somechannel",
 * "youtube.com/@BadChannel", "vk.com/badgroup/" -- into the
 * BlacklistEntry it will be matched against (see urlMatchesBlacklistEntry).
 * Runs the input through the same parsing (safeParseUrl) and hostname
 * normalization (normalizeHostname) the whitelist uses, so "the same
 * site" means the same thing across both features, then additionally
 * requires and normalizes a path.
 *
 * A bare domain with no path (or only "/") is REFUSED, not silently
 * accepted as "block the whole domain" -- that would make this feature
 * do exactly what it was explicitly asked not to do (block a whole
 * platform rather than one specific channel/page on it); someone who
 * actually wants an entire domain gone has AntiLink's whitelist for that
 * (by simply never whitelisting it), which is what that mechanism is
 * for. `display` is the original full URL the owner typed (with the
 * scheme/host case they used), trimmed but otherwise unmodified -- shown
 * back to them on the list screen, since "t.me / /somechannel" read from
 * the normalized {hostname, path} alone would be far less recognizable
 * than the link they actually pasted. */
export function normalizeBlacklistEntry(input: string): BlacklistEntryValidation {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "пустая строка" };
  if (trimmed.length > BLACKLIST_ENTRY_MAX_LENGTH) {
    return { ok: false, error: `слишком длинная ссылка (максимум ${BLACKLIST_ENTRY_MAX_LENGTH} символов)` };
  }
  const parsed = safeParseUrl(trimmed);
  if (!parsed || !parsed.hostname) return { ok: false, error: "не похоже на ссылку" };
  const path = normalizePathForBlacklist(parsed.pathname);
  if (path === "/") {
    return {
      ok: false,
      error:
        "это похоже на домен целиком, а не на ссылку на конкретный канал/страницу — " +
        "укажите полную ссылку, например t.me/канал или youtube.com/@канал",
    };
  }
  return { ok: true, entry: { hostname: normalizeHostname(parsed.hostname), path }, display: trimmed };
}

// ---------------------------------------------------------------------------
// URL blacklist storage
// ---------------------------------------------------------------------------

/** What's actually stored per entry: the normalized {hostname, path} used
 * for matching, plus the original text the owner typed, so the list
 * screen can show back something recognizable (see
 * normalizeBlacklistEntry's own comment on `display`). */
export interface StoredBlacklistEntry extends BlacklistEntry {
  display: string;
}

/** Reads the stored blacklist. NULL/undefined, or anything that isn't a
 * JSON array of well-formed entries (corrupted, hand-edited), both
 * resolve to an empty list -- same reasoning as resolveAntilinkWhitelist
 * above: there is no built-in default here either, since which links are
 * unwanted is entirely specific to each chat. */
export function resolveUrlBlacklist(stored: string | null | undefined): StoredBlacklistEntry[] {
  if (stored === null || stored === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is StoredBlacklistEntry =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as StoredBlacklistEntry).hostname === "string" &&
        typeof (p as StoredBlacklistEntry).path === "string" &&
        typeof (p as StoredBlacklistEntry).display === "string",
    );
  } catch {
    // fall through to empty
  }
  return [];
}

export function serializeUrlBlacklist(entries: readonly StoredBlacklistEntry[]): string {
  return JSON.stringify(entries);
}

/** Same page size and the same reasoning as ANTILINK_WHITELIST_PAGE_SIZE
 * above: no cap on the total number of entries (addBlacklistEntries below
 * never refuses for "too many"), paginated instead to stay within
 * Telegram's 100-buttons-per-message limit regardless of how large the
 * list grows. */
export const URL_BLACKLIST_PAGE_SIZE = 20;

export interface AddBlacklistEntriesResult {
  /** The full blacklist after adding. */
  blacklist: StoredBlacklistEntry[];
  /** Entries actually added, for display (their original typed form). */
  added: string[];
  /** Lines that were refused, with why. Blank lines are ignored, not
   * listed -- same convention as the whitelist and as addSpamPhrases in
   * moderation-settings.ts. */
  skipped: Array<{ input: string; reason: WhitelistSkipReason; error?: string }>;
}

/** Adds blacklist entries from free text, one per line -- same
 * one-line-per-entry convention as addWhitelistEntries above. Each line
 * is parsed and checked independently, so one bad line (including the
 * "that's a whole domain, not a specific link" case) doesn't reject the
 * rest. Duplicate check compares the normalized {hostname, path}, not
 * the original typed text, so "t.me/x" and "https://t.me/x/" are
 * correctly recognized as the same entry even though they're typed
 * differently. */
export function addBlacklistEntries(
  current: readonly StoredBlacklistEntry[],
  rawInput: string,
): AddBlacklistEntriesResult {
  const blacklist = [...current];
  const added: string[] = [];
  const skipped: AddBlacklistEntriesResult["skipped"] = [];

  for (const line of rawInput.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const checked = normalizeBlacklistEntry(line);
    if (!checked.ok) {
      skipped.push({ input: line.trim(), reason: "invalid", error: checked.error });
      continue;
    }
    const isDuplicate = blacklist.some(
      (e) => e.hostname === checked.entry.hostname && e.path === checked.entry.path,
    );
    if (isDuplicate) {
      skipped.push({ input: checked.display, reason: "duplicate" });
      continue;
    }
    const stored: StoredBlacklistEntry = { ...checked.entry, display: checked.display };
    blacklist.push(stored);
    added.push(checked.display);
  }
  return { blacklist, added, skipped };
}

/** Returns the blacklist without the entry at `index`, or null if `index`
 * isn't a valid position -- same reasoning (and the same risk window) as
 * removeWhitelistEntryAt above. */
export function removeBlacklistEntryAt(
  current: readonly StoredBlacklistEntry[],
  index: number,
): StoredBlacklistEntry[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
  return current.filter((_, i) => i !== index);
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
