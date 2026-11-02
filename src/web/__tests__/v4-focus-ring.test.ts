// One focus ring, V4's Figma: a 1.5px --accent stroke INSIDE the box, offset 0,
// so focus never moves or grows anything and never changes a radius. Text
// fields have no ring at all: their 1px border turns --accent (the error state
// keeps --err). The one width lives in tokens.css as --focus-w; no sheet writes
// its own.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cascade, el, selects } from "./sheet-cascade";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

function sheets(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sheets(p, out);
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

type Rule = { file: string; line: number; selector: string; body: string; forced: boolean };

/** Every style rule, with its selector, body and whether a forced-colors query is around it. */
function rules(file: string): Rule[] {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
  const out: Rule[] = [];
  const stack: boolean[] = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === "\n") line++;
    if (c === "{") {
      const header = css.slice(start, i).trim();
      if (header.startsWith("@")) {
        stack.push(/forced-colors/.test(header) || stack.some(Boolean));
        start = i + 1;
        startLine = line;
        continue;
      }
      const end = css.indexOf("}", i);
      out.push({
        // Forward slashes on every platform: the allowlist and the checks name
        // "styles/tokens.css", and relative() answers with backslashes on Windows.
        file: relative(WEB, file).replace(/\\/g, "/"), line: startLine + (css.slice(start, i).match(/^\s*/)![0].match(/\n/g)?.length ?? 0),
        selector: header, body: css.slice(i + 1, end), forced: stack.some(Boolean),
      });
      for (const ch of css.slice(i, end)) if (ch === "\n") line++;
      i = end;
      start = i + 1;
      startLine = line;
    } else if (c === "}") {
      stack.pop();
      start = i + 1;
      startLine = line;
    }
  }
  return out;
}

const ALL = sheets(WEB).flatMap(rules);
const FOCUS = /:focus-visible|:focus-within|:focus\b/;
const focusRules = ALL.filter(r => FOCUS.test(r.selector));

// A real exception, if one ever remains: { file, needle (in the selector), why }.
const ALLOWLIST: { file: string; needle: string; why: string }[] = [
  { file: "styles/tokens.css", needle: '.switch[aria-checked="true"]:focus-visible', why: "the grouped outside ring for controls that already wear the accent (its own case below)" },
  { file: "styles/usage-panel.css", needle: ".up-period .uh-range-btn:focus-visible", why: "the period strip's ring is inset 4px and rounded so it keeps off the ::after indicator and the hairline" },
  { file: "styles/forge-panel.css", needle: '.fg-tabs .uh-range-btn[aria-selected="true"]:focus-visible', why: ".fg-tabs scrolls and clips an outside ring at 2px, so it keeps a 1px step" },
];
const allowed = (r: Rule) => ALLOWLIST.some(a => a.file === r.file && r.selector.includes(a.needle));

// The selectors styled as the V4 text field (sunken fill, 1px border, --r-ctl).
const FIELDS = [
  ".settings-filter-field", ".sm-select", ".ap-manage-input", ".aa-field input",
  ".radio-filter-search input", ".tr-input", ".tr-select", ".qh-window select",
  ".jr-move-pop select", ".jr-transition select", ".jr-comment-compose textarea",
  ".su-pricing select", ".ap-field select", ".ap-pop .ap-field select",
  ".ap-rest-sort select", ".bw-settings select",
];

describe("one focus ring (V4's Figma)", () => {
  const tokens = readFileSync(join(WEB, "styles/tokens.css"), "utf8");

  it("tokens.css defines --focus-w: 1.5px and the global ring is inside, with no radius", () => {
    expect(tokens).toMatch(/--focus-w:\s*1\.5px/);
    const g = ALL.find(r => r.file.endsWith("styles/tokens.css") && r.selector === ":focus-visible");
    expect(g, "global :focus-visible rule").toBeDefined();
    expect(g!.body).toMatch(/outline:\s*var\(--focus-w\)\s+solid\s+var\(--accent\)/);
    expect(g!.body).toMatch(/outline-offset:\s*calc\(-1\s*\*\s*var\(--focus-w\)\)/);
    expect(g!.body).not.toMatch(/border-radius/);
  });

  it("the scan sees the sheets (a parser that finds nothing would pass everything)", () => {
    expect(focusRules.length).toBeGreaterThan(60);
    expect(focusRules.some(r => r.forced)).toBe(true);
  });

  it("no focus rule writes its own outline width (0/none, or var(--focus-w))", () => {
    const bad = focusRules.filter(r => !allowed(r)).flatMap(r =>
      [...r.body.matchAll(/outline(?:-width)?:\s*([^;]+)/g)]
        .filter(m => !/^(none|0|0px)\b/.test(m[1]!.trim()) && !/var\(--focus-w\)/.test(m[1]!) && !/^[a-z-]*\s*$/.test(m[1]!.trim()))
        .map(m => `${r.file}:${r.line} ${r.selector} -> outline: ${m[1]!.trim()}`));
    expect(bad).toEqual([]);
  });

  it("no focus rule has a positive outline-offset", () => {
    const bad = focusRules.filter(r => !allowed(r)).flatMap(r =>
      [...r.body.matchAll(/outline-offset:\s*([^;]+)/g)]
        .filter(m => !/^(0|0px|calc\(-1\s*\*\s*var\(--focus-w\)\)|-)/.test(m[1]!.trim()))
        .map(m => `${r.file}:${r.line} ${r.selector} -> outline-offset: ${m[1]!.trim()}`));
    expect(bad).toEqual([]);
  });

  it("focus never changes a radius", () => {
    const bad = focusRules.filter(r => /:focus-visible\s*$/.test(r.selector) && /border-radius/.test(r.body) && !allowed(r))
      .map(r => `${r.file}:${r.line} ${r.selector}`);
    expect(bad).toEqual([]);
  });

  it("every text-field selector has a focus rule with outline: none and a border-colour", () => {
    const rule = ALL.find(r => r.file.endsWith("styles/tokens.css") && r.selector.includes(".settings-filter-field") && !r.selector.includes("aria-invalid"));
    expect(rule, "text-field focus rule in tokens.css").toBeDefined();
    const listed = rule!.selector.split(",").map(x => x.replace(/\s+/g, " ").trim());
    for (const f of FIELDS) expect(listed, f).toContain(f + ":focus-visible");
    expect(rule!.selector).toMatch(/:focus-visible/);
    expect(rule!.body).toMatch(/outline:\s*none/);
    expect(rule!.body).toMatch(/border-color:\s*var\(--accent\)/);
    const err = ALL.find(r => r.file.endsWith("styles/tokens.css") && r.selector.includes("aria-invalid") && r.selector.includes(":focus-visible"));
    expect(err?.body).toMatch(/border-color:\s*var\(--err\)/);
  });

  it("forced colours give the text-field family its ring back", () => {
    const forced = ALL.find(r => r.forced && r.selector.includes(":focus-visible") && r.selector.includes(".settings-filter-field"));
    expect(forced, "forced-colors field rule").toBeDefined();
    expect(forced!.body).toMatch(/outline:\s*var\(--focus-w\)\s+solid\s+Highlight/);
    for (const f of FIELDS) expect(forced!.selector, f).toContain(f + ":focus-visible");
  });

  it("where a control already wears the accent, the ring steps outside: same stroke, offset 2px", () => {
    const g = ALL.find(r => r.file === "styles/tokens.css" && r.selector.includes('.switch[aria-checked="true"]:focus-visible'));
    expect(g, "grouped outside-ring rule").toBeDefined();
    const sels = g!.selector.split(",").map(x => x.replace(/\s+/g, " ").trim());
    // The controls whose on/pressed/selected state fills or borders itself with --accent.
    for (const s of [
      '.switch[aria-checked="true"]', '.uh-range-btn[aria-pressed="true"]',
      '.fg-tabs .uh-range-btn[aria-selected="true"]', '.fd-sections .uh-range-btn[aria-selected="true"]',
      ".aa-tab.on", '.character-choice[aria-checked="true"]', '.qh-provider[aria-pressed="true"]',
      'button.btn.jr-chip[aria-pressed="true"]', '.radio-controls .radio-mute[aria-pressed="true"]',
      '.radio-filter-trigger[data-filtered="true"]', "button.btn.primary",
    ]) expect(sels, s).toContain(s + ":focus-visible");
    // Offset only: width, style and colour stay the global ring's.
    expect(g!.body.replace(/\s+/g, " ").trim()).toBe("outline-offset: 2px;");
    // The one place that clips an outside ring keeps the old 1px step.
    const forge = ALL.find(r => r.file === "styles/forge-panel.css" && r.selector.includes('.fg-tabs .uh-range-btn[aria-selected="true"]:focus-visible'));
    expect(forge?.body.replace(/\s+/g, " ").trim()).toBe("outline-offset: 1px;");
  });

  it("a hovered AND focused text field keeps the accent border (no later hover rule beats the focus one)", () => {
    for (const f of FIELDS) {
      const parts = f.split(" ");
      const chain = parts.map((tok, i) => {
        if (i < parts.length - 1) return el("div", [tok.replace(/^\./, "")]);
        const tag = /^[a-z]/.test(tok) ? tok : "input";
        return el(tag, tok.startsWith(".") ? [tok.slice(1)] : [], { states: ["hover", "focus-visible"] });
      });
      expect(cascade(sel => selects(sel, chain), "border-color", 1200), f).toBe("var(--accent)");
    }
  });
});
