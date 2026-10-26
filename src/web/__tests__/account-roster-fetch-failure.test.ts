// The 3.46.0 report points to the roster's paired fetches. If an injected
// fetch throws on the second call, evaluating Promise.all's array used to
// leave the first request without a rejection handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, mount } from "./fake-react";
import { useAccountRoster } from "../use-account-roster";
import { RELOAD_SLOW, RELOAD_UNREACHABLE } from "../accounts-reload";

// React may evaluate functional state updates after the async catch returns.
// Hold those updaters explicitly; fake-react normally evaluates them at once.
const updates = vi.hoisted(() => ({ deferred: false, pending: [] as Array<() => void> }));
vi.mock("react", async () => {
  const { react } = await import("./fake-react");
  return {
    ...react,
    useState<T>(initial: T | (() => T)) {
      const [value, set] = react.useState(initial);
      return [value, (next: T | ((prev: T) => T)) => {
        if (updates.deferred && typeof next === "function") updates.pending.push(() => set(next));
        else set(next);
      }] as const;
    },
  };
});

beforeEach(() => {
  updates.deferred = false;
  updates.pending = [];
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const ignoreRoster = () => {};

describe("paired account requests when fetch is wrapped by an extension", () => {
  it("handles the first rejection even when the second fetch throws synchronously", async () => {
    let reject!: (reason: Error) => void;
    const first = new Promise<Response>((_resolve, fail) => { reject = fail; });
    const observed = vi.spyOn(first, "then");
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      if (++calls === 1) return first;
      throw new TypeError("Failed to fetch");
    });
    const view = mount(() => useAccountRoster(ignoreRoster), {});
    await flush();
    const handled = observed.mock.calls.some(([, fail]) => typeof fail === "function");
    // Keep the failing baseline safe for Vitest; this handler is attached only
    // after observing whether the real load had already handled the request.
    void first.catch(() => {});
    reject(new TypeError("Failed to fetch"));
    await flush();
    expect(view.tree.failure).toEqual(RELOAD_UNREACHABLE);
    expect(view.tree.reloading).toBe(false);
    view.unmount();
    expect(handled, "the first request can reject without an app handler").toBe(true);
  });

  it.each(["throw", "reject"] as const)(
    "aborts a still-pending sibling fetch when another request fails by %s",
    async failureKind => {
      let calls = 0;
      let aborts = 0;
      const signals: AbortSignal[] = [];
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        if (++calls === 1) {
          const signal = init.signal!;
          signals.push(signal);
          // This request cannot finish on its own. It must be cancelled even
          // though Promise.all has already rejected on its sibling.
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborts++;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        if (failureKind === "throw") throw new TypeError("Failed to fetch");
        return Promise.reject(new TypeError("Failed to fetch"));
      });

      const view = mount(() => useAccountRoster(ignoreRoster), {});
      await flush();
      expect(calls).toBe(2);
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted, "the orphaned request lost its timeout and unmount cleanup").toBe(true);
      expect(aborts).toBe(1);
      // Cleanup must not turn a synchronous network error into a timeout.
      expect(view.tree.failure).toEqual(RELOAD_UNREACHABLE);
      expect(view.tree.reloading).toBe(false);
      view.unmount();
    },
  );

  it.each(["network", "timeout"] as const)(
    "preserves %s classification when React evaluates failure state after cleanup",
    async reason => {
      updates.deferred = true;
      const signals: AbortSignal[] = [];
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        const signal = init.signal!;
        signals.push(signal);
        if (reason === "network" && signals.length === 2) return Promise.reject(new TypeError("Failed to fetch"));
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      });
      const view = mount(() => useAccountRoster(ignoreRoster), {});
      try {
        await flush();
        if (reason === "timeout") await vi.advanceTimersByTimeAsync(30_000);
        // A poll at the same 30s boundary may start a new pair after cleanup.
        expect(signals.slice(0, 2)).toHaveLength(2);
        expect(signals.slice(0, 2).every(signal => signal.aborted)).toBe(true);
        expect(view.tree.reloading).toBe(false);
        expect(view.tree.failure).toBeNull();
        expect(updates.pending).toHaveLength(1);
        // Run React's queued updater only after sibling cancellation and
        // controller cleanup have finished, as deferred rendering can do.
        updates.pending.shift()!();
        expect(view.tree.failure).toEqual(reason === "timeout" ? RELOAD_SLOW : RELOAD_UNREACHABLE);
      } finally { view.unmount(); }
    },
  );

  it("gives both requests the same deadline and clears busy state after a timeout", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const view = mount(() => useAccountRoster(ignoreRoster), {});
    await flush();
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signals.slice(0, 2).every(signal => signal.aborted)).toBe(true);
    expect(view.tree.reloading).toBe(false);
    expect(view.tree.failure?.reload).toBe(true);
    view.unmount();
  });

  it.each([0, 1])("shows a recoverable failure when request %i rejects normally", async failed => {
    vi.stubGlobal("fetch", vi.fn((_url: string) => {
      const index = vi.mocked(fetch).mock.calls.length - 1;
      return index === failed ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve({ ok: true, json: async () => null });
    }));
    const view = mount(() => useAccountRoster(ignoreRoster), {});
    await flush();
    expect(view.tree.failure).toEqual(RELOAD_UNREACHABLE);
    expect(view.tree.reloading).toBe(false);
    view.unmount();
  });
});
