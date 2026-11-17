import { describe, expect, it } from "vitest";
import { THEMES, color, contrast, over, palette } from "./integrations-palette";

// Brand accents are theme data. They must stay identifiable on the actual
// list/header/reading surfaces, including a selected row's composed fill.
describe("provider accents on Workspace surfaces", () => {
  it.each(THEMES)("keeps both transparent marks readable in %s", theme => {
    const scope = palette(theme);
    const bg = color("var(--bg)", scope);
    const panel = over(color("var(--panel)", scope), bg);
    const selected = over(color("var(--selected)", scope), panel);
    const surfaces = [bg, panel, selected, over(color("var(--ctl-fill)", scope), panel)];
    const claude = color("var(--provider-claude)", scope);
    const codex = color("var(--provider-codex)", scope);
    expect(claude).not.toEqual(codex);
    for (const mark of [claude, codex]) for (const surface of surfaces) {
      expect(contrast(over(mark, surface), surface)).toBeGreaterThanOrEqual(3);
    }
  });
});
