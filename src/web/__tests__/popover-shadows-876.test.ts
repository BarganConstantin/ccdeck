// #876: the sound popover and the usage-history dialog hard-coded black shadows
// (0.30 + 0.34, and 0.5) with no light answer, while the theme blocks already
// define lighter slate shadows for the white page.
//
// The dialog takes .modal's --shadow-2. The popover kept its two layers — a
// tight line for sitting ON something, a wide soft one for its height — and
// got a light answer in the same geometry, a token since #1287. It left the
// topbar with its speaker (2026-10-07); the popovers left on the deck, the
// anchored ⋯ menus, draw the same tight line over --shadow-2, and the light
// answer this issue asked for is pinned on that line now.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const css = sheetText()
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** The value of `prop` in the first rule written for exactly this selector. */
function decl(selector: string, prop: string): string | null {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  const m = rule && new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule[1]);
  return m ? m[1].trim() : null;
}

const LIGHT = ':root[data-theme="light"] ';
const history = readFileSync(fileURLToPath(new URL("../components/UsageHistoryModal.tsx", import.meta.url)), "utf8");

function lightToken(name: string): string {
  const block = /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(css);
  const m = block && new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block[1]);
  if (!m) throw new Error(`light theme declares no ${name}`);
  return m[1].trim();
}

/** Split a box-shadow into its layers, leaving commas inside rgba() alone. */
const layers = (v: string) => v.split(/,(?![^(]*\))/).map(s => s.trim());
const alphaOf = (v: string) => +/rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(v)![1];
const BLACK = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/;

describe("the usage-history dialog's shadow (#876)", () => {
  it("is .modal's --shadow-2, which each theme block tunes for its own canvas", () => {
    // By composition since #874: the dialog wears the shared shell, and its own
    // rule declares no second shadow.
    expect(history).toMatch(/className="modal uh-modal"/);
    expect(decl(".modal", "box-shadow")).toMatch(/^var\(--shadow-2\)/);
    expect(decl(".modal.uh-modal", "box-shadow")).toBeNull();
  });
});

/** A token's value in the dark block, the one :root opens with. */
function darkToken(name: string): string {
  const block = /:root,\s*\n:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css);
  const m = block && new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block[1]);
  if (!m) throw new Error(`dark theme declares no ${name}`);
  return m[1].trim();
}

describe("the popovers' contact line on the light theme (#876)", () => {
  // A light RULE until #1287 made the line a token, --shadow-contact, which
  // each theme block tunes for its own ground — so the light answer is the
  // light block's value of the token the popovers read.
  const reads = decl(".anchored-popover", "box-shadow");
  const dark = darkToken("--shadow-contact");
  const light = lightToken("--shadow-contact");

  it("has a light answer at all", () => {
    expect(reads, "the popover no longer reads the token that answers the theme").toBe("var(--shadow-contact), var(--shadow-2)");
    expect(decl(`${LIGHT}.anchored-popover`, "box-shadow"), "a light rule would be a second copy of the token").toBeNull();
    expect(light, "no light value, so black stays black on the white page").not.toBe(dark);
  });

  it("keeps its geometry", () => {
    const geometry = (v: string) => layers(v).map(l => l.replace(/rgba\([^)]*\)/, "").trim());
    expect(layers(light)).toHaveLength(1);
    expect(geometry(light)).toEqual(geometry(dark));
  });

  it("draws it in slate, no heavier than the light theme's own --shadow-2", () => {
    expect(light).not.toMatch(BLACK);
    const ceiling = alphaOf(lightToken("--shadow-2"));
    for (const layer of layers(light)) expect(alphaOf(layer), layer).toBeLessThanOrEqual(ceiling);
  });
});

describe("no floating surface keeps a black shadow on white", () => {
  it("answers the light theme for every dialog and popover this batch touched", () => {
    // `.modal` carries both dialogs this batch touched since #874 put them on it.
    // The Appearance menu's station list is a surface floating over the
    // controls under it, and kept a black 0.22 of its own until it took the
    // anchored popover's two layers and their light answer.
    // The sound popover was the first of these; the anchored popover, which
    // draws the same line, stands in its place since it left (2026-10-07).
    for (const sel of [".anchored-popover", ".modal", ".appearance-source-list"]) {
      const base = decl(sel, "box-shadow")!;
      const themed = /var\(--shadow-\d\)/.test(base) && !BLACK.test(base);
      expect(themed || decl(`${LIGHT}${sel}`, "box-shadow") !== null, `${sel}: ${base}`).toBe(true);
    }
  });
});
