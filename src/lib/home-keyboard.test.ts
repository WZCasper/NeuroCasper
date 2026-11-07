import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatHomeButtonLabel,
  HOME_MENU_BUTTON_LABEL,
  parseHomeKeyboardPress,
  type HomeSection,
} from "./home-keyboard.js";

const ALL_SECTIONS: HomeSection[] = ["channel", "streamers", "moderation"];

test("formatHomeButtonLabel + parseHomeKeyboardPress round-trip for every section and a realistic channel id", () => {
  for (const section of ALL_SECTIONS) {
    const label = formatHomeButtonLabel(section, 42);
    assert.deepEqual(parseHomeKeyboardPress(label), { kind: "section", section, channelId: 42 });
  }
});

test("the home menu button parses to {kind: 'menu'} with no channel id at all", () => {
  assert.deepEqual(parseHomeKeyboardPress(HOME_MENU_BUTTON_LABEL), { kind: "menu" });
});

test("an ordinary chat message the user typed themselves does not accidentally parse as a button press", () => {
  assert.equal(parseHomeKeyboardPress("привет"), null);
  assert.equal(parseHomeKeyboardPress("👥 Модерация"), null); // похоже, но без [id] — не настоящая кнопка
  assert.equal(parseHomeKeyboardPress("👥 Модерация []"), null); // пустые скобки — не число
});

test("a non-numeric or malformed id inside the brackets is rejected, not silently coerced to 0 or NaN", () => {
  assert.equal(parseHomeKeyboardPress("⚙️ Канал [ ]"), null); // Number(' ') === 0 -- must NOT match
  assert.equal(parseHomeKeyboardPress("⚙️ Канал [abc]"), null);
  assert.equal(parseHomeKeyboardPress("⚙️ Канал [4.5]"), null); // не целое
  assert.equal(parseHomeKeyboardPress("⚙️ Канал [-1]"), null); // отрицательное -- не бывает id канала
});

test("formatHomeButtonLabel for different channel ids produces visibly different button text", () => {
  assert.notEqual(formatHomeButtonLabel("moderation", 1), formatHomeButtonLabel("moderation", 2));
});

test("a button label for one section never parses as a different section (icons/text must not cross-match)", () => {
  const channelLabel = formatHomeButtonLabel("channel", 7);
  const parsed = parseHomeKeyboardPress(channelLabel);
  assert.ok(parsed && parsed.kind === "section");
  assert.equal(parsed.section, "channel");
  assert.notEqual(parsed.section, "streamers");
});
