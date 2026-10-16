// The terminal's host leaves the accessibility tree whenever it stops showing
// a live frame, and never with focus inside it: Chrome refuses aria-hidden
// over a focused descendant ("Blocked aria-hidden on an element because its
// descendant retained focus"), which the hands-on run of the stage logged when
// a switch held the last frame with the pane's textarea still focused.
import { afterEach, describe, expect, it, vi } from "vitest";
import StageBody, { type StageBodyProps } from "../components/terminal/StageBody";
import type { StagePhase } from "../components/terminal/stage-model";
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

  it("keeps the focus through a reconnect, whose frozen frame stays shown", () => {
    const el = host(false);
    const view = mount(StageBody, props({ kind: "live", readOnly: false } as StagePhase, el));
    (globalThis as { document: { activeElement: unknown } }).document.activeElement = el.textarea;
    view.rerender(props({ kind: "attaching", reconnect: true }, el));
    expect(el.textarea.blur).not.toHaveBeenCalled();
    expect(el.attrs.has("aria-hidden")).toBe(false);
  });
});
