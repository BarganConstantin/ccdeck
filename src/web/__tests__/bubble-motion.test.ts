// #354: three defects in the motion of the element the deck draws most — a
// live deck was sampled with 79 tool bubbles on screen at once — all three in
// one block of styles.css, and all three invisible to a test that only reads
// durations off the sheet. What each of them needed was a statement about the
// MECHANISM, so the sweeps below are written against mechanisms rather than
// against the seven literal declarations that happened to be wrong.
//
// There is no jsdom here and no layout engine, so nothing rendered can be
// observed. The sheet, ToolBursts.tsx and burst-layout.ts are the evidence. Every parser below
// is re-derived rather than imported from another test file: a test that
// borrowed another one's collector would go green the moment that one was
// loosened. Comments are stripped before anything is read, because the comments
// in this sheet quote the declarations they explain — several of them now quote
// the exact `ease-in` and the exact `460ms` that the assertions here say appear
// nowhere.
//
// 1. THE FLASH FIRED FROM THE WRONG CLOCK.
//    `.tool-burst.status-done` read `bubble-spawn 460ms …, bubble-done-flash
//    520ms 460ms ease-out`, under a comment claiming "spawn THEN flash … so
//    neither interrupts the other". That is true only if the list starts when
//    the bubble does. It does not. `bubble-spawn` is named at the same list
//    index on the base rule and on the status rule, so it survives the class
//    change untouched; `bubble-done-flash` is NEW to the list at that moment,
//    so it starts THEN and measures its delay from the class change — which is
//    the tool finishing, at an arbitrary time. Measured through a real deck at
//    127.0.0.1:4409 on a Bash call: the tool settled at timeline 5356ms, the ✓'s
//    own `mark-pop` started one frame later at 5373 with no delay, and the flash
//    did not paint until 5833. One event, two signals, 460ms apart — 680ms on
//    the sub-bubble, whose delay had been SUMMED with its spawn delay in the
//    belief that the list restarts, which made a sub's glow trail its primary's
//    by 220ms on a tool that finished once.
//    So the rule swept below is the mechanism: an animation that first appears
//    when a class is added begins at the class change, therefore it may not
//    carry a delay.
//
// 2. THE ENTRANCE BOUNCED TWICE.
//    `animation-timing-function` on the shorthand is not the curve of the
//    animation, it is the default curve of every SEGMENT of it. `bubble-spawn`
//    had three keyframes and overrode nothing, so cubic-bezier(0.34, 1.56,
//    0.64, 1) — which peaks at progress 1.0978 — was applied to both segments.
//    `getKeyframes()` on a live bubble returned it attached to offsets 0, 0.55
//    AND 1, and the measured scale path was 0.35 → 1.1948 at 140ms → 1.1201 at
//    250ms → a trough of 0.9883 at 370ms → 1.00: an arrival that ends by
//    shrinking below its own size. The sweep below counts, per animation, how
//    many segments an overshooting curve governs.
//
// 3. THE EXIT WAS THE ONLY `ease-in` IN THE SHEET.
//    Every other timing function here decelerates into rest — all seven
//    distinct cubic-bezier() curves in the sheet put their second control point
//    at x < 1, so the curve flattens as it lands. `ease-in` is
//    cubic-bezier(0.42, 0, 1, 1): its second control point sits ON the endpoint,
//    so it leaves rest at zero speed and arrives at full speed, which is the
//    hang the report describes. Measured pre-fix, 150ms into the 600ms exit the
//    bubble was still at opacity 0.907 while the SVG leader line pointing at it
//    — whose opacity burst-layout.ts computes in JS as a dead-linear `1 - since /
//    FADE_MS` over the same 600ms — had already given up a quarter of its own.
//    The bubble was outliving its own connector, which is the exact desync
//    .tool-burst-wrap was fixed for in #259.
//    Worth recording because the report proposed it: the fix it suggested,
//    cubic-bezier(0.4, 0, 1, 1), is `ease-in` with x1 nudged by 0.02. Measured
//    side by side in Chrome at 150ms of 600ms it gives 0.9014 against ease-in's
//    0.9065 — it would have changed the declaration and not the defect. The
//    curve is split off from the fade instead, for the reason .confetti-bit
//    already writes out in this sheet: one timing function governs every
//    property in a keyframe set, so movement keeps an ease-out and the fade runs
//    linear on its own clock, which is the connector's clock.
//
// NOT swept here, and left to the issues that own them: #355 (fourteen controls
// with no press feedback), #356 (four live-pulse rates and three modal
// entrances) and #379 (the duration/easing token scale). The literal durations
// asserted below are literals on purpose — when #379 lands they become token
// lookups, and this file should be updated rather than worked around.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sheetText } from "./sheet-source";

const web = fileURLToPath(new URL("..", import.meta.url));
const rawCss = sheetText();
/** Blanked to spaces rather than cut, so a reported line number still points at
 *  the rule it belongs to. */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const lineOf = (at: number) => css.slice(0, at).split("\n").length;

// The canvas layer and the layout it draws from, read as one: the fade's
// duration and ramp moved to burst-layout.ts, the connector that wears it is
// still drawn in ToolBursts.tsx.
const rawBursts = readFileSync(join(web, "components/ToolBursts.tsx"), "utf8")
  + "\n" + readFileSync(join(web, "burst-layout.ts"), "utf8");
/** `[^\r\n]` rather than `.` so a CRLF checkout on Windows strips the same
 *  line comments a LF one does — `.` excludes \r, so `.*$` would fail to reach
 *  the end of a \r-terminated line and quietly strip nothing at all. */
const bursts = rawBursts
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");

// ─── parsing ──────────────────────────────────────────────────────────────

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Commas inside cubic-bezier(), color-mix() and translate() are not list
 *  separators. */
function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

/** Split on whitespace, but never inside cubic-bezier(0.34, 1.56, 0.64, 1). */
function tokens(part: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i <= part.length; i++) {
    const c = part[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if ((i === part.length || /\s/.test(c)) && depth === 0) {
      const tok = part.slice(start, i).trim();
      if (tok) out.push(tok);
      start = i + 1;
    }
  }
  return out;
}

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`).exec(body);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

/** Property names declared in a block, keyed off `{` as well as `;` because a
 *  keyframe's first declaration follows the brace. */
const declared = (body: string): Set<string> =>
  new Set([...body.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:/g)].map(m => m[1]));

type Rule = { selector: string; body: string; reduced: boolean; at: number };
type Frame = { offsets: number[]; body: string };

const rules: Rule[] = [];
const keyframes = new Map<string, Frame[]>();

const offsetOf = (stop: string): number =>
  stop === "from" ? 0 : stop === "to" ? 1 : parseFloat(stop) / 100;

function frames(src: string): Frame[] {
  const out: Frame[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const offsets = src.slice(i, open).split(",").map(s => s.trim()).filter(Boolean).map(offsetOf);
    const [inner, end] = block(src, open);
    out.push({ offsets, body: inner });
    i = end + 1;
  }
  return out;
}

function collect(src: string, base: number, reduced: boolean): void {
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    const named = /^@keyframes\s+([\w-]+)/.exec(prelude);
    if (named) keyframes.set(named[1], frames(inner));
    else if (prelude.startsWith("@")) {
      collect(inner, base + open + 1, reduced || /prefers-reduced-motion\s*:\s*reduce/.test(prelude));
    } else if (prelude) {
      rules.push({ selector: prelude, body: inner, reduced, at: base + open });
    }
    i = end + 1;
  }
}
collect(css, 0, false);

const EASING = /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\(|steps\()/;
const TIME = /^-?[\d.]+m?s$/;

type Part = { name: string; duration: string | null; delay: string | null; easing: string; raw: string };

/** One entry of an `animation` shorthand list. Per the shorthand's grammar the
 *  FIRST time is the duration and the SECOND is the delay, whatever else is
 *  interleaved between them. */
function animationParts(value: string | null): Part[] {
  if (value == null || value === "none") return [];
  return splitTop(value).map(part => {
    const toks = tokens(part);
    const times = toks.filter(t => TIME.test(t));
    return {
      name: toks.find(t => keyframes.has(t)) ?? "",
      duration: times[0] ?? null,
      delay: times[1] ?? null,
      easing: toks.find(t => EASING.test(t)) ?? "ease",
      raw: part.replace(/\s+/g, " ").trim(),
    };
  }).filter(p => p.name !== "");
}

const animationsOf = (rule: Rule): Part[] => animationParts(decl(rule.body, "animation"));

const ms = (t: string | null): number => {
  if (t == null) return 0;
  return t.endsWith("ms") ? parseFloat(t) : parseFloat(t) * 1000;
};

/** Every selector in a list, normalised so two spellings of one match. */
const selectors = (rule: Rule): string[] =>
  splitTop(rule.selector).map(s => s.replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim());

/** Does an overshooting curve govern this segment? A cubic-bezier whose control
 *  points leave the 0..1 band on the y axis carries the value past its target
 *  and back — that is exactly one bounce per segment it governs. */
function overshoots(easing: string): boolean {
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(easing);
  if (!m) return false;
  const [, y1, , y2] = m[1].split(",").map(Number);
  return y1 > 1 || y2 > 1 || y1 < 0 || y2 < 0;
}

/** The keyframe offsets of `name`, in order, each with the easing that governs
 *  the segment STARTING at it — its own `animation-timing-function` if it has
 *  one, otherwise the animation's. The last offset starts no segment. */
function segments(name: string, shorthandEasing: string): { from: number; easing: string }[] {
  const stops: { offset: number; easing: string }[] = [];
  for (const f of keyframes.get(name) ?? []) {
    const own = decl(f.body, "animation-timing-function");
    for (const offset of f.offsets) stops.push({ offset, easing: own ?? shorthandEasing });
  }
  stops.sort((a, b) => a.offset - b.offset);
  return stops.slice(0, -1).map(s => ({ from: s.offset, easing: s.easing }));
}

// ─── the sweeps ───────────────────────────────────────────────────────────

/** The bubble's two base rules — the ones that carry an animation with no
 *  status class on them. Everything else on .tool-burst is a state added later,
 *  and a state's animation list is compared against the base it extends. */
const BASES = [".tool-burst.sub", ".tool-burst"];
const baseAnimations = new Map<string, Set<string>>();
for (const base of BASES) {
  const rule = rules.find(r => !r.reduced && selectors(r).includes(base) && decl(r.body, "animation") != null);
  if (rule) baseAnimations.set(base, new Set(animationsOf(rule).map(p => p.name)));
}

/** A `.tool-burst` rule whose selector carries a class the base does not — the
 *  status classes React swaps in when the tool settles.
 *  `.sub` is not one of them, which is why it is a base and not a state: a
 *  bubble is a sub-bubble from the frame it is mounted, so its own spawn delay
 *  is measured from its birth like any other.
 *  `.fading` is excluded too: React mounts that class on an element it is about
 *  to unmount on a wall-clock timer, and its timing is answered against that
 *  timer further down rather than against a class change. */
type StateRule = { rule: Rule; sel: string; base: string };
const stateRules: StateRule[] = [];
for (const rule of rules) {
  if (rule.reduced || decl(rule.body, "animation") == null) continue;
  for (const sel of selectors(rule)) {
    if (!/^\.tool-burst[.\w-]*$/.test(sel)) continue;
    if (BASES.includes(sel) || /\.fading(?![\w-])/.test(sel)) continue;
    const base = BASES.find(b => sel.startsWith(b) && sel !== b);
    if (base) stateRules.push({ rule, sel, base });
  }
}

/** Animations that only exist once a state class lands, so the browser starts
 *  them at the class change rather than at the element's birth. */
const startedByAClassChange = stateRules.flatMap(({ rule, sel, base }) =>
  animationsOf(rule)
    .filter(p => !(baseAnimations.get(base) ?? new Set()).has(p.name))
    .map(p => ({ sel, part: p, at: rule.at })));

// V4's motion spec took the done flash, the error shake, the emoji wobble, the
// spawn's blur and the exit's travel off the bubble: a bubble RISES (opacity and
// 4px of y, Base), changes colour in Fast when its tool settles, and LEAVES with
// its opacity in Exit. The sweeps below keep the three mechanisms the #354 defects
// were about (a state's animation starting on the tool's clock, an entrance that
// does not overshoot, a bubble and its connector leaving together) and read them
// against the new shape; the flash and shake sweeps went with the flash and the
// shake.

describe("a tool bubble reports the tool, on the tool's clock", () => {
  it("gives no delay to an animation that starts when a class lands", () => {
    // The delay would be measured from the class change, and the class change
    // is the event being reported. Any delay here is pure lateness.
    const late = startedByAClassChange
      .filter(a => ms(a.part.delay) > 0)
      .map(a => `styles.css:${lineOf(a.at)} ${a.sel} — ${a.part.raw} is ${ms(a.part.delay)}ms late`);
    expect(late).toEqual([]);
  });

  it("starts no animation at all when the tool settles: done and failed are colour changes", () => {
    // The done flash and the error shake are gone (V4's motion spec, Tool bursts:
    // a failure is a colour change in Fast; no shake, no box-shadow in motion).
    expect(startedByAClassChange).toEqual([]);
    expect(stateRules).toEqual([]);
    const base = rules.find(r => !r.reduced && selectors(r).includes(".tool-burst") && decl(r.body, "transition") != null)!;
    const timed = splitTop(decl(base.body, "transition")!).map(p => p.trim().split(/\s+/)[0]);
    for (const p of ["border-color", "background-color"]) expect(timed, p).toContain(p);
    expect(decl(base.body, "transition")).toMatch(/border-color var\(--dur-fast\)/);
    for (const p of ["box-shadow", "filter", "transform"]) expect(timed, p).not.toContain(p);
  });

  it("lets the ✓ come in on the same instant", () => {
    // `.tb-mark` is a freshly inserted element, so its fade has always run the
    // moment the tool landed.
    const mark = animationsOf(rules.find(r => selectors(r).includes(".tool-burst .tb-mark") && !r.reduced)!)[0];
    expect(mark.name).toBe("burst-fade-in");
    expect(ms(mark.delay)).toBe(0);
  });
});

describe("the entrance holds nothing after it ends", () => {
  // `burst-rise` fills `backwards` only, so the bubble's opacity and transform
  // are its own rules' once it has risen: .dim fades it, .fading takes it out,
  // and the hover lift (translate, an independent property) composes with
  // whatever is there. A `both` fill would pin the 100% keyframe against all of
  // them, which is the hazard the old spawn needed three workarounds for.
  it("fills backwards and not forwards, on the primary and the sub", () => {
    for (const base of BASES) {
      const rule = rules.find(r => !r.reduced && selectors(r).includes(base) && decl(r.body, "animation") != null)!;
      const value = decl(rule.body, "animation")!;
      expect(value, base).toMatch(/burst-rise/);
      expect(value, base).toMatch(/\bbackwards\b/);
      expect(value, base).not.toMatch(/\b(both|forwards)\b/);
    }
  });

  it("names only opacity and transform, and no blur, brightness, shadow or scale", () => {
    const named = new Set<string>();
    for (const name of ["burst-rise", "burst-fade-in"]) {
      for (const f of keyframes.get(name) ?? []) for (const p of declared(f.body)) named.add(p);
    }
    expect([...named].sort()).toEqual(["opacity", "transform"]);
    const rise = (keyframes.get("burst-rise") ?? []).map(f => decl(f.body, "transform") ?? "").join(" ");
    expect(rise).toMatch(/translateY\(4px\)/);
    expect(rise).not.toMatch(/scale/);
  });

  it("lifts under the pointer with the independent property, as before", () => {
    const lift = rules.find(r => selectors(r).includes(".tool-burst.clickable:hover"))!;
    expect(decl(lift.body, "translate")).toBeTruthy();
    expect(decl(lift.body, "transform")).toBeNull();
  });
});

describe("an entrance lands without overshooting", () => {
  /** Every (rule, animation) pair in the sheet, with the segments its curve
   *  governs. A shorthand easing applies to EVERY segment unless a keyframe
   *  overrides it, which is the whole of defect 2. */
  const governed: { sel: string; name: string; bouncing: number; total: number; at: number }[] = [];
  for (const rule of rules) {
    if (rule.reduced) continue;
    for (const part of animationsOf(rule)) {
      const segs = segments(part.name, part.easing);
      const bouncing = segs.filter(s => overshoots(s.easing)).length;
      for (const sel of selectors(rule)) {
        governed.push({ sel, name: part.name, bouncing, total: segs.length, at: rule.at });
      }
    }
  }

  it("never lets an overshooting curve govern more than one segment", () => {
    const doubled = governed
      .filter(g => g.bouncing > 1)
      .map(g => `styles.css:${lineOf(g.at)} ${g.sel} — ${g.name} bounces on ${g.bouncing} of ${g.total} segments`);
    expect([...new Set(doubled)]).toEqual([]);
  });

  it("sweeps the bubble's rise, so a pass means something", () => {
    // burst-rise is one segment from a start to the element's own style.
    const rise = governed.filter(g => g.name === "burst-rise");
    expect(rise.length).toBeGreaterThan(0);
    for (const g of rise) expect(g.bouncing, "burst-rise overshooting segments").toBe(0);
  });

  it("runs on the sheet's own ease-out, as a token", () => {
    // Spelled var(--ease): the token IS cubic-bezier(0.23, 1, 0.32, 1), which is
    // monotone and cannot overshoot.
    expect(css).toMatch(/burst-rise var\(--dur-base\) var\(--ease\) backwards/);
    const shared = [...css.matchAll(/var\(--ease\)/g)];
    expect(shared.length).toBeGreaterThan(5);
  });

  it("starts from something rather than from nothing", () => {
    // Nothing in the real world appears from nothing: the rise starts at 4px
    // below its place, opaque from zero, and is never scaled (V4's rule: no scale
    // from 0, and the bubble has no scale at all). The sheet states the same of
    // .aa-done's own entrance, which is checked here too so the convention has
    // two holders rather than one.
    const first = (keyframes.get("burst-rise") ?? []).find(k => k.offsets.includes(0))!;
    expect(decl(first.body, "opacity")).toBe("0");
    expect(decl(first.body, "transform")).toBe("translateY(4px)");
    const scaleAt = (name: string, offset: number): number => {
      const f = (keyframes.get(name) ?? []).find(k => k.offsets.includes(offset))!;
      const t = decl(f.body, "transform") ?? "";
      return parseFloat(/scale\(([\d.]+)\)/.exec(t)![1]);
    };
    expect(scaleAt("aa-done-in", 0)).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps the most repetitive element in the app on Base, and the sub a step behind", () => {
    for (const base of BASES) {
      const rule = rules.find(r => !r.reduced && selectors(r).includes(base) && decl(r.body, "animation") != null)!;
      expect(decl(rule.body, "animation"), `${base} rise`).toMatch(/burst-rise var\(--dur-base\)/);
    }
    // The sub rises one stagger step after its primary, so the pair still reads
    // as one gesture; the step is the token, not a literal.
    const sub = decl(rules.find(r => !r.reduced && selectors(r).includes(".tool-burst.sub"))!.body, "animation")!;
    expect(sub).toMatch(/burst-rise var\(--dur-base\) var\(--ease\) var\(--delay-step\) backwards/);
  });
});

describe("this sheet decelerates into rest", () => {
  it("uses no ease-in anywhere", () => {
    // `ease-in` leaves rest at zero speed and arrives at full speed, which is
    // the one shape nothing else here has. The negative lookahead is load
    // bearing: `ease-in-out` is a different keyword and the sheet uses it for
    // the symmetric loops, where a curve has no landing to flatten into.
    const found = [...css.matchAll(/\bease-in\b(?!-out)/g)].map(m => `styles.css:${lineOf(m.index!)}`);
    expect(found).toEqual([]);
  });

  it("read a sheet with the comments taken out of it, which is why that holds", () => {
    // The comments here quote the declarations they explain, and the ones added
    // for #354 quote the removed `ease-in` and the removed `460ms` by name. An
    // "appears nowhere" assertion over the raw file would be answered by the
    // comment explaining the removal, so the strip is part of the evidence.
    expect(rawCss).toMatch(/\/\*/);
    expect(css).not.toMatch(/\/\*/);
    // Blanked, not cut: every offset above still points at its own line.
    expect(css.length).toBe(rawCss.length);
    expect(css.split("\n").length).toBe(rawCss.split("\n").length);
  });

  it("flattens every curve as it lands", () => {
    // A cubic-bezier whose second control point sits at x = 1 arrives at full
    // speed — that is what `ease-in` is. Every curve written out in this sheet
    // puts it short of the end instead.
    const arriving: string[] = [];
    for (const m of css.matchAll(/cubic-bezier\(([^)]*)\)/g)) {
      const [, , x2] = m[1].split(",").map(Number);
      if (!(x2 < 1)) arriving.push(`styles.css:${lineOf(m.index!)} ${m[0]}`);
    }
    expect(arriving).toEqual([]);
    // The sheet spells its curves var(--ease) and var(--ease-stage) now (tokens.css
    // owns the cubic-bezier), so the curves it uses are those literals plus the tokens.
    expect([...css.matchAll(/cubic-bezier\([^)]*\)|var\(--ease(-stage)?\)/g)].length).toBeGreaterThan(30);
  });
});

describe("a bubble and its leader line leave together", () => {
  const fadingRules = rules.filter(r => !r.reduced && selectors(r).some(s => /^\.tool-burst[.\w-]*\.fading$/.test(s)));

  it("covers both the primary and the sub with one rule", () => {
    // The sub is a `.tool-burst` too, so `.tool-burst.fading` takes it out with
    // its primary; there is no second rule to keep in step.
    expect(fadingRules.map(r => r.selector)).toEqual([".tool-burst.fading"]);
  });

  it("leaves with opacity in Exit and nothing else, as a transition", () => {
    // A transition and not an animation, so a bubble brought back mid-fade
    // turns round from where it is (V4's rule 6); no scale, no travel, no blur
    // (the old exit slid 18px and blurred).
    const rule = fadingRules[0];
    expect(animationsOf(rule)).toEqual([]);
    expect(decl(rule.body, "animation")).toBeNull();
    expect(decl(rule.body, "opacity")).toBe("0");
    expect(decl(rule.body, "transition")).toMatch(/^opacity var\(--dur-exit\) var\(--ease\)$/);
    for (const p of ["transform", "translate", "scale", "filter"]) expect(declared(rule.body).has(p), p).toBe(false);
  });

  it("takes its connector with it, in the same Exit", () => {
    const base = rules.find(r => !r.reduced && r.selector === ".tool-conn")!;
    expect(decl(base.body, "transition")).toMatch(/opacity var\(--dur-base\) var\(--ease\)/);
    const leaving = rules.find(r => !r.reduced && r.selector === ".tool-conn.fading")!;
    expect(decl(leaving.body, "transition-duration")).toBe("var(--dur-exit)");
  });

  it("fades for Exit and is removed on the card's own timer", () => {
    // FADE_MS is the Exit (--dur-exit, 150) the ramp below runs over; the
    // element itself stays until the card's removal timer (EXIT_ANIM_MS,
    // visibility.ts), long after it is invisible, so a coarse clock tick can
    // never remove a bubble before its fade has been drawn.
    expect(bursts).toMatch(/const FADE_MS = 150;/);
    expect(bursts).toMatch(/now - a\.exitAt > EXIT_ANIM_MS/);
    // The connector's opacity is still a linear ramp over that window.
    expect(bursts).toMatch(/Math\.max\(0, 1 - since \/ FADE_MS\)/);
    expect(bursts).toMatch(/const opacity = b\.fade\b/);
    expect(bursts).toMatch(/className=\{`tool-conn status-\$\{b\.status\}/);
  });

  it("is answered under reduced motion by the same fade: there is nothing to take away", () => {
    // Exit is opacity only, so `.tool-burst.fading` needs no reduced-motion rule.
    const answers = rules.filter(r => r.reduced && selectors(r).some(s => /\.tool-burst[.\w-]*\.fading$/.test(s)));
    expect(answers).toEqual([]);
  });
});

describe("the sheet names no animation it does not define, and defines none it does not name", () => {
  it("resolves every animation name to a keyframe set", () => {
    const missing: string[] = [];
    for (const rule of rules) {
      const value = decl(rule.body, "animation") ?? decl(rule.body, "animation-name");
      if (value == null || value.replace(/\s*!important$/, "") === "none") continue;
      for (const part of splitTop(value)) {
        const toks = tokens(part);
        if (!toks.some(t => keyframes.has(t))) missing.push(`styles.css:${lineOf(rule.at)} ${rule.selector} — ${part.trim()}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("leaves no keyframe set behind that nothing runs", () => {
    // This is the assertion that would have caught a rename half-done: when
    // the bubble's spawn, flash, shake and exit became burst-rise and
    // burst-fade-in, an orphaned `@keyframes bubble-spawn` would have shown up
    // right here.
    const used = new Set<string>();
    for (const rule of rules) {
      for (const part of animationsOf(rule)) used.add(part.name);
      for (const n of splitTop(decl(rule.body, "animation-name") ?? "").map(s => s.trim())) used.add(n);
    }
    const orphans = [...keyframes.keys()].filter(n => !used.has(n));
    expect(orphans).toEqual([]);
    for (const gone of ["bubble-fade", "bubble-fade-move", "bubble-fade-out", "bubble-spawn", "bubble-done-flash", "bubble-err-shake", "emoji-wobble", "mark-pop"]) {
      expect(keyframes.has(gone), gone).toBe(false);
    }
    expect(keyframes.has("burst-rise")).toBe(true);
    expect(keyframes.has("burst-fade-in")).toBe(true);
  });
});
