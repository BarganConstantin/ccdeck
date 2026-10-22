// The GitHub and GitLab panel's shell (#2179), drawn once on the server: the
// toolbar, the tab strip and the search over the list. A unit suite has no
// browser, so how it behaves under the keys is tested through the rules it is
// built from; this is what it draws.
import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ForgePanel, { type ForgeSplitProps } from "../components/forge/ForgePanel";
import { selectionKey } from "../components/forge/ForgeContext";
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

describe("the search over the list", () => {
  it("is the integrations' shared field, which Escape empties before it closes anything", () => {
    const html = draw("github");
    expect(html).toMatch(/<div class="ig-search"><svg[^>]*>.*?<\/svg><input type="search" class="ig-search-input" aria-label="Search by title or number, or paste a GitHub link"/);
    expect(html).not.toContain("fg-search\"");
  });
});

describe("an open item and Escape", () => {
  it("leaves Escape to the host's split, which closes the item before the modal at every width", () => {
    // IntegrationSplit puts an open detail on the dismiss stack and calls the
    // panel's onBack; a second entry of the panel's own would take two
    // presses' worth of closing from one.
    const panel = readFileSync(new URL("../components/forge/ForgePanel.tsx", import.meta.url), "utf8");
    expect(panel).not.toMatch(/modalStack/);
    expect(panel).toMatch(/onBack=\{\(\) => select\(null\)\}/);
  });

  it("names each item once for the host, so a new one arriving is marked as new", () => {
    const keys = [
      selectionKey({ type: "change", repo: "acme/web", number: 12 }),
      selectionKey({ type: "issue", repo: "acme/web", number: 12 }),
      selectionKey({ type: "change", repo: "acme/api", number: 12 }),
      selectionKey({ type: "branch", repo: "acme/web", name: "12" }),
      selectionKey({ type: "pipeline", repo: "acme/web", id: "12" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(selectionKey({ type: "change", repo: "acme/web", number: 12 })).toBe(keys[0]);
  });
});

describe("the list and the keyboard", () => {
  it("is one Tab stop walked with the arrows: every kind of row is marked for it, and the panel walks them", () => {
    const src = (name: string) => readFileSync(new URL(`../components/forge/${name}`, import.meta.url), "utf8");
    for (const tab of ["ChangesTab.tsx", "PipelinesTab.tsx", "IssuesTab.tsx"]) {
      expect(src(tab)).toMatch(/className="fg-row fgl-row[^"]*"\n\s+data-nav=""/);
    }
    expect(src("BranchesTab.tsx")).toMatch(/className="fgl-hit"\n\s+data-nav=""/);
    expect(src("ForgeParts.tsx")).toMatch(/className="fg-fold" data-nav=""/);
    expect(src("ForgePanel.tsx")).toMatch(/useRovingRows\(listRef\);[\s\S]*<div ref=\{listRef\} className="fg-list">/);
    // No row is given a tab stop of its own in the markup: the walk moves it.
    for (const name of ["ChangesTab.tsx", "PipelinesTab.tsx", "IssuesTab.tsx", "BranchesTab.tsx", "ForgeParts.tsx"]) {
      expect(src(name)).not.toMatch(/tabIndex=/);
    }
  });
});
