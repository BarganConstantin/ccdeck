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
  HELD_LABEL_CAP, heldEvents, heldShort, outageSentence, PAUSE_WIDEST_LABEL, pauseButton, statusPill,
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

// ── #504 — one box, three labels ────────────────────────────────────────────

const PAUSE = ".topbar .actions .pause-btn";

describe("the pause control stopped resizing itself (#504)", () => {
  it("caps the held count in the label and nowhere else", () => {
    // The cap is what bounds the label BY CONSTRUCTION rather than by
    // measurement: without it the string gains a character at 10, at 100, at
    // 1000, and no fixed box can be sized for a number with no ceiling.
    expect(heldShort(0)).toBe("0");
    expect(heldShort(1)).toBe("1");
    expect(heldShort(HELD_LABEL_CAP)).toBe(String(HELD_LABEL_CAP));
    expect(heldShort(HELD_LABEL_CAP + 1)).toBe(`${HELD_LABEL_CAP}+`);
    expect(heldShort(999999)).toBe(`${HELD_LABEL_CAP}+`);
    // The tooltip is not a control and does not owe the box anything, so it
    // keeps saying the exact figure — and says it with its unit, which is the
    // finding statusPill was written for in the first place.
    expect(pauseButton({ paused: true, held: 231 }).title).toContain(heldEvents(231));
    expect(pauseButton({ paused: true, held: 231 }).title).toContain("231 events");
    expect(pauseButton({ paused: true, held: 231 }).label).toBe(`Resume · ${HELD_LABEL_CAP}+ held`);
  });

  it("names its own widest label, and that label is one the button really shows", () => {
    // A ghost string that no state can produce would be a box sized for a
    // fiction. This one is exactly what the button renders at cap + 1.
    expect(PAUSE_WIDEST_LABEL).toBe(pauseButton({ paused: true, held: HELD_LABEL_CAP + 1 }).label);
    expect(PAUSE_WIDEST_LABEL).toContain(String(HELD_LABEL_CAP));
  });

  it("is the longest of every label the control can reach, and by a countable margin", () => {
    // Length stands in for width because the button renders in tabular figures
    // (asserted below), so every digit is the same box. That makes the claim
    // arithmetic rather than typographic: the only label carrying three
    // characters where a count goes is `99+`, and every other one carries at
    // most two digits.
    const variable = new Set<string>();
    for (const held of [0, 1, 2, 9, 10, 11, 42, 98, 99, 100, 101, 999, 1000, 123456]) {
      for (const paused of [true, false]) {
        const { label } = pauseButton({ paused, held });
        expect(label.length, `"${label}" is longer than the box`)
          .toBeLessThanOrEqual(PAUSE_WIDEST_LABEL.length);
        const m = /^Resume · (.+) held$/.exec(label);
        if (m) variable.add(m[1]);
      }
    }
    expect([...variable].filter(v => v.length > 2)).toEqual([`${HELD_LABEL_CAP}+`]);
  });

  it("draws the ghost and the live label in one grid cell, so the box measures the worst case", () => {
    // A `min-width` in pixels was the other option and is the one this sheet
    // would normally reach for. It cannot work here: the number would be
    // measured in whatever face rendered it and then applied to Segoe UI on
    // Windows and to whatever fontconfig picks on Linux, and a wider face
    // simply overruns it. A hidden copy of the string measures itself.
    expect(decl(PAUSE, "display")).toBe("inline-grid");
    const area = decl(PAUSE, "grid-template-areas")!;
    const cell = /"([\w-]+)"/.exec(area)![1];
    for (const child of [".topbar .actions .pause-widest", ".topbar .actions .pause-label"]) {
      expect(declIn(bodyOf(child), "grid-area"), child).toBe(cell);
      expect(declIn(bodyOf(child), "white-space"), child).toBe("nowrap");
    }
    expect(decl(".topbar .actions .pause-widest", "visibility")).toBe("hidden");
    expect(decl(PAUSE, "font-variant-numeric")).toBe("tabular-nums");
  });

  it("renders that ghost from the exported constant, not from a second copy of the string", () => {
    expect(app).toContain('<span className="pause-widest" aria-hidden>{PAUSE_WIDEST_LABEL}</span>');
    expect(app).toContain('<span className="pause-label">{btn.label}</span>');
    expect(app).toMatch(/className=\{`btn pause-btn \$\{paused \? "warn" : ""\}`\}/);
    // aria-hidden as well as visibility:hidden. Either alone would keep the
    // accessible name right; both is what makes it true of a reader that walks
    // the markup and of one that walks the render.
    expect(app).toMatch(/className="pause-widest" aria-hidden/);
  });

  it("does not animate the box, because animating a box means animating layout", () => {
    // #504 says this in as many words and it is worth pinning: a width
    // transition is a main-thread relayout that would owe reduced motion an
    // answer under this sheet's own rules, and a smoothly animated reflow is
    // still a reflow. The same reasoning is what moved `.sd-core-fill` off
    // `height` two describes down.
    const layout = ["width", "min-width", "max-width", "height", "all"];
    for (const sel of [PAUSE, ".topbar .actions .pause-widest", ".topbar .actions .pause-label", "button.btn"]) {
      const eased = transitioned(declIn(bodyOf(sel), "transition"));
      expect(eased.filter(p => layout.includes(p)), `${sel} eases a layout property`).toEqual([]);
    }
    expect(declIn(bodyOf(PAUSE), "min-width"),
      "a pixel min-width is the fix this control deliberately did not take").toBeNull();
  });

  it("adds no press obligation, because it is still the same button underneath", () => {
    // `pause-btn` is a second class on an element that already carries `btn`,
    // so the press, the transition and the reduced-motion answer are all
    // `button.btn`'s and none of them is restated. What would create a new
    // obligation is `cursor: pointer` on the new class, and canvas-motion's
    // sweep is keyed on exactly that.
    for (const sel of [PAUSE, ".topbar .actions .pause-widest", ".topbar .actions .pause-label"]) {
      expect(declIn(bodyOf(sel), "cursor"), sel).toBeNull();
    }
    expect(decl("button.btn", "cursor")).toBe("pointer");
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
    const banner = app.slice(app.indexOf('<div className="conn-banner"'));
    const end = banner.indexOf("</div>");
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
    // to go there — and it does not need one. That state's explanation hangs off
    // the Pause button, which is focusable and HAS an accessible name, so its
    // `title` is a description on a named node rather than on an anonymous one;
    // and the key itself is in the shortcuts sheet.
    expect(pauseButton({ paused: true, held: 0 }).title).toContain("(Space)");
    expect(pauseButton({ paused: true, held: 7 }).title).toContain("(Space)");
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
