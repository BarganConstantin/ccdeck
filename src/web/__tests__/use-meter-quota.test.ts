// useMeterQuota is the rail's usage meter's only way to the quota. The owner's
// OK (2026-11-01) is the usual /api/quota read while a deck page is open, never
// a forced refresh. On this side that is: every request is a plain
// `/api/quota` (no refresh, no cached), once a minute, paused while the page is
// hidden, nothing at all on a deck that does not watch Claude Code, and a failed
// read keeps the last reading marked failed. Run on fake-react.ts with a fetch
// that records every URL.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flush, mount } from "./fake-react";
import { useMeterQuota } from "../use-quota";

vi.mock("react", async () => (await import("./fake-react")).react);

const urls: string[] = [];
let body: unknown;
let httpOk: boolean;
let down: boolean;
let visibility: "visible" | "hidden";
const listeners = new Map<string, Set<() => void>>();

beforeEach(() => {
  urls.length = 0;
  visibility = "visible";
  httpOk = true;
  down = false;
  listeners.clear();
  body = { ok: true, session5hPct: 40, planLabel: "Max 20x", fetchedAt: 1_000 };
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", {
    get visibilityState() { return visibility; },
    addEventListener: (type: string, fn: () => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
  });
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    if (down) throw new Error("unreachable");
    return { ok: httpOk, json: async () => body };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const visibilityChanged = () => { for (const fn of [...(listeners.get("visibilitychange") ?? [])]) fn(); };

describe("useMeterQuota", () => {
  it("never sends refresh=1 or cached: every URL is the plain /api/quota", async () => {
    const view = mount(() => useMeterQuota(true), {});
    await flush();
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    visibilityChanged();
    await flush();
    expect(urls.length).toBeGreaterThanOrEqual(4);
    for (const url of urls) {
      expect(url).toBe("/api/quota");
      expect(url).not.toContain("refresh");
      expect(url).not.toContain("cached");
    }
    view.unmount();
  });

  it("polls every 60 seconds, not faster", async () => {
    const view = mount(() => useMeterQuota(true), {});
    await flush();
    expect(urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(urls).toHaveLength(2);
    view.unmount();
  });

  it("hands back the reading and when it was collected (its own fetchedAt)", async () => {
    body = { ok: true, session5hPct: 40, planLabel: "Max 20x", fetchedAt: 123_456 };
    const view = mount(() => useMeterQuota(true), {});
    await flush();
    expect(view.tree).toMatchObject({ readAt: 123_456, failed: false, reading: { ok: true, session5hPct: 40, planLabel: "Max 20x" } });
    view.unmount();
  });

  it("is switched off on a deck that does not watch Claude Code", async () => {
    const off = mount(() => useMeterQuota(false), {});
    await flush();
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(urls).toEqual([]);
    expect(off.tree).toEqual({ reading: null, readAt: 0, failed: false });
    off.unmount();
  });

  it("pauses while the page is hidden, looks at once when it is visible again, and cleans up", async () => {
    const view = mount(() => useMeterQuota(true), {});
    await flush();
    expect(urls).toHaveLength(1);
    visibility = "hidden";
    visibilityChanged();
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(urls, "hidden: no ticks").toHaveLength(1);
    visibility = "visible";
    visibilityChanged();
    await flush();
    expect(urls, "visible again: a read now").toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(urls, "and the minute poll resumes").toHaveLength(3);
    view.unmount();
    expect(listeners.get("visibilitychange")?.size ?? 0).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(urls, "unmounted: nothing more").toHaveLength(3);
  });

  it("does not start while the page opens hidden", async () => {
    visibility = "hidden";
    const view = mount(() => useMeterQuota(true), {});
    await flush();
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(urls).toEqual([]);
    visibility = "visible";
    visibilityChanged();
    await flush();
    expect(urls).toHaveLength(1);
    view.unmount();
  });

  it("keeps the last reading, marked failed, when a read fails, and clears the mark on the next good one", async () => {
    const view = mount(() => useMeterQuota(true), {});
    await flush();
    down = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(view.tree).toMatchObject({ failed: true, readAt: 1_000, reading: { session5hPct: 40 } });
    down = false;
    httpOk = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(view.tree).toMatchObject({ failed: true, reading: { session5hPct: 40 } });
    httpOk = true;
    body = { ok: true, session5hPct: 55, fetchedAt: 9_000 };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(view.tree).toMatchObject({ failed: false, readAt: 9_000, reading: { session5hPct: 55 } });
    view.unmount();
  });

  it("treats an answer without numbers as a failed read, not as a reading", async () => {
    const view = mount(() => useMeterQuota(true), {});
    await flush();
    body = { ok: false, reason: "cli_failed" };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(view.tree).toMatchObject({ failed: true, reading: { session5hPct: 40 } });
    view.unmount();
  });

  it("is written without a refresh path at all", () => {
    const src = readFileSync(fileURLToPath(new URL("../use-quota.ts", import.meta.url)), "utf8");
    const start = src.indexOf("export function useMeterQuota");
    const hook = src.slice(start, src.indexOf("// ── Codex quota types", start))
      .replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    expect(hook).not.toContain("refresh");
    expect(hook).not.toContain("cached");
    expect(hook.match(/fetch\(/g)).toHaveLength(1);
    expect(hook).toContain('"/api/quota"');
  });
});
