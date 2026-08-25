// Three controls, three different ways of telling the user something that was
// not true. They are unrelated in the interface and identical in shape, which
// is why #546 filed them together and why one file pins all three.
//
// The auto-switch toggle said nothing about itself. It carried `role="switch"`
// and `aria-checked`, so the state channel was right, but its accessible name
// came from its own contents — and its contents are the single word "off", or
// "on" once it is armed. A screen reader walking the accounts panel therefore
// read "Switch threshold, combo box, 90%" and then "off, switch, off": the one
// control that decides whether the deck changes your Claude account behind your
// back named itself after its own state. Once armed the name became "on", so a
// voice-control user had to say *click off* in order to turn it ON, which is
// the failure inverted. `title` could not rescue it — the accessible name
// algorithm reaches an element's contents before it reaches its title, so the
// tooltip resolved to a description — and the `<h3>Auto-switch</h3>` above it
// was a heading in the neighbourhood, not a programmatic label. `aria-label`
// outranks contents, which is what every other nameless control in this panel
// was given in the #381 sweep.
//
// The failure box's × was 13.5 x 14.4 CSS px. That is under WCAG 2.2 SC 2.5.8's
// 24 x 24 floor on both axes, on the only control that clears a red box the
// panel otherwise never clears by itself, and the standard's spacing exception
// does not apply to a target sitting 6px from its own caption. The rule's
// comment had argued the size from the ink — 10px text in a 288px panel, where
// a button-sized button would shout — and the argument is a good one about ink
// and says nothing at all about where a finger may land.
//
// The session header pill promised a drag it has never had. `.cluster-label`
// declared `cursor: grab` and `touch-action: none` over a plain <button> whose
// only handler is a fit-view click; the drag belongs to the invisible
// sessionGroup node behind the cards, and App.tsx deliberately stops that
// handle short of the header strip so a click can reach the label. So you press
// the pill, you pull, nothing follows the cursor — and on release the click
// fires anyway and the viewport flies off to frame that session, a camera move
// the user did not ask for and was invited to make by the cursor. Two rules for
// `.cluster-label.dragging` sat underneath it painting a drag state onto an
// element nothing has ever put `dragging` on.
//
// This suite has no DOM and no layout engine, so nothing below is measured in a
// browser: it reads the two components and the stylesheet as text and pins the
// declarations the geometry and the naming come out of, the way
// ver-close-button.test.ts and panel-rhythm.test.ts do. The one number written
// out by hand is 24, which belongs to the standard rather than to this sheet.
// Every size is computed from what the CSS says, so that raising the glyph or
// its line-height moves what the test asserts instead of quietly falsifying it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

/** Comments quote what they replaced — this change wrote `cursor: grab`,
 *  `.cluster-label.dragging` and `aria-label` into prose a few lines from the
 *  rules that no longer contain them — so every read below is of the stripped
 *  text, and a comment can never satisfy an assertion. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

const css = strip(read("../styles.css"));
const accounts = strip(read("../components/AccountsPanel.tsx"));
const clusters = strip(read("../components/SessionClusters.tsx"));

/** WCAG 2.2 SC 2.5.8, in CSS pixels. The only hand-written number in the file. */
const TARGET_FLOOR = 24;

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

/** Every rule in the sheet, @media bodies flattened in — a cursor or a target
 *  declared inside a media query is still a cursor and still a target. */
function allRules(src: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    if (prelude.startsWith("@")) out.push(...allRules(inner));
    else out.push({ selector: prelude, body: inner });
    i = end + 1;
  }
  return out;
}

const RULES = allRules(css);
const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

/** Every top-level rule naming this exact selector, concatenated in source
 *  order, which is the cascade an element with that selector alone sees. */
function bodyOf(selector: string): string {
  const hit = RULES.filter(r => selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

/** The last declaration of `prop` in a body, which is the one that wins. */
function declIn(body: string, prop: string): string | null {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}

const decl = (selector: string, prop: string) => declIn(bodyOf(selector), prop);

/** A length in px, as a number. */
function px(selector: string, prop: string): number {
  const v = decl(selector, prop);
  const m = v && /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  if (!m) throw new Error(`${selector} { ${prop}: ${v} } is not a px length`);
  return Number(m[1]);
}

/** A shorthand box, expanded the way CSS expands it: top right bottom left. */
function box(selector: string, prop: string): [number, number, number, number] {
  const raw = decl(selector, prop);
  if (raw === null) throw new Error(`no ${prop} on ${selector}`);
  const parts = raw.split(/\s+/).map(p => {
    const m = /^(-?\d+(?:\.\d+)?)(?:px)?$/.exec(p);
    if (!m) throw new Error(`${selector} { ${prop}: ${raw} } has a side this file cannot read`);
    return Number(m[1]);
  });
  const [a, b = a, c = a, d = b] = parts;
  return [a, b, c, d];
}

// ── the components, as markup ───────────────────────────────────────────────

/** The open tag beginning at `from`, with braces and quotes tracked so that the
 *  `>` of an `onClick={() => …}` does not end the tag five attributes early —
 *  the same hazard control-edges.test.ts' scanner exists to survive. */
function openTagAt(src: string, from: number): string {
  let depth = 0;
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return src.slice(from, i + 1);
  }
  throw new Error("unterminated open tag");
}

/** The one element in a source that carries `marker`, from its `<` to its `>`. */
function tagCarrying(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} in this component`);
  const start = src.lastIndexOf("<", at);
  return openTagAt(src, start);
}

describe("the auto-switch toggle says what it switches, not what it is set to", () => {
  const toggle = tagCarrying(accounts, 'role="switch"');
  /** What every assertion here is really reporting, said once. */
  const NAMELESS =
    "the auto-switch has no aria-label, so its accessible name is whatever its "
    + 'contents spell — "off" when it is off, "on" when it is on';

  it("is still the switch it was, so the state keeps its own channel", () => {
    expect(toggle.startsWith("<button")).toBe(true);
    expect(toggle).toContain('type="button"');
    expect(toggle).toContain('role="switch"');
    expect(toggle).toContain("aria-checked={auto.enabled}");
  });

  it("carries a name of its own, since its contents can only spell its state", () => {
    // The contents are still "on"/"off" — they are the right thing to SHOW and
    // were never a name. aria-label outranks them, which is the whole fix.
    expect(accounts).toContain('{auto.enabled ? "on" : "off"}');
    expect(/aria-label="[^"]+"/.test(toggle), NAMELESS).toBe(true);
  });

  it("names itself with the words already on the screen above it", () => {
    // SC 2.5.3: what a voice-control user has to pronounce is what they can
    // read. The section's visible title is the h3 this switch sits under.
    const heading = /<h3 className="ap-auto-title">([^<]+)<\/h3>/.exec(accounts);
    expect(heading, "the auto-switch section lost its visible title").not.toBeNull();
    const name = /aria-label="([^"]+)"/.exec(toggle);
    expect(name, NAMELESS).not.toBeNull();
    expect(name![1]).toBe(heading![1]);
  });

  it("keeps that name still while the switch moves under it", () => {
    // A name that flips with the state is the defect one step sideways: the
    // control would still be called something different depending on whether it
    // is on. Only aria-checked is allowed to depend on `auto.enabled`.
    const name = /aria-label=(\{[^}]*\}|"[^"]*")/.exec(toggle);
    expect(name, NAMELESS).not.toBeNull();
    expect(name![1]).not.toContain("auto.enabled");
    expect(name![1]).not.toContain("?");
  });

  it("leaves the tooltip to say the longer thing, which is a description", () => {
    // title is kept and is still state-dependent, which is correct for a
    // description. It is simply no longer the only thing this control says.
    expect(toggle).toContain("title={auto.enabled");
  });

  it("does not stand alone — the panel's other nameless controls were named too", () => {
    // The #381 sweep this one was missed by. Named here so that a later change
    // stripping any of them fails beside the switch rather than silently.
    for (const named of [
      'aria-label="Add an account"',
      'aria-label="Reload accounts"',
      'aria-label="Switch threshold"',
      'aria-label="Dismiss this message"',
    ]) expect(accounts).toContain(named);
  });
});

describe("the failure box's dismiss is a target as well as a glyph", () => {
  // What the reader sees, computed rather than quoted: a 12px glyph on a 1.2
  // line box, with 3px of padding down each side. Both numbers move if the
  // sheet ever redraws the ×, and everything below moves with them.
  const fontSize = px(".ap-failure-x", "font-size");
  const lineHeight = Number(decl(".ap-failure-x", "line-height"));
  const [, padRight, , padLeft] = box(".ap-failure-x", "padding");
  const paintedHeight = fontSize * lineHeight;

  /** What the pointer gets: a transparent pseudo-element, centred on the glyph
   *  by handing half of its own size back as a margin.
   *
   *  Read here rather than beside the numbers above, and asserted into
   *  existence first: a sheet that has lost the rule should fail the three
   *  assertions about the target by name, not take the file's other two
   *  controls down with it at collection time. */
  function target() {
    expect(
      RULES.find(r => selectors(r.selector).includes(".ap-failure-x::after")),
      ".ap-failure-x has no ::after — the dismiss is back to the size of its glyph",
    ).toBeTruthy();
    const [marginTop, , , marginLeft] = box(".ap-failure-x::after", "margin");
    return {
      width: px(".ap-failure-x::after", "width"),
      height: px(".ap-failure-x::after", "height"),
      marginTop,
      marginLeft,
    };
  }

  it("is drawn small enough that the glyph alone could never clear the floor", () => {
    // Not a formality: it is the reason the pseudo-element has to exist at all.
    // If a later change grows the × past 24px this fails, and it should — the
    // extra box would then be redundant rather than load-bearing.
    expect(paintedHeight).toBeLessThan(TARGET_FLOOR);
    expect(padLeft + padRight).toBeLessThan(TARGET_FLOOR);
  });

  it("clears 24 x 24 on both axes, which is what SC 2.5.8 asks for", () => {
    const t = target();
    expect(t.width).toBeGreaterThanOrEqual(TARGET_FLOOR);
    expect(t.height).toBeGreaterThanOrEqual(TARGET_FLOOR);
  });

  it("sits centred on the glyph, so the reach is the same on all four sides", () => {
    // Centring is what makes the size above a target rather than a rectangle
    // hanging off one corner of the character. Half the box back as a negative
    // margin is the technique `.empty-hero .core` already uses in this sheet.
    const t = target();
    expect(decl(".ap-failure-x::after", "position")).toBe("absolute");
    expect(decl(".ap-failure-x::after", "top")).toBe("50%");
    expect(decl(".ap-failure-x::after", "left")).toBe("50%");
    expect(t.marginTop).toBe(-t.height / 2);
    expect(t.marginLeft).toBe(-t.width / 2);
    // And it really does cover the ink it is centred on, at whatever size the
    // ink is drawn — the property that survives a change to the glyph.
    expect(t.height).toBeGreaterThanOrEqual(paintedHeight);
  });

  it("is anchored to the button rather than to whatever is positioned above it", () => {
    // Without this the pseudo-element resolves against some ancestor and the
    // target lands somewhere else in the panel entirely.
    target();
    expect(decl(".ap-failure-x", "position")).toBe("relative");
    expect(decl(".ap-failure-x::after", "content")).toBe('""');
  });

  it("paints nothing, so the box that was drawn is still the box that shows", () => {
    // The original comment's argument, kept: a real hit area would be the
    // loudest thing in a 288px panel. A transparent pseudo-element is not one.
    target();
    const after = bodyOf(".ap-failure-x::after");
    for (const painted of ["background", "border", "box-shadow", "outline", "color"])
      expect(declIn(after, painted), `${painted} on .ap-failure-x::after`).toBeNull();
  });

  it("takes no room from the message it dismisses", () => {
    // The other two ways to reach 24px both charge the sentence for it:
    // padding and a min-width/min-height pair each widen a flex item inside a
    // row whose text is already `flex: 1; min-width: 0`.
    const rule = bodyOf(".ap-failure-x");
    for (const grew of ["min-width", "min-height", "width", "height"])
      expect(declIn(rule, grew), `${grew} on .ap-failure-x`).toBeNull();
    expect(declIn(rule, "font-size")).toBe(`${fontSize}px`);
    expect(declIn(rule, "background")).toBe("none");
  });

  it("still names itself, which is the half of this control that was already right", () => {
    const dismiss = tagCarrying(accounts, 'className="ap-failure-x"');
    expect(dismiss).toContain('aria-label="Dismiss this message"');
  });
});

describe("the session header pill offers only the gesture it has", () => {
  const label = tagCarrying(clusters, 'className="cluster-label"');

  it("is a button with a click and nothing else", () => {
    expect(label.startsWith("<button")).toBe(true);
    expect(label).toContain("onClick={() => focusSession(c.sessionId)}");
    for (const drag of ["onPointerDown", "onMouseDown", "onDragStart", "onTouchStart", "draggable"])
      expect(label, `the label grew a ${drag}`).not.toContain(drag);
  });

  it("shows the cursor a button shows, not the one a drag surface shows", () => {
    expect(decl(".cluster-label", "cursor")).toBe("pointer");
  });

  it("promises no drag anywhere in the sheet, in any state or theme", () => {
    for (const rule of RULES) {
      if (!/\.cluster-label(?![\w-])/.test(rule.selector)) continue;
      const cursor = declIn(rule.body, "cursor") ?? "";
      expect(cursor, `${rule.selector} { cursor: ${cursor} }`).not.toMatch(/grab/);
      // touch-action: none took the gesture away from the browser and handed it
      // to a pointer-drag that was never written. Nothing is left to hand it to.
      expect(declIn(rule.body, "touch-action"), rule.selector).toBeNull();
    }
  });

  it("has no rule left for a state it cannot be in", () => {
    // `dragging` is React Flow's class, written onto `.react-flow__node-*`, and
    // App.tsx's is `dragging-any` on `.canvas-wrap`. Neither is this element,
    // and nothing else ever touches this element's class list — the className
    // is a constant string, so there is no runtime that could add one.
    const dead = RULES.flatMap(r => selectors(r.selector))
      .filter(s => /\.cluster-label(?![\w-])[^,]*\.dragging/.test(s));
    expect(dead, "a rule painting a drag state onto a label that cannot be dragged").toEqual([]);
    expect(clusters).not.toContain("dragging");
    expect(clusters).toContain('className="cluster-label"');
  });

  it("leaves the grab cursor where a drag really is", () => {
    // The point is not that this sheet may not say `grab`; it is that only the
    // surfaces that move may say it. Both of the ones that do still do.
    expect(decl(".session-group-handle", "cursor")).toBe("grab");
    expect(decl(".react-flow__node-sessionGroup", "cursor")).toBe("grab");
  });
});
