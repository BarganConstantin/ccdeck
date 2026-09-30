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
// A matcher, not a selector engine: each test knows the handful of selector
// shapes that can reach its element and should fail on one it cannot read,
// rather than a general parser guess.
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
