// What the cascade gives one element, read out of the sheet.
//
// Most tests here pin a rule: this selector, this declaration. That answers
// "is the rule still written" and not "does it still win", and the two part
// ways the moment a later rule, a heavier selector or a media block says
// something else about the same property. #1790's detail column was exactly
// that: four rules declared the right templates, and a fifth, unconditional
// one gave a phone a 360px track anyway. So these read the sheet the way a
// browser does for one element at one window width — every `@media` block
// honoured, then specificity, then source order — and the caller says which
// selectors select its element, and how heavily.
//
// `selects` answers that for an element described as a chain — its tag,
// classes, attributes and states, and its ancestors' — which covers what the
// sheet writes: compounds, descendants and children, `:not`/`:is`/`:where`.
// What it cannot read (`:has()`, a sibling) throws, and only when the rest of
// the selector already matched, so a test fails loudly on a rule that could
// reach its element instead of quietly skipping it. A test that knows the
// few selector shapes reaching its element can pass its own matcher instead.
import { sheetText } from "./sheet-source";

export interface SheetRule {
  selectors: string[];
  body: string;
  /** The `@media` condition the rule sits in, or null at the top level. */
  media: string | null;
  /** Cascade order: later wins at equal specificity. */
  order: number;
}

/** Top-level separators only, so `:is(a, b)` and `min(a, b)` stay whole. */
export function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === sep && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}

/** The index just past the `}` that closes the `{` at `open`. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

function parse(text: string, media: string | null, out: SheetRule[]): SheetRule[] {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const prelude = text.slice(i, open).replace(/^[\s;]+/, "").trim();
    const end = closeOf(text, open);
    const inner = text.slice(open + 1, end - 1);
    // Nested media is not written in this sheet; @keyframes, @font-face and
    // @supports hold nothing a layout or focus test resolves.
    if (prelude.startsWith("@media")) parse(inner, prelude.slice(6).trim(), out);
    else if (!prelude.startsWith("@")) out.push({ selectors: splitTop(prelude), body: inner, media, order: out.length });
    i = end;
  }
  return out;
}

let rules: SheetRule[] | null = null;

/** Every style rule in the sheet, in cascade order, comments stripped. */
export function sheetRules(): readonly SheetRule[] {
  rules ??= parse(sheetText().replace(/\/\*[\s\S]*?\*\//g, ""), null, []);
  return rules;
}

/** A desktop screen `width` wide. Widths are what is asked; every other
 *  feature — reduced motion, forced colours, a coarse pointer — is off. */
export function mediaApplies(query: string | null, width: number): boolean {
  if (query == null) return true;
  return splitTop(query).some(alt => alt.split(/\s+and\s+/).every(f => {
    const m = /^\((max|min)-width:\s*([\d.]+)px\)$/.exec(f.trim());
    if (!m) return false;
    return m[1] === "max" ? width <= +m[2] : width >= +m[2];
  }));
}

/** The value one declaration has in a rule's body, or undefined — the last of
 *  them when a body says it twice, as the cascade would. `!important` is not
 *  weighed: the sheet spends it on two table cells and nothing these read. */
export function declared(body: string, prop: string): string | undefined {
  const re = new RegExp(`(?:^|[;{\\s])${prop.replace(/-/g, "\\-")}\\s*:\\s*([^;]+)`, "g");
  return [...body.matchAll(re)].at(-1)?.[1].trim();
}

/** What the cascade gives `prop` at `width` on the element `specificity`
 *  describes: it returns how heavily a selector selects the element, or null
 *  when it does not. The weight is one number — ids never occur here, so
 *  classes and pseudo-classes count ten and type selectors one. */
export function cascade(specificity: (selector: string) => number | null, prop: string, width: number): string | null {
  let best: { spec: number; order: number; value: string } | null = null;
  for (const r of sheetRules()) {
    if (!mediaApplies(r.media, width)) continue;
    const value = declared(r.body, prop);
    if (value == null) continue;
    for (const s of r.selectors) {
      const spec = specificity(s);
      if (spec == null) continue;
      if (!best || spec > best.spec || (spec === best.spec && r.order > best.order)) best = { spec, order: r.order, value };
    }
  }
  return best?.value ?? null;
}

/** One element, as a selector can ask about it: its tag, classes, attributes
 *  and the pseudo-classes it is in (`focus-visible`, `root`, …). A chain of
 *  them, root first, is the element and its ancestors. */
export interface El {
  tag: string;
  classes: readonly string[];
  attrs: Readonly<Record<string, string>>;
  states: readonly string[];
}

export function el(tag: string, classes: string[] = [], more: { attrs?: Record<string, string>; states?: string[] } = {}): El {
  return { tag, classes, attrs: more.attrs ?? {}, states: more.states ?? [] };
}

/** The simple selectors of one compound: `button`, `.v`, `[data-x="y"]`, `:not(…)`. */
const SIMPLE = /^(?:\*|[a-z][a-z0-9-]*|\.[\w-]+|#[\w-]+|\[[^\]]*\]|::?[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?)/i;

/** How heavily one compound selects `e`, or null. Anything a compound can say
 *  that this does not read — `:has()`, a sibling, an argument with a
 *  combinator in it — throws, but only once everything else in the compound
 *  has matched: a rule for some other element never stops a test. */
function compound(c: string, e: El): number | null {
  let rest = c, weight = 0, unread: string | null = null;
  while (rest) {
    const m = SIMPLE.exec(rest);
    if (!m) throw new Error(`unread compound: ${c}`);
    const s = m[0];
    rest = rest.slice(s.length);
    if (s === "*") continue;
    if (/^[a-z]/i.test(s)) { if (s.toLowerCase() !== e.tag) return null; weight += 1; continue; }
    if (s.startsWith(".")) { if (!e.classes.includes(s.slice(1))) return null; weight += 10; continue; }
    if (s.startsWith("#")) return null;
    if (s.startsWith("[")) {
      const a = /^\[([\w-]+)(?:([~^$*|]?=)"([^"]*)")?\]$/.exec(s);
      if (!a) { unread ??= s; continue; }
      const have = e.attrs[a[1]];
      if (have === undefined) return null;
      const want = a[3];
      const ok = !a[2] ? true
        : a[2] === "=" ? have === want
        : a[2] === "^=" ? have.startsWith(want)
        : a[2] === "$=" ? have.endsWith(want)
        : a[2] === "*=" ? have.includes(want)
        : a[2] === "~=" ? have.split(/\s+/).includes(want)
        : have === want || have.startsWith(`${want}-`);
      if (!ok) return null;
      weight += 10;
      continue;
    }
    if (s.startsWith("::") || /^:(before|after)$/.test(s)) return null;  // a pseudo-element, not `e`
    const fn = /^:([\w-]+)\((.*)\)$/.exec(s);
    if (fn && (fn[1] === "not" || fn[1] === "is" || fn[1] === "where")) {
      const args = splitTop(fn[2]);
      if (args.some(a => /[\s>+~]/.test(a))) { unread ??= s; continue; }
      const hits = args.map(a => compound(a, e));
      const best = Math.max(...args.map(a => compoundWeight(a)));
      if (fn[1] === "not") { if (hits.some(h => h != null)) return null; weight += best; continue; }
      if (hits.every(h => h == null)) return null;
      if (fn[1] === "is") weight += best;
      continue;
    }
    if (fn) { unread ??= s; continue; }
    if (!e.states.includes(s.slice(1))) return null;
    weight += 10;
  }
  if (unread) throw new Error(`unread selector part ${unread} in ${c}`);
  return weight;
}

/** A compound's own specificity, whatever it matches. */
function compoundWeight(c: string): number {
  let w = 0;
  for (let rest = c, m = SIMPLE.exec(rest); rest && m; rest = rest.slice(m[0].length), m = SIMPLE.exec(rest)) {
    const s = m[0];
    if (s === "*") continue;
    w += /^[a-z]/i.test(s) || s.startsWith("::") ? 1 : 10;
  }
  return w;
}

/** How heavily `selector` selects the last element of `chain`, or null.
 *  Descendant and child combinators; siblings are not in a chain, so a
 *  selector that needs one throws once its subject has matched. */
export function selects(selector: string, chain: readonly El[]): number | null {
  const steps = splitTop(selector.replace(/\s*([>+~])\s*/g, " $1 "), " ").filter(Boolean);
  const at = (si: number, ei: number): number | null => {
    const w = compound(steps[si], chain[ei]);
    if (w == null) return null;
    if (si === 0) return w;
    const comb = steps[si - 1];
    if (comb === "+" || comb === "~") throw new Error(`unread combinator in ${selector}`);
    if (comb === ">") {
      const up = ei > 0 ? at(si - 2, ei - 1) : null;
      return up == null ? null : w + up;
    }
    for (let a = ei - 1; a >= 0; a--) {
      const up = at(si - 1, a);
      if (up != null) return w + up;
    }
    return null;
  };
  return at(steps.length - 1, chain.length - 1);
}
