// #515: a `<button>` shipped with no appearance at all — the browser's default
// grey box, default padding, default radius — and every sweep in this suite
// stayed green. A person found it by looking at the screen.
//
// #514 had moved the appearance of every bare-glyph control onto a shared
// `.glyph-btn` and cut each per-control rule down to what is genuinely that
// control's own. For the machine panel's close button that left
// `.sd-close { margin-left: auto; }` — and the JSX was not given the shared
// class, so the element shipped with `margin-left: auto` as its entire
// contribution from the stylesheet. Eight siblings were converted correctly;
// `npm test` reported the same counts before and after the fix.
//
// Three guards could plausibly have caught it, and each misses for its own
// reason:
//
//   unstyled-class.test.ts asks whether every class a component uses has a rule
//   in the sheet. `.sd-close` has one. Whether that rule says anything about
//   how the control looks is not a question it asks.
//
//   control-edges.test.ts sweeps controls for a boundary that clears 3:1 — but
//   it builds its input from rules that actually paint an edge, so a control
//   with no border drops out before any assertion runs. That is the same
//   property that put `.sd-close` in neither the swept list nor the exemption
//   list during #514, noted at the time as a curiosity.
//
//   panel-rhythm.test.ts pins heights for `.btn` and `.btn.icon-btn`. A control
//   carrying neither is outside its scope.
//
// So the shape that escapes is specific, and now that the codebase has shared
// appearance classes it is reproducible rather than accidental: a control whose
// only stylesheet contribution is layout, and which is missing the class that
// would have given it appearance.
//
// This file asks the narrower, checkable question that would have failed on the
// commit that introduced it: for every class set a `<button>` can render with,
// do the rules that match it declare any APPEARANCE at all — anything about how
// the control looks, as opposed to only where it sits? And, from the other
// direction, is every per-control rule that was trimmed to pure layout actually
// worn beside one of the shared classes it was trimmed in favour of?
//
// No DOM — plain node, vitest — so this reads styles.css and the .tsx the way
// control-edges.test.ts and unstyled-class.test.ts do. The tag scanner is
// shared with control-edges.test.ts (see ./tsx-scan and #513).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { classSetsIn, openTags } from "./tsx-scan";

const web = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(web, "styles.css"), "utf8");

// ── the stylesheet, as rules ────────────────────────────────────────────────

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Top-level rules only. A @media body is a different cascade — the
 *  reduced-motion overrides in particular are not the resting appearance of
 *  anything, and a print or forced-colors block is not either. */
function topLevel(src: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    if (!prelude.startsWith("@")) out.push({ selector: prelude, body: inner });
    i = end + 1;
  }
  return out;
}

const RULES = topLevel(css.replace(/\/\*[\s\S]*?\*\//g, ""));
const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

interface Decl { prop: string; value: string }

const declarations = (body: string): Decl[] =>
  [...body.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;]*)/g)]
    .map(m => ({ prop: m[1], value: m[2].replace(/\s+/g, " ").trim() }));

// ── what counts as an appearance ────────────────────────────────────────────

/**
 * The properties that say how a control LOOKS.
 *
 * A whitelist rather than a list of layout properties to ignore, and that
 * direction is the point. With a blacklist, a control styled only with a
 * property nobody thought of would pass this sweep in silence — which is the
 * failure #515 is about. With a whitelist the same control fails loudly and
 * somebody adds the property here. A false alarm is cheap; a false pass is what
 * shipped a grey box.
 *
 * `border-radius` is deliberately NOT on it. On `.glyph-btn` it exists to round
 * the focus ring on a control that paints no box at rest, so a rule whose only
 * entry here was a radius would be describing the shape of nothing.
 */
const APPEARANCE = new Set([
  "background", "background-color", "background-image",
  "border", "border-color", "border-width", "border-style",
  "border-top", "border-bottom", "border-left", "border-right",
  "border-block", "border-inline", "border-block-start", "border-block-end",
  "border-inline-start", "border-inline-end",
  "box-shadow", "outline", "outline-color", "filter", "backdrop-filter",
  "mix-blend-mode", "opacity",
  "color", "-webkit-text-fill-color",
  "font", "font-family", "font-size", "font-weight", "font-style",
  "letter-spacing", "text-decoration", "text-transform", "text-shadow",
]);

/**
 * A value that declares the ABSENCE of the thing rather than the thing.
 *
 * `background: none`, `border: 0` and `outline: none` are how a control says it
 * paints no box — which is the whole of what `.sd-close` had going for it, and
 * exactly what made the browser draw its own. `inherit` and `currentColor` are
 * NOT on this list: on a `<button>`, whose user-agent stylesheet supplies its
 * own font and its own grey, taking the parent's is a deliberate override and a
 * real statement about appearance.
 */
const NOTHING = /^(none|0|0px|transparent|initial|unset|revert)$/i;

const declaresAppearance = (decls: Decl[]) =>
  decls.some(d => APPEARANCE.has(d.prop) && !NOTHING.test(d.value));

// ── which rules a class set actually wears ──────────────────────────────────

/** The last compound in a selector — the part that describes the element the
 *  rule is about, rather than something it sits inside. */
const finalCompound = (sel: string) => {
  const parts = sel.split(/\s*[\s>+~]\s*/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
};

/**
 * Whether a selector describes this class set AT REST.
 *
 * Ancestors are not verified — no DOM here can say what a control sits inside —
 * so a descendant selector is read as scoping and its final compound is what
 * decides. That is over-generous by design: crediting a rule that might not
 * apply can only ever make this sweep quieter, and the assertion it guards is
 * "there is at least one rule saying how this looks", where the honest failure
 * to avoid is a control with nothing at all.
 *
 * What is NOT over-generous is the state question. A compound carrying a
 * pseudo-class or an attribute selector is a state — `:hover`, `.on`,
 * `[aria-pressed="true"]` — and a control whose only appearance arrives on
 * hover is unstyled at rest, which is the defect, not a pass. A `:root[…]`
 * theme block is a cascade, not a state, so it is allowed as an ancestor.
 */
function restingMatch(sel: string, classes: readonly string[]): boolean {
  const parts = sel.split(/\s*[\s>+~]\s*/).filter(Boolean);
  const last = finalCompound(sel);
  if (!last || /[:[]/.test(last)) return false;
  for (const part of parts.slice(0, -1)) {
    if (part.startsWith(":root")) continue;
    if (/[:[]/.test(part)) return false;
  }
  const tag = /^[a-zA-Z][\w-]*/.exec(last);
  if (tag && tag[0] !== "button") return false;
  const names = [...last.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
  if (!names.length && !tag) return false;
  return names.every(n => classes.includes(n));
}

const rulesFor = (classes: readonly string[]) =>
  RULES.filter(r => selectors(r.selector).some(s => restingMatch(s, classes)));

// ── the markup ──────────────────────────────────────────────────────────────

/** Every .tsx that ends up in the bundle. The suite's own files are not markup. */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** One `<button>`, and one of the class sets it can render with. A ternary
 *  className is two elements as far as a reader is concerned, and both of them
 *  have to look like something — so each string the expression can evaluate to
 *  is swept on its own. */
interface Control {
  where: string;
  classes: string[];
}

const CONTROLS: Control[] = tsxFiles(web).flatMap(path => {
  const file = path.slice(web.length).replaceAll("\\", "/");
  return openTags(readFileSync(path, "utf8"), ["button"]).flatMap(tag =>
    classSetsIn(tag.attrs).map(classes => ({ where: `${file}:${tag.line}`, classes })));
});

/** The classes the sheet uses to give a control its whole appearance, so that a
 *  per-control rule can be trimmed to the one thing that is that control's own.
 *  `.glyph-btn` is #514's; `.btn` predates it and does the same job for a
 *  labelled control. */
const SHARED = ["glyph-btn", "btn"];

/**
 * Controls that really do own no appearance, each with the reason.
 *
 * The test is whether the element is a wrapper around something else that IS
 * drawn. Both of these are: the box itself is deliberately invisible and what
 * the eye lands on is a child the sheet paints in full. Neither is a control
 * that lost its class.
 */
const EXEMPT = new Map<string, string>([
  // A column in the usage chart. The whole visible mark is `.uh-bar` inside it,
  // and the column is the hit area — a press on the empty space above a short
  // day still selects that day, which is why the target is the column and not
  // the bar. UsageHistoryModal.tsx.
  ["uh-bar-col", "a hit area around .uh-bar, which is what is drawn"],
  // The context donut, whose appearance is the SVG it wraps. Its `border-radius`
  // is there to round the focus ring, the same reason `.glyph-btn` carries one.
  ["ctx-donut", "a hit area around an SVG donut, which is what is drawn"],
]);

const exemption = (classes: readonly string[]) => classes.find(c => EXEMPT.has(c));

describe("every button the app renders has an appearance somewhere in the sheet", () => {
  it("is asked of every control in the components, not a list somebody keeps", () => {
    // A hand-kept list rots, and the defect this file exists for was a control
    // that fell out of two lists at once. So: floors, and a spread across files.
    expect(CONTROLS.length).toBeGreaterThan(50);
    expect(new Set(CONTROLS.map(c => c.where.split(":")[0])).size).toBeGreaterThan(8);
    // The exemplar is in there, wearing the class it was missing.
    const closes = CONTROLS.filter(c => c.classes.includes("sd-close"));
    expect(closes.map(c => c.classes.slice().sort()), "the machine panel's close button")
      .toEqual([["glyph-btn", "sd-close"]]);
  });

  it("has nothing in the sheet handing every button a look for free", () => {
    // If a bare `button { … }` rule ever paints one, every control passes the
    // sweep below whatever its own rules say and this file stops being able to
    // fail. There is no such rule today — the sheet styles controls by class
    // throughout — and the day somebody adds one this is where the question
    // gets asked rather than the answer being assumed.
    const global = RULES.filter(r => selectors(r.selector)
      .some(s => /^button$/.test(finalCompound(s)) && declaresAppearance(declarations(r.body))));
    expect(global.map(r => r.selector),
      "a bare `button` rule with an appearance would make the sweep below vacuous").toEqual([]);
  });

  it("finds a rule for each of them at rest", () => {
    // Before the appearance question can mean anything, something has to match.
    // A control with NO resting rule at all is the same defect a step earlier.
    const ruleless = CONTROLS
      .filter(c => !exemption(c.classes) && !rulesFor(c.classes).length)
      .map(c => `${c.where} [${c.classes.join(" ")}]`);
    expect([...new Set(ruleless)]).toEqual([]);
  });

  it("declares how it looks, and not only where it sits", () => {
    // The assertion #515 asked for. `.sd-close { margin-left: auto; }` is a
    // complete answer to where the × goes and says nothing whatever about what
    // it looks like; with the shared class missing from the JSX, nothing else
    // did either, and the browser drew its own grey box.
    const bare = CONTROLS
      .filter(c => !exemption(c.classes))
      .filter(c => !declaresAppearance(rulesFor(c.classes).flatMap(r => declarations(r.body))))
      .map(c => `${c.where} [${c.classes.join(" ")}]`);
    expect([...new Set(bare)],
      "a control whose rules are all layout — it will render as the browser's default button")
      .toEqual([]);
  });

  it("excuses only controls that are a hit area around something drawn", () => {
    // The one hand-list here, so it is worth saying out loud what is on it and
    // keeping it from outliving what it excused. Each entry has to still be a
    // class the markup puts on a button, and still be one this sweep would
    // otherwise fail — an exemption that has stopped excusing anything is a
    // sentence nobody will re-read.
    for (const [name, reason] of EXEMPT) {
      expect(reason.length, `${name} is excused without a reason`).toBeGreaterThan(20);
      const wearing = CONTROLS.filter(c => c.classes.includes(name));
      expect(wearing.length, `${name} is excused but no button carries it`).toBeGreaterThan(0);
      for (const c of wearing) {
        expect(declaresAppearance(rulesFor(c.classes).flatMap(r => declarations(r.body))),
          `${name} is excused but ${c.where} declares an appearance — drop the exemption`).toBe(false);
      }
    }
  });
});

describe("the per-control rules #514 trimmed are worn beside the class that carries the look", () => {
  /** What one class says on its own — every rule whose final compound is that
   *  class and nothing else. Not `.btn.primary`, not `.ver-banner .ver-act`:
   *  a rule that needs a second class or an ancestor is not what the class
   *  brings with it wherever it is worn. */
  const OWN = (() => {
    const own = new Map<string, Decl[]>();
    for (const rule of RULES) {
      for (const sel of selectors(rule.selector)) {
        const m = /^(?:button)?\.([\w-]+)$/.exec(finalCompound(sel));
        if (!m || !restingMatch(sel, [m[1]])) continue;
        own.set(m[1], [...(own.get(m[1]) ?? []), ...declarations(rule.body)]);
      }
    }
    return own;
  })();

  const WORN = new Set(CONTROLS.flatMap(c => c.classes));

  /** A class that gives a control its look wherever it is worn. Computed, not
   *  listed: `.glyph-btn` and `.btn` are the two the sheet was rewritten around,
   *  and the assertion below is about the property, not about those two names. */
  const CARRIES_A_LOOK = [...OWN]
    .filter(([name, decls]) => WORN.has(name) && declaresAppearance(decls))
    .map(([name]) => name);

  /** A class with a rule of its very own that is pure layout. These are the
   *  rules #514 cut down: what is left of one is the single thing that is this
   *  control's rather than the shared class's — where the × goes, how far the
   *  refresh glyph sits from its neighbour — which makes them a complete list of
   *  the places an appearance class is expected to be. */
  const TRIMMED = [...OWN]
    .filter(([name, decls]) =>
      WORN.has(name) && !EXEMPT.has(name) && !declaresAppearance(decls))
    .map(([name]) => name);

  it("finds both halves at all, which is what makes the next one mean something", () => {
    // Nine controls were converted in #514 and one was missed. The layout-only
    // classes are the surviving evidence of that conversion; if this list ever
    // came back empty the assertion below would be vacuously true.
    expect(TRIMMED.length, "no per-control rule in the sheet is layout-only any more")
      .toBeGreaterThanOrEqual(4);
    expect(TRIMMED).toContain("sd-close");
    expect(SHARED.every(s => CARRIES_A_LOOK.includes(s)),
      `${SHARED.join(" and ")} are supposed to be what a bare control's look comes from`).toBe(true);
  });

  it("never lets one be worn without a class that carries a look", () => {
    // The cheaper half of #515, asked from the stylesheet's side rather than the
    // markup's — and a stricter question than the sweep above, which is happy
    // for appearance to arrive from a two-class rule or from an ancestor. This
    // one wants a class that brings a look with it wherever it goes, because
    // that is the shape #514 left the sheet in. `.sd-close` alone fails here
    // even if something else in the cascade happened to cover for it.
    const orphans = CONTROLS
      .filter(c => c.classes.some(n => TRIMMED.includes(n)))
      .filter(c => !c.classes.some(n => CARRIES_A_LOOK.includes(n)))
      .map(c => `${c.where} [${c.classes.join(" ")}]`);
    expect([...new Set(orphans)],
      "a control wearing a layout-only rule with nothing beside it to give it an appearance")
      .toEqual([]);
  });
});

describe("the questions this sweep asks, asked of themselves", () => {
  it("calls a rule that only positions a control no appearance at all", () => {
    // The exemplar, verbatim, so the predicate cannot quietly start saying yes.
    expect(declaresAppearance(declarations("margin-left: auto;"))).toBe(false);
    expect(declaresAppearance(declarations("flex: none; margin: -2px 0 0; padding: 0 3px;"))).toBe(false);
    // And a rule that says the control paints nothing is still saying nothing.
    expect(declaresAppearance(declarations("background: none; border: 0; outline: none;"))).toBe(false);
  });

  it("calls a colour, a size and a fill an appearance, including the inherited kind", () => {
    expect(declaresAppearance(declarations("color: var(--muted); font-size: 16px;"))).toBe(true);
    expect(declaresAppearance(declarations("background: var(--ctl-fill);"))).toBe(true);
    expect(declaresAppearance(declarations("border: 1px solid var(--ctl-edge);"))).toBe(true);
    // `.ap-failure-x` is the reason this matters: it is deliberately bare, it
    // carries no shared class, and it passes without an exemption because its
    // own rule is complete — it takes the message's colour on purpose.
    expect(declaresAppearance(declarations("color: inherit; opacity: 0.6; font-size: 12px;"))).toBe(true);
  });

  it("does not count an appearance that only arrives in a state", () => {
    expect(restingMatch(".sd-close", ["glyph-btn", "sd-close"])).toBe(true);
    expect(restingMatch(".glyph-btn:hover", ["glyph-btn", "sd-close"])).toBe(false);
    expect(restingMatch('button.btn.icon-btn[aria-pressed="true"]', ["btn", "icon-btn"])).toBe(false);
    expect(restingMatch(".ap-header .glyph-btn", ["glyph-btn"])).toBe(true);
    expect(restingMatch(':root[data-theme="light"] .glyph-btn', ["glyph-btn"])).toBe(true);
    expect(restingMatch(".detail-panel:hover .glyph-btn", ["glyph-btn"])).toBe(false);
    // A rule for a class the set does not carry is not this control's.
    expect(restingMatch(".btn.primary", ["btn"])).toBe(false);
  });
});
