// The git view owns its keys. With focus inside it, none of the deck's
// single-key shortcuts may fire — R re-arranges the canvas and drops every pin
// with no undo — and outside it `g` opens the view on the selection while Esc
// closes it before it would clear the selection behind it.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, useEffect: (fn: () => void) => { fn(); } };
});

import { mountDeckKeys, BODY } from "./deck-keys-harness";
import { sourceOf } from "./client-source";

let deck: ReturnType<typeof mountDeckKeys>;
beforeEach(() => { deck = mountDeckKeys(); });

const IN_VIEW = { tagName: "DIV", role: "option", inKeyScope: true };

describe("with focus inside the git view", () => {
  it("lets none of R C D L J K F Z Space Delete reach the deck", () => {
    deck.gitView.value = true;
    for (const key of ["r", "R", "c", "C", "d", "D", "l", "L", "j", "J", "k", "K", "f", "F", "z", "Z", " ", "Delete", "g", "Escape"]) {
      deck.press(key, { target: IN_VIEW });
    }
    const p = deck.props;
    for (const spy of [p.handleRelayout, p.requestClear, p.toggleSessionList, p.stepAgent, p.handleFit, p.focusAgent,
      p.togglePause, deck.removeSelected, p.clearSelection, p.toggleGitView, p.closeGitView, deck.detail.set]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("is held by the view's own handler too, which stops every key but Tab", () => {
    const view = sourceOf("components/GitView.tsx");
    expect(view).toMatch(/data-key-scope="git"/);
    expect(view).toMatch(/if \(intent\.kind === "pass"\) return;\s*e\.stopPropagation\(\);/);
  });
});

describe("on the deck", () => {
  it("opens the git view with g, from either case", () => {
    deck.press("g");
    expect(deck.props.toggleGitView).toHaveBeenCalledTimes(1);
    deck.press("G");
    expect(deck.props.toggleGitView).toHaveBeenCalledTimes(2);
  });

  it("leaves g alone behind a dialog", () => {
    deck.keyHelp.value = true;
    deck.press("g");
    expect(deck.props.toggleGitView).not.toHaveBeenCalled();
  });

  it("closes the open view on Esc and keeps the selection", () => {
    deck.gitView.value = true;
    deck.press("Escape", { target: BODY });
    expect(deck.props.closeGitView).toHaveBeenCalledWith("key");
    expect(deck.props.clearSelection).not.toHaveBeenCalled();
    // The next Esc is the selection's, as before.
    deck.press("Escape", { target: BODY });
    expect(deck.props.clearSelection).toHaveBeenCalledTimes(1);
  });

  it("asks for a selection and the switch before g opens anything", () => {
    const app = sourceOf("App.tsx");
    expect(app).toMatch(/gitKeyAllowed\(\{\s*selected: primarySelectedIdRef\.current != null,\s*gitOn: gitOnNow\(\),/);
  });
});
