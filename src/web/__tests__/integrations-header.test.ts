// The integration modal's header (#2178): its connection selector is the
// deck's shared select, whose edge measured 2.44 to 2.79:1 on the header in
// six dark themes. The header re-points that one select's edge at the
// control edge, scoped so every other select in the deck is as it was, and
// this measures it on the select's own fill over the header in every theme.
import { describe, expect, it } from "vitest";
import { THEMES, color, contrast, host, over, panelOf, scopeOf } from "./integrations-palette";

describe("the connection selector in the modal's header", () => {
  it("takes the control edge, in the header only", () => {
    expect(host).toMatch(/\.ig-conn-select\s*\{[^}]*--sm-edge:\s*var\(--ctl-edge\)/);
    expect(host).not.toMatch(/(^|\})\s*\.sm-select\s*\{/);
  });

  for (const theme of THEMES) {
    it(`draws a boundary of 3:1 or better on its fill over the header in ${theme}`, () => {
      const scope = { ...scopeOf(theme), "sm-edge": "var(--ctl-edge)" };
      const ground = over(color("var(--sm-fill)", scope), panelOf(scope));
      const edge = contrast(over(color("var(--sm-edge)", scope), ground), ground);
      expect(Math.round(edge * 100) / 100, theme).toBeGreaterThanOrEqual(3);
    });
  }
});
