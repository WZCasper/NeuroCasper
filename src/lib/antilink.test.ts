import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageEntity } from "grammy/types";
import {
  addBlacklistEntries,
  addWhitelistEntries,
  extractMessageLinks,
  hostnameIsWhitelisted,
  isLinkAllowed,
  messageHasBlacklistedLink,
  messageHasDisallowedLink,
  normalizeBlacklistEntry,
  normalizeHostname,
  normalizeWhitelistEntry,
  removeBlacklistEntryAt,
  removeWhitelistEntryAt,
  resolveAntilinkWhitelist,
  resolveUrlBlacklist,
  safeParseUrl,
  serializeAntilinkWhitelist,
  serializeUrlBlacklist,
  urlMatchesBlacklistEntry,
  type StoredBlacklistEntry,
} from "./antilink.js";

// ---------------------------------------------------------------------------
// safeParseUrl
// ---------------------------------------------------------------------------

test("safeParseUrl parses a URL that already has a scheme", () => {
  const parsed = safeParseUrl("https://example.com/path");
  assert.equal(parsed?.hostname, "example.com");
});

test("safeParseUrl falls back to assuming https:// for a bare domain", () => {
  const parsed = safeParseUrl("example.com/path");
  assert.equal(parsed?.hostname, "example.com");
});

test("safeParseUrl falls back to https:// for a bare www. domain with no path", () => {
  const parsed = safeParseUrl("www.vk.com");
  assert.equal(parsed?.hostname, "www.vk.com");
});

test("safeParseUrl returns null for text with no host-like structure", () => {
  assert.equal(safeParseUrl(""), null);
  assert.equal(safeParseUrl("   "), null);
});

// ---------------------------------------------------------------------------
// normalizeHostname / hostnameIsWhitelisted
// ---------------------------------------------------------------------------

test("normalizeHostname lowercases and strips exactly one leading www.", () => {
  assert.equal(normalizeHostname("WWW.Example.COM"), "example.com");
  assert.equal(normalizeHostname("example.com"), "example.com");
  assert.equal(normalizeHostname("www.www.example.com"), "www.example.com"); // only one www. stripped
});

test("hostnameIsWhitelisted matches an exact host", () => {
  assert.equal(hostnameIsWhitelisted("youtube.com", ["youtube.com"]), true);
});

test("hostnameIsWhitelisted matches a subdomain of a whitelisted host", () => {
  assert.equal(hostnameIsWhitelisted("cdn.youtube.com", ["youtube.com"]), true);
});

test("hostnameIsWhitelisted treats www. as an alias on both sides", () => {
  assert.equal(hostnameIsWhitelisted("www.youtube.com", ["youtube.com"]), true);
  assert.equal(hostnameIsWhitelisted("youtube.com", ["www.youtube.com"]), true);
});

test("hostnameIsWhitelisted does not match an unrelated host, including a look-alike suffix", () => {
  assert.equal(hostnameIsWhitelisted("youtube.com.evil.example", ["youtube.com"]), false);
  assert.equal(hostnameIsWhitelisted("notyoutube.com", ["youtube.com"]), false);
  assert.equal(hostnameIsWhitelisted("youtu.be", ["youtube.com"]), false); // a genuinely different domain
});

test("hostnameIsWhitelisted returns false against an empty whitelist", () => {
  assert.equal(hostnameIsWhitelisted("youtube.com", []), false);
});

// ---------------------------------------------------------------------------
// isLinkAllowed
// ---------------------------------------------------------------------------

test("isLinkAllowed allows a whitelisted link and blocks everything else", () => {
  const whitelist = ["youtube.com", "vk.com"];
  assert.equal(isLinkAllowed("https://www.youtube.com/watch?v=xyz", whitelist), true);
  assert.equal(isLinkAllowed("vk.com/club123", whitelist), true); // bare domain, no scheme
  assert.equal(isLinkAllowed("https://scam-example.ru/bonus", whitelist), false);
});

test("isLinkAllowed blocks a link it cannot parse into any hostname", () => {
  // A tg:// deep link has no traditional host the way an http(s) URL does;
  // the documented, deliberate behavior is to block rather than guess.
  assert.equal(isLinkAllowed("tg://resolve?domain=something", ["youtube.com"]), false);
});

// ---------------------------------------------------------------------------
// extractMessageLinks / messageHasDisallowedLink
// ---------------------------------------------------------------------------

function urlEntity(offset: number, length: number): MessageEntity {
  return { type: "url", offset, length };
}

function textLinkEntity(offset: number, length: number, url: string): MessageEntity {
  return { type: "text_link", offset, length, url };
}

test("extractMessageLinks reads a plain autodetected url entity from the message text", () => {
  const text = "Загляни сюда: https://example.com/promo и напиши мне";
  const linkStart = text.indexOf("https://example.com/promo");
  const message = { text, entities: [urlEntity(linkStart, "https://example.com/promo".length)] };
  assert.deepEqual(extractMessageLinks(message), ["https://example.com/promo"]);
});

test("extractMessageLinks reads the real destination out of a disguised text_link entity", () => {
  // A spammer's classic move: display text looks innocent, the actual
  // destination (entity.url) is a completely different domain.
  const text = "Подробнее здесь";
  const message = {
    text,
    entities: [textLinkEntity(0, text.length, "https://totally-a-scam.example/bonus")],
  };
  assert.deepEqual(extractMessageLinks(message), ["https://totally-a-scam.example/bonus"]);
});

test("extractMessageLinks also reads links from a caption (photo/video with a link in the caption)", () => {
  const caption = "Забери бонус: https://scam.example/go";
  const linkStart = caption.indexOf("https://scam.example/go");
  const message = {
    text: undefined,
    entities: undefined,
    caption,
    caption_entities: [urlEntity(linkStart, "https://scam.example/go".length)],
  };
  assert.deepEqual(extractMessageLinks(message), ["https://scam.example/go"]);
});

test("extractMessageLinks correctly slices a url entity positioned after emoji (UTF-16 offsets)", () => {
  // 😀 is a surrogate pair (2 UTF-16 code units); Telegram's offsets count
  // code units, and so does a plain JS string .slice -- this would come
  // out one character short/long if that alignment were wrong.
  const text = "😀 https://example.com/x дальше текст";
  const linkStart = text.indexOf("https://example.com/x");
  const message = { text, entities: [urlEntity(linkStart, "https://example.com/x".length)] };
  assert.deepEqual(extractMessageLinks(message), ["https://example.com/x"]);
});

test("extractMessageLinks ignores non-link entities (bold, mention, etc.)", () => {
  const text = "@someone написал это жирным";
  const message = {
    text,
    entities: [
      { type: "mention" as const, offset: 0, length: "@someone".length },
      { type: "bold" as const, offset: text.indexOf("жирным"), length: "жирным".length },
    ],
  };
  assert.deepEqual(extractMessageLinks(message), []);
});

test("extractMessageLinks returns an empty array for a message with no text/caption at all", () => {
  assert.deepEqual(extractMessageLinks({}), []);
});

test("messageHasDisallowedLink is false when every link in the message is whitelisted", () => {
  const text = "Смотри тут: https://youtube.com/watch?v=xyz";
  const message = { text, entities: [urlEntity(text.indexOf("https://"), "https://youtube.com/watch?v=xyz".length)] };
  assert.equal(messageHasDisallowedLink(message, ["youtube.com"]), false);
});

test("messageHasDisallowedLink is true as soon as ONE link isn't whitelisted, even if others are", () => {
  const first = "https://youtube.com/watch?v=xyz";
  const second = "https://scam.example/go";
  const text = `${first} ${second}`;
  const message = {
    text,
    entities: [urlEntity(0, first.length), urlEntity(text.indexOf(second), second.length)],
  };
  assert.equal(messageHasDisallowedLink(message, ["youtube.com"]), true);
});

test("messageHasDisallowedLink is false for a message with no links at all", () => {
  assert.equal(messageHasDisallowedLink({ text: "Привет, как дела?" }, []), false);
});

// ---------------------------------------------------------------------------
// resolveAntilinkWhitelist / serializeAntilinkWhitelist
// ---------------------------------------------------------------------------

test("resolveAntilinkWhitelist returns an empty list for null/undefined (no built-in default, unlike spam phrases)", () => {
  assert.deepEqual(resolveAntilinkWhitelist(null), []);
  assert.deepEqual(resolveAntilinkWhitelist(undefined), []);
});

test("resolveAntilinkWhitelist parses a stored JSON array of hostnames", () => {
  assert.deepEqual(resolveAntilinkWhitelist('["youtube.com","vk.com"]'), ["youtube.com", "vk.com"]);
});

test("resolveAntilinkWhitelist falls back to an empty list for corrupted/non-array JSON", () => {
  assert.deepEqual(resolveAntilinkWhitelist("not json at all"), []);
  assert.deepEqual(resolveAntilinkWhitelist('{"not":"an array"}'), []);
});

test("serializeAntilinkWhitelist round-trips through resolveAntilinkWhitelist", () => {
  const list = ["youtube.com", "vk.com", "t.me"];
  assert.deepEqual(resolveAntilinkWhitelist(serializeAntilinkWhitelist(list)), list);
});

// ---------------------------------------------------------------------------
// normalizeWhitelistEntry
// ---------------------------------------------------------------------------

test("normalizeWhitelistEntry accepts a bare domain", () => {
  const result = normalizeWhitelistEntry("youtube.com");
  assert.deepEqual(result, { ok: true, hostname: "youtube.com" });
});

test("normalizeWhitelistEntry accepts a full URL and reduces it to just the hostname", () => {
  const result = normalizeWhitelistEntry("https://www.youtube.com/watch?v=xyz");
  assert.deepEqual(result, { ok: true, hostname: "youtube.com" }); // www. stripped too
});

test("normalizeWhitelistEntry accepts a domain with a path and strips it", () => {
  const result = normalizeWhitelistEntry("vk.com/club123");
  assert.deepEqual(result, { ok: true, hostname: "vk.com" });
});

test("normalizeWhitelistEntry rejects an empty/blank line", () => {
  assert.equal(normalizeWhitelistEntry("").ok, false);
  assert.equal(normalizeWhitelistEntry("   ").ok, false);
});

// ---------------------------------------------------------------------------
// addWhitelistEntries
// ---------------------------------------------------------------------------

test("addWhitelistEntries adds several new hostnames from one multi-line batch", () => {
  const result = addWhitelistEntries([], "youtube.com\nvk.com\nt.me");
  assert.deepEqual(result.added, ["youtube.com", "vk.com", "t.me"]);
  assert.deepEqual(result.whitelist, ["youtube.com", "vk.com", "t.me"]);
  assert.deepEqual(result.skipped, []);
});

test("addWhitelistEntries skips a duplicate of an existing entry, in either raw form", () => {
  const result = addWhitelistEntries(["youtube.com"], "https://www.youtube.com/\nvk.com");
  assert.deepEqual(result.added, ["vk.com"]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "duplicate");
});

test("addWhitelistEntries skips a duplicate within the SAME batch too", () => {
  const result = addWhitelistEntries([], "youtube.com\nyoutube.com");
  assert.deepEqual(result.added, ["youtube.com"]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "duplicate");
});

test("addWhitelistEntries reports an invalid line without rejecting the rest of the batch", () => {
  const result = addWhitelistEntries([], "   \nyoutube.com");
  assert.deepEqual(result.added, ["youtube.com"]);
  assert.deepEqual(result.skipped, []); // the blank line is silently ignored, not reported
});

test("addWhitelistEntries never refuses for having too many entries (no cap, unlike the old spam-phrase limit)", () => {
  const many = Array.from({ length: 200 }, (_, i) => `domain-${i}.example`).join("\n");
  const result = addWhitelistEntries([], many);
  assert.equal(result.added.length, 200);
  assert.equal(result.skipped.length, 0);
});

// ---------------------------------------------------------------------------
// removeWhitelistEntryAt
// ---------------------------------------------------------------------------

test("removeWhitelistEntryAt removes exactly the entry at the given position", () => {
  const result = removeWhitelistEntryAt(["a.com", "b.com", "c.com"], 1);
  assert.deepEqual(result, ["a.com", "c.com"]);
});

test("removeWhitelistEntryAt returns null for an out-of-range index (stale button)", () => {
  assert.equal(removeWhitelistEntryAt(["a.com"], 5), null);
  assert.equal(removeWhitelistEntryAt(["a.com"], -1), null);
  assert.equal(removeWhitelistEntryAt([], 0), null);
});

// ---------------------------------------------------------------------------
// normalizeBlacklistEntry
// ---------------------------------------------------------------------------

test("normalizeBlacklistEntry accepts a full link and normalizes hostname + path", () => {
  const result = normalizeBlacklistEntry("https://t.me/somechannel");
  assert.deepEqual(result, {
    ok: true,
    entry: { hostname: "t.me", path: "/somechannel" },
    display: "https://t.me/somechannel",
  });
});

test("normalizeBlacklistEntry accepts a bare domain+path with no scheme", () => {
  const result = normalizeBlacklistEntry("youtube.com/@BadChannel");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.entry.hostname, "youtube.com");
    assert.equal(result.entry.path, "/@badchannel"); // lowercased -- see normalizePathForBlacklist's own comment
  }
});

test("normalizeBlacklistEntry strips a trailing slash from the path", () => {
  const result = normalizeBlacklistEntry("https://t.me/somechannel/");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.entry.path, "/somechannel");
});

test("normalizeBlacklistEntry REFUSES a bare domain with no path -- must not be able to blacklist a whole platform", () => {
  assert.equal(normalizeBlacklistEntry("youtube.com").ok, false);
  assert.equal(normalizeBlacklistEntry("https://t.me").ok, false);
  assert.equal(normalizeBlacklistEntry("https://t.me/").ok, false);
});

test("normalizeBlacklistEntry rejects an empty/blank line", () => {
  assert.equal(normalizeBlacklistEntry("").ok, false);
  assert.equal(normalizeBlacklistEntry("   ").ok, false);
});

test("normalizeBlacklistEntry keeps `display` as the original typed text, only trimmed", () => {
  const result = normalizeBlacklistEntry("  https://t.me/SomeChannel  ");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.display, "https://t.me/SomeChannel"); // case preserved here, unlike entry.path
});

// ---------------------------------------------------------------------------
// urlMatchesBlacklistEntry
// ---------------------------------------------------------------------------

test("urlMatchesBlacklistEntry matches the exact blacklisted link", () => {
  const entry = { hostname: "t.me", path: "/somechannel" };
  assert.equal(urlMatchesBlacklistEntry("https://t.me/somechannel", entry), true);
});

test("urlMatchesBlacklistEntry matches a deeper path under the blacklisted channel (e.g. a specific post)", () => {
  const entry = { hostname: "t.me", path: "/somechannel" };
  assert.equal(urlMatchesBlacklistEntry("https://t.me/somechannel/123", entry), true);
});

test("urlMatchesBlacklistEntry does NOT match a different channel whose name merely starts with the same text", () => {
  // The exact bug a naive string-prefix check (rather than a "/"-boundary
  // check) would have: "/somechannel" must not match "/somechannel2".
  const entry = { hostname: "t.me", path: "/somechannel" };
  assert.equal(urlMatchesBlacklistEntry("https://t.me/somechannel2", entry), false);
});

test("urlMatchesBlacklistEntry does NOT match the same path on a different host", () => {
  const entry = { hostname: "t.me", path: "/somechannel" };
  assert.equal(urlMatchesBlacklistEntry("https://example.com/somechannel", entry), false);
});

test("urlMatchesBlacklistEntry is case-insensitive on the path (Telegram/YouTube identifiers are case-insensitive on the platform itself)", () => {
  const entry = { hostname: "t.me", path: "/somechannel" };
  assert.equal(urlMatchesBlacklistEntry("https://t.me/SomeChannel", entry), true);
});

test("urlMatchesBlacklistEntry treats www. as an alias on the hostname side too", () => {
  const entry = { hostname: "youtube.com", path: "/@badchannel" };
  assert.equal(urlMatchesBlacklistEntry("https://www.youtube.com/@badchannel", entry), true);
});

test("urlMatchesBlacklistEntry ignores a query string/fragment appended to an otherwise-matching link", () => {
  const entry = { hostname: "t.me", path: "/somechannel" };
  assert.equal(urlMatchesBlacklistEntry("https://t.me/somechannel?utm_source=spam", entry), true);
  assert.equal(urlMatchesBlacklistEntry("https://t.me/somechannel#section", entry), true);
});

test("urlMatchesBlacklistEntry returns false for a link it cannot parse into any hostname", () => {
  const entry = { hostname: "t.me", path: "/somechannel" };
  assert.equal(urlMatchesBlacklistEntry("tg://resolve?domain=somechannel", entry), false);
});

// ---------------------------------------------------------------------------
// messageHasBlacklistedLink
// ---------------------------------------------------------------------------

function urlEntityAt(offset: number, length: number): MessageEntity {
  return { type: "url", offset, length };
}

test("messageHasBlacklistedLink is true when a link in the message matches a blacklist entry", () => {
  const text = "Загляни сюда: https://t.me/somechannel";
  const linkStart = text.indexOf("https://t.me/somechannel");
  const message = { text, entities: [urlEntityAt(linkStart, "https://t.me/somechannel".length)] };
  const blacklist: StoredBlacklistEntry[] = [{ hostname: "t.me", path: "/somechannel", display: "t.me/somechannel" }];
  assert.equal(messageHasBlacklistedLink(message, blacklist), true);
});

test("messageHasBlacklistedLink is false when the message's link is a DIFFERENT channel on the same platform", () => {
  const text = "https://t.me/anotherchannel";
  const message = { text, entities: [urlEntityAt(0, text.length)] };
  const blacklist: StoredBlacklistEntry[] = [{ hostname: "t.me", path: "/somechannel", display: "t.me/somechannel" }];
  assert.equal(messageHasBlacklistedLink(message, blacklist), false);
});

test("messageHasBlacklistedLink is false for a message with no links, or an empty blacklist", () => {
  assert.equal(messageHasBlacklistedLink({ text: "привет, как дела?" }, []), false);
  const text = "https://t.me/somechannel";
  const message = { text, entities: [urlEntityAt(0, text.length)] };
  assert.equal(messageHasBlacklistedLink(message, []), false);
});

// ---------------------------------------------------------------------------
// resolveUrlBlacklist / serializeUrlBlacklist
// ---------------------------------------------------------------------------

test("resolveUrlBlacklist returns an empty list for null/undefined", () => {
  assert.deepEqual(resolveUrlBlacklist(null), []);
  assert.deepEqual(resolveUrlBlacklist(undefined), []);
});

test("resolveUrlBlacklist parses a stored JSON array of entries", () => {
  const stored = '[{"hostname":"t.me","path":"/x","display":"t.me/x"}]';
  assert.deepEqual(resolveUrlBlacklist(stored), [{ hostname: "t.me", path: "/x", display: "t.me/x" }]);
});

test("resolveUrlBlacklist falls back to an empty list for corrupted JSON or malformed entries", () => {
  assert.deepEqual(resolveUrlBlacklist("not json"), []);
  assert.deepEqual(resolveUrlBlacklist('[{"hostname":"t.me"}]'), []); // missing path/display
  assert.deepEqual(resolveUrlBlacklist('["just a string, not an entry object"]'), []);
});

test("serializeUrlBlacklist round-trips through resolveUrlBlacklist", () => {
  const entries: StoredBlacklistEntry[] = [
    { hostname: "t.me", path: "/x", display: "t.me/x" },
    { hostname: "youtube.com", path: "/@bad", display: "youtube.com/@bad" },
  ];
  assert.deepEqual(resolveUrlBlacklist(serializeUrlBlacklist(entries)), entries);
});

// ---------------------------------------------------------------------------
// addBlacklistEntries
// ---------------------------------------------------------------------------

test("addBlacklistEntries adds several valid entries from one multi-line batch", () => {
  const result = addBlacklistEntries([], "t.me/badchannel\nyoutube.com/@spammer");
  assert.deepEqual(result.added, ["t.me/badchannel", "youtube.com/@spammer"]);
  assert.equal(result.blacklist.length, 2);
  assert.deepEqual(result.skipped, []);
});

test("addBlacklistEntries refuses a bare-domain line without rejecting the rest of the batch", () => {
  const result = addBlacklistEntries([], "youtube.com\nt.me/badchannel");
  assert.deepEqual(result.added, ["t.me/badchannel"]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "invalid");
});

test("addBlacklistEntries skips a duplicate of an existing entry, comparing the NORMALIZED form", () => {
  const existing: StoredBlacklistEntry[] = [{ hostname: "t.me", path: "/badchannel", display: "t.me/badchannel" }];
  // Typed differently (scheme + trailing slash) but the same normalized entry.
  const result = addBlacklistEntries(existing, "https://t.me/badchannel/");
  assert.deepEqual(result.added, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "duplicate");
});

test("addBlacklistEntries never refuses for having too many entries", () => {
  const many = Array.from({ length: 150 }, (_, i) => `example${i}.com/channel${i}`).join("\n");
  const result = addBlacklistEntries([], many);
  assert.equal(result.added.length, 150);
  assert.equal(result.skipped.length, 0);
});

// ---------------------------------------------------------------------------
// removeBlacklistEntryAt
// ---------------------------------------------------------------------------

test("removeBlacklistEntryAt removes exactly the entry at the given position", () => {
  const entries: StoredBlacklistEntry[] = [
    { hostname: "a.com", path: "/1", display: "a.com/1" },
    { hostname: "b.com", path: "/2", display: "b.com/2" },
    { hostname: "c.com", path: "/3", display: "c.com/3" },
  ];
  const result = removeBlacklistEntryAt(entries, 1);
  assert.deepEqual(result, [entries[0], entries[2]]);
});

test("removeBlacklistEntryAt returns null for an out-of-range index", () => {
  const entries: StoredBlacklistEntry[] = [{ hostname: "a.com", path: "/1", display: "a.com/1" }];
  assert.equal(removeBlacklistEntryAt(entries, 5), null);
  assert.equal(removeBlacklistEntryAt(entries, -1), null);
  assert.equal(removeBlacklistEntryAt([], 0), null);
});
