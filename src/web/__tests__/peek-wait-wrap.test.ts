// The canvas card's hover card says in full what a session is waiting for.
//
// "Waiting on you" is the one state the deck exists to surface, and the hover
// card is how a board zoomed out says it at a readable size. It said it on one
// line beside how long the session had waited, cut with an ellipsis at the
// card's width: "Claude needs your permission to use Bash" lost its last word,
// and a question a session asks lost most of itself. The whole text sat in a
// `title`, which this card can never show: it refuses the pointer, and it opens
// as often for keyboard focus as for a hover.
//
// The line now wraps to two lines, and only text longer than that ends in an
// ellipsis. The duration sits at the end of the first line, the way a time
// sits beside a message, and the second line runs under it, so the sentence
// gets the card's width wherever it can. The clamp cuts at the end of the
// text, and the duration comes first, so it is never what gets cut. The
// session's title above it has the same two lines, and both hold them in an
// engine without a line clamp, as a plain max-height. The card's name stays one
// line with its tooltip.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cascade, el, selects, type El } from "./sheet-cascade";
import { agentAriaLabel, waitingLabel } from "../agent-copy";
import { placeBeside, POPOVER_MARGIN, type Edges } from "../popover-place";
import type { AgentNodeData, WaitingBlock } from "../types";

const peek = readFileSync(fileURLToPath(new URL("../components/SessionPeek.tsx", import.meta.url)), "utf8");

/** The hover card, down to its waiting line and the parts of that line. */
const CARD = [el("html", [], { states: ["root"] }), el("body"), el("div", ["ap-peek", "node-peek"])];
const WAIT = [...CARD, el("p", ["node-peek-wait", "warn"])];
const SAID = [...WAIT, el("span", ["node-peek-said"])];
const SINCE = [...SAID, el("span", ["node-peek-since"]), el("b")];
const MARK = [...WAIT, el("svg", ["alert-mark"])];
const TITLE = [...CARD, el("p", ["node-peek-title"])];
const got = (chain: El[], prop: string, width = 1440) => cascade(s => selects(s, chain), prop, width);

/** What Claude Code sends for a question, at the length real ones run to. */
const QUESTION = "web-app needs your input: the invoice preview rounds totals half-even while the API rounds half-up. "
  + "Should I change the preview to match the API, change the API to match the preview, or leave both and note it in the changelog?";

describe("the hover card's waiting line", () => {
  it("wraps to two lines, and cuts with an ellipsis only past them", () => {
    expect(got(SAID, "display")).toBe("-webkit-box");
    expect(got(SAID, "-webkit-box-orient")).toBe("vertical");
    expect(got(SAID, "-webkit-line-clamp")).toBe("2");
    expect(got(SAID, "line-clamp")).toBe("2");
    expect(got(SAID, "overflow")).toBe("hidden");
    // The one-line cut is gone, and a path with no spaces in it breaks
    // rather than running out of the card.
    expect(got(SAID, "white-space")).not.toBe("nowrap");
    expect(got(SAID, "text-overflow")).toBeNull();
    expect(got(SAID, "overflow-wrap")).toBe("anywhere");
  });

  it("holds its two lines in an engine without a line clamp", () => {
    const lh = got(WAIT, "line-height");
    expect(lh).toMatch(/^\d+(\.\d+)?$/);
    expect(got(SAID, "max-height")).toBe(`calc(2 * ${lh}em)`);
  });

  it("keeps how long the session has waited whole, at the end of the first line", () => {
    expect(got(SINCE, "float")).toBe("right");
    expect(got(SINCE, "white-space")).toBe("nowrap");
    // First in the clamped text, so it floats on the first line and the clamp,
    // which cuts at the end, never reaches it. Inside an inline wrapper, so it
    // floats in the text rather than becoming a box of its own in an engine
    // that lays the clamp out as a legacy flexible box.
    expect(peek).toContain(
      '<span className="node-peek-said" title={waitingLabel(a.waiting)}>'
      + '<span className="node-peek-since"><b>{elapsed(a.waiting.since, undefined, now)}</b></span>'
      + "{waitingLabel(a.waiting)}</span>",
    );
    // The warning mark and the sentence start level, not centred on two lines.
    expect(got(WAIT, "align-items")).toBe("flex-start");
  });

  it("centres the warning mark on that first line", () => {
    // As tall as one line of the row, so the drawing (centred in its square
    // viewBox) sits in the middle of the first line's box at any line height.
    expect(got(MARK, "height")).toBe(`${got(WAIT, "line-height")}em`);
    expect(got(MARK, "flex")).toBe("none");
  });

  it("is the whole sentence in the card's text and in its spoken name", () => {
    // Nothing is cut before the sheet: the clamp is visual only, so the whole
    // sentence is in the card's text for anything that reads it.
    expect(peek).toContain("</span>{waitingLabel(a.waiting)}</span>");
    const waiting: WaitingBlock = { since: 1, kind: "asked", message: QUESTION };
    expect(waitingLabel(waiting)).toBe(QUESTION);
    // And the waiting card's own accessible name, which the keyboard lands on
    // when this card opens for focus, says it whole.
    const card = {
      id: "s1", sessionId: "s1", label: "web-app", kind: "root", state: "active",
      startedAt: 0, tools: [], prompts: [], toolCount: 0, waiting,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    } as unknown as AgentNodeData;
    expect(agentAriaLabel(card)).toContain(QUESTION);
  });
});

describe("the session title above it", () => {
  it("has the same two lines, with the same fallback", () => {
    expect(got(TITLE, "-webkit-line-clamp")).toBe("2");
    expect(got(TITLE, "line-clamp")).toBe("2");
    const lh = got(TITLE, "line-height");
    expect(lh).toMatch(/^\d+(\.\d+)?$/);
    expect(got(TITLE, "max-height")).toBe(`calc(2 * ${lh}em)`);
    expect(got(TITLE, "overflow-wrap")).toBe("anywhere");
  });
});

describe("where the card goes once its waiting line takes two lines", () => {
  // The card as measured on a waiting card at a distance: 168px with its
  // waiting line on one line, and one line of 11px text taller with two.
  const ONE = { width: 288, height: 168 };
  const TWO = { width: 288, height: 168 + 16 };
  const WINDOWS = [[1440, 900], [1280, 800], [1100, 800], [900, 800], [640, 900], [390, 844]];
  // Tiles the size the canvas draws them at the compact and overview
  // distances, the only ones the card opens on, over the whole window.
  const tiles = (w: number, h: number): Edges[] => {
    const out: Edges[] = [];
    for (const [tw, th] of [[50, 25], [58, 36], [130, 80]]) {
      for (let x = -20; x <= w; x += 37) {
        for (let y = -10; y <= h; y += 29) out.push({ left: x, right: x + tw, top: y, bottom: y + th });
      }
    }
    return out;
  };
  const covered = (a: Edges, p: { top: number; left: number; maxHeight: number | null }, size: { width: number; height: number }) => {
    const h = p.maxHeight ?? size.height;
    const x = Math.max(0, Math.min(a.right, p.left + size.width) - Math.max(a.left, p.left));
    const y = Math.max(0, Math.min(a.bottom, p.top + h) - Math.max(a.top, p.top));
    return x * y;
  };

  for (const [w, h] of WINDOWS) {
    it(`opens where the one-line card did and covers no more of its tile, at ${w}×${h}`, () => {
      const view = { width: w, height: h };
      for (const a of tiles(w, h)) {
        const one = placeBeside(a, ONE, view);
        const two = placeBeside(a, TWO, view);
        expect(two.side).toBe(one.side);
        expect(two.left).toBe(one.left);
        expect(covered(a, two, TWO)).toBeLessThanOrEqual(covered(a, one, ONE));
        // And inside the window, top and bottom.
        expect(two.top).toBeGreaterThanOrEqual(POPOVER_MARGIN);
        expect(two.top + (two.maxHeight ?? TWO.height)).toBeLessThanOrEqual(h - POPOVER_MARGIN);
      }
    });
  }
});
