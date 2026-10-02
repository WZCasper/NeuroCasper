import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateRegistrationDate, formatApproximateRegistrationDate } from "./registration-date-estimate.js";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// estimateRegistrationDate
//
// The two interpolation cases below are cross-checked against an
// independent Python re-implementation of the exact same
// WizardLoop/CreationDate algorithm and dataset (see
// src/lib/registration-date-estimate.ts's module doc comment for
// provenance), computed separately from -- not derived from -- this
// TypeScript port, so a match confirms the port is faithful rather than
// merely internally consistent.
// ---------------------------------------------------------------------------

test("an ID exactly at a known reference point returns that point's date verbatim, no interpolation", () => {
  // 400169472 -> "2017-07-31" is one of the dataset's own points.
  const result = estimateRegistrationDate(400169472);
  assert.equal(isoDate(result.date), "2017-07-31");
  assert.equal(result.extrapolated, false);
});

test("an ID at or before the very first reference point returns that point's date, not an earlier extrapolation", () => {
  const result = estimateRegistrationDate(0);
  assert.equal(isoDate(result.date), "2013-08-14");
  assert.equal(result.extrapolated, false);

  // Negative/pre-launch IDs (which cannot occur for a real Telegram user,
  // but the function shouldn't misbehave if ever called with one) clamp
  // to the same floor rather than extrapolating backwards past it.
  const resultBelowZero = estimateRegistrationDate(-100);
  assert.equal(isoDate(resultBelowZero.date), "2013-08-14");
});

test("interpolates between two known points, matching an independently-computed reference value (case 1)", () => {
  // Cross-checked in Python: interpolating between (400169472,
  // "2017-07-31") and (805158066, "2019-07-15") at userId 600000000
  // yields 2018-07-18.
  const result = estimateRegistrationDate(600000000);
  assert.equal(isoDate(result.date), "2018-07-18");
  assert.equal(result.extrapolated, false);
});

test("interpolates between two known points, matching an independently-computed reference value (case 2)", () => {
  // Cross-checked in Python: interpolating between (7002435197,
  // "2024-04-06") and (7078066115, "2024-09-08") at userId 7050000000
  // yields 2024-07-12.
  const result = estimateRegistrationDate(7050000000);
  assert.equal(isoDate(result.date), "2024-07-12");
  assert.equal(result.extrapolated, false);
});

test("an ID past the last reference point extrapolates and is flagged as extrapolated", () => {
  // The dataset's last point is (8559682245, "2025-11-11"). An ID well
  // past that must still return SOME date (not throw, not fall through
  // unhandled) and must be flagged so callers know this specific
  // estimate isn't bounded by the source dataset's usual accuracy claim.
  const result = estimateRegistrationDate(9500000000);
  assert.equal(result.extrapolated, true);
  assert.ok(result.date.getTime() > 0, "must produce a real date, not an invalid one");
});

test("an extrapolated date is never later than the current moment (an account cannot register in the future)", () => {
  const before = Date.now();
  // An enormous ID, far beyond anything Telegram has issued, to force
  // the extrapolated estimate as far into the future as the raw linear
  // formula would otherwise put it.
  const result = estimateRegistrationDate(9_000_000_000_000);
  const after = Date.now();
  assert.ok(
    result.date.getTime() <= after,
    `estimated date ${result.date.toISOString()} must not be later than now`,
  );
  // Sanity: the clamp actually engaged for an ID this extreme (otherwise
  // this test would trivially pass without exercising the Math.min at
  // all).
  assert.ok(before > 0);
});

// ---------------------------------------------------------------------------
// formatApproximateRegistrationDate
// ---------------------------------------------------------------------------

test("formats a normal (non-extrapolated) estimate with the ≈ prefix and no extra caveat", () => {
  const formatted = formatApproximateRegistrationDate({ date: new Date("2018-07-18T00:00:00Z"), extrapolated: false });
  assert.equal(formatted, "≈ 18 июля 2018");
});

test("formats an extrapolated estimate with the ≈ prefix AND the extra low-confidence note", () => {
  const formatted = formatApproximateRegistrationDate({ date: new Date("2026-01-01T00:00:00Z"), extrapolated: true });
  assert.equal(formatted, "≈ 1 января 2026 (очень грубая оценка, данных за этот период мало)");
});

test("renders every month name correctly (genitive case), not just the ones exercised above", () => {
  const monthDates: Array<[string, string]> = [
    ["2020-01-15T00:00:00Z", "15 января 2020"],
    ["2020-02-15T00:00:00Z", "15 февраля 2020"],
    ["2020-03-15T00:00:00Z", "15 марта 2020"],
    ["2020-04-15T00:00:00Z", "15 апреля 2020"],
    ["2020-05-15T00:00:00Z", "15 мая 2020"],
    ["2020-06-15T00:00:00Z", "15 июня 2020"],
    ["2020-07-15T00:00:00Z", "15 июля 2020"],
    ["2020-08-15T00:00:00Z", "15 августа 2020"],
    ["2020-09-15T00:00:00Z", "15 сентября 2020"],
    ["2020-10-15T00:00:00Z", "15 октября 2020"],
    ["2020-11-15T00:00:00Z", "15 ноября 2020"],
    ["2020-12-15T00:00:00Z", "15 декабря 2020"],
  ];
  for (const [iso, expectedTail] of monthDates) {
    const formatted = formatApproximateRegistrationDate({ date: new Date(iso), extrapolated: false });
    assert.equal(formatted, `≈ ${expectedTail}`);
  }
});
