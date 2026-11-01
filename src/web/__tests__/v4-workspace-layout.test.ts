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
    const own = /\.view-switch|\.view-opt|\[data-view="workspace"\]|\[data-fill\]|\.ts-ws-|\.insp-none|\.insp-tab\[aria-current|\.app\[data-fade\]|:root\[data-motion="instant"\] \.app\[data-fade\]|\.ts-tools \.glyph-btn\[data-zoom\]|\.ts-stage\[data-fill\]/;
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
    expect(decl(ruleFor(css, '.app[data-view="workspace"][data-zoom] .left-column').body, "display")).toBe("none");
    expect(decl(ruleFor(css, '.app[data-view="workspace"][data-zoom] .detail').body, "display")).toBe("none");
    expect(css).toContain('.app[data-view="workspace"][data-zoom] :is(.canvas-wrap, .stage-dock, .conn-banner, .ver-banner) { grid-column: 1; }');
  });

  it("is last in the sheet, so it outranks the narrower windows' templates", () => {
    expect(css.lastIndexOf("[data-zoom]")).toBeGreaterThan(css.lastIndexOf("@media (max-width: 1099px)"));
  });
});

describe("narrower windows", () => {
  it("make the Inspector today's detail sheet under 1320, fixed over the pane, clear of the stripe and the status bar", () => {
    const sheet = block(css, "@media (max-width: 1319px)");
    const detail = ruleFor(sheet, '.app[data-view="workspace"] .detail').body;
    expect(decl(detail, "position")).toBe("fixed");
    expect(decl(detail, "top")).toBe("var(--topbar-h)");
    expect(decl(detail, "right")).toBe("var(--edge-w)");
    expect(decl(detail, "bottom")).toBe("var(--status-room)");
    expect(decl(ruleFor(sheet, 'body .app[data-view="workspace"]').body, "grid-template-columns")).toBe("minmax(0, 1fr)");
    // Its Fold comes back there, to close the sheet.
    expect(decl(ruleFor(sheet, '.app[data-view="workspace"] .detail .insp-fold').body, "display")).toBe("inline-flex");
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
    expect(stage).toContain('const workspace = view === "workspace" && !phone && (offered || !prefsKnown);');
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

  it("fades the middle with opacity alone, over --dur-base; reduced motion keeps the fade, shorter", () => {
    expect(css).toMatch(/@keyframes view-fade \{ from \{ opacity: 0; \} \}/);
    expect(decl(ruleFor(css, ".app[data-fade] .canvas-wrap").body, "animation")).toBe("view-fade var(--dur-base) var(--ease) both");
    const reduced = block(css.slice(css.indexOf("@keyframes view-fade")), "@media (prefers-reduced-motion: reduce)");
    expect(decl(ruleFor(reduced, ".app[data-fade] .canvas-wrap").body, "animation")).toBe("view-fade var(--dur-fast) linear both");
    // By key it does not move at all.
    expect(decl(ruleFor(css, ':root[data-motion="instant"] .app[data-fade] .canvas-wrap').body, "animation")).toBe("none");
  });
});
