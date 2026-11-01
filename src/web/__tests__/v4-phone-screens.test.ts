// The phone at 640 and under, as LAYOUT: the drawer full width, the rail's rows
// 62 high, the Term takeover's header and note, and the words for a dropped
// connection. Every rule this phase added sits inside @media (max-width: 640px),
// so the desktop (641 and up) is the sheet it was: the phone declarations are held
// inside the query by name, and none of them is in the desktop part of its sheet.
//
// Not built here, and held not built: the Term key row (a new input path), the
// Machine tab's online dot, the push note, the rail's usage meter. What opens at
// load is phone-load.ts's, untouched.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ConnectionBanner, { UNREACHABLE_SUB, UNREACHABLE_TITLE } from "../components/ConnectionBanner";
import { PHONE_QUERY } from "../components/EdgeRails";
import { words } from "./screens-fixtures";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const PHONE = "@media (max-width: 640px) {";

/** The [start, end) of every top-level block opened by `header`, braces matched. */
function blocksOf(css: string, header: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = css.indexOf(header); at >= 0; at = css.indexOf(header, at + 1)) {
    let depth = 0;
    for (let i = at + header.length - 1; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { out.push([at, i + 1]); break; }
    }
  }
  return out;
}
/** A sheet less its phone blocks: what the desktop is. */
function desktopPart(css: string): string {
  let out = css;
  for (const [a, b] of blocksOf(css, PHONE).reverse()) out = out.slice(0, a) + out.slice(b);
  return out;
}

describe("the phone is 640 and under", () => {
  it("is the query the deck already uses", () => {
    expect(PHONE_QUERY).toBe("(max-width: 640px)");
  });
});

describe("every rule this phase added sits inside the phone query", () => {
  const added: Array<[string, RegExp]> = [
    ["styles/search-and-banners.css", /conn-banner-phone|conn-phone-|conn-unreachable/g],
    ["styles/stage-shell.css", /\[data-takeover\] \.ts-(?:head|bar)/g],
  ];
  for (const [path, needle] of added) {
    it(`${path}: ${needle.source}`, () => {
      const css = read(path).replace(/\/\*[\s\S]*?\*\//g, "");
      const inside = blocksOf(css, PHONE);
      const hits = [...css.matchAll(needle)].map(m => m.index!);
      expect(hits.length).toBeGreaterThan(0);
      for (const at of hits) expect(inside.some(([a, b]) => at > a && at < b), `${path} @${at}`).toBe(true);
    });
  }

  it("the drawer's full width is in left-column.css's phone block", () => {
    const css = read("styles/left-column.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const block = css.slice(...blocksOf(css, PHONE)[0]);
    expect(block).toContain(".left-column:not(.closing) { width: 100vw; }");
    expect(block).toMatch(/\.left-column > \.session-list,\s*\.left-column > \.accounts-panel \{ width: 100%; \}/);
  });

  it("each phone declaration is held inside a phone block and appears nowhere in the desktop part", () => {
    // By name, not by digest: a digest of the whole desktop sheet had to be re-pinned by
    // every unrelated desktop change. A phone rule that slips out of the 640 query
    // is found in the desktop part; one that is dropped is not found in a phone block.
    // Whitespace is dropped on both sides, so a reflow of a rule is not a change.
    const squash = (css: string) => css.replace(/\s+/g, "");
    const phoneDecls: Record<string, string[]> = {
      "styles/session-list.css": [
        ".session-list .sl-usage-btn { min-height: 44px; }",
        ".session-list .sl-row { min-height: 62px; }",
        ".session-list .sl-more, .session-list .sl-fold-btn { min-height: 44px; }",
        ".session-list .sl-close { min-width: 44px; min-height: 44px; }",
      ],
      "styles/left-column.css": [
        ".left-column:not(.closing) { width: 100vw; }",
        ".left-column > .session-list, .left-column > .accounts-panel { width: 100%; }",
      ],
      "styles/search-and-banners.css": [
        ".conn-banner-phone {",
        ".conn-banner-phone .conn-unreachable {",
      ],
      "styles/stage-shell.css": [
        ".ts-stage[data-takeover] .ts-head { height: 56px; }",
        ".ts-stage[data-takeover] .ts-head > .glyph-btn { width: 32px; height: 44px; }",
        ".ts-stage[data-takeover] .ts-bar { height: auto; min-height: 52px;",
      ],
    };
    for (const [path, decls] of Object.entries(phoneDecls)) {
      const css = read(path).replace(/\/\*[\s\S]*?\*\//g, "");
      const phone = squash(blocksOf(css, PHONE).map(([a, b]) => css.slice(a, b)).join(""));
      const desktop = squash(desktopPart(css));
      for (const d of decls) {
        expect(phone, `${path}: ${d} is in a phone block`).toContain(squash(d));
        expect(desktop, `${path}: ${d} is not in the desktop part`).not.toContain(squash(d));
      }
    }
  });
});

describe("the rail on a phone", () => {
  it("makes a session row 62 high at 640 and under, inside the phone query", () => {
    const css = read("styles/session-list.css");
    const phone = css.slice(...blocksOf(css, PHONE)[0]);
    expect(phone).toContain(".session-list .sl-row { min-height: 62px; }");
  });

  it("keeps the other touch targets at 44, inside the phone query", () => {
    const css = read("styles/session-list.css");
    const phone = css.slice(...blocksOf(css, PHONE)[0]);
    expect(phone).toContain(".session-list .sl-more, .session-list .sl-fold-btn { min-height: 44px; }");
    expect(phone).toContain(".session-list .sl-close { min-width: 44px; min-height: 44px; }");
  });
});

describe("the Term takeover", () => {
  const css = read("styles/stage-shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const phone = css.slice(...blocksOf(css, PHONE)[0]);

  it("has a header 56 high with a back button 32 by 44, and a note at least 52 high", () => {
    expect(phone).toContain(".ts-stage[data-takeover] .ts-head { height: 56px; }");
    expect(phone).toContain(".ts-stage[data-takeover] .ts-head > .glyph-btn { width: 32px; height: 44px; }");
    expect(phone).toMatch(/\.ts-stage\[data-takeover\] \.ts-bar \{ height: auto; min-height: 52px;/);
  });

  it("draws no key row and no machine dot: no new input path, no data that does not exist", () => {
    const stage = read("components/terminal/KeysBar.tsx") + read("components/terminal/StageHeader.tsx");
    expect(stage).not.toMatch(/key-row|keyrow|onKey\b|Ctrl\+C/);
    expect(read("components/EdgeRails.tsx")).not.toMatch(/machine-dot|online/i);
  });
});

describe("the banner for a dropped connection", () => {
  const banner = (over: Partial<Parameters<typeof ConnectionBanner>[0]> = {}) =>
    renderToStaticMarkup(createElement(ConnectionBanner, { restarting: false, restartMode: undefined as never, live: false, paused: false, ...over }));

  it("says it in the phone's words at phone width, with the curly apostrophe", () => {
    const out = banner({ phone: true });
    expect(out).toContain('class="conn-banner conn-banner-phone" role="alert"');
    expect(words(out)).toContain("Can’t reach your computer");
    expect(UNREACHABLE_TITLE).toBe("Can’t reach your computer");
    expect(words(out)).toContain(UNREACHABLE_SUB);
    expect(words(out)).toContain("Agents may still be running");
  });

  it("names no time of last news: the deck keeps none to say", () => {
    expect(words(banner({ phone: true }))).not.toMatch(/last news|\d{1,2}:\d{2}/i);
  });

  it("is the markup it was at desktop width, whether the prop is left out or false", () => {
    const desktop = banner();
    expect(banner({ phone: false })).toBe(desktop);
    expect(desktop).toContain('class="conn-banner" role="alert"');
    expect(words(desktop)).toContain("Lost connection to the");
    expect(desktop).not.toMatch(/conn-banner-phone|Can.t reach/);
  });

  it("keeps a restart the deck asked for in its own sentence at phone width", () => {
    const out = banner({ phone: true, restarting: true, restartMode: "npx" as never });
    expect(words(out)).toContain("Fetching the new version with npx");
    expect(out).not.toContain("conn-banner-phone");
  });

  it("is an alert, and the phone's strip is a card in the sheet's tokens", () => {
    const css = read("styles/search-and-banners.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const block = css.slice(...blocksOf(css, PHONE)[0]);
    expect(block).toContain("background: var(--bg-soft);");
    expect(block).toContain("border: 1px solid var(--line);");
    expect(block).toContain("border-radius: var(--r-panel);");
    expect(block).toContain("padding: 12px;");
  });
});

describe("what opens at load is not touched", () => {
  it("phone-load.ts does not mention the screens or the flags", () => {
    expect(read("phone-load.ts")).not.toMatch(/chat|decision|screens/i);
  });
});
