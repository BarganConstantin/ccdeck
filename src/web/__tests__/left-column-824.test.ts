// #824: opening the session list silently closed the Claude accounts panel —
// both share the left column — and closing the list did not bring it back. The
// close was persisted as "0", so the panel stayed gone across reloads: the
// reader lost a panel they never closed.
//
// The first fix made the list EVICT the panel rather than close it: the
// eviction was remembered, never stored, and undone when the list closed.
//
// CHANGED ON PURPOSE (the owner, 2026-11-23): nothing evicts anything now. Each
// door opens and closes its own panel and leaves the other as it is, and with
// both open Accounts stands under the list in the same column, as This machine
// stands under Usage on the right (left-column-stack.test.ts runs it). What
// #824 asked for holds more simply than before: the list never closes the
// panel, so there is no close of the reader's to lose and no eviction to undo.
// These pin that the eviction is gone and that nothing took its place.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clientText, sourceOf } from "./client-source";

const app = clientText();
const column = sourceOf("use-left-column.ts");
const between = (src: string, from: string, to: string) => {
  const at = src.indexOf(from);
  expect(at, `${from} is in the source`).toBeGreaterThanOrEqual(0);
  return src.slice(at, src.indexOf(to, at));
};
/** The bodies of the hook's effects that run on exactly this one dep. */
const effectsOn = (dep: string) =>
  [...column.matchAll(new RegExp(`useEffect\\(\\(\\) => \\{((?:(?!useEffect\\()[\\s\\S])*?)\\}, \\[${dep}\\]\\);`, "g"))].map(m => m[1]);

describe("the session list leaves the accounts panel as it is (#824)", () => {
  it("opens and closes the list without touching the panel", () => {
    // Was: the list's toggle evicted an open panel and remembered it.
    const toggle = between(column, "const toggleSessionList", "const toggleAccountsPanel");
    expect(toggle).toMatch(/setSessionListOpen\(open => !open\)/);
    expect(toggle).not.toMatch(/setAccountsPanelOpen/);
  });

  it("closes the list, whichever way it closes, without reopening or closing the panel", () => {
    // Was: closing the list gave an evicted panel back, by an effect on the
    // list's state. With no eviction there is nothing to give back, and no
    // effect on the list's state sets the panel at all.
    expect(column).not.toMatch(/accountsEvictedRef|accountsWaiting/);
    const listEffects = effectsOn("sessionListOpen");
    expect(listEffects.length).toBeGreaterThan(0);
    for (const body of listEffects) expect(body).not.toMatch(/setAccountsPanelOpen/);
    // The list's own close and L both reach the list's state alone. The close
    // is two links — the button calls closeSessionList, which is
    // setSessionListOpen(false) — so both are pinned, and the chain is proved
    // rather than assumed. (It arms the keyboard's hand-off on the way:
    // panel-close-focus.test.ts.)
    expect(app).toMatch(/onClose=\{\(\) => \{ panelReturn\.sessionList\(\); closeSessionList\(\); \}\}/);
    expect(column).toMatch(/const closeSessionList = useCallback\(\(\) => setSessionListOpen\(false\), \[\]\);/);
  });

  it("stores the panel's own open and close, and nothing the list does", () => {
    // Was: an eviction skipped the write. Every change of the panel's flag is
    // the reader's own now (or a hold's, which is not written either way).
    const write = effectsOn("accountsPanelOpen").join("\n");
    expect(write).toMatch(/writeStored\(ACCOUNTS_PANEL_OPEN_KEY, accountsPanelOpen \? "1" : "0"\);/);
    expect(write).not.toMatch(/sessionListOpen/);
  });

  it("loads the panel as it was left, under a list open on the same load", () => {
    // Was: a list open on load kept the panel waiting behind it.
    const load = between(column, "const [accountsPanelOpen, setAccountsPanelOpen]", "useEffect(");
    expect(load).not.toMatch(/sessionListOpen/);
    expect(load).toMatch(/return wanted;/);
  });

  it("opens and closes the panel by its own door without touching the list", () => {
    // Was: the panel's toggle took the column from the list and ended an eviction.
    const toggle = between(column, "const toggleAccountsPanel", "const closeSessionList");
    expect(toggle).toMatch(/setAccountsPanelOpen\(open => !open\)/);
    expect(toggle).not.toMatch(/setSessionListOpen/);
  });
});

describe("a phone's session list is a drawer, and picking a session closes it", () => {
  it("closes the list on a pick only on a phone, through the path that keeps the panel away", () => {
    // On a phone the column lies over the canvas (left-column.css), so a pick
    // that left it open would focus a session nobody can see.
    // CHANGED ON PURPOSE (the owner's phone layout): a phone opens on Sessions and
    // a row opens that session's pane (the Command Panel on), which covers the
    // list, so the list closes there through this path; with no terminal the
    // Inspector is a sheet over the list and the list stays under it.
    expect(app).toMatch(/const pickSession = useCallback\(\(sessionId: string\) => \{\s*if \(phone && stage\.enabled\) \{[\s\S]*?closeSessionListToCanvas\(\);\s*return;\s*\}\s*(?:\/\/[^\n]*\s*)?openSession\(sessionId\);\s*\}/);
    expect(app).toMatch(/onSelect=\{pickSession\}/);
  });

  it("closes the list alone, so the accounts panel neither slides back over the session nor is shut", () => {
    // Was: it ended the eviction before closing. There is none to end: it is
    // the list's own close, and Accounts, a sheet of its own on a phone, is
    // left as it is.
    expect(column).toMatch(/const closeSessionListToCanvas = closeSessionList;/);
    // And it does not write the reader's stored choice: only the panel's own
    // state change does, and this one leaves that state alone.
    const close = between(column, "const closeSessionListToCanvas", "const closeAccountsPanel");
    expect(close).not.toMatch(/writeStored|setAccountsPanelOpen/);
  });

  it("lays the column over the canvas under 641px instead of beside it", () => {
    const sheet = readFileSync(fileURLToPath(new URL("../styles/left-column.css", import.meta.url)), "utf8");
    const phone = sheet.slice(sheet.indexOf("@media (max-width: 640px)"));
    expect(phone).toMatch(/\.app:has\(\.left-column\):not\(:has\(\.detail\)\) \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(phone).toMatch(/\.left-column \{[^}]*position: fixed;/);
  });
});
