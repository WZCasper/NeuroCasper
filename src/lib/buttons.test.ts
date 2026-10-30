import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKeyboard, PLATFORM_LABELS } from "./buttons.js";

/** buildKeyboard puts exactly one button per row (see its own comment on
 * why -- .row() is only ever called BETWEEN buttons, never after the
 * last one), so flattening row-by-row and dropping any empty rows found
 * along the way is exactly equivalent to asserting there are none: an
 * empty row would show up here as a missing button at that position,
 * which every test below would then catch as a mismatched button list.
 * This file used to work around a real bug where buildKeyboard left a
 * trailing empty row after the last button on every call -- .flat()
 * silently absorbing that empty row was what let it go unnoticed; the
 * explicit no-empty-rows test lower down in this file exists so a
 * regression like that can't hide the same way again. */
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

// ---------------------------------------------------------------------------
// Regression: buildKeyboard used to leave one trailing empty row after the
// last button on every call (InlineKeyboard.row() always starts a new row
// regardless of whether the current one has anything in it, and nothing
// stopped it from being called one time too many after the final button --
// see buildKeyboard's own comment). Harmless to how Telegram renders the
// keyboard (it just doesn't draw an empty row), but a real defect in the
// data this function produced on every single call, so it's worth its own
// explicit, un-maskable check rather than only being implied by the tests
// above happening to still pass.
// ---------------------------------------------------------------------------

test("buildKeyboard never produces an empty row, with one platform and no extra links", () => {
  const kb = buildKeyboard([{ platform: "kick", url: "https://kick.example/1" }]);
  assert.deepEqual(
    kb.inline_keyboard.map((row) => row.length),
    [1],
  );
});

test("buildKeyboard never produces an empty row, with several platforms and several extra links", () => {
  const kb = buildKeyboard(
    [
      { platform: "kick", url: "https://kick.example/1" },
      { platform: "youtube", url: "https://youtube.example/1" },
      { platform: "tiktok", url: "https://tiktok.example/1" },
    ],
    [
      { label: "Twitch", url: "https://twitch.example/1" },
      { label: "Discord", url: "https://discord.example/1" },
    ],
  );
  // Every row has exactly one button -- buildKeyboard's whole contract is
  // one button per row -- and critically, there are exactly as many rows
  // as buttons: no extra trailing row.
  assert.deepEqual(
    kb.inline_keyboard.map((row) => row.length),
    [1, 1, 1, 1, 1],
  );
});

test("buildKeyboard with absolutely nothing to show produces a genuinely empty keyboard, not one empty row", () => {
  const kb = buildKeyboard([], []);
  assert.deepEqual(kb.inline_keyboard, []);
});
