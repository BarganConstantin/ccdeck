// The chosen tab and chip in the integration panels keep their words at 4.5:1 on the accent wash
// they sit on, in every theme (a 16 % wash over the panel put --text at 4.485:1 in Gruvbox
// Material). The backgrounds are read from the sheets, so a retuned mix is measured.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES, color, contrast, over, panelOf, scopeOf, web } from "./integrations-palette";

const sheet = (name: string) => readFileSync(`${web}styles/${name}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function backgroundOf(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return /background:\s*([^;]+);/.exec(body)?.[1].trim() ?? "";
}
const CHOSEN: Array<[string, string]> = [
  ["forge-panel.css", '.fg-tabs .uh-range-btn[aria-selected="true"], .fd-sections .uh-range-btn[aria-selected="true"]'],
  ["forge-detail.css", '.fd-sections .uh-range-btn[aria-selected="true"]'],
  ["jira.css", 'button.btn.jr-chip[aria-pressed="true"]'],
];

describe("chosen pills in the integration panels", () => {
  for (const theme of THEMES) {
    it(`${theme}: --text reads at 4.5:1 on every chosen pill's wash`, () => {
      const scope = scopeOf(theme);
      const panel = panelOf(scope);
      for (const [file, selector] of CHOSEN) {
        const bg = backgroundOf(sheet(file), selector);
        expect(bg, selector).toMatch(/color-mix/);
        const bed = over(color(bg, scope), panel);
        expect(contrast(over(color("var(--text)", scope), bed), bed), `${theme} ${selector}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
