// #824: opening the session list silently closed the Claude accounts panel —
// both share the left column — and closing the list did not bring it back. The
// close was persisted as "0", so the panel stayed gone across reloads: the
// reader lost a panel they never closed.
//
// The list now EVICTS the panel rather than closing it: the eviction is
// remembered, never stored as the reader's choice, and undone when the list
// closes by any of its ways out. A load with the list open keeps the panel
// waiting behind it. The reader's own toggle of the panel ends an eviction.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clientText } from "./client-source";

// The left column moved to use-left-column.ts whole — both panels, the eviction
// and the toggles — so this reads the client. Every match here is positive.
const app = clientText();
const between = (from: string, to: string) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));

describe("the session list evicts the accounts panel, and gives it back (#824)", () => {
  it("remembers an eviction when the list takes the column from an open panel", () => {
    const toggle = between("const toggleSessionList", "const toggleAccountsPanel");
    expect(toggle).toMatch(/setAccountsPanelOpen\(was => \{ if \(was\) accountsEvictedRef\.current = true; return false; \}\)/);
  });

  it("gives the panel back when the list closes, whichever way it closes", () => {
    expect(app).toMatch(/if \(!sessionListOpen && accountsEvictedRef\.current\) \{\s*accountsEvictedRef\.current = false;\s*setAccountsPanelOpen\(true\);\s*\}\s*\}, \[sessionListOpen\]\);/);
    // The list's own close and L both reach it, because it reacts to the state.
    // The close is two links now — the button calls closeSessionList, which is
    // setSessionListOpen(false) — so both are pinned, and the chain is proved
    // rather than assumed. (It arms the keyboard's hand-off on the way:
    // panel-close-focus.test.ts.)
    expect(app).toMatch(/onClose=\{\(\) => \{ panelReturn\.sessionList\(\); closeSessionList\(\); \}\}/);
    expect(app).toMatch(/const closeSessionList = useCallback\(\(\) => setSessionListOpen\(false\), \[\]\);/);
  });

  it("never stores an eviction as the reader closing the panel", () => {
    expect(app).toMatch(/if \(!accountsPanelOpen && accountsEvictedRef\.current\) return;\s*writeStored\(ACCOUNTS_PANEL_OPEN_KEY/);
  });

  it("keeps the panel waiting behind a list that is open on load", () => {
    expect(app).toMatch(/if \(wanted && sessionListOpen\) \{ accountsEvictedRef\.current = true; return false; \}/);
  });

  it("lets the reader's own toggle of the panel end the eviction", () => {
    const toggle = between("const toggleAccountsPanel", "// ccusage history modal");
    expect(toggle).toMatch(/accountsEvictedRef\.current = false;/);
  });
});
