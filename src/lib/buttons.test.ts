import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKeyboard, PLATFORM_LABELS } from "./buttons.js";

/** InlineKeyboard.row() always leaves a trailing empty row after the last
 * button (see grammY's InlineKeyboard) -- flatten and drop empties so
 * assertions only deal with actual buttons, in order. */
function flatten(kb: ReturnType<typeof buildKeyboard>): Array<{ text: string; url: string }> {
  return kb.inline_keyboard.flat().map((btn) => {
    if (!("url" in btn)) throw new Error(`Expected a URL button, got: ${JSON.stringify(btn)}`);
    return { text: btn.text, url: btn.url };
  });
}

test("buildKeyboard renders one button per monitored platform with its label", () => {
  const kb = buildKeyboard([{ platform: "youtube", url: "https://youtube.com/watch?v=1" }]);
  const buttons = flatten(kb);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0]?.text, PLATFORM_LABELS.youtube);
  assert.equal(buttons[0]?.url, "https://youtube.com/watch?v=1");
});

test("buildKeyboard puts monitored platforms before extra links, each in given order", () => {
  const kb = buildKeyboard(
    [
      { platform: "youtube", url: "https://youtube.example/1" },
      { platform: "kick", url: "https://kick.example/1" },
    ],
    [{ label: "Discord", url: "https://discord.example/1" }],
  );
  const buttons = flatten(kb);
  assert.deepEqual(
    buttons.map((b) => b.text),
    [PLATFORM_LABELS.youtube, PLATFORM_LABELS.kick, "\u{1F4AC} Discord"],
  );
});

test("buildKeyboard styles known extra-link labels case-insensitively", () => {
  const kb = buildKeyboard([], [
    { label: "TWITCH", url: "https://twitch.tv/x" },
    { label: " twitter ", url: "https://x.com/x" },
  ]);
  const buttons = flatten(kb);
  assert.equal(buttons[0]?.text, "\u{1F7E3} Twitch");
  // "twitter" is trimmed and lowercased before lookup, and styled the same as "x".
  assert.equal(buttons[1]?.text, "⚫ X");
});

test("buildKeyboard falls back to a generic link icon for an unrecognized label", () => {
  const kb = buildKeyboard([], [{ label: "My Fan Page", url: "https://example.com/fans" }]);
  const buttons = flatten(kb);
  assert.equal(buttons[0]?.text, "\u{1F517} My Fan Page");
  assert.equal(buttons[0]?.url, "https://example.com/fans");
});

test("buildKeyboard with nothing to show produces no real buttons", () => {
  const kb = buildKeyboard([]);
  assert.equal(flatten(kb).length, 0);
});
