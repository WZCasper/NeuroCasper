import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChannelFlag } from "../db.js";
import {
  buildBotDeletePermissionWarning,
  CHANNEL_FLAG_LABELS,
  toggleConfirmationText,
} from "./moderation-permissions.js";

// Каждый флаг, который реально переключается кнопкой в боте (см.
// TOGGLE_ACTION_TO_FLAG и "pin"/"unpin"/"codtg" в telegram.ts), должен
// иметь подпись здесь -- иначе toggleConfirmationText молча покажет
// "undefined" вместо названия настройки.
const ALL_FLAGS: ChannelFlag[] = [
  "auto_pin",
  "auto_unpin",
  "welcome_enabled",
  "spam_filter_enabled",
  "leave_enabled",
  "antilink_enabled",
  "url_blacklist_enabled",
  "hide_service_messages",
  "cod_summary_enabled",
];

test("every known ChannelFlag has a non-empty label", () => {
  for (const flag of ALL_FLAGS) {
    const label = CHANNEL_FLAG_LABELS[flag];
    assert.equal(typeof label, "string");
    assert.ok(label.trim().length > 0, `label for ${flag} must not be empty`);
  }
});

test("toggleConfirmationText shows a checkmark and \"включено\" when enabled", () => {
  const text = toggleConfirmationText("hide_service_messages", true);
  assert.ok(text.startsWith("✅"));
  assert.ok(text.includes("включено"));
  assert.ok(!text.includes("выключено")); // "включено" being a substring of "выключено" is exactly the trap this checks for
  assert.ok(text.includes(CHANNEL_FLAG_LABELS.hide_service_messages));
});

test("toggleConfirmationText shows a cross and \"выключено\" when disabled", () => {
  const text = toggleConfirmationText("antilink_enabled", false);
  assert.ok(text.startsWith("❌"));
  assert.ok(text.includes("выключено"));
  assert.ok(text.includes(CHANNEL_FLAG_LABELS.antilink_enabled));
});

test("toggleConfirmationText label matches the flag given, not some other flag", () => {
  const text = toggleConfirmationText("cod_summary_enabled", true);
  assert.ok(text.includes(CHANNEL_FLAG_LABELS.cod_summary_enabled));
  assert.ok(!text.includes(CHANNEL_FLAG_LABELS.auto_pin));
});

test("buildBotDeletePermissionWarning: confirmed true -> no warning", () => {
  assert.equal(buildBotDeletePermissionWarning(true), "");
});

test("buildBotDeletePermissionWarning: unknown (null, the check itself failed) -> no warning, never a false alarm", () => {
  assert.equal(buildBotDeletePermissionWarning(null), "");
});

test("buildBotDeletePermissionWarning: confirmed false -> a non-empty warning naming the missing right", () => {
  const warning = buildBotDeletePermissionWarning(false);
  assert.ok(warning.length > 0);
  assert.ok(warning.includes("Удалять сообщения"));
  assert.ok(warning.endsWith("\n\n")); // leaves a blank line before the rest of the screen's own text
});
