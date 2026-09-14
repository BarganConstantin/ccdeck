// #876: the sound popover and the usage-history dialog hard-coded black shadows
// (0.30 + 0.34, and 0.5) with no light answer, while the theme blocks already
// define lighter slate shadows for the white page.
//
// The dialog takes .modal's --shadow-2. The popover keeps its two layers — a
// tight line for sitting ON something, a wide soft one for its height, which
// its own comment argues for — and gets a light rule in the same geometry.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
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

describe("the sound popover's shadow on the light theme (#876)", () => {
  const dark = decl(".sound-menu", "box-shadow")!;
  const light = decl(`${LIGHT}.sound-menu`, "box-shadow");

  it("has a light rule at all", () => {
    expect(light, "no light rule, so black stays black on the white page").not.toBeNull();
  });

  it("keeps the two layers and their geometry", () => {
    const geometry = (v: string) => layers(v).map(l => l.replace(/rgba\([^)]*\)/, "").trim());
    expect(layers(light!)).toHaveLength(2);
    expect(geometry(light!)).toEqual(geometry(dark));
  });

  it("draws them in slate, no heavier than the light theme's own --shadow-2", () => {
    expect(light).not.toMatch(BLACK);
    const ceiling = alphaOf(lightToken("--shadow-2"));
    for (const layer of layers(light!)) expect(alphaOf(layer), layer).toBeLessThanOrEqual(ceiling);
  });
});

describe("no floating surface keeps a black shadow on white", () => {
  it("answers the light theme for every dialog and popover this batch touched", () => {
    // `.modal` carries both dialogs this batch touched since #874 put them on it.
    for (const sel of [".sound-menu", ".modal"]) {
      const base = decl(sel, "box-shadow")!;
      const themed = /var\(--shadow-\d\)/.test(base) && !BLACK.test(base);
      expect(themed || decl(`${LIGHT}${sel}`, "box-shadow") !== null, `${sel}: ${base}`).toBe(true);
    }
  });
});
