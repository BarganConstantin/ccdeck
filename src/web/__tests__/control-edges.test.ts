// #325 fixed five controls. #332 measured the other sixty-five.
//
// The defect it fixed was one control filled from `var(--bg-soft)` and edged
// with `var(--line)`, which on this sheet is a control with neither: --bg-soft
// is 1.04:1 against --panel in dark and byte-identical to it in light, and
// --line is 1.14:1 dark / 1.60:1 light — both under the 3:1 that WCAG 1.4.11
// asks of a boundary that is a control's only identification. #325 mixed two
// replacement values out of `var(--text)` and scoped them to `.ap-account`,
// which was right for the blast radius of that issue and wrong as a resting
// place: twenty-two of the app's seventy rendered controls had the same defect,
// in BOTH themes, and every one of them was reading the same two tokens the
// manage block had just stopped reading.
//
// So the two values are at :root now under names that are not --ap-*, the row's
// private copy is gone, and this file is the sweep. It is deliberately not a
// list of the ratios somebody once measured: it asks the sheet, for every
// control that DECLARES a boundary, on every opaque surface that control can
// land on, in both themes, whether the boundary clears 3:1 — and whether any
// state the control can enter draws that boundary fainter than it rests. A
// hover that lowers a contrast is not a hover.
//
// What it does not do is lift --line. That would redraw every panel edge,
// table rule and card in the app to solve a problem that belongs to controls;
// #325 declined and the last test here holds the line by value.
//
// No DOM — plain node, vitest — so this reads styles.css the way
// manage-block.test.ts, contrast-floors.test.ts and session-hue.test.ts do and
// computes the ratios from the sheet's own token values.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { TAG_BUDGET, classesIn, openTags, withoutComments } from "./tsx-scan";

const web = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(web, "styles.css"), "utf8");

/** WCAG 1.4.3 for the words, 1.4.11 for a control's own boundary. */
const BODY = 4.5;
const NON_TEXT = 3;

type Rgba = [number, number, number, number];

function parseColor(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  if (s === "transparent" || s === "none") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
}

/** Source-over compositing onto an already-opaque backdrop. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1) as Rgba;
}

function relativeLuminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

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

/** Top-level rules only. A @media body is a different cascade — the reduced-
 *  motion overrides in particular are not the resting appearance of anything. */
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

const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const RULES = topLevel(bare);

const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

/** Every top-level rule naming this exact selector, concatenated in source
 *  order — one element's cascade may be written in more than one place. */
function bodyOf(selector: string): string {
  const hit = RULES.filter(r => selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

/** The last declaration of `prop`, which is the one that wins. */
function declIn(body: string, prop: string): string | null {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}

const decl = (selector: string, prop: string) => declIn(bodyOf(selector), prop);

/** The colour in a value that may also carry a width and a style. Parens are
 *  counted rather than matched lazily: `color-mix(in srgb, var(--x) 6%, …)`
 *  nests, and a `[^)]*` stops inside it. */
function colourIn(value: string): string {
  const head = /(color-mix|var|rgba?)\(/i.exec(value);
  if (head) {
    const open = head.index + head[0].length - 1;
    let depth = 0;
    for (let i = open; i < value.length; i++) {
      if (value[i] === "(") depth++;
      else if (value[i] === ")" && --depth === 0) return value.slice(head.index, i + 1);
    }
    throw new Error(`unbalanced parens in "${value}"`);
  }
  const hex = /#[0-9a-f]{3,8}/i.exec(value);
  if (hex) return hex[0];
  // `border: none` and `border: 0` are the same statement: no boundary.
  if (/\b(transparent|none)\b/.test(value) || /^\s*0\s*$/.test(value)) return "transparent";
  // A ring drawn in the element's own text colour. Returned verbatim rather
  // than resolved: what `color` is at that point in the cascade is a question
  // this file cannot answer, and `resolve` refusing it is the honest outcome —
  // an edge nobody here understands is one for a human to look at.
  if (/\bcurrentColor\b/i.test(value)) return "currentColor";
  throw new Error(`no colour in "${value}"`);
}

/** Split a comma-separated value at the TOP level, so the commas inside
 *  `rgba(0,0,0,.4)` do not tear a box-shadow layer in half. */
function topLevelParts(value: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out;
}

/** A rule's border colour, whichever way it was written.
 *
 *  #378 widened this from three properties to the whole set. It read
 *  `border-color`, `border` and `border-bottom` only, so a control edged with
 *  `border-top` or a logical `border-inline` returned null — and null is what
 *  `paintsAnEdge` below reads as "no boundary at all", which means such a rule
 *  was neither swept nor reported as unswept. Nothing in the sheet does that
 *  today; the point is that nothing would have said so. */
const BORDER_PROPS = [
  "border-color", "border",
  "border-top", "border-bottom", "border-left", "border-right",
  "border-block", "border-inline", "border-block-start", "border-block-end",
  "border-inline-start", "border-inline-end",
];

function borderColourIn(body: string): string | null {
  for (const prop of BORDER_PROPS) {
    const raw = declIn(body, prop);
    if (raw !== null) return colourIn(raw);
  }
  return null;
}

/**
 * Every property name that can put a colour on a border, for the sweeps that
 * ask "does ANY declaration here name this token" rather than "what is this
 * rule's one edge colour".
 *
 * A superset of `BORDER_PROPS`, and deliberately a second list rather than an
 * edit to that one: `BORDER_PROPS` is priority-ordered and `borderColourIn`
 * returns the first hit, so what is in it decides which rules count as having
 * an edge at all — which `paintsAnEdge` and `RING_RULES` both read. The four
 * `-color` longhands belong in that answer too and are missing from it for the
 * same reason they were missing here; that is a separate change with a
 * different blast radius, and this one stays additive.
 *
 * #629. `declIn` anchors the property name — it must sit straight after a `;`
 * or `{` with nothing but whitespace before the colon — so `border-color` does
 * not match `border-bottom-color` and `border` does not match `border-bottom`.
 * A sweep reading those two names alone therefore sees one spelling in ten,
 * and the sheet writes the others: 23 `border-bottom`, 6 `border-top`, 4
 * `border-right`, 2 `border-left` and 2 `border-bottom-color` at the time of
 * writing, against 80 `border-color` and 74 `border`.
 */
const EDGE_COLOUR_PROPS = [
  ...BORDER_PROPS,
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-block-color", "border-inline-color",
  "border-block-start-color", "border-block-end-color",
  "border-inline-start-color", "border-inline-end-color",
];

/**
 * Every border-colour declaration in the sheet, as the rule and property that
 * wrote it.
 *
 * Collected, not short-circuited. The check this replaces asked
 * `declIn(body, "border-color") ?? declIn(body, "border")`, and `??` stops at
 * the first non-null: a rule carrying `border-color: var(--line)` had its
 * `border` shorthand never read. No rule in the sheet writes both today, so
 * that half of #629 is latent rather than live — which is exactly the state
 * the property half was in until `border-bottom-color` arrived.
 */
const EDGE_DECLS: Array<{ selector: string; prop: string; raw: string }> = RULES.flatMap(rule =>
  EDGE_COLOUR_PROPS.flatMap(prop => {
    const raw = declIn(rule.body, prop);
    return raw === null ? [] : [{ selector: rule.selector, prop, raw }];
  }));

/**
 * A RING: a boundary drawn outside the box rather than in the border — an
 * `outline`, or a `box-shadow` layer with no offset and no blur.
 *
 * #378. `borderColourIn` returned null for both, and `paintsAnEdge` reads null
 * as "no boundary", so a control whose only visible edge was
 * `outline: 1px solid var(--line)` passed the sweep that calls itself
 * exhaustive at 1.14:1 dark / 1.60:1 light. Measured, by adding exactly that
 * rule to a real control class: all 1849 tests stayed green. It is not a
 * hypothetical shape either — `.uh-bar-col.sel .uh-bar` already marks the
 * selected chart bar this way.
 *
 * Offset and blur are what separates a ring from a drop shadow. `0 0 0 2px X`
 * is a line at a fixed distance from the box and reads as an edge;
 * `0 4px 14px rgba(0,0,0,.45)` is a soft shadow with no boundary anywhere in
 * it, and asking it to clear 3:1 would be asking the wrong question.
 */
function ringColourIn(body: string): string | null {
  const outline = declIn(body, "outline");
  if (outline !== null) return colourIn(outline);
  const shadow = declIn(body, "box-shadow");
  if (shadow === null) return null;
  for (const layer of topLevelParts(shadow)) {
    if (/^\s*(?:inset\s+)?0\s+0\s+0\s+/.test(layer)) return colourIn(layer);
  }
  return null;
}

const borderColour = (selector: string) => {
  const c = borderColourIn(bodyOf(selector));
  if (c === null) throw new Error(`${selector} declares no border`);
  return c;
};

// ── tokens and the surfaces a control can land on ───────────────────────────

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function rootTokens(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of bodyOf(`:root[data-theme="${theme}"]`).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

const TOK: Record<Theme, Record<string, string>> = { dark: rootTokens("dark"), light: rootTokens("light") };

/** var() with an optional fallback, and the `color-mix(in srgb, X N%, transparent)`
 *  form this sheet uses for every tint — which is just X at N% alpha. */
function resolve(value: string, theme: Theme): Rgba {
  const v = value.trim();
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/.exec(v);
  if (mix) {
    const base = resolve(mix[1], theme);
    return [base[0], base[1], base[2], base[3] * (+mix[2] / 100)];
  }
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(v);
  if (ref) {
    const defined = TOK[theme][ref[1]];
    if (defined !== undefined) return resolve(defined, theme);
    if (ref[2] === undefined) throw new Error(`undefined token with no fallback: ${v}`);
    return resolve(ref[2], theme);
  }
  return parseColor(v);
}

/** The colour stops of a gradient token, in order. */
const stopsOf = (value: string) =>
  value.match(/var\(--[\w-]+\)|#[0-9a-f]{3,8}/gi) ?? [];

/** Every opaque bed a control is ever painted on, by the name the sheet gives
 *  it. The topbar is a gradient, so both of its ends count: a pill centred in
 *  52px of it is read against the darker one as much as the lighter. */
function surfaces(theme: Theme): Record<string, Rgba> {
  const panel = parseColor(TOK[theme]["--panel"]);
  const bg = parseColor(TOK[theme]["--bg"]);
  const top = stopsOf(TOK[theme]["--topbar-grad"]).map(s => resolve(s, theme));
  const bannerTint = resolve(colourIn(decl(".ver-banner", "background")!), theme);
  const activeTint = resolve(colourIn(decl(".ap-account.active", "background")!), theme);
  return {
    "--panel": panel,
    "--bg-soft": parseColor(TOK[theme]["--bg-soft"]),
    "--bg": bg,
    "the topbar's light end": top[0],
    "the topbar's dark end": top[1],
    "the version banner": over(bannerTint, bg),
    "the active account row": over(activeTint, panel),
  };
}

/** The beds small text lands on, which is not the same set: the banner and the
 *  active row are washes a control sits in, and nothing writes a status hue on
 *  either. Both ends of the node gradient count — a node's top and bottom
 *  differ, and the cost line runs across both. */
function textBeds(theme: Theme): Array<[string, Rgba]> {
  const named: Array<[string, Rgba]> = (["--panel", "--bg-soft", "--bg"] as const)
    .map(t => [t, parseColor(TOK[theme][t])]);
  const top = stopsOf(TOK[theme]["--topbar-grad"]).map((s, i): [string, Rgba] =>
    [`the topbar, stop ${i}`, resolve(s, theme)]);
  const node = stopsOf(TOK[theme]["--node-grad"]).map((s, i): [string, Rgba] =>
    [`a node, stop ${i}`, resolve(s, theme)]);
  return [...named, ...top, ...node];
}

const TOPBAR = ["the topbar's light end", "the topbar's dark end"];
const BANNER = ["the version banner", "--bg"];
const ACCOUNTS = ["--panel", "the active account row"];

// ── which rules in the sheet are a control's ─────────────────────────────────
//
// Harvested from the markup rather than listed, because a hand-kept list rots.
// Hoisted to module scope in #378 so the ring sweep and the exhaustiveness
// check ask the same question of the same set.

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** Every component, as [name relative to src/web, source]. Read one at a time
 *  rather than joined into one string, which is what this file used to do: a
 *  scan that runs off the end of one file must not reach into the next, and a
 *  message that can name the file is worth more than one that cannot. Forward
 *  slashes so a Windows run reports the same name a mac one does. */
const COMPONENTS: Array<[string, string]> = tsxFiles(web)
  .map(p => [p.slice(web.length).replaceAll("\\", "/"), readFileSync(p, "utf8")]);

/**
 * Every `<button>`, `<input>`, `<select>` and `<a>` the components open.
 *
 * The scanner is `./tsx-scan`'s now rather than this file's own, for the two
 * reasons #513 gives. It strips comments before it looks for markup — an
 * English possessive in a line comment used to open a string that nothing in
 * the tag ever closed, after which the scan spent its whole budget harvesting
 * other elements' classes into this one's attribute text — and it says when a
 * scan reached that budget instead of handing back a truncated tag that looks
 * exactly like a long one.
 *
 * #378's fix is still in there: braces are counted and quotes tracked, so the
 * `>` in `onClick={() => …}` does not end a tag early.
 */
const TAGS = COMPONENTS.flatMap(([file, src]) =>
  openTags(src, ["button", "input", "select", "a"]).map(t => ({ ...t, file })));

/** The tags the scan could not finish. Empty, and a test below says so by name. */
const RUNAWAYS = TAGS.filter(t => t.ranAway).map(t => `${t.file}:${t.line} <${t.name}`);

/** Every class the components put on one of those four tags. */
const INTERACTIVE = new Set<string>();
for (const tag of TAGS) for (const c of classesIn(tag.attrs)) INTERACTIVE.add(c);

const escapeClass = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MARKS = [...INTERACTIVE].map(c => new RegExp(`\\.${escapeClass(c)}(?![\\w-])`));
MARKS.push(/(?:^|[\s>+~])(?:button|input|select)(?![\w-])/);

const isControlRule = (selector: string) =>
  selectors(selector).some(s => MARKS.some(re => re.test(s)));

/** A control, as the sheet writes it: the rule that draws it at rest, the rule
 *  its fill comes from when that is a base class, every rule that redraws its
 *  boundary in some state, and the beds it can sit on. */
interface Control {
  at: string;
  fillFrom?: string;
  states?: string[];
  beds: string[];
}

const CONTROLS: Control[] = [
  // topbar
  { at: ".topbar .brand button.v:not(.stale)", fillFrom: ".topbar .brand button.v",
    states: [".topbar .brand button.v:not(.stale):hover"], beds: TOPBAR },
  { at: ".topbar .brand button.v.stale", states: [".topbar .brand button.v.stale:hover"], beds: TOPBAR },
  { at: ".selected-ribbon", states: [".selected-ribbon:hover"], beds: TOPBAR },
  { at: "button.btn", states: ["button.btn:hover"], beds: [...TOPBAR, "--panel"] },
  { at: "button.btn.primary", fillFrom: "button.btn.primary", beds: [...TOPBAR, "--panel"] },
  // The on state of an icon toggle (#370). Two selectors on one rule, so both
  // have to be named or the exhaustiveness check below reports the other as
  // unswept. Its own state delta — this fill against the bare bar, which is a
  // different question from this edge against this fill — is toggle-state.test.ts'.
  { at: 'button.btn.icon-btn[aria-pressed="true"]', beds: [...TOPBAR, "--panel"] },
  { at: 'button.btn.icon-btn[aria-expanded="true"]', beds: [...TOPBAR, "--panel"] },
  // `button.btn.warn` was swept here until the topbar Pause button, its only
  // wearer, moved to the canvas control stack. The rule is gone from the sheet
  // rather than kept unworn, so there is nothing left to measure — and the
  // exhaustiveness check at the bottom of this describe is what would say so if
  // it came back.
  { at: "button.btn.danger", fillFrom: "button.btn", states: ["button.btn.danger:hover"], beds: ["--panel"] },
  { at: ".topbar .waiting-stat", states: [".topbar .waiting-stat:hover"], beds: TOPBAR },
  // The skip link (#381). It is only ever on screen while it holds focus, and
  // it is drawn over the topbar it skips past — so the beds are the bar's two
  // ends, like every other control up here. It gets the sweep rather than an
  // exemption because it is the one control on this deck whose entire audience
  // cannot see it until the moment it appears: nobody discovers it by looking,
  // which means it has to be legible the first frame it is there.
  { at: ".skip-link", beds: TOPBAR },
  // version banner
  { at: ".ver-banner .ver-cmd", states: [".ver-banner .ver-cmd:hover"], beds: BANNER },
  { at: ".ver-banner .ver-act", states: [".ver-banner .ver-act:hover:not(:disabled)"], beds: BANNER },
  { at: ".ver-banner .ver-auto:hover", fillFrom: ".ver-banner .ver-auto", beds: BANNER },
  // canvas, detail panel, modals
  { at: ".detail-reopen", beds: ["--bg"] },
  // `.detail-close:hover` and `.ctx-modal-close` used to be here, and they are
  // gone rather than exempted. Both are `.glyph-btn` now — a bare character in
  // a panel header, no border at rest and none grown on hover — so there is no
  // boundary left for this sweep to measure and no arithmetic an exemption
  // would be excusing it from. 1.4.11 is answered the way it is answered for
  // `.detail .tool` below: the glyph is the identification, inside a box that
  // already draws its own edge and writes its own title. The exhaustiveness
  // check at the bottom of this describe is what keeps that honest — the day
  // either one draws an edge again it lands in `unclassified` and has to come
  // back up here or be written into EXEMPT with a reason.
  { at: ".session-list .sl-row:hover", fillFrom: ".session-list .sl-row:hover",
    states: [".session-list .sl-row.selected"], beds: ["--panel"] },
  // accounts panel
  { at: ".ap-auto-state", states: ["button.ap-auto-state:hover:not(:disabled)", ".ap-auto-state.live"],
    beds: ["--panel"] },
  { at: ".ap-field select", states: [".ap-field select:hover:not(:disabled)"], beds: ACCOUNTS },
  { at: ".ap-more:hover", fillFrom: ".ap-more", states: [".ap-more.on"], beds: ACCOUNTS },
  { at: ".ap-manage-input", states: [".ap-manage-input:hover"], beds: ACCOUNTS },
  { at: ".ap-manage-btn", states: [".ap-manage-btn:hover:not(:disabled)"], beds: ACCOUNTS },
  { at: ".ap-manage-btn.danger", fillFrom: ".ap-manage-btn",
    states: [".ap-manage-btn.danger:hover:not(:disabled)", ".ap-manage-btn.danger.armed"], beds: ACCOUNTS },
  { at: ".ap-share-foot .ap-manage-btn", fillFrom: ".ap-share-foot .ap-manage-btn",
    states: [".ap-share-foot .ap-manage-btn:hover:not(:disabled)"], beds: ACCOUNTS },
  { at: ".ap-fix", states: [".ap-fix:hover"], beds: ["--panel"] },
  // add-account dialog
  { at: ".aa-tab", states: [".aa-tab.on"], beds: ["--panel"] },
  { at: ".aa-link", states: [".aa-link:hover"], beds: ["--panel"] },
  { at: ".aa-field input", beds: ["--panel"] },
];

/** What the control is filled with at rest. `background: none` and a rule that
 *  declares no background at all are both "whatever is behind it". */
function restingFill(c: Control): string {
  return decl(c.fillFrom ?? c.at, "background") ?? "transparent";
}

/** A boundary's ratio against the bed it is drawn on, with the control's own
 *  fill in between — `background-clip` is `border-box` by default, so the
 *  border composites over the fill, not straight onto the surface. */
function edgeRatio(edge: string, fill: string, bed: Rgba, theme: Theme): number {
  const filled = over(resolve(fill, theme), bed);
  return contrastRatio(over(resolve(edge, theme), filled), bed);
}

// ── the rings ────────────────────────────────────────────────────────────────

/**
 * Rings that are decoration rather than identification, each with the reason.
 *
 * The test is whether the ring is the only thing telling you the element is
 * there or which state it is in. A hairline added on hover, over a control
 * whose resting edge the sweep above already measures, is not — it is a lift.
 */
const EXEMPT_RINGS = new Set([
  // An --accent-dim glow ADDED on hover to a button whose own border does not
  // move. 1.91:1 dark / 1.39:1 light, and the file already refuses to let
  // --accent-dim be a border-color anywhere for exactly that reason; as a glow
  // over an edge that is still there it takes nothing away.
  'button.btn.icon-btn[aria-pressed="true"]:hover',
  'button.btn.icon-btn[aria-expanded="true"]:hover',
  // A currentColor hairline on a canvas label that is lifting under the
  // pointer. .cluster-label is exempt at rest for the reason below — it reads
  // its own name at 4.5:1 — and session-hue.test.ts owns its rim as decoration.
  // `.cluster-label.dragging` was excused beside it until #546 took the rule
  // out of the sheet: nothing ever put `dragging` on that element, and the
  // check at the bottom of this describe is the one that would have said so
  // the moment the exemption outlived what it excused.
  ".cluster-label:hover",
  // The same shape on a tool burst: a hover lift in the burst's own category
  // hue, over a chip identified by the tool name written across it.
  ".tool-burst.clickable:hover",
]);

/** Every rule in the sheet that draws a ring somebody has to be able to see:
 *  a control's, or ANY element's focus indicator, since 2.4.11 is owed to
 *  whatever the keyboard can reach and not only to things with a class. */
const RING_RULES = RULES.filter(rule => {
  if (!isControlRule(rule.selector) && !/:focus-visible/.test(rule.selector)) return false;
  if (selectors(rule.selector).every(s => EXEMPT_RINGS.has(s))) return false;
  // A rule that declares a border is measured as a border above; the ring, if
  // it has one too, is the extra on top.
  if (borderColourIn(rule.body) !== null) return false;
  const ring = ringColourIn(rule.body);
  return ring !== null && ring !== "transparent";
});

describe("the scan everything below is built on (#513)", () => {
  it("reads every control in the app without running off the end of one", () => {
    // A runaway is the failure this file could least afford and the one it had
    // no way to report: the scan hits its budget, the truncated window is
    // pushed as though it were a tag, and whatever markup it swallowed hands
    // its classes to a control that never carried them. The sweep can then pass
    // having examined the wrong element. Named here, so it cannot be quiet.
    expect(RUNAWAYS, "a tag scan ran away — the classes it collected belong to something else")
      .toEqual([]);
    // Not a vacuous check: the app really does have controls to find, and they
    // really are spread across the components rather than sitting in one file.
    expect(TAGS.length).toBeGreaterThan(60);
    expect(new Set(TAGS.map(t => t.file)).size).toBeGreaterThan(5);
  });

  it("takes the comments out of the source before it looks for markup", () => {
    // The pre-pass, asked of the file the issue counted. Sixteen comment lines
    // in `AccountsPanel.tsx` carry an apostrophe today; they are benign only
    // because of where its buttons happen to sit, which is a property of this
    // week's markup and not of the scanner. All sixteen stay exactly as their
    // author wrote them, and none of them reaches the scan.
    const panel = COMPONENTS.find(([name]) => name === "components/AccountsPanel.tsx")![1];
    const commentsWithApostrophes = panel.split("\n")
      .filter(line => /^\s*(\/\/|\*)/.test(line) && line.includes("'"));
    expect(commentsWithApostrophes.length,
      "the fixture is gone — this file no longer proves anything").toBeGreaterThanOrEqual(10);
    const bare = withoutComments(panel);
    expect(bare.split("\n").filter(line => /^\s*\/\//.test(line))).toEqual([]);
    // Including the ones written after code on the same line, which is the case
    // every hand-rolled stripper in this suite drops a line-filter on and
    // misses — and this file's own example of one carries an apostrophe.
    expect(panel).toContain("// unix ms — claude-swap's next planned read");
    expect(bare).not.toContain("next planned read");
    // Prose is dropped; the markup and the strings around it are not. An
    // apostrophe in JSX text is prose the browser renders, not a string
    // literal, and it has to survive without swallowing what follows it.
    expect(bare.split("\n").length).toBe(panel.split("\n").length);
    expect(bare).toContain("Couldn't read the account store.");
  });

  it("closes a quote at the end of a line, because a string cannot span one", () => {
    // The rule that lets prose have apostrophes at all. JSX text is not
    // JavaScript — `Couldn't read the account store.` is a sentence a browser
    // renders — so an apostrophe in it is not a string opening. Read as one it
    // would swallow every comment after it and hand the scanner back the exact
    // hazard the pre-pass exists to remove. A `'` or `"` still open at a newline
    // was never a string, and closes there; a template literal really can span
    // lines, so a backtick is exempt.
    const prose = ["<span>Couldn't read the account store.</span>", "// this note has to go"].join("\n");
    expect(withoutComments(prose)).not.toContain("this note has to go");
    const template = ["const s = `line one", "// not a comment: still inside the literal", "`;"].join("\n");
    expect(withoutComments(template)).toContain("not a comment");
  });

  it("reads a button through the apostrophe in the comment inside it", () => {
    // The exact shape #512 hit, reduced.
    const source = [
      '<button',
      '  className="the-control"',
      '  onClick={() => {',
      "    // Shift-click restores the user's own hooks.",
      '    restore();',
      '  }}',
      '>x</button>',
      '<div className="somewhere-else" />',
    ].join("\n");
    const [tag] = openTags(source, ["button"]);
    expect(tag.ranAway).toBe(false);
    expect(classesIn(tag.attrs)).toEqual(["the-control"]);
    expect(tag.attrs).not.toContain("somewhere-else");
  });

  it("does not let a `>` written in prose end the tag early", () => {
    // The quiet half of #513 and the worse one. Nothing runs away here: the
    // scan simply stops at the wrong `>`, the className written after it is
    // never seen, and the control drops out of `INTERACTIVE` — so every rule
    // that class names drops out of the exhaustiveness check too, and the sweep
    // passes having examined one control fewer than it believes.
    const source = [
      '<button',
      '  // a note about the > sign',
      '  className="the-control"',
      '>x</button>',
    ].join("\n");
    const [tag] = openTags(source, ["button"]);
    expect(tag.ranAway).toBe(false);
    expect(classesIn(tag.attrs)).toEqual(["the-control"]);
  });

  it("does not let an unbalanced brace in prose swallow the rest of the file", () => {
    // The hazard the old budget comment named, kept as a case rather than as a
    // sentence. An unmatched `{` in a comment holds the depth above zero, so no
    // later `>` closes anything and the scan spends its budget on other
    // people's markup.
    const source = [
      '<button',
      '  // was: onClick={() => setOpen(true)',
      '  className="the-control"',
      '>x</button>',
      '<div className="somewhere-else" />',
    ].join("\n");
    const [tag] = openTags(source, ["button"]);
    expect(tag.ranAway).toBe(false);
    expect(classesIn(tag.attrs)).toEqual(["the-control"]);
    expect(tag.attrs).not.toContain("somewhere-else");
  });

  it("does not let a lone backtick in prose run past the end of the tag", () => {
    // A template literal is the one quote that may span lines, so an unclosed
    // one in a comment is the shape that survives every other rule here.
    const source = [
      '<button className="the-control"',
      '  // the shape it replaced was `btn ${x}',
      '>x</button>',
      '<div className="somewhere-else" />',
    ].join("\n");
    const [tag] = openTags(source, ["button"]);
    expect(tag.ranAway).toBe(false);
    expect(classesIn(tag.attrs)).toEqual(["the-control"]);
  });

  it("says a scan ran away rather than handing back somebody else's classes", () => {
    // What is left once comments are gone: a tag that genuinely never closes.
    // The answer is a flag and an empty attribute string, not a truncated
    // window — attributes read out of a runaway are not this tag's, and
    // returning them is the mis-attribution the whole issue is about.
    const source = `<button className={\`unterminated\n${"x".repeat(TAG_BUDGET)}\n<div className="somewhere-else" />`;
    const [tag] = openTags(source, ["button"]);
    expect(tag.ranAway).toBe(true);
    expect(tag.attrs).toBe("");
    expect(tag.line).toBe(1);
    expect(classesIn(tag.attrs)).toEqual([]);
  });
});

describe("the contrast maths, against the two ends everybody knows", () => {
  it("puts white on black at 21:1 and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#14161b"), parseColor("#14161b"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("reproduces the ratios #332 reported, so the floors below have a baseline", () => {
    // Every one of these is a shipped value from v1.33.135, restated as
    // arithmetic. They are literals on purpose: the tokens have moved, and a
    // baseline that moved with them would not be one.
    const white = parseColor("#ffffff");
    const canvas = parseColor("#eef1f6");
    const darkPanel = parseColor("#14161b");
    // `Pause`, `Re-layout`, `Clear`, the three icon buttons: transparent fill,
    // --line edge. 1.00 on the fill in light because --bg-soft IS --panel.
    expect(contrastRatio(parseColor("#c8cdd6"), white)).toBeCloseTo(1.60, 2);
    expect(contrastRatio(parseColor("#c8cdd6"), canvas)).toBeCloseTo(1.41, 2);
    expect(contrastRatio(parseColor("#1f2229"), darkPanel)).toBeCloseTo(1.14, 2);
    // The `$` button — the only filled .btn — and its --accent-dim edge over it.
    const dimFill = over([3, 105, 161, 0.22], canvas);
    expect(contrastRatio(dimFill, canvas)).toBeCloseTo(1.37, 2);
    expect(contrastRatio(over([3, 105, 161, 0.22], dimFill), canvas)).toBeCloseTo(1.79, 2);
    // .detail-reopen: a --panel tab on the canvas, edged with --line.
    expect(contrastRatio(white, canvas)).toBeCloseTo(1.13, 2);
    // --accent-dim, the hover edge on eleven rules, against what it hovered.
    expect(contrastRatio(over([3, 105, 161, 0.22], white), white)).toBeCloseTo(1.39, 2);
    expect(contrastRatio(over([56, 189, 248, 0x50 / 255], darkPanel), darkPanel)).toBeCloseTo(1.91, 2);
    // --ok and --warn on the canvas: under AA by a tenth, fine on a panel.
    expect(contrastRatio(parseColor("#15803d"), canvas)).toBeCloseTo(4.43, 2);
    expect(contrastRatio(parseColor("#b45309"), canvas)).toBeCloseTo(4.44, 2);
    expect(contrastRatio(parseColor("#15803d"), white)).toBeCloseTo(5.02, 2);
    // .pill.live: --ok on its own 10% wash, at the dark end of the topbar.
    expect(contrastRatio(parseColor("#15803d"), over([21, 128, 61, 0.10], canvas))).toBeCloseTo(3.90, 2);
  });
});

describe("every control that draws a boundary draws one that can be seen (1.4.11)", () => {
  it("clears 3:1 at rest, on every surface it can land on, in both themes", () => {
    for (const theme of themes) {
      const beds = surfaces(theme);
      for (const c of CONTROLS) {
        const fill = restingFill(c);
        const edge = borderColour(c.at);
        for (const bedName of c.beds) {
          expect(edgeRatio(edge, fill, beds[bedName], theme), `${theme} ${c.at} on ${bedName}`)
            .toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    }
  });

  it("never draws it fainter in a state than at rest — a hover that lowers a contrast is not a hover", () => {
    for (const theme of themes) {
      const beds = surfaces(theme);
      for (const c of CONTROLS) {
        const restFill = restingFill(c);
        const restEdge = borderColour(c.at);
        for (const state of c.states ?? []) {
          const body = bodyOf(state);
          const fill = declIn(body, "background") ?? restFill;
          const edge = borderColourIn(body) ?? restEdge;
          for (const bedName of c.beds) {
            const bed = beds[bedName];
            expect(edgeRatio(edge, fill, bed, theme), `${theme} ${state} on ${bedName}`)
              .toBeGreaterThanOrEqual(edgeRatio(restEdge, restFill, bed, theme) - 1e-9);
          }
        }
      }
    }
  });

  it("leaves nothing in the sheet drawing a boundary on a control the sweep has not seen", () => {
    // The sweep is only worth its runtime if it is exhaustive, and a hand-kept
    // list rots. So: every class the components put on a <button>, <input>,
    // <select> or <a>, plus the three tag names themselves, and every top-level
    // rule that paints a visible border on one of them has to be either swept
    // above or named below with a reason. A new control cannot be added to this
    // app without landing in one of the two lists.
    expect(INTERACTIVE.size).toBeGreaterThan(20);

    /** An edge a reader could see: not `none`, not `0`, not transparent. A
     *  value this file cannot resolve counts as visible — an edge nobody here
     *  understands is exactly the one that has to be looked at by hand.
     *
     *  #378: a ring counts. This used to ask `borderColourIn` alone, so a rule
     *  drawing its whole boundary with `outline` or an inset box-shadow
     *  answered "no boundary" and fell out of both lists at once — not swept,
     *  and not reported as unswept either, which is the failure mode a check
     *  calling itself exhaustive can least afford. */
    const paintsAnEdge = (body: string) => {
      try {
        const c = borderColourIn(body) ?? ringColourIn(body);
        if (c === null || c === "transparent") return false;
        return resolve(c, "light")[3] > 0;
      } catch { return true; }
    };

    // Named, with the reason. All three are the same reason 1.4.11 gives:
    // a control identified by its own visible label or glyph does not owe you
    // a boundary, and a line BETWEEN grouped controls is not one of them.
    const EXEMPT = new Set([
      // The stack's frame and the rules between its buttons. Each button is a
      // glyph; the group's outline is a group's outline.
      ".react-flow__controls-button",
      // Rows in the tool list. `border: none` plus a hairline separating one
      // row from the next — the row is identified by the tool's name in it.
      ".detail .tool", "button.tool.clickable", "button.tool.clickable:last-child",
      // A label on the canvas, whose rim is a tint of the session hue and
      // whose floors session-hue.test.ts owns as decoration. It reads its own
      // name at 4.5:1, which is the identification. (It read "draggable" here
      // until #546; it is a fit-view button and never was one.)
      ".cluster-label",
    ]);
    const swept = new Set<string>();
    for (const c of CONTROLS) {
      for (const s of selectors(c.at)) swept.add(s);
      for (const s of c.states ?? []) swept.add(s);
      if (c.fillFrom) swept.add(c.fillFrom);
    }
    // Rings are swept by their own describe below, which measures every one of
    // them rather than working from a list — so a new outline-only control
    // lands there automatically and has to clear 3:1 to pass. What is left for
    // a hand-list is the rings that are decoration, and those name themselves.
    for (const r of RING_RULES) for (const s of selectors(r.selector)) swept.add(s);
    for (const s of EXEMPT_RINGS) swept.add(s);

    const unclassified = RULES
      .filter(r => isControlRule(r.selector) && paintsAnEdge(r.body))
      .flatMap(r => selectors(r.selector))
      .filter(s => !swept.has(s) && !EXEMPT.has(s));
    expect([...new Set(unclassified)]).toEqual([]);
  });
});

describe("the rings, which a border sweep cannot see (1.4.11, 2.4.11)", () => {
  it("finds the focus indicator at all, which is the surface nothing here measured", () => {
    // The keyboard focus ring is the whole of what a keyboard user gets, and
    // this file used to be blind to it: `outline` was not one of the three
    // properties it read. quiet-signals.test.ts does measure the search field's
    // ring — against three surfaces — so the issue's "never measured at all" is
    // not quite right; what was missing is every OTHER ring, and the beds this
    // file knows about that the other one does not (the topbar's two gradient
    // ends, the version banner's wash, the active account row).
    //
    // A floor rather than a count: deleting a control must not fail this, and
    // a sheet that has stopped drawing focus rings must.
    const focus = RING_RULES.filter(r => /:focus-visible/.test(r.selector));
    expect(focus.length, "the sheet draws no focus indicator this sweep can find")
      .toBeGreaterThanOrEqual(8);
    expect(RING_RULES.some(r => selectors(r.selector).includes(":focus-visible")),
      "the global :focus-visible bed is gone, so most of the app has no ring").toBe(true);
  });

  it("draws every one of them at 3:1 on every surface it can float over, both themes", () => {
    // `outline-offset` puts the ring OUTSIDE the control, so unlike a border it
    // composites straight onto whatever is behind — no fill in between. Swept
    // against every opaque bed in the sheet rather than a per-rule list: a ring
    // is a few pixels of line, the beds are cheap, and the conservative answer
    // is the one that keeps holding when a control moves.
    //
    // What this catches that nothing did: a future --accent tweak. Measured
    // today it is 9.07–11.72:1 dark and 4.39–5.93:1 light, so there is room —
    // and the day somebody spends it, this is the line that says so rather than
    // the keyboard users finding out.
    for (const theme of themes) {
      const beds = surfaces(theme);
      for (const rule of RING_RULES) {
        const raw = ringColourIn(rule.body)!;
        // A ring this file cannot resolve — `currentColor`, or a token only the
        // element itself carries — is not a pass. It fails here by name, rather
        // than throwing an unattributed parse error, so whoever wrote it is
        // told to either sweep it by hand or put it in EXEMPT_RINGS with a
        // reason. That is the same standard the border sweep holds.
        expect(() => resolve(raw, theme),
          `${rule.selector} rings in ${raw}, which cannot be measured here`).not.toThrow();
        const ring = resolve(raw, theme);
        for (const [bedName, bed] of Object.entries(beds)) {
          expect(contrastRatio(over(ring, bed), bed), `${theme} ${rule.selector} on ${bedName}`)
            .toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    }
  });

  it("names every ring it excuses, and excuses none that is a control's only edge", () => {
    // The one hand-list left in this describe, so it is worth saying out loud
    // what is on it. Each entry is a hairline ADDED in a state, over an element
    // whose identification does not depend on it — and each one is a rule that
    // really is in the sheet, so an exemption cannot outlive the thing it
    // excused and start quietly covering something else.
    for (const excused of EXEMPT_RINGS) {
      const rule = RULES.find(r => selectors(r.selector).includes(excused));
      expect(rule, `${excused} is excused from the ring sweep but is not in the sheet`).toBeTruthy();
      expect(ringColourIn(rule!.body), `${excused} is excused from the ring sweep but draws no ring`)
        .not.toBeNull();
      // A state, never a resting appearance: `:hover`, `.dragging`, `.on`.
      expect(excused, `${excused} is a resting rule and may not be excused`)
        .toMatch(/:hover|\.dragging|:active/);
    }
  });
});

describe("the control surface, promoted (#332)", () => {
  it("lives at :root in both themes and is mixed from the foreground", () => {
    // The property that made #325's fix work and the reason it is safe to
    // promote: a value derived from var(--text) exists in both themes by
    // construction. A value borrowed from another surface does not — --bg-soft
    // is the proof, byte-identical to --panel on white.
    for (const theme of themes) {
      expect(TOK[theme]["--ctl-fill"], theme).toMatch(/var\(--text\)/);
      expect(TOK[theme]["--ctl-edge"], theme).toMatch(/var\(--text\)/);
    }
    expect(TOK.light["--bg-soft"]).toBe(TOK.light["--panel"]);
  });

  it("did not buy any of it by lifting --line", () => {
    // The trap #325 named and refused. --line is the app's structural hairline
    // — panel edges, table rules, separators, card outlines, the scrollbar
    // thumb — and lifting it to clear 3:1 would redraw all of them to fix a
    // defect that is the controls'. Pinned by value, in both themes.
    expect(TOK.dark["--line"]).toBe("#1f2229");
    expect(TOK.light["--line"]).toBe("#c8cdd6");
    expect(TOK.dark["--line-soft"]).toBe("#1a1c22");
    expect(TOK.light["--line-soft"]).toBe("#dde1e8");
  });

  it("left no control reading --line for its own edge", () => {
    for (const c of CONTROLS) {
      expect(borderColour(c.at), c.at).not.toBe("var(--line)");
    }
  });

  it("retired the row-scoped copy rather than keeping two names for one idea", () => {
    expect(bare).not.toMatch(/--ap-ctl-/);
    // …and did not simply move the scope down a level: the readers are spread
    // across the topbar, the banner, the canvas, two side panels and a dialog.
    // Twenty-four rules at the time of writing; a floor rather than a count,
    // so deleting a control does not fail this and re-scoping the tokens back
    // to one block does.
    //
    // The floor was 20 against 23 readers, which left room for three deletions
    // and no more — so the first change that actually did what the sentence
    // above says is allowed failed it. Four rules stopped reading the tokens
    // when the panel and dialog header closes went bare: the fill and edge
    // `.detail-close:hover` grew, the edge `.ctx-modal-close` rested on and the
    // fills under `.ctx-modal-close:hover` and `.uh-close:hover`. None of that
    // is a re-scope; it is four boxes that stopped being drawn.
    //
    // So the count is a floor with slack in it again, and the claim the count
    // was standing in for is asserted directly underneath. A re-scope is not
    // really "fewer readers" — it is readers that all live in one place — and
    // counting the distinct blocks they sit in says so whatever the total does.
    const readers = RULES.filter(r => /var\(--ctl-(fill|edge)\)/.test(r.body));
    expect(readers.length).toBeGreaterThanOrEqual(15);
    expect(readers.filter(r => r.selector.startsWith(".ap-")).length).toBeLessThan(readers.length / 2);
    const areas = new Set(readers.map(r => selectors(r.selector)[0].split(/[\s:.]+/).filter(Boolean)[0]));
    expect(areas.size, `--ctl-* is read from ${[...areas].sort().join(", ")}`).toBeGreaterThanOrEqual(10);
  });

  it("is a fill for controls that write in --text, and the sheet knows which those are", () => {
    // --ctl-fill is mixed FROM the foreground, so it moves the bed toward the
    // words: 7% of --text lifts the dark panel enough that --muted lands at
    // 4.05:1 on it. That is fine under a label written in --text (11.15:1) and
    // wrong under one written in --muted, which is why the four controls below
    // keep the flat --bg-soft wash and take their identification from the edge
    // instead. Not a preference — the arithmetic is in this test.
    for (const theme of themes) {
      for (const [name, bed] of textBeds(theme)) {
        const fill = over(resolve("var(--ctl-fill)", theme), bed);
        expect(contrastRatio(parseColor(TOK[theme]["--text"]), fill), `${theme} --text on the fill over ${name}`)
          .toBeGreaterThanOrEqual(BODY);
      }
    }
    const darkFill = over(resolve("var(--ctl-fill)", "dark"), parseColor(TOK.dark["--panel"]));
    expect(contrastRatio(parseColor(TOK.dark["--muted"]), darkFill)).toBeLessThan(BODY);
    for (const sel of [".selected-ribbon", ".aa-field input", ".session-list .sl-row:hover"]) {
      expect(decl(sel, "background"), sel).toBe("var(--bg-soft)");
    }
  });

  it("stopped asking --accent-dim to be a boundary anywhere, however the boundary is spelled", () => {
    // 1.91:1 dark, 1.39:1 light. It is a fill and a glow and it is fine at
    // both; as a border colour it was under the resting edge of every control
    // that hovered to it, which made the pointer take contrast away.
    //
    // #629 widened this from two property names to every one that can carry a
    // border colour, and turned it into a collecting sweep. It read
    // `border-color` and `border` only, which
    // `declIn` matches anchored, so `border-bottom-color: var(--accent-dim)`
    // — a one-sided hover underline, the ordinary thing to reach for on a
    // control, and a spelling this sheet already uses at `.ver-banner.done` —
    // walked a 1.39:1 light edge straight past a check that calls itself
    // "anywhere".
    //
    // It also asserted nothing when it passed: the old `expect.unreachable`
    // sat inside an `if`, so the intended state ran the body to completion
    // having called no matcher. It was the only case in the repository that
    // did. `toEqual([])` records the assertion, prints the offenders when
    // there are any, and lets the guard below tell "found nothing" apart from
    // "looked nowhere".

    // The premise, measured rather than quoted, so the case carries its own
    // reason and stops being true the day the token stops being faint. An edge
    // composites over the fill and this token's own wash is the fill it is
    // usually drawn on, so the panel is the honest bed for it.
    const dimOnPanel = (theme: Theme) => {
      const panel = parseColor(TOK[theme]["--panel"]);
      return contrastRatio(over(resolve("var(--accent-dim)", theme), panel), panel);
    };
    const ratios = themes.map(t => `${t} ${dimOnPanel(t).toFixed(2)}:1`).join(", ");
    for (const theme of themes) {
      expect(dimOnPanel(theme), `--accent-dim is ${ratios} — if it now clears ${NON_TEXT}:1 as a boundary, this case has outlived its reason`)
        .toBeLessThan(NON_TEXT);
    }

    const offenders = EDGE_DECLS
      .filter(d => /--accent-dim/.test(d.raw))
      .map(d => `${d.selector} { ${d.prop}: ${d.raw} }`);
    expect(offenders, `--accent-dim as a control boundary reads ${ratios}, under the ${NON_TEXT}:1 of 1.4.11`)
      .toEqual([]);

    // Anti-vacuity. An empty input set passes the line above for the wrong
    // reason, and every way of emptying it is a plausible edit: a parser that
    // stops finding rules, a property list somebody trims, a `declIn` whose
    // regex stops matching. Floors with slack in them rather than counts —
    // 191 and 37 today, so the sheet can lose most of its borders without
    // failing this and cannot lose the sweep.
    expect(EDGE_DECLS.length, "the --accent-dim sweep read no border declarations at all")
      .toBeGreaterThan(120);
    const widened = EDGE_DECLS.filter(d => d.prop !== "border" && d.prop !== "border-color");
    expect(widened.length,
      "the sweep is back to reading `border` and `border-color` only, which is what #629 was")
      .toBeGreaterThan(15);
  });
});

describe("the two status hues, on the canvas as well as on the panels", () => {
  it("reads --ok and --warn at 4.5:1 on every opaque surface in the sheet", () => {
    // They were 4.43:1 and 4.44:1 on --bg and 5.02:1 on --panel, so they failed
    // exactly where they are read most: a tool burst's ✓ and a node's cost.
    for (const theme of themes) {
      for (const token of ["--ok", "--warn"]) {
        const fg = parseColor(TOK[theme][token]);
        for (const [name, bed] of textBeds(theme)) {
          expect(contrastRatio(fg, bed), `${theme} ${token} on ${name}`).toBeGreaterThanOrEqual(BODY);
        }
      }
    }
  });

  it("reads each status pill's own word at 4.5:1 wherever in the topbar it lands", () => {
    // The pill is centred in 52px of a gradient, so an alpha wash gave its word
    // one ratio at the top of the bar and another at the bottom — 4.39:1 and
    // 3.90:1 for `live`. The light tints are opaque now, which is the same fix
    // #268 applied to the node rings for the same reason.
    for (const theme of themes) {
      const beds = surfaces(theme);
      for (const [state, token] of [["live", "--ok"], ["paused", "--warn"], ["dead", "--err"]] as const) {
        const light = RULES.find(r =>
          selectors(r.selector).includes(`:root[data-theme="light"] .topbar .status .pill.${state}`));
        const fillRaw = (theme === "light" ? declIn(light!.body, "background") : null)
          ?? decl(".topbar .status .pill", "background")!;
        if (theme === "light") expect(fillRaw, state).not.toMatch(/rgba\(/);
        const fg = parseColor(TOK[theme][token]);
        for (const bedName of TOPBAR) {
          const fill = over(resolve(fillRaw, theme), beds[bedName]);
          expect(contrastRatio(fg, fill), `${theme} .pill.${state} on ${bedName}`).toBeGreaterThanOrEqual(BODY);
        }
      }
    }
  });
});
