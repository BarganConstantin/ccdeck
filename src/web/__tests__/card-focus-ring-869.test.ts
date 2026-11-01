// #869: a canvas card reached by Tab drew no focus ring.
//
// Every card is a tab stop — React Flow gives the node wrapper `tabindex=0` and
// `role=button` — and a busy canvas holds dozens of them. The deck's global
// ring (`:focus-visible` at 0,1,0) never showed on any of them, because React
// Flow's own sheet, imported ahead of ours in main.tsx, takes it away:
//
//   .react-flow__node.selectable:focus,
//   .react-flow__node.selectable:focus-visible { outline: none; }
//
// at 0,3,0. Nothing selected a card on focus either, so the one outline a card
// does draw — the selection's, now `.react-flow__node.rf-selected .agent-node`
// (card-selection-ring.test.ts) — did not help. A keyboard reader moving
// through the cards could not see which one Enter would act on.
//
// The ring goes back on the CARD, not the wrapper: the card is the box with the
// radius and the session's own --accent, which is why selection draws there
// too. Read as text, the way canvas-pointer-focus.test.ts reads the sheet;
// comments are stripped so the prose quoting a selector cannot satisfy it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const css = sheetText()
  .replace(/\/\*[\s\S]*?\*\//g, "");
const reactFlowCss = readFileSync(
  fileURLToPath(new URL("../../../node_modules/reactflow/dist/style.css", import.meta.url)), "utf8");

const FOCUSED_CARD = ".react-flow__node:focus-visible .agent-node";
const SELECTED_CARD = ".react-flow__node.rf-selected .agent-node";

function decl(selector: string, prop: string): string | null {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const body = re.exec(css)?.[1];
  if (body == null) return null;
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "m").exec(body);
  return m ? m[1].trim() : null;
}

describe("a canvas card reached by keyboard shows a ring (#869)", () => {
  it("is needed because React Flow still removes the wrapper's ring", () => {
    // If a React Flow upgrade stops doing this, the global ring reaches the
    // wrapper again and the card would draw two — revisit the rule below then.
    expect(reactFlowCss).toMatch(/\.react-flow__node\.selectable:focus-visible\s*\{\s*outline:\s*none/);
  });

  it("draws the deck's ring on the card while its wrapper has keyboard focus", () => {
    // V4's Figma: 1.5px accent inside, offset 0 (--focus-w, negative offset).
    expect(decl(FOCUSED_CARD, "outline")).toBe("var(--focus-w) solid var(--accent)");
    expect(decl(FOCUSED_CARD, "outline-offset")).toBe("calc(-1 * var(--focus-w))");
  });

  it("is the accent ring selection draws (colour and style), so the canvas keeps one focus language", () => {
    // Focus without selection still reads apart: selection also lifts the
    // card with --shadow-2, focus does not. V4's Figma moved only the focus
    // ring to the one inside stroke; selection is not a focus state and keeps
    // its own width and offset, so only the colour and style are compared.
    expect(decl(SELECTED_CARD, "outline")).toMatch(/ solid var\(--accent\)$/);
    expect(decl(FOCUSED_CARD, "outline")).toMatch(/ solid var\(--accent\)$/);
    expect(decl(FOCUSED_CARD, "box-shadow")).toBeNull();
  });
});
