// The git view owns its keys: what the view answers itself, what it stops
// before it reaches the deck, and how its dividers move from the keyboard.
import { describe, expect, it } from "vitest";
import { gitKeyAllowed, inKeyScope, paneForLostFocus, splitterMove, viewKeyIntent, type ViewKeyWhere } from "../git-view-keys";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
const at = (pane: ViewKeyWhere["pane"], over: Partial<ViewKeyWhere> = {}): ViewKeyWhere =>
  ({ pane, typing: false, handled: false, ...over });

describe("a keystroke inside the view", () => {
  it("stops every deck shortcut where it is", () => {
    // R re-arranges the canvas and drops every pin with no undo. None of these
    // may leave the view, wherever in it focus sits.
    for (const k of ["r", "R", "c", "C", "d", "D", "l", "L", "j", "J", "k", "K", "f", "F", "z", "Z", " ", "Delete"]) {
      for (const pane of ["graph", "files", "diff", null] as const) {
        expect(viewKeyIntent(key(k), at(pane)), `${JSON.stringify(k)} in ${pane}`).toEqual({ kind: "swallow" });
      }
    }
  });

  it("lets Tab through, so focus can leave", () => {
    expect(viewKeyIntent(key("Tab"), at("graph"))).toEqual({ kind: "pass" });
  });

  it("leaves the browser its chords", () => {
    expect(viewKeyIntent(key("c", { ctrlKey: true }), at("diff"))).toEqual({ kind: "pass" });
    expect(viewKeyIntent(key("r", { metaKey: true }), at("graph"))).toEqual({ kind: "pass" });
  });

  it("steps back one layer on Esc: diff, files, history, then the view closes", () => {
    expect(viewKeyIntent(key("Escape"), at("diff"))).toEqual({ kind: "focus", pane: "files" });
    expect(viewKeyIntent(key("Escape"), at("files"))).toEqual({ kind: "focus", pane: "graph" });
    expect(viewKeyIntent(key("Escape"), at("graph"))).toEqual({ kind: "close" });
    expect(viewKeyIntent(key("Escape"), at(null))).toEqual({ kind: "close" });
  });

  it("closes on g, the key that opened it", () => {
    expect(viewKeyIntent(key("g"), at("graph"))).toEqual({ kind: "close" });
    expect(viewKeyIntent(key("G"), at("diff"))).toEqual({ kind: "close" });
  });

  it("takes the newest diff on n", () => {
    expect(viewKeyIntent(key("n"), at("diff"))).toEqual({ kind: "newest" });
    expect(viewKeyIntent(key("N"), at("graph"))).toEqual({ kind: "newest" });
  });

  it("moves between panes when the pane did not take the key itself", () => {
    expect(viewKeyIntent(key("ArrowRight"), at("graph"))).toEqual({ kind: "focus", pane: "files" });
    expect(viewKeyIntent(key("Enter"), at("graph"))).toEqual({ kind: "focus", pane: "files" });
    expect(viewKeyIntent(key("Enter"), at("files"))).toEqual({ kind: "focus", pane: "diff" });
    expect(viewKeyIntent(key("ArrowLeft"), at("files"))).toEqual({ kind: "focus", pane: "graph" });
    expect(viewKeyIntent(key("ArrowLeft"), at("diff"))).toEqual({ kind: "focus", pane: "files" });
    // Answered by the pane: the view only keeps it from the deck.
    expect(viewKeyIntent(key("Enter"), at("graph", { handled: true }))).toEqual({ kind: "swallow" });
  });

  it("leaves a text field every key but Esc", () => {
    expect(viewKeyIntent(key("g"), at(null, { typing: true }))).toEqual({ kind: "swallow" });
    expect(viewKeyIntent(key("Escape"), at(null, { typing: true }))).toEqual({ kind: "close" });
  });
});

describe("focus whose holder left the page with its data", () => {
  // A file row whose file was committed or put back, a commit row amended
  // away, the Uncommitted row of a detached HEAD gone clean: the node that
  // held focus is removed, focus falls to the page, and every deck key acts
  // again — R re-arranges the board and drops every pin.
  it("goes back to the pane that held it", () => {
    expect(paneForLostFocus({ connected: false, pane: "files" }, true)).toBe("files");
    expect(paneForLostFocus({ connected: false, pane: "graph" }, true)).toBe("graph");
    expect(paneForLostFocus({ connected: false, pane: "diff" }, true)).toBe("diff");
  });

  it("goes to the history when what held it sat outside the panes", () => {
    expect(paneForLostFocus({ connected: false, pane: null }, true)).toBe("graph");
  });

  it("stays where it is when nothing was lost", () => {
    // Still on the page: a click on the canvas, another window, a pane that moved focus itself.
    expect(paneForLostFocus({ connected: true, pane: "files" }, true)).toBeNull();
    // Something else already has it.
    expect(paneForLostFocus({ connected: false, pane: "files" }, false)).toBeNull();
    expect(paneForLostFocus(null, true)).toBeNull();
  });
});

describe("the region that owns its keys", () => {
  it("is found from any element inside it", () => {
    const inside = { closest: (s: string) => (s === "[data-key-scope]" ? {} : null) };
    const outside = { closest: () => null };
    expect(inKeyScope(inside)).toBe(true);
    expect(inKeyScope(outside)).toBe(false);
    // window and the document have no closest()
    expect(inKeyScope({})).toBe(false);
    expect(inKeyScope(null)).toBe(false);
  });
});

describe("g on the deck", () => {
  it("opens only with a selection, Git on, and no dialog in front", () => {
    expect(gitKeyAllowed({ selected: true, gitOn: true, dialogOpen: false })).toBe(true);
    expect(gitKeyAllowed({ selected: false, gitOn: true, dialogOpen: false })).toBe(false);
    expect(gitKeyAllowed({ selected: true, gitOn: false, dialogOpen: false })).toBe(false);
    expect(gitKeyAllowed({ selected: true, gitOn: true, dialogOpen: true })).toBe(false);
  });
});

describe("a divider from the keyboard (WAI-ARIA window splitter)", () => {
  it("steps 16px on the arrows of its own axis and 64px on Page keys", () => {
    expect(splitterMove("ArrowLeft", "vertical")).toEqual({ step: -16 });
    expect(splitterMove("ArrowRight", "vertical")).toEqual({ step: 16 });
    expect(splitterMove("ArrowUp", "horizontal")).toEqual({ step: -16 });
    expect(splitterMove("ArrowDown", "horizontal")).toEqual({ step: 16 });
    expect(splitterMove("PageUp", "vertical")).toEqual({ step: -64 });
    expect(splitterMove("PageDown", "horizontal")).toEqual({ step: 64 });
  });

  it("ignores the other axis's arrows", () => {
    expect(splitterMove("ArrowUp", "vertical")).toBeNull();
    expect(splitterMove("ArrowLeft", "horizontal")).toBeNull();
    expect(splitterMove("x", "vertical")).toBeNull();
  });

  it("goes to the ends on Home and End, and back to the default on Enter", () => {
    expect(splitterMove("Home", "vertical")).toEqual({ to: "min" });
    expect(splitterMove("End", "horizontal")).toEqual({ to: "max" });
    expect(splitterMove("Enter", "vertical")).toEqual({ to: "reset" });
  });
});
