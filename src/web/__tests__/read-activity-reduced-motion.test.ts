// The read marks of the local reports (#2186): the quota mark runs its own
// keyframes, every mark is answered under reduced motion by its own selector,
// and the box keeps announcing the read either way.
//
// ReadActivity draws one decorative mark per occasional local read — quota
// history, the process list, sensor history — inside a role="status" box whose
// label is the words. The quota mark carries a reading from the clock to the
// record, so it travels across the link (read-activity-transfer) rather than
// down the lines like the other two.
//
// Its first version named those keyframes through the animation-name longhand
// and answered the marks under reduced motion with rules of OTHER selectors
// than the ones that set them moving: `.read-activity .read-activity-mark` for
// `.read-activity-mark`, and a transform-only rule for the quota mark. Checked
// in headless Chromium, that cascade did stop all three: the stop rode on a
// specificity tie and on source order inside one part. It is the shape this
// suite refuses everywhere else (canvas-motion: "a media query adds no
// specificity", so coverage is matched on the exact selector), because the
// next rule that adds a class to the mark's own selector wins the tie and the
// mark moves again for a reader who asked it not to.
//
// So this file asks two things of the sheet. The cascade, resolved here the way
// a browser resolves it (specificity, then order) over the rendered markup:
// what a reader sees with and without reduced motion. And the convention:
// every rule that moves a mark has an answer of its own selector, later, that
// stops it.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReadActivity from "../components/ReadActivity";
import { sheetText } from "./sheet-source";

type Kind = "quota" | "processes" | "history";
const KINDS: Kind[] = ["quota", "processes", "history"];
const TITLE: Record<Kind, string> = {
  quota: "Reading quota history…",
  processes: "Reading the process list…",
  history: "Reading sensor history…",
};

/** Comments quote declarations while explaining them; strip before reading. */
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; body: string; reduced: boolean; at: number };

/** Flat rule list with the reduced-motion flag, the way canvas-motion reads it. */
function collect(src: string, base: number, reduced: boolean, out: Rule[]): Rule[] {
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    let depth = 0, end = open;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) { end = j; break; }
    }
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const inner = src.slice(open + 1, end);
    if (prelude.startsWith("@keyframes")) {
      // not a rule
    } else if (prelude.startsWith("@")) {
      collect(inner, base + open + 1, reduced || /prefers-reduced-motion\s*:\s*reduce/.test(prelude), out);
    } else if (prelude) {
      for (const selector of prelude.split(",").map(s => s.replace(/\s+/g, " ").trim())) {
        out.push({ selector, body: inner, reduced, at: base + open });
      }
    }
    i = end + 1;
  }
  return out;
}

const rules = collect(css, 0, false, []).filter(r => r.selector.includes("read-activity"));

/** The body of `@keyframes <name>`, bounded to its own braces. */
function keyframes(name: string): string {
  const at = css.indexOf(`@keyframes ${name} `);
  expect(at, `no @keyframes ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error(`unbalanced @keyframes ${name}`);
}

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`).exec(body);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

/** The keyframes an `animation` shorthand names: the token that is not a time,
 *  a count, a timing function or a keyword. */
const KEYWORDS = new Set(["infinite", "both", "forwards", "backwards", "none", "normal", "reverse", "alternate",
  "alternate-reverse", "running", "paused", "linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end"]);
const shorthandName = (value: string): string => {
  if (value === "none") return "none";
  const tokens = value.replace(/[a-z-]+\([^)]*\)/g, " ").split(/\s+/).filter(Boolean);
  return tokens.find(t => !KEYWORDS.has(t) && !/^-?[\d.]+(m?s)?$/.test(t)) ?? "none";
};

/** One element of the rendered box: its classes and attributes. */
type El = { classes: string[]; attrs: Record<string, string> };

/** The box, its svg and its mark, read off the component's own markup. */
function rendered(kind: Kind): { html: string; path: El[] } {
  const html = renderToStaticMarkup(createElement(ReadActivity, { kind, title: TITLE[kind] }));
  const el = (tag: string): El => {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
    return { classes: (attrs.class ?? "").split(/\s+/).filter(Boolean), attrs };
  };
  const box = el(/^<div[^>]*>/.exec(html)![0]);
  const svg = el(/<svg[^>]*>/.exec(html)![0]);
  const mark = el(/<[a-z]+ class="read-activity-mark"[^>]*>/.exec(html)![0]);
  return { html, path: [box, svg, mark] };
}

/** Classes and attribute tests of one compound selector, or null for anything
 *  else (a pseudo-class, a type, a combinator other than descendant). */
function compound(text: string): { classes: string[]; attrs: [string, string | null][] } | null {
  const classes: string[] = []; const attrs: [string, string | null][] = [];
  const rest = text.replace(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g, (_, c, a, v) => {
    if (c) classes.push(c); else attrs.push([a, v ?? null]);
    return "";
  });
  return rest ? null : { classes, attrs };
}

const matchesEl = (c: NonNullable<ReturnType<typeof compound>>, el: El) =>
  c.classes.every(k => el.classes.includes(k)) &&
  c.attrs.every(([a, v]) => a in el.attrs && (v == null || el.attrs[a] === v));

/** Does `selector` match the last element of `path` (descendant combinators only)? */
function matches(selector: string, path: El[]): boolean {
  const parts = selector.split(" ").map(compound);
  if (parts.some(p => p == null)) return false;
  let at = path.length - 1;
  if (!matchesEl(parts[parts.length - 1]!, path[at])) return false;
  for (let k = parts.length - 2; k >= 0; k--) {
    do at--; while (at >= 0 && !matchesEl(parts[k]!, path[at]));
    if (at < 0) return false;
  }
  return true;
}

const specificity = (selector: string) => (selector.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length;

/** The value a browser computes for the mark: the winning declaration by
 *  specificity, then by order, with the reduced-motion rules in or out. */
function cascade(kind: Kind, prop: "animation-name" | "transform", reduced: boolean): string {
  const { path } = rendered(kind);
  let best: { spec: number; at: number; value: string } | null = null;
  for (const r of rules) {
    if (r.reduced && !reduced) continue;
    if (!matches(r.selector, path)) continue;
    let value = decl(r.body, prop);
    if (prop === "animation-name") {
      const short = decl(r.body, "animation");
      // A shorthand and a longhand in one body: the later one wins.
      if (short != null && (value == null || r.body.lastIndexOf("animation:") > r.body.lastIndexOf("animation-name"))) value = shorthandName(short);
    }
    if (value == null) continue;
    const spec = specificity(r.selector);
    if (!best || spec > best.spec || (spec === best.spec && r.at >= best.at)) best = { spec, at: r.at, value };
  }
  return best?.value ?? "none";
}

describe("the quota mark runs its own keyframes", () => {
  it("travels across the link, and the other two scan down their lines", () => {
    expect(cascade("quota", "animation-name", false)).toBe("read-activity-transfer");
    expect(cascade("processes", "animation-name", false)).toBe("read-activity-scan");
    expect(cascade("history", "animation-name", false)).toBe("read-activity-scan");
    expect(keyframes("read-activity-transfer")).toMatch(/translateX/);
    expect(keyframes("read-activity-transfer")).not.toMatch(/translateY|width|height|margin/);
  });
});

describe("reduced motion answers every read mark", () => {
  it("stops all three and rests each one where its movement points", () => {
    for (const kind of KINDS) expect(cascade(kind, "animation-name", true), kind).toBe("none");
    // The quota mark rests along the link, the others down the lines: a still
    // mark that still says which way the reading goes.
    expect(cascade("quota", "transform", true)).toBe("translateX(8px)");
    expect(cascade("processes", "transform", true)).toBe("translateY(4px)");
    expect(cascade("history", "transform", true)).toBe("translateY(4px)");
  });

  it("answers each rule that moves a mark with a rule of its own selector, later, that stops it", () => {
    const moving = rules.filter(r => !r.reduced && r.selector.endsWith(".read-activity-mark") &&
      ((decl(r.body, "animation") ?? decl(r.body, "animation-name") ?? "none") !== "none"));
    // If a rename ever slips the marks out of this sweep, this collapses first.
    expect(moving.map(r => r.selector).length).toBeGreaterThanOrEqual(2);
    const unanswered = moving.filter(m => !rules.some(r => r.reduced && r.selector === m.selector && r.at > m.at &&
      decl(r.body, "animation") === "none"));
    expect(unanswered.map(m => `${m.selector} { ${decl(m.body, "animation") ?? decl(m.body, "animation-name")} }`)).toEqual([]);
  });

  it("names the quota mark's keyframes in the shorthand its answer resets", () => {
    // `animation: none` resets every longhand, but a longhand set on a more
    // specific selector than the answer outlives it. One shorthand on one
    // selector, answered by the same selector, cannot drift that way.
    const quota = rules.filter(r => !r.reduced && matches(r.selector, rendered("quota").path) &&
      /read-activity-transfer/.test(r.body));
    expect(quota.length, "no rule runs read-activity-transfer on the quota mark").toBeGreaterThan(0);
    for (const r of quota) {
      expect(decl(r.body, "animation-name"), r.selector).toBeNull();
      expect(decl(r.body, "animation"), r.selector).toMatch(/^read-activity-transfer \d+ms/);
    }
  });
});

describe("the box keeps announcing the read", () => {
  it("is a labelled status whose words are visible and whose drawing is not read out", () => {
    for (const kind of KINDS) {
      const { html, path: [box, svg] } = rendered(kind);
      expect(box.attrs.role, kind).toBe("status");
      expect(box.attrs["aria-label"], kind).toBe(TITLE[kind]);
      expect(html, kind).toContain(`<strong>${TITLE[kind]}</strong>`);
      expect(svg.attrs["aria-hidden"], kind).toBe("true");
    }
  });

  it("is never hidden, faded out or emptied by the reduced-motion rules", () => {
    for (const r of rules.filter(r => r.reduced)) {
      expect(r.body, r.selector).not.toMatch(/(^|;)\s*(display|visibility|content)\s*:/);
      expect(r.body, r.selector).not.toMatch(/(^|;)\s*opacity\s*:\s*0\s*(;|$)/);
    }
  });
});
