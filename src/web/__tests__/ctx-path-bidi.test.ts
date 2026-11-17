// The "CLAUDE.md files in scope" list got its left-side ellipsis from
// `direction: rtl`, the usual trick for keeping the end of a path readable.
// The usual bug came with it: in an RTL paragraph the leading '/' of a POSIX
// path is a bidi-neutral sitting at the boundary, so the bidi algorithm hands
// it the paragraph's level and reorders it to the far end —
// /Users/consultant/project/CLAUDE.md drew as Users/consultant/project/CLAUDE.md/
// on every mac and Linux box, and correctly on Windows, where the drive letter
// gives the line a strong-LTR first character.
//
// CHANGED ON PURPOSE: the head was cut in TypeScript (truncatePathStart) to a
// character budget; the list now draws each path with PathText, read from the
// session's folder or from "~", and CSS cuts its middle, keeping the file and
// the folder above it (every file here has one name). These pin that the drawn
// text is still the path in order, left to right, and pin the CSS rule against
// the trick coming back. path-display.test.ts pins the display itself.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PathText from "../components/PathText";
import { displayPath } from "../path-display";
import { sheetText } from "./sheet-source";

const POSIX = "/opt/consultant/Desktop/agents-deck/src/web/components/CLAUDE.md";
const WINDOWS = "D:\\consultant\\Desktop\\agents-deck\\src\\web\\CLAUDE.md";

/** A memory row as ContextView draws it, and the text it shows, in order. */
const row = (path: string, cwd?: string) => renderToStaticMarkup(createElement(PathText, { className: "ctx-md-path", path, cwd, keep: 2 }));
const shown = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

describe("a memory file's path", () => {
  it("keeps the leading slash of a POSIX path at the front, never at the end", () => {
    const text = shown(row("/opt/c/CLAUDE.md"));
    expect(text.startsWith("/")).toBe(true);
    expect(text.endsWith("/")).toBe(false);
    expect(shown(row(POSIX)).endsWith("/")).toBe(false);
  });

  it("is drawn left to right whatever the language around it", () => {
    expect(row(POSIX)).toMatch(/^<span class="path-text ctx-md-path" dir="ltr"/);
  });

  it("keeps the file and the folder above it whole, because every file here is CLAUDE.md", () => {
    expect(row(POSIX)).toContain('<span class="path-tail">/components/CLAUDE.md</span>');
    expect(row(WINDOWS)).toContain('<span class="path-tail">\\web\\CLAUDE.md</span>');
  });

  it("renders the path it shows and nothing else, no character moved", () => {
    const paths = [POSIX, WINDOWS, "/CLAUDE.md", "/" + "d/".repeat(60) + "CLAUDE.md",
                   "/home/x/" + "n".repeat(90) + "/CLAUDE.md", "relative/CLAUDE.md"];
    for (const p of paths) {
      const text = shown(row(p, "/home/x/work"));
      expect(text).toBe(displayPath(p, "/home/x/work"));
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("puts the whole path in the hover", () => {
    expect(row(POSIX)).toContain(`title="${POSIX}"`);
  });
});

describe(".ctx-md-path", () => {
  it("sets no direction, so the paragraph stays LTR and the path stays in order", () => {
    const css = sheetText();
    const rule = /\.ctx-md-path\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).not.toMatch(/(^|[^-])direction\s*:/);
    // The ellipsis stays: it is the backstop where the row is not PathText's flex box.
    expect(rule![1]).toMatch(/text-overflow\s*:\s*ellipsis/);
  });
});
