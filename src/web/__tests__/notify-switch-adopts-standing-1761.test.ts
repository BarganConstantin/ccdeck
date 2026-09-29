// Turning the deck's notifications on adopts what is standing (#1761).
//
// With the browser's permission granted and the deck's own switch off, a block
// that arrived while the tab was hidden was never written down as seen: the
// muted switch made `noticesFor` answer nothing, and the hidden branch keeps
// only keys already raised. The user comes back, sees it on the canvas, turns
// the switch on, and leaves it unanswered — and the next block change while
// hidden announced it alongside the new one, possibly hours late. Granting the
// browser's permission already adopts the standing blocks (the reseed keyed on
// the permission); the deck's own switch did not.
//
// Run, not read: the hook is rendered on a React of four hooks — state, refs,
// callbacks and effects, the effects run in order after each render whose
// deps moved — against a Notification, a document and a fetch the test owns.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BlockedSession } from "../ambient-counts";

const hooks = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  interface Instance {
    slots: unknown[];
    effects: Array<{ deps: Deps; cleanup: void | (() => void) }>;
    queued: Array<{ index: number; run: () => void | (() => void); deps: Deps }>;
    cursor: number;
    effectCursor: number;
    dirty: boolean;
    flushing: boolean;
    flush(): void;
  }
  let current: Instance | null = null;
  const moved = (prev: Deps, next: Deps) => !prev || !next || next.some((d, k) => !Object.is(d, prev[k]));

  const react = {
    useState<T>(init: T | (() => T)) {
      const inst = current!;
      const i = inst.cursor++;
      if (!(i in inst.slots)) inst.slots[i] = typeof init === "function" ? (init as () => T)() : init;
      const set = (next: T | ((prev: T) => T)) => {
        const prev = inst.slots[i] as T;
        const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        if (Object.is(prev, value)) return;
        inst.slots[i] = value;
        inst.dirty = true;
        if (!inst.flushing) inst.flush();
      };
      return [inst.slots[i] as T, set] as const;
    },
    useRef<T>(init: T) {
      const inst = current!;
      const i = inst.cursor++;
      if (!(i in inst.slots)) inst.slots[i] = { current: init };
      return inst.slots[i] as { current: T };
    },
    useCallback<F>(fn: F, deps: Deps) {
      const inst = current!;
      const i = inst.cursor++;
      const prev = inst.slots[i] as { fn: F; deps: Deps } | undefined;
      if (!prev || moved(prev.deps, deps)) inst.slots[i] = { fn, deps };
      return (inst.slots[i] as { fn: F }).fn;
    },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      const inst = current!;
      const index = inst.effectCursor++;
      const prev = inst.effects[index];
      if (!prev || moved(prev.deps, deps)) inst.queued.push({ index, run, deps });
    },
  };

  function mount<P, R>(hook: (props: P) => R, props: P) {
    let latest = props;
    let result!: R;
    const inst: Instance = {
      slots: [], effects: [], queued: [], cursor: 0, effectCursor: 0, dirty: false, flushing: false,
      flush() {
        inst.flushing = true;
        try {
          let passes = 0;
          do {
            if (++passes > 50) throw new Error("the hook never settled");
            inst.dirty = false;
            inst.cursor = 0;
            inst.effectCursor = 0;
            inst.queued = [];
            current = inst;
            try { result = hook(latest); } finally { current = null; }
            for (const q of inst.queued) {
              const cleanup = inst.effects[q.index]?.cleanup;
              if (typeof cleanup === "function") cleanup();
            }
            for (const q of inst.queued) inst.effects[q.index] = { deps: q.deps, cleanup: q.run() };
          } while (inst.dirty);
        } finally { inst.flushing = false; }
      },
    };
    inst.flush();
    return {
      get now() { return result; },
      rerender(next: Partial<P>) { latest = { ...latest, ...next }; inst.flush(); },
    };
  }

  return { react, mount };
});

vi.mock("react", () => hooks.react);

const { useOsNotifications } = await import("../use-os-notifications");

const blocked = (id: string, since: number): BlockedSession =>
  ({ id, label: id, waiting: { kind: "permission", message: "Claude needs your permission", since } });

let raised: string[] = [];
let page: { hidden: boolean };

class FakeNotification {
  static permission = "granted";
  static requestPermission = () => Promise.resolve("granted");
  onclick: (() => void) | null = null;
  constructor(_title: string, opts: { tag: string }) { raised.push(opts.tag); }
  close() {}
}

beforeEach(() => {
  raised = [];
  page = { hidden: false };
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", page);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, prefs: { notifications: true } }) })));
});

afterEach(() => { vi.unstubAllGlobals(); });

function deck() {
  const view = hooks.mount(useOsNotifications, {
    waitingSessions: [] as BlockedSession[], liveSince: null as number | null, focusSession: () => {},
  });
  view.now.loadNotifyPrefs({ prefs: { notifications: false } });
  view.rerender({ liveSince: 1 });
  return view;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("turning the deck's notification switch on", () => {
  it("treats a block standing at that moment as seen, and announces only what comes after", async () => {
    const view = deck();
    page.hidden = true;
    view.rerender({ waitingSessions: [blocked("A", 1000)] });
    expect(raised).toEqual([]);

    page.hidden = false;
    view.now.toggleNotify();
    await flush();
    expect(view.now.notifyOn).toBe(true);

    page.hidden = true;
    view.rerender({ waitingSessions: [blocked("A", 1000), blocked("B", 5000)] });
    expect(raised).toEqual(["B@5000"]);
  });

  it("still announces a block that arrives after it, while hidden", async () => {
    const view = deck();
    view.now.toggleNotify();
    await flush();
    page.hidden = true;
    view.rerender({ waitingSessions: [blocked("A", 1000)] });
    expect(raised).toEqual(["A@1000"]);
  });

  it("adopts nothing when the press turns it off", async () => {
    // Off to on is the moment the user says "tell me from here". On to off
    // leaves the memo alone: nothing is raised while it is off anyway.
    const view = deck();
    view.now.toggleNotify();
    await flush();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, prefs: { notifications: false } }) })));
    view.now.toggleNotify();
    await flush();
    expect(view.now.notifyOn).toBe(false);
    page.hidden = true;
    view.rerender({ waitingSessions: [blocked("A", 1000)] });
    expect(raised).toEqual([]);
  });
});
