// Syntax colours come back after a worker that stopped answering: the request
// it held falls back to plain text, and the next diff gets a fresh worker with
// its grammars sent again. A grammar that failed to load is tried again.
import { afterAll, describe, expect, it, vi } from "vitest";
import { highlightDocs, TOK_TIMEOUT } from "../git-syntax";
import { sourceOf } from "./client-source";

type Msg = { t: string; id?: number; lang?: string };
const workers: FakeWorker[] = [];
let silent = false;

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  posted: Msg[] = [];
  terminated = false;
  constructor() { workers.push(this); }
  postMessage(m: Msg) {
    this.posted.push(m);
    // A worker that died without saying so answers nothing.
    if (m.t === "tok" && !silent) queueMicrotask(() => this.onmessage?.({ data: { t: "tok", id: m.id, spans: [[[0, 3, "kw"]]] } }));
  }
  terminate() { this.terminated = true; }
}

vi.stubGlobal("Worker", FakeWorker);
afterAll(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("a worker that stops answering", () => {
  it("lets the diff it held fall back to plain text, and colours the next one in a fresh worker", async () => {
    expect(await highlightDocs("json", ["{}"])).toEqual([[[0, 3, "kw"]]]);
    expect(workers).toHaveLength(1);

    silent = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const held = highlightDocs("json", ['{"a": 1}']);
    await vi.advanceTimersByTimeAsync(TOK_TIMEOUT + 1);
    expect(await held).toBeNull();
    expect(workers[0].terminated).toBe(true);
    vi.useRealTimers();

    silent = false;
    expect(await highlightDocs("json", ['{"b": 2}'])).toEqual([[[0, 3, "kw"]]]);
    expect(workers).toHaveLength(2);
    // The new worker was handed the grammar again before it was asked.
    expect(workers[1].posted.map(m => m.t)).toEqual(["lang", "tok"]);
  });
});

describe("a grammar that failed to load", () => {
  it("is not remembered as failed, so the next diff in that language tries again", () => {
    expect(sourceOf("git-syntax.ts")).toMatch(/return true; \}, \(\) => \{ sent\.delete\(lang\); return false; \}\);/);
  });
});
