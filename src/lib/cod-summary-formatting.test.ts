import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractLifetimeStats,
  formatDailySummaryMessage,
  formatMemberFailureLine,
  formatMemberStatsLine,
} from "./cod-summary-formatting.js";

// ---------------------------------------------------------------------------
// extractLifetimeStats
// ---------------------------------------------------------------------------

test("extractLifetimeStats reads all four fields from a well-formed response", () => {
  const raw = { data: { lifetime: { all: { properties: { kills: 1234, deaths: 987, wins: 12, kdRatio: 1.25 } } } } };
  assert.deepEqual(extractLifetimeStats(raw), { kills: 1234, deaths: 987, wins: 12, kdRatio: 1.25 });
});

test("extractLifetimeStats returns all-undefined for a response with no lifetime section at all", () => {
  const raw = { data: { username: "Casper" } };
  assert.deepEqual(extractLifetimeStats(raw), { kills: undefined, deaths: undefined, wins: undefined, kdRatio: undefined });
});

test("extractLifetimeStats returns all-undefined for completely unrelated input (null, a string, an array)", () => {
  assert.deepEqual(extractLifetimeStats(null), { kills: undefined, deaths: undefined, wins: undefined, kdRatio: undefined });
  assert.deepEqual(extractLifetimeStats("not an object"), { kills: undefined, deaths: undefined, wins: undefined, kdRatio: undefined });
  assert.deepEqual(extractLifetimeStats([1, 2, 3]), { kills: undefined, deaths: undefined, wins: undefined, kdRatio: undefined });
});

test("extractLifetimeStats leaves a single missing field undefined without affecting the other three", () => {
  const raw = { data: { lifetime: { all: { properties: { kills: 50, wins: 2 } } } } };
  assert.deepEqual(extractLifetimeStats(raw), { kills: 50, deaths: undefined, wins: 2, kdRatio: undefined });
});

test("extractLifetimeStats treats a non-numeric value for a known field as undefined, not as a crash or a coerced number", () => {
  const raw = { data: { lifetime: { all: { properties: { kills: "not a number", wins: 5 } } } } };
  const result = extractLifetimeStats(raw);
  assert.equal(result.kills, undefined);
  assert.equal(result.wins, 5);
});

// ---------------------------------------------------------------------------
// formatMemberStatsLine
// ---------------------------------------------------------------------------

test("formatMemberStatsLine includes all four stats when all are present", () => {
  const line = formatMemberStatsLine("Casper", "亗 Casper#7378333", { kills: 1234, deaths: 987, wins: 12, kdRatio: 1.25 });
  assert.ok(line.includes("Casper"));
  assert.ok(line.includes("亗 Casper#7378333"));
  assert.ok(line.includes("1234"));
  assert.ok(line.includes("987"));
  assert.ok(line.includes("12"));
  assert.ok(line.includes("1.25"));
});

test("formatMemberStatsLine omits a field entirely when it's undefined, rather than showing 0 or a placeholder", () => {
  const line = formatMemberStatsLine("Casper", "Casper#1234", { kills: 100, deaths: undefined, wins: undefined, kdRatio: undefined });
  assert.ok(line.includes("100"));
  assert.ok(!line.includes("смертей"), "must not mention deaths at all when the value is unknown");
  assert.ok(!line.includes("побед"), "must not mention wins at all when the value is unknown");
});

test("formatMemberStatsLine says so explicitly when NO field came through at all, instead of an empty/misleading line", () => {
  const line = formatMemberStatsLine("Casper", "Casper#1234", { kills: undefined, deaths: undefined, wins: undefined, kdRatio: undefined });
  assert.ok(line.includes("не прислал"));
});

test("formatMemberStatsLine rounds kdRatio to 2 decimals but kills/deaths/wins to whole numbers", () => {
  const line = formatMemberStatsLine("Casper", "Casper#1234", { kills: 100, deaths: 50, wins: 3, kdRatio: 2 });
  assert.ok(line.includes("K/D 2.00"));
  assert.ok(!line.includes("100.00"), "kills must not get decimal places");
});

// ---------------------------------------------------------------------------
// formatMemberFailureLine
// ---------------------------------------------------------------------------

test("formatMemberFailureLine gives a distinct, actionable explanation for each failure reason", () => {
  const unauth = formatMemberFailureLine("Casper", "Casper#1234", "unauthenticated");
  const privateProfile = formatMemberFailureLine("Casper", "Casper#1234", "profile_private");
  assert.notEqual(unauth, privateProfile);
  assert.ok(privateProfile.includes("Account Linking"), "the profile_private case should point the member at the actual fix");
});

test("formatMemberFailureLine always includes the member's name and tag, whatever the reason", () => {
  for (const reason of ["unauthenticated", "not_found_or_unknown_title", "profile_private", "unexpected_response"] as const) {
    const line = formatMemberFailureLine("Casper", "Casper#1234", reason);
    assert.ok(line.includes("Casper"));
    assert.ok(line.includes("Casper#1234"));
  }
});

// ---------------------------------------------------------------------------
// formatDailySummaryMessage
// ---------------------------------------------------------------------------

test("formatDailySummaryMessage includes the channel title and every member line, in order", () => {
  const message = formatDailySummaryMessage("Моя группа", ["• первая строка", "• вторая строка"]);
  assert.ok(message.includes("Моя группа"));
  assert.ok(message.indexOf("первая строка") < message.indexOf("вторая строка"));
});
