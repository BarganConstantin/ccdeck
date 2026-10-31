// One search field for every integration panel (#2178, #2179). Jira's stood at
// the deck's control height with a magnifier and a --muted placeholder that
// fell to 4.06:1 on its fill in Dark; the forges' was 32px, had no magnifier,
// and an Escape typed into it closed the whole modal instead of emptying it.
// IntegrationSearch is one field: this pins its markup, that Escape empties it
// first through the deck's dismiss stack (never a key listener of its own),
// and its sizes and inks in the sheet.
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationSearch from "../components/IntegrationSearch";
import { sheetText } from "./sheet-source";

const source = readFileSync(fileURLToPath(new URL("../components/IntegrationSearch.tsx", import.meta.url)), "utf8");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const render = (value: string) => renderToStaticMarkup(createElement(IntegrationSearch, {
  value, onChange: () => {}, label: "Search issues by key or summary", placeholder: "Search key or summary",
}));
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
};

describe("the integrations' search field", () => {
  it("is named by its label, with the magnifier hidden and the placeholder only a hint", () => {
    const html = render("");
    expect(html).toMatch(/^<div class="ig-search"><svg [^>]*aria-hidden="true"/);
    expect(html).toMatch(/<input type="search" class="ig-search-input" aria-label="Search issues by key or summary" placeholder="Search key or summary" value=""\/>/);
    expect(html).not.toMatch(/ig-search-clear/);
    // Not a <label> around the field: Clear is a button, and a label may not hold one.
    expect(html).not.toMatch(/<label/);
  });

  it("offers Clear inside its end once there is something to clear", () => {
    const html = render("PROJ-12");
    expect(html).toMatch(/<div class="ig-search" data-filled="true">/);
    expect(html).toMatch(/<button type="button" class="glyph-btn ig-search-clear" aria-label="Clear the search" title="Clear">/);
  });

  it("empties on Escape before anything closes, through the dismiss stack while it has focus and text", () => {
    expect(source).toMatch(/const clearing = focused && value !== "";/);
    expect(source).toMatch(/modalStack\.push\(\(\) => onChangeRef\.current\(""\), 0, "popover"\)/);
    expect(source).not.toMatch(/["']Escape["']/);
  });

  it("stands at the deck's control height with an AA placeholder, and one clear mark", () => {
    expect(rule(".ig-search-input")).toMatch(/min-height:\s*var\(--ctl-h\)/);
    // V4's field: --muted is 4.91:1 or more on --bg-soft.
    expect(rule(".ig-search-input::placeholder")).toMatch(/color:\s*var\(--muted\)/);
    expect(rule(".ig-search-input::-webkit-search-cancel-button")).toMatch(/display:\s*none/);
    expect(rule(".ig-search")).toMatch(/min-width:\s*0/);
  });
});
