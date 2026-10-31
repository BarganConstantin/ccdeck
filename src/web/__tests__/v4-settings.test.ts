// V4's Settings on its own rows (Phase 1, PR 5): the dialog's nav and pane, the
// nav item, the page head, the section label, the borderless list, the row and
// its disabled state, the switch and the select. Phase 1 moves nothing, so this
// pins only how they LOOK, at sheet level. Tokens only; no hex or rgba here.
import { describe, it, expect } from "vitest";
import { sheetText } from "./sheet-source";

interface Rule { media: string; selectors: string[]; decls: Record<string, string> }

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** The sheet as a flat list of rules in source order, each with the @media
 *  prelude it sits in ("" at the top level). */
function parse(text: string): Rule[] {
  const rules: Rule[] = [];
  const block = (from: number): number => {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced braces");
  };
  const walk = (start: number, end: number, media: string) => {
    let i = start;
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= end) return;
      const prelude = text.slice(i, open).trim().replace(/\s+/g, " ");
      const close = block(open);
      const inner = text.slice(open + 1, close);
      if (prelude.startsWith("@keyframes")) { /* not read here */ }
      else if (prelude.startsWith("@")) walk(open + 1, close, prelude.startsWith("@media") ? prelude.slice(6).trim() : media);
      else {
        const decls: Record<string, string> = {};
        for (const m of inner.matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) decls[m[1]] = m[2].replace(/\s+/g, " ");
        const selectors = prelude.split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, " "));
        rules.push({ media, selectors, decls });
      }
      i = close + 1;
    }
  };
  walk(0, text.length, "");
  return rules;
}
const rules = parse(css);

/** The value the cascade would give `prop` on exactly this selector (the last
 *  rule that names it, in the given @media, "" for none). */
function decl(selector: string, prop: string, media = ""): string | undefined {
  let found: string | undefined;
  for (const r of rules) if (r.media === media && r.selectors.includes(selector) && prop in r.decls) found = r.decls[prop];
  return found;
}
const has = (selector: string, media = "") => rules.some(r => r.media === media && r.selectors.includes(selector));
const INC = (px: number) => `calc(${px}px + var(--ui-text-increase, 0px))`;
const REDUCED = "(prefers-reduced-motion: reduce)";
const POINTER = "(hover: hover) and (pointer: fine)";

describe("V4's Settings dialog body", () => {
  it("has a 200px nav column on the dock's fill, over a --line edge", () => {
    expect(decl(".settings-body", "grid-template-columns")).toBe("200px minmax(0, 1fr)");
    expect(decl(".settings-side", "background")).toBe("var(--dock)");
    expect(decl(".settings-side", "border-right")).toBe("1px solid var(--line)");
  });
  it("pads the nav 8 all round, 2 between the items, and parts no group of them", () => {
    expect(decl(".settings-nav", "padding")).toBe("8px");
    expect(decl(".settings-nav", "gap")).toBe("2px");
    expect(css).not.toMatch(/#settings-tab-(notifications|integrations|about)/);
  });
  it("keeps the field 12px off the first item (4 under it, 8 of nav padding)", () => {
    expect(decl(".settings-search", "padding")).toBe("12px 8px 4px");
  });
  it("pads the pane 16 on all four sides, with the same scroll padding, and leaves no gap between groups", () => {
    expect(decl(".settings-pane", "padding")).toBe("16px");
    expect(decl(".settings-pane", "scroll-padding")).toBe("16px 0 16px");
    expect(decl(".modal.settings-modal", "--settings-group-gap")).toBe("0px");
  });
});

describe("V4's nav item", () => {
  const tab = ".settings-tab";
  it("is a table row tall, 4 and 8 of padding, 13 on 20 at 400 in the secondary tier", () => {
    expect(decl(tab, "min-height")).toBe("var(--row-table)");
    expect(decl(tab, "padding")).toBe("4px 8px");
    expect(decl(tab, "border-radius")).toBe("var(--r-ctl)");
    expect(decl(tab, "align-items")).toBe("center");
    expect(decl(tab, "font-size")).toBe(INC(13));
    expect(decl(tab, "line-height")).toBe(INC(20));
    expect(decl(tab, "font-weight")).toBe("400");
    expect(decl(tab, "color")).toBe("var(--text-secondary)");
  });
  it("washes on hover and fills with --selected at 600 when chosen", () => {
    expect(decl(`${tab}:hover`, "background")).toBe("var(--ctl-fill)");
    expect(decl(`${tab}:hover`, "color")).toBe("var(--text)");
    expect(decl(`${tab}[aria-selected="true"]`, "background")).toBe("var(--selected)");
    expect(decl(`${tab}[aria-selected="true"]`, "color")).toBe("var(--text)");
    expect(decl(`${tab}[aria-selected="true"]`, "font-weight")).toBe("600");
  });
  it("draws no glyph", () => {
    expect(has(".settings-tab > svg")).toBe(false);
  });
});

describe("V4's page head", () => {
  it("is a title and a line 4 apart: 14 on 20 at 600, then 12 on 16 in --muted", () => {
    expect(decl(".settings-pane-heading", "display")).toBe("flex");
    expect(decl(".settings-pane-heading", "flex-direction")).toBe("column");
    expect(decl(".settings-pane-heading", "gap")).toBe("4px");
    expect(decl(".settings-pane-title", "font-size")).toBe(INC(14));
    expect(decl(".settings-pane-title", "line-height")).toBe(INC(20));
    expect(decl(".settings-pane-title", "font-weight")).toBe("600");
    expect(decl(".settings-pane-title", "color")).toBe("var(--text)");
    expect(decl(".settings-pane-note", "font-size")).toBe(INC(12));
    expect(decl(".settings-pane-note", "line-height")).toBe(INC(16));
    expect(decl(".settings-pane-note", "color")).toBe("var(--muted)");
  });
});

describe("V4's section label", () => {
  it("is 12 on 16 at 600 in the secondary tier", () => {
    const sel = ".sm-tone-name";
    expect(decl(sel, "font-size")).toBe(INC(12));
    expect(decl(sel, "line-height")).toBe(INC(16));
    expect(decl(sel, "font-weight")).toBe("600");
    expect(decl(sel, "color")).toBe("var(--text-secondary)");
    // The literal 12px the reach test reads stays.
    expect(css).toMatch(/\.settings-caption h3,\s*\.sm-tone-name\s*\{[^}]*font-size:\s*calc\(12px/);
  });
  it("carries the space between groups: 16 above (8 for the first), 2 below, no side padding, no gap to the list", () => {
    expect(decl(".settings-caption", "padding")).toBe("16px 0 2px");
    expect(decl(".settings-group:first-child > .settings-caption", "padding-top")).toBe("8px");
    expect(decl(".settings-pane-head + .settings-group > .settings-caption", "padding-top")).toBe("8px");
    expect(decl(".settings-group", "gap")).toBe("0");
  });
});

describe("V4's list: no box, a --line-soft hairline between rows", () => {
  it("has no border, radius or ground", () => {
    const own = rules.filter(r => r.media === "" && r.selectors.includes(".settings-list"));
    for (const r of own) for (const p of ["border", "border-radius", "background"]) expect(r.decls, p).not.toHaveProperty(p);
    expect(decl(".settings-list > :not(:first-child)", "border-top")).toBe("1px solid var(--line-soft)");
  });
});

describe("V4's row", () => {
  const row = ".settings-row";
  it("is --row-settings tall with the block padding that makes name + note exactly that, and none at the sides", () => {
    expect(decl(row, "min-height")).toBe("var(--row-settings)");
    expect(decl(row, "padding")).toBe("calc((var(--row-settings) - 36px) / 2) 0");
    expect(decl(row, "column-gap")).toBe("16px");
    expect(decl(row, "row-gap")).toBe("0");
  });
  it("starts its control level with the name, and centres a row of a name alone", () => {
    expect(decl(row, "align-items")).toBe("start");
    expect(decl(row, "align-content")).toBe("center");
    expect(decl(".settings-row:not(:has(> .settings-row-note))", "align-items")).toBe("center");
    expect(decl(".settings-row-control", "align-items")).toBe("flex-start");
    expect(decl('.settings-row-control > [role="switch"]', "margin-top")).toBe("1px");
  });
  it("names at 13 on 20, 500 in --text; describes at 12 on 16 in --muted, 400px wide at most", () => {
    expect(decl(".settings-row-name", "font-size")).toBe(INC(13));
    expect(decl(".settings-row-name", "line-height")).toBe(INC(20));
    expect(decl(".settings-row-name", "font-weight")).toBe("500");
    expect(decl(".settings-row-name", "color")).toBe("var(--text)");
    expect(decl(".settings-row-note", "font-size")).toBe(INC(12));
    expect(decl(".settings-row-note", "line-height")).toBe(INC(16));
    expect(decl(".settings-row-note", "color")).toBe("var(--muted)");
    expect(decl(".settings-row-note", "max-width")).toBe("400px");
  });
  it("shows a disabled control at 0.45 and its name and note in --muted", () => {
    expect(decl(".settings-row-control", "--dim-off")).toBe("0.45");
    expect(decl(".settings-row:has(> .settings-row-control :is(:disabled, [aria-disabled=\"true\"])) :is(.settings-row-name, .settings-row-note)", "color")).toBe("var(--muted)");
    // Elsewhere the deck's token is untouched.
    expect(decl(":root", "--dim-off")).toBe("0.6");
  });
  it("gives Sounds' second row shape the same height, padding and hairline, and the disclosure no side padding", () => {
    expect(decl(".settings-list > .sm-row", "min-height")).toBe("var(--row-settings)");
    expect(decl(".settings-list > .sm-row", "padding")).toBe("calc((var(--row-settings) - 36px) / 2) 0");
    expect(decl(".settings-row-details", "padding")).toMatch(/^0 0 /);
  });
  it("keeps the key table's own compact padding, with no minimum height", () => {
    expect(decl(".settings-keys .settings-row", "padding-block")).toBe("calc(6px * var(--ui-space, 1))");
    expect(decl(".settings-keys .settings-row", "min-height")).toBe("0");
  });
});

describe("V4's switch: 32 x 18 with a 14px knob", () => {
  it("is a border-box track, off on --bg-soft with the --ctl-edge edge, on --accent", () => {
    expect(decl(".switch", "box-sizing")).toBe("border-box");
    expect(decl(".switch", "width")).toBe("32px");
    expect(decl(".switch", "height")).toBe("18px");
    expect(decl(".switch", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".switch", "border")).toBe("1px solid var(--ctl-edge)");
    expect(decl(".switch", "background")).toBe("var(--bg-soft)");
    expect(decl('.switch[aria-checked="true"]', "background")).toBe("var(--accent)");
    expect(decl('.switch[aria-checked="true"]', "border-color")).toBe("var(--accent)");
    expect(decl('.switch[data-tone="warn"][aria-checked="true"]', "background")).toBe("var(--warn)");
    expect(decl('.switch[data-tone="warn"][aria-checked="true"]', "border-color")).toBe("var(--warn)");
  });
  it("has a round 14px knob, --muted off and --panel on, travelling 12px (2px of air at each end)", () => {
    expect(decl(".switch-knob", "width")).toBe("14px");
    expect(decl(".switch-knob", "height")).toBe("14px");
    expect(decl(".switch-knob", "left")).toBe("2px");
    expect(decl(".switch-knob", "background")).toBe("var(--muted)");
    expect(decl('.switch[aria-checked="true"] .switch-knob', "background")).toBe("var(--panel)");
    expect(decl('.switch[aria-checked="true"] .switch-knob', "transform")).toBe("translateY(-50%) translateX(12px)");
    // 32 - 2 (border) = 30 inside; 30 - 2 - 14 - 2 = 12.
    expect(30 - 2 - 14 - 2).toBe(12);
  });
  it("moves the knob in Base and stretches it in Fast on a pointer press only, toward the left when on", () => {
    expect(decl(".switch-knob", "transition")).toBe(
      "transform var(--dur-base) var(--ease), width var(--dur-base) var(--ease), background-color var(--dur-base) var(--ease)");
    const press = ".switch:active:not(:disabled):not(:focus-visible) .switch-knob";
    expect(decl(press, "width")).toBe("18px");
    expect(decl(press, "transition-duration")).toBe("var(--dur-fast)");
    expect(decl('.switch[aria-checked="true"]:active:not(:disabled):not(:focus-visible) .switch-knob', "transform"))
      .toBe("translateY(-50%) translateX(8px)");
    expect(decl(".switch:focus-visible .switch-knob", "transition-duration")).toBe("var(--dur-fast)");
  });
  it("no longer scales the track on press, in either sheet", () => {
    expect(has(".switch:active:not(:disabled)")).toBe(false);
    expect(css).not.toMatch(/\.switch:active:not\(:disabled\)\s*[,{]/);
  });
  it("lifts the edge and the knob to --text on a real pointer only; an on knob stays --panel", () => {
    expect(decl(".switch:hover:not(:disabled)", "border-color", POINTER)).toBe("var(--text)");
    expect(decl(".switch:hover:not(:disabled) .switch-knob", "background", POINTER)).toBe("var(--text)");
    expect(decl('.switch[aria-checked="true"]:hover:not(:disabled) .switch-knob', "background", POINTER)).toBe("var(--panel)");
    expect(has(".switch:hover:not(:disabled)")).toBe(false);
  });
  it("neither stretches nor travels under reduced motion", () => {
    expect(decl(".switch-knob", "transition", REDUCED)).toBe("background-color var(--dur-fast) var(--ease)");
    // The answers carry the press rules' own selectors, so they win on
    // specificity rather than losing to the stretch they are meant to stop.
    const press = ".switch:active:not(:disabled):not(:focus-visible) .switch-knob";
    expect(decl(press, "width", REDUCED)).toBe("14px");
    expect(decl(`.switch[aria-checked="true"]${press.slice(".switch".length)}`, "transform", REDUCED))
      .toBe("translateY(-50%) translateX(12px)");
  });
  it("keeps the 24px target", () => {
    expect(decl(".switch::after", "height")).toBe("24px");
    expect(decl(".switch::after", "width")).toBe("max(100%, 24px)");
  });
});

describe("V4's select", () => {
  it("is a control tall, 0 8 0 12, --bg-soft with the --ctl-edge edge, 13 on 20", () => {
    expect(decl(".sm-select", "min-height")).toBe("var(--ctl-h)");
    expect(decl(".sm-select", "padding")).toBe("0 8px 0 12px");
    expect(decl(".sm-select", "background")).toBe("var(--bg-soft)");
    expect(decl(".sm-select", "border")).toBe("1px solid var(--ctl-edge)");
    expect(decl(".sm-select", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".sm-select", "font-size")).toBe(INC(13));
    expect(decl(".sm-select", "line-height")).toBe("var(--lh-body)");
  });
});
