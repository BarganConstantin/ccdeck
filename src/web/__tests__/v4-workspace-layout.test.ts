// V4 Workspace: the layout. The columns are the Board's grid with the detail
// panel open; the pane is the stage dock filling the canvas's cell; Zoom folds
// the list and the Inspector; Usage and Machine float over the Inspector; the
// narrower windows fall back to sheets. All of it keyed on data-view, which
// only exists in Workspace, so nothing here matches on the Board.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(read("styles/workspace.css"));
const board = strip(read("styles/stage-shell.css"));

/** A selector list split at its top-level commas (a comma inside :is() stays). */
function selectorsOf(list: string): string[] {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(" || list[i] === "[") depth++;
    else if (list[i] === ")" || list[i] === "]") depth--;
    else if (list[i] === "," && depth === 0) { out.push(list.slice(from, i)); from = i + 1; }
  }
  out.push(list.slice(from));
  return out.map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The first rule whose selector list has `sel` as an entry. */
function ruleFor(text: string, sel: string): { body: string; at: number } {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (selectorsOf(m[1]).includes(sel)) return { body: m[2], at: m.index };
  }
  throw new Error(`no rule for ${sel}`);
}
const decl = (body: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+)`).exec(body)?.[1].replace(/\s+/g, " ").trim();
/** The text of an at-rule block opened by `head`. */
function block(text: string, head: string): string {
  const at = text.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = text.indexOf("{", at); i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(text.indexOf("{", at) + 1, i);
  }
  throw new Error(`unclosed ${head}`);
}

describe("the sheet", () => {
  it("comes after the sheets whose ties it wins on source order", () => {
    const sheet = read("styles.css");
    expect(sheet).toContain('@import "./styles/workspace.css";');
    for (const earlier of ["stage-shell.css", "detail-panel.css", "left-column.css", "tokens.css", "terminal-stage.css"]) {
      expect(sheet.indexOf("workspace.css"), earlier).toBeGreaterThan(sheet.indexOf(earlier));
    }
    expect(sheetText()).toContain(".view-switch");
  });

  it("matches nothing on the Board: every Workspace rule is keyed on data-view, the pane's data-fill, or a class only Workspace draws", () => {
    const own = /\.view-switch|\.view-opt|\[data-view="workspace"\]|\[data-fill\]|\.ts-ws-|\.insp-none|\.insp-tab\[aria-current|\.ws-cell|:root\[data-view-switch\]|:root\[data-motion="instant"\] \.app\[data-view="workspace"\]|\.ts-tools \.glyph-btn\[data-zoom\]|\.ts-stage\[data-fill\]/;
    const body = css.replace(/@media[^{]*\{/g, "").replace(/@keyframes[^{]*\{[^{}]*\{[^{}]*\}\s*\}/g, "");
    const stray: string[] = [];
    for (const m of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const sel of selectorsOf(m[1])) if (!own.test(sel)) stray.push(sel);
    }
    expect(stray).toEqual([]);
  });
});

describe("the pane", () => {
  it("is the dock stretched over the cell, and its terminal the full width", () => {
    expect(decl(ruleFor(css, ".stage-dock[data-fill]").body, "justify-self")).toBe("stretch");
    expect(decl(ruleFor(css, ".stage-dock[data-fill]").body, "width")).toBe("auto");
    expect(decl(ruleFor(css, ".stage-dock[data-fill] .stage-in").body, "width")).toBe("100%");
  });

  it("keeps the board under it mounted but out of sight", () => {
    expect(decl(ruleFor(css, '.app[data-view="workspace"] .canvas-wrap > *').body, "visibility")).toBe("hidden");
  });

  it("keeps the Board's own dock rules where they were", () => {
    expect(decl(ruleFor(board, ".stage-dock").body, "justify-self")).toBe("end");
    expect(decl(ruleFor(board, ".stage-dock").body, "width")).toBe("min(var(--stage-w), 100%)");
  });
});

describe("Usage and Machine", () => {
  const hide = '.app:has(.stage-dock:not([data-phase="waiting"])) :is(.usage-panel, .sysdetail)';

  it("float over the Inspector in Workspace: the Board's hide is outranked, not edited", () => {
    expect(decl(ruleFor(board, hide).body, "visibility")).toBe("hidden");
    const lift = ruleFor(css, '.app[data-view="workspace"]:has(.stage-dock) :is(.usage-panel, .sysdetail)');
    expect(decl(lift.body, "visibility")).toBe("visible");
  });
});

describe("Zoom", () => {
  it("folds the list and the Inspector without unmounting them, into one track", () => {
    expect(decl(ruleFor(css, 'body .app[data-view="workspace"][data-zoom]').body, "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(decl(ruleFor(css, 'body .app[data-view="workspace"][data-zoom]:has(.left-column)').body, "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(css).toContain('.app[data-view="workspace"][data-zoom] :is(.canvas-wrap, .ws-cell, .stage-dock, .conn-banner, .ver-banner) { grid-column: 1; }');
  });

  it("takes the panels out by sliding them, not by display: none, so the pane has the cell once and the terminal refits once", () => {
    // CHANGED ON PURPOSE (V4's motion spec): the list and the Inspector (and
    // Usage and Machine with them) are overlays while Zoom is on or moving, and
    // out of sight by visibility after the slide; display: none had no motion.
    expect(css).not.toMatch(/\[data-zoom\] \.(left-column|detail) \{ display: none/);
    expect(decl(ruleFor(css, '.app[data-view="workspace"][data-zoom] .left-column').body, "position")).toBe("fixed");
    expect(decl(ruleFor(css, '.app[data-view="workspace"][data-zoom] .detail').body, "position")).toBe("fixed");
    const folded = ruleFor(css, '.app[data-view="workspace"][data-zoom="fold"] .left-column').body;
    expect(decl(folded, "transform")).toBe("translateX(-100%)");
    expect(decl(folded, "visibility")).toBe("hidden");
    const right = ruleFor(css, '.app[data-view="workspace"][data-zoom="fold"] :is(.detail, .usage-panel, .sysdetail)').body;
    expect(decl(right, "transform")).toBe("translateX(100%)");
  });

  it("folds on --dur-stage-out and unfolds on --dur-move, both --ease-stage; a key is at once; reduced motion crossfades over 140", () => {
    const list = ".left-column, .detail, .usage-panel, .sysdetail";
    const fold = decl(ruleFor(css, `.app[data-view="workspace"][data-zoom] :is(${list})`).body, "transition")!;
    expect(fold).toContain("transform var(--dur-stage-out) var(--ease-stage)");
    expect(fold).toContain("opacity var(--dur-stage-out) var(--ease-stage)");
    // Hidden only once the slide is over.
    expect(fold).toContain("visibility 0s var(--ease) var(--dur-stage-out)");
    const unfold = decl(ruleFor(css, `.app[data-view="workspace"][data-zoom="unfold"] :is(${list})`).body, "transition")!;
    expect(unfold).toContain("transform var(--dur-move) var(--ease-stage)");
    expect(unfold).toContain("opacity var(--dur-move) var(--ease-stage)");
    expect(decl(ruleFor(css, `:root[data-motion="instant"] .app[data-view="workspace"][data-zoom] :is(${list})`).body, "transition")).toBe("none");
    expect(strip(read("styles/tokens.css"))).toContain("--dur-xfade: 140ms;");
    const reduced = block(css.slice(css.indexOf("[data-zoom=\"unfold\"] :is(")), "@media (prefers-reduced-motion: reduce)");
    expect(decl(ruleFor(reduced, `.app[data-view="workspace"][data-zoom="fold"] :is(${list})`).body, "transform")).toBe("none");
    expect(decl(ruleFor(reduced, `.app[data-view="workspace"][data-zoom="fold"] :is(${list})`).body, "transition")).toContain("opacity var(--dur-xfade) var(--ease)");
  });

  it("is last in the sheet, so it outranks the narrower windows' templates", () => {
    expect(css.lastIndexOf("[data-zoom]")).toBeGreaterThan(css.lastIndexOf("@media (max-width: 1099px)"));
  });
});

describe("narrower windows", () => {
  it("make the Inspector today's detail sheet under 1320, fixed over the pane, clear of the status bar", () => {
    const sheet = block(css, "@media (max-width: 1319px)");
    const detail = ruleFor(sheet, '.app[data-view="workspace"] .detail').body;
    expect(decl(detail, "position")).toBe("fixed");
    // CHANGED ON PURPOSE (V4's Figma): the sheet starts under the banner strip as well as the top bar, so the strip's dismiss and Copy stay reachable.
    expect(decl(detail, "top")).toBe("calc(var(--topbar-h) + var(--rating-h, 0px))");
    // V4's Figma: one bar on the left, none on the right.
    expect(decl(detail, "right")).toBe("0");
    expect(decl(detail, "bottom")).toBe("var(--status-room)");
    expect(decl(ruleFor(sheet, 'body .app[data-view="workspace"]').body, "grid-template-columns")).toBe("minmax(0, 1fr)");
    // CHANGED ON PURPOSE (V4's Figma draws the Fold in the column too): nothing hides it in the
    // column, so there is no rule to bring it back in the sheet; it is drawn at every width.
    expect(css).not.toContain('.insp-fold');
  });

  it("make the list a sheet under 1100 too, and the pane the one column", () => {
    const sheet = block(css, "@media (max-width: 1099px)");
    expect(decl(ruleFor(sheet, 'body .app[data-view="workspace"]').body, "grid-template-columns")).toBe("minmax(0, 1fr)");
    const list = ruleFor(sheet, '.app[data-view="workspace"] .left-column').body;
    expect(decl(list, "position")).toBe("fixed");
    expect(decl(list, "left")).toBe("var(--edge-w)");
  });

  it("do not exist on a phone: Workspace is the Board alone at 640 and under", () => {
    // The sheets open at 1319 and 1099; none of them reaches a phone-width rule
    // of its own, because data-view is never set there (App draws it only when
    // the stage hook says Workspace, which is false on a phone).
    const stage = readFileSync(fileURLToPath(new URL("../use-stage.ts", import.meta.url)), "utf8");
    // `!chunkFailed` joined the formula (review 3c): a stage that cannot load is the Board.
    expect(stage).toContain('const workspace = view === "workspace" && !phone && !chunkFailed && (offered || !prefsKnown);');
  });
});

describe("tokens only", () => {
  it("draws no colour of its own", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  it("styles the switch as the Inspector's tab pill: --bg-soft track, --panel chip, 24px buttons", () => {
    expect(decl(ruleFor(css, ".view-switch").body, "background")).toBe("var(--bg-soft)");
    expect(decl(ruleFor(css, ".view-switch").body, "border-radius")).toBe("var(--r-panel)");
    expect(decl(ruleFor(css, ".view-opt").body, "height")).toBe("24px");
    expect(decl(ruleFor(css, '.view-opt[aria-pressed="true"]').body, "background")).toBe("var(--panel)");
  });

  it("crossfades the two views on Fast with the browser's view transition, and holds the Board's canvas at its box", () => {
    // CHANGED ON PURPOSE (V4's motion spec): the switch is one crossfade on Fast
    // between two views each laid out at full size, so the old view's fade-out
    // keyframes are gone; view-switch.ts draws the picture, this sheet times it.
    expect(css).not.toContain("@keyframes view-fade");
    expect(css).not.toContain("[data-fade]");
    const old = decl(ruleFor(css, ":root[data-view-switch]::view-transition-old(root)").body, "animation-duration");
    expect(old).toBe("var(--dur-fast)");
    expect(decl(ruleFor(css, ":root[data-view-switch]::view-transition-new(root)").body, "animation-timing-function")).toBe("var(--ease)");
    expect(decl(ruleFor(css, ":root[data-view-switch]::view-transition-group(root)").body, "animation-duration")).toBe("var(--dur-fast)");
    // The canvas keeps the box it had: fixed, hidden, out of reach.
    const pin = ruleFor(css, '.app[data-view="workspace"][data-pin] .canvas-wrap').body;
    expect(decl(pin, "position")).toBe("fixed");
    expect(decl(pin, "width")).toBe("var(--board-w)");
    expect(decl(pin, "visibility")).toBe("hidden");
    // The pane measures its own cell, where the canvas would have been.
    expect(decl(ruleFor(css, ".ws-cell").body, "visibility")).toBe("hidden");
    // Nothing else moves across the switch.
    const still = ruleFor(css, ":root[data-view-switch] .app :is(.left-column, .left-column > *, .detail, .stage-dock, .stage-in, .usage-panel, .sysdetail, .ts-stage .ts-card)").body;
    expect(decl(still, "transition")).toBe("none");
    expect(decl(still, "animation")).toBe("none");
  });
});
