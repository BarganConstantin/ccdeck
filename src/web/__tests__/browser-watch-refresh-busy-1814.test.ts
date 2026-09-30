// #1814: the ↻ in Browser Watch's header answered for every read, not for the
// one somebody asked for.
//
// `load()` set `busy` for every read — the one on open and the ten-second poll
// as well as the ↻'s forced re-read — so the glyph turned to `…` with
// aria-busy every ten seconds while nobody had pressed anything. And every
// read's `finally` cleared both `busy` and the guard behind it, so a poll that
// finished while a pressed re-read was still out made the ↻ look done and let
// a second press through.
//
// Run, not read: the hook on a React of four hooks, its interval on fake
// timers, and a fetch whose every answer the test hands back when it chooses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── the hook, on a React small enough to read ───────────────────────────────
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
  const moved = (a: Deps, b: Deps) => !a || !b || a.length !== b.length || a.some((d, k) => !Object.is(d, b[k]));

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
    useCallback<F>(fn: F, deps?: readonly unknown[]) {
      const inst = current!;
      const i = inst.cursor++;
      const prev = inst.slots[i] as { fn: F; deps: Deps } | undefined;
      if (prev && !moved(prev.deps, deps)) return prev.fn;
      inst.slots[i] = { fn, deps };
      return fn;
    },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      const inst = current!;
      const index = inst.effectCursor++;
      const prev = inst.effects[index];
      if (!prev || moved(prev.deps, deps)) inst.queued.push({ index, run, deps });
    },
  };

  function mount<A extends unknown[], R>(hook: (...args: A) => R, ...args: A) {
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
            try { result = hook(...args); } finally { current = null; }
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
    return { get now() { return result; } };
  }

  return { react, mount };
});

vi.mock("react", () => hooks.react);

const { useBrowserWatch } = await import("../use-browser-watch");

// ── a deck that answers when the test says so ───────────────────────────────
interface Asked { url: string; answer: () => Promise<void> }
let asked: Asked[] = [];
const SNAP = { settings: { enabled: false, quietMinutes: 15 }, episodes: [], browsers: [], profiles: [] };

/** Let every promise the answer released run its continuation. */
const settle = () => new Promise<void>(r => setTimeout(r, 0));

beforeEach(() => {
  asked = [];
  // Only the interval is faked: `settle` needs a real turn of the loop.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.stubGlobal("fetch", (url: string) => new Promise(resolve => {
    asked.push({
      url,
      answer: async () => {
        resolve({ ok: true, status: 200, json: async () => SNAP });
        await settle();
      },
    });
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const onWatching = () => {};
const presses = () => asked.filter(a => a.url === "/api/browser-watch?refresh=1");

/** The dialog opened, its first read answered, and the ten-second poll out. */
async function pollingDialog() {
  const view = hooks.mount(useBrowserWatch, onWatching);
  await asked[0].answer();
  vi.advanceTimersByTime(10_000);
  expect(asked.map(a => a.url), "the interval did not poll").toEqual(["/api/browser-watch", "/api/browser-watch"]);
  return { view, poll: asked[1] };
}

describe("the ↻ answers for the re-read somebody asked for", () => {
  it("stays ↻ through the read on open and the ten-second poll", async () => {
    const view = hooks.mount(useBrowserWatch, onWatching);
    expect(view.now.busy, "the read on open drew … on a ↻ nobody pressed").toBe(false);
    await asked[0].answer();
    vi.advanceTimersByTime(10_000);
    expect(asked).toHaveLength(2);
    expect(view.now.busy, "the ten-second poll drew … on a ↻ nobody pressed").toBe(false);
  });

  it("stays busy, and guarded, when a poll finishes before the re-read", async () => {
    const { view, poll } = await pollingDialog();
    void view.now.load(true);
    expect(view.now.busy).toBe(true);

    await poll.answer();
    expect(view.now.busy, "the poll finishing made the re-read look done").toBe(true);
    void view.now.load(true);
    expect(presses(), "a second press went out while the first was still out").toHaveLength(1);

    await presses()[0].answer();
    expect(view.now.busy, "the re-read answered and the ↻ stayed busy").toBe(false);
  });

  it("keeps the guard when a poll starts while the re-read is out", async () => {
    const view = hooks.mount(useBrowserWatch, onWatching);
    await asked[0].answer();
    void view.now.load(true);
    vi.advanceTimersByTime(10_000);
    expect(asked.map(a => a.url)).toEqual(["/api/browser-watch", "/api/browser-watch?refresh=1", "/api/browser-watch"]);
    expect(view.now.busy, "the poll starting cleared the re-read's …").toBe(true);
    void view.now.load(true);
    expect(presses(), "the poll starting released the guard").toHaveLength(1);
  });

  it("is still a press the poll cannot turn away", async () => {
    // The guard is the press's own: a poll has nobody behind it to refuse, and
    // must go out while a re-read is still on its way.
    const view = hooks.mount(useBrowserWatch, onWatching);
    await asked[0].answer();
    void view.now.load(true);
    void view.now.load(false);
    expect(asked.map(a => a.url)).toEqual(["/api/browser-watch", "/api/browser-watch?refresh=1", "/api/browser-watch"]);
  });
});
