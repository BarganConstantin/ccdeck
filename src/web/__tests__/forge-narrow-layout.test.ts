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
  // CHANGED ON PURPOSE (V4's Figma): the list beside an open item is 480 wide, and Figma's rows
  // (a PR's two lines, a branch's one line or two) fit there, so the rows fold to their
  // phone shape at 440 rather than 520. The filters and the tabs keep their own breakpoints.
  const narrow = blocks(lists, "@container fgl (max-width: 440px)").join("\n");

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

describe("a list beside an open item", () => {
  // The list column beside an open item is 441 to 640 wide.
  const beside = blocks(lists, "@container fgl (min-width: 441px) and (max-width: 640px)").join("\n");

  it("gives a pull request's or an issue's title the whole first line, and the meta, the time and the facts the second", () => {
    expect(decls(beside, ".fg-row.fgl-row")).toContain('grid-template-areas: "title title" "line side"');
    expect(decls(beside, ".fgl-row > .fgl-title")).toMatch(/white-space: nowrap/);
    // The meta and the time are one line there, the time at its end; on a
    // wide list and a phone they are cells of the row's grid.
    expect(decls(topLevel(lists), ".fgl-row > .fgl-line")).toBe("display: contents;");
    expect(decls(beside, ".fgl-row > .fgl-line")).toMatch(/grid-area: line; display: flex;/);
    expect(decls(beside, ".fgl-line > .fgl-when")).toMatch(/flex: none/);
    // The facts' chips are taller than the line and lend it 2px each way, so the row stays 44.
    expect(decls(beside, ".fgl-row > .fgl-side")).toMatch(/margin-block: -2px/);
  });

  it("lays a pipeline out on its own areas, so its state never sits on its duration", () => {
    // The rule for every row matches a pipeline's too; the pipeline's own,
    // after it, gives each of its pieces a cell.
    const pipe = decls(beside, ".fg-row.fgl-pipeline");
    expect(pipe).toContain('grid-template-areas: "status title side" ". line side"');
    expect(pipe).toMatch(/grid-template-columns: 14px minmax\(0, 1fr\) auto/);
    expect(beside.indexOf(".fg-row.fgl-pipeline")).toBeGreaterThan(beside.indexOf(".fg-row.fgl-row"));
    // The state is its 14px glyph; its word is kept for a screen reader.
    expect(decls(beside, ".fgl-pipeline > .fgl-status .fg-glyph")).toMatch(/width: 14px; height: 14px/);
    expect(decls(beside, ".fgl-pipeline > .fgl-status .fg-mark-word")).toMatch(SR_HIDDEN);
    // How long it ran joins the meta line, and an empty one takes no room.
    expect(decls(beside, ".fgl-line > .fgl-duration:empty")).toMatch(/display: none/);
  });

  it("keeps a selected row's title at 400, as every other row's", () => {
    expect(panel).not.toMatch(/\.fg-row\[data-selected\] \.fg-row-title\s*\{[^}]*font-weight/);
  });

  it("keeps a branch's name on one line, cut with an ellipsis rather than broken inside", () => {
    expect(decls(topLevel(lists), ".fgl-branch-code")).toMatch(/white-space: nowrap; overflow: hidden; text-overflow: ellipsis/);
    expect(decls(topLevel(lists), ".fgl-branch-code")).not.toMatch(/overflow-wrap: anywhere/);
    // Up to 820 the name has the first line beside the counts alone.
    expect(decls(blocks(lists, "@container fgl (max-width: 820px)").join("\n"), ".fg-rows > li.fgl-branch"))
      .toContain('grid-template-areas: "name stats" "commit change"');
  });

  it("says how far a branch is from the default one on one line", () => {
    expect(decls(topLevel(detail), ".fd-fact dd.fd-diverge")).toMatch(/display: flex; flex-wrap: nowrap; white-space: nowrap/);
  });
});

describe("a phone's first screen goes to the list", () => {
  it("keeps a narrow list's filters on one row: the scope as a menu button, the sort as its glyph", () => {
    // CHANGED ON PURPOSE: the filters stand in the row over the search now,
    // outside the tab's own box, so they answer the list column's width.
    const narrow = blocks(lists, "@container fg-list (max-width: 520px)").join("\n");
    // The menu button is drawn always and shown only on a narrow list…
    expect(decls(topLevel(lists), ".fgl-scope")).toMatch(/display: none/);
    expect(decls(narrow, ".fgl-scope")).toMatch(/display: inline-flex/);
    // …where the strip it stands for, and the sort's word, are not.
    expect(decls(narrow, ".fgl-scope-seg")).toMatch(/display: none/);
    expect(decls(narrow, ".fgl-sort-word")).toMatch(/display: none/);
  });

  it("keeps the four tabs on one row that scrolls, never a grid of two rows", () => {
    // CHANGED ON PURPOSE: the toolbar spans the whole panel now, over the list
    // and the open item, so its tabs answer the panel's width, not the list's.
    const narrow = blocks(panel, "@container fg-panel (max-width: 440px)").join("\n");
    expect(decls(narrow, ".fg-tabs")).not.toMatch(/display: grid/);
    expect(decls(narrow, ".fg-tabs .uh-range-btn")).toMatch(/flex: 1 0 auto/);
    expect(decls(narrow, ".fg-tabs .uh-range-btn")).not.toMatch(/white-space: normal/);
    expect(panel).not.toMatch(/\.fg-tabs\s*\{[^}]*grid-template-columns/);
  });

  it("pads a narrow list's tabs tightly enough that all four fit a 360px phone", () => {
    // GitLab's four names need 288px at 4px a side, which a 360px phone's
    // list has; at 6px a side Issues ran past the edge there, and at 320px
    // it was out of sight altogether, not even a sliver to say it was there.
    const narrow = blocks(panel, "@container fg-panel (max-width: 440px)").join("\n");
    // CHANGED ON PURPOSE (V4's Figma): the tabs are 24px pills with no vertical padding, so the
    // same 4px a side is written as "0 4px".
    expect(decls(narrow, ".fg-tabs .uh-range-btn")).toMatch(/(?:^|; )padding: 0 4px;/);
  });

  it("keeps a change's sections on one row on a phone's pane, each label whole", () => {
    // CHANGED ON PURPOSE: the sections carry their names alone now (V4's
    // Figma), so there is no count to stack under a label; each pill shares
    // the row and centres its name.
    const narrow = blocks(detail, "@container fd (max-width: 479px)").join("\n");
    expect(decls(narrow, ".fd-sections")).not.toMatch(/display: grid/);
    expect(decls(narrow, ".fd-sections .uh-range-btn")).toMatch(/flex: 1 0 auto;.*justify-content: center/);
    expect(decls(narrow, ".fd-sections .uh-range-btn")).not.toMatch(/flex-direction: column/);
    expect(decls(narrow, ".fd-sections .uh-range-btn")).not.toMatch(/white-space: normal/);
    expect(detail).not.toMatch(/\.fd-sections\s*\{[^}]*grid-template-columns/);
  });

  it("wraps a change's sections on a pane too narrow for all four, rather than cutting the last label", () => {
    // A pane beside the list at 900px, or a 360px phone, has less room than
    // the four labels; the last one goes to a second row, whole.
    expect(decls(topLevel(detail), ".fd-sections")).toMatch(/flex-wrap: wrap/);
    expect(decls(topLevel(detail), ".fd-sections")).not.toMatch(/overflow-x: auto/);
  });
});

describe("the words kept for a screen reader", () => {
  it("are placed inside the scroller they belong to, so they never run on below the modal", () => {
    // .fg-sr and the shared .vis-hidden are absolutely placed; their box must
    // be the list's scroller or the page inside the detail's.
    expect(decls(topLevel(panel), ".fg-sr")).toMatch(/position: absolute/);
    expect(decls(topLevel(panel), ".fg-tab-body")).toMatch(/position: relative;.*overflow-y: auto/);
    expect(decls(topLevel(detail), ".fd")).toMatch(/^position: relative;/);
  });
});

describe("the toolbar on a phone", () => {
  it("keeps the freshness line's words, and lets the picker cut its own name instead", () => {
    expect(decls(topLevel(panel), ".fg-toolbar > .ig-freshness")).toMatch(/flex-shrink: 0;.*max-width: 60%/);
    expect(decls(topLevel(lists), "button.btn.fgl-repo-trigger")).toMatch(/min-width: 0/);
  });
});

describe("a scoped label on a row", () => {
  it("keeps its scope, up to 12ch, and cuts its value first", () => {
    expect(decls(topLevel(lists), ".fgl-label-scope")).toMatch(/flex: none; max-width: 12ch;/);
    expect(decls(topLevel(lists), ".fgl-label-name")).toMatch(/min-width: 0; overflow: hidden; text-overflow: ellipsis/);
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
    expect(decls(topLevel(panel), ".fg-row:hover")).toBe("");
    // The pointer's fill stands under the mouse query, and nowhere else.
    expect(decls(blocks(panel, "@media (hover: hover) and (pointer: fine)").join("\n"), ".fg-row:hover")).toMatch(/background: var\(--ctl-fill\)/);
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

describe("a state line on an item page", () => {
  it("keeps its mark beside its words when the words wrap, the mark on their first line", () => {
    // "Approved by" a long name used to drop the whole sentence under the
    // mark, leaving the mark alone on a line of its own.
    const led = ".fd-status-line:has(> .fg-mark:first-child)";
    expect(decls(topLevel(detail), led)).toMatch(/flex-wrap: nowrap; align-items: flex-start; line-height: 1.5;/);
    expect(decls(topLevel(detail), `${led} > :not(:first-child)`)).toMatch(/min-width: 0/);
    expect(decls(topLevel(detail), ".fd-status-line > .fg-mark:first-child")).toMatch(/flex: none; height: 1.5em;/);
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

  // V4's motion rules: tab content never animates. It used to fade in over
  // 100ms (fadeIn); it is shown at once now, so there is nothing for reduced
  // motion to take away either.
  it("shows the chosen one's content at once: tab content never animates", () => {
    expect(decls(topLevel(panel), ".fg-tab-body:not([hidden])")).toBe("");
    expect(decls(topLevel(detail), ".fd-section:not([hidden])")).toBe("");
    expect(panel).not.toMatch(/\.fg-tab-body[^{]*\{[^}]*animation/);
    expect(detail).not.toMatch(/\.fd-section[^{]*\{[^}]*animation/);
  });

  it("has no reduced-motion answer to give for it", () => {
    expect(decls(reduced(panel), ".fg-tab-body:not([hidden])")).toBe("");
    expect(decls(reduced(detail), ".fd-section:not([hidden])")).toBe("");
  });
});
