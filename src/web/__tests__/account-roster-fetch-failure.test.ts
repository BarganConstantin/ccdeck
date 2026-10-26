// The 3.46.0 report points to the roster's paired fetches. If an injected
// fetch throws on the second call, evaluating Promise.all's array used to
// leave the first request without a rejection handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, mount } from "./fake-react";
import { useAccountRoster } from "../use-account-roster";
import { RELOAD_UNREACHABLE } from "../accounts-reload";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => {
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
