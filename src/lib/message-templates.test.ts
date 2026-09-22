import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TEMPLATE, renderTemplate } from "./message-templates.js";

test("renderTemplate replaces known placeholders", () => {
  const out = renderTemplate("{streamer} is playing {game}: {title}", {
    streamer: "Alex",
    platform: "youtube",
    title: "Ranked grind",
    game: "Chess",
    link: "",
  });
  assert.equal(out, "Alex is playing Chess: Ranked grind");
});

test("renderTemplate leaves unknown placeholders untouched instead of deleting them", () => {
  const out = renderTemplate("{streamer} — {notaplaceholder}", {
    streamer: "Alex",
    platform: "",
    title: "",
    game: "",
    link: "",
  });
  assert.equal(out, "Alex — {notaplaceholder}");
});

test("renderTemplate replaces every occurrence of a repeated placeholder", () => {
  const out = renderTemplate("{title}! Again: {title}!", {
    streamer: "",
    platform: "",
    title: "Live now",
    game: "",
    link: "",
  });
  assert.equal(out, "Live now! Again: Live now!");
});

test("renderTemplate on a template with no placeholders returns it unchanged", () => {
  const out = renderTemplate("Static text, no vars here", {
    streamer: "Alex",
    platform: "",
    title: "",
    game: "",
    link: "",
  });
  assert.equal(out, "Static text, no vars here");
});

test("DEFAULT_TEMPLATE renders to just the title", () => {
  const out = renderTemplate(DEFAULT_TEMPLATE, {
    streamer: "Alex",
    platform: "",
    title: "Ranked grind",
    game: "",
    link: "",
  });
  assert.equal(out, "Ranked grind");
});
