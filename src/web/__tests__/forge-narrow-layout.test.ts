// How the GitHub and GitLab panel lays itself out when it is narrow: a phone,
// or the list column beside an open item. These are rules the browser applies
// by the list's or the page's own width (container queries), so they are read
// from the panel's stylesheets; the browser checks of the same screens are in
// the QA runs, which a unit suite cannot draw.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sheet = (name: string) =>
  readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The bodies of every block opened by exactly `prelude` (an at-rule). */
function blocks(src: string, prelude: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(`${prelude} {`, from);
    if (at < 0) return out;
    let i = src.indexOf("{", at);
    const start = i + 1;
    for (let depth = 0; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(start, i));
    from = i;
  }
}

/** Every declaration the plain rules in `body` give `selector`, joined. */
function decls(body: string, selector: string): string {
  return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(",").map(s => s.trim()).includes(selector))
    .map(m => m[2].trim())
    .join("; ");
}

/** `src` with every at-rule block taken out: the rules that always apply. */
function topLevel(src: string): string {
  let out = src;
  for (;;) {
    const at = out.search(/@[a-z-]+[^{;]*\{/);
    if (at < 0) return out;
    let i = out.indexOf("{", at);
    for (let depth = 0; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}" && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(i + 1);
  }
}

const lists = sheet("forge-lists.css");
const SR_HIDDEN = /position: absolute;.*clip: rect\(0 0 0 0\)/;

describe("a narrow list's rows", () => {
  const narrow = blocks(lists, "@container fgl (max-width: 520px)").join("\n");

  it("wraps a row's facts inside their column rather than under the time beside them", () => {
    // The facts (pipeline, Approved, reviewers, comments) share a line with
    // the time; a column that cannot hold them wraps them, never overlaps.
    expect(decls(narrow, ".fg-row.fgl-row")).toContain('"side when"');
    expect(decls(narrow, ".fgl-row > .fgl-side")).toMatch(/flex-wrap: wrap/);
    expect(decls(topLevel(lists), ".fgl-side")).toMatch(/min-width: 0/);
  });

  it("keeps the time's verb for a screen reader only once the list is phone-narrow", () => {
    expect(decls(blocks(lists, "@container fgl (max-width: 300px)").join("\n"), ".fgl-row .fgl-when-verb")).toMatch(SR_HIDDEN);
    // A pipeline's status line has less room, so its verbs go from a phone's width.
    expect(decls(blocks(lists, "@container fgl (max-width: 360px)").join("\n"), ".fgl-pipeline .fgl-when-verb")).toMatch(SR_HIDDEN);
  });
});

const detail = sheet("forge-detail.css");
const panel = sheet("forge-panel.css");

describe("a phone's first screen goes to the list", () => {
  it("keeps a narrow list's filters on one row: the scope as a menu button, the sort as its glyph", () => {
    const narrow = blocks(lists, "@container fgl (max-width: 520px)").join("\n");
    // The menu button is drawn always and shown only on a narrow list…
    expect(decls(topLevel(lists), ".fgl-scope")).toMatch(/display: none/);
    expect(decls(narrow, ".fgl-scope")).toMatch(/display: inline-flex/);
    // …where the strip it stands for, and the sort's word, are not.
    expect(decls(narrow, ".fgl-scope-seg")).toMatch(/display: none/);
    expect(decls(narrow, ".fgl-sort-word")).toMatch(/display: none/);
  });

  it("keeps the four tabs on one row that scrolls, never a grid of two rows", () => {
    const narrow = blocks(panel, "@container fg-list (max-width: 520px)").join("\n");
    expect(decls(narrow, ".fg-tabs")).not.toMatch(/display: grid/);
    expect(decls(narrow, ".fg-tabs .uh-range-btn")).toMatch(/flex: 1 0 auto/);
    expect(decls(narrow, ".fg-tabs .uh-range-btn")).not.toMatch(/white-space: normal/);
    expect(panel).not.toMatch(/\.fg-tabs\s*\{[^}]*grid-template-columns/);
  });

  it("keeps a change's sections on one row on a phone's pane, each label whole over its count", () => {
    const narrow = blocks(detail, "@container fd (max-width: 479px)").join("\n");
    expect(decls(narrow, ".fd-sections")).not.toMatch(/display: grid/);
    expect(decls(narrow, ".fd-sections .uh-range-btn")).toMatch(/flex: 1 0 auto;.*flex-direction: column/);
    expect(decls(narrow, ".fd-sections .uh-range-btn")).not.toMatch(/white-space: normal/);
    expect(detail).not.toMatch(/\.fd-sections\s*\{[^}]*grid-template-columns/);
  });
});

describe("an item page's top line", () => {
  it("is the integrations' shared bar, spanning exactly the page's own side padding at every width", () => {
    // The bar (IntegrationDetailBar) runs edge to edge by --ig-detail-pad; a
    // page that pads otherwise than it says would leave the bar short or over.
    const side = (body: string) => /(?:^|; )padding: \S+ (\d+px)/.exec(decls(body, ".fd"))?.[1];
    const wide = topLevel(detail);
    expect(side(wide)).toBe("20px");
    expect(decls(wide, ".fd")).toContain(`--ig-detail-pad: ${side(wide)}`);
    const phone = blocks(detail, "@media (max-width: 640px)").join("\n");
    expect(side(phone)).toBe("16px");
    expect(decls(phone, ".fd")).toContain(`--ig-detail-pad: ${side(phone)}`);
    // No bar of the panel's own is left beside it.
    expect(detail).not.toMatch(/\.fd-(?:bar|ref|close)\b/);
  });
});

describe("a selected row", () => {
  it("is not the hover: the panel's own fill answers the pointer only, the host's rule the selection", () => {
    // A list row is the integrations' shared row (ig-row in integrations.css),
    // whose selection is a fill of its own and whose words all go to --text.
    expect(decls(topLevel(panel), ".fg-row:hover")).toMatch(/background: var\(--ctl-fill\)/);
    expect(panel).not.toMatch(/\.fg-row\[data-selected\]\s*[,{][^}]*background/);
    expect(lists).not.toMatch(/\.fgl-branch\[data-selected\]\s*[,{][^}]*background/);
  });

  it("keeps a badge's word in the row's ink and its mark in the state's colour", () => {
    expect(decls(panel, ".ig-row[data-selected] .fg-badge")).toMatch(/color: var\(--ig-sel-ink, var\(--text\)\)/);
    expect(decls(panel, ".ig-row[data-selected] .fg-badge[data-tone=bad] > [aria-hidden]")).toMatch(/color: var\(--err\)/);
  });

  it("draws a branch's Create link in the row's ink, underlined, since the accent is under AA on the selection", () => {
    expect(decls(lists, ".ig-row[data-selected] .fgl-create")).toMatch(/color: var\(--ig-sel-ink, var\(--text\)\);.*text-decoration: underline/);
  });
});

describe("a job's log", () => {
  it("never wraps a line, so a line number stays beside its line; it scrolls sideways instead", () => {
    expect(decls(detail, ".fd-log")).toMatch(/overflow: auto/);
    expect(decls(detail, ".fd-log")).toMatch(/white-space: pre;/);
    expect(decls(detail, ".fd-log")).not.toMatch(/overflow-wrap: anywhere/);
  });
});

describe("a row's press", () => {
  it("deepens the row's tone and moves nothing, a list row and a branch row alike", () => {
    expect(panel).not.toMatch(/\.fg-row:active\s*\{[^}]*transform/);
    expect(decls(topLevel(panel), ".fg-row")).not.toMatch(/transform/);
    expect(decls(topLevel(panel), ".fg-rows .fg-row:active")).toMatch(/background: color-mix\(in srgb, var\(--text\) 10%, transparent\)/);
    expect(decls(topLevel(lists), ".fg-rows > li.fgl-branch:has(> .fgl-hit:active)")).toMatch(/background: color-mix\(in srgb, var\(--text\) 10%, transparent\)/);
  });
});

describe("words an item page draws on a filled bed", () => {
  it("lifts the quiet tier a step on a thread's head and a hovered file, where --muted is under AA", () => {
    expect(decls(detail, ".fd-thread-head")).toMatch(/background: var\(--ctl-fill\);.*--muted: var\(--text-secondary\)/);
    expect(decls(detail, "a.fd-file:hover")).toMatch(/background: var\(--ctl-fill\);.*--muted: var\(--text-secondary\)/);
    expect(decls(detail, ".fd-path-dir")).toMatch(/color: var\(--muted\)/);
  });

  it("underlines a link inside a title, which its colour alone does not tell from the words around it", () => {
    expect(decls(detail, ".fd-title a")).toMatch(/text-decoration: underline/);
  });

  it("underlines a link inside the token help's sentences, for the same reason", () => {
    expect(decls(topLevel(panel), ".fg-token-link")).toMatch(/text-decoration: underline/);
  });
});

describe("choosing a tab or a section", () => {
  const reduced = (src: string) => blocks(src, "@media (prefers-reduced-motion: reduce)").join("\n");

  it("fades the chosen one's content in over 100ms, moving nothing", () => {
    expect(decls(topLevel(panel), ".fg-tab-body:not([hidden])")).toBe("animation: fadeIn 100ms ease-out;");
    expect(decls(topLevel(detail), ".fd-section:not([hidden])")).toBe("animation: fadeIn 100ms ease-out;");
  });

  it("does not fade at all under reduced motion", () => {
    expect(decls(reduced(panel), ".fg-tab-body:not([hidden])")).toBe("animation: none;");
    expect(decls(reduced(detail), ".fd-section:not([hidden])")).toBe("animation: none;");
  });
});
