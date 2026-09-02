// The deck's text hierarchy, and the one thing that must not quietly collapse.
//
// DARK HAD TWO LEVELS, NOT THREE. `--muted` and `--text-dim` were byte-identical
// at #7e828c, so every secondary and tertiary string rendered at one weight in
// the theme most people use, while light had three real ones. That is not a
// Browser Watch defect — it is the ramp — and it was found by measuring the
// panel rather than by reading the token names, which promise a hierarchy the
// dark sheet was not delivering.
//
// The fix could not be a dimmer tier. `--muted` sits at 4.70:1 on --panel, two
// tenths above the AA floor: #787c86 measures 4.33 and #727680 measures 3.98,
// so there is no room underneath it that is still readable. The level had to be
// added ABOVE, which also costs nothing that already works — no existing rule
// moves to make space for it, and #622's recorded argument about a 0.9 fade
// stays true because `--muted` never changed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHEET = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

type Rgb = [number, number, number];
const hex = (h: string): Rgb => {
  const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) throw new Error(`not a hex colour: ${h}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lum = (c: Rgb) => {
  const [r, g, b] = c.map(v => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(hex(a)), lum(hex(b))].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

/** The `:root` block for a theme, read out of the sheet rather than assumed. */
function tokens(theme: "dark" | "light"): Record<string, string> {
  const head = theme === "dark" ? ':root,\n:root[data-theme="dark"] {' : ':root[data-theme="light"] {';
  const i = SHEET.indexOf(head);
  if (i < 0) throw new Error(`no ${theme} block`);
  // Comments stripped first. A token reader that parses prose will eventually
  // read prose: `[^;]+` is greedy, so one `--name:` written inside a comment
  // swallows every declaration up to the next semicolon — which is how this
  // very test first reported that the token it had just added did not exist.
  const body = SHEET.slice(i, SHEET.indexOf("\n}", i)).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const [, k, v] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
  return out;
}

const DARK = tokens("dark");
const LIGHT = tokens("light");

/** Every surface small text is painted on, per theme. Both gradient stops
 *  count: a node's top and bottom differ and prose runs across both. */
const BEDS: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    "--panel": "#14161b", "--bg-soft": "#0f1116", "--bg": "#0b0c10",
    "topbar top": "#14161b", "topbar bottom": "#0f1116",
    "node top": "#14161b", "node bottom": "#0f1116",
  },
  light: {
    "--panel": "#ffffff", "--bg-soft": "#ffffff", "--bg": "#eef1f6",
    "topbar top": "#ffffff", "topbar bottom": "#eef1f6",
    "node top": "#ffffff", "node bottom": "#f2f5fa",
  },
};

describe("the text ramp has three readable levels in both themes", () => {
  it("declares the secondary tier in both, and they are not the same colour", () => {
    // Copying the dark value across is the mistake this catches, and it is not
    // an obvious one: in light `--muted` is BRIGHTER than dark's, so a secondary
    // tier mirrored over would land BELOW the token it is meant to outrank.
    expect(DARK["--text-secondary"], "dark has no --text-secondary").toBeTruthy();
    expect(LIGHT["--text-secondary"], "light has no --text-secondary").toBeTruthy();
    expect(LIGHT["--text-secondary"]).not.toBe(DARK["--text-secondary"]);
  });

  it("orders text > secondary > muted, in both themes", () => {
    // The ordering is the token's whole reason to exist. Stated as ratios
    // against --panel rather than as luminance, because contrast is what a
    // reader experiences and the two themes run in opposite directions.
    for (const [theme, tok] of [["dark", DARK], ["light", LIGHT]] as const) {
      const bed = BEDS[theme]["--panel"];
      const text = ratio(tok["--text"], bed);
      const second = ratio(tok["--text-secondary"], bed);
      const muted = ratio(tok["--muted"], bed);
      expect(second, `${theme}: secondary is not below primary`).toBeLessThan(text);
      expect(second, `${theme}: secondary is not above muted`).toBeGreaterThan(muted);
    }
  });

  it("makes the same-sized step down to muted in both themes", () => {
    // Perceptually similar, not merely passing in both. The step from secondary
    // to muted IS the distinction being drawn, so it is the one that has to
    // feel the same — dark 1.47, light 1.50 at the values chosen.
    const step = (tok: Record<string, string>, theme: "dark" | "light") =>
      ratio(tok["--text-secondary"], BEDS[theme]["--panel"]) / ratio(tok["--muted"], BEDS[theme]["--panel"]);
    expect(Math.abs(step(DARK, "dark") - step(LIGHT, "light")))
      .toBeLessThan(0.25);
  });

  it("clears AA on every surface prose actually lands on", () => {
    // Not only --panel. A secondary string can appear on the canvas, on a node,
    // and on either end of two gradients, and a tier that clears the panel and
    // fails the canvas is a tier that fails where it is read most.
    for (const [theme, tok] of [["dark", DARK], ["light", LIGHT]] as const) {
      for (const [name, bed] of Object.entries(BEDS[theme])) {
        expect(ratio(tok["--text-secondary"], bed), `${theme} --text-secondary on ${name}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("leaves no room to have solved this by dimming instead", () => {
    // The record of why the tier went above rather than below. If --muted is
    // ever raised, this fails and the decision gets re-made deliberately
    // instead of the comment quietly going stale.
    const muted = ratio(DARK["--muted"], BEDS.dark["--panel"]);
    expect(muted, "dark --muted has moved; the argument for adding above needs re-deciding")
      .toBeLessThan(5.2);
    expect(muted, "dark --muted fell under AA").toBeGreaterThanOrEqual(4.5);
  });

  it("did not disturb --muted or --text-dim to get here", () => {
    // #622's recorded argument — that no fade of the category bar would have
    // worked because 0.9 is still under AA in dark — rests on --muted's value.
    // Adding a tier above must not have re-decided that by accident.
    expect(DARK["--muted"]).toBe("#7e828c");
    expect(DARK["--text-dim"]).toBe("#7e828c");
    expect(LIGHT["--muted"]).toBe("#4a5260");
    expect(LIGHT["--text-dim"]).toBe("#5f6673");
  });
});

describe("what was migrated to the secondary tier", () => {
  /** The rules that read it, by selector, from the sheet itself. */
  const users = [...SHEET.matchAll(/(^|\n)([^\n{}]+?)\{[^}]*?color:\s*var\(--text-secondary\)/g)]
    .map(m => m[2].trim());

  it("is prose a reader reads, not metadata they glance at", () => {
    // Every one of these is a sentence somebody reads to understand something:
    // the panel's core explanation, the four access facts, why an empty list is
    // normal, what the disc's marks mean, the empty feed's one line, why six
    // browsers are unwatched, why the first read is slow, and the reader's own
    // error text.
    expect(users.sort()).toEqual([
      ".bw-access dd",
      ".bw-empty-note",
      ".bw-key dd",
      ".bw-loading p",
      ".bw-note",
      ".bw-rest",
      ".bw-row-detail",
      ".bw-settings-note",
    ]);
  });

  it("left the timestamps, counts, labels and system lines where they were", () => {
    // The failure this guards is migration by appearance rather than by role —
    // moving something because the brighter token looks nicer. A stamp, a
    // count, a section label and the deck's own log voice are all metadata,
    // and metadata is what --muted and --text-dim are for.
    for (const quiet of [".bw-log-time", ".bw-log-sys", ".bw-sec-head", ".bw-feed-count",
                         ".bw-prof-state", ".bw-relay", ".bw-count-of", ".bw-ep-meta"]) {
      expect(users, `${quiet} was migrated, and it is metadata`).not.toContain(quiet);
    }
  });

  it("gives emphasis inside a secondary paragraph the tier above it", () => {
    // A <strong> that stayed at --muted inside a paragraph that moved up would
    // be emphasis rendered quieter than the sentence around it.
    expect(SHEET).toMatch(/\.bw-settings-note strong \{ color: var\(--text\);/);
  });
});

describe("reading tokens out of the sheet", () => {
  it("is not fooled by a token name written inside a comment", () => {
    // The latent bug this hardening answers, reproduced against the same regex
    // the contrast census uses. `[^;]+` is greedy: one `--name:` in prose eats
    // every declaration after it up to the next semicolon, and the swallowed
    // tokens are then simply missing from a Record the sweeps read BY NAME — so
    // a census stops measuring a colour and reports no failures for it.
    const block = `
      --text: #d8dae0;
      /* it sits below --muted: two tenths above the floor */
      --text-secondary: #9aa0ab;
      --accent: #7dd3fc;
    `;
    const naive: Record<string, string> = {};
    for (const [, k, v] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) naive[k] = v.trim();
    expect(naive["--text-secondary"], "the naive reader should lose it — if it does not, this case has stopped testing anything").toBeUndefined();

    const stripped: Record<string, string> = {};
    for (const [, k, v] of block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      stripped[k] = v.trim();
    }
    expect(stripped["--text-secondary"]).toBe("#9aa0ab");
    expect(stripped["--accent"]).toBe("#7dd3fc");
  });
});
