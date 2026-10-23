import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEAVE_TEMPLATE,
  DEFAULT_SPAM_PHRASES,
  DEFAULT_WELCOME_TEMPLATE,
  LEAVE_TEMPLATE_MAX_LENGTH,
  SPAM_PHRASE_MAX_LENGTH,
  SPAM_PHRASE_MIN_LENGTH,
  WELCOME_DELETE_AFTER_MAX_SECONDS,
  WELCOME_TEMPLATE_MAX_LENGTH,
  addSpamPhrases,
  formatDeleteAfter,
  normalizeSpamPhrase,
  removeSpamPhraseAt,
  renderLeaveText,
  renderWelcomeText,
  resolveLeaveTemplate,
  resolveSpamPhrases,
  resolveWelcomeTemplate,
  serializeSpamPhrases,
  validateLeaveTemplate,
  validateWelcomeDeleteAfterMinutes,
  validateWelcomeTemplate,
} from "./moderation-settings.js";

// ---------------------------------------------------------------------------
// resolveWelcomeTemplate
// ---------------------------------------------------------------------------

test("null or undefined stored template resolves to the built-in default", () => {
  assert.equal(resolveWelcomeTemplate(null), DEFAULT_WELCOME_TEMPLATE);
  assert.equal(resolveWelcomeTemplate(undefined), DEFAULT_WELCOME_TEMPLATE);
});

test("a whitespace-only stored template also falls back to the default, not an empty greeting", () => {
  // validateWelcomeTemplate rejects this on input, but resolveWelcomeTemplate
  // is a second, independent line of defense for whatever ends up stored.
  assert.equal(resolveWelcomeTemplate("   "), DEFAULT_WELCOME_TEMPLATE);
});

test("a real custom template is returned exactly as stored", () => {
  assert.equal(resolveWelcomeTemplate("Привет, {name}!"), "Привет, {name}!");
});

// ---------------------------------------------------------------------------
// renderWelcomeText
// ---------------------------------------------------------------------------

test("substitutes every documented placeholder", () => {
  const out = renderWelcomeText("{name} / {username} / {registered} / {chat}", {
    name: "Иван Иванов",
    username: "@ivan",
    registered: "≈ 1 января 2020",
    chat: "Тестовая группа",
  });
  assert.equal(out, "Иван Иванов / @ivan / ≈ 1 января 2020 / Тестовая группа");
});

test("an unknown placeholder is left untouched rather than silently removed", () => {
  const out = renderWelcomeText("{name} — {typo}", { name: "Иван", username: "", registered: "", chat: "" });
  assert.equal(out, "Иван — {typo}");
});

// ---------------------------------------------------------------------------
// resolveLeaveTemplate / renderLeaveText / validateLeaveTemplate
// ---------------------------------------------------------------------------

test("null, undefined, or whitespace-only stored leave template resolves to the built-in default", () => {
  assert.equal(resolveLeaveTemplate(null), DEFAULT_LEAVE_TEMPLATE);
  assert.equal(resolveLeaveTemplate(undefined), DEFAULT_LEAVE_TEMPLATE);
  assert.equal(resolveLeaveTemplate("   "), DEFAULT_LEAVE_TEMPLATE);
});

test("a real custom leave template is returned exactly as stored", () => {
  assert.equal(resolveLeaveTemplate("Пока, {name}!"), "Пока, {name}!");
});

test("renderLeaveText substitutes every documented placeholder (no {registered}, unlike welcome)", () => {
  const out = renderLeaveText("{name} / {username} / {chat}", {
    name: "Иван Иванов",
    username: "@ivan",
    chat: "Тестовая группа",
  });
  assert.equal(out, "Иван Иванов / @ivan / Тестовая группа");
});

test("renderLeaveText leaves an unknown placeholder untouched rather than silently removing it", () => {
  const out = renderLeaveText("{name} — {typo}", { name: "Иван", username: "", chat: "" });
  assert.equal(out, "Иван — {typo}");
});

test("validateLeaveTemplate rejects an empty or whitespace-only template", () => {
  assert.equal(validateLeaveTemplate("").ok, false);
  assert.equal(validateLeaveTemplate("   \n  ").ok, false);
});

test("validateLeaveTemplate accepts a normal template and returns it trimmed", () => {
  const result = validateLeaveTemplate("  Пока, {name}!  ");
  assert.deepEqual(result, { ok: true, template: "Пока, {name}!" });
});

test("validateLeaveTemplate accepts a template exactly at the max length, rejects one character over", () => {
  const atLimit = "a".repeat(LEAVE_TEMPLATE_MAX_LENGTH);
  assert.equal(validateLeaveTemplate(atLimit).ok, true);

  const overLimit = "a".repeat(LEAVE_TEMPLATE_MAX_LENGTH + 1);
  const result = validateLeaveTemplate(overLimit);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.includes(String(LEAVE_TEMPLATE_MAX_LENGTH)));
});

// ---------------------------------------------------------------------------
// validateWelcomeTemplate
// ---------------------------------------------------------------------------

test("rejects an empty or whitespace-only template", () => {
  assert.equal(validateWelcomeTemplate("").ok, false);
  assert.equal(validateWelcomeTemplate("   \n  ").ok, false);
});

test("accepts a normal template and returns it trimmed", () => {
  const result = validateWelcomeTemplate("  Привет, {name}!  ");
  assert.deepEqual(result, { ok: true, template: "Привет, {name}!" });
});

test("accepts a template exactly at the max length, rejects one character over", () => {
  const atLimit = "a".repeat(WELCOME_TEMPLATE_MAX_LENGTH);
  assert.equal(validateWelcomeTemplate(atLimit).ok, true);

  const overLimit = "a".repeat(WELCOME_TEMPLATE_MAX_LENGTH + 1);
  const result = validateWelcomeTemplate(overLimit);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.includes(String(WELCOME_TEMPLATE_MAX_LENGTH)));
});

// ---------------------------------------------------------------------------
// normalizeSpamPhrase
// ---------------------------------------------------------------------------

test("lowercases, collapses internal whitespace, and trims", () => {
  assert.equal(normalizeSpamPhrase("  Деньги   В  Долг  "), "деньги в долг");
  assert.equal(normalizeSpamPhrase("Нужна\tработа\n"), "нужна работа");
});

// ---------------------------------------------------------------------------
// resolveSpamPhrases / serializeSpamPhrases
// ---------------------------------------------------------------------------

test("null or undefined stored phrases resolve to the built-in default list", () => {
  assert.deepEqual(resolveSpamPhrases(null), [...DEFAULT_SPAM_PHRASES]);
  assert.deepEqual(resolveSpamPhrases(undefined), [...DEFAULT_SPAM_PHRASES]);
});

test("DEFAULT_SPAM_PHRASES has no duplicates and every phrase is already normalized and within bounds", () => {
  assert.equal(DEFAULT_SPAM_PHRASES.length, 77);
  assert.equal(new Set(DEFAULT_SPAM_PHRASES).size, DEFAULT_SPAM_PHRASES.length, "no duplicate phrases");
  for (const phrase of DEFAULT_SPAM_PHRASES) {
    assert.equal(phrase, normalizeSpamPhrase(phrase), `"${phrase}" must already be in normalized form`);
    assert.ok(phrase.length >= SPAM_PHRASE_MIN_LENGTH, `"${phrase}" is shorter than SPAM_PHRASE_MIN_LENGTH`);
    assert.ok(phrase.length <= SPAM_PHRASE_MAX_LENGTH, `"${phrase}" is longer than SPAM_PHRASE_MAX_LENGTH`);
  }
});

test("a stored empty array is honored as 'no phrases', distinct from null", () => {
  assert.deepEqual(resolveSpamPhrases("[]"), []);
});

test("a real stored list round-trips through serialize/resolve exactly", () => {
  const phrases = ["деньги в долг", "нужна работа"];
  assert.deepEqual(resolveSpamPhrases(serializeSpamPhrases(phrases)), phrases);
});

test("non-string entries in a stored array are dropped, not left in as-is", () => {
  assert.deepEqual(resolveSpamPhrases('["ok", 5, null, "also ok"]'), ["ok", "also ok"]);
});

test("corrupted/invalid JSON falls back to the default list rather than throwing", () => {
  assert.deepEqual(resolveSpamPhrases("{not valid json"), [...DEFAULT_SPAM_PHRASES]);
});

test("valid JSON that isn't an array (e.g. an object) falls back to the default list", () => {
  assert.deepEqual(resolveSpamPhrases('{"a": 1}'), [...DEFAULT_SPAM_PHRASES]);
});

// ---------------------------------------------------------------------------
// addSpamPhrases
// ---------------------------------------------------------------------------

test("adds one new phrase, normalized, to an empty list", () => {
  const result = addSpamPhrases([], "  Деньги В Долг  ");
  assert.deepEqual(result.phrases, ["деньги в долг"]);
  assert.deepEqual(result.added, ["деньги в долг"]);
  assert.deepEqual(result.skipped, []);
});

test("adds several phrases from separate lines, and normalizes each independently", () => {
  const result = addSpamPhrases([], "нужна работа\nЗАЙМ НА КАРТУ\n");
  assert.deepEqual(result.phrases, ["нужна работа", "займ на карту"]);
  assert.deepEqual(result.added, ["нужна работа", "займ на карту"]);
});

test("blank lines in the input are silently ignored, not reported as skipped", () => {
  const result = addSpamPhrases([], "нужна работа\n\n   \nищу работу");
  assert.deepEqual(result.added, ["нужна работа", "ищу работу"]);
  assert.deepEqual(result.skipped, []);
});

test("a phrase shorter than the minimum is skipped with reason too_short, and the rest still get added", () => {
  const result = addSpamPhrases([], "тел\nнужна работа");
  assert.deepEqual(result.added, ["нужна работа"]);
  assert.deepEqual(result.skipped, [{ phrase: "тел", reason: "too_short" }]);
});

test("a phrase at exactly the minimum length is accepted, one character under is not", () => {
  const atMin = "a".repeat(SPAM_PHRASE_MIN_LENGTH);
  const underMin = "a".repeat(SPAM_PHRASE_MIN_LENGTH - 1);
  const result = addSpamPhrases([], `${atMin}\n${underMin}`);
  assert.deepEqual(result.added, [atMin]);
  assert.deepEqual(result.skipped, [{ phrase: underMin, reason: "too_short" }]);
});

test("a phrase longer than the maximum is skipped with reason too_long", () => {
  const tooLong = "a".repeat(SPAM_PHRASE_MAX_LENGTH + 1);
  const result = addSpamPhrases([], tooLong);
  assert.deepEqual(result.skipped, [{ phrase: tooLong, reason: "too_long" }]);
  assert.deepEqual(result.added, []);
});

test("a phrase already in the current list is skipped as a duplicate, case/spacing-insensitively", () => {
  const result = addSpamPhrases(["нужна работа"], "  НУЖНА   РАБОТА  ");
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.skipped, [{ phrase: "нужна работа", reason: "duplicate" }]);
});

test("two identical phrases within the SAME input are only added once, the second is a duplicate", () => {
  const result = addSpamPhrases([], "нужна работа\nнужна работа");
  assert.deepEqual(result.added, ["нужна работа"]);
  assert.deepEqual(result.skipped, [{ phrase: "нужна работа", reason: "duplicate" }]);
});

test("never refuses for having too many phrases (no cap -- the list screen paginates instead)", () => {
  const many = Array.from({ length: 150 }, (_, i) => `фраза номер ${i}`);
  const result = addSpamPhrases(many, "ещё одна новая фраза");
  assert.equal(result.phrases.length, 151);
  assert.deepEqual(result.added, ["ещё одна новая фраза"]);
  assert.deepEqual(result.skipped, []);
});

// ---------------------------------------------------------------------------
// removeSpamPhraseAt
// ---------------------------------------------------------------------------

test("removes the phrase at the given index, preserving the order of the rest", () => {
  const result = removeSpamPhraseAt(["a", "b", "c"], 1);
  assert.deepEqual(result, ["a", "c"]);
});

test("returns null for an out-of-range index (stale button after the list changed)", () => {
  assert.equal(removeSpamPhraseAt(["a", "b"], 2), null);
  assert.equal(removeSpamPhraseAt(["a", "b"], -1), null);
  assert.equal(removeSpamPhraseAt([], 0), null);
});

test("returns null for a non-integer index rather than doing something undefined", () => {
  assert.equal(removeSpamPhraseAt(["a", "b"], 1.5), null);
});

// ---------------------------------------------------------------------------
// validateWelcomeDeleteAfterMinutes / formatDeleteAfter
// ---------------------------------------------------------------------------

test("whole minutes are converted to seconds", () => {
  assert.deepEqual(validateWelcomeDeleteAfterMinutes("10"), { ok: true, seconds: 600 });
  assert.deepEqual(validateWelcomeDeleteAfterMinutes("  1 "), { ok: true, seconds: 60 });
});

test("0 means never delete and is accepted", () => {
  assert.deepEqual(validateWelcomeDeleteAfterMinutes("0"), { ok: true, seconds: 0 });
});

test("decimal minutes work with either a dot or a comma", () => {
  assert.deepEqual(validateWelcomeDeleteAfterMinutes("1.5"), { ok: true, seconds: 90 });
  assert.deepEqual(validateWelcomeDeleteAfterMinutes("1,5"), { ok: true, seconds: 90 });
});

test("the maximum (24 hours) is accepted, one minute over is rejected", () => {
  const maxMinutes = WELCOME_DELETE_AFTER_MAX_SECONDS / 60;
  assert.deepEqual(validateWelcomeDeleteAfterMinutes(String(maxMinutes)), { ok: true, seconds: WELCOME_DELETE_AFTER_MAX_SECONDS });
  assert.equal(validateWelcomeDeleteAfterMinutes(String(maxMinutes + 1)).ok, false);
});

test("anything that is not a plain non-negative decimal is rejected", () => {
  for (const bad of ["", "   ", "abc", "-5", "+5", "1e3", "0x10", "10 минут", "5.", ".5", "Infinity", "1,2,3"]) {
    assert.equal(validateWelcomeDeleteAfterMinutes(bad).ok, false, `"${bad}" must be rejected`);
  }
});

test("formatDeleteAfter shows whole minutes, minutes+seconds, seconds, and 0 as 'never'", () => {
  assert.equal(formatDeleteAfter(600), "10 мин");
  assert.equal(formatDeleteAfter(90), "1 мин 30 сек");
  assert.equal(formatDeleteAfter(45), "45 сек");
  assert.equal(formatDeleteAfter(0), "не удалять");
});
