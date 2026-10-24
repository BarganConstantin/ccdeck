// One weight for every glyph in the stage's terminal (terminal-stage.css).
// xterm's WebGL renderer draws each glyph once, into a scratch canvas, and
// keeps it. While idle it draws the ASCII set with that canvas outside the
// page; a glyph a frame needs before then is drawn with the canvas inside the
// terminal's element, where the deck's antialiased smoothing (tokens.css)
// reaches it. On a Mac those are two weights, and a reopened pane, whose
// screen arrives before the idle drawing is done, mixed them within a line.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the stage terminal's glyph weight", () => {
  it("keeps the browser's own smoothing in the terminal, past the deck's antialiased", () => {
    expect(read("../styles/tokens.css"), "the smoothing it answers is still the deck's").toMatch(
      /html, body, #root \{[^}]*-webkit-font-smoothing: antialiased;/,
    );
    expect(read("../styles/terminal-stage.css")).toContain(".ts-host .xterm { -webkit-font-smoothing: auto; }");
  });

  it("answers xterm's atlas as it is: idle draws outside the page, draws on demand inside the terminal", () => {
    const atlas = read("../../../node_modules/@xterm/addon-webgl/src/TextureAtlas.ts");
    expect(atlas, "the idle warm-up draws with no element to sit in").toContain(
      "this._drawToCache(i, DEFAULT_COLOR, DEFAULT_COLOR, DEFAULT_EXT, false, undefined)",
    );
    expect(atlas, "a draw given an element puts the scratch canvas in it").toMatch(
      /if \(domContainer && this\._tmpCanvas\.parentElement !== domContainer\) \{[^}]*domContainer\.append\(this\._tmpCanvas\);/,
    );
    const renderer = read("../../../node_modules/@xterm/addon-webgl/src/GlyphRenderer.ts");
    expect(renderer, "and a frame's draw gives it the terminal's element").toContain(
      "this._atlas.getRasterizedGlyph(code, bg, fg, ext, false, this._terminal.element)",
    );
  });
});
