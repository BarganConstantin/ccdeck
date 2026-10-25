// A long plan step on the full-size note ran on past the note's border.
//
// The note draws each step on one line and cuts it with an ellipsis, so it
// keeps its height as the work moves down the list (RecapNoteNode, NotePlan).
// But the list is the details panel's grid, and a bare grid column is as wide
// as its widest row's min-content. With every step on one line, that is the
// whole of the longest step. Measured in headless Chromium on a 300px note: a
// 274px list with a 401px column, every row 114px past the note's border, and
// no step cut. The face drawn at a distance never had it, since its list is
// `display: contents` and each row is held to the face's width.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import RecapNoteNode, { type RecapNoteData } from "../components/RecapNoteNode";
import { cascade, el, selects } from "./sheet-cascade";

const LONG = "Verify: full suite, contract tests, mutations, independent review, CI, report";

const data: RecapNoteData = {
  sessionId: "s",
  parentId: "s",
  note: { kind: "now", text: "checking the diff before merge", at: Date.now(), source: "prompt" },
  plan: {
    at: Date.now(),
    items: [
      { text: LONG, status: "completed" },
      { text: "Merge both pull requests", status: "in_progress", active: "Merging both pull requests" },
      { text: "Post-merge suite", status: "pending" },
    ],
  },
  noteKey: "s",
  hue: 200,
};

/** The full note's step text, root first, as RecapNoteNode draws it. */
const note = el("div", ["recap-note", "is-status", "status-now", "has-plan"]);
const plan = el("div", ["recap-note-plan"]);
const list = el("ol", ["plan-list"]);
const item = el("li", ["plan-item"], { attrs: { "data-status": "completed" } });
const text = el("span", ["plan-text"]);
const at = (chain: ReturnType<typeof el>[], prop: string) => cascade(s => selects(s, chain), prop, 1440);

describe("a long plan step on the full-size note", () => {
  it("is drawn in the list the stylesheet rules are written for", () => {
    const html = renderToStaticMarkup(createElement(ReactFlowProvider, null,
      createElement(RecapNoteNode as never, { id: "n", data, selected: false, type: "recap", zIndex: 0, isConnectable: false, xPos: 0, yPos: 0, dragging: false })));
    expect(html).toMatch(/<div class="recap-note-plan"[^>]*>.*?<ol class="plan-list"><li class="plan-item" data-status="completed">.*?<span class="plan-text">Verify: full suite/);
  });

  it("is cut to one line rather than wrapped", () => {
    expect(at([note, plan, list, item, text], "white-space")).toBe("nowrap");
    expect(at([note, plan, list, item, text], "text-overflow")).toBe("ellipsis");
    expect(at([note, plan, list, item, text], "min-width")).toBe("0");
  });

  it("keeps the list's column to the note's width, so the cut can happen", () => {
    // The step's min-content is the whole step once it is on one line, and an
    // `auto` column grows to that. `minmax(0, …)` takes the floor away.
    expect(at([note, plan, list], "display")).toBe("grid");
    expect(at([note, plan, list], "grid-template-columns")).toBe("minmax(0, 1fr)");
  });
});
