// One top line for an item in every integration panel's detail (#2178,
// #2179). The forges had it (the reference to copy, "Open in … ↗", Close);
// Jira drew a bordered "Open in Jira" and two "Copy key" / "Copy link"
// buttons instead. And on a phone the forges' reference shortened from its
// end, so "!5144" went first. IntegrationDetailBar is the forges' bar in the
// host: this pins that the number never gives way, that the host's Back
// stands in for Close on a narrow screen, and that the link leaves in a new
// tab without handing the page over.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationDetailBar, { referenceParts } from "../components/IntegrationDetailBar";
import { sheetText } from "./sheet-source";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
};
const bar = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(IntegrationDetailBar, {
  reference: "acme/widgets#463", copyLabel: "reference", href: "https://github.example/acme/widgets/pull/463",
  openLabel: "Open in GitHub", narrow: false, onClose: () => {}, ...props,
}));

describe("an item's top line", () => {
  it("splits a reference into the path that may shorten and the number that may not", () => {
    expect(referenceParts("acme/widgets#463")).toEqual({ path: "acme/widgets", num: "#463" });
    expect(referenceParts("group/sub/project!5144")).toEqual({ path: "group/sub/project", num: "!5144" });
    expect(referenceParts("acme/widgets #12")).toEqual({ path: "acme/widgets ", num: "#12" });
    expect(referenceParts("PROJ-123")).toEqual({ path: "", num: "PROJ-123" });
    expect(referenceParts("acme/widgets")).toEqual({ path: "acme/widgets", num: "" });
  });

  it("draws the reference, Copy, the link out and Close on a wide screen", () => {
    const html = bar({});
    expect(html).toContain('<code class="ig-ref-text" title="acme/widgets#463"><span class="ig-ref-path">acme/widgets</span><span class="ig-ref-num">#463</span></code>');
    expect(html).toContain('<button type="button" class="glyph-btn ig-copy" aria-label="Copy reference" title="Copy reference">');
    expect(html).toMatch(/<a class="ig-open" href="https:\/\/github\.example\/acme\/widgets\/pull\/463" target="_blank" rel="noreferrer noopener">Open in GitHub<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('<button type="button" class="glyph-btn ig-detail-close" aria-label="Close details" title="Close">');
  });

  it("leaves Close to the host's Back on a narrow screen, and the link out when there is none", () => {
    const html = bar({ narrow: true, href: null });
    expect(html).not.toContain("ig-detail-close");
    expect(html).not.toContain("<a ");
  });

  it("gives way from the path, never from the number", () => {
    expect(rule(".ig-ref-path")).toMatch(/min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/);
    expect(rule(".ig-ref-num")).toMatch(/flex:\s*none/);
    expect(rule(".ig-ref")).toMatch(/min-width:\s*0/);
    expect(rule(".ig-detail-bar-end")).toMatch(/flex:\s*none/);
    // In a grid pane as much as in a block or a flex column.
    expect(rule(".ig-detail-bar")).toMatch(/min-width:\s*0/);
  });

  it("sticks to the top of the pane, edge to edge across the panel's padding", () => {
    const b = rule(".ig-detail-bar");
    expect(b).toMatch(/position:\s*sticky/);
    expect(b).toMatch(/margin-inline:\s*calc\(-1 \* var\(--ig-detail-pad, 20px\)\)/);
    expect(b).toMatch(/background:\s*var\(--panel\)/);
  });
});
