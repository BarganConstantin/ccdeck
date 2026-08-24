// Two findings about the account row, and they are the same finding twice: the
// panel drew the thing it exists to say more quietly than the thing it repeats.
//
// #519 measured the state channel. `active` was a 6% accent wash across the row
// — 1.118:1 against the panel in dark, 1.091:1 in light, which is not a signal —
// while the `switch` it repeats on every other row was a 30px bordered box. The
// wash also lifted the bed enough to take six text tiers under AA: `--muted` on
// it reads 4.208:1, which is `.ap-num`, `.ap-email`, `.ap-lane-label`,
// `.ap-lane-reset`, `.ap-age` and the `.ap-more` glyph. And the same issue found
// `.ap-account.disabled { opacity: 0.6 }` drawing every tier on a HELD-OUT row
// at 2.495:1 — a row whose `⋯` still opens, whose numbers are what the reader is
// deciding on, and which carried the only control that could undo the state,
// except that control was not rendered at all unless auto-switch was running.
//
// #518 measured the focus. `share`, `↻` and `switch` each disabled the button
// the press had just come from, and Chrome drops focus when the focused element
// becomes disabled, so every primary action in the panel sent the keyboard to
// `<body>`. Driven over CDP with real Tab and Enter presses, before and after:
//
//   pressed            before   after
//   share              BODY     the share button, aria-busy=true
//   reload ↻           BODY     the reload button
//   switch             BODY     that row's ⋯ (the button itself is replaced)
//   remove → confirm   BODY     the panel reload (the row is gone)
//
// So: three display tiers, one for each kind of thing a row says — a filled chip
// for state, an outlined pill for a verb, dotted text for a preference — and one
// mechanism for going busy. Both are decisions about inputs, and both are held
// here as arithmetic and as markup rather than as a screenshot somebody took.
//
// No DOM: the ratios come from the sheet's own tokens with the arithmetic
// toggle-state.test.ts and manage-block.test.ts use, and the markup half reads
// AccountsPanel.tsx as text.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { focusDropped, pressAccepted, pressState, rescueSelectors } from "../panel-press";

const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");
const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const panelCode = panel
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

// ── the arithmetic ──────────────────────────────────────────────────────────

type Rgba = [number, number, number, number];

function parseColor(input: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim())!;
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}
const over = (fg: Rgba, bg: Rgba): Rgba =>
  [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;
function relativeLuminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function palette(theme: Theme): Record<string, string> {
  const head = `:root[data-theme="${theme}"]`;
  const at = bare.indexOf(head);
  const open = bare.indexOf("{", at);
  const close = bare.indexOf("}", open);
  const out: Record<string, string> = {};
  for (const m of bare.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) out[m[1]] = m[2].trim();
  return out;
}
const TOK: Record<Theme, Record<string, string>> = { dark: palette("dark"), light: palette("light") };

function resolve(value: string, theme: Theme): Rgba {
  const v = value.trim();
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/.exec(v);
  if (mix) {
    const base = resolve(mix[1], theme);
    return [base[0], base[1], base[2], base[3] * (+mix[2] / 100)];
  }
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (ref) return resolve(TOK[theme][ref[1]], theme);
  return parseColor(v);
}

/** The body of one top-level rule, by exact selector. */
function ruleOf(selector: string): string {
  const at = bare.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  const open = bare.indexOf("{", at);
  return bare.slice(open + 1, bare.indexOf("}", open));
}
const declOf = (selector: string, prop: string) => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]*)`).exec(ruleOf(selector));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

/** The bed each row is painted on. */
function beds(theme: Theme) {
  const panelBed = resolve("var(--panel)", theme);
  const tint = resolve(declOf(".ap-account.active", "background")!, theme);
  return { panel: panelBed, active: over(tint, panelBed) };
}

const BODY = 4.5;

describe("the wash stopped being asked to be a state channel (#519)", () => {
  it("keeps the color-mix shape two other suites parse with a non-null assertion", () => {
    expect(declOf(".ap-account.active", "background"))
      .toMatch(/^color-mix\(in srgb, var\(--accent\) \d+%, transparent\)$/);
  });

  it("puts every text tier on the active row back over 4.5:1, in both themes", () => {
    // The six the report named, by the token each of them paints in.
    const tiers = [".ap-num", ".ap-email", ".ap-lane-label", ".ap-lane-reset", ".ap-age", ".ap-more"];
    for (const theme of themes) {
      const bed = beds(theme).active;
      for (const sel of tiers) {
        // `.ap-age` takes its colour from `.ap-meta`, which is the row footer.
        const raw = declOf(sel, "color") ?? declOf(".ap-meta", "color")!;
        expect(contrastRatio(resolve(raw, theme), bed), `${theme} ${sel} on the active row`)
          .toBeGreaterThanOrEqual(BODY);
      }
    }
    // The number, so a later tweak that squeaks past 4.5 still has to say so:
    // 4.547:1 in dark at 2%, against the 4.208:1 the row shipped with at 6%.
    expect(contrastRatio(resolve("var(--muted)", "dark"), beds("dark").active)).toBeCloseTo(4.547, 2);
    expect(contrastRatio(resolve("var(--muted)", "light"), beds("light").active)).toBeCloseTo(7.652, 2);
  });

  it("cannot be turned back into a state channel by raising it", () => {
    // Derived rather than asserted about one value: there is no percentage at
    // which the wash reaches the 3:1 of a non-text signal AND its own body text
    // stays readable. That is why the word carries the state.
    for (const theme of themes) {
      const panelBed = resolve("var(--panel)", theme);
      const accent = resolve("var(--accent)", theme);
      const muted = resolve("var(--muted)", theme);
      for (let pct = 1; pct <= 100; pct++) {
        const row = over([accent[0], accent[1], accent[2], pct / 100], panelBed);
        const signal = contrastRatio(row, panelBed) >= 3;
        const readable = contrastRatio(muted, row) >= BODY;
        expect(signal && readable, `${theme} at ${pct}%`).toBe(false);
      }
    }
  });

  it("stopped dimming a whole row that is not inert", () => {
    // 0.6 over the row drew every tier at 2.495:1 dark, on a row carrying three
    // working controls. The rule is gone and the class with it.
    expect(bare).not.toMatch(/\.ap-account\.disabled/);
    expect(panelCode).not.toMatch(/a\.disabled \? " disabled" : ""/);
    // The arithmetic that made it a defect, kept so the number is not folklore.
    const bed = resolve("var(--panel)", "dark");
    const muted = resolve("var(--muted)", "dark");
    expect(contrastRatio(over([muted[0], muted[1], muted[2], 0.6], bed), bed)).toBeCloseTo(2.495, 2);
  });
});

describe("three tiers, one per kind of thing a row says", () => {
  it("makes state a filled chip, which is the loudest of the three", () => {
    for (const theme of themes) {
      const bed = beds(theme).panel;
      const fill = resolve(declOf(".ap-badge-active", "background")!, theme);
      const word = resolve(declOf(".ap-badge-active", "color")!, theme);
      // The chip against the panel, against the wash it replaces, and against
      // the verb pill it outranks.
      const pill = over(resolve(declOf(".ap-manage-btn", "background")!, theme), bed);
      expect(contrastRatio(fill, bed), `${theme} chip on --panel`).toBeGreaterThanOrEqual(5);
      expect(contrastRatio(fill, beds(theme).active), `${theme} chip on its own row`).toBeGreaterThanOrEqual(5);
      expect(contrastRatio(fill, pill), `${theme} chip vs the switch pill`).toBeGreaterThanOrEqual(5);
      expect(contrastRatio(word, fill), `${theme} the word on the chip`).toBeGreaterThanOrEqual(BODY);
    }
    // The shipped numbers, as numbers.
    expect(contrastRatio(resolve("var(--accent)", "dark"), beds("dark").panel)).toBeCloseTo(10.855, 2);
    expect(contrastRatio(resolve("var(--accent)", "light"), beds("light").panel)).toBeCloseTo(5.934, 2);
  });

  it("drops the verb to the panel's own small pill instead of a box of its own", () => {
    // `switch` was `btn ap-switch`, so it rendered `button.btn`: 30px tall with
    // a 24px minimum on the two markers beside it. It is `.ap-manage-btn` now —
    // the same pill `save`, `share` and `remove` use — and its own class is
    // down to the one thing it still has to say.
    expect(panelCode).toMatch(/className="ap-manage-btn ap-switch"/);
    expect(panelCode).not.toMatch(/className="btn ap-switch"/);
    expect(declOf(".ap-switch", "flex-shrink")).toBe("0");
    expect(declOf(".ap-switch", "padding")).toBeNull();
    expect(declOf(".ap-switch", "font-size")).toBeNull();
  });

  it("says held out in words, on every held-out row, with auto-switch on or off", () => {
    // The dimming was the whole signal before, and with auto-switch off the one
    // control that would undo it was not rendered at all — a 1.4.1 failure and a
    // trap in the same rule.
    expect(panelCode).toMatch(/\{a\.disabled && <span className="ap-badge-held">held out<\/span>\}/);
    expect(panelCode).toMatch(/\(\(\(auto\?\.enabled \|\| auto\?\.external\) && !a\.active\) \|\| a\.disabled\) && \(/);
    expect(panelCode).toMatch(/\{a\.disabled \? "put back" : "hold out"\}/);
    // The marker takes the slot `switch` would have had, because a switch to a
    // held-out account is refused and a control that can never act is worse
    // than no control.
    expect(panelCode).toMatch(/\{!a\.active && !a\.disabled && \(/);
    expect(panelCode).not.toMatch(/disabled=\{[^}]*a\.disabled/);
    for (const theme of themes) {
      const chip = over(resolve(declOf(".ap-badge-held", "background")!, theme), beds(theme).panel);
      expect(contrastRatio(resolve(declOf(".ap-badge-held", "color")!, theme), chip), `${theme} held out`)
        .toBeGreaterThanOrEqual(BODY);
    }
  });

  it("leaves the state markers out of the control language entirely", () => {
    // Neither chip draws a border, so neither can be mistaken for the pill
    // beside it and neither lands in control-edges.test.ts as a control with an
    // edge to justify. They are markers.
    for (const sel of [".ap-badge-active", ".ap-badge-held"]) {
      expect(ruleOf(sel), sel).not.toMatch(/(?:^|;)\s*border(?:-(?:color|width|style|top|bottom|left|right))?\s*:/);
      expect(declOf(sel, "border-radius"), sel).toBe("999px");
    }
  });
});

describe("a press never disables the control it came from (#518)", () => {
  it("holds a control inert only while somebody else is working", () => {
    expect(pressState(null, "share-2")).toEqual({ disabled: false, busy: false });
    expect(pressState("share-2", "share-2")).toEqual({ disabled: false, busy: true });
    expect(pressState("rm-3", "share-2")).toEqual({ disabled: true, busy: false });
    // The property that closes the issue, over every pair: the control whose
    // own request is out is never the one that gets `disabled`.
    const tags = ["share-2", "rm-3", "alias-1", "move-4", "threshold", "enable", "switch-2", "reload"];
    for (const inflight of [null, ...tags]) {
      for (const tag of tags) {
        const s = pressState(inflight, tag);
        expect(s.disabled && s.busy, `${inflight} / ${tag}`).toBe(false);
        if (inflight === tag) expect(s.disabled, tag).toBe(false);
      }
    }
  });

  it("keeps the guard the disabling used to be", () => {
    // Leaving the working control enabled means a second Enter reaches the
    // handler, so the handler refuses. Driven in Chrome: three clicks on
    // `switch` during one in-flight request sent exactly one POST.
    expect(pressAccepted(null)).toBe(true);
    expect(pressAccepted("share-2")).toBe(false);
    expect(panelCode).toMatch(/if \(!claim\(tag\)\) return null;/);
    expect(panelCode).toMatch(/if \(!claim\(`switch-\$\{num\}`\)\) return;/);
    expect(panelCode).toMatch(/if \(!pressAccepted\(busyRef\.current\)\) return false;/);
    // A ref, not the state, because the state a handler closes over is a render
    // old and the second press happens before the next one.
    expect(panelCode).toMatch(/const busyRef = useRef<string \| null>\(null\);/);
  });

  it("is spelled once, and every control in the panel reads it", () => {
    expect(panelCode).toMatch(/const pressProps = \(tag: string, working = false\) => \{/);
    // Nothing goes inert any other way. `.ap-fix` in the empty state is the one
    // control still on `disabled={reloading}` and is deliberately untouched:
    // #518 names it as out of scope, and it is the only control on screen in
    // that branch, so there is nothing for a busy lock to protect it from.
    const disabled = [...panelCode.matchAll(/disabled=\{([^}]*)\}/g)].map(m => m[1]);
    expect(disabled).toEqual(["reloading"]);
    expect(panelCode).toMatch(/className="ap-fix" disabled=\{reloading\}/);
    // Every request-bearing control takes the same two attributes.
    const spread = [...panelCode.matchAll(/\{\.\.\.pressProps\(([^)]*)\)\}/g)].map(m => m[1]);
    expect(spread.length).toBeGreaterThanOrEqual(9);
    expect(spread).toContain('"threshold"');
    expect(spread).toContain('"enable"');
    expect(spread).toContain('"reload", reloading');
  });

  it("hands focus on only where the press takes its own control away", () => {
    // Three of the four sites unmount rather than disable, and no busy
    // mechanism can help with that: `switch` becomes the `active` marker,
    // `remove` takes the row, and a slot move re-mounts the block a row over.
    expect(rescueSelectors(3)).toEqual(["#ap-more-3", ".accounts-panel .ap-refresh"]);
    expect(rescueSelectors(null)).toEqual([".accounts-panel .ap-refresh"]);
    // Both targets are real, named controls in the panel rather than a
    // container nobody can hear.
    expect(panelCode).toMatch(/id=\{`ap-more-\$\{a\.num\}`\}/);
    expect(panelCode).toMatch(/className="glyph-btn ap-refresh"/);
    // And only when focus was really dropped — a reader who tabbed elsewhere
    // during the request keeps where they put themselves.
    expect(focusDropped(null)).toBe(true);
    expect(focusDropped("BODY")).toBe(true);
    expect(focusDropped("HTML")).toBe(true);
    expect(focusDropped("BUTTON")).toBe(false);
    expect(focusDropped("INPUT")).toBe(false);
    expect(panelCode).toMatch(/if \(!focusDropped\(document\.activeElement\?\.tagName \?\? null\)\) return;/);
    // Exactly the three sites that unmount, and no others: a rescue on a press
    // that kept its control would take focus off it for no reason.
    expect([...panelCode.matchAll(/rescueFocus\(/g)].length).toBe(3);
    expect(panelCode).toMatch(/rescueFocus\(num\);/);
    expect(panelCode).toMatch(/rescueFocus\(next\.menuFor\);/);
    expect(panelCode).toMatch(/rescueFocus\(null\);/);
  });
});
