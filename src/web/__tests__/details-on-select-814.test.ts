// #814: clicking an agent opened nothing, and once the detail panel was closed
// the mouse could not bring it back.
//
// A click only selected the card: the topbar grew a ribbon and the panel — the
// prompt, every tool call, tokens, timing — opened only with D. `detailOpen`
// is persisted, so a panel closed with its × stayed closed across reloads for
// anybody who never found the key, and the welcome tour told a newcomer to
// "Click any node" for exactly what a click did not do (#817).
//
// The owner chose the fix on 2026-09-14: selecting an agent is inspecting it.
// Every plain selection goes through selectAgent, so that is where the panel
// opens; the × and D stay as they were. Read as text, the way
// viewport-motion-671.test.ts reads App.tsx.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WELCOME_STEPS } from "../components/guide-art";

// selectAgent moved to use-selection.ts; everything that calls it stayed in
// App.tsx. The two are read as one, so a body is found wherever it lives.
// The keydown handler moved to use-deck-shortcuts.ts, stepAgent and
// focusSession to use-agent-focus.ts, the canvas's click handlers to
// use-canvas-clicks.ts, the <ReactFlow> element they are handed to to
// components/BoardFlow.tsx, and the panel's frame to components/DetailAside.tsx;
// the keys and the rest of the deck are read as one.
const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../use-selection.ts", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../use-deck-shortcuts.ts", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../use-agent-focus.ts", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../use-canvas-clicks.ts", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../components/BoardFlow.tsx", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../components/DetailAside.tsx", import.meta.url)), "utf8");
const appCode = app
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

/** One function body, from its opening to the brace that closes it. */
function body(opening: string): string {
  const at = appCode.indexOf(opening);
  if (at < 0) throw new Error(`details-on-select-814: no "${opening}" in App.tsx`);
  const from = appCode.indexOf("{", appCode.indexOf("=>", at));
  let depth = 0;
  for (let i = from; i < appCode.length; i++) {
    if (appCode[i] === "{") depth++;
    else if (appCode[i] === "}" && --depth === 0) return appCode.slice(at, i + 1);
  }
  throw new Error(`details-on-select-814: unbalanced body after "${opening}"`);
}

const selectAgent = body("const selectAgent = useCallback");

describe("selecting an agent opens its details (#814)", () => {
  it("opens the detail panel on a plain selection, and not on Shift+click", () => {
    expect(selectAgent).toMatch(/if \(!additive && inspect\) setDetailOpen\(true\);/);
    expect(selectAgent).toMatch(/inspect: boolean = !additive/);
  });

  it("is reached by every way a single agent gets selected", () => {
    // A click on a card, j/k, and a session picked from the list or the
    // waiting button. Enter on a focused card goes through onNodeClick's twin
    // in canvas-keys, which also lands in selectAgent.
    // A click on a card is the one that does not (2026-09-19): it goes to the
    // session and leaves the panel to the double-click, which selects through
    // the same door with the panel's default. App.tsx hands the handlers to
    // BoardFlow whole, and BoardFlow hands each to <ReactFlow>.
    expect(appCode).toMatch(/<BoardFlow\b[^>]*\bclicks=\{clicks\}/);
    expect(appCode).toMatch(/onNodeClick=\{onNodeClick\}/);
    expect(appCode).toMatch(/const onNodeClick = \(e: React\.MouseEvent, n: Node\) => \{[\s\S]*?selectAgent\(id, e\.shiftKey, false\);\s*if \(e\.shiftKey\) return;/);
    // And shuts a panel left open, which is stored across reloads — on the
    // stored flag, not on what is showing, which after a reload is nothing.
    expect(appCode).toMatch(/if \(detailOpen\) setDetailOpen\(false\);/);
    expect(appCode).toMatch(/onNodeDoubleClick=\{onNodeDoubleClick\}/);
    expect(appCode).toMatch(/const onNodeDoubleClick = \(_: React\.MouseEvent, n: Node\) => \{[\s\S]*?selectAgent\(id, false\);/);
    expect(body("const stepAgent = useCallback")).toMatch(/selectAgent\(target\.id, false\)/);
    expect(body("const focusSession = useCallback")).toMatch(/selectAgent\(sessionId, false\)/);
  });

  it("keeps the panel's × and D", () => {
    expect(appCode).toMatch(/<DetailAside\b[^>]*\bsetDetailOpen=\{setDetailOpen\}/);
    expect(appCode).toMatch(/onClick=\{\(\) => setDetailOpen\(false\)\}/);
    // D toggles whenever something is selected; with nothing selected it now
    // selects first (#845, d-without-selection-845.test.ts).
    expect(appCode).toMatch(/if \(e\.key === "d" \|\| e\.key === "D"\) \{\s*if \(primarySelectedIdRef\.current\) setDetailOpen\(o => !o\);/);
  });

  it("makes the tour's inspect step true (#817)", () => {
    expect(WELCOME_STEPS.some(s => /^Double-click any node: its prompt, every tool call/.test(s.line))).toBe(true);
  });
});
