// The GitHub and GitLab panel's shell (#2179), drawn once on the server: the
// toolbar, the tab strip and the search over the list. A unit suite has no
// browser, so how it behaves under the keys is tested through the rules it is
// built from; this is what it draws.
import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ForgePanel, { type ForgeSplitProps } from "../components/forge/ForgePanel";
import type { ForgePrefs } from "../forge-panel";
import type { ForgeKind } from "../forge-types";

const prefs = (view: Record<string, unknown> = {}): ForgePrefs => ({
  read: <T,>(key: string, check: (v: unknown) => v is T) => {
    const v = key === "view" ? { repo: "acme/web", tab: "changes", ...view } : undefined;
    return check(v) ? v : undefined;
  },
  write: () => {},
});

function Split({ list, detail }: ForgeSplitProps): ReactNode {
  return createElement("div", { className: "split" }, list, detail);
}

const draw = (kind: ForgeKind, view: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ForgePanel, {
  kind,
  connection: { id: "shell", name: "Shell", baseUrl: kind === "github" ? "https://github.com" : "https://gitlab.example.com" },
  api: async () => new Response("{}"),
  assetUrl: (u: string) => u,
  prefs: prefs(view),
  narrow: false,
  onReconnect: () => {},
  Split,
}));

describe("the panel's toolbar", () => {
  it("ends on the integrations' shared freshness line and its Refresh", () => {
    const html = draw("gitlab");
    expect(html).toMatch(/<div class="ig-freshness" data-tone="none">/);
    expect(html).toMatch(/<button type="button" class="glyph-btn ig-refresh" aria-label="Refresh GitLab" title="Refresh"/);
    expect(html).not.toContain("fg-fresh");
    expect(html).not.toContain("fg-refresh");
  });
});
