// Two presses whose answer took their own control away (#1762).
//
// The sound menu's "Enable" is replaced by a status word once the browser's
// prompt is answered, and Usage history's "Try again" goes with the error
// branch it sits in once a retry succeeds. Both answers arrive later, as a
// render, and in both the focused control was unmounted under the reader:
// focus fell to <body>, the dialog's trap sent the next Tab to its first stop,
// and a screen reader said nothing. The rule is panel-press.ts's (#518) — a
// control the update takes away hands focus to the nearest thing that outlived
// it — and SettingsFailureLine already keeps it for its own press.
//
// The hand-off is one hook, run here on a React of two hooks (refs, and
// effects keyed on their deps) against a document whose focused element the
// test sets. The two presses are components the suite has no DOM to mount, so
// their wiring to it is read from the markup, the way #1411 and #1540 are.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sourceOf } from "./client-source";

const hooks = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  interface Instance {
    slots: unknown[];
    effects: Array<{ deps: Deps; cleanup: void | (() => void) }>;
    queued: Array<{ index: number; run: () => void | (() => void); deps: Deps }>;
    cursor: number;
    effectCursor: number;
  }
  let current: Instance | null = null;
  const moved = (prev: Deps, next: Deps) => !prev || !next || next.some((d, k) => !Object.is(d, prev[k]));
  const react = {
    useRef<T>(init: T) {
      const inst = current!;
      const i = inst.cursor++;
      if (!(i in inst.slots)) inst.slots[i] = { current: init };
      return inst.slots[i] as { current: T };
    },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      const inst = current!;
      const index = inst.effectCursor++;
      const prev = inst.effects[index];
      if (!prev || moved(prev.deps, deps)) inst.queued.push({ index, run, deps });
    },
  };
  function mount<P extends unknown[], R>(hook: (...args: P) => R, ...args: P) {
    const inst: Instance = { slots: [], effects: [], queued: [], cursor: 0, effectCursor: 0 };
    let result!: R;
    const render = (next: P) => {
      inst.cursor = 0;
      inst.effectCursor = 0;
      inst.queued = [];
      current = inst;
      try { result = hook(...next); } finally { current = null; }
      for (const q of inst.queued) {
        const cleanup = inst.effects[q.index]?.cleanup;
        if (typeof cleanup === "function") cleanup();
      }
      for (const q of inst.queued) inst.effects[q.index] = { deps: q.deps, cleanup: q.run() };
    };
    render(args);
    return { get now() { return result; }, rerender: (...next: P) => render(next) };
  }
  return { react, mount };
});

vi.mock("react", () => hooks.react);

const { useFocusRescue } = await import("../components/use-focus-rescue");

const BODY = { tagName: "BODY" };
let page: { activeElement: { tagName: string } | null };
let target: { focus: ReturnType<typeof vi.fn> };
const ref = () => ({ current: target as unknown as HTMLElement });

beforeEach(() => {
  page = { activeElement: { tagName: "BUTTON" } };
  target = { focus: vi.fn() };
  vi.stubGlobal("document", page);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("useFocusRescue", () => {
  it("hands focus on when the pressed control goes and took focus with it", () => {
    const targetRef = ref();
    const view = hooks.mount(useFocusRescue, false, targetRef);
    view.now();
    page.activeElement = BODY;
    view.rerender(true, targetRef);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it("leaves focus alone when the reader had already moved it somewhere", () => {
    const targetRef = ref();
    const view = hooks.mount(useFocusRescue, false, targetRef);
    view.now();
    page.activeElement = { tagName: "INPUT" };
    view.rerender(true, targetRef);
    expect(target.focus).not.toHaveBeenCalled();
  });

  it("does nothing for a control that went without being pressed", () => {
    const targetRef = ref();
    const view = hooks.mount(useFocusRescue, false, targetRef);
    page.activeElement = BODY;
    view.rerender(true, targetRef);
    expect(target.focus).not.toHaveBeenCalled();
  });

  it("waits through an answer that keeps the control, and rescues on the one that takes it", () => {
    // A retry that fails again leaves Try again where it was; a dismissed
    // prompt leaves Enable. The press is still owed its hand-off.
    const targetRef = ref();
    const view = hooks.mount(useFocusRescue, false, targetRef);
    view.now();
    view.rerender(false, targetRef);
    expect(target.focus).not.toHaveBeenCalled();
    page.activeElement = BODY;
    view.rerender(true, targetRef);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it("rescues once per press", () => {
    const targetRef = ref();
    const view = hooks.mount(useFocusRescue, false, targetRef);
    view.now();
    page.activeElement = BODY;
    view.rerender(true, targetRef);
    view.rerender(false, targetRef);
    view.rerender(true, targetRef);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });
});

// The channel and its Enable moved with the notification switches from the
// sound popover to Settings › Notifications (2026-10-07), unchanged.
describe("Settings › Notifications' Enable", () => {
  const menu = sourceOf("components/NotificationsSection.tsx");

  it("arms the hand-off on its press", () => {
    expect(menu).toMatch(/<button type="button" className="btn sm-channel-action" onClick=\{\(\) => \{ rescueChannel\(\); onAskNotify\(\); \}\}>/);
  });

  it("hands focus to the Notifications switch once the answer replaces it", () => {
    // A real control with a name, the switch this channel serves — not a
    // heading made focusable, which is the invented stop canvas-keyboard
    // keeps out of the deck.
    expect(menu).toMatch(/const rescueChannel = useFocusRescue\(!channel\.ask, notifySwitchRef\);/);
    expect(menu).toMatch(/<button\s+ref=\{notifySwitchRef\}\s+type="button"\s+role="switch"\s+aria-checked=\{notifyOn\}\s+aria-labelledby="sm-notify-label"/);
  });
});

describe("Usage history's Try again", () => {
  const modal = sourceOf("components/UsageHistoryModal.tsx");

  it("arms the hand-off on its press", () => {
    expect(modal).toMatch(/<button className="btn uh-retry" onClick=\{\(\) => \{ rescueRetry\(\); reload\(\); \}\} \{\.\.\.selfPressProps\(loading\)\}>/);
  });

  it("hands focus to ↻ once a retry that worked takes the error branch away", () => {
    expect(modal).toMatch(/const rescueRetry = useFocusRescue\(view\.phase !== "error", reloadRef\);/);
    expect(modal).toMatch(/<button\s+ref=\{reloadRef\}\s+className="glyph-btn uh-reload"/);
  });
});
