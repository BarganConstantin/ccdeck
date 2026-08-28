// Three topbar defects that share a bar and nothing else: a control that
// resizes itself under the pointer (#504), a fill that eases a layout property
// twelve times a tick (#505), and the deck's most consequential sentence living
// in a `title` on a non-focusable span (#510).
//
// None of them can be re-measured here — plain node, no DOM, no layout engine,
// and React cannot be rendered in this suite. Every number quoted below was
// taken from headless Chrome against this same stylesheet, at 1470px and 1x DPR
// in both themes, and what this file does is pin the RULES and the STRINGS that
// produce them, the way panel-rhythm.test.ts and toggle-state.test.ts do.
//
// The measurements, so the assertions have something to be about:
//
//   #504  `Pause` 60.16px · `Resume` 71.11px · `Resume · 999 held` 132.03px.
//         Pressing Space walked the button 45px left and the selected-agent
//         ribbon 28px; the eight buttons to its right did NOT move, because
//         `.actions` is `flex: none` against a `space-between` bar. After the
//         fix all six reachable labels render at 131.8px and x=1110.2, and the
//         ribbon holds at 697.38 — one box, one position, every state.
//   #505  All twelve columns land within 0.01px of where `height` put them;
//         the whole difference in a 1x capture is 160 pixels of 6500, one to
//         three antialiased rows at each column's own top edge.
//   #510  Chrome reports the pill as `role=generic, name="", description="SSE
//         disconnected"`. The pause button, by contrast, reports
//         `role=button, name="Resume · 99+ held"` with the ghost span ignored
//         for `ariaHiddenElement` — so the fix for #504 costs #510 nothing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  HELD_LABEL_CAP, heldEvents, heldShort, outageSentence, PAUSE_LABEL, pauseTitle, statusPill,
} from "../status-pill";

const web = fileURLToPath(new URL("..", import.meta.url));
const rawCss = readFileSync(join(web, "styles.css"), "utf8");
/** The comments in this sheet quote the declarations they replaced — including
 *  `transition: height` and the 18px box — so every read goes through the
 *  stripped copy or the assertions would pass on their own explanations. */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

function markup(...path: string[]): string {
  return readFileSync(join(web, ...path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}
const app = markup("App.tsx");
const systemMeter = markup("components", "SystemMeter.tsx");

// ── the stylesheet, as rules ────────────────────────────────────────────────

function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

type Rule = { selector: string; body: string; reduced: boolean };

/** Every rule, carrying whether a reduced-motion block encloses it. */
function collect(src: string, reduced: boolean, out: Rule[]): Rule[] {
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    if (prelude.startsWith("@keyframes")) {
      // not a rule
    } else if (prelude.startsWith("@")) {
      collect(inner, reduced || /prefers-reduced-motion\s*:\s*reduce/.test(prelude), out);
    } else if (prelude) {
      out.push({ selector: prelude, body: inner, reduced });
    }
    i = end + 1;
  }
  return out;
}

const RULES = collect(css, false, []);
const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

function bodyOf(selector: string): string {
  const hit = RULES.filter(r => !r.reduced && selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

function declIn(body: string, prop: string): string | null {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}
const decl = (selector: string, prop: string) => declIn(bodyOf(selector), prop);

/** Commas inside cubic-bezier() are not list separators. */
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
const transitioned = (value: string | null): string[] =>
  value == null || value === "none" ? [] : splitTop(value).map(p => p.split(/\s/)[0]);

// ── #504 — one box, every count ─────────────────────────────────────────────
//
// The defect moved with the string. #504 was the Pause BUTTON resizing itself
// as its label went `Pause` → `Resume` → `Resume · 42 held`; the button has
// since left the bar for the canvas control stack, and the held count it
// printed is in the status pill's label instead. That is the same string with a
// worse neighbourhood: the pill LEADS the readout strip, so its width is
// upstream of the machine meter, the token total and the dollar figure, where
// the button had only itself and the ribbon downstream of it. And the count is
// the half that moves unbidden — the tone changes when somebody presses Space,
// but `paused · 9` becomes `paused · 10` while nobody touches anything.
//
// So the fix travels too: a hidden copy of the widest label this tone can reach,
// in the same grid cell as the live one, measuring itself in whatever face the
// platform supplies. Measured in headless Chrome against this same stylesheet at
// 1x DPR, at 1470px and 1200px, in both themes — every number below is identical
// across all four of those, which is itself the point:
//
//   paused at 0 / 9 / 42 / 150 held — the pill is 102.64px at every one of them,
//   and the meter, tokens and cost hold x = 298.61 / 348.61 / 459.66 through all
//   four. With the ghost taken back out of the same page, the same four labels
//   measure 71.08 / 88.05 / 95.34 / 102.64 and the meter walks 267.05 → 298.61,
//   taking the two readouts behind it 31.56px with it.
//   Resting `live` is 49.89px, which is its own word and not the paused box —
//   that is what the per-tone ghost buys, and it is 52.75px of bar that pinning
//   all three tones to one string would have spent permanently.
//
// The figures above were taken when `paused · 99+` was the tone's longest
// label. #547 gave it a fourth — `paused · full`, for a hold that has reached
// its ceiling and started dropping — so the reserved box is one glyph wider
// than those measurements and the whole strip sits that much further right
// while paused. Deliberately left unremeasured rather than restated from a
// guess: what the numbers are here for is the SHAPE of the result — one width
// across every count, and the paused tone's cost charged to the paused tone —
// and both survive the extra glyph unchanged. The assertions below are on the
// invariant, not on the pixels.

const PILL = ".topbar .status .pill .pill-box";

describe("the status pill stopped resizing itself (#504)", () => {
  it("caps the held count in the label and nowhere else", () => {
    // The cap is what bounds the label BY CONSTRUCTION rather than by
    // measurement: without it the string gains a character at 10, at 100, at
    // 1000, and no fixed box can be sized for a number with no ceiling.
    expect(heldShort(0)).toBe("0");
    expect(heldShort(1)).toBe("1");
    expect(heldShort(HELD_LABEL_CAP)).toBe(String(HELD_LABEL_CAP));
    expect(heldShort(HELD_LABEL_CAP + 1)).toBe(`${HELD_LABEL_CAP}+`);
    expect(heldShort(999999)).toBe(`${HELD_LABEL_CAP}+`);
    // The tooltip is not a box and does not owe the strip anything, so it keeps
    // saying the exact figure — and says it with its unit, which is the finding
    // statusPill was written for in the first place.
    const pill = statusPill({ connected: true, paused: true, held: 231 });
    expect(pill.title).toContain(heldEvents(231));
    expect(pill.title).toContain("231 events");
    expect(pill.label).toBe(`paused · ${HELD_LABEL_CAP}+`);
  });

  it("names a widest label that is one the pill really shows", () => {
    // A ghost string no state can produce would be a box sized for a fiction.
    // Since #547 the longest label the tone reaches is the one it shows once
    // the hold has filled and started dropping — `paused · full` — so that is
    // the string the box reserves, and this is the state that renders it.
    const full = statusPill({ connected: true, paused: true, held: 1000, dropped: 12 });
    expect(full.widest).toBe(full.label);
    expect(full.label).toBe("paused · full");
    // And it really is the longest: the count the pill used to reserve for is
    // one glyph shorter, which is the whole of what the change costs the bar.
    const over = statusPill({ connected: true, paused: true, held: HELD_LABEL_CAP + 1 });
    expect(over.label).toBe(`paused · ${HELD_LABEL_CAP}+`);
    expect(over.label.length).toBeLessThan(full.label.length);
  });

  it("reserves each tone its own worst case and not the loudest one", () => {
    // The one place this differs from the button, and deliberately. The button
    // pinned all three of its labels to `Resume · 99+ held`, which was right
    // for a control in a run of controls — every state of it had to occupy the
    // same slot. The pill's three tones are not states of one label, they are
    // three different facts, and only one of them carries a number that moves
    // on its own. Pinning `live` to the paused box costs 52.75px of the resting
    // bar, permanently, to still a transition a user causes by hand.
    for (const [state, want] of [
      [{ connected: true, paused: false, held: 0 }, "live"],
      [{ connected: false, paused: true, held: 40 }, "offline"],
      [{ connected: true, paused: true, held: 0 }, "paused · full"],
      [{ connected: true, paused: true, held: 150 }, "paused · full"],
      [{ connected: true, paused: true, held: 1000, dropped: 3 }, "paused · full"],
    ] as const) {
      expect(statusPill(state).widest, JSON.stringify(state)).toBe(want);
    }
  });

  it("is the longest of every label the tone can reach, and by a countable margin", () => {
    // Length stands in for width because the pill renders in tabular figures
    // (asserted below), so every digit is the same box. That makes the claim
    // arithmetic rather than typographic: the only count carrying three
    // characters is `99+`, and every other one carries at most two digits. The
    // fourth thing the slot can hold is the word `full`, at four — the ghost,
    // and the only label longer than the capped count.
    const variable = new Set<string>();
    for (const held of [0, 1, 2, 9, 10, 11, 42, 98, 99, 100, 101, 150, 999, 1000, 123456]) {
      for (const dropped of [0, 5]) {
        const pill = statusPill({ connected: true, paused: true, held, dropped });
        expect(pill.label.length, `"${pill.label}" is longer than the box`)
          .toBeLessThanOrEqual(pill.widest.length);
        const m = /^paused · (.+)$/.exec(pill.label);
        if (m) variable.add(m[1]);
      }
    }
    expect([...variable].filter(v => v.length > 2).sort())
      .toEqual([`${HELD_LABEL_CAP}+`, "full"]);
  });

  it("draws the ghost and the live label in one grid cell, so the box measures the worst case", () => {
    // A `min-width` in pixels was the other option and is the one this sheet
    // would normally reach for. It cannot work here: the number would be
    // measured in whatever face rendered it and then applied to Segoe UI on
    // Windows and to whatever fontconfig picks on Linux, and a wider face
    // simply overruns it. A hidden copy of the string measures itself.
    expect(decl(PILL, "display")).toBe("inline-grid");
    const area = decl(PILL, "grid-template-areas")!;
    const cell = /"([\w-]+)"/.exec(area)![1];
    for (const child of [".topbar .status .pill .pill-widest", ".topbar .status .pill .pill-label"]) {
      expect(declIn(bodyOf(child), "grid-area"), child).toBe(cell);
      expect(declIn(bodyOf(child), "white-space"), child).toBe("nowrap");
    }
    expect(decl(".topbar .status .pill .pill-widest", "visibility")).toBe("hidden");
    expect(decl(PILL, "font-variant-numeric")).toBe("tabular-nums");
    // Anchored to the dot at the left rather than centred, which is where the
    // button differed: the slack at zero held has to open where the count will
    // appear, or the word itself shifts when the first event lands.
    expect(decl(PILL, "justify-items")).toBe("start");
  });

  it("renders that ghost from the pill the app is already reading, not a second copy", () => {
    expect(app).toContain('<span className="pill-widest" aria-hidden>{pill.widest}</span>');
    expect(app).toContain('<span className="pill-label">{pill.label}</span>');
    // aria-hidden as well as visibility:hidden. Either alone keeps the ghost
    // out of what is announced; both is what makes it true of a reader that
    // walks the markup and of one that walks the render.
    expect(app).toMatch(/className="pill-widest" aria-hidden/);
  });

  it("does not animate the box, because animating a box means animating layout", () => {
    // #504 says this in as many words and it is worth pinning: a width
    // transition is a main-thread relayout that would owe reduced motion an
    // answer under this sheet's own rules, and a smoothly animated reflow is
    // still a reflow. The same reasoning is what moved `.sd-core-fill` off
    // `height` two describes down.
    const layout = ["width", "min-width", "max-width", "height", "all"];
    for (const sel of [PILL, ".topbar .status .pill .pill-widest",
                       ".topbar .status .pill .pill-label", ".topbar .status .pill"]) {
      const eased = transitioned(declIn(bodyOf(sel), "transition"));
      expect(eased.filter(p => layout.includes(p)), `${sel} eases a layout property`).toEqual([]);
    }
    expect(declIn(bodyOf(PILL), "min-width"),
      "a pixel min-width is the fix this control deliberately did not take").toBeNull();
  });

  it("adds no press obligation, because the pill is not a control at all", () => {
    // The pill is an unfocusable span with a title, which is the whole reason
    // #510 moved its one irreplaceable sentence into the connection banner. It
    // has no cursor, and neither do the two spans inside it — canvas-motion's
    // press sweep is keyed on `cursor: pointer`, so a stray one here would owe
    // five obligations for a thing nobody can press.
    for (const sel of [PILL, ".topbar .status .pill .pill-widest",
                       ".topbar .status .pill .pill-label", ".topbar .status .pill"]) {
      expect(declIn(bodyOf(sel), "cursor"), sel).toBeNull();
    }
  });
});

// ── the control that left the bar ───────────────────────────────────────────

describe("Pause is a canvas verb and lives on the canvas (#527's rule, applied last)", () => {
  /** The `<ControlButton>` whose aria-label is the pause control's. */
  const CONTROL = (() => {
    const at = app.indexOf("aria-label={PAUSE_LABEL}");
    expect(at, "no control carries PAUSE_LABEL").toBeGreaterThan(-1);
    const open = app.lastIndexOf("<ControlButton", at);
    return app.slice(open, app.indexOf("</ControlButton>", at));
  })();

  it("is gone from the topbar, markup and stylesheet together", () => {
    // Both halves, because either one left behind is a defect of its own: a
    // button with no rule renders as the browser's grey box (#515) and a rule
    // with no button is a selector nothing can match (dead-css.test.ts).
    expect(app).not.toMatch(/pause-btn|pause-widest|pause-label/);
    expect(css).not.toMatch(/\.pause-btn|\.pause-widest|\.pause-label/);
    // `.btn.warn` was worn by exactly one element — the Resume half of that
    // button — so it goes with it rather than waiting unworn for a next user.
    expect(css).not.toMatch(/button\.btn\.warn/);
    expect(app).not.toMatch(/className=\{`btn[^`]*warn/);
  });

  it("keeps the topbar runs it did not belong to", () => {
    // The removal takes a run with it — Pause was alone in the first one — and
    // that is the change, not a side effect: what is left is the disclosures
    // and the settings, which is the split the bar was regrouped into.
    expect((app.match(/<div className="action-run">/g) ?? [])).toHaveLength(2);
    expect(app).toMatch(/aria-label="Toggle usage panel"/);
    // #711 renamed this one. The button used to toggle the sound and now opens
    // a menu that holds the switch, two volumes, two sound choices and two
    // previews, so its name says what the press does rather than what it used
    // to do. What this case is about is unchanged and is why it still names a
    // control in the second run: the settings run still exists and still has
    // something in it.
    expect(app).toMatch(/aria-label="Sound settings"/);
  });

  it("is drawn the way the four glyphs beside it are drawn", () => {
    // The stack is a grammar: a 24-unit grid, strokes in currentColor at weight
    // 2, rendered at 14px. A glyph a weight or a box away from its neighbours
    // reads as a control from somewhere else.
    expect(CONTROL).toMatch(/<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>/);
    expect(CONTROL).toMatch(/stroke="currentColor"/);
    expect(CONTROL).toMatch(/strokeWidth="2"/);
    expect(CONTROL).toMatch(/fill="none"/);
    // And a name, because a glyph has none. The four around it each gained one
    // for the same reason when they moved.
    expect(CONTROL).toMatch(/aria-label=\{PAUSE_LABEL\}/);
    // `dropped` joined `held` in #547: the hold is bounded now, and a tooltip
    // that named the count without saying the queue had overflowed would be
    // describing a backlog that will be applied whole when it will not.
    // The gate stopped being `pauseRef.current` in #612 — it was seeded as a
    // `useRef` argument, so `createPauseGate()` ran on every render and every
    // gate but the first was discarded. It is a lazily-initialised value now
    // and the ref around it is gone; what the tooltip has to say is unchanged.
    expect(CONTROL).toMatch(
      /title=\{pauseTitle\(\{ paused, held: pauseGate\.size, dropped: pauseGate\.dropped \}\)\}/,
    );
  });

  it("reports which of its two states it is in, which its four neighbours need not", () => {
    // They are one-shot commands: a glyph is a complete account of what a
    // command does, and there is nothing true about Recenter between presses.
    // Pause is a setting that stays on. aria-pressed is this deck's word for
    // that — the sound switch has carried it since #370 — and not
    // aria-expanded, which would promise a region that appears.
    expect(CONTROL).toMatch(/aria-pressed=\{paused\}/);
    expect(CONTROL).not.toMatch(/aria-expanded|aria-haspopup/);
    // The name does not flip with it. "Resume the canvas, pressed" is two
    // halves contradicting each other; the state belongs in the attribute.
    expect(PAUSE_LABEL).toBe("Pause the canvas");
    expect(CONTROL).not.toMatch(/Resume/);
  });

  it("draws that state as a polarity step, not as a hue", () => {
    // #370's finding, on a second surface. Greyscale, a photocopy and every
    // colour vision deficiency keep a luminance inversion and lose a hue swap,
    // so the glyph goes from lighter-than-its-bed to darker-than-its-bed in
    // dark and the other way in light. Amber rather than the accent because
    // amber is what a frozen canvas is drawn in everywhere else on this deck.
    const on = '.react-flow__controls-button[aria-pressed="true"]';
    expect(decl(on, "background")).toBe("var(--warn)");
    expect(decl(on, "color")).toBe("var(--bg)");
    expect(decl(".react-flow__controls-button", "color")).toBe("var(--text)");
    expect(decl(".react-flow__controls-button", "background")).toBe("var(--panel)");
    // Keyed on the attribute, so the pixels and the tree cannot disagree.
    expect(css).not.toMatch(/\.react-flow__controls-button\.paused/);
  });

  it("answers the pointer while pressed, which the fill alone would not", () => {
    // The unpressed hover repaints the background and the pressed state has
    // already claimed it, so without a channel of its own a pressed Pause would
    // give the pointer nothing — the wall #370 hit on the topbar toggles. The
    // halo it answered with cannot work here: `.react-flow__controls` is
    // `overflow: hidden` and clips one. An inset keyline is not clipped.
    const hover = bodyOf('.react-flow__controls-button[aria-pressed="true"]:hover');
    expect(declIn(hover, "box-shadow")).toBe("inset 0 0 0 2px var(--bg)");
    expect(decl(".react-flow__controls", "overflow")).toBe("hidden");
  });

  it("adds no press obligation, because it is React Flow's own button underneath", () => {
    // Reusing the stack's class is what avoids all five of the obligations
    // canvas-motion.test.ts enumerates for a pressable name. What would create
    // them is `cursor: pointer` in this sheet, which is what that sweep is
    // keyed on.
    for (const sel of ['.react-flow__controls-button[aria-pressed="true"]',
                       '.react-flow__controls-button[aria-pressed="true"]:hover',
                       ".react-flow__controls-button"]) {
      expect(declIn(bodyOf(sel), "cursor"), sel).toBeNull();
    }
  });

  it("leaves Space exactly where it was", () => {
    // The key is how this feature is actually used and nothing about it moved:
    // the same handler, the same gate, the same row in the shortcuts sheet.
    expect(app).toMatch(/if \(e\.key === " "\) \{ e\.preventDefault\(\); togglePause\(\); \}/);
    expect(app).toMatch(/<kbd>space<\/kbd><span>pause \/ resume<\/span>/);
    expect(CONTROL).toMatch(/onClick=\{togglePause\}/);
  });
});

// ── #505 — the per-core fills ───────────────────────────────────────────────

describe("the machine panel's core fills are composited, not laid out (#505)", () => {
  const FILL = ".sysdetail .sd-core-fill";
  const SIBLING = ".sysdetail .sd-fill";

  it("eases transform where it used to ease height", () => {
    const eased = transitioned(decl(FILL, "transition"));
    expect(eased).toContain("transform");
    expect(eased).not.toContain("height");
  });

  it("scales a full-height column, which is the only way flex-end stays in place", () => {
    // The half that makes this more than a find-and-replace. The track is
    // `align-items: flex-end` with `overflow: hidden`, so a scaleY is the same
    // picture as a height only if the box being scaled fills the track to begin
    // with — `height: 100%` is what makes the alignment a no-op — and only if
    // the origin is where flex-end used to put the fill.
    expect(decl(FILL, "height")).toBe("100%");
    expect(decl(FILL, "transform-origin")).toBe("bottom");
    expect(decl(".sd-core", "align-items")).toBe("flex-end");
    expect(decl(".sd-core", "overflow")).toBe("hidden");
  });

  it("is written as a transform by the component too, with the 2% floor intact", () => {
    expect(systemMeter).toMatch(/className="sd-core-fill" style=\{\{ transform: `scaleY\(\$\{Math\.max\(2, v\) \/ 100\}\)` \}\}/);
    expect(systemMeter).not.toMatch(/sd-core-fill[\s\S]{0,120}height:/);
  });

  it("now agrees with the sibling it was supposed to have been converted with", () => {
    // The defect was an inconsistency inside one component: `.sd-fill` was moved
    // to a transform and the rule two declarations above it was not. Asked of
    // both, so neither can drift back on its own.
    for (const sel of [FILL, SIBLING]) {
      expect(transitioned(declIn(bodyOf(sel), "transition")), sel).toContain("transform");
      expect(declIn(bodyOf(sel), "height"), sel).toBe("100%");
    }
    expect(systemMeter).toMatch(/transform: `scaleX\(/);
  });

  it("keeps the reduced-motion answer that covered the property it replaced", () => {
    // `transition: none` neutralises whatever the rule eases, so the answer did
    // not have to change — but "did not have to change" is the kind of claim
    // that is worth a test rather than a shrug.
    const answers = RULES.filter(r => r.reduced
      && selectors(r.selector).some(s => s === FILL || s === SIBLING));
    expect(answers.length).toBeGreaterThan(0);
    for (const sel of [FILL, SIBLING]) {
      expect(answers.some(r => selectors(r.selector).includes(sel)
        && declIn(r.body, "transition") === "none"), sel).toBe(true);
    }
  });
});

// ── #510 — the sentence that was mouse-only ─────────────────────────────────

describe("the outage explanation reaches something other than a pointer (#510)", () => {
  it("says nothing while the stream is up, or while the canvas is running", () => {
    // The banner already says the connection is gone in its own words. What was
    // missing is only what the two states mean together, so that is all this
    // adds — a role="alert" that repeats itself is a role="alert" people stop
    // reading.
    expect(outageSentence({ connected: true, paused: false })).toBeNull();
    expect(outageSentence({ connected: true, paused: true })).toBeNull();
    expect(outageSentence({ connected: false, paused: false })).toBeNull();
  });

  it("names the key and the consequence when both are true", () => {
    const said = outageSentence({ connected: false, paused: true })!;
    expect(said).toContain("Space");
    expect(said).toMatch(/paused/i);
    expect(said).toMatch(/until the stream is back/);
  });

  it("keeps the pill's own claim rather than a stronger one", () => {
    // The issue paraphrases the tooltip as "resuming a disconnected deck will
    // not recover the missed events", which is a statement about events being
    // destroyed. The tooltip itself says resuming "will not bring events back
    // UNTIL it reconnects" — a queue that is not being fed, not a queue that
    // has been thrown away. The sentence in the banner keeps the smaller claim,
    // because the deck replays from the event log and the larger one would be
    // false.
    const pillTitle = statusPill({ connected: false, paused: true, held: 3 }).title;
    expect(pillTitle).toContain("until it reconnects");
    expect(outageSentence({ connected: false, paused: true })).not.toMatch(/cannot be recovered|lost forever/);
  });

  it("renders inside the banner that already announces, and only there", () => {
    expect(app).toMatch(/<div className="conn-banner" role="alert">/);
    expect(app).toMatch(/const outage = outageSentence\(\{ connected: live, paused \}\);/);
    expect(app).toMatch(/\{outage && <span className="conn-sub">\{outage\}<\/span>\}/);
  });

  it("earns that choice — the banner has no dismiss control, which the pill was kept for", () => {
    // The tradeoff #510 sets up is "discoverability forever versus announced
    // once", resting on the premise that the banner is dismissible and the pill
    // is not. It is not: `.conn-banner` carries no control at all. The VERSION
    // banner is the dismissible one, and `.ver-close` is how you can tell the
    // two apart. So the banner is on screen for exactly as long as the
    // condition, which is the property the pill was being kept for.
    // The two lookups carry the case, so a miss has to fail rather than answer
    // a sentinel (#652). `slice()` on a -1 hands back the LAST CHARACTER of
    // App.tsx, the inner indexOf on that character is -1 in turn, and
    // `slice(0, -1)` is the empty string — which contains no button, no
    // onClick and no ver-close, so the premise of the whole tradeoff above went
    // green over nothing. Measured against the real file: writing the class as
    // a template literal, which is what this line will meet the first time the
    // banner takes a tone, dropped both to -1 and the assertion still passed.
    const at = app.indexOf('<div className="conn-banner"');
    expect(at, 'App.tsx has no literal `<div className="conn-banner"` — the check below would be reading the empty string')
      .toBeGreaterThan(-1);
    const banner = app.slice(at);
    const end = banner.indexOf("</div>");
    expect(end, "the conn-banner element has no closing </div> after it — the check below would be reading the empty string")
      .toBeGreaterThan(-1);
    expect(banner.slice(0, end)).not.toMatch(/<button|onClick|ver-close/);
    expect(app).toMatch(/className="ver-close"/);
  });

  it("costs the bar no new tab stop, which was the price of the other direction", () => {
    // The alternative was `tabIndex={0}` plus an aria-label on the pill. The
    // audit's objection to it stands: this bar already gains a stop mid-session
    // when the meter swaps its idle <span> for a <button>, and a second one
    // that appears and disappears with the connection would move the keyboard
    // map under someone using it.
    const pill = /<span className=\{`pill \$\{pill\.tone\}`\}[^>]*>/.exec(app)![0];
    expect(pill).not.toMatch(/tabIndex|role=/);
    // And the mouse tooltip still works for the people who already use it,
    // which is one of #510's own acceptance conditions.
    expect(pill).toMatch(/title=\{pill\.title\}/);
  });

  it("leaves the paused-but-connected case where it was already reachable", () => {
    // No banner renders while the stream is alive, so the sentence has nowhere
    // to go there — and it does not need one. That state's explanation hangs
    // off the pause control, which is focusable and HAS an accessible name, so
    // its `title` is a description on a named node rather than on an anonymous
    // one; and the key itself is in the shortcuts sheet. The control is a glyph
    // in the canvas stack now rather than a word in this bar, and the property
    // that mattered here is the one it kept: named, focusable, and carrying the
    // same three sentences.
    expect(pauseTitle({ paused: true, held: 0 })).toContain("(Space)");
    expect(pauseTitle({ paused: true, held: 7 })).toContain("(Space)");
    expect(PAUSE_LABEL.trim()).not.toBe("");
    expect(app).toMatch(/<kbd>space<\/kbd><span>pause \/ resume<\/span>/);
  });

  it("draws the added sentence in a colour that is measured rather than assumed", () => {
    // --text, not --muted, and not the banner's own --err: the alarm belongs to
    // the dot and the headline, and this is running text under it — the same
    // split `.ver-banner` argues for at `.ver-sub`. Measured on the banner's
    // wash at both ends of its gradient: 11.54:1 / 13.99:1 dark and
    // 13.25:1 / 16.72:1 light.
    expect(decl(".conn-banner .conn-sub", "color")).toBe("var(--text)");
    expect(decl(".conn-banner .conn-sub", "font-weight")).toBe("400");
  });
});
