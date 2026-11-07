import { test } from "node:test";
import assert from "node:assert/strict";
import { formatOnboardingComplete, isValidAnswerText, looksLikeActivisionTag } from "./cod-onboarding.js";

// ---------------------------------------------------------------------------
// isValidAnswerText
// ---------------------------------------------------------------------------

test("isValidAnswerText accepts an ordinary short name", () => {
  assert.equal(isValidAnswerText("Casper"), true);
});

test("isValidAnswerText rejects an empty or whitespace-only answer", () => {
  assert.equal(isValidAnswerText(""), false);
  assert.equal(isValidAnswerText("   "), false);
});

test("isValidAnswerText rejects an unreasonably long answer (someone pasting a wall of text instead of a name)", () => {
  assert.equal(isValidAnswerText("a".repeat(101)), false);
  assert.equal(isValidAnswerText("a".repeat(100)), true); // boundary: exactly 100 is still fine
});

// ---------------------------------------------------------------------------
// looksLikeActivisionTag
// ---------------------------------------------------------------------------

test("looksLikeActivisionTag accepts the owner's own example format verbatim", () => {
  assert.equal(looksLikeActivisionTag("亗 Casper#7378333"), true);
});

test("looksLikeActivisionTag accepts a plain ASCII name + # + digits", () => {
  assert.equal(looksLikeActivisionTag("Gazreyn#2546"), true);
});

test("looksLikeActivisionTag rejects a string with no '#' at all", () => {
  assert.equal(looksLikeActivisionTag("just a name"), false);
});

test("looksLikeActivisionTag rejects a '#' with nothing numeric after it", () => {
  assert.equal(looksLikeActivisionTag("Casper#"), false);
  assert.equal(looksLikeActivisionTag("Casper#abc"), false);
});

test("looksLikeActivisionTag uses the LAST '#' when the name part itself contains one (e.g. a hashtag-style nickname)", () => {
  // "#1 Casper#7378333" -- the name happens to contain a '#' too; the
  // real numeric suffix is the one after the LAST '#', not the first.
  assert.equal(looksLikeActivisionTag("#1 Casper#7378333"), true);
});

test("looksLikeActivisionTag trims surrounding whitespace before checking", () => {
  assert.equal(looksLikeActivisionTag("  Casper#1234  "), true);
});

// ---------------------------------------------------------------------------
// formatOnboardingComplete
// ---------------------------------------------------------------------------

test("formatOnboardingComplete includes both the display name and the tag the user gave", () => {
  const message = formatOnboardingComplete("Casper", "亗 Casper#7378333");
  assert.ok(message.includes("Casper"));
  assert.ok(message.includes("亗 Casper#7378333"));
});
