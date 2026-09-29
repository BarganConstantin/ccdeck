// A first press the browser does not count (#1760).
//
// A browser lets an AudioContext run only after user activation, and not every
// input is activation: Escape is not, and neither is a touch's pointerdown —
// the touch counts when it lifts. The player used to latch "unlocked" on the
// first press whatever the context did, and the page listened for that press
// once, so a tab whose first input was Escape or a touch kept a suspended
// context for the rest of its life: no later click, key, M or preview asked
// the context to resume again.
//
// Run, not read. The context is a fake whose resume() runs it only while the
// test says the press is activation, and otherwise hands back a promise that
// never settles — what a browser does with a resume() it will not honour. The
// hook is run under a React reduced to the two hooks it calls, against a
// window that is a plain EventTarget. Nothing here builds a real AudioContext.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const react = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", () => ({
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
  useEffect: (run: () => void | (() => void)) => { react.effects.push(run); },
}));

const { createChimePlayer } = await import("../chime-player");
const { useChimePlayer } = await import("../use-chime-player");

/** Whether the press being handled is one the browser counts as activation. */
let activation = false;
let resumes = 0;
let built = 0;

class FakeCtx extends EventTarget {
  state: "suspended" | "running" = "suspended";
  currentTime = 0;
  destination = {} as AudioNode;
  constructor() { super(); built++; }
  resume() {
    resumes++;
    if (!activation) return new Promise<void>(() => {});
    this.state = "running";
    this.dispatchEvent(new Event("statechange"));
    return Promise.resolve();
  }
  createOscillator() {
    const node = { type: "", frequency: { value: 0 }, connect: (n: unknown) => n, start() {}, stop() {} };
    return node as unknown as OscillatorNode;
  }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n: unknown) => n } as unknown as GainNode;
  }
}
const Ctor = FakeCtx as unknown as typeof AudioContext;

beforeEach(() => {
  activation = false;
  resumes = 0;
  built = 0;
  react.effects = [];
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("the player, when the first press was not activation", () => {
  it("starts on the next press that is", () => {
    const p = createChimePlayer({ enabled: () => true, ctor: Ctor });
    p.unlock();
    expect(p.state()).toBe("locked");
    expect(p.play("done")).toBe(false);

    activation = true;
    p.unlock();
    expect(p.state()).toBe("ready");
    expect(p.play("done")).toBe(true);
  });

  it("keeps the one context it built, rather than a new one per press", () => {
    const p = createChimePlayer({ enabled: () => true, ctor: Ctor });
    p.unlock();
    p.unlock();
    activation = true;
    p.unlock();
    expect(built).toBe(1);
    expect(resumes).toBe(3);
  });

  it("asks nothing more of a context that is already running", () => {
    activation = true;
    const p = createChimePlayer({ enabled: () => true, ctor: Ctor });
    p.unlock();
    p.unlock();
    expect(resumes).toBe(1);
  });

  it("says ready when the context starts, not only when a press asked it to", () => {
    // The switch's tooltip reads what onState reports. A context the browser
    // starts later — a resume answered after the press — is announced by its
    // own statechange.
    const seen: string[] = [];
    const p = createChimePlayer({ enabled: () => true, ctor: Ctor, onState: s => seen.push(s) });
    p.unlock();
    const ctx = p.context as unknown as FakeCtx;
    ctx.state = "running";
    ctx.dispatchEvent(new Event("statechange"));
    expect(seen.at(-1)).toBe("ready");
  });
});

describe("the page's wake listeners", () => {
  function mountHook() {
    const win = Object.assign(new EventTarget(), { AudioContext: FakeCtx });
    vi.stubGlobal("window", win);
    const ref = <T>(current: T) => ({ current });
    const chimesRef = ref<ReturnType<typeof createChimePlayer> | null>(null);
    useChimePlayer({
      chimesRef,
      soundOnRef: ref<boolean | null>(true),
      tonePrefsRef: ref(undefined as never),
      customSelectionsRef: ref({ done: null, "needs-input": null }),
      fallbackCustomRef: ref(() => {}),
    });
    const cleanups = react.effects.map(run => run()).filter((c): c is () => void => typeof c === "function");
    return { win, chimesRef, unmount: () => cleanups.forEach(c => c()) };
  }

  it("try again after an Escape, on the pointerdown that follows", () => {
    const { win, chimesRef } = mountHook();
    win.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    win.dispatchEvent(new Event("pointerdown"));
    expect(resumes).toBe(2);
    activation = true;
    win.dispatchEvent(new Event("pointerdown"));
    expect(chimesRef.current?.state()).toBe("ready");
  });

  it("hear a touch when it lifts, after its pointerdown was refused", () => {
    const { win, chimesRef } = mountHook();
    win.dispatchEvent(new Event("pointerdown"));
    expect(chimesRef.current?.state()).toBe("locked");
    activation = true;
    win.dispatchEvent(new Event("pointerup"));
    expect(chimesRef.current?.state()).toBe("ready");
  });

  it("stop listening once the context runs, and at unmount", () => {
    const { win, unmount } = mountHook();
    activation = true;
    win.dispatchEvent(new Event("pointerdown"));
    const after = resumes;
    for (const type of ["pointerdown", "pointerup", "keydown"]) win.dispatchEvent(new Event(type));
    expect(resumes).toBe(after);
    unmount();
    win.dispatchEvent(new Event("pointerdown"));
    expect(resumes).toBe(after);
  });

  it("leave nothing behind at unmount while still locked", () => {
    const { win, unmount } = mountHook();
    unmount();
    for (const type of ["pointerdown", "pointerup", "keydown"]) win.dispatchEvent(new Event(type));
    expect(resumes).toBe(0);
  });
});
