import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import CodexAccountsPanel from "../components/CodexAccountsPanel";
import LanSyncSection from "../components/LanSyncSection";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// #2472: Local network is about this deck and the decks paired with it, not
// about one CLI, so the Codex side of the Accounts panel ends on the same row
// as Claude's and opens the same view.
describe("Local network row, common to both sides of the Accounts panel (#2472)", () => {
  it("ends the Codex side on the Local network row", () => {
    const html = renderToStaticMarkup(createElement(CodexAccountsPanel, { onClose() {} }));
    expect(html).toContain('id="ap-lan-entry"');
  });

  it("waits for Claude's roster before drawing it, so the share list is never empty by mistake", () => {
    const html = renderToStaticMarkup(createElement(CodexAccountsPanel, { onClose() {}, lanReady: false }));
    expect(html).not.toContain('id="ap-lan-entry"');
    expect(html).toContain('id="codex-accounts-panel"');
  });

  it("draws nothing on the side that is not on screen: one row, one set of ids", () => {
    const hidden = renderToStaticMarkup(createElement(CodexAccountsPanel, { onClose() {}, side: "hidden" }));
    expect(hidden).not.toContain('id="ap-lan-entry"');
    const away = renderToStaticMarkup(createElement(LanSyncSection, {
      accounts: [], onChanged() {}, view: false, onOpen() {}, onBack() {}, closeButton: null, active: false,
    }));
    expect(away).toBe("");
  });

  it("keeps the hidden side from polling the deck a second time", () => {
    const hook = read("../use-lan-section.ts");
    expect(hook).toMatch(/if \(alive\.current && active\) timer = window\.setTimeout\(tick, every\.current\);/);
  });

  it("lists Claude's accounts and Codex's in the share dialog, from either side", () => {
    const app = read("../App.tsx");
    expect(app).toContain("onLanAccounts={setClaudeLan} codexLanAccounts={codexLan}");
    expect(app).toContain("const lanOffered = useMemo(() => [...(claudeLan ?? []), ...codexLan], [claudeLan, codexLan]);");
    expect(app).toContain("lanAccounts={lanOffered} lanReady={!providers.claude || claudeLan != null}");
    expect(app).toContain("onLanShown={lanShown} onLanAccounts={setCodexLan}");
  });
});
