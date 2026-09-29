// The room a session's box takes around its cards, written once.
//
// cluster-bounds.ts, session-group-nodes.ts and layout-geometry.ts each carried
// the 18 / 26 / 12 by hand, with a comment in each saying which other file it
// had to match. They import session-chrome.ts now. What is pinned here: the
// three numbers themselves (the layout suites hard-code them as an oracle),
// that everything derived from them is derived rather than retyped, and that
// the box, the handle and the layout still agree at runtime — the drag handle
// under a card is the card's own rim, and the chrome the layout budgets is
// exactly what the card draws around its cards.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Node } from "reactflow";

import { clusterBounds, type ClusterNode } from "../cluster-bounds";
import { CARD_MARGIN, CROSS_SESSION_X, SESSION_CHROME } from "../layout-geometry";
import { HEADER_H, LABEL_LIFT, PAD } from "../session-chrome";
import { GROUP_PAD, sessionGroupNodes } from "../session-group-nodes";
import type { AgentNodeData } from "../types";
import { WEB_DIR } from "./client-source";
import { withoutComments } from "./tsx-scan";

const card = (sessionId: string, x: number, y: number, width = 240, height = 130): ClusterNode => ({
  type: "agent", position: { x, y }, width, height,
  data: { sessionId, kind: "root", label: sessionId, state: "active" } as AgentNodeData,
});

describe("the three parts", () => {
  it("are the numbers the board has always been drawn with", () => {
    expect(PAD).toBe(18);
    expect(HEADER_H).toBe(26);
    expect(LABEL_LIFT).toBe(12);
  });

  it("are what the handle pads with and what the layout budgets", () => {
    expect(GROUP_PAD).toBe(PAD);
    expect(SESSION_CHROME).toBe(PAD * 2 + HEADER_H + LABEL_LIFT);
    expect(SESSION_CHROME).toBe(74);
    expect(CROSS_SESSION_X).toBe(PAD * 2 + CARD_MARGIN);
    expect(CROSS_SESSION_X).toBe(60);
  });
});

describe("the card and the handle, drawn from them", () => {
  // Sessions of different shapes: one card, a fan, a card measured wider than
  // the default, and one far from the origin.
  const boards: ClusterNode[][] = [
    [card("s1", 0, 0)],
    [card("s1", 100, 100), card("s1", 500, 260), card("s1", 100, 420)],
    [card("s1", -300, 40, 420, 170)],
    [card("s1", 12_345, -6_789)],
  ];

  for (const [i, cards] of boards.entries()) {
    it(`line up edge for edge below the label strip (board ${i})`, () => {
      const nodes = cards.map((c, n) => ({ id: `c${n}`, ...c })) as Node[];
      const [grip] = sessionGroupNodes(nodes);
      const [box] = clusterBounds(cards);
      const minX = Math.min(...cards.map(c => c.position.x));
      const minY = Math.min(...cards.map(c => c.position.y));
      const maxX = Math.max(...cards.map(c => c.position.x + c.width!));
      const maxY = Math.max(...cards.map(c => c.position.y + c.height!));
      // The handle: the cards plus PAD, and nothing above them.
      expect(grip.position).toEqual({ x: minX - PAD, y: minY - PAD });
      expect(grip.width).toBe(maxX - minX + PAD * 2);
      expect(grip.height).toBe(maxY - minY + PAD * 2);
      // The card: the handle, plus the header strip on top.
      expect(box.x).toBe(grip.position.x);
      expect(box.w).toBe(grip.width);
      expect(box.y).toBe(minY - PAD - HEADER_H);
      expect(box.y + HEADER_H).toBe(grip.position.y);
      expect(box.h).toBe(grip.height! + HEADER_H);
      // And what the layout reserves is that box, plus the tab above it.
      expect(box.h + LABEL_LIFT - (maxY - minY)).toBe(SESSION_CHROME);
    });
  }
});

describe("the three files that used to carry their own copy", () => {
  const code = (rel: string) => withoutComments(readFileSync(`${WEB_DIR}${rel}`, "utf8"));

  it("import the parts from session-chrome.ts", () => {
    expect(code("cluster-bounds.ts")).toMatch(/^import \{ HEADER_H, LABEL_LIFT, PAD \} from "\.\/session-chrome";$/m);
    expect(code("layout-geometry.ts")).toMatch(/^import \{ HEADER_H, LABEL_LIFT, PAD \} from "\.\/session-chrome";$/m);
    expect(code("session-group-nodes.ts")).toMatch(/^import \{ PAD \} from "\.\/session-chrome";$/m);
  });

  it("and none of them declares or spells a part of its own", () => {
    for (const rel of ["cluster-bounds.ts", "layout-geometry.ts", "session-group-nodes.ts"]) {
      const text = code(rel);
      expect(text, rel).not.toMatch(/\b(?:const|let|var) (?:PAD|HEADER_H|LABEL_LIFT)\b/);
      expect(text, rel).not.toMatch(/\b(?:GROUP_PAD|PAD|HEADER_H|LABEL_LIFT) = \d/);
      expect(text, rel).not.toMatch(/\b18 \* 2\b|\+ 26 \+ 12\b/);
    }
    expect(code("session-group-nodes.ts")).toMatch(/^export const GROUP_PAD = PAD;$/m);
  });
});
