// The terminal's host leaves the accessibility tree whenever it stops showing
// a live frame, and never with focus inside it: Chrome refuses aria-hidden
// over a focused descendant ("Blocked aria-hidden on an element because its
// descendant retained focus"), which the hands-on run of the stage logged when
// a switch held the last frame with the pane's textarea still focused.
import { afterEach, describe, expect, it, vi } from "vitest";
import StageBody, { type StageBodyProps } from "../components/terminal/StageBody";
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
      const blurs: (() => void)[] = [];
      const retry = {
        focus: vi.fn(), setAttribute: vi.fn(), removeAttribute: vi.fn(),
        addEventListener: vi.fn((type: string, fn: () => void) => { if (type === "blur") blurs.push(fn); }),
      };
      const card = { querySelector: vi.fn((s: string) => (s === "[data-stage-land]" ? retry : null)) };
      Object.assign(el, { parentElement: card });
      const view = mount(StageBody, props({ kind: "live", readOnly: false } as StagePhase, el));
      (globalThis as { document: { activeElement: unknown } }).document.activeElement = el.textarea;
      if (via) view.rerender(props(via, el));
      view.rerender(props({ kind: "error", message: "The deck lost its connection to tmux." }, el));
      expect(el.textarea.blur).toHaveBeenCalledTimes(1);
      expect(retry.focus, `via ${JSON.stringify(via)}`).toHaveBeenCalledTimes(1);
      // Marked as the catch while it holds the focus, so the stage's letters
      // pass it by too (terminal-keys.ts); unmarked once it lets go.
      expect(retry.setAttribute).toHaveBeenCalledWith(CAUGHT_KEYS_ATTR, "");
      expect(retry.setAttribute.mock.invocationCallOrder[0]).toBeLessThan(retry.focus.mock.invocationCallOrder[0]);
      expect(retry.removeAttribute).not.toHaveBeenCalled();
      for (const blur of blurs) blur();
      expect(retry.removeAttribute).toHaveBeenCalledWith(CAUGHT_KEYS_ATTR);
    }
  });

  it("leaves the keys alone on any other card, and when the pane never had them", () => {
    const land = () => {
      const el = host(false);
      const action = { focus: vi.fn(), setAttribute: vi.fn(), removeAttribute: vi.fn(), addEventListener: vi.fn() };
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
