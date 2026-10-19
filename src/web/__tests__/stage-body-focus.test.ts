// The terminal's host leaves the accessibility tree whenever it stops showing
// a live frame, and never with focus inside it: Chrome refuses aria-hidden
// over a focused descendant ("Blocked aria-hidden on an element because its
// descendant retained focus"), which the hands-on run of the stage logged when
// a switch held the last frame with the pane's textarea still focused.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StageBody, { CAUGHT_QUIET_MS, catchKeys, type StageBodyProps } from "../components/terminal/StageBody";
import type { StagePhase } from "../components/terminal/stage-model";
import { CAUGHT_KEYS_ATTR } from "../shortcuts";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

function host(focusedInside: boolean) {
  const attrs = new Map<string, string>();
  const textarea = { blur: vi.fn(() => { (globalThis as { document: { activeElement: unknown } }).document.activeElement = null; }) };
  const el = {
    attrs,
    textarea,
    contains: (n: unknown) => n === textarea,
    setAttribute: vi.fn((k: string, v: string) => { attrs.set(k, v); }),
    removeAttribute: vi.fn((k: string) => { attrs.delete(k); }),
  };
  (globalThis as Record<string, unknown>).document = { activeElement: focusedInside ? textarea : null };
  return el;
}

/** A button that takes the focus when asked (unless `refuses`), with its
 *  attributes and listeners, and a way to fire a key or a blur at it. */
function button({ refuses = false } = {}) {
  const attrs = new Map<string, string>();
  const on = new Map<string, Set<(e: unknown) => void>>();
  const b = {
    attrs,
    focus: vi.fn(() => { if (!refuses) (globalThis as { document: { activeElement: unknown } }).document.activeElement = b; }),
    setAttribute: (k: string, v: string) => { attrs.set(k, v); },
    removeAttribute: (k: string) => { attrs.delete(k); },
    addEventListener: (t: string, fn: (e: unknown) => void) => { if (!on.has(t)) on.set(t, new Set()); on.get(t)!.add(fn); },
    removeEventListener: (t: string, fn: (e: unknown) => void) => { on.get(t)?.delete(fn); },
    listeners: (t: string) => on.get(t)?.size ?? 0,
    fire(type: string, key?: string) {
      const e = { type, key, prevented: false, preventDefault() { e.prevented = true; } };
      for (const fn of [...(on.get(type) ?? [])]) fn(e);
      return e.prevented;
    },
  };
  return b;
}

const props = (phase: StagePhase, el: ReturnType<typeof host>): StageBodyProps => ({
  hostRef: { current: el as unknown as HTMLDivElement }, phase,
  onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(),
});

afterEach(() => { delete (globalThis as Record<string, unknown>).document; });

describe("the terminal host and assistive technology", () => {
  it("is in the tree while it shows a live session, and out of it behind a card", () => {
    const el = host(false);
    const view = mount(StageBody, props({ kind: "attaching", reconnect: false }, el));
    expect(el.attrs.get("aria-hidden")).toBe("true");
    view.rerender(props({ kind: "live", readOnly: false } as StagePhase, el));
    expect(el.attrs.has("aria-hidden")).toBe(false);
  });

  it("lets go of the focus before a held frame is hidden, so the attribute is never refused", () => {
    const el = host(false);
    const view = mount(StageBody, props({ kind: "live", readOnly: false } as StagePhase, el));
    (globalThis as { document: { activeElement: unknown } }).document.activeElement = el.textarea;
    view.rerender(props({ kind: "attaching", reconnect: false }, el));
    expect(el.textarea.blur).toHaveBeenCalledTimes(1);
    expect(el.attrs.get("aria-hidden")).toBe("true");
    const blurAt = el.textarea.blur.mock.invocationCallOrder[0];
    const hideAt = el.setAttribute.mock.invocationCallOrder.at(-1)!;
    expect(blurAt, "blurred first, then hidden").toBeLessThan(hideAt);
  });

  it("hands a pane's keys to Try again when its connection to tmux is lost, never to the body", () => {
    // On the body, the letters still being typed for the session ran the
    // deck's shortcuts: a "?" opened the key sheet. Straight from live, and
    // after a reconnect that gave up.
    for (const via of [null, { kind: "attaching", reconnect: true }] as const) {
      const el = host(false);
      const retry = button();
      Object.assign(el, { parentElement: { querySelector: vi.fn((s: string) => (s === "[data-stage-land]" ? retry : null)) } });
      const view = mount(StageBody, props({ kind: "live", readOnly: false } as StagePhase, el));
      (globalThis as { document: { activeElement: unknown } }).document.activeElement = el.textarea;
      if (via) view.rerender(props(via, el));
      view.rerender(props({ kind: "error", message: "The deck lost its connection to tmux." }, el));
      expect(el.textarea.blur).toHaveBeenCalledTimes(1);
      expect(retry.focus, `via ${JSON.stringify(via)}`).toHaveBeenCalledTimes(1);
      expect(retry.attrs.has(CAUGHT_KEYS_ATTR), "caught (catchKeys, below)").toBe(true);
      retry.fire("blur");
    }
  });

  it("leaves the keys alone on any other card, and when the pane never had them", () => {
    const land = () => {
      const el = host(false);
      const action = button();
      Object.assign(el, { parentElement: { querySelector: () => action } });
      return { el, action };
    };
    // Reopen here is one keystroke from a second agent on the same conversation.
    const reopen = land();
    const a = mount(StageBody, props({ kind: "live", readOnly: false } as StagePhase, reopen.el));
    (globalThis as { document: { activeElement: unknown } }).document.activeElement = reopen.el.textarea;
    a.rerender(props({ kind: "not-attachable", target: { kind: "outside", adoptable: true, sentence: "" }, stillRunning: true, busy: false } as unknown as StagePhase, reopen.el));
    a.rerender(props({ kind: "error", message: "later" }, reopen.el));
    expect(reopen.action.focus, "a later error is not the lost connection").not.toHaveBeenCalled();

    const idle = land();
    const b = mount(StageBody, props({ kind: "live", readOnly: false } as StagePhase, idle.el));
    b.rerender(props({ kind: "error", message: "The deck lost its connection to tmux." }, idle.el));
    expect(idle.action.focus, "the keys were on the board all along").not.toHaveBeenCalled();
  });

  it("keeps the focus through a reconnect, whose frozen frame stays shown", () => {
    const el = host(false);
    const view = mount(StageBody, props({ kind: "live", readOnly: false } as StagePhase, el));
    (globalThis as { document: { activeElement: unknown } }).document.activeElement = el.textarea;
    view.rerender(props({ kind: "attaching", reconnect: true }, el));
    expect(el.textarea.blur).not.toHaveBeenCalled();
    expect(el.attrs.has("aria-hidden")).toBe(false);
  });
});

describe("the control that caught a pane's keys", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as Record<string, unknown>).document = { activeElement: null };
  });
  afterEach(() => { vi.useRealTimers(); });

  it("is not pressed by the Space or Enter of the sentence still being typed", () => {
    // A Try again pressed mid-sentence unmounted itself and put the rest of
    // the sentence on the body, where the deck's shortcuts run.
    const b = button();
    expect(catchKeys(b as unknown as HTMLElement)).toBe(true);
    expect(b.attrs.has(CAUGHT_KEYS_ATTR)).toBe(true);
    expect(b.fire("keydown", " "), "Space, on its way down").toBe(true);
    expect(b.fire("keyup", " "), "and up, where a button takes it").toBe(true);
    expect(b.fire("keydown", "Enter")).toBe(true);
    expect(b.fire("keydown", "n"), "a letter is nobody's to cancel: the stage passes it by").toBe(false);
  });

  it("answers as itself once the burst has been quiet for a moment, or once it loses the focus", () => {
    const b = button();
    catchKeys(b as unknown as HTMLElement);
    vi.advanceTimersByTime(CAUGHT_QUIET_MS - 100);
    b.fire("keydown", "e");
    vi.advanceTimersByTime(CAUGHT_QUIET_MS - 100);
    expect(b.attrs.has(CAUGHT_KEYS_ATTR), "every key of the burst keeps it caught").toBe(true);
    vi.advanceTimersByTime(100);
    expect(b.attrs.has(CAUGHT_KEYS_ATTR)).toBe(false);
    expect(b.fire("keydown", "Enter"), "a deliberate Enter presses it").toBe(false);
    expect(b.listeners("keydown") + b.listeners("keyup") + b.listeners("blur"), "nothing left listening").toBe(0);

    const c = button();
    catchKeys(c as unknown as HTMLElement);
    c.fire("blur");
    expect(c.attrs.has(CAUGHT_KEYS_ATTR)).toBe(false);
    expect(c.fire("keyup", " ")).toBe(false);
  });

  it("marks nothing when the focus does not take", () => {
    // An inert dock mid-morph: a mark left on a control without the focus
    // would block the stage's letters the next time a reader tabbed to it.
    const b = button({ refuses: true });
    expect(catchKeys(b as unknown as HTMLElement)).toBe(false);
    expect(b.attrs.has(CAUGHT_KEYS_ATTR)).toBe(false);
    expect(b.listeners("keydown")).toBe(0);
  });
});
