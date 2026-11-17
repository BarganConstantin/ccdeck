// V4 top-10 #8: monospace only where the text is code.
//
// Mono tells the reader "you could type or paste this". It stays on paths,
// commands, terminal text, keys, code and JSON, ids and tool-call arguments.
// A clock, a count, a percent, a token or cost figure, a model name or a label
// is not that: it is set in the interface's sans, and where it is a figure it
// keeps its digits lined up with tabular-nums instead.
//
// Read from the sheet the way the suite reads it, cascade order and all, so a
// later rule or a `font:` shorthand (which resets font-variant-numeric) is
// counted. A handful of representative selectors from each side is pinned
// here; the per-surface tests pin the rest.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { lazySheetText, sheetParts, sheetText } from "./sheet-source";

const web = fileURLToPath(new URL("..", import.meta.url));
const tokens = readFileSync(join(web, "styles/tokens.css"), "utf8");
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** `[selector list, body]` for every top-level rule (not inside @media and the like). */
function topLevelRules(css: string): [string, string][] {
  const text = noComments(css);
  const out: [string, string][] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const selector = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (depth && j < text.length) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    if (!selector.startsWith("@")) out.push([selector, text.slice(open + 1, j - 1)]);
    i = j;
  }
  return out;
}

/** Splits a selector list at its top-level commas (not the ones inside :is()). */
function selectorsOf(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < list.length; k++) {
    if (list[k] === "(") depth++;
    else if (list[k] === ")") depth--;
    else if (list[k] === "," && depth === 0) {
      out.push(list.slice(from, k));
      from = k + 1;
    }
  }
  out.push(list.slice(from));
  return out.map(s => s.trim().replace(/\s+/g, " "));
}

const rules = topLevelRules(sheetText() + lazySheetText());

/** What the rules naming exactly `selector` leave its face as, last one winning. */
function face(selector: string): { family: string | null; numeric: string | null } {
  let family: string | null = null;
  let numeric: string | null = null;
  let seen = false;
  for (const [list, body] of rules) {
    if (!selectorsOf(list).includes(selector)) continue;
    seen = true;
    for (const d of body.split(";").map(s => s.trim()).filter(Boolean)) {
      const colon = d.indexOf(":");
      const prop = d.slice(0, colon).trim();
      const value = d.slice(colon + 1).trim().replace(/\s+/g, " ");
      if (prop === "font") {
        // The shorthand sets the family and resets font-variant-numeric.
        numeric = null;
        const named = /var\(--font-(?:sans|mono)\)/.exec(value);
        if (named) family = named[0];
        else if (value === "inherit") family = "inherit";
      } else if (prop === "font-family") family = value;
      else if (prop === "font-variant-numeric") numeric = value;
    }
  }
  if (!seen) throw new Error(`no rule names ${selector}`);
  return { family, numeric };
}

const SANS = "var(--font-sans)";
const MONO = "var(--font-mono)";

describe("the two faces live in tokens.css, and the body reads the sans", () => {
  it("declares --font-sans once, beside --font-mono in the bare :root, with the body's stack", () => {
    const sheet = noComments(sheetText());
    expect(sheet.match(/--font-sans\s*:/g)).toHaveLength(1);
    const root = /(?:^|\})\s*:root\s*\{([^}]*--font-mono\s*:[^}]*)\}/.exec(noComments(tokens));
    expect(root, "a bare :root that declares --font-mono").not.toBeNull();
    expect(root![1]).toMatch(
      /--font-sans:\s*-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;/,
    );
  });

  it("sets the body in var(--font-sans), and spells the sans stack nowhere else", () => {
    expect(noComments(tokens)).toMatch(
      /html,\s*body,\s*#root\s*\{[^}]*font:\s*calc\(13px \+ var\(--ui-text-increase, 0px\)\)\/1\.45 var\(--font-sans\);/,
    );
    for (const [path, text] of sheetParts()) {
      if (path === "styles/tokens.css") continue;
      expect(noComments(text), path).not.toMatch(/-apple-system|BlinkMacSystemFont|"Segoe UI"/);
    }
    expect(noComments(lazySheetText())).not.toMatch(/-apple-system|BlinkMacSystemFont|"Segoe UI"/);
  });

  it("says in the type roles that Meta is sans with tabular figures and Code alone is mono", () => {
    expect(tokens).toContain("Meta is set in the interface's sans (--font-sans), with tabular figures");
    expect(tokens).toContain("Code alone is set in --font-mono (V4 top-10 #8)");
    expect(tokens).not.toContain("Meta and Code are set in --font-mono");
  });
});

describe("figures and labels are sans, the figures with tabular digits", () => {
  // Each of these was var(--font-mono) before V4 top-10 #8.
  const figures: [string, string][] = [
    [".agent-node .time", "the board card's clock"],
    [".agent-node .foot", "the card's cost, clock and tokens"],
    [".statusbar-version", "the status bar's version figure"],
    [".topbar .count-pill b", "a top-bar count"],
    [".qb-pct", "a quota bar's percent"],
    [".up-total-value", "the usage panel's hero figure"],
    [".ta-cell", "a tool-audit count"],
    [".insp-time-took", "how long a call took"],
    [".uh-day-table tbody td", "a day's tokens and cost"],
  ];
  for (const [selector, what] of figures) {
    it(`sets ${what} (${selector}) in the sans with tabular-nums`, () => {
      const f = face(selector);
      expect(f.family, selector).toBe(SANS);
      expect(f.numeric, selector).toBe("tabular-nums");
    });
  }

  const labels: [string, string][] = [
    [".model-chip", "a model's name"],
    [".ta-op", "a tool's name in the audit"],
    [".ig-head .ig-conn-name", "a connection's name"],
  ];
  for (const [selector, what] of labels) {
    it(`sets ${what} (${selector}) in the sans`, () => {
      expect(face(selector).family, selector).toBe(SANS);
    });
  }
});

describe("code stays mono", () => {
  const code: [string, string][] = [
    [".path-text", "a path"],
    [".kbd", "a key in the status bar"],
    [".key-help kbd", "a key in the shortcuts sheet"],
    ["button.tool.clickable .tool-arg", "a tool call's argument in the inspector"],
    [".insp-time-arg", "the argument of the slowest call"],
    [".ta-report code", "code in the tool audit"],
    [".chat-tool-arg", "a tool row's argument in Chat"],
    [".agent-node .waiting-said.mono", "the call a card waits on"],
    [".modal-tool-id", "a call's id"],
    [".tr-command", "a command in the traffic radar"],
  ];
  for (const [selector, what] of code) {
    it(`keeps ${what} (${selector}) in mono`, () => {
      expect(face(selector).family, selector).toBe(MONO);
    });
  }

  it("splits the mixed rows: the argument mono, the figure beside it sans", () => {
    expect(face(".insp-time-arg").family).toBe(MONO);
    expect(face(".insp-time-took").family).toBe(SANS);
    expect(face(".tr-body code").family).toBe(MONO);
    expect(face(".tr-body time").family).toBe(SANS);
    expect(face(".tr-body time").numeric).toBe("tabular-nums");
    expect(face(".chat-tool").family).toBe(SANS);
    expect(face(".chat-tool-arg").family).toBe(MONO);
  });
});
