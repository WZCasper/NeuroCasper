import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatChannelChoiceButtonLabel,
  formatHomeButtonLabel,
  HOME_MENU_BUTTON_LABEL,
  parseChannelChoicePress,
  parseHomeKeyboardPress,
  type HomeKeyboardChannel,
  type HomeSection,
} from "./home-keyboard.js";

const ALL_SECTIONS: HomeSection[] = ["channel", "streamers", "moderation"];

function channel(partial: Partial<HomeKeyboardChannel> & { id: number }): HomeKeyboardChannel {
  return { title: "Тестовая группа", telegram_chat_id: -100123456, ...partial };
}

test("formatHomeButtonLabel + parseHomeKeyboardPress round-trip for every section and a realistic channel", () => {
  const ch = channel({ id: 42, title: "CLUB WARZONE" });
  for (const section of ALL_SECTIONS) {
    const label = formatHomeButtonLabel(section, ch);
    assert.deepEqual(parseHomeKeyboardPress(label, [ch]), { kind: "section", section, channelId: 42 });
  }
});

test("formatHomeButtonLabel shows the channel's actual TITLE, not a bare id/index", () => {
  const label = formatHomeButtonLabel("moderation", channel({ id: 7, title: "CLUB WARZONE" }));
  assert.ok(label.includes("CLUB WARZONE"));
  assert.ok(!label.includes("[7]"), "must not show the raw numeric id in brackets anymore");
});

test("formatHomeButtonLabel falls back to the numeric telegram chat id only when the channel has no title yet", () => {
  const label = formatHomeButtonLabel("channel", channel({ id: 1, title: null, telegram_chat_id: -100999 }));
  assert.ok(label.includes("-100999"));
});

test("the home menu button parses to {kind: 'menu'} regardless of the channel list passed in", () => {
  assert.deepEqual(parseHomeKeyboardPress(HOME_MENU_BUTTON_LABEL, []), { kind: "menu" });
  assert.deepEqual(parseHomeKeyboardPress(HOME_MENU_BUTTON_LABEL, [channel({ id: 1 })]), { kind: "menu" });
});

test("an ordinary chat message the user typed themselves does not accidentally parse as a button press", () => {
  const ch = channel({ id: 1, title: "CLUB WARZONE" });
  assert.equal(parseHomeKeyboardPress("привет", [ch]), null);
  assert.equal(parseHomeKeyboardPress("👥 Модерация", [ch]), null); // похоже, но без названия канала — не настоящая кнопка
});

test("a button text that matches no channel the owner currently has returns null (e.g. the channel was removed)", () => {
  const ch = channel({ id: 1, title: "CLUB WARZONE" });
  const label = formatHomeButtonLabel("moderation", channel({ id: 2, title: "ДРУГАЯ ГРУППА" }));
  assert.equal(parseHomeKeyboardPress(label, [ch]), null);
});

test("two channels with the SAME title: matches the first one in the given order rather than failing outright", () => {
  const first = channel({ id: 1, title: "ОБСУЖДЕНИЯ" });
  const second = channel({ id: 2, title: "ОБСУЖДЕНИЯ" });
  const label = formatHomeButtonLabel("streamers", first); // same text for both, since titles match
  const result = parseHomeKeyboardPress(label, [first, second]);
  assert.deepEqual(result, { kind: "section", section: "streamers", channelId: 1 });
});

test("a button label for one section never parses as a different section (icons/text must not cross-match)", () => {
  const ch = channel({ id: 7, title: "CLUB WARZONE" });
  const channelLabel = formatHomeButtonLabel("channel", ch);
  const parsed = parseHomeKeyboardPress(channelLabel, [ch]);
  assert.ok(parsed && parsed.kind === "section");
  assert.equal(parsed.section, "channel");
  assert.notEqual(parsed.section, "streamers");
});

test("a channel title containing brackets or emoji doesn't break parsing (titles are free text, not a mini-syntax)", () => {
  const ch = channel({ id: 3, title: "[VIP] 🔥 Моя группа #1" });
  const label = formatHomeButtonLabel("moderation", ch);
  assert.deepEqual(parseHomeKeyboardPress(label, [ch]), { kind: "section", section: "moderation", channelId: 3 });
});

// ---------------------------------------------------------------------------
// formatChannelChoiceButtonLabel / parseChannelChoicePress
// ---------------------------------------------------------------------------

test("formatChannelChoiceButtonLabel + parseChannelChoicePress round-trip for a channel with a title", () => {
  const ch = channel({ id: 5, title: "CLUB WARZONE" });
  const label = formatChannelChoiceButtonLabel(ch);
  assert.equal(label, "CLUB WARZONE");
  assert.equal(parseChannelChoicePress(label, [ch]), 5);
});

test("parseChannelChoicePress returns null for text that matches no known channel", () => {
  const ch = channel({ id: 1, title: "ОБСУЖДЕНИЯ" });
  assert.equal(parseChannelChoicePress("СОВСЕМ ДРУГОЕ НАЗВАНИЕ", [ch]), null);
});

test("parseChannelChoicePress matches the first channel when two share the same title", () => {
  const first = channel({ id: 1, title: "ОБСУЖДЕНИЯ" });
  const second = channel({ id: 2, title: "ОБСУЖДЕНИЯ" });
  assert.equal(parseChannelChoicePress("ОБСУЖДЕНИЯ", [first, second]), 1);
});
