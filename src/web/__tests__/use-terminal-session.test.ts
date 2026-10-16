// The stage's terminal session, driven through a fake WebSocket, a fake xterm
// and a fake deck API.
//
// The real protocol code (terminal-protocol.ts) sits between the fake socket
// and the controller, so each case plays the deck's frames exactly as the
// socket would carry them and reads back what the terminal was told to do and
// what went up the wire. The fake terminal keeps xterm's one ordering promise
// — a write's callback runs after everything queued before it is parsed, and
// before anything queued after it — and nothing more, so a case cannot pass by
// leaning on behaviour the real terminal lacks.
//
// The hook itself is a thin wrapper; its own cases at the end run it under
// fake-react and check only that it starts, switches and disposes the
// controller with the component.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("react", async () => (await import("./fake-react")).react);

import { mount as mountComponent, flush } from "./fake-react";
import { MAX_MESSAGE_BYTES, connectTerminal } from "../terminal-protocol";
import type { ApiFailure, NotAttachable, SessionRef, TerminalStatus, Ticketed, Launched } from "../terminal-api";
import {
  CTRL_V,
  PASTE_TOO_LARGE,
  RECONNECT_DELAYS_MS,
  RECONNECT_GIVE_UP_MS,
  RESIZE_SETTLE_MS,
  STREAM_QUIET_MS,
  TMUX_SETUP_GIVE_UP_MS,
  TMUX_SETUP_POLL_MS,
  createTerminalSession,
  pasteHoldsImage,
  showCursorFromTheStart,
  subjectKey,
  useTerminalSession,
  type SessionDeps,
  type SessionSnapshot,
  type StageTerminal,
  type StageTerminalEvents,
  type StageSubject,
  type LaunchedSession,
  type UseTerminalSessionOptions,
} from "../use-terminal-session";
import type { TerminalKey } from "../terminal-keys";

// ---------------------------------------------------------------------------
// The fakes.

/** A WebSocket the case drives (the SocketLike surface, nothing more). */
class FakeSocket {
  binaryType = "blob";
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  closedWith: Array<number | undefined> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | Uint8Array) {
    if (this.readyState !== 1) throw new Error(`send() while readyState is ${this.readyState}`);
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data));
  }
  close(code?: number) { this.closedWith.push(code); this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.({}); }
  text(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  binary(bytes: Uint8Array) { this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  drop(code = 1006) { this.onerror?.({}); this.readyState = 3; this.onclose?.({ code }); }
  sentText() { return this.sent.filter((f): f is string => typeof f === "string").map(f => JSON.parse(f)); }
  sentBytes() { return this.sent.filter((f): f is Uint8Array => typeof f !== "string").map(b => new TextDecoder().decode(b)); }
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (d: Uint8Array | string) => (typeof d === "string" ? d : new TextDecoder().decode(d));

/** A terminal that records what it was told, in order, and parses only when
 *  the case says so — which is how a case sees what happens before reveal. */
class FakeTerminal implements StageTerminal {
  cols: number;
  rows: number;
  log: string[] = [];
  queue: Array<{ data: string; done?: () => void }> = [];
  theme: unknown = null;
  disposed = false;
  constructor(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  write(data: Uint8Array | string, done?: () => void) { this.queue.push({ data: dec(data), done }); }
  /** Parse everything queued, in order, running each write's callback after
   *  its own bytes — the promise xterm's write queue makes. */
  parse() {
    while (this.queue.length) {
      const { data, done } = this.queue.shift()!;
      if (data) this.log.push(`write ${JSON.stringify(data)}`);
      done?.();
    }
  }
  reset() { this.log.push("reset"); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; this.log.push(`resize ${cols}x${rows}`); }
  setTheme(theme: unknown) { this.theme = theme; }
  versions: unknown[] = [];
  tmuxVersion(v: unknown) { this.versions.push(v); }
  focus() { this.log.push("focus"); }
  blur() { this.log.push("blur"); }
  cell() { return { w: 8, h: 18 }; }
  dispose() { this.disposed = true; }
}

const REF: SessionRef = { sessionId: "6f1c2d3e-0000-4000-8000-000000000001", provider: "claude", cwd: "/home/u/code/paycore" };
const OTHER: SessionRef = { sessionId: "6f1c2d3e-0000-4000-8000-000000000002", provider: "claude", cwd: "/home/u/personal/ccdeck" };
const ticketed = (ticket: string): Ticketed => ({ ok: true, ticket, target: { kind: "A", label: "attaches directly" } });
const failure = (status: number | null, error = "The deck did not answer."): ApiFailure => ({ ok: false, status, error });

interface Rig {
  deps: SessionDeps;
  sockets: FakeSocket[];
  terminal: () => FakeTerminal;
  events: () => StageTerminalEvents;
  mounts: number;
  clock: { now: number };
  open: ReturnType<typeof vi.fn>;
  adopt: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  snaps: SessionSnapshot[];
  last: () => SessionSnapshot;
  cells: unknown[];
  launched: LaunchedSession[];
  notices: string[];
  resolveMount: () => void;
}

/** A controller wired to the fakes. `lazyMount` keeps xterm "loading" until
 *  the case resolves it, the way the dynamic import does in a browser. */
function rig({ lazyMount = false } = {}) {
  const sockets: FakeSocket[] = [];
  let term: FakeTerminal | null = null;
  let events: StageTerminalEvents | null = null;
  let resolveMount = () => {};
  const clock = { now: 1_000_000 };
  const r = {
    sockets, clock, mounts: 0, snaps: [] as SessionSnapshot[], cells: [] as unknown[],
    launched: [] as LaunchedSession[], notices: [] as string[],
    open: vi.fn(async (_ref: SessionRef) => ticketed(`t${sockets.length + 1}`) as Ticketed | NotAttachable | ApiFailure),
    adopt: vi.fn(async (_ref: SessionRef) => ticketed("adopted") as Ticketed | ApiFailure),
    launch: vi.fn(async (_a: { agent: string; cwd: string }) =>
      ({ ok: true, sessionId: OTHER.sessionId, name: "ccdeck-claude-1a2b3c4d", ticket: "launched" }) as Launched | ApiFailure),
    status: vi.fn(async () => ({ ok: true, platform: "linux", tmux: { ok: true } }) as TerminalStatus | ApiFailure),
  } as unknown as Rig;
  r.terminal = () => { if (!term) throw new Error("no terminal yet"); return term; };
  r.events = () => { if (!events) throw new Error("not mounted"); return events; };
  r.last = () => r.snaps[r.snaps.length - 1];
  r.resolveMount = () => resolveMount();
  r.deps = {
    api: { status: r.status, open: r.open, adopt: r.adopt, launch: r.launch } as unknown as SessionDeps["api"],
    connect: options => connectTerminal({
      ...options,
      base: "http://127.0.0.1:4317/",
      createSocket: url => { const s = new FakeSocket(url); sockets.push(s); return s; },
    }),
    mount: (_host, init, ev) => {
      r.mounts += 1;
      events = ev;
      const made = new FakeTerminal(init.cols, init.rows);
      if (!lazyMount) { term = made; return Promise.resolve(made); }
      return new Promise<StageTerminal>(res => { resolveMount = () => { term = made; res(made); }; });
    },
    now: () => clock.now,
  };
  const ctl = createTerminalSession(r.deps, {
    onChange: s => r.snaps.push(s),
    onCell: c => r.cells.push(c),
    onLaunched: l => r.launched.push(l),
    onNotice: n => r.notices.push(n),
  });
  return { r, ctl };
}

const HOST = {} as HTMLElement;
const THEME = { background: "#14161b" };
const key = (over: Partial<TerminalKey>): TerminalKey =>
  ({ type: "keydown", key: "a", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over });

/** Show `ref` and play the deck through to a seeded, revealed pane. */
async function attach(r: Rig, ctl: ReturnType<typeof rig>["ctl"], ref = REF, seed = "SEED") {
  ctl.show({ kind: "session", ref });
  await flush();
  const s = r.sockets[r.sockets.length - 1];
  s.open();
  s.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
  s.text({ t: "reset", cols: 120, rows: 40 });
  s.binary(enc(seed));
  r.terminal().parse();
  return s;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------

describe("opening a session: write before reveal", () => {
  it("asks for a ticket, sends its size first, and reveals the pane only once the seed is parsed", async () => {
    const { r, ctl } = rig();
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "session", ref: REF });
    expect(r.last().phase).toEqual({ kind: "attaching", reconnect: false });
    await flush();
    expect(r.open).toHaveBeenCalledWith(REF);
    const s = r.sockets[0];
    expect(s.url).toBe("ws://127.0.0.1:4317/api/terminal/attach?ticket=t1");
    s.open();
    expect(s.sentText()[0], "the first frame is the size, which starts the stream").toEqual({ t: "size", cols: 120, rows: 40 });

    s.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    s.text({ t: "reset", cols: 120, rows: 40 });
    s.binary(enc("\x1b[?1049hSEED"));
    expect(r.last().phase.kind, "nothing is revealed before the seed is parsed").toBe("attaching");
    r.terminal().parse();
    expect(r.terminal().log).toEqual(["reset", 'write "\\u001b[?1049hSEED"']);
    expect(r.last().phase).toEqual({ kind: "live", sizeOwner: "dock", readOnly: false });
    expect(r.cells, "the cell is measured once the pane has drawn").toEqual([{ w: 8, h: 18 }]);
  });

  it("writes the output that follows the seed after it, in the order it arrived", async () => {
    const { r, ctl } = rig();
    ctl.resize(100, 30, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "session", ref: REF });
    await flush();
    const s = r.sockets[0];
    s.open();
    s.text({ t: "reset", cols: 100, rows: 30 });
    s.binary(enc("SEED"));
    s.binary(enc("one"));
    s.binary(enc("two"));
    r.terminal().parse();
    expect(r.terminal().log).toEqual(["reset", 'write "SEED"', 'write "one"', 'write "two"']);
  });

  it("applies a size asked for while the seed was on its way the moment the pane is revealed", async () => {
    // The first size seeds the pane; a later one only resizes it, and the TUI
    // redraws at the new size. A divider that moved during the attach must not
    // leave the terminal drawing that redraw at the size it was seeded at.
    const { r, ctl } = rig();
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "session", ref: REF });
    await flush();
    const s = r.sockets[0];
    s.open();
    ctl.resize(100, 40, false);
    await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS);
    s.text({ t: "reset", cols: 120, rows: 40 });
    s.binary(enc("SEED"));
    s.binary(enc("redrawn at 100"));
    r.terminal().parse();
    expect(r.terminal().log).toEqual(["reset", 'write "SEED"', "resize 100x40", 'write "redrawn at 100"']);
    expect(s.sentText().filter(m => m.t === "size").at(-1)).toEqual({ t: "size", cols: 100, rows: 40 });
  });

  it("holds everything the deck sent until xterm has loaded, then replays it in order", async () => {
    const { r, ctl } = rig({ lazyMount: true });
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    const s = r.sockets[0];
    s.open();
    s.text({ t: "reset", cols: 120, rows: 40 });
    s.binary(enc("SEED"));
    s.binary(enc("after"));
    expect(() => r.terminal(), "xterm is still on its way").toThrow();
    r.resolveMount();
    await flush();
    r.terminal().parse();
    expect(r.terminal().log).toEqual(["reset", 'write "SEED"', 'write "after"']);
    expect(r.last().phase.kind).toBe("live");
  });

  it("is a state card, not an error, when the session has no pane to attach to", async () => {
    const { r, ctl } = rig();
    const target = { kind: "C" as const, label: "This session was started outside the deck…", adoptable: true };
    r.open.mockResolvedValueOnce({ ok: false, target });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.last().phase).toEqual({ kind: "not-attachable", target, stillRunning: false, busy: false });
    expect(r.sockets, "no socket for a session that has no pane").toHaveLength(0);
  });

  it("says tmux is missing as a fact, with its install line, and keeps saying it while it checks again", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValue({ ok: false, target: { kind: "unsupported", label: "The terminal runs on tmux…", reason: "missing" } });
    r.status.mockResolvedValue({ ok: true, platform: "linux", tmux: { ok: false, reason: "missing", install: "sudo apt install tmux" } });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.last().phase).toEqual({ kind: "tmux-missing", reason: "missing", install: "sudo apt install tmux", busy: false });
    ctl.retry();
    expect(r.last().phase, "Check again keeps the fact up").toMatchObject({ kind: "tmux-missing", busy: true });
    await flush();
    expect(r.last().phase).toMatchObject({ kind: "tmux-missing", busy: false });
    expect(r.open).toHaveBeenCalledTimes(2);
  });

  it("draws a refusal as a sentence the deck wrote", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValueOnce(failure(404, "The terminal is not switched on for this deck."));
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.last().phase).toEqual({ kind: "error", message: "The terminal is not switched on for this deck." });
  });
});

describe("switching sessions on the one terminal", () => {
  it("resets and seeds the same terminal for the next session, and drops the last one's socket", async () => {
    const { r, ctl } = rig();
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const first = await attach(r, ctl, REF, "A");
    ctl.show({ kind: "session", ref: OTHER });
    expect(first.closedWith, "the old view leaves; its tmux session keeps running").toEqual([1000]);
    expect(r.last().phase).toEqual({ kind: "attaching", reconnect: false });
    first.binary(enc("late output from A"));
    await flush();
    const second = r.sockets[1];
    second.open();
    second.text({ t: "reset", cols: 120, rows: 40 });
    second.binary(enc("B"));
    r.terminal().parse();
    expect(r.mounts, "one terminal for the stage's whole life").toBe(1);
    expect(r.terminal().log).toEqual(["reset", 'write "A"', "reset", 'write "B"']);
    expect(r.last().phase.kind).toBe("live");
  });

  it("treats the same subject handed again as no switch at all", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    await attach(r, ctl);
    ctl.show({ kind: "session", ref: { ...REF } });
    await flush();
    expect(r.open).toHaveBeenCalledTimes(1);
    expect(subjectKey({ kind: "session", ref: REF })).toBe(subjectKey({ kind: "session", ref: { ...REF, cwd: "/elsewhere" } }));
  });

  it("goes quiet for the empty stage", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    ctl.show({ kind: "empty" });
    expect(s.closedWith).toEqual([1000]);
    expect(r.last().phase).toEqual({ kind: "empty" });
  });
});

describe("a deck restart under a live pane (scenario S3)", () => {
  it("keeps the frame, reconnects with a fresh ticket, and backs off while the deck is down", async () => {
    const { r, ctl } = rig();
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    s.text({ t: "exit", reason: "server-shutdown" });
    expect(r.last().phase, "the frozen frame stays up").toEqual({ kind: "attaching", reconnect: true });
    expect(r.terminal().log.filter(l => l === "reset"), "nothing is cleared yet").toHaveLength(1);

    r.open.mockResolvedValueOnce(failure(null));
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(r.open).toHaveBeenCalledTimes(2);
    expect(r.last().phase).toEqual({ kind: "attaching", reconnect: true });

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1] - 1);
    expect(r.open, "the second wait is longer").toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.open).toHaveBeenCalledTimes(3);
    const back = r.sockets[1];
    expect(back.url, "a fresh ticket, never the spent one").toMatch(/ticket=t2$/);
    back.open();
    back.text({ t: "reset", cols: 120, rows: 40 });
    back.binary(enc("AGAIN"));
    r.terminal().parse();
    expect(r.last().phase.kind).toBe("live");
  });

  it("treats a socket that simply drops the same way", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    s.drop();
    expect(r.last().phase).toEqual({ kind: "attaching", reconnect: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(r.open).toHaveBeenCalledTimes(2);
  });

  it("gives up with a sentence once the deck has been gone for two minutes", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    r.open.mockResolvedValue(failure(null));
    s.text({ t: "exit", reason: "server-shutdown" });
    for (let i = 0; i < 40 && r.last().phase.kind === "attaching"; i++) {
      r.clock.now += 5000;
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(r.clock.now - 1_000_000).toBeGreaterThan(RECONNECT_GIVE_UP_MS);
    expect(r.last().phase.kind).toBe("error");
    expect((r.last().phase as { message: string }).message).toMatch(/still running in tmux/);
  });
});

describe("how a session ends", () => {
  it("freezes the last frame when the session itself ends, and reopens it here on request", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    s.text({ t: "exit", reason: "ended" });
    expect(r.last().phase).toEqual({ kind: "ended" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.open, "an ended session is not reconnected to").toHaveBeenCalledTimes(1);
    ctl.adopt();
    await flush();
    expect(r.adopt).toHaveBeenCalledWith(REF, {}, { cols: 80, rows: 24 });
    expect(r.sockets[1].url).toMatch(/ticket=adopted$/);
  });

  it("does not say 'just now' for a pane the deck says had already ended when it attached", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    expect(r.last().phase.kind).toBe("live");
    s.text({ t: "exit", reason: "ended", atOpen: true });
    expect(r.last().phase).toEqual({ kind: "ended", atOpen: true });
  });

  it("refuses a second Reopen here while the first is still asking — the button stays enabled (#620)", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValueOnce({ ok: false, target: { kind: "C", label: "started outside the deck", adoptable: true } });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    ctl.adopt();
    ctl.adopt();
    await flush();
    expect(r.adopt).toHaveBeenCalledTimes(1);
  });

  it("keeps an ending that arrives before the seed is parsed, rather than revealing the pane over it, and knows it did not see it end", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "session", ref: REF });
    await flush();
    const s = r.sockets[0];
    s.open();
    s.text({ t: "reset", cols: 120, rows: 40 });
    s.binary(enc("LAST FRAME"));
    s.text({ t: "exit", reason: "ended" });
    r.terminal().parse();
    expect(r.last().phase).toEqual({ kind: "ended", atOpen: true });
    expect(r.terminal().log, "the frame is still drawn, frozen").toContain('write "LAST FRAME"');
  });

  it("says someone else took the pane, and leaves it at that", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    s.text({ t: "exit", reason: "detached" });
    expect(r.last().phase).toEqual({ kind: "detached" });
  });

  it("answers adopt's 409 in place, and checks again when asked", async () => {
    const { r, ctl } = rig();
    const target = { kind: "C" as const, label: "started outside the deck", adoptable: true };
    r.open.mockResolvedValueOnce({ ok: false, target });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    r.adopt.mockResolvedValueOnce(failure(409, "still-running"));
    ctl.adopt();
    expect(r.last().phase).toMatchObject({ kind: "not-attachable", busy: true });
    await flush();
    expect(r.last().phase).toEqual({ kind: "not-attachable", target, stillRunning: true, busy: false });
    ctl.adopt();
    await flush();
    expect(r.adopt).toHaveBeenCalledTimes(2);
    expect(r.sockets[0].url).toMatch(/ticket=adopted$/);
  });
});

describe("keys, paste and the pane's size", () => {
  async function liveRig() {
    const { r, ctl } = rig();
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    return { r, ctl, s };
  }

  it("sends typed input as bytes and a paste whole, so the pane sees one bracketed paste", async () => {
    const { r, s } = await liveRig();
    r.events().onInput("ls -la\r");
    r.events().onPaste("line one\nline two");
    expect(s.sentBytes()).toEqual(["ls -la\r"]);
    expect(s.sentText().at(-1)).toEqual({ t: "paste", text: "line one\nline two" });
  });

  it("knows a pasted screenshot from pasted text, files that are not images, and nothing at all", () => {
    const items = (...list: Array<{ kind: string; type: string }>) => ({ items: Object.assign(list, { length: list.length }) as unknown as DataTransferItemList });
    expect(pasteHoldsImage(items({ kind: "file", type: "image/png" }))).toBe(true);
    expect(pasteHoldsImage(items({ kind: "string", type: "text/plain" }))).toBe(false);
    expect(pasteHoldsImage(items({ kind: "file", type: "application/pdf" }))).toBe(false);
    expect(pasteHoldsImage(null)).toBe(false);
    expect(CTRL_V).toBe("\x16");
  });

  it("hands the program Ctrl+V for a screenshot pasted with no text, as a terminal would", () => {
    // mountXterm's paste listener (source-pinned: it needs a real xterm): no
    // text and an image means the key itself, so the program reads the image.
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../use-terminal-session.ts"), "utf8");
    const paste = src.slice(src.indexOf("const onPaste = (e: ClipboardEvent) => {"), src.indexOf('host.addEventListener("paste", onPaste, true);'));
    expect(paste).toMatch(/if \(!text\) \{[\s\S]*if \(pasteHoldsImage\(e\.clipboardData\)\) \{[\s\S]*events\.onInput\(CTRL_V\);/);
  });

  it("says a paste is too big to send, rather than losing it without a word", async () => {
    const { r, s } = await liveRig();
    const before = s.sentText().length;
    r.events().onPaste("x".repeat(MAX_MESSAGE_BYTES));
    expect(s.sentText().length, "nothing went out").toBe(before);
    expect(r.notices).toEqual([PASTE_TOO_LARGE]);
    r.events().onPaste("small");
    expect(r.notices, "an ordinary paste says nothing").toHaveLength(1);
  });

  it("sends Shift+Enter as ESC CR, once, and keeps it from the pane's own Enter", async () => {
    const { r, s } = await liveRig();
    expect(r.events().onKey(key({ key: "Enter", shiftKey: true }))).toBe(false);
    expect(r.events().onKey(key({ type: "keypress", key: "Enter", shiftKey: true }))).toBe(false);
    expect(s.sentBytes()).toEqual(["\x1b\r"]);
  });

  it("keeps Ctrl+Shift+C from the session (the pane copies it), and sends ESC + letter for a Mac's Option chords", async () => {
    const { r, s } = await liveRig();
    expect(r.events().onKey(key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(s.sentBytes(), "copying types nothing").toEqual([]);
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    try {
      expect(r.events().onKey(key({ key: "π", code: "KeyP", altKey: true }))).toBe(false);
      expect(r.events().onKey(key({ type: "keypress", key: "π", code: "KeyP", altKey: true })), "once, on the keydown").toBe(false);
      expect(s.sentBytes()).toEqual(["\x1bp"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wires xterm the way the pane needs: tmux's widths and replies, Ctrl/Cmd links, Option-drag, a paste brings the view down", () => {
    // mountXterm runs only in a browser; what it sets up is pinned here as
    // source, and was measured in headless Chrome against tmux 3.8 (see the
    // header comments it carries and terminal-replies.ts).
    const src = readFileSync(fileURLToPath(new URL("../use-terminal-session.ts", import.meta.url)), "utf8");
    const mount = src.slice(src.indexOf("export const mountXterm"), src.indexOf("// The controller."));
    expect(mount).toContain("new UnicodeGraphemesAddon()");
    expect(mount, "Unicode 11 widths split 👍🏽 and 👨‍👩‍👧 where tmux and Claude Code do not").not.toMatch(/Unicode11Addon|activeVersion = "11"/);
    expect(mount).toMatch(/leaveRepliesToTmux\(term\.parser\)/);
    expect(mount).toMatch(/linkHandler: \{ activate: follow, allowNonHttpProtocols: false \}/);
    expect(mount).toContain("new WebLinksAddon(follow)");
    expect(mount).toContain("macOptionClickForcesSelection: true");
    expect(mount).toMatch(/term\.scrollToBottom\(\);\s*events\.onPaste\(text\)/);
    expect(mount).toMatch(/replies\.dispose\(\)/);
  });

  it("keeps the release chord from the pane without acting on it, and lets Escape through to the TUI", async () => {
    // The release itself is the deck's window listener's (terminal-keys.ts):
    // answering it here too would release twice.
    const { r, s } = await liveRig();
    r.events().onFocusChange(true);
    expect(r.last().keysOwner).toBe("pane");
    expect(r.events().onKey(key({ key: "X", code: "KeyX", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(s.sentBytes(), "nothing of the chord reaches the session").toEqual([]);
    expect(r.terminal().log).not.toContain("blur");
    r.events().onFocusChange(false);
    expect(r.last().keysOwner, "the owner follows the textarea's focus").toBe("board");
    expect(r.events().onKey(key({ key: "Escape" })), "Escape always belongs to the session").toBe(true);
    expect(r.events().onKey(key({ key: "x", ctrlKey: true })), "plain Ctrl+X too").toBe(true);
  });

  it("resizes the pane once, 120ms after the divider settles, never while it is held", async () => {
    const { r, ctl, s } = await liveRig();
    const sizes = () => s.sentText().filter(m => m.t === "size");
    expect(sizes()).toHaveLength(1);
    ctl.resize(100, 40, true);
    ctl.resize(104, 40, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sizes(), "nothing while the divider is held").toHaveLength(1);
    ctl.resize(100, 40, false);
    await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS - 1);
    expect(sizes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sizes().at(-1)).toEqual({ t: "size", cols: 100, rows: 40 });
    expect(r.terminal().log.at(-1)).toBe("resize 100x40");
    ctl.resize(101, 40, false);
    ctl.resize(102, 40, false);
    await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS);
    expect(sizes(), "a burst of changes is one resize").toHaveLength(3);
  });

  it("follows a pane that owns its size (case B), and never resizes it", async () => {
    const { r, ctl } = rig();
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "session", ref: REF });
    await flush();
    const s = r.sockets[0];
    s.open();
    s.text({ t: "hello", kind: "B", sizeOwner: "pane", readOnly: false });
    s.text({ t: "reset", cols: 90, rows: 30 });
    s.binary(enc("S"));
    s.text({ t: "size", cols: 96, rows: 30 });
    r.terminal().parse();
    expect(r.terminal().log).toEqual(["reset", "resize 90x30", 'write "S"', "resize 96x30"]);
    expect(r.last().phase).toEqual({ kind: "live", sizeOwner: "pane", readOnly: false });
    ctl.resize(100, 40, false);
    await vi.advanceTimersByTimeAsync(RESIZE_SETTLE_MS);
    expect(s.sentText().filter(m => m.t === "size"), "only the first, which starts the stream").toHaveLength(1);
  });

  it("lights the spine while output streams, and lets it go out when the output stops", async () => {
    const { r, s } = await liveRig();
    s.binary(enc("tick"));
    expect(r.last().streaming).toBe(true);
    await vi.advanceTimersByTimeAsync(STREAM_QUIET_MS);
    expect(r.last().streaming).toBe(false);
  });

  it("sends nothing from a pane that is not live", async () => {
    const { r, s } = await liveRig();
    s.text({ t: "exit", reason: "ended" });
    r.events().onInput("x");
    r.events().onPaste("y");
    expect(s.sentBytes()).toEqual([]);
  });
});

describe("the theme's colours, for tmux to answer a program's colour question with", () => {
  const DARK = { background: "#14161b", foreground: "#e6e6e6" };
  const LIGHT = { background: "rgb(250, 250, 248)", foreground: "#1F2328" };

  it("go up with the first size, again when the theme changes, and never twice the same", async () => {
    const { r, ctl } = rig();
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: DARK, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    expect(s.sentText().slice(0, 2)).toEqual([
      { t: "size", cols: 120, rows: 40 },
      { t: "colours", fg: "#e6e6e6", bg: "#14161b" },
    ]);
    ctl.setTheme(LIGHT);
    expect(s.sentText().at(-1), "normalised to #rrggbb").toEqual({ t: "colours", fg: "#1f2328", bg: "#fafaf8" });
    const sent = s.sentText().length;
    ctl.setTheme({ ...LIGHT, cursor: "#ff0000" });
    expect(s.sentText(), "the same two colours send nothing").toHaveLength(sent);
  });

  it("go up again on a new connection, with the theme as it is by then", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: DARK, fontFamily: "monospace" });
    await flush();
    ctl.setTheme(LIGHT);
    await attach(r, ctl);
    await attach(r, ctl, OTHER);
    expect(r.sockets[1].sentText().filter(m => m.t === "colours")).toEqual([{ t: "colours", fg: "#1f2328", bg: "#fafaf8" }]);
  });
});

describe("the tmux the pane lives in, for the questions xterm leaves to it", () => {
  it("is unknown on every new connection until the deck says, then the deck's, in the order of the bytes", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "session", ref: REF });
    await flush();
    const s = r.sockets[0];
    s.open();
    s.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    s.text({ t: "tmux", version: "3.4" });
    s.text({ t: "reset", cols: 120, rows: 40 });
    s.binary(enc("SEED"));
    expect(r.terminal().versions, "applied as xterm parses up to it, not before").toEqual([]);
    r.terminal().parse();
    expect(r.terminal().versions).toEqual([null, [3, 4]]);

    // Another session — maybe the user's own tmux — starts unknown again.
    ctl.show({ kind: "session", ref: OTHER });
    await flush();
    const t = r.sockets[1];
    t.open();
    t.text({ t: "hello", kind: "B", sizeOwner: "pane", readOnly: false });
    r.terminal().parse();
    expect(r.terminal().versions.at(-1)).toBeNull();
    t.text({ t: "tmux", version: "3.8" });
    s.text({ t: "tmux", version: "3.2" });
    r.terminal().parse();
    expect(r.terminal().versions.at(-1), "and never from a socket that is no longer the one speaking").toEqual([3, 8]);
  });
});

describe("a new session started from the stage", () => {
  it("starts it at the stage's own size, with the options New session chose", async () => {
    const { r, ctl } = rig();
    ctl.resize(132, 41, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "launch", agent: "claude", cwd: "/w", key: "n9", options: { model: "haiku", permissionMode: "plan" } });
    await flush();
    expect(r.launch).toHaveBeenCalledWith({ agent: "claude", cwd: "/w", size: { cols: 132, rows: 41 }, launch: { model: "haiku", permissionMode: "plan" } });
  });

  it("says starting, reports the launched session, and attaches with the launch's own ticket", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "launch", agent: "claude", cwd: "/home/u/personal/ccdeck", key: "n1" });
    expect(r.last().phase).toEqual({ kind: "starting", agent: "claude", cwd: "/home/u/personal/ccdeck" });
    await flush();
    expect(r.launch, "at the size the pane will show it at").toHaveBeenCalledWith({ agent: "claude", cwd: "/home/u/personal/ccdeck", size: { cols: 80, rows: 24 } });
    expect(r.launched).toEqual([{ agent: "claude", cwd: "/home/u/personal/ccdeck", sessionId: OTHER.sessionId, name: "ccdeck-claude-1a2b3c4d" }]);
    expect(r.sockets[0].url).toMatch(/ticket=launched$/);
  });

  it("keeps the connection when the board's session for the launch takes over as the subject", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "launch", agent: "claude", cwd: OTHER.cwd, key: "n1" });
    await flush();
    ctl.show({ kind: "session", ref: OTHER });
    await flush();
    expect(r.sockets[0].closedWith, "the same view, now named after its session").toEqual([]);
    expect(r.open).not.toHaveBeenCalled();
  });

  it("says tmux is missing when the launch is refused for want of it", async () => {
    const { r, ctl } = rig();
    r.launch.mockResolvedValueOnce(failure(409, "The terminal runs on tmux, which is not installed on this machine."));
    r.status.mockResolvedValueOnce({ ok: true, platform: "darwin", tmux: { ok: false, reason: "missing", install: "brew install tmux" } });
    ctl.show({ kind: "launch", agent: "codex", cwd: "/w", key: "n2" });
    await flush();
    expect(r.last().phase).toEqual({ kind: "tmux-missing", reason: "missing", install: "brew install tmux", busy: false });
  });
});

describe("while the deck sets up its own tmux", () => {
  const INSTALLING = { ok: true, platform: "linux", tmux: { ok: false, reason: "installing" } } as TerminalStatus;
  const READY = { ok: true, platform: "linux", tmux: { ok: true } } as TerminalStatus;
  const refused = () => failure(409, "The terminal runs on tmux, which is not installed on this machine.");

  it("says so, asks again until it lands, then starts the session it was asked for", async () => {
    const { r, ctl } = rig();
    r.launch.mockResolvedValueOnce(refused());
    r.status.mockResolvedValueOnce(INSTALLING).mockResolvedValueOnce(INSTALLING).mockResolvedValueOnce(READY);
    ctl.show({ kind: "launch", agent: "claude", cwd: "/w", key: "n3" });
    await flush();
    expect(r.last().phase).toEqual({ kind: "tmux-installing" });
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    expect(r.last().phase, "still setting up").toEqual({ kind: "tmux-installing" });
    expect(r.launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    await flush();
    expect(r.status).toHaveBeenCalledTimes(3);
    expect(r.launch, "asked once more, now that tmux is there").toHaveBeenCalledTimes(2);
    expect(r.launch.mock.calls[1][0]).toEqual({ agent: "claude", cwd: "/w", size: { cols: 80, rows: 24 } });
    expect(r.sockets).toHaveLength(1);
  });

  it("reopens a board session the same way", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValueOnce({ ok: false, target: { kind: "unsupported", label: "The terminal runs on tmux…", reason: "missing" } });
    r.status.mockResolvedValueOnce(INSTALLING).mockResolvedValueOnce(READY);
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.last().phase).toEqual({ kind: "tmux-installing" });
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    await flush();
    expect(r.open).toHaveBeenCalledTimes(2);
    expect(r.sockets).toHaveLength(1);
  });

  it("falls back to the install line, saying why, when the download fails", async () => {
    const { r, ctl } = rig();
    r.launch.mockResolvedValueOnce(refused());
    r.status.mockResolvedValueOnce(INSTALLING).mockResolvedValueOnce({
      ok: true, platform: "linux", tmux: { ok: false, reason: "missing", install: "sudo apt install tmux", download: "download_failed" },
    });
    ctl.show({ kind: "launch", agent: "claude", cwd: "/w", key: "n4" });
    await flush();
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    expect(r.last().phase).toEqual({
      kind: "tmux-missing", reason: "missing", install: "sudo apt install tmux", download: "download_failed", busy: false,
    });
  });

  it("keeps waiting through a deck that blinks, and gives up in a sentence after a few minutes", async () => {
    const { r, ctl } = rig();
    r.launch.mockResolvedValueOnce(refused());
    r.status.mockResolvedValueOnce(INSTALLING).mockResolvedValueOnce(failure(null)).mockResolvedValue(INSTALLING);
    ctl.show({ kind: "launch", agent: "claude", cwd: "/w", key: "n5" });
    await flush();
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    expect(r.last().phase, "no answer is not a verdict").toEqual({ kind: "tmux-installing" });
    r.clock.now += TMUX_SETUP_GIVE_UP_MS + 1;
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    expect(r.last().phase).toEqual({ kind: "error", message: "The deck is still setting up tmux. Try again in a minute." });
    const asked = r.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS * 4);
    expect(r.status.mock.calls.length, "and stops asking").toBe(asked);
  });

  it("stops asking once the stage shows something else", async () => {
    const { r, ctl } = rig();
    r.launch.mockResolvedValueOnce(refused());
    r.status.mockResolvedValue(INSTALLING);
    ctl.show({ kind: "launch", agent: "claude", cwd: "/w", key: "n6" });
    await flush();
    ctl.show({ kind: "empty" });
    const asked = r.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS * 3);
    expect(r.status.mock.calls.length).toBe(asked);
    expect(r.last().phase).toEqual({ kind: "empty" });
  });
});

describe("the controller's own life", () => {
  it("closes the socket and the terminal on dispose, and ignores answers that come back after", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    const count = r.snaps.length;
    ctl.dispose();
    expect(s.closedWith).toEqual([1000]);
    expect(r.terminal().disposed).toBe(true);
    s.binary(enc("late"));
    ctl.show({ kind: "session", ref: OTHER });
    await flush();
    expect(r.snaps.length, "nothing is drawn after dispose").toBe(count);
  });

  it("hands a theme to the terminal whenever the palette changes, even before it has loaded", async () => {
    const { r, ctl } = rig({ lazyMount: true });
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    ctl.setTheme({ background: "#ffffff" });
    r.resolveMount();
    await flush();
    expect(r.terminal().theme).toEqual({ background: "#ffffff" });
  });
});

// ---------------------------------------------------------------------------

describe("the hook", () => {
  function hookRig() {
    const { r } = rig();
    const seen: Array<ReturnType<typeof useTerminalSession>> = [];
    const Probe = (o: UseTerminalSessionOptions) => { seen.push(useTerminalSession(o)); return null; };
    const props = (subject: StageSubject): UseTerminalSessionOptions =>
      ({ subject, cols: 120, rows: 40, theme: THEME, fontFamily: "monospace", deps: r.deps });
    return { r, seen, Probe, props };
  }

  it("opens the subject it is given, switches when it changes, and leaves when the stage unmounts", async () => {
    const { r, seen, Probe, props } = hookRig();
    const m = mountComponent(Probe, props({ kind: "session", ref: REF }));
    await flush();
    expect(r.open).toHaveBeenCalledWith(REF);
    expect(seen.at(-1)!.phase).toEqual({ kind: "attaching", reconnect: false });
    r.sockets[0].open();
    m.rerender(props({ kind: "session", ref: OTHER }));
    await flush();
    expect(r.sockets[0].closedWith).toEqual([1000]);
    expect(r.open).toHaveBeenLastCalledWith(OTHER);
    m.unmount();
    expect(r.sockets[1].closedWith, "the stage's socket goes with it; the tmux session does not").toEqual([1000]);
  });

  it("does not switch for a re-render that hands the same session again", async () => {
    const { r, Probe, props } = hookRig();
    const m = mountComponent(Probe, props({ kind: "session", ref: REF }));
    await flush();
    m.rerender(props({ kind: "session", ref: { ...REF } }));
    await flush();
    expect(r.open).toHaveBeenCalledTimes(1);
    m.unmount();
  });
});

// ---------------------------------------------------------------------------

describe("the cursor of a pane nobody has focused yet", () => {
  it("is drawn from the first frame: xterm's hold-until-focus flag is lifted", () => {
    const term = { _core: { coreService: { isCursorInitialized: false } } };
    showCursorFromTheStart(term);
    expect(term._core.coreService.isCursorInitialized).toBe(true);
  });

  it("leaves a terminal without that flag as it is, rather than inventing one", () => {
    const term = { _core: { coreService: {} as Record<string, unknown> } };
    showCursorFromTheStart(term);
    expect(term._core.coreService).toEqual({});
    expect(() => showCursorFromTheStart(null)).not.toThrow();
    expect(() => showCursorFromTheStart({})).not.toThrow();
  });

  it("still finds the flag where the installed xterm keeps it, so an upgrade that moves it fails here and not silently", () => {
    const xterm = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "@xterm", "xterm", "src");
    const pub = readFileSync(resolve(xterm, "browser/public/Terminal.ts"), "utf8");
    expect(pub).toMatch(/private _core: ITerminal/);
    const core = readFileSync(resolve(xterm, "common/services/CoreService.ts"), "utf8");
    expect(core).toMatch(/public isCursorInitialized: boolean = false/);
  });
});
