// Where the keys go when the stage answers with a card instead of a pane
// (TerminalStage.tsx landFocus, settlesFocus): onto the card's own action, so
// a card click or the Terminal button never leaves the focus on a board about
// to go inert — where the browser drops it on the body. Focus the reader has
// already put somewhere else is left there.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { landFocus, settlesFocus } from "../components/terminal/TerminalStage";
import StageBody, { type StageBodyProps } from "../components/terminal/StageBody";
import KeysBar, { type KeysBarProps } from "../components/terminal/KeysBar";
import type { StagePhase } from "../components/terminal/stage-model";

const body = { id: "body" };
const el = (name: string, inBoard = false) => ({
  name, focus: vi.fn(), closest: (sel: string) => (inBoard && sel.includes(".react-flow") ? {} : null),
});

/** A stage root holding `found` by selector, and containing `inside`. */
function stage(found: Record<string, ReturnType<typeof el> | undefined>, inside: unknown[] = []) {
  return {
    contains: (n: unknown) => inside.includes(n),
    querySelector: (sel: string) => found[sel] ?? null,
  } as unknown as HTMLElement;
}
const at = (active: unknown) => { (globalThis as Record<string, unknown>).document = { body, activeElement: active }; };
afterEach(() => { delete (globalThis as Record<string, unknown>).document; });

describe("landing the keys on the stage's answer", () => {
  it("puts them on the card's action from the body, or from the board going inert", () => {
    for (const active of [body, el("card", true), null]) {
      const action = el("Reopen here");
      at(active);
      expect(landFocus(stage({ "[data-stage-land]": action }))).toBe(true);
      expect(action.focus).toHaveBeenCalledTimes(1);
    }
  });

  it("falls back on the header's ⌨, then ✕, which every stage draws", () => {
    at(body);
    const keys = el("⌨");
    expect(landFocus(stage({ ".ts-head button[aria-pressed]": keys }))).toBe(true);
    expect(keys.focus).toHaveBeenCalled();
    const close = el("✕");
    expect(landFocus(stage({ ".ts-head button[data-stage-close]": close }))).toBe(true);
    expect(close.focus).toHaveBeenCalled();
    expect(landFocus(stage({})), "nothing drawn yet: ask again later").toBe(false);
  });

  it("leaves focus already in the stage, or taken anywhere else, where it is", () => {
    const action = el("Reopen here");
    const mine = el("✕");
    at(mine);
    expect(landFocus(stage({ "[data-stage-land]": action }, [mine]))).toBe(true);
    at(el("Settings button"));
    expect(landFocus(stage({ "[data-stage-land]": action }))).toBe(true);
    expect(action.focus).not.toHaveBeenCalled();
  });

  it("waits for a card that is the answer, not a pane on its way", () => {
    const on: StagePhase[] = [
      { kind: "empty" }, { kind: "ended" }, { kind: "detached" }, { kind: "error", message: "x" },
      { kind: "tmux-missing", reason: "missing", busy: false },
      { kind: "not-attachable", target: { kind: "C", label: "x", adoptable: true } as never, stillRunning: false, busy: false },
      { kind: "live", sizeOwner: "dock", readOnly: true },
    ];
    for (const phase of on) expect(settlesFocus(phase), phase.kind).toBe(true);
    const off: StagePhase[] = [
      { kind: "attaching", reconnect: false }, { kind: "starting", agent: "claude", cwd: "/w" }, { kind: "tmux-installing" },
      { kind: "live", sizeOwner: "dock", readOnly: false },
      // Check again: the request it makes waits for what the check finds.
      { kind: "tmux-missing", reason: "missing", busy: true },
    ];
    for (const phase of off) expect(settlesFocus(phase), phase.kind).toBe(false);
  });
});

describe("the action each card lands on", () => {
  const card = (phase: StagePhase) => renderToStaticMarkup(createElement(StageBody, { phase, onAdopt() {}, onNotNow() {}, onRetry() {}, onNewSession() {} } as unknown as StageBodyProps));
  const landed = (html: string) => [...html.matchAll(/<button[^>]*data-stage-land[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1].replace(/<[^>]+>/g, ""));

  it("is one action per card, the one the card is for", () => {
    expect(landed(card({ kind: "empty" }))).toEqual(["New session"]);
    expect(landed(card({ kind: "error", message: "It broke." }))).toEqual(["Try again"]);
    expect(landed(card({ kind: "tmux-missing", reason: "missing", busy: false }))).toEqual(["Check again"]);
    const reopen = { kind: "not-attachable", target: { kind: "C", label: "Ended.", adoptable: true }, stillRunning: false, busy: false } as unknown as StagePhase;
    expect(landed(card(reopen))).toEqual(["Reopen here"]);
    const cannot = { kind: "not-attachable", target: { kind: "C", label: "Elsewhere.", adoptable: false }, stillRunning: false, busy: false } as unknown as StagePhase;
    expect(landed(card(cannot)), "nothing to reopen: the way out").toEqual(["Not now"]);
  });

  it("is the keys bar's own action under an ended or detached frame", () => {
    const html = renderToStaticMarkup(createElement(KeysBar, { end: { sentence: "The session ended.", action: "Reopen here", onAction() {} } } as unknown as KeysBarProps));
    expect(landed(html)).toEqual(["Reopen here"]);
  });
});
