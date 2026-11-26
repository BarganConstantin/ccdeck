// What Chat reads (use-session-transcript.ts): asked only while the Chat view
// is on screen; soon after the session is heard from; once more when its
// prompts or its end change; on a timer while the page is visible, every 1.5
// seconds while the session works and every fifteen otherwise, sending the
// version it holds; older pages on request, kept in front of the live window.
// The answer as ChatView draws it, in the language on show.
//
// Run as a hook under the suite's stand-in React (fake-react.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ChatSource } from "../components/chat/chat-model";
import {
  chatSessionFor, HEARD_MS, IDLE_POLL_MS, MAX_KEPT_TURNS, POLL_MS, readTranscript, useSessionTranscript, type SessionTranscriptInput,
} from "../use-session-transcript";
import { mount, flush } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const answer = (status: number, body: unknown = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
const ready = (turns: unknown[] = [{ kind: "user", text: "hi" }], complete = true) => answer(200, { ok: true, complete, turns });

function setup(
  first: SessionTranscriptInput,
  fetchFn: (url: string) => Promise<Response>,
  visible = () => true,
  watchVisible?: (onChange: () => void) => () => void,
) {
  let source: ChatSource = { state: "loading" };
  const Probe = (input: SessionTranscriptInput) => { source = useSessionTranscript(input, { fetchFn: fetchFn as never, visible, watchVisible }); return null; };
  const view = mount(Probe, first);
  return { view, get source() { return source; } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const on: SessionTranscriptInput = { session: "abc", shown: true, working: false, change: "0:idle" };

describe("when it asks", () => {
  it("fetches nothing while Chat is not on screen, and nothing with no session", async () => {
    const fetchFn = vi.fn(async () => ready());
    const a = setup({ ...on, shown: false, working: true }, fetchFn);
    const b = setup({ ...on, session: null, working: true }, fetchFn);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(a.source).toEqual({ state: "loading" });
    expect(b.source).toEqual({ state: "loading" });
  });

  // CHANGED ON PURPOSE: this used to expect no further ask at all while the
  // session rests. A local command's output reaches the transcript with no
  // event, so a resting session is asked again every 15 s while the page is
  // looked at, and that ask sends the version it holds (one stat on the server).
  it("asks once when Chat is shown, for that session only, and while the session rests only every 15 s", async () => {
    const fetchFn = vi.fn(async () => ready());
    const h = setup(on, fetchFn);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe("/api/session/transcript?session=abc");
    expect(h.source).toMatchObject({ state: "ready", turns: [{ kind: "user", text: "hi" }] });
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("loads Codex explicitly and clears a Claude result with the same session ID", async () => {
    const fetchFn = vi.fn(async () => ready());
    const h = setup(on, fetchFn);
    await flush();
    h.view.rerender({ ...on, provider: "codex" });
    expect(h.source).toEqual({ state: "loading" });
    await flush();
    expect(fetchFn.mock.calls[1][0]).toBe("/api/session/transcript?session=abc&provider=codex");
    expect(h.source.state).toBe("ready");
  });

  // CHANGED ON PURPOSE: this used to expect no fetch once the session stopped
  // working. The final reply and the question a session waits on land just as the
  // status turns from working, after the last timed ask, so a status change is
  // one more ask. Changed again: the timer then slows to every 15 s rather than
  // resting (see the case above).
  // CHANGED ON PURPOSE (Chat live): every 1.5 s while the session works, so a
  // turn reads live; an unmoved file costs the deck one stat per ask.
  it("asks again every 1.5 s while the session is working, once more when its status changes, and then every 15 s", async () => {
    expect(POLL_MS).toBe(1500);
    expect(IDLE_POLL_MS).toBe(15000);
    const fetchFn = vi.fn(async () => ready());
    const h = setup({ ...on, working: true, change: "1:working" }, fetchFn);
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    h.view.rerender({ ...on, working: false, change: "1:idle" });
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it("asks once more when a working session turns to waiting", async () => {
    const fetchFn = vi.fn(async () => ready());
    const h = setup({ ...on, working: true, change: "1:working" }, fetchFn);
    await flush();
    h.view.rerender({ ...on, working: false, change: "1:waiting" });
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("drops an older answer that lands after a newer one", async () => {
    const pending: Array<(r: Response) => void> = [];
    const fetchFn = vi.fn(() => new Promise<Response>(done => { pending.push(done); }));
    const h = setup(on, fetchFn);
    await flush();
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    expect(pending).toHaveLength(2);
    pending[1](ready([{ kind: "assistant", text: "newer" }]));
    await flush();
    pending[0](ready([{ kind: "assistant", text: "older" }]));
    await flush();
    expect(h.source).toMatchObject({ state: "ready", turns: [{ kind: "assistant", text: "newer" }] });
  });

  it("rests on the timer while the page is hidden", async () => {
    const fetchFn = vi.fn(async () => ready());
    let visible = false;
    setup({ ...on, working: true }, fetchFn, () => visible);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    visible = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("asks once more when the prompt count or the status changes, and stops when Chat goes away", async () => {
    const fetchFn = vi.fn(async () => ready());
    const h = setup(on, fetchFn);
    await flush();
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    h.view.rerender({ ...on, change: "1:ended" });
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    h.view.rerender({ ...on, change: "1:ended", shown: false, working: true });
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("shows loading, not the last session's turns, for a different session", async () => {
    const h = setup(on, vi.fn(async () => ready()));
    await flush();
    expect(h.source.state).toBe("ready");
    h.view.rerender({ ...on, session: "other" });
    expect(h.source).toEqual({ state: "loading" });
  });
});

describe("what it answers", () => {
  it("says a session the deck cannot read yet in words, with no Retry", async () => {
    const h = setup(on, vi.fn(async () => answer(404, { ok: false, reason: "unknown_session" })));
    await flush();
    expect(h.source).toEqual({ state: "error", message: "The conversation shows once the session takes its next step." });
  });

  it("gives an ended session its own sentence when the deck cannot read it", async () => {
    const h = setup({ ...on, ended: true }, vi.fn(async () => answer(404, { ok: false, reason: "unknown_session" })));
    await flush();
    expect(h.source).toEqual({ state: "error", message: "This conversation is not available on this deck." });
  });

  it("says any other failure could not be read, with Retry that asks again", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => (++n === 1 ? answer(500) : ready()));
    const h = setup(on, fetchFn);
    await flush();
    const failed = h.source;
    expect(failed).toMatchObject({ state: "error", message: "The conversation could not be read." });
    (failed as { onRetry(): void }).onRetry();
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(h.source.state).toBe("ready");
  });

  it("treats a thrown fetch and a malformed body as a failure", async () => {
    expect(await readTranscript("a", async () => { throw new Error("down"); })).toEqual({ kind: "failed" });
    expect(await readTranscript("a", async () => answer(200, { ok: true }))).toEqual({ kind: "failed" });
    expect(await readTranscript("a", async () => answer(200, { ok: false, turns: [] }))).toEqual({ kind: "failed" });
  });

  it("starts the turns with a line saying earlier turns are not shown when the read was cut", async () => {
    const h = setup(on, vi.fn(async () => ready([{ kind: "assistant", text: "late" }], false)));
    await flush();
    expect(h.source).toEqual({
      state: "ready",
      turns: [{ kind: "record", text: "Earlier turns are not shown." }, { kind: "assistant", text: "late" }],
    });
  });
});

type Ready = Extract<ChatSource, { state: "ready" }>;
const params = (url: string) => new URL(url, "http://deck").searchParams;
const turn = (text: string) => ({ kind: "user", text });
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => turn(`${prefix}${i}`));

describe("live, without a fixed timer", () => {
  it("sends the version it holds, and keeps what it drew when the file has not moved", async () => {
    const fetchFn = vi.fn(async (url: string) => (params(url).get("since") === "v1"
      ? answer(200, { ok: true, unchanged: true })
      : answer(200, { ok: true, complete: true, turns: [turn("hi")], version: "v1" })));
    const h = setup(on, fetchFn);
    await flush();
    const drawn = (h.source as Ready).turns;
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(params(fetchFn.mock.calls[1][0]).get("since")).toBe("v1");
    // The very turns it held: nothing was put in their place.
    expect((h.source as Ready).turns).toBe(drawn);
  });

  it("does not send one session's version for another, nor after Retry", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => (++n === 2 ? answer(500) : answer(200, { ok: true, complete: true, turns: [], version: "v1" })));
    const h = setup(on, fetchFn);
    await flush();
    h.view.rerender({ ...on, session: "other" });
    await flush();
    expect(params(fetchFn.mock.calls[1][0]).get("since")).toBeNull();
    (h.source as { onRetry(): void }).onRetry();
    await flush();
    expect(params(fetchFn.mock.calls[2][0]).get("since")).toBeNull();
  });

  it("asks HEARD_MS after the session is heard from, once for a burst, and keeps asking through a steady stream", async () => {
    const fetchFn = vi.fn(async () => ready());
    const h = setup({ ...on, heard: 1 }, fetchFn);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    h.view.rerender({ ...on, heard: 2 });
    await vi.advanceTimersByTimeAsync(100);
    h.view.rerender({ ...on, heard: 3 });
    await vi.advanceTimersByTimeAsync(100);
    h.view.rerender({ ...on, heard: 4 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEARD_MS - 200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // One event every 100 ms for 2 s: a waiting ask is not pushed back, so it still asks.
    for (let i = 5; i < 25; i++) {
      h.view.rerender({ ...on, heard: i });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(fetchFn).toHaveBeenCalledTimes(8);
  });

  it("asks nothing more for the moment Chat is shown, nor for another session's first event", async () => {
    const fetchFn = vi.fn(async () => ready());
    const h = setup({ ...on, heard: 1 }, fetchFn);
    await flush();
    await vi.advanceTimersByTimeAsync(HEARD_MS * 4);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    h.view.rerender({ ...on, session: "other", heard: 9 });
    await flush();
    await vi.advanceTimersByTimeAsync(HEARD_MS * 4);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not ask on events while Chat is not shown", async () => {
    const fetchFn = vi.fn(async () => ready());
    const h = setup({ ...on, shown: false, heard: 1 }, fetchFn);
    h.view.rerender({ ...on, shown: false, heard: 2 });
    await vi.advanceTimersByTimeAsync(HEARD_MS * 4);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not ask on events or the timer while the page is hidden, and asks once when it is looked at again", async () => {
    const fetchFn = vi.fn(async () => ready());
    let visible = false;
    let onChange = () => {};
    const watch = (cb: () => void) => { onChange = cb; return () => { onChange = () => {}; }; };
    const h = setup({ ...on, heard: 1 }, fetchFn, () => visible, watch);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    h.view.rerender({ ...on, heard: 2 });
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    visible = true;
    onChange();
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    h.view.rerender({ ...on, heard: 2, shown: false });
    onChange();
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

/** A stand-in route: the live window from `live()`, and each older window by its
 *  `before` (with `<after` when one is sent); any other cursor is refused as stale. */
function route(pages: Record<string, unknown | (() => Promise<Response>)>, live: () => unknown) {
  return vi.fn(async (url: string) => {
    const q = params(url);
    const before = q.get("before");
    if (!before) return answer(200, live());
    const key = q.get("after") ? `${before}<${q.get("after")}` : before;
    const page = pages[key];
    if (typeof page === "function") return (page as () => Promise<Response>)();
    return page ? answer(200, page) : answer(400, { ok: false, reason: "stale_cursor" });
  });
}

describe("older pages", () => {
  const p1 = { ok: true, complete: false, turns: [turn("p1")], older: "c1" };
  const p0 = { ok: true, complete: true, turns: [turn("p0")] };

  it("offers older turns only while there are some, puts each page in front, and stops at the start", async () => {
    const fetchFn = route({ c2: p1, c1: p0 }, () => ({ ok: true, complete: false, turns: [turn("l0")], version: "v1", older: "c2" }));
    const h = setup(on, fetchFn);
    await flush();
    let src = h.source as Ready;
    // No "Earlier turns are not shown." line: the older part is offered instead.
    expect(src.turns).toEqual([turn("l0")]);
    expect(src.older).toMatchObject({ loading: false, failed: false });
    expect(src.head).toBeUndefined();
    src.older!.load();
    expect((h.source as Ready).older?.loading).toBe(true);
    await flush();
    expect(params(fetchFn.mock.calls[1][0]).get("before")).toBe("c2");
    expect(params(fetchFn.mock.calls[1][0]).get("since")).toBeNull();
    src = h.source as Ready;
    expect(src.turns).toEqual([turn("p1"), turn("l0")]);
    expect(src.head).toBe(1);
    src.older!.load();
    await flush();
    src = h.source as Ready;
    expect(src.turns).toEqual([turn("p0"), turn("p1"), turn("l0")]);
    expect(src.older).toBeUndefined();
    expect(src.head).toBe(2);
  });

  it("a live answer replaces only the live window: the pages stay", async () => {
    let live = { ok: true, complete: false, turns: [turn("l0")], version: "v1", older: "c2" };
    const fetchFn = route({ c2: p1 }, () => live);
    const h = setup(on, fetchFn);
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    live = { ...live, turns: [turn("l0"), turn("l1")], version: "v2" };
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    expect((h.source as Ready).turns).toEqual([turn("p1"), turn("l0"), turn("l1")]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("reads the stretch the live window slid past, before and after, and draws it between", async () => {
    let live = { ok: true, complete: false, turns: [turn("l0")], version: "v1", older: "c2" };
    const fetchFn = route({ c2: p1, "c3<c2": { ok: true, complete: true, turns: [turn("g0")] } }, () => live);
    const h = setup(on, fetchFn);
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    live = { ok: true, complete: false, turns: [turn("l1")], version: "v2", older: "c3" };
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    expect(params(fetchFn.mock.calls[3][0]).get("before")).toBe("c3");
    expect(params(fetchFn.mock.calls[3][0]).get("after")).toBe("c2");
    const src = h.source as Ready;
    expect(src.turns).toEqual([turn("p1"), turn("g0"), turn("l1")]);
    expect(src.older).toBeDefined();
    // The pages now end where the live window starts: the next answer needs no stretch.
    live = { ...live, turns: [turn("l1"), turn("l2")], version: "v3" };
    h.view.rerender({ ...on, change: "2:idle" });
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect((h.source as Ready).turns).toEqual([turn("p1"), turn("g0"), turn("l1"), turn("l2")]);
  });

  it("starts over from the live window when the stretch cannot be read (the file was replaced)", async () => {
    let live = { ok: true, complete: false, turns: [turn("l0")], version: "v1", older: "c2" };
    const fetchFn = route({ c2: p1 }, () => live);
    const h = setup(on, fetchFn);
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    live = { ok: true, complete: false, turns: [turn("x0")], version: "w1", older: "d1" };
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    const src = h.source as Ready;
    expect(src.turns).toEqual([turn("x0")]);
    expect(src.older).toBeDefined();
    // And the next page is asked before the new window's cursor.
    src.older!.load();
    await flush();
    expect(params(fetchFn.mock.calls.at(-1)![0]).get("before")).toBe("d1");
  });

  it("starts over when the file now starts with the live window, with no stretch to read", async () => {
    let live: Record<string, unknown> = { ok: true, complete: false, turns: [turn("l0")], version: "v1", older: "c2" };
    const fetchFn = route({ c2: p1 }, () => live);
    const h = setup(on, fetchFn);
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    live = { ok: true, complete: true, turns: [turn("new")], version: "w1" };
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(h.source).toEqual({ state: "ready", turns: [turn("new")] });
  });

  it("keeps a first page that lands after the live window moved on, and reads the stretch between", async () => {
    let release: (r: Response) => void = () => {};
    let live = { ok: true, complete: false, turns: [turn("l0")], version: "v1", older: "c2" };
    const fetchFn = route({
      c2: () => new Promise<Response>(done => { release = done; }),
      "c3<c2": { ok: true, complete: true, turns: [turn("g0")] },
    }, () => live);
    const h = setup(on, fetchFn);
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    live = { ok: true, complete: false, turns: [turn("l1")], version: "v2", older: "c3" };
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    expect((h.source as Ready).turns).toEqual([turn("l1")]);
    release(answer(200, p1));
    await flush();
    expect((h.source as Ready).turns).toEqual([turn("p1"), turn("g0"), turn("l1")]);
  });

  it("says a page could not be read, and pressing again tries again", async () => {
    let n = 0;
    const fetchFn = route({ c2: () => Promise.resolve(++n === 1 ? answer(500) : answer(200, p1)) },
      () => ({ ok: true, complete: false, turns: [turn("l0")], version: "v1", older: "c2" }));
    const h = setup(on, fetchFn);
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    expect((h.source as Ready).older).toMatchObject({ loading: false, failed: true });
    expect((h.source as Ready).turns).toEqual([turn("l0")]);
    (h.source as Ready).older!.load();
    await flush();
    expect((h.source as Ready).turns).toEqual([turn("p1"), turn("l0")]);
    expect((h.source as Ready).older).toMatchObject({ failed: false });
  });

  it("is not left loading when Chat is hidden while a page is read: shown again, a press asks again", async () => {
    let n = 0;
    // The first read never answers: Chat goes away under it.
    const fetchFn = route({ c2: () => (++n === 1 ? new Promise<Response>(() => {}) : Promise.resolve(answer(200, p1))) },
      () => ({ ok: true, complete: false, turns: [turn("l0")], version: "v1", older: "c2" }));
    const h = setup(on, fetchFn);
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    expect((h.source as Ready).older?.loading).toBe(true);
    h.view.rerender({ ...on, shown: false });
    await flush();
    h.view.rerender(on);
    await flush();
    expect((h.source as Ready).older).toMatchObject({ loading: false, failed: false });
    (h.source as Ready).older!.load();
    await flush();
    expect((h.source as Ready).turns).toEqual([turn("p1"), turn("l0")]);
    expect(n).toBe(2);
  });

  it(`keeps at most ${MAX_KEPT_TURNS} turns: at the cap no more are offered, and growth lets the oldest page go`, async () => {
    let live = { ok: true, complete: false, turns: many("l", 200), version: "v1", older: "c2" };
    const fetchFn = route({
      c2: { ok: true, complete: false, turns: many("p1-", 900), older: "c1" },
      c1: { ok: true, complete: false, turns: many("p0-", 900), older: "c0" },
      "c3<c2": { ok: true, complete: true, turns: many("g", 300) },
    }, () => live);
    const h = setup(on, fetchFn);
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    let src = h.source as Ready;
    expect(src.older).toBeUndefined();
    expect(src.turns[0]).toEqual({ kind: "record", text: "Earlier turns are not shown." });
    expect(src.turns).toHaveLength(MAX_KEPT_TURNS + 1);
    live = { ...live, turns: many("m", 200), version: "v2", older: "c3" };
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    src = h.source as Ready;
    expect(src.turns).toHaveLength(900 + 300 + 200);
    expect(src.turns[0]).toEqual(turn("p1-0"));
    expect(src.older).toBeDefined();
    expect(src.head).toBe(900);
  });

  it("keeps the page a press asked for even when it passes the cap, and then offers no more", async () => {
    const fetchFn = route({
      c2: { ok: true, complete: false, turns: many("p1-", 1700), older: "c1" },
      c1: { ok: true, complete: false, turns: many("p0-", 200), older: "c0" },
    }, () => ({ ok: true, complete: false, turns: many("l", 200), version: "v1", older: "c2" }));
    const h = setup(on, fetchFn);
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    (h.source as Ready).older!.load();
    await flush();
    const src = h.source as Ready;
    expect(src.older).toBeUndefined();
    expect(src.turns[1]).toEqual(turn("p0-0"));
    expect(src.turns).toHaveLength(1 + 200 + 1700 + 200);
  });
});

describe("which pane has Chat on offer", () => {
  it("only with the flag effective and a supported session whose id has the route's shape", () => {
    const claude = { sessionId: "0d9c6f3e-1b2a-4c5d-8e7f-aabbccddeeff", provider: "claude" };
    expect(chatSessionFor(true, claude)).toBe(claude.sessionId);
    expect(chatSessionFor(false, claude)).toBeNull();
    expect(chatSessionFor(true, { ...claude, provider: "codex" })).toBe(claude.sessionId);
    expect(chatSessionFor(true, { ...claude, provider: "unsupported" })).toBeNull();
    expect(chatSessionFor(true, null)).toBeNull();
    for (const sessionId of ["", "../x", "a/b", "a.b", "-a", "a".repeat(129)]) expect(chatSessionFor(true, { sessionId, provider: "claude" })).toBeNull();
  });

  it("the stage asks the hook with Chat's own switch only, so a Term pane fetches nothing", () => {
    const stage = readFileSync(new URL("../components/terminal/TerminalStage.tsx", import.meta.url), "utf8");
    expect(stage).toContain('useState<"chat" | "term">("term")');
    expect(stage).toContain('const chatOn = chatSession !== null && view === "chat";');
    expect(stage).toContain("shown: chatOn,");
  });
});

describe("opencode and Copilot, whose conversations the deck does not read", () => {
  const OC = "ses_4b2f9c1a7e3dXk2mQp8R";
  const CP = "9a8b7c6d-1111-4222-8333-444455556666";

  it("have Chat on offer, so it can say so, whatever shape their id has", () => {
    expect(chatSessionFor(true, { sessionId: OC, provider: "opencode" })).toBe(OC);
    expect(chatSessionFor(true, { sessionId: CP, provider: "copilot" })).toBe(CP);
    expect(chatSessionFor(false, { sessionId: OC, provider: "opencode" })).toBeNull();
    expect(chatSessionFor(true, { sessionId: "", provider: "copilot" })).toBeNull();
  });

  it("are never fetched: a Copilot id is a UUID, and the route would look it up as Claude's", async () => {
    const fetchFn = vi.fn(async () => ready());
    expect(await readTranscript(CP, fetchFn as never, undefined, "copilot")).toEqual({ kind: "unknown" });
    expect(await readTranscript(OC, fetchFn as never, undefined, "opencode")).toEqual({ kind: "unknown" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("show the calm line, asked for nothing, however long the pane stays open", async () => {
    for (const [provider, session, name] of [["opencode", OC, "OpenCode"], ["copilot", CP, "GitHub Copilot"]] as const) {
      const fetchFn = vi.fn(async () => ready());
      const h = setup({ ...on, session, provider, working: true, heard: 1 }, fetchFn);
      await flush();
      await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3);
      expect(fetchFn, provider).not.toHaveBeenCalled();
      expect(h.source).toEqual({ state: "absent", message: `ccdeck doesn’t read ${name} conversations, so there is no chat to show here. Its prompts and tool calls are on the board.` });
      h.view.unmount();
    }
  });

  it("leave a Claude session's Chat asking as before", async () => {
    const fetchFn = vi.fn(async () => ready());
    const h = setup({ ...on, provider: "claude" }, fetchFn);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(h.source).toMatchObject({ state: "ready" });
  });
});
