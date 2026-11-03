// What Chat reads (use-session-transcript.ts): asked only while the Chat view
// is on screen, again every five seconds while the session works and the page
// is visible, once more when its prompts or its end change; the answer as
// ChatView draws it, in the language on show.
//
// Run as a hook under the suite's stand-in React (fake-react.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ChatSource } from "../components/chat/chat-model";
import {
  chatSessionFor, POLL_MS, readTranscript, useSessionTranscript, type SessionTranscriptInput,
} from "../use-session-transcript";
import { mount, flush } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const answer = (status: number, body: unknown = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
const ready = (turns: unknown[] = [{ kind: "user", text: "hi" }], complete = true) => answer(200, { ok: true, complete, turns });

function setup(first: SessionTranscriptInput, fetchFn: (url: string) => Promise<Response>, visible = () => true) {
  let source: ChatSource = { state: "loading" };
  const Probe = (input: SessionTranscriptInput) => { source = useSessionTranscript(input, { fetchFn: fetchFn as never, visible }); return null; };
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

  it("asks once when Chat is shown, for that session only, and does not repeat while the session rests", async () => {
    const fetchFn = vi.fn(async () => ready());
    const h = setup(on, fetchFn);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe("/api/session/transcript?session=abc");
    expect(h.source).toMatchObject({ state: "ready", turns: [{ kind: "user", text: "hi" }] });
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // CHANGED ON PURPOSE: this used to expect no fetch once the session stopped
  // working. The final reply and the question a session waits on land just as the
  // status turns from working, after the last timed ask, so a status change is
  // one more ask, and only then does the timer rest.
  it("asks again every 5 s while the session is working, once more when its status changes, and then rests", async () => {
    const fetchFn = vi.fn(async () => ready());
    const h = setup({ ...on, working: true, change: "1:working" }, fetchFn);
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    h.view.rerender({ ...on, working: false, change: "1:idle" });
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(fetchFn).toHaveBeenCalledTimes(4);
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

describe("which pane has Chat on offer", () => {
  it("only with the flag effective and a Claude session whose id has the route's shape", () => {
    const claude = { sessionId: "0d9c6f3e-1b2a-4c5d-8e7f-aabbccddeeff", provider: "claude" };
    expect(chatSessionFor(true, claude)).toBe(claude.sessionId);
    expect(chatSessionFor(false, claude)).toBeNull();
    expect(chatSessionFor(true, { ...claude, provider: "codex" })).toBeNull();
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
