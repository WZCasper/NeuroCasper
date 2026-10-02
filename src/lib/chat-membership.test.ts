import { test } from "node:test";
import assert from "node:assert/strict";
import { bioLooksLikeSpam, escapeHtml, isMemberStatus } from "./chat-membership.js";

// ---------------------------------------------------------------------------
// isMemberStatus
// ---------------------------------------------------------------------------

test("creator, administrator and member all count as being in the chat", () => {
  assert.equal(isMemberStatus({ status: "creator" }), true);
  assert.equal(isMemberStatus({ status: "administrator" }), true);
  assert.equal(isMemberStatus({ status: "member" }), true);
});

test("left and kicked never count as being in the chat", () => {
  assert.equal(isMemberStatus({ status: "left" }), false);
  assert.equal(isMemberStatus({ status: "kicked" }), false);
});

test("restricted defers to its own is_member flag rather than being treated as always in or always out", () => {
  assert.equal(isMemberStatus({ status: "restricted", is_member: true }), true);
  assert.equal(isMemberStatus({ status: "restricted", is_member: false }), false);
});

test("restricted with is_member omitted is treated as not a member (fails closed, not open)", () => {
  assert.equal(isMemberStatus({ status: "restricted" }), false);
});

test("an unrecognized status string is treated as not a member rather than throwing", () => {
  // Defends against a future Bot API status this code doesn't know about
  // yet -- silently not-a-member is the safe default (it only ever makes
  // handleMyChatMemberUpdate treat an add/remove transition as having
  // happened when it possibly hasn't, never the reverse of hiding one).
  assert.equal(isMemberStatus({ status: "some_future_status" }), false);
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

test("leaves plain text with no special characters unchanged", () => {
  assert.equal(escapeHtml("Casper"), "Casper");
});

test("escapes each of the three HTML-significant characters individually", () => {
  assert.equal(escapeHtml("A & B"), "A &amp; B");
  assert.equal(escapeHtml("5 < 10"), "5 &lt; 10");
  assert.equal(escapeHtml("10 > 5"), "10 &gt; 5");
});

test("escapes all three together, in order, without double-escaping the ampersands introduced by the other replacements", () => {
  // & must be escaped first: escaping < and > first would be fine on its
  // own, but escaping & LAST would double-escape the &amp; / &lt; / &gt;
  // that the earlier replacements just introduced (producing &amp;amp;
  // etc). escapeHtml's replace order (& then < then >) avoids that.
  assert.equal(escapeHtml("<b>A & B</b>"), "&lt;b&gt;A &amp; B&lt;/b&gt;");
});

test("neutralizes an HTML injection attempt via a spoofed Telegram first_name", () => {
  // This is exactly the attack src/lib/chat-membership.ts's own doc
  // comment describes: a user sets their Telegram first_name to something
  // that looks like a tag, hoping it gets interpreted as real markup once
  // interpolated into a parse_mode: "HTML" message alongside genuine tags.
  const maliciousFirstName = '<a href="https://evil.example">click here</a>';
  const escaped = escapeHtml(maliciousFirstName);
  assert.equal(escaped, "&lt;a href=\"https://evil.example\"&gt;click here&lt;/a&gt;");
  // The escaped form must not contain a literal, renderable <a> tag.
  assert.ok(!escaped.includes("<a "), "escaped output must not contain a literal opening <a> tag");
});

// ---------------------------------------------------------------------------
// bioLooksLikeSpam
// ---------------------------------------------------------------------------

test("an undefined bio (missing or privacy-hidden) is never spam", () => {
  assert.equal(bioLooksLikeSpam(undefined), false);
});

test("an empty-string bio is never spam", () => {
  assert.equal(bioLooksLikeSpam(""), false);
});

test("an ordinary, unremarkable bio is not spam", () => {
  assert.equal(bioLooksLikeSpam("Люблю котиков и путешествия"), false);
});

test("detects the loan-solicitation category (one of the two named examples)", () => {
  assert.equal(bioLooksLikeSpam("Даю деньги в долг быстро, звони"), true);
});

test("detects the job-seeking-spam category (the other named example)", () => {
  assert.equal(bioLooksLikeSpam("Нужна работа, любая, срочно"), true);
});

test("matches case-insensitively", () => {
  assert.equal(bioLooksLikeSpam("ДЕНЬГИ В ДОЛГ под расписку"), true);
  assert.equal(bioLooksLikeSpam("Деньги В Долг"), true);
});

test("matches as a substring anywhere in a longer bio, not only as the whole bio", () => {
  assert.equal(bioLooksLikeSpam("21 год, из Москвы. Ищу работу на удалёнке, пишите в личку"), true);
});

test("a bio that merely shares individual words with a spam phrase, without the phrase itself, is not spam", () => {
  // Guards against the check being accidentally looser than the literal
  // phrase list -- "работа" and "деньги" appear individually in plenty of
  // ordinary bios that aren't soliciting loans or touting for gig work.
  assert.equal(bioLooksLikeSpam("Работа программистом, увлекаюсь шахматами"), false);
  assert.equal(bioLooksLikeSpam("Считаю деньги на карманные расходы"), false);
});

test("uses a custom phrase list when one is passed, instead of the built-in default", () => {
  // A phrase that IS in the built-in default list must NOT match once a
  // custom (and different) list is supplied -- the custom list fully
  // replaces the default, it doesn't merge with it.
  assert.equal(bioLooksLikeSpam("Даю деньги в долг быстро, звони", ["продам гараж"]), false);
  // A phrase that is only in the custom list DOES match.
  assert.equal(bioLooksLikeSpam("Продам гараж недорого", ["продам гараж"]), true);
});

test("an empty custom phrase list matches nothing, even a bio that would trip the built-in default", () => {
  assert.equal(bioLooksLikeSpam("Даю деньги в долг быстро, звони", []), false);
});

test("a blank phrase in a custom list is ignored, not treated as matching every bio", () => {
  // String#includes("") is true for any string, so a naive implementation
  // would ban everyone who joins once an empty entry sneaks into the list
  // (e.g. from a stray blank line). normalizeSpamPhrase("") === "" is
  // filtered out explicitly for this reason.
  assert.equal(bioLooksLikeSpam("Совершенно обычное описание профиля", ["", "   "]), false);
});

test("custom-list matching is case- and spacing-insensitive, same as the default list", () => {
  assert.equal(bioLooksLikeSpam("ПРОДАМ   Гараж недорого", ["продам гараж"]), true);
});

