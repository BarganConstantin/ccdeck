// One person for every integration panel (#2178, #2179). Jira drew two
// initials in --text; the forges drew one initial in a fixed 10px of --muted,
// 3.42:1 in Dark. Jira's stack overlapped initials 6px into an unreadable
// string, and its empty face for nobody was a --line ring at 1.14 to 2.25:1.
// This pins the shared face: initials when the picture is missing or failed,
// the reader's own face ringed, the stack rule (three, then +N; pictures
// overlap and are cut away, initials never do), and the two marks that are
// all a face has, the empty ring and your ring, measured at 3:1 or better on
// every ground a row has in every theme.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationAvatar, { IntegrationAvatarStack, IntegrationPerson, UnassignedAvatar, stackLabel } from "../components/IntegrationAvatar";
import { THEMES, color, contrast, css, host, over, panelOf, scopeOf } from "./integrations-palette";

const html = (el: Parameters<typeof createElement>[0], props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(el as never, props as never));
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(host)?.[1] ?? "";
};

describe("a face", () => {
  it("is the picture, hidden from a screen reader, with its size for the stack's cut", () => {
    const out = html(IntegrationAvatar, { src: "/api/integrations/asset?u=1", name: "Ana Lee", size: 20 });
    expect(out).toMatch(/^<img class="ig-avatar" style="width:20px;height:20px;--ig-avatar-size:20px" src="\/api\/integrations\/asset\?u=1" alt="" aria-hidden="true"/);
  });

  it("is two initials when there is no picture, at a size that grows with the text", () => {
    expect(html(IntegrationAvatar, { src: null, name: "Ana Lee" })).toMatch(/class="ig-avatar ig-avatar-initials"[^>]*aria-hidden="true">AL<\/span>/);
    expect(html(IntegrationAvatar, { src: null, name: "Ana Lee", size: 32 })).toMatch(/data-large="true"/);
    expect(rule(".ig-avatar-initials")).toMatch(/color:\s*var\(--text\)/);
    expect(rule(".ig-avatar-initials")).toMatch(/font-size:\s*calc\(9px \+ var\(--ui-text-increase, 0px\)\)/);
  });

  it("rings yours in the accent, initials included, and in the highlight under a Contrast theme", () => {
    expect(html(IntegrationAvatar, { src: null, name: "Me", you: true })).toMatch(/data-you="true"/);
    expect(html(IntegrationAvatar, { src: "/a", name: "Me", you: true })).toMatch(/data-you="true"/);
    expect(rule(".ig-avatar[data-you]")).toMatch(/outline:\s*1\.5px solid var\(--accent\)/);
    const forced = css.slice(css.indexOf("@media (forced-colors: active) {"));
    expect(forced).toMatch(/\.ig-avatar\[data-you\]\s*\{\s*outline-color:\s*Highlight/);
    // Every face keeps a circle there: the outline a Contrast theme paints.
    expect(rule(".ig-avatar")).toMatch(/outline:\s*1px solid transparent/);
  });

  it("puts a name beside the face, or keeps it for a screen reader and a tooltip", () => {
    expect(html(IntegrationPerson, { src: null, name: "Ana Lee" })).toContain('<span class="ig-person-name">Ana Lee</span>');
    const nameless = html(IntegrationPerson, { src: null, name: "Ana Lee", nameless: true });
    expect(nameless).toMatch(/^<span class="ig-person" title="Ana Lee">/);
    expect(nameless).toContain('<span class="vis-hidden">Ana Lee</span>');
  });
});

describe("a stack of faces", () => {
  const people = ["Ana Lee", "Ben Ode", "Cy Park", "Dee Ray", "Eli Su"].map((name, i) => ({ key: String(i), name, src: null }));

  it("shows three, then +N, and is one image named with every name", () => {
    const out = html(IntegrationAvatarStack, { people, label: "Assigned to" });
    expect(out).toMatch(/^<span class="ig-stack" role="img" aria-label="Assigned to Ana Lee, Ben Ode, Cy Park, Dee Ray and Eli Su" title="Ana Lee, Ben Ode, Cy Park, Dee Ray, Eli Su">/);
    expect(out.match(/ig-avatar-initials/g)).toHaveLength(3);
    expect(out).toContain('<span class="ig-stack-more" aria-hidden="true">+2</span>');
    expect(html(IntegrationAvatarStack, { people: people.slice(0, 3) })).not.toContain("ig-stack-more");
    expect(html(IntegrationAvatarStack, { people: [] })).toBe("");
    expect(stackLabel(["A", "B"])).toBe("A and B");
  });

  it("overlaps a picture only on a picture, cut away round it, and never initials", () => {
    expect(rule(".ig-stack")).toMatch(/gap:\s*2px/);
    const cut = rule("img.ig-avatar + img.ig-avatar");
    expect(cut).toMatch(/margin-left:\s*-6px/);
    expect(cut).toMatch(/(^|[;\s])mask-image:\s*radial-gradient\(circle at calc\(4px - var\(--ig-avatar-size\) \/ 2\) 50%, transparent calc\(var\(--ig-avatar-size\) \/ 2 \+ 2px\)/);
    // Nothing else in the stack moves into its neighbour.
    expect(host).not.toMatch(/\.ig-avatar-initials\s*\+[^{]*\{[^}]*margin-left:\s*-/);
  });
});

describe("the marks that are all a face has", () => {
  for (const theme of THEMES) {
    it(`edges the empty face and rings yours at 3:1 or better on every ground a row has, in ${theme}`, () => {
      const scope = scopeOf(theme);
      const panel = panelOf(scope);
      const grounds = {
        bg: color("var(--bg)", scope),
        panel,
        hovered: over(color("var(--ig-hover-fill)", scope), panel),
        chosen: over(color("var(--ig-sel-fill)", scope), panel),
      };
      for (const [where, ground] of Object.entries(grounds)) {
        // A chosen row re-points the edge at its own ink.
        const ink = where === "chosen" ? "var(--ig-sel-muted)" : "var(--ctl-edge)";
        const edge = contrast(over(color(ink, scope), ground), ground);
        const ring = contrast(over(color("var(--accent)", scope), ground), ground);
        expect(Math.round(edge * 100) / 100, `${theme}: empty face's edge on ${where}`).toBeGreaterThanOrEqual(3);
        expect(Math.round(ring * 100) / 100, `${theme}: your ring on ${where}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("draws the empty face's edge in the control edge", () => {
    expect(html(UnassignedAvatar, { size: 18 })).toBe('<span class="ig-avatar ig-avatar-none" style="width:18px;height:18px;--ig-avatar-size:18px" aria-hidden="true"></span>');
    expect(rule(".ig-avatar-none")).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--ctl-edge\)/);
    // On a chosen row the edge is the row's own ink, --text, written out so
    // the ring sweep (control-edges) can measure it in every theme.
    expect(rule(".ig-row[data-selected] .ig-avatar-none")).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--text\)/);
  });
});
