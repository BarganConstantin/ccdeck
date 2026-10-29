import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { integrationCall, readThrough } from "../integrations/client";

beforeEach(() => { vi.stubGlobal("window", globalThis); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// Fetch resolves at headers, while a real fetch's body still listens to its
// signal. Model that boundary with a readable body, not an unresolved fetch.
function stalledBody(status = 200) {
  let signal!: AbortSignal;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const api = vi.fn(async (_path: string, init?: RequestInit) => {
    signal = init!.signal!;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      body = controller;
      controller.enqueue(new TextEncoder().encode('{"partial":"'));
      signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
    } }), { status });
  });
  return { api, get signal() { return signal; }, release() { body.error(new Error("Test cleanup")); } };
}

for (const caller of ["readThrough", "integrationCall"] as const) {
  function request(api: ReturnType<typeof stalledBody>["api"], signal?: AbortSignal) {
    if (caller === "integrationCall") {
      vi.stubGlobal("fetch", api);
      return integrationCall("/synthetic", { signal, timeoutMs: 50 });
    }
    return readThrough(api, "synthetic", { signal, timeoutMs: 50 });
  }

  it(`${caller} keeps its deadline while consuming a stalled JSON body`, async () => {
    const h = stalledBody();
    const result = request(h.api).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(60);
      expect(h.signal.aborted).toBe(true);
      expect(await result).toMatchObject({ kind: "network", message: "The deck took too long to answer." });
    } finally { h.release(); await result; }
  });

  it(`${caller} forwards panel cancellation after headers`, async () => {
    const h = stalledBody();
    const outer = new AbortController();
    const result = request(h.api, outer.signal).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      outer.abort();
      expect(h.signal.aborted).toBe(true);
      expect(await result).toMatchObject({ name: "AbortError" });
    } finally { h.release(); await result; }
  });

  it(`${caller} releases its timer and outer listener after a complete read`, async () => {
    const outer = new AbortController();
    const remove = vi.spyOn(outer.signal, "removeEventListener");
    const api = vi.fn(async () => Response.json({ answer: 42 }));
    expect(await request(api, outer.signal)).toEqual({ answer: 42 });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it(`${caller} also bounds an error response's stalled JSON body`, async () => {
    const h = stalledBody(503);
    const result = request(h.api).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(60);
      expect(h.signal.aborted).toBe(true);
      expect(await result).toMatchObject({ kind: "network", message: "The deck took too long to answer." });
      expect(vi.getTimerCount()).toBe(0);
    } finally { h.release(); await result; }
  });

  it(`${caller} does not start work with an already-cancelled signal`, async () => {
    const outer = new AbortController(); outer.abort();
    const api = vi.fn(async () => Response.json({ answer: 42 }));
    await expect(request(api, outer.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(api).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it(`${caller} preserves a tracker's structured error`, async () => {
    const api = vi.fn(async () => Response.json({ ok: false, error: { kind: "permission", message: "No access" } }, { status: 403 }));
    await expect(request(api)).rejects.toMatchObject({ kind: "permission", message: "No access" });
    expect(vi.getTimerCount()).toBe(0);
  });
}
