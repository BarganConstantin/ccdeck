// useCachedQuota is the rail's usage meter's only way to the quota, and the
// owner's rule for it (2026-11-01) is that the meter never causes a read of its
// own. On this side that is three things: every request it makes carries
// `cached=1` (the route then answers from memory alone, server-side pinned in
// quota-peek.test.ts), none carries `refresh=1`, and a deck that does not watch
// Claude Code asks nothing at all. The hook is run on fake-react.ts with a
// fetch that records every URL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flush, mount } from "./fake-react";
import { useCachedQuota } from "../use-quota";

vi.mock("react", async () => (await import("./fake-react")).react);

const urls: string[] = [];
let body: unknown;
let visibility: "visible" | "hidden";
const listeners = new Map<string, Set<() => void>>();

beforeEach(() => {
  urls.length = 0;
  visibility = "visible";
  listeners.clear();
  body = { ok: true, session5hPct: 40, planLabel: "Max 20x", readAt: 1_000, lapsed: false };
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", {
    get visibilityState() { return visibility; },
    addEventListener: (type: string, fn: () => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
  });
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return { ok: true, json: async () => body };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const cameBack = () => { for (const fn of [...(listeners.get("visibilitychange") ?? [])]) fn(); };

describe("useCachedQuota", () => {
  it("asks for the cached reading only: every URL carries cached=1 and none refresh=1", async () => {
    const view = mount(() => useCachedQuota(true), {});
    await flush();
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    cameBack();
    await flush();
    expect(urls.length).toBeGreaterThanOrEqual(4);
    for (const url of urls) {
      expect(url).toBe("/api/quota?cached=1");
      expect(url).not.toContain("refresh");
    }
    view.unmount();
  });

  it("polls every 60 seconds, not faster", async () => {
    const view = mount(() => useCachedQuota(true), {});
    await flush();
    expect(urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(urls).toHaveLength(2);
    view.unmount();
  });

  it("hands back the reading, when it was read and whether it has lapsed", async () => {
    body = { ok: true, session5hPct: 40, planLabel: "Max 20x", readAt: 123_456, lapsed: true };
    const view = mount(() => useCachedQuota(true), {});
    await flush();
    expect(view.tree).toMatchObject({ readAt: 123_456, lapsed: true, reading: { ok: true, session5hPct: 40, planLabel: "Max 20x" } });
    view.unmount();
  });

  it("has no reading when the server has none, or when it is switched off", async () => {
    body = { ok: false, reason: "no_reading" };
    const view = mount(() => useCachedQuota(true), {});
    await flush();
    expect(view.tree).toEqual({ reading: null, readAt: 0, lapsed: false });
    view.unmount();

    urls.length = 0;
    const off = mount(() => useCachedQuota(false), {});
    await flush();
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(urls).toEqual([]);
    expect(off.tree).toEqual({ reading: null, readAt: 0, lapsed: false });
    off.unmount();
  });

  it("looks again when the page becomes visible, stops while hidden, and cleans up", async () => {
    const view = mount(() => useCachedQuota(true), {});
    await flush();
    expect(urls).toHaveLength(1);
    visibility = "hidden";
    cameBack();
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(urls, "hidden: no ticks").toHaveLength(1);
    visibility = "visible";
    cameBack();
    await flush();
    expect(urls, "visible again: a look now").toHaveLength(2);
    view.unmount();
    expect(listeners.get("visibilitychange")?.size ?? 0).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(urls, "unmounted: nothing more").toHaveLength(2);
  });

  it("is written without a refresh path at all", () => {
    const src = readFileSync(fileURLToPath(new URL("../use-quota.ts", import.meta.url)), "utf8");
    const start = src.indexOf("export function useCachedQuota");
    const hook = src.slice(start, src.indexOf("// ── Codex quota types", start))
      .replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    expect(hook).not.toContain("refresh");
    expect(hook.match(/fetch\(/g)).toHaveLength(1);
    expect(hook).toContain('"/api/quota?cached=1"');
  });
});
