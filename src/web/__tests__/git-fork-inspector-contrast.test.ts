// The Fork look's lower half, measured in both themes from the sheet's own
// values: every word the diff paints on each bed it lands on (the pane, the
// added and removed tints, the stronger tints of the changed words), with
// dark changed lines drawn without syntax tones because Fork's own tones fail
// there; the +/− glyphs and the line numbers on the gutter; the tints kept
// too faint to carry the meaning alone; the path bar, the tree's rows at rest
// and selected, the Commit tab's greys, links and badges; and each status
// square's glyph on its own colour.
//
// Read from the two parts that hold these rules and from tokens.css, the way
// contrast-floors.test.ts reads the deck look's pairs.
import { describe, expect, it } from "vitest";
import { sheetParts } from "./sheet-source";

const BODY = 4.5;
const NON_TEXT = 3;
const FORK = '.gv-wide[data-look="fork"]';
const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];
type Rgba = [number, number, number, number];

const part = (path: string) => sheetParts().find(([p]) => p === path)![1].replace(/\/\*[\s\S]*?\*\//g, "");
const TOKENS = part("styles/tokens.css");
const OURS = part("styles/git-inspector-fork.css") + part("styles/git-diff-fork.css");

/** Top-level rules only (nothing inside an at-rule), each selector list split
 *  at its top-level commas. */
function topRules(css: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  let depth = 0, start = 0, prelude = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      if (depth === 0) { prelude = css.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        if (!prelude.startsWith("@")) {
          const sel: string[] = [];
          let d = 0, from = 0;
          for (let j = 0; j < prelude.length; j++) {
            if (prelude[j] === "(") d++;
            else if (prelude[j] === ")") d--;
            else if (prelude[j] === "," && d === 0) { sel.push(prelude.slice(from, j)); from = j + 1; }
          }
          sel.push(prelude.slice(from));
          out.push({ selectors: sel.map(s => s.replace(/\s+/g, " ").trim()), body: css.slice(start, i) });
        }
        start = i + 1;
      }
    }
  }
  return out;
}

const RULES = topRules(OURS);

function declsOf(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of body.split(";")) {
    const m = /^\s*(--[\w-]+|[a-z-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The last value the Fork sheet sets for `prop` on exactly `selector`: the
 *  Fork look's own classes as they are, the deck's under the Fork scope. */
function decl(selector: string, prop: string): string {
  const spellings = [selector, `${FORK} ${selector}`];
  let found: string | null = null;
  for (const r of RULES) if (spellings.some(s => r.selectors.includes(s))) found = declsOf(r.body)[prop] ?? found;
  if (found === null) throw new Error(`nothing sets ${prop} on ${selector}`);
  return found;
}

function tokenBlock(head: RegExp, css: string): Record<string, string> {
  const m = head.exec(css);
  if (!m) throw new Error(`no block for ${head}`);
  return declsOf(m[1]);
}

const TOK: Record<Theme, Record<string, string>> = {
  dark: {
    ...tokenBlock(/:root,\s*\n:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/, TOKENS),
    ...Object.assign({}, ...RULES.filter(r => r.selectors.includes(FORK)).map(r => declsOf(r.body))),
  },
  light: {
    ...tokenBlock(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/, TOKENS),
    ...Object.assign({}, ...RULES.filter(r => r.selectors.includes(FORK)).map(r => declsOf(r.body))),
    ...Object.assign({}, ...RULES.filter(r => r.selectors.includes(`:root[data-theme="light"] ${FORK}`)).map(r => declsOf(r.body))),
  },
};

function parse(input: string): Rgba {
  const s = input.trim();
  if (s === "transparent") return [0, 0, 0, 0];
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba;
}

function resolve(value: string, theme: Theme): Rgba {
  const v = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (v) {
    const t = TOK[theme][v[1]];
    if (t === undefined) throw new Error(`${theme}: ${v[1]} is not declared`);
    return resolve(t, theme);
  }
  return parse(value);
}

const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;
const lum = (c: Rgba) => {
  const [r, g, b] = [c[0], c[1], c[2]].map(x => { const n = x / 255; return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgba, b: Rgba) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
/** A bed: a colour flattened over what is under it. */
const bed = (theme: Theme, value: string, under?: Rgba) => { const c = resolve(value, theme); return c[3] < 1 ? over(c, under ?? resolve("var(--fk-diff)", theme)) : c; };
const ratio = (theme: Theme, ink: string, on: Rgba) => contrast(over(resolve(ink, theme), on), on);
const expectAt = (r: number, floor: number, what: string) => expect(r, `${what} — ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(floor);

describe("the Fork diff's colour pairs", () => {
  it("reads the code at 4.5:1 on the pane, on both tints and on both word highlights", () => {
    for (const theme of themes) {
      const pane = bed(theme, decl(".gvd-scroll", "background"));
      const add = bed(theme, decl('.gvd-line[data-kind="add"]', "background"), pane);
      const del = bed(theme, decl('.gvd-line[data-kind="del"]', "background"), pane);
      const beds: Array<[string, Rgba]> = [
        ["pane", pane], ["added line", add], ["removed line", del],
        ["added word", bed(theme, decl('.gvd-line[data-kind="add"] .gvd-word', "background"), add)],
        ["removed word", bed(theme, decl('.gvd-line[data-kind="del"] .gvd-word', "background"), del)],
      ];
      for (const [where, b] of beds) expectAt(ratio(theme, decl(".gvd-line .gvd-code", "color"), b), BODY, `${theme} code on the ${where}`);
    }
  });

  it("keeps the syntax tones at 4.5:1 wherever they are drawn, and drops them from dark changed lines", () => {
    const tones = [".syn-kw", ".syn-str", ".syn-com"].map(s => [s, decl(s, "color")] as const);
    for (const theme of themes) {
      const pane = bed(theme, "var(--fk-diff)");
      for (const [s, ink] of tones) expectAt(ratio(theme, ink, pane), BODY, `${theme} ${s} on a context line`);
    }
    // Light keeps them on every bed.
    const pane = bed("light", "var(--fk-diff)");
    const add = bed("light", "var(--fk-diff-add)", pane), del = bed("light", "var(--fk-diff-del)", pane);
    for (const [where, b] of [["added line", add], ["removed line", del], ["added word", bed("light", "var(--fk-diff-add-word)", add)], ["removed word", bed("light", "var(--fk-diff-del-word)", del)]] as const) {
      for (const [s, ink] of tones) expectAt(ratio("light", ink, b), BODY, `light ${s} on the ${where}`);
    }
    // Dark: the rule that draws changed lines in the code's own colour, and
    // the reason for it — Fork's own keyword tone on its added word tint.
    for (const kind of ["add", "del"]) {
      const sel = `:root:not([data-theme="light"]) ${FORK} .gvd-line[data-kind="${kind}"] .gvd-code span`;
      const r = RULES.find(x => x.selectors.includes(sel));
      expect(r && declsOf(r.body).color, sel).toBe("inherit");
    }
    const darkAdd = bed("dark", "var(--fk-diff-add)");
    expect(ratio("dark", "var(--fk-syn-str)", bed("dark", "var(--fk-diff-add-word)", darkAdd))).toBeLessThan(BODY);
  });

  it("draws the +/− glyphs, the line numbers and the hunk's header at 4.5:1 on the gutter's own colour", () => {
    for (const theme of themes) {
      for (const kind of ["add", "del"]) {
        const cell = bed(theme, decl(".gvd-line .gvd-glyph", "background"));
        expectAt(ratio(theme, decl(`.gvd-line[data-kind="${kind}"] .gvd-glyph`, "color"), cell), BODY, `${theme} ${kind} glyph`);
      }
      const gutter = bed(theme, decl(".gvd-line .gvd-ln", "background"));
      expectAt(ratio(theme, decl(".gvd-line .gvd-ln", "color"), gutter), BODY, `${theme} line numbers`);
      const hunk = bed(theme, decl(".gvd-hunk", "background"));
      expectAt(ratio(theme, decl(".gvd-hunk", "color"), hunk), BODY, `${theme} hunk header`);
      expectAt(ratio(theme, decl(".gvd-hunk-range", "color"), hunk), BODY, `${theme} hunk range`);
    }
  });

  it("keeps the tints under 3:1 against the pane, so the glyph carries the meaning", () => {
    for (const theme of themes) {
      const pane = bed(theme, "var(--fk-diff)");
      for (const kind of ["add", "del"]) {
        const tint = contrast(bed(theme, decl(`.gvd-line[data-kind="${kind}"]`, "background"), pane), pane);
        expect(tint, `${theme} ${kind} tint`).toBeLessThan(NON_TEXT);
      }
    }
  });

  it("reads the no-newline and carriage-return marks on every bed", () => {
    for (const theme of themes) {
      const pane = bed(theme, "var(--fk-diff)");
      expectAt(ratio(theme, decl(".gvd-noeol", "color"), pane), BODY, `${theme} no-newline mark on a context line`);
      for (const kind of ["add", "del"]) {
        const b = bed(theme, `var(--fk-diff-${kind})`, pane);
        expectAt(ratio(theme, decl(`.gvd-line[data-kind="${kind}"] .gvd-noeol`, "color"), b), BODY, `${theme} no-newline mark on a ${kind} line`);
        expectAt(ratio(theme, decl(`.gvd-line[data-kind="${kind}"] .gvd-cr`, "color"), b), BODY, `${theme} carriage return on a ${kind} line`);
      }
    }
  });

  it("reads the path bar, its pill and the empty pane's line", () => {
    for (const theme of themes) {
      const bar = bed(theme, decl(".fkd-bar", "background"));
      expectAt(ratio(theme, decl(".fkd-bar-dir", "color"), bar), BODY, `${theme} path folder`);
      expectAt(ratio(theme, decl(".fkd-bar-base", "color"), bar), BODY, `${theme} path name`);
      expectAt(ratio(theme, decl(".fkd-tool", "color"), bar), NON_TEXT, `${theme} path-bar tool`);
      expectAt(ratio(theme, decl(".fkd-step", "color"), bar), NON_TEXT, `${theme} step chevron`);
      expectAt(ratio(theme, decl(".fkd-pill", "color"), bed(theme, decl(".fkd-pill", "background"), bar)), BODY, `${theme} Show latest pill`);
      expectAt(ratio(theme, decl(".fkd-empty-line", "color"), bed(theme, decl(".fkd-empty", "background"))), BODY, `${theme} empty pane`);
    }
  });
});

describe("the tree, the strip and the Commit tab", () => {
  it("reads a row at rest, hovered, selected and selected in a focused tree", () => {
    for (const theme of themes) {
      const tree = bed(theme, decl(".fkt", "background"));
      expectAt(ratio(theme, decl(".fkt-row", "color"), tree), BODY, `${theme} row at rest`);
      expectAt(ratio(theme, decl(".fkt-row", "color"), bed(theme, decl(".fkt-row:hover", "background"), tree)), BODY, `${theme} row hovered`);
      expectAt(ratio(theme, decl(".fkt-row.is-sel", "color"), bed(theme, decl(".fkt-row.is-sel", "background"))), BODY, `${theme} row selected`);
      const focused = ".fkt:not(.is-blurred):focus-within .fkt-row.is-sel";
      expectAt(ratio(theme, decl(focused, "color"), bed(theme, decl(focused, "background"))), BODY, `${theme} row selected, tree focused`);
      expectAt(ratio(theme, decl(".fkt-other", "color"), tree), BODY, `${theme} another agent's name`);
      expectAt(ratio(theme, decl(".fkt-row.is-quiet .fkt-name", "color"), tree), BODY, `${theme} a file the agent did not edit`);
      expectAt(ratio(theme, decl(".fkt-row.is-quiet .fkt-name", "color"), bed(theme, decl(".fkt-row:hover", "background"), tree)), BODY, `${theme} a quiet file hovered`);
      expectAt(ratio(theme, decl(".fkt-empty", "color"), tree), BODY, `${theme} empty tree`);
      expectAt(ratio(theme, decl(".fkc-group-head", "color"), tree), BODY, `${theme} Unstaged / Staged`);
    }
  });

  it("reads each file kind's letters on the tree", () => {
    for (const theme of themes) {
      const tree = bed(theme, "var(--fk-tree)");
      for (const kind of ["cs", "ts", "js", "json", "md", "rs", "py", "css", "html", "sql", "yaml", "sh"]) {
        expectAt(ratio(theme, decl(`.fk-ft[data-ft="${kind}"]`, "color"), tree), BODY, `${theme} ${kind} label`);
      }
    }
  });

  it("reads the strip, the filter and the Commit tab's words on their surfaces", () => {
    for (const theme of themes) {
      const inspector = bed(theme, "var(--fk-inspector)");
      for (const sel of [".fkc-strip-sha", ".fkc-strip-date", ".fkc-strip-subject", ".fkc-filter", ".fkm-id-role", ".fkm-id-mail", ".fkm-id-date", ".fkm-meta dt", ".fkm-parent", ".fkm-clipped", ".fkm-note"]) {
        expectAt(ratio(theme, decl(sel, "color"), inspector), BODY, `${theme} ${sel}`);
      }
      expectAt(ratio(theme, decl(".fkc-filter-input::placeholder", "color"), inspector), BODY, `${theme} filter placeholder`);
      const ref = bed(theme, decl(".fkm-ref", "background"), inspector);
      expectAt(ratio(theme, decl(".fkm-ref", "color"), ref), BODY, `${theme} a ref badge's name`);
      // The border shorthand names its width and style before the colour.
      const edge = decl(".fkm-ref", "border").replace(/^1px solid /, "");
      expectAt(contrast(bed(theme, edge, inspector), inspector), NON_TEXT, `${theme} a ref badge's edge`);
    }
  });
});

describe("the status squares", () => {
  /** A square's glyph ink: its own rule's colour, else the square's. */
  const ink = (kind: string) => {
    try { return decl(`.fk-st[data-st="${kind}"]`, "color"); } catch { return decl(".fk-st", "color"); }
  };

  it("draws the M and T letters at 4.5:1 on their square, and the drawn marks at 3:1", () => {
    for (const theme of themes) {
      const tree = bed(theme, "var(--fk-tree)");
      for (const [kind, floor] of [["modified", BODY], ["added", NON_TEXT], ["untracked", NON_TEXT], ["deleted", NON_TEXT], ["renamed", NON_TEXT]] as const) {
        const fill = bed(theme, decl(`.fk-st[data-st="${kind}"]`, "background"), tree);
        expectAt(ratio(theme, ink(kind), fill), floor, `${theme} ${kind} glyph on its square`);
      }
      const tri = bed(theme, decl(".fk-st-tri-fill", "fill"), tree);
      expectAt(ratio(theme, decl(".fk-st-tri-ink", "stroke"), tri), BODY, `${theme} conflict ! on its triangle`);
      // Fork's own white glyph would fail on the yellow square: the reason
      // its ink is drawn dark here.
      expect(ratio(theme, "var(--fk-st-glyph)", bed(theme, "var(--fk-st-modified)", tree))).toBeLessThan(NON_TEXT);
    }
  });
});
