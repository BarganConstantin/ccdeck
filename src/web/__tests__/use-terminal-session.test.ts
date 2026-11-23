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
import { forgetTerminalTextStep, setTerminalTextStep, terminalTextStep } from "../terminal-text-size";
import { MAX_MESSAGE_BYTES, connectTerminal, type TerminalConnection } from "../terminal-protocol";
import { CLEAN_END_MIN_LIVE_MS } from "../components/terminal/stage-model";
import { launchTerminal, type ApiFailure, type NotAttachable, type SessionRef, type TerminalStatus, type Ticketed, type Launched } from "../terminal-api";
import { askSteps, SUBMIT_WORDS } from "../ask-keys";
import type { ChatQuestion } from "../components/chat/chat-model";
import {
  ACK_EVERY_BYTES,
  ASK_KEY_GAP_MS,
  ASK_SCREEN_POLL_MS,
  ASK_SCREEN_WAIT_MS,
  CTRL_V,
  ECHO_WINDOW_MS,
  ELSEWHERE_POLL_MS,
  ENGINE_NO_RETURN_MSG,
  ENGINE_NO_RETURN_WINDOWS_MSG,
  NO_RETURN_MSG,
  NO_RETURN_WINDOWS_MSG,
  PASTE_TOO_LARGE_MSG,
  RECONNECT_DELAYS_MS,
  RECONNECT_GIVE_UP_MS,
  RESTART_FAST_MS,
  RESTART_POLL_MS,
  RESIZE_SETTLE_MS,
  STREAM_QUIET_MS,
  TMUX_SETUP_GIVE_UP_MS,
  TMUX_SETUP_POLL_MS,
  createTerminalSession,
  EVENTS_ONLY_MSG,
  eventsOnlyPhase,
  forgetKeyInFlight,
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
import { en } from "../i18n/en";

// CHANGED ON PURPOSE (the UI in every language): the sentences are keys in the
// source; these read the English the catalog gives them, and the tests below
// still pin the words.
const ENGINE_NO_RETURN = en[ENGINE_NO_RETURN_MSG];
const ENGINE_NO_RETURN_WINDOWS = en[ENGINE_NO_RETURN_WINDOWS_MSG];
const NO_RETURN = en[NO_RETURN_MSG];
const NO_RETURN_WINDOWS = en[NO_RETURN_WINDOWS_MSG];
const PASTE_TOO_LARGE = en[PASTE_TOO_LARGE_MSG];

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
  answers: unknown[] = [];
  viewAnswers(kinds: unknown) { this.answers.push(kinds); }
  focus() { this.log.push("focus"); }
  blur() { this.log.push("blur"); }
  /** The terminal's input holds the focus, and the program asked for
   *  application cursor keys: set by the case. */
  focused = false;
  appKeys = false;
  hasFocus() { return this.focused; }
  applicationCursorKeys() { return this.appKeys; }
  scrollForInput() { this.log.push("scroll-for-input"); }
  /** The sizes the pane's text was set to, and the cell they draw: 8 × 18 at
   *  the stage's 13.3px, scaled with the text. */
  fontSizes: number[] = [];
  fontSize = 13.3;
  setFontSize(px: number) { this.fontSizes.push(px); this.fontSize = px; }
  cell() { return { w: 8 * this.fontSize / 13.3, h: 18 * this.fontSize / 13.3 }; }
  dispose() { this.disposed = true; }
}

const REF: SessionRef = { sessionId: "6f1c2d3e-0000-4000-8000-000000000001", provider: "claude", cwd: "/home/u/code/paycore" };
const OTHER: SessionRef = { sessionId: "6f1c2d3e-0000-4000-8000-000000000002", provider: "claude", cwd: "/home/u/personal/ccdeck" };
const REF_SUBJECT = subjectKey({ kind: "session", ref: REF });
const OTHER_SUBJECT = subjectKey({ kind: "session", ref: OTHER });
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
 *  the case resolves it, the way the dynamic import does in a browser.
 *  `windows`: the deck's sessions run in the Windows session host. */
function rig({ lazyMount = false, windows = false } = {}) {
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
  }, { windows });
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
  it("keeps Codex's cached RGB prompt bands theme-aware in seeds and output without reopening", async () => {
    const { r, ctl } = rig();
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const native = "\x1b[48;2;54;55;57mPrompt\x1b[49m";
    const themed = "\x1b[48;5;237mPrompt\x1b[49m";
    const socket = await attach(r, ctl, { ...REF, provider: "codex" }, native);
    expect(r.terminal().log).toContain(`write ${JSON.stringify(themed)}`);
    expect(socket.sentText()).toContainEqual({ t: "ack", bytes: enc(native).byteLength });
    r.terminal().log.length = 0;
    socket.binary(enc(native.slice(0, 12)));
    socket.binary(enc(native.slice(12)));
    r.terminal().parse();
    expect(r.terminal().log).toEqual([`write ${JSON.stringify(themed)}`]);
    ctl.setTheme({ foreground: "#1f2328", background: "#fafaf8" });
    expect(r.open).toHaveBeenCalledTimes(1);
    expect(socket.sentBytes()).toEqual([]);
    ctl.dispose();
  });

  it("leaves Claude's RGB output untouched when the pane switches providers", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const native = "\x1b[48;2;54;55;57mPrompt\x1b[49m";
    await attach(r, ctl, { ...REF, provider: "codex" }, native);
    r.terminal().log.length = 0;
    await attach(r, ctl, OTHER, native);
    expect(r.terminal().log).toContain(`write ${JSON.stringify(native)}`);
    ctl.dispose();
  });

  it("asks for a ticket, sends its size first, and reveals the pane only once the seed is parsed", async () => {
    const { r, ctl } = rig();
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "session", ref: REF });
    expect(r.last().phase).toEqual({ kind: "attaching", reconnect: false });
    await flush();
    // CHANGED ON PURPOSE: open sends size and colours like adopt (managed Codex attach)
    expect(r.open).toHaveBeenCalledWith(REF, {}, { cols: 120, rows: 40 }, undefined);
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
    expect(r.last().phase).toEqual({ kind: "not-attachable", target, stillRunning: true, busy: false });
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
    r.open.mockResolvedValueOnce(failure(404, "The Command Panel is not switched on for this deck."));
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.last().phase).toEqual({ kind: "error", message: "The Command Panel is not switched on for this deck." });
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
    expect(r.last().subject, "a snapshot names the subject it describes, from the switch's first one on")
      .toBe(subjectKey({ kind: "session", ref: OTHER }));
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

describe("telling the deck what the terminal has parsed", () => {
  it("acknowledges the seed at once, then every 64 KiB parsed, and never for a connection it has left", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl); // seed "SEED", already parsed by attach
    const acks = () => s.sentText().filter(m => m.t === "ack").map(m => m.bytes);
    expect(acks(), "the seed: how the deck learns this panel acknowledges").toEqual([4]);
    const big = new Uint8Array(ACK_EVERY_BYTES / 2).fill(0x61);
    s.binary(big);
    r.terminal().parse();
    expect(acks(), "half a step parsed: nothing yet").toEqual([4]);
    s.binary(big);
    expect(acks(), "received is not parsed").toEqual([4]);
    r.terminal().parse();
    expect(acks()).toEqual([4, 4 + ACK_EVERY_BYTES]);
    // Bytes still in the write queue when the panel moves on are not counted
    // against the next connection.
    s.binary(new Uint8Array(ACK_EVERY_BYTES).fill(0x62));
    s.drop();
    r.terminal().parse();
    expect(acks()).toEqual([4, 4 + ACK_EVERY_BYTES]);
  });
});

describe("a deck restart under a live pane (scenario S3)", () => {
  it("keeps the frame, reconnects with a fresh ticket, and asks every 250 ms while a restarting deck is down", async () => {
    const { r, ctl } = rig();
    ctl.resize(120, 40, false);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    s.text({ t: "exit", reason: "server-shutdown" });
    expect(r.last().phase, "the frozen frame stays up").toEqual({ kind: "attaching", reconnect: true });
    expect(r.terminal().log.filter(l => l === "reset"), "nothing is cleared yet").toHaveLength(1);

    r.open.mockResolvedValueOnce(failure(null));
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS);
    expect(r.open).toHaveBeenCalledTimes(2);
    expect(r.last().phase).toEqual({ kind: "attaching", reconnect: true });

    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS - 1);
    expect(r.open, "a deck on its way back is asked at the same pace, not backed off").toHaveBeenCalledTimes(2);
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

  it("backs off as before once a restart has taken longer than a restart takes", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    r.open.mockResolvedValue(failure(null));
    s.text({ t: "exit", reason: "server-shutdown" });
    const before = r.open.mock.calls.length;
    // The first ask was set going in the fast window; by the time it fails,
    // the restart has outlasted the window.
    r.clock.now += RESTART_FAST_MS + 1;
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS);
    expect(r.open.mock.calls.length, "the first ask, set going in the fast window").toBe(before + 1);
    await vi.advanceTimersByTimeAsync(RESTART_POLL_MS);
    expect(r.open.mock.calls.length, "past the fast window the ladder applies").toBe(before + 1);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1] - RESTART_POLL_MS);
    expect(r.open.mock.calls.length).toBe(before + 2);
  });

  it("treats a socket that simply drops the same way, on the backoff ladder", async () => {
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
    expect(r.last().phase).toEqual({ kind: "error", message: NO_RETURN });
  });

  it("on Windows, says the session is still running in the session host when the deck does not come back", async () => {
    const { r, ctl } = rig({ windows: true });
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    r.open.mockResolvedValue(failure(null));
    s.text({ t: "exit", reason: "server-shutdown" });
    for (let i = 0; i < 40 && r.last().phase.kind === "attaching"; i++) {
      r.clock.now += 5000;
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(r.last().phase).toEqual({ kind: "error", message: NO_RETURN_WINDOWS });
    expect(NO_RETURN_WINDOWS).toBe("The deck did not come back. The session is still running in the session host; try again once the deck is up.");
    expect(NO_RETURN_WINDOWS).not.toMatch(/tmux/);
  });
});

describe("a deck whose sessions run in the Windows session host", () => {
  it("says a refusal that would have been tmux missing elsewhere as the deck wrote it, and asks nothing about tmux", async () => {
    const { r, ctl } = rig({ windows: true });
    r.open.mockResolvedValue({ ok: false, target: { kind: "unsupported", label: "The Command Panel cannot open this session here." } });
    r.status.mockResolvedValue({ ok: true, platform: "win32", tmux: { ok: false, reason: "unsupported-platform" } });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.last().phase).toEqual({ kind: "error", message: "The Command Panel cannot open this session here." });
    expect(r.status, "no tmux to ask about").not.toHaveBeenCalled();

    const linux = rig();
    linux.r.open.mockResolvedValue({ ok: false, target: { kind: "unsupported", label: "The terminal runs on tmux…", reason: "missing" } });
    linux.r.status.mockResolvedValue({ ok: true, platform: "linux", tmux: { ok: false, reason: "missing", install: "sudo apt install tmux" } });
    linux.ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(linux.r.status, "elsewhere tmux is asked about, as before").toHaveBeenCalledTimes(1);
    expect(linux.r.last().phase.kind).toBe("tmux-missing");
  });
});

describe("checking an external terminal", () => {
  it("checks whether the original stopped before offering to resume", async () => {
    const { r, ctl } = rig();
    const external = { kind: "C" as const, label: "running elsewhere", adoptable: true };
    r.open.mockResolvedValueOnce({ ok: false, target: external });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.last().phase).toMatchObject({ kind: "not-attachable", stillRunning: true });
    r.open.mockResolvedValueOnce({ ok: false, target: { kind: "gone", label: "ended", adoptable: true } });
    ctl.adopt();
    await flush();
    expect(r.adopt).not.toHaveBeenCalled();
    expect(r.last().phase).toMatchObject({ kind: "not-attachable", target: { kind: "gone" }, stillRunning: false });
    ctl.adopt();
    await flush();
    expect(r.adopt).toHaveBeenCalledTimes(1);
    expect(r.sockets[0].url).toMatch(/ticket=adopted$/);
  });

  // #97: quitting the session in its own terminal turns the card into Reopen
  // here without a press. The look is a read; it never adopts or stops.
  it("looks again on its own while the session runs elsewhere, and offers Reopen here once it stopped", async () => {
    const { r, ctl } = rig();
    const external = { kind: "C" as const, label: "running elsewhere", adoptable: true };
    r.open.mockResolvedValue({ ok: false, target: external });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.open).toHaveBeenCalledTimes(1);
    const shown = r.snaps.length;
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    expect(r.open, "one look per interval").toHaveBeenCalledTimes(2);
    expect(r.open.mock.calls[1][0]).toEqual(REF);
    expect(r.snaps.length, "still running: the card is left as it is").toBe(shown);
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    expect(r.open).toHaveBeenCalledTimes(3);

    r.open.mockResolvedValue({ ok: false, target: { kind: "gone", label: "ended", adoptable: true } });
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    expect(r.last().phase).toEqual({ kind: "not-attachable", target: { kind: "gone", label: "ended", adoptable: true }, stillRunning: false, busy: false });
    expect(r.adopt, "Reopen here waits for the press").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS * 3);
    expect(r.open, "nothing more to look for once it can be reopened").toHaveBeenCalledTimes(4);
    ctl.adopt();
    await flush();
    expect(r.adopt).toHaveBeenCalledTimes(1);
  });

  // An open the engine answers by starting a client (a Codex conversation
  // loaded in the local Codex app server) starts it in the pane: the first
  // open and every look carry the pane's size and colours, as an adopt does.
  it("opens, and looks again, at the pane's size and in its colours as they are then", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValue({ ok: false, target: { kind: "C", label: "running elsewhere", adoptable: true } });
    ctl.resize(132, 41, false);
    ctl.setTheme({ foreground: "#E6E6E6", background: "rgb(250, 250, 248)" });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.open).toHaveBeenCalledTimes(1);
    expect(r.open.mock.calls[0], "the first open").toEqual([REF, {}, { cols: 132, rows: 41 }, { fg: "#e6e6e6", bg: "#fafaf8" }]);
    ctl.resize(100, 30, false);
    ctl.setTheme({ foreground: "#e6e6e6", background: "#14161b" });
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    expect(r.open).toHaveBeenCalledTimes(2);
    expect(r.open.mock.calls[1], "the look while it runs elsewhere").toEqual([REF, {}, { cols: 100, rows: 30 }, { fg: "#e6e6e6", bg: "#14161b" }]);
  });

  it("keeps the card through a failed look, and attaches when the session has a pane again", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValueOnce({ ok: false, target: { kind: "C", label: "running elsewhere", adoptable: true } });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    r.open.mockResolvedValueOnce(failure(null));
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    expect(r.last().phase, "a deck that blinked is not news").toMatchObject({ kind: "not-attachable", stillRunning: true, busy: false });
    // Reopened from another tab: it is the deck's pane now, and the stage shows it.
    r.open.mockResolvedValueOnce(ticketed("t9"));
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    expect(r.sockets).toHaveLength(1);
    expect(r.sockets[0].url).toMatch(/ticket=t9$/);
  });

  it("does not look while the page is hidden, and stops when the stage shows something else", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValue({ ok: false, target: { kind: "C", label: "running elsewhere", adoptable: true } });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    const g = globalThis as { document?: unknown };
    const had = "document" in g;
    const before = g.document;
    g.document = { visibilityState: "hidden" };
    try {
      await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS * 3);
      expect(r.open, "a hidden tab asks nothing").toHaveBeenCalledTimes(1);
    } finally {
      if (had) g.document = before; else delete g.document;
    }
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    expect(r.open, "shown again, it looks again").toHaveBeenCalledTimes(2);

    r.open.mockResolvedValue(ticketed("other"));
    ctl.show({ kind: "session", ref: OTHER });
    await flush();
    const calls = r.open.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS * 3);
    expect(r.open.mock.calls.slice(calls).map(c => c[0]), "nothing more about the session that left").not.toContainEqual(REF);
  });

  it("looks again after a refused Reopen here says it is still running", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValueOnce({ ok: false, target: { kind: "gone", label: "ended", adoptable: true } });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    r.adopt.mockResolvedValueOnce(failure(409, "still-running"));
    ctl.adopt();
    await flush();
    expect(r.last().phase).toMatchObject({ kind: "not-attachable", stillRunning: true, busy: false });
    r.open.mockResolvedValueOnce({ ok: false, target: { kind: "gone", label: "ended", adoptable: true } });
    await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    expect(r.last().phase).toMatchObject({ kind: "not-attachable", target: { kind: "gone" }, stillRunning: false });
    expect(r.adopt).toHaveBeenCalledTimes(1);
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
    // THEME has no foreground: no colours to start the session in.
    expect(r.adopt).toHaveBeenCalledWith(REF, {}, { cols: 80, rows: 24 }, undefined);
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

  // Internal #104: an agent that ended itself — status 0, while the pane
  // watched it run — is a clean ending, which the stage closes the pane on.
  it("calls an ending clean only for status 0, no signal, after the pane was live a while", async () => {
    for (const [exit, liveMs, phase] of [
      [{ exitStatus: 0 }, CLEAN_END_MIN_LIVE_MS, { kind: "ended", clean: true }],
      [{ exitStatus: 0 }, CLEAN_END_MIN_LIVE_MS - 1, { kind: "ended" }],
      [{ exitStatus: 1 }, 60_000, { kind: "ended" }],
      [{ exitSignal: 9 }, 60_000, { kind: "ended" }],
      [{ exitStatus: 0, exitSignal: 9 }, 60_000, { kind: "ended" }],
      [{}, 60_000, { kind: "ended" }],
    ] as const) {
      const { r, ctl } = rig();
      ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
      await flush();
      const s = await attach(r, ctl);
      r.clock.now += liveMs;
      s.text({ t: "exit", reason: "ended", ...exit });
      expect(r.last().phase, `${JSON.stringify(exit)} after ${liveMs} ms`).toEqual(phase);
    }
  });

  it("never calls clean an ending it did not watch, whatever the status", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    r.clock.now += 60_000;
    s.text({ t: "exit", reason: "ended", atOpen: true, exitStatus: 0 });
    expect(r.last().phase).toEqual({ kind: "ended", atOpen: true });
  });

  it("refuses a second Reopen here while the first is still asking — the button stays enabled (#620)", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValueOnce({ ok: false, target: { kind: "gone", label: "ended", adoptable: true } });
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

  it("rechecks a refusal caused by the original restarting before adopt", async () => {
    const { r, ctl } = rig();
    const target = { kind: "gone" as const, label: "ended", adoptable: true };
    r.open.mockResolvedValueOnce({ ok: false, target });
    ctl.show({ kind: "session", ref: REF });
    await flush();
    r.adopt.mockResolvedValueOnce(failure(409, "still-running"));
    ctl.adopt();
    await flush();
    expect(r.last().phase).toMatchObject({ kind: "not-attachable", stillRunning: true, busy: false });
    r.open.mockResolvedValueOnce({ ok: false, target: { kind: "C", label: "running elsewhere", adoptable: true } });
    ctl.adopt();
    await flush();
    expect(r.adopt).toHaveBeenCalledTimes(1);
    expect(r.open).toHaveBeenCalledTimes(2);
    expect(r.sockets).toHaveLength(0);
  });
});

// Codex's own "Update now" installs the new version, says "Please restart
// Codex." and exits 0, exactly as /exit does. The deck tells the two apart by
// the codex on disk (codex-update.mjs); the stage restarts an updated one.
describe("a Codex that updated itself", () => {
  const CODEX: SessionRef = { ...REF, provider: "codex" };

  /** A rig whose deck answers "did it update itself?" as `answer` does. */
  function codexRig(answer: (liveForMs: number) => Promise<boolean>) {
    const { r, ctl } = rig();
    const asked = vi.fn(answer);
    r.deps.api.codexUpdated = asked;
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    return { r, ctl, asked };
  }

  it("asks how long the pane was live, keeps the pane plainly ended while it asks, and says updated on a yes", async () => {
    const { r, ctl, asked } = codexRig(async () => true);
    await flush();
    const s = await attach(r, ctl, CODEX);
    r.clock.now += 60_000;
    s.text({ t: "exit", reason: "ended", exitStatus: 0 });
    expect(r.last().phase, "never clean while it asks, so the stage does not close the pane first").toEqual({ kind: "ended" });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith(60_000);
    await flush();
    expect(r.last().phase).toEqual({ kind: "ended", updated: true });
    expect(r.adopt, "the stage restarts it, not the session").not.toHaveBeenCalled();
  });

  it("takes a no as the ending it would have been: clean after status 0, plain when tmux gave no status", async () => {
    for (const [exit, phase] of [
      [{ exitStatus: 0 }, { kind: "ended", clean: true }],
      [{}, { kind: "ended" }],
    ] as const) {
      const { r, ctl, asked } = codexRig(async () => false);
      await flush();
      const s = await attach(r, ctl, CODEX);
      r.clock.now += 60_000;
      s.text({ t: "exit", reason: "ended", ...exit });
      await flush();
      expect(asked, JSON.stringify(exit)).toHaveBeenCalledTimes(1);
      expect(r.last().phase, JSON.stringify(exit)).toEqual(phase);
    }
  });

  it("takes a question that failed as a no", async () => {
    const { r, ctl, asked } = codexRig(async () => { throw new Error("offline"); });
    await flush();
    const s = await attach(r, ctl, CODEX);
    r.clock.now += 60_000;
    s.text({ t: "exit", reason: "ended", exitStatus: 0 });
    await flush();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(r.last().phase).toEqual({ kind: "ended", clean: true });
  });

  it("asks nothing for a crash, a kill, an ending it never watched, or an agent that is not Codex", async () => {
    for (const [ref, exit, phase] of [
      [CODEX, { exitStatus: 1 }, { kind: "ended" }],
      [CODEX, { exitSignal: 9 }, { kind: "ended" }],
      [CODEX, { exitStatus: 0, exitSignal: 15 }, { kind: "ended" }],
      [CODEX, { exitStatus: 0, atOpen: true }, { kind: "ended", atOpen: true }],
      [REF, { exitStatus: 0 }, { kind: "ended", clean: true }],
      [REF, {}, { kind: "ended" }],
    ] as const) {
      const { r, ctl, asked } = codexRig(async () => true);
      await flush();
      const s = await attach(r, ctl, ref);
      r.clock.now += 60_000;
      s.text({ t: "exit", reason: "ended", ...exit });
      await flush();
      const label = `${ref.provider} ${JSON.stringify(exit)}`;
      expect(asked, label).not.toHaveBeenCalled();
      expect(r.last().phase, label).toEqual(phase);
    }
  });

  it("asks nothing for a Codex that ended before its first frame was drawn", async () => {
    const { r, ctl, asked } = codexRig(async () => true);
    await flush();
    ctl.show({ kind: "session", ref: CODEX });
    await flush();
    const s = r.sockets[0];
    s.open();
    s.text({ t: "reset", cols: 120, rows: 40 });
    s.binary(enc("LAST FRAME"));
    s.text({ t: "exit", reason: "ended", exitStatus: 0 });
    r.terminal().parse();
    await flush();
    expect(asked).not.toHaveBeenCalled();
    expect(r.last().phase).toEqual({ kind: "ended", atOpen: true });
  });

  it("asks for a Codex the stage launched, which has no session id yet", async () => {
    const { r, ctl, asked } = codexRig(async () => true);
    r.launch.mockResolvedValueOnce({ ok: true, sessionId: "", name: "ccdeck-codex-9f8e7d6c", ticket: "launched" } as Launched);
    await flush();
    ctl.show({ kind: "launch", agent: "codex", cwd: "/w", key: "n20" });
    await flush();
    const s = r.sockets[0];
    s.open();
    s.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    s.text({ t: "reset", cols: 120, rows: 40 });
    s.binary(enc("Update available!"));
    r.terminal().parse();
    expect(r.last().phase.kind).toBe("live");
    r.clock.now += 20_000;
    s.text({ t: "exit", reason: "ended", exitStatus: 0 });
    await flush();
    expect(asked).toHaveBeenCalledWith(20_000);
    expect(r.last().phase).toEqual({ kind: "ended", updated: true });
    expect(r.launch, "launched once: the stage starts the next one").toHaveBeenCalledTimes(1);
  });

  it("drops an answer that comes after the stage moved on: Reopen here pressed, or another session shown", async () => {
    for (const moveOn of ["reopen", "switch"] as const) {
      let answer!: (updated: boolean) => void;
      const { r, ctl, asked } = codexRig(() => new Promise<boolean>(res => { answer = res; }));
      await flush();
      const s = await attach(r, ctl, CODEX);
      r.clock.now += 60_000;
      s.text({ t: "exit", reason: "ended", exitStatus: 0 });
      expect(asked, moveOn).toHaveBeenCalledTimes(1);
      if (moveOn === "reopen") ctl.adopt();
      else ctl.show({ kind: "session", ref: OTHER });
      await flush();
      const moved = r.last().phase;
      expect(moved.kind, moveOn).toBe("attaching");
      answer(true);
      await flush();
      expect(r.last().phase, moveOn).toEqual(moved);
    }
  });
});

describe("sending a Chat prompt on the current terminal connection", () => {
  async function promptRig(readOnly = false) {
    const { r, ctl } = rig();
    let connection: TerminalConnection;
    const connect = r.deps.connect;
    r.deps.connect = options => (connection = connect(options));
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    if (readOnly) s.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: true });
    s.sent.length = 0;
    r.terminal().log.length = 0;
    return { r, ctl, s, connection: connection! };
  }

  it("records one intact multiline Unicode paste then Enter, without changing focus or key ownership", async () => {
    const { r, ctl, s } = await promptRig();
    const text = "  Bună 👨‍👩‍👧\n日本語\r\n\"quoted\"\\path  ";
    expect(ctl.sendPrompt(text, REF_SUBJECT)).toBe("sent");
    expect(s.sent).toEqual([JSON.stringify({ t: "paste", text }), enc("\r")]);
    expect(r.terminal().log).toEqual([]);
    expect(ctl.snapshot().keysOwner).toBe("board");
    s.binary(enc("echo"));
    expect(ctl.snapshot().streaming).toBe(false);
    ctl.dispose();
  });

  it.each(["", " \t\r\n", "\u2003\u00a0"])("refuses blank text %j before any transport call", async text => {
    const { ctl, s, connection } = await promptRig();
    const paste = vi.spyOn(connection, "sendPaste");
    const enter = vi.spyOn(connection, "sendInput");
    expect(ctl.sendPrompt(text, REF_SUBJECT)).toBe("empty");
    expect(paste).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
    ctl.dispose();
  });

  it("checks the encoded paste cap before sending, including Unicode bytes and JSON escaping", async () => {
    const { ctl, s, connection } = await promptRig();
    const paste = vi.spyOn(connection, "sendPaste");
    const enter = vi.spyOn(connection, "sendInput");
    for (const text of ["x".repeat(MAX_MESSAGE_BYTES), "😀".repeat(MAX_MESSAGE_BYTES / 4), `x${"\n".repeat(MAX_MESSAGE_BYTES / 2)}`]) {
      expect(ctl.sendPrompt(text, REF_SUBJECT)).toBe("too-large");
    }
    expect(paste).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
    ctl.dispose();
  });

  it("refuses read-only before calling either send method", async () => {
    const { ctl, s, connection } = await promptRig(true);
    const paste = vi.spyOn(connection, "sendPaste");
    const enter = vi.spyOn(connection, "sendInput");
    expect(ctl.sendPrompt("unsent", REF_SUBJECT)).toBe("unavailable");
    expect(paste).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
    ctl.dispose();
  });

  it("refuses before attachment, during reconnect and after disposal, without retaining text", async () => {
    const { ctl } = rig();
    expect(ctl.sendPrompt("before mount", REF_SUBJECT)).toBe("unavailable");
    ctl.dispose();
    const { r, ctl: live, s, connection } = await promptRig();
    const paste = vi.spyOn(connection, "sendPaste");
    s.drop();
    expect(live.sendPrompt("while disconnected", REF_SUBJECT)).toBe("unavailable");
    expect(paste).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    await flush();
    const next = r.sockets[1];
    next.open();
    next.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    next.text({ t: "reset", cols: 120, rows: 40 });
    next.binary(enc("fresh"));
    r.terminal().parse();
    expect(next.sentText().filter(frame => frame.t === "paste")).toEqual([]);
    expect(next.sentBytes()).toEqual([]);
    live.dispose();
    expect(live.sendPrompt("after disposal", REF_SUBJECT)).toBe("unavailable");
  });

  it.each([false, true])("leaves the text unsent when paste is refused or throws (throws=%s)", async throws => {
    const { ctl, s, connection } = await promptRig();
    vi.spyOn(connection, "sendPaste").mockImplementation(() => {
      if (throws) throw new Error("paste failed");
      return false;
    });
    const enter = vi.spyOn(connection, "sendInput");
    expect(ctl.sendPrompt("unsent", REF_SUBJECT)).toBe("unavailable");
    expect(enter).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
    ctl.dispose();
  });

  it.each([false, true])("returns partial when Enter is refused or throws, without retry (throws=%s)", async throws => {
    const { ctl, s, connection } = await promptRig();
    const enter = vi.spyOn(connection, "sendInput").mockImplementation(() => {
      if (throws) throw new Error("Enter failed");
      return false;
    });
    expect(ctl.sendPrompt("already pasted", REF_SUBJECT)).toBe("partial");
    expect(s.sent).toEqual([JSON.stringify({ t: "paste", text: "already pasted" })]);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledWith("\r");
    vi.advanceTimersByTime(10_000);
    expect(s.sent).toHaveLength(1);
    ctl.dispose();
  });

  it("catches actual socket send errors both before paste and after a recorded paste", async () => {
    const { ctl, s } = await promptRig();
    const send = s.send.bind(s);
    vi.spyOn(s, "send").mockImplementation(() => { throw new Error("socket lost"); });
    expect(ctl.sendPrompt("unsent", REF_SUBJECT)).toBe("unavailable");
    expect(s.sent).toEqual([]);
    vi.mocked(s.send).mockImplementation(frame => {
      if (typeof frame !== "string") throw new Error("Enter lost");
      send(frame);
    });
    expect(ctl.sendPrompt("pasted", REF_SUBJECT)).toBe("partial");
    expect(s.sent).toEqual([JSON.stringify({ t: "paste", text: "pasted" })]);
    ctl.dispose();
  });

  it("refuses a target change before paste", async () => {
    const { r, ctl, s, connection } = await promptRig();
    const paste = vi.spyOn(connection, "sendPaste");
    r.deps.now = () => { ctl.show({ kind: "session", ref: OTHER }); return r.clock.now; };
    expect(ctl.sendPrompt("unsent", REF_SUBJECT)).toBe("unavailable");
    expect(paste).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
    ctl.dispose();
    await flush();
  });

  it("rejects a stale expected subject after the controller is fully live on another target", async () => {
    const { r, ctl, s } = await promptRig();
    const retainedSend = () => ctl.sendPrompt("session A draft", REF_SUBJECT);
    const next = await attach(r, ctl, OTHER);
    next.sent.length = 0;
    expect(retainedSend()).toBe("unavailable");
    expect(ctl.sendPrompt("wrong key", "empty")).toBe("unavailable");
    expect(s.sent).toEqual([]);
    expect(next.sent).toEqual([]);
    expect(ctl.sendPrompt("session B draft", OTHER_SUBJECT)).toBe("sent");
    expect(next.sent).toEqual([JSON.stringify({ t: "paste", text: "session B draft" }), enc("\r")]);
    ctl.dispose();
  });

  it.each(["target", "generation", "disconnect", "read-only", "dispose"])("stops after paste when %s changes, never sending Enter or replaying the prompt", async change => {
    const { r, ctl, s, connection } = await promptRig();
    const paste = connection.sendPaste.bind(connection);
    vi.spyOn(connection, "sendPaste").mockImplementation(text => {
      const accepted = paste(text);
      if (change === "target") ctl.show({ kind: "session", ref: OTHER });
      if (change === "generation") {
        ctl.show({ kind: "empty" });
        ctl.show({ kind: "session", ref: REF });
      }
      if (change === "disconnect") s.drop();
      if (change === "read-only") s.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: true });
      if (change === "dispose") ctl.dispose();
      return accepted;
    });
    const enter = vi.spyOn(connection, "sendInput");
    expect(ctl.sendPrompt("original target only", REF_SUBJECT)).toBe("partial");
    expect(enter).not.toHaveBeenCalled();
    expect(s.sent).toEqual([JSON.stringify({ t: "paste", text: "original target only" })]);
    if (change === "disconnect") vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    await flush();
    const next = r.sockets[1];
    if (next) {
      next.open();
      next.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
      next.text({ t: "reset", cols: 120, rows: 40 });
      next.binary(enc("replacement"));
      r.terminal().parse();
      expect(next.sentText().filter(frame => frame.t === "paste")).toEqual([]);
      expect(next.sentBytes()).toEqual([]);
    }
    ctl.dispose();
  });
});

describe("answering Claude Code's question from Chat (sendAsk)", () => {
  const question = (text: string, labels: string[], extra: Partial<ChatQuestion> = {}): ChatQuestion =>
    ({ header: "", question: text, multi: false, options: labels.map(label => ({ label, description: "" })), ...extra });
  const DB = question("Which database should the service use?", ["Postgres", "SQLite", "DynamoDB"]);
  const FEATURES = question("Which features should ship first?", ["Search", "Export", "Sharing"], { multi: true });
  const DB_SCREEN = " ☐ Database\n\n Which database should the service use?\n\n ❯ 1. Postgres\n   2. SQLite\n   3. DynamoDB\n   4. Type something.";
  const FEATURES_SCREEN = " Which features should ship first?\n\n   1. [ ] Search\n   2. [ ] Export\n   3. [ ] Sharing";
  const REVIEW_SCREEN = " Review your answers\n\n Ready to submit your answers?\n ❯ 1. Submit answers\n   2. Cancel";

  async function askRig({ screen = DB_SCREEN as string | null, readOnly = false } = {}) {
    const { r, ctl } = rig();
    let connection: TerminalConnection;
    const connect = r.deps.connect;
    r.deps.connect = options => (connection = connect(options));
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    if (readOnly) s.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: true });
    const view = { text: screen ?? "" };
    if (screen !== null) Object.assign(r.terminal(), { screen: () => view.text });
    s.sent.length = 0;
    return { r, ctl, s, view, connection: connection! };
  }
  /** One poll of the screen: the deck's clock and the timers move together. */
  const poll = async (r: Rig, ms = ASK_SCREEN_POLL_MS) => { r.clock.now += ms; await vi.advanceTimersByTimeAsync(ms); };

  it("one choice: the digit alone, at once, when the screen shows the question", async () => {
    const { ctl, s } = await askRig();
    expect(await ctl.sendAsk(askSteps([DB], [{ options: [1] }])!, REF_SUBJECT)).toBe("sent");
    expect(s.sent).toEqual([enc("2")]);
    ctl.dispose();
  });

  it("each step waits for the program to draw what it answers, then the review screen's submit", async () => {
    const { r, ctl, s, view } = await askRig();
    const steps = askSteps([DB, FEATURES], [{ options: [0] }, { options: [0, 2] }])!;
    const done = ctl.sendAsk(steps, REF_SUBJECT);
    await flush();
    expect(s.sent, "the second question is not on screen yet").toEqual([enc("1")]);
    await poll(r, ASK_KEY_GAP_MS + ASK_SCREEN_POLL_MS);
    expect(s.sent).toHaveLength(1);
    view.text = FEATURES_SCREEN;
    await poll(r);
    expect(s.sent, "the step's first key goes as its question shows").toEqual([enc("1"), enc("1")]);
    await poll(r, ASK_KEY_GAP_MS);
    expect(s.sent).toEqual([enc("1"), enc("1"), enc("3")]);
    await poll(r, ASK_KEY_GAP_MS);
    expect(s.sent).toEqual([enc("1"), enc("1"), enc("3"), enc("\t")]);
    view.text = REVIEW_SCREEN;
    await poll(r, ASK_KEY_GAP_MS);
    expect(await done).toBe("sent");
    expect(s.sent).toEqual([enc("1"), enc("1"), enc("3"), enc("\t"), enc("1")]);
    expect(REVIEW_SCREEN).toContain(SUBMIT_WORDS);
    ctl.dispose();
  });

  // A prompt that reads "13" in one go does not see two presses, and words
  // pasted before "Type something" opens miss the box: keys come apart, as a
  // person's do.
  it("keys go apart: the next one only after the program had time to read the last", async () => {
    const { r, ctl, s } = await askRig({ screen: FEATURES_SCREEN });
    const done = ctl.sendAsk([{ expect: [], keys: [{ input: "1" }, { input: "3" }, { input: "\t" }] }], REF_SUBJECT);
    await flush();
    expect(s.sent).toEqual([enc("1")]);
    await poll(r, ASK_KEY_GAP_MS - 1);
    expect(s.sent, "not before the gap").toEqual([enc("1")]);
    await poll(r, 1);
    expect(s.sent).toEqual([enc("1"), enc("3")]);
    await poll(r, ASK_KEY_GAP_MS);
    expect(await done).toBe("sent");
    expect(s.sent).toEqual([enc("1"), enc("3"), enc("\t")]);
    ctl.dispose();
  });

  it("the session going away between two keys of a step stops the rest", async () => {
    const { r, ctl, s } = await askRig({ screen: FEATURES_SCREEN });
    const done = ctl.sendAsk(askSteps([FEATURES], [{ options: [0, 1] }])!, REF_SUBJECT);
    await flush();
    expect(s.sent).toEqual([enc("1")]);
    ctl.show({ kind: "session", ref: OTHER });
    await poll(r, ASK_KEY_GAP_MS);
    expect(await done).toBe("partial");
    expect(s.sent).toEqual([enc("1")]);
    ctl.dispose();
  });

  it("your own words: the box's digit, the words as one paste once the box had time to open, Enter only once they show", async () => {
    const { r, ctl, s, view } = await askRig();
    const done = ctl.sendAsk(askSteps([DB], [{ options: [], text: "MySQL, please" }])!, REF_SUBJECT);
    await flush();
    expect(s.sent, "the words wait for the box").toEqual([enc("4")]);
    await poll(r, ASK_KEY_GAP_MS);
    expect(s.sent).toEqual([enc("4"), JSON.stringify({ t: "paste", text: "MySQL, please" })]);
    await poll(r, ASK_KEY_GAP_MS + ASK_SCREEN_POLL_MS);
    expect(s.sent, "Enter waits until the words show").toHaveLength(2);
    view.text = `${DB_SCREEN}\n   > MySQL, please`;
    await poll(r);
    expect(await done).toBe("sent");
    expect(s.sent.at(-1)).toEqual(enc("\r"));
    ctl.dispose();
  });

  it("a screen that never shows the question sends nothing and says it changed", async () => {
    const { r, ctl, s } = await askRig({ screen: "$ " });
    const done = ctl.sendAsk(askSteps([DB], [{ options: [1] }])!, REF_SUBJECT);
    await poll(r, ASK_SCREEN_WAIT_MS - ASK_SCREEN_POLL_MS);
    expect(s.sent).toEqual([]);
    await poll(r);
    expect(await done).toBe("changed");
    expect(s.sent).toEqual([]);
    ctl.dispose();
  });

  it("a later step that never shows: what went stays, and the rest is left to Term", async () => {
    const { r, ctl, s } = await askRig();
    const done = ctl.sendAsk(askSteps([DB, FEATURES], [{ options: [2] }, { options: [1] }])!, REF_SUBJECT);
    await poll(r, ASK_KEY_GAP_MS);
    await poll(r, ASK_SCREEN_WAIT_MS);
    expect(await done).toBe("partial");
    expect(s.sent).toEqual([enc("3")]);
    ctl.dispose();
  });

  it("the session going away while a step waits stops the keys", async () => {
    const { r, ctl, s } = await askRig();
    const done = ctl.sendAsk(askSteps([DB, FEATURES], [{ options: [0] }, { options: [1] }])!, REF_SUBJECT);
    await flush();
    ctl.show({ kind: "session", ref: OTHER });
    await poll(r, ASK_KEY_GAP_MS);
    expect(await done).toBe("partial");
    expect(s.sent).toEqual([enc("1")]);
    const next = r.sockets.at(-1)!;
    expect(next === s || next.sent.length === 0).toBe(true);
    ctl.dispose();
  });

  it("refuses with nothing sent: read only, another session, no screen to read, no steps", async () => {
    const steps = askSteps([DB], [{ options: [0] }])!;
    const readOnly = await askRig({ readOnly: true });
    expect(await readOnly.ctl.sendAsk(steps, REF_SUBJECT)).toBe("unavailable");
    expect(readOnly.s.sent).toEqual([]);
    readOnly.ctl.dispose();
    const other = await askRig();
    expect(await other.ctl.sendAsk(steps, OTHER_SUBJECT)).toBe("unavailable");
    expect(await other.ctl.sendAsk([], REF_SUBJECT)).toBe("unavailable");
    expect(other.s.sent).toEqual([]);
    other.ctl.dispose();
    const blind = await askRig({ screen: null });
    expect(await blind.ctl.sendAsk(steps, REF_SUBJECT)).toBe("unavailable");
    expect(blind.s.sent).toEqual([]);
    blind.ctl.dispose();
    const { ctl } = rig();
    expect(await ctl.sendAsk(steps, REF_SUBJECT)).toBe("unavailable");
    ctl.dispose();
  });

  it("a key the connection refuses: nothing went is unavailable, after one went is partial", async () => {
    const first = await askRig();
    vi.spyOn(first.connection, "sendInput").mockReturnValue(false);
    expect(await first.ctl.sendAsk(askSteps([DB], [{ options: [0] }])!, REF_SUBJECT)).toBe("unavailable");
    first.ctl.dispose();
    const later = await askRig({ screen: `${DB_SCREEN}\n${FEATURES_SCREEN}` });
    const send = later.connection.sendInput.bind(later.connection);
    vi.spyOn(later.connection, "sendInput").mockImplementation(data => data === "1" && send(data));
    const done = later.ctl.sendAsk(askSteps([DB, FEATURES], [{ options: [0] }, { options: [1] }])!, REF_SUBJECT);
    await poll(later.r, ASK_KEY_GAP_MS);
    expect(await done).toBe("partial");
    expect(later.s.sent).toEqual([enc("1")]);
    later.ctl.dispose();
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

  it("does not light the spine for the echo of what was typed, only for output of the program's own", async () => {
    const { r, s } = await liveRig();
    const lit = () => r.last().streaming;
    s.binary(enc("x"));
    expect(lit(), "output with no input before it is the program's").toBe(true);
    r.clock.now += STREAM_QUIET_MS + 1;
    vi.advanceTimersByTime(STREAM_QUIET_MS + 1);
    expect(lit()).toBe(false);
    r.events().onInput("a");
    s.binary(enc("a"));
    expect(lit(), "the echo of a key").toBe(false);
    r.clock.now += ECHO_WINDOW_MS;
    s.binary(enc("thinking…"));
    expect(lit(), "output that goes on after the key").toBe(true);
  });

  it("sends typed input as bytes and a paste whole, so the pane sees one bracketed paste", async () => {
    const { r, s } = await liveRig();
    r.events().onInput("ls -la\r");
    r.events().onPaste("line one\nline two");
    expect(s.sentBytes()).toEqual(["ls -la\r"]);
    expect(s.sentText().at(-1)).toEqual({ t: "paste", text: "line one\nline two" });
  });

  describe("the phone's key row (press)", () => {
    it("sends an arrow as the terminal itself would: ESC [ A normally, ESC O A in application cursor-key mode", async () => {
      const { r, ctl, s } = await liveRig();
      ctl.press("\x1b[A");
      ctl.press("\x1b[B");
      r.terminal().appKeys = true;
      ctl.press("\x1b[A");
      ctl.press("\x1b[B");
      expect(s.sentBytes()).toEqual(["\x1b[A", "\x1b[B", "\x1bOA", "\x1bOB"]);
    });

    it("leaves the other keys' bytes alone in either mode", async () => {
      const { r, ctl, s } = await liveRig();
      r.terminal().appKeys = true;
      for (const bytes of ["\x1b", "\t", "\x03", "\r"]) ctl.press(bytes);
      expect(s.sentBytes()).toEqual(["\x1b", "\t", "\x03", "\r"]);
    });

    it("brings a view scrolled back to the bottom, as a typed key does", async () => {
      const { r, ctl } = await liveRig();
      r.terminal().log.length = 0;
      ctl.press("\r");
      expect(r.terminal().log).toContain("scroll-for-input");
    });

    // CHANGED ON PURPOSE (the phone layout): the test used to set the focus on
    // the terminal at press time. In the case the refocus exists for, the focus
    // has already left the terminal when the click lands, so the press is sent
    // with what was noted when it BEGAN (pointerdown), in that order.
    it("gives the focus back when the terminal held it as the press began, even though it left before the click", async () => {
      const { r, ctl } = await liveRig();
      r.terminal().log.length = 0;
      // Pointerdown: the terminal holds the focus.
      r.terminal().focused = true;
      const heldAtStart = ctl.holdsFocus();
      expect(heldAtStart).toBe(true);
      // The browser takes the focus off it before the click.
      r.terminal().focused = false;
      ctl.press("\t", heldAtStart);
      expect(r.terminal().log, "it held the focus when the press began").toContain("focus");
    });

    it("takes no focus when the terminal did not hold it as the press began", async () => {
      const { r, ctl } = await liveRig();
      r.terminal().log.length = 0;
      expect(ctl.holdsFocus()).toBe(false);
      ctl.press("\t", false);
      expect(r.terminal().log).not.toContain("focus");
      // Held at the click but not at the start: the start decides.
      r.terminal().focused = true;
      ctl.press("\t", false);
      expect(r.terminal().log).not.toContain("focus");
    });

    it("with no start noted, the focus held at the click is used", async () => {
      const { r, ctl } = await liveRig();
      r.terminal().log.length = 0;
      ctl.press("\t");
      expect(r.terminal().log).not.toContain("focus");
      r.terminal().focused = true;
      ctl.press("\t");
      expect(r.terminal().log).toContain("focus");
    });
  });

  it("sends keys typed before the pane was ready one at a time, as they were typed, and only to a live pane", async () => {
    const { r, ctl, s } = await liveRig();
    ctl.type("hé😀\x1b\r\r");
    expect(s.sentBytes(), "a fast typist's keys, Shift+Enter's two bytes as one").toEqual(["h", "é", "😀", "\x1b\r", "\r"]);
    s.text({ t: "exit", reason: "ended" });
    ctl.type("x");
    expect(s.sentBytes()).toHaveLength(5);
    expect(r.last().phase.kind).toBe("ended");
  });

  it("knows a pasted screenshot from pasted text, files that are not images, and nothing at all", () => {
    const items = (...list: Array<{ kind: string; type: string }>) => ({ items: Object.assign(list, { length: list.length }) as unknown as DataTransferItemList });
    expect(pasteHoldsImage(items({ kind: "file", type: "image/png" }))).toBe(true);
    expect(pasteHoldsImage(items({ kind: "string", type: "text/plain" }))).toBe(false);
    expect(pasteHoldsImage(items({ kind: "file", type: "application/pdf" }))).toBe(false);
    expect(pasteHoldsImage(null)).toBe(false);
    expect(CTRL_V).toBe("\x16");
  });

  it("pastes nothing on a middle click the program has the mouse for, and still on Shift+middle, as a native terminal does", () => {
    // mountXterm's listeners (source-pinned: they need a real xterm). Linux
    // pastes the primary selection on a middle click; a program with mouse
    // tracking is sent that click by xterm, and pasting as well put the old
    // selection into its prompt.
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../use-terminal-session.ts"), "utf8");
    expect(src).toMatch(/const onMouseDown = \(e: MouseEvent\) => \{ if \(e\.button === 1 && !e\.shiftKey\) middleAt = performance\.now\(\); \};/);
    const paste = src.slice(src.indexOf("const onPaste = (e: ClipboardEvent) => {"), src.indexOf('host.addEventListener("paste", onPaste, true);'));
    expect(paste).toMatch(/const fromMiddle = performance\.now\(\) - middleAt < MIDDLE_PASTE_MS;[\s\S]*if \(fromMiddle && programHasMouse\(\)\) return;[\s\S]*if \(!text\)/);
    expect(src).toMatch(/host\.removeEventListener\("mousedown", onMouseDown, true\);/);
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

  it("keeps 10,000 lines of scrollback in the pane, the history the deck's tmux keeps for it (8ecfcfb7)", () => {
    // mountXterm's options (source-pinned: they need a real xterm). xterm's
    // own default is 1,000 and the stage kept 2,000 before 8ecfcfb7; native
    // terminals keep 10,000, and so does the pane's tmux (PANE_HISTORY,
    // set as history-limit on the deck's server). A reattach seeds only the
    // last SEED_HISTORY lines, which must stay below what the pane keeps.
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const src = read("../use-terminal-session.ts");
    const mount = src.slice(src.indexOf("export const mountXterm"), src.indexOf("// The controller."));
    const lines = (text: string, re: RegExp) => Number((re.exec(text)?.[1] ?? "NaN").replaceAll("_", ""));
    const kept = lines(mount, /\n\s*scrollback: ([\d_]+),/);
    expect(kept, "the pane's scrollback").toBe(10_000);
    expect(mount.match(/\bscrollback:/g), "set once, in the one Terminal the stage makes").toHaveLength(1);
    const sessions = read("../../server/terminal-sessions.mjs");
    expect(lines(sessions, /export const PANE_HISTORY = ([\d_]+);/), "the deck's tmux history-limit").toBe(kept);
    expect(sessions).toMatch(/\["set-option", "-g", "history-limit", String\(PANE_HISTORY\)\]/);
    const socket = read("../../server/terminal-bridge.mjs");
    expect(lines(socket, /export const SEED_HISTORY = ([\d_]+);/), "a reattach's seed fits in what the pane keeps").toBeLessThan(kept);
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
    expect(r.open).toHaveBeenCalledWith(REF, {}, { cols: 120, rows: 40 }, { fg: "#e6e6e6", bg: "#14161b" });
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

describe("a session with no tmux, which says instead what xterm answers itself", () => {
  it("hands the deck's list to the terminal in the order of the bytes, and never a list from a socket that is no longer speaking", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "session", ref: REF });
    await flush();
    const s = r.sockets[0];
    s.open();
    s.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    s.text({ t: "replies", v: 1, view: ["osc11", "decrqm-dec", "xtversion"] });
    s.text({ t: "reset", cols: 120, rows: 40 });
    s.binary(enc("SEED"));
    expect(r.terminal().answers, "applied as xterm parses up to it, not before").toEqual([]);
    r.terminal().parse();
    expect(r.terminal().versions, "the connection starts unknown, which also clears any list").toEqual([null]);
    expect(r.terminal().answers).toEqual([["decrqm-dec", "osc11"]]);

    ctl.show({ kind: "session", ref: OTHER });
    await flush();
    const t = r.sockets[1];
    t.open();
    t.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    s.text({ t: "replies", v: 1, view: ["da"] });
    t.text({ t: "replies", v: 2, view: ["da"] });
    r.terminal().parse();
    expect(r.terminal().versions.at(-1), "the new connection starts unknown again").toBeNull();
    expect(r.terminal().answers, "nothing from the old socket, nothing from a frame this bundle cannot read").toEqual([["decrqm-dec", "osc11"]]);
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
    expect(r.launch).toHaveBeenCalledWith({ agent: "claude", cwd: "/w", key: "n9", size: { cols: 132, rows: 41 }, launch: { model: "haiku", permissionMode: "plan" } });
  });

  it("starts it in the stage's colours, so a program asking at its first frame is told the deck's", async () => {
    const { r, ctl } = rig();
    ctl.setTheme({ foreground: "#E6E6E6", background: "rgb(250, 250, 248)" });
    ctl.mount(HOST, { theme: { foreground: "#E6E6E6", background: "rgb(250, 250, 248)" }, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "launch", agent: "codex", cwd: "/w", key: "n10" });
    await flush();
    expect(r.launch.mock.calls[0][0]).toMatchObject({ agent: "codex", colours: { fg: "#e6e6e6", bg: "#fafaf8" } });
  });

  it("never starts a second agent on Try again once the launch has started one", async () => {
    // A Codex launch answers no session id, so the stage can only reach it
    // by the launch's own ticket. Try again after its connection was lost
    // ran the launch again: a second Codex in the same folder, one press
    // (or a stray Space) away.
    const { r, ctl } = rig();
    r.launch.mockResolvedValueOnce({ ok: true, sessionId: "", name: "ccdeck-codex-9f8e7d6c", ticket: "launched" } as Launched);
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "launch", agent: "codex", cwd: "/w", key: "n11" });
    await flush();
    const s = r.sockets[0];
    s.open();
    s.text({ t: "exit", reason: "error", message: "The deck lost its connection to tmux." });
    expect(r.last().phase).toMatchObject({ kind: "error" });
    ctl.retry();
    await flush();
    expect(r.launch, "launched once").toHaveBeenCalledTimes(1);
    expect(r.last().phase).toEqual({ kind: "error", message: "This session started without a name the deck can find it by yet. Open it from the board." });

    // A launch the deck refused started nothing, and Try again asks again.
    r.launch.mockResolvedValueOnce(failure(500, "tmux could not start the session."));
    ctl.show({ kind: "launch", agent: "codex", cwd: "/w", key: "n12" });
    await flush();
    expect(r.last().phase).toEqual({ kind: "error", message: "tmux could not start the session." });
    ctl.retry();
    await flush();
    expect(r.launch).toHaveBeenCalledTimes(3);
    // By the same key, which is how the deck tells a launch asked again whose
    // first answer never came (it started an agent) from a new one.
    expect(r.launch.mock.calls[1][0].key).toBe("n12");
    expect(r.launch.mock.calls[2][0].key).toBe("n12");
  });

  it("says starting, reports the launched session, and attaches with the launch's own ticket", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    ctl.show({ kind: "launch", agent: "claude", cwd: "/home/u/personal/ccdeck", key: "n1" });
    expect(r.last().phase).toEqual({ kind: "starting", agent: "claude", cwd: "/home/u/personal/ccdeck" });
    await flush();
    expect(r.launch, "at the size the pane will show it at").toHaveBeenCalledWith({ agent: "claude", cwd: "/home/u/personal/ccdeck", key: "n1", size: { cols: 80, rows: 24 } });
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
    expect(r.last().subject, "and says so, for the stage to match it against what it shows").toBe(subjectKey({ kind: "session", ref: OTHER }));
  });

  it("keeps a Codex launch's connection for the session the stage says it became, and only that one", async () => {
    // Codex is answered no id, so the launch's own answer cannot name the
    // session; the stage, which asked the deck, says which launch it came from.
    const codexRef = { sessionId: "019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5b", provider: "codex" as const, cwd: OTHER.cwd };
    for (const [next, kept] of [
      [{ kind: "session", ref: codexRef, launch: "n1" }, true],
      [{ kind: "session", ref: codexRef }, false],
      [{ kind: "session", ref: codexRef, launch: "n0" }, false],
    ] as const) {
      const { r, ctl } = rig();
      r.launch.mockResolvedValueOnce({ ok: true, sessionId: "", name: "ccdeck-codex-9f8e7d6c", ticket: "launched" } as Launched);
      ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
      await flush();
      ctl.show({ kind: "launch", agent: "codex", cwd: OTHER.cwd, key: "n1" });
      await flush();
      ctl.show(next);
      await flush();
      const label = JSON.stringify(next);
      if (kept) {
        expect(r.sockets[0].closedWith, label).toEqual([]);
        expect(r.open, label).not.toHaveBeenCalled();
      } else {
        expect(r.open, `${label}: a switch, attached afresh`).toHaveBeenCalled();
      }
    }
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

/** The engine's own refusals of a launch, in its own words: the Windows
 *  console's (agent-missing, full, stopping, host-generations), and for
 *  `exists`, which only an attach is ever answered, the tmux backend's. */
const ENGINE_SAID = {
  "agent-missing": "Claude Code is not installed here as a program the deck can start. Install it with the standalone installer or WinGet.",
  exists: "The deck is already attached to that session.",
  full: "The deck is running as many sessions as it can; end one to start another.",
  stopping: "The deck is stopping, so it starts nothing new.",
  "host-generations": "Sessions still run on two older session hosts. End or restart them to start new sessions.",
} as const;

describe("the Command Panel's engine refusing (pro-engine-host-v1.md, Refusals)", () => {
  const NOT_INSTALLED = "The Command Panel's engine is not installed on this machine.";
  const refusal = (status: number, code: string, error: string): ApiFailure => ({ ok: false, status, error, code } as ApiFailure);
  const restarting = () => refusal(503, "restarting", "The Command Panel's engine is restarting.");

  it("shows a state of this machine as it is, without asking about tmux, and checks again in place", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValueOnce(refusal(409, "not-installed", NOT_INSTALLED)).mockResolvedValueOnce(refusal(409, "not-installed", NOT_INSTALLED));
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.last().phase).toEqual({ kind: "error", message: NOT_INSTALLED, code: "not-installed", busy: false });
    expect(r.status, "an engine's state is not tmux's").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS);
    expect(r.open, "a state is not waited out: asked once").toHaveBeenCalledTimes(1);

    ctl.retry();
    expect(r.last().phase, "Check again keeps the sentence up").toEqual({ kind: "error", message: NOT_INSTALLED, code: "not-installed", busy: true });
    ctl.retry();
    await flush();
    expect(r.open, "a second press while it checks is refused").toHaveBeenCalledTimes(2);
    expect(r.last().phase).toEqual({ kind: "error", message: NOT_INSTALLED, code: "not-installed", busy: false });

    // Installed since: the same press attaches.
    ctl.retry();
    await flush();
    expect(r.open).toHaveBeenCalledTimes(3);
    expect(r.sockets).toHaveLength(1);
  });

  it("keeps a card up when a check finds the engine starting, and attaches once it answers", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValueOnce(refusal(409, "failed", "The Command Panel's engine would not start.")).mockResolvedValueOnce(restarting());
    ctl.show({ kind: "session", ref: REF });
    await flush();
    ctl.retry();
    await flush();
    expect(r.last().phase, "a card, never reconnecting over an empty box").toEqual({ kind: "attaching", reconnect: false });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(r.open).toHaveBeenCalledTimes(3);
    expect(r.sockets).toHaveLength(1);
  });

  it("says a launch's refusal as the engine's state, and never launches again by itself", async () => {
    const { r, ctl } = rig();
    r.launch.mockResolvedValueOnce(refusal(409, "not-verified", "The Command Panel's engine could not be verified, so it was not started."));
    ctl.show({ kind: "launch", agent: "claude", cwd: "/w", key: "n7" });
    await flush();
    expect(r.last().phase).toMatchObject({ kind: "error", code: "not-verified", busy: false });
    expect(r.status, "a 409 of the engine's own is not tmux missing").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS);
    expect(r.launch).toHaveBeenCalledTimes(1);
  });

  /** The deck's 409 answer to a launch, read by the page's own terminal-api, as the stage reads it. */
  const answered = (r: Rig, body: Record<string, unknown>) =>
    r.launch.mockImplementationOnce(req => launchTerminal(req as Parameters<typeof launchTerminal>[0], {
      fetchFn: async () => ({ ok: false, status: 409, json: async () => body }) as unknown as Response,
    }));

  it("says the engine's own refusal of a launch in its words, never the tmux card, even where there is no tmux", async () => {
    for (const [code, said] of Object.entries(ENGINE_SAID)) {
      const { r, ctl } = rig();
      answered(r, { ok: false, error: said, code });
      // A deck with no tmux at all (Windows), had it been asked.
      r.status.mockResolvedValue({ ok: true, platform: "win32", tmux: { ok: false, reason: "unsupported" } });
      ctl.show({ kind: "launch", agent: "claude", cwd: "C:\\lab\\home\\projects\\demo", key: "n9" });
      await flush();
      await flush();
      // A Claude session refused for want of Claude Code is marked so, and its
      // card offers to install it (ClaudeInstall.tsx); the sentence is kept.
      expect(r.last().phase, `${code}: the engine's sentence, with Try again and Not now`)
        .toEqual(code === "agent-missing" ? { kind: "error", message: said, missing: "claude" } : { kind: "error", message: said });
      expect(r.status, `${code}: the engine's 409 is not tmux missing`).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS);
      expect(r.launch, `${code}: never launched again by itself`).toHaveBeenCalledTimes(1);

      // Try again is the reader's press: the same launch, by its key, once.
      ctl.retry();
      await flush();
      expect(r.launch, code).toHaveBeenCalledTimes(2);
      expect(r.launch.mock.calls[1][0], code).toMatchObject({ agent: "claude", key: "n9" });
      ctl.dispose();
    }
  });

  it("on Linux, keeps the code of a launch refused for want of Claude, so the card can offer to install it", async () => {
    const said = "Claude Code is not installed on this machine.";
    const { r, ctl } = rig();
    answered(r, { ok: false, error: said, code: "agent-missing" });
    ctl.show({ kind: "launch", agent: "claude", cwd: "/w", key: "n10" });
    await flush();
    await flush();
    expect(r.last().phase).toEqual({ kind: "error", message: said, missing: "claude" });
    expect(r.status, "not tmux's").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS);
    expect(r.launch, "never launched again by itself").toHaveBeenCalledTimes(1);

    // Installed: the card asks once (its onInstalled is the stage's retry),
    // and that is the same launch, by its key, once.
    ctl.retry();
    await flush();
    expect(r.launch).toHaveBeenCalledTimes(2);
    expect(r.launch.mock.calls[1][0]).toMatchObject({ agent: "claude", key: "n10" });
    await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS);
    expect(r.launch, "and no more").toHaveBeenCalledTimes(2);
  });

  it("says a Codex launch refused for want of Codex as it always has: its sentence, with Try again", async () => {
    const said = "Codex is not installed on this machine.";
    const { r, ctl } = rig();
    answered(r, { ok: false, error: said, code: "agent-missing" });
    ctl.show({ kind: "launch", agent: "codex", cwd: "/w", key: "n11" });
    await flush();
    await flush();
    expect(r.last().phase).toEqual({ kind: "error", message: said });
  });

  it("marks a Claude session's open refused for want of Claude, and a Codex one's not", async () => {
    for (const provider of ["claude", "codex"] as const) {
      const { r, ctl } = rig();
      r.open.mockResolvedValueOnce(refusal(409, "agent-missing", "not installed"));
      ctl.show({ kind: "session", ref: { ...REF, provider } });
      await flush();
      expect(r.last().phase, provider).toEqual(provider === "claude"
        ? { kind: "error", message: "not installed", missing: "claude" }
        : { kind: "error", message: "not installed" });
      ctl.dispose();
    }
  });

  it("offers a launch the engine refused for a moment again, by its key, only when pressed", async () => {
    const { r, ctl } = rig();
    r.launch.mockResolvedValueOnce(restarting());
    ctl.show({ kind: "launch", agent: "codex", cwd: "/w", key: "n8" });
    await flush();
    expect(r.last().phase, "a moment is not a state of the machine").toEqual({ kind: "error", message: "The Command Panel's engine is restarting." });
    await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS);
    expect(r.launch, "not asked again by itself: nothing starts that was not pressed for").toHaveBeenCalledTimes(1);
    ctl.retry();
    await flush();
    expect(r.launch).toHaveBeenCalledTimes(2);
    expect(r.launch.mock.calls[1][0].key, "the same launch, which the deck keeps to one agent").toBe("n8");
    expect(r.launched).toHaveLength(1);
  });

  it("waits out a moment's refusal on a first open, its card kept up, and attaches once the engine is back", async () => {
    const { r, ctl } = rig();
    r.open.mockResolvedValueOnce(restarting());
    ctl.show({ kind: "session", ref: REF });
    await flush();
    expect(r.last().phase, "the card, not an empty box").toEqual({ kind: "attaching", reconnect: false });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(r.open).toHaveBeenCalledTimes(2);
    expect(r.sockets).toHaveLength(1);
    expect(r.last().phase).toEqual({ kind: "attaching", reconnect: false });
  });

  it("reconnects while the engine restarts under a live pane, and gives up naming the engine, not the deck", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    r.open.mockResolvedValue(restarting());
    // The deck closes a relayed socket 1011 when its engine goes.
    s.drop(1011);
    expect(r.last().phase, "the frozen frame stays up").toEqual({ kind: "attaching", reconnect: true });
    for (let i = 0; i < 40 && r.last().phase.kind === "attaching"; i++) {
      r.clock.now += 5000;
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(r.open.mock.calls.length).toBeGreaterThan(3);
    expect(r.last().phase).toEqual({ kind: "error", message: "The Command Panel's engine did not come back. The session is still running in tmux; try again in a moment." });
  });

  it("on Windows, gives up naming the session host, never the deck's tmux", async () => {
    const { r, ctl } = rig({ windows: true });
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    r.open.mockResolvedValue(restarting());
    s.drop(1011);
    for (let i = 0; i < 40 && r.last().phase.kind === "attaching"; i++) {
      r.clock.now += 5000;
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(r.last().phase).toEqual({ kind: "error", message: ENGINE_NO_RETURN_WINDOWS });
    expect(ENGINE_NO_RETURN_WINDOWS).toBe("The Command Panel's engine did not come back. The session is still running in the session host; try again in a moment.");
    expect(ENGINE_NO_RETURN).toBe("The Command Panel's engine did not come back. The session is still running in tmux; try again in a moment.");
  });

  it("answers a state of the machine met while reconnecting at once", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await flush();
    const s = await attach(r, ctl);
    r.open.mockResolvedValueOnce(refusal(409, "failed", "The Command Panel's engine would not start."));
    s.drop(1011);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(r.last().phase).toEqual({ kind: "error", message: "The Command Panel's engine would not start.", code: "failed", busy: false });
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
    expect(r.launch.mock.calls[1][0]).toEqual({ agent: "claude", cwd: "/w", key: "n3", size: { cols: 80, rows: 24 } });
    expect(r.sockets).toHaveLength(1);
  });

  it("carries how far the download has got to the card, drawing only what changed", async () => {
    const at = (progress: unknown) => ({ ok: true, platform: "linux", tmux: { ok: false, reason: "installing", progress } }) as TerminalStatus;
    const half = { stage: "downloading", received: 550_000, total: 1_100_000 };
    const { r, ctl } = rig();
    r.launch.mockResolvedValueOnce(refused());
    r.status.mockResolvedValueOnce(INSTALLING).mockResolvedValueOnce(at(half)).mockResolvedValueOnce(at(half))
      .mockResolvedValueOnce(failure(null)).mockResolvedValueOnce(at({ stage: "checking" })).mockResolvedValueOnce(READY);
    ctl.show({ kind: "launch", agent: "codex", cwd: "/w", key: "n7" });
    await flush();
    expect(r.last().phase, "the deck has not said yet").toEqual({ kind: "tmux-installing" });
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    expect(r.last().phase).toEqual({ kind: "tmux-installing", progress: half });
    const drawn = r.snaps.length;
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    expect(r.snaps.length, "the same answer draws nothing").toBe(drawn);
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    expect(r.last().phase, "a deck that blinks leaves the bar where it was").toEqual({ kind: "tmux-installing", progress: half });
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    expect(r.last().phase).toEqual({ kind: "tmux-installing", progress: { stage: "checking" } });
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    await flush();
    expect(r.launch).toHaveBeenCalledTimes(2);
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

// THE EMPTY BOARD'S NEW SESSION ON A MACHINE WITH NO TMUX IT CAN USE (V4
// onboarding). The button stays, and asks nothing first: its form's Start is a
// launch like any other (use-stage.test.ts, "stays on the launch a Start
// made"). The engine refuses that launch for want of tmux, 409
// `tmux-unavailable`, which the page keeps no code for (terminal-api.test.ts),
// so the stage asks the status — the route that, where the engine calls the
// machine fixable, fetches ccdeck's own tmux for a missing one or one older
// than 3.2 alike (terminal-routes.mjs withOwnTmux, pro-engine-routes.test.ts)
// — shows the fetch with its progress, and starts the session once tmux is
// there. Each case starts from the deck's real 409, read by terminal-api.
describe("New session from the empty board, on a machine with no tmux it can use", () => {
  const LAUNCH: StageSubject = { kind: "launch", agent: "claude", cwd: "/home/u/code/paycore", key: "hero-1" };
  /** The deck's 409 for a launch, read by the page's own terminal-api. */
  const refusedWith = (r: Rig, body: Record<string, unknown>) =>
    r.launch.mockImplementationOnce(req => launchTerminal(req as Parameters<typeof launchTerminal>[0], {
      fetchFn: async () => ({ ok: false, status: 409, json: async () => body }) as unknown as Response,
    }));
  const noTmux = (r: Rig) => refusedWith(r, { ok: false, error: "tmux is not available on this machine.", code: "tmux-unavailable" });
  const status = (tmux: TerminalStatus["tmux"], platform = "linux") => ({ ok: true, platform, tmux }) as TerminalStatus;

  it("with a tmux it can use, starts the session at once and asks nothing about tmux", async () => {
    const { r, ctl } = rig();
    ctl.show(LAUNCH);
    expect(r.last().phase).toEqual({ kind: "starting", agent: "claude", cwd: "/home/u/code/paycore" });
    await flush();
    expect(r.launch).toHaveBeenCalledTimes(1);
    expect(r.status, "no question before the launch: the press waits on nothing").not.toHaveBeenCalled();
    expect(r.launched).toHaveLength(1);
    expect(r.sockets).toHaveLength(1);
  });

  it("with none, or one too old, that the deck can fetch: shows the fetch and how far it has got, then starts the session it was asked for, once", async () => {
    const half = { stage: "downloading", received: 550_000, total: 1_100_000 } as const;
    const { r, ctl } = rig();
    noTmux(r);
    r.status.mockResolvedValueOnce(status({ ok: false, reason: "installing" }))
      .mockResolvedValueOnce(status({ ok: false, reason: "installing", progress: half }))
      .mockResolvedValueOnce(status({ ok: true, version: "3.8" }));
    ctl.show(LAUNCH);
    await flush();
    await flush();
    expect(r.last().phase, "the deck's own tmux on its way, before it has said how far").toEqual({ kind: "tmux-installing" });
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    expect(r.last().phase).toEqual({ kind: "tmux-installing", progress: half });
    expect(r.launch, "nothing started while it is on its way").toHaveBeenCalledTimes(1);
    expect(r.launched).toEqual([]);
    await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS);
    await flush();
    expect(r.status).toHaveBeenCalledTimes(3);
    expect(r.launch).toHaveBeenCalledTimes(2);
    expect(r.launch.mock.calls[1][0], "the same launch, by its key: one agent").toMatchObject({ agent: "claude", cwd: "/home/u/code/paycore", key: "hero-1" });
    const kinds = r.snaps.map(s => s.phase.kind);
    expect(kinds.slice(kinds.lastIndexOf("tmux-installing")), "starting again once tmux is there").toContain("starting");
    expect(r.launched, "one session started").toHaveLength(1);
    expect(r.sockets).toHaveLength(1);
  });

  it("where the fetch failed, or the deck cannot fetch one here, says the tmux message it always has, and starts nothing by itself", async () => {
    const cases: Array<[TerminalStatus[], unknown]> = [
      // Offline, or a build that was not the pinned one: the plain fact, why, and the install line.
      [[status({ ok: false, reason: "installing" }), status({ ok: false, reason: "missing", install: "brew install tmux", download: "download_failed" })],
        { kind: "tmux-missing", reason: "missing", install: "brew install tmux", download: "download_failed", busy: false }],
      // No fetch here (downloads switched off, no build for this machine): the engine's answer as it is.
      [[status({ ok: false, reason: "too-old", version: "3.1", install: "sudo apt install tmux" })],
        { kind: "tmux-missing", reason: "too-old", install: "sudo apt install tmux", busy: false }],
    ];
    for (const [answers, card] of cases) {
      const { r, ctl } = rig();
      noTmux(r);
      for (const answer of answers) r.status.mockResolvedValueOnce(answer);
      ctl.show(LAUNCH);
      await flush();
      await flush();
      await vi.advanceTimersByTimeAsync(TMUX_SETUP_POLL_MS * (answers.length - 1));
      expect(r.last().phase).toEqual(card);
      await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS);
      expect(r.status, "asked no more once it is a fact").toHaveBeenCalledTimes(answers.length);
      expect(r.launch, "the launch is not asked again by itself").toHaveBeenCalledTimes(1);
      expect(r.launched).toEqual([]);
      ctl.dispose();
    }
  });

  it("on Windows, which needs no tmux, is as it was: a launch goes through, a refusal is said as it is, and tmux is never asked about", async () => {
    const started = rig({ windows: true });
    started.ctl.show({ kind: "launch", agent: "claude", cwd: "C:\\lab\\paycore", key: "hero-2" });
    await flush();
    expect(started.r.launched).toHaveLength(1);
    expect(started.r.status).not.toHaveBeenCalled();

    const { r, ctl } = rig({ windows: true });
    refusedWith(r, { ok: false, error: "The session host could not start the session." });
    ctl.show({ kind: "launch", agent: "claude", cwd: "C:\\lab\\paycore", key: "hero-3" });
    await flush();
    await flush();
    expect(r.last().phase).toEqual({ kind: "error", message: "The session host could not start the session." });
    await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS);
    expect(r.status, "no tmux to ask about").not.toHaveBeenCalled();
    expect(r.launch).toHaveBeenCalledTimes(1);
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

  it("exposes synchronous prompt sending and blocks the render-to-effect target gap and unmount", async () => {
    const { r, seen, Probe, props } = hookRig();
    let duringCommit: (() => void) | undefined;
    const m = mountComponent(Probe, props({ kind: "session", ref: REF }), {
      commit: () => {
        seen.at(-1)!.hostRef.current = HOST as HTMLDivElement;
        duringCommit?.();
      },
    });
    await flush();
    const s = r.sockets[0];
    s.open();
    s.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    s.text({ t: "reset", cols: 120, rows: 40 });
    s.binary(enc("seed"));
    r.terminal().parse();
    s.sent.length = 0;
    const send = seen.at(-1)!.sendPrompt;
    expect(send("Bună\n世界", REF_SUBJECT)).toBe("sent");
    expect(s.sent).toEqual([JSON.stringify({ t: "paste", text: "Bună\n世界" }), enc("\r")]);
    s.sent.length = 0;
    duringCommit = () => { expect(send("wrong target", REF_SUBJECT)).toBe("unavailable"); };
    m.rerender(props({ kind: "session", ref: OTHER }));
    duringCommit = undefined;
    await flush();
    expect(seen.at(-1)!.sendPrompt).toBe(send);
    expect(s.sent).toEqual([]);
    const next = r.sockets[1];
    next.open();
    next.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    next.text({ t: "reset", cols: 120, rows: 40 });
    next.binary(enc("new target"));
    r.terminal().parse();
    expect(next.sentBytes()).toEqual([]);
    expect(next.sentText().filter(frame => frame.t === "paste")).toEqual([]);
    expect(send("stale draft", REF_SUBJECT)).toBe("unavailable");
    expect(next.sentBytes()).toEqual([]);
    expect(next.sentText().filter(frame => frame.t === "paste")).toEqual([]);
    expect(send("new prompt", OTHER_SUBJECT)).toBe("sent");
    m.unmount();
    expect(send("after unmount", OTHER_SUBJECT)).toBe("unavailable");
  });

  it("opens the subject it is given, switches when it changes, and leaves when the stage unmounts", async () => {
    const { r, seen, Probe, props } = hookRig();
    const m = mountComponent(Probe, props({ kind: "session", ref: REF }));
    await flush();
    // CHANGED ON PURPOSE: open sends size and colours like adopt (managed Codex attach)
    expect(r.open).toHaveBeenCalledWith(REF, {}, { cols: 120, rows: 40 }, undefined);
    expect(seen.at(-1)!.phase).toEqual({ kind: "attaching", reconnect: false });
    r.sockets[0].open();
    m.rerender(props({ kind: "session", ref: OTHER }));
    await flush();
    expect(r.sockets[0].closedWith).toEqual([1000]);
    // CHANGED ON PURPOSE: open sends size and colours like adopt (managed Codex attach)
    expect(r.open).toHaveBeenLastCalledWith(OTHER, {}, { cols: 120, rows: 40 }, undefined);
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

  it("blinks as a native terminal's does, except for a reader who asked the OS for less motion", () => {
    // mountXterm's options (source-pinned: they need a real xterm).
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../use-terminal-session.ts"), "utf8");
    const mount = src.slice(src.indexOf("export const mountXterm"), src.indexOf("// The controller."));
    expect(mount).toMatch(/\n\s*cursorBlink: !prefersReducedMotion\(\),/);
    expect(mount.match(/\bcursorBlink:/g), "set once, in the one Terminal the stage makes").toHaveLength(1);
    expect(src).toMatch(/import \{ prefersReducedMotion \} from "\.\/viewport-motion";/);
  });

  it("still finds the flag where the installed xterm keeps it, so an upgrade that moves it fails here and not silently", () => {
    const xterm = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "@xterm", "xterm", "src");
    const pub = readFileSync(resolve(xterm, "browser/public/Terminal.ts"), "utf8");
    expect(pub).toMatch(/private _core: ITerminal/);
    const core = readFileSync(resolve(xterm, "common/services/CoreService.ts"), "utf8");
    expect(core).toMatch(/public isCursorInitialized: boolean = false/);
  });
});

describe("a key let go outside the pane", () => {
  it("is forgotten, so the text an emoji panel or dictation sends next is not dropped", () => {
    const term = { _core: { _keyDownSeen: true, _keyPressHandled: true, other: 1 } };
    forgetKeyInFlight(term);
    expect(term._core).toEqual({ _keyDownSeen: false, _keyPressHandled: false, other: 1 });
  });

  it("leaves a terminal without those flags as it is, rather than inventing them", () => {
    const term = { _core: {} as Record<string, unknown> };
    forgetKeyInFlight(term);
    expect(term._core).toEqual({});
    expect(() => forgetKeyInFlight(null)).not.toThrow();
    expect(() => forgetKeyInFlight({})).not.toThrow();
  });

  it("is forgotten each time the pane loses the keys, before the stage hears of it", () => {
    // mountXterm's blur (source-pinned: it needs a real xterm).
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../use-terminal-session.ts"), "utf8");
    const mount = src.slice(src.indexOf("export const mountXterm"), src.indexOf("// The controller."));
    expect(mount).toMatch(/const onBlur = \(\) => \{\s*forgetKeyInFlight\(term\);\s*events\.onFocusChange\(false\);\s*\};/);
    expect(mount).toMatch(/textarea\?\.addEventListener\("blur", onBlur\);/);
    expect(mount).toMatch(/textarea\?\.removeEventListener\("blur", onBlur\);/);
  });

  it("still finds xterm keeping that mark until a keyup of its own, so an upgrade that changes it fails here", () => {
    const xterm = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "@xterm", "xterm");
    const core = readFileSync(resolve(xterm, "src/browser/CoreBrowserTerminal.ts"), "utf8");
    expect(core).toMatch(/private _keyDownSeen: boolean = false;/);
    expect(core).toMatch(/private _keyPressHandled: boolean = false;/);
    // Text with no key is dropped while either is set …
    expect(core).toMatch(/if \(ev\.data && ev\.inputType === 'insertText' && \(!ev\.composed \|\| !this\._keyDownSeen\)[^\n]*\{\s*if \(this\._keyPressHandled\) \{\s*return false;/);
    // … and only a keyup in its textarea clears the first: its blur does not.
    expect(core.match(/this\._keyDownSeen = false;/g)).toHaveLength(1);
    const keyUp = core.slice(core.indexOf("protected _keyUp(ev: KeyboardEvent): void {"));
    expect(keyUp).toMatch(/^protected _keyUp\(ev: KeyboardEvent\): void \{\s*this\._keyDownSeen = false;/);
    const blur = core.slice(core.indexOf("private _handleTextAreaBlur(): void {"), core.indexOf("private _syncTextArea(): void {"));
    expect(blur).not.toMatch(/_keyDownSeen|_keyPressHandled/);
    // The bundle the deck loads keeps the names the fix sets.
    const bundle = readFileSync(resolve(xterm, "lib/xterm.mjs"), "utf8");
    expect(bundle).toMatch(/\._keyDownSeen=/);
    expect(bundle).toMatch(/\._keyPressHandled=/);
  });
});

describe("the pane's own text size (terminal-text-size.ts)", () => {
  // The chord follows the platform (⌘ on a Mac, Ctrl elsewhere), and Node
  // reports the runner's own: pinned here, so a macOS runner reads these
  // Ctrl cases as Linux does. The Mac case below pins a Mac.
  beforeEach(() => { vi.stubGlobal("navigator", { platform: "Linux x86_64" }); forgetTerminalTextStep(); setTerminalTextStep(100); });
  afterEach(() => { setTerminalTextStep(100); forgetTerminalTextStep(); vi.unstubAllGlobals(); });

  it("Ctrl+= and Ctrl+- zoom the pane's text on the keydown, kept from xterm and from the browser", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await attach(r, ctl);
    const s = r.sockets[r.sockets.length - 1];
    const sent = s.sentBytes().length;
    expect(r.events().onKey(key({ key: "=", ctrlKey: true }))).toBe(false);
    expect(terminalTextStep()).toBe(110);
    expect(r.events().onKey(key({ type: "keyup", key: "=", ctrlKey: true })), "kept on the keyup too").toBe(false);
    expect(terminalTextStep(), "and stepped once, on the keydown").toBe(110);
    expect(r.events().onKey(key({ key: "-", ctrlKey: true }))).toBe(false);
    expect(r.events().onKey(key({ key: "-", ctrlKey: true }))).toBe(false);
    expect(terminalTextStep()).toBe(90);
    expect(r.events().onKey(key({ key: "0", ctrlKey: true }))).toBe(false);
    expect(terminalTextStep()).toBe(100);
    expect(s.sentBytes().length, "nothing of it reached the session").toBe(sent);
    expect(r.events().onKey(key({ key: "_", ctrlKey: true, shiftKey: true })), "Ctrl+_ is the session's undo").toBe(true);
  });

  it("on a Mac only ⌘ zooms; Ctrl+= stays the session's", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await attach(r, ctl);
    expect(r.events().onKey(key({ key: "=", ctrlKey: true })), "Ctrl+= goes on to xterm").toBe(true);
    expect(terminalTextStep()).toBe(100);
    expect(r.events().onKey(key({ key: "=", metaKey: true }))).toBe(false);
    expect(terminalTextStep()).toBe(110);
    expect(r.events().onKey(key({ key: "0", metaKey: true }))).toBe(false);
    expect(terminalTextStep()).toBe(100);
  });

  it("a new size goes to the terminal and the cell is measured again, so the stage refits its columns", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace", fontSize: 13.3 });
    await attach(r, ctl);
    expect(r.cells).toEqual([{ w: 8, h: 18 }]);
    ctl.setFontSize(26.6);
    expect(r.terminal().fontSizes).toEqual([26.6]);
    expect(r.cells[r.cells.length - 1]).toEqual({ w: 16, h: 36 });
    expect(r.last().cell).toEqual({ w: 16, h: 36 });
    ctl.setFontSize(13.3);
    expect(r.cells[r.cells.length - 1]).toEqual({ w: 8, h: 18 });
  });

  it("a size set before xterm has loaded is the one it opens at", async () => {
    const { r, ctl } = rig({ lazyMount: true });
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace", fontSize: 13.3 });
    ctl.setFontSize(19.95);
    r.resolveMount();
    await flush();
    expect(r.terminal().fontSizes).toEqual([19.95]);
    expect(r.cells[r.cells.length - 1].w).toBeCloseTo(12, 5);
  });

  it("a disposed session sizes nothing", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    await attach(r, ctl);
    ctl.dispose();
    ctl.setFontSize(20);
    expect(r.terminal().fontSizes).toEqual([]);
  });
});

describe("an opencode or Copilot session on the stage", () => {
  // Each runs in a terminal of its own the deck did not start and cannot
  // reach, and the engine knows no such provider: asked as Claude's, a Copilot
  // UUID could reopen Claude Code on another CLI's conversation.
  const OC: SessionRef = { sessionId: "ses_4b2f9c1a7e3dXk2mQp8R", provider: "opencode", cwd: "/home/u/billing" };
  const CP: SessionRef = { sessionId: "9a8b7c6d-1111-4222-8333-444455556666", provider: "copilot", cwd: "/home/u/docs" };

  it("asks the engine nothing and shows the card at once, with nothing to reopen", async () => {
    for (const [ref, name] of [[OC, "OpenCode"], [CP, "GitHub Copilot"]] as const) {
      const { r, ctl } = rig();
      ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
      ctl.show({ kind: "session", ref });
      await flush();
      expect(r.open, name).not.toHaveBeenCalled();
      expect(r.sockets).toHaveLength(0);
      expect(r.snaps.some(s => s.phase.kind === "attaching"), "no attaching before the card").toBe(false);
      expect(r.last().phase).toEqual({
        kind: "not-attachable",
        target: { kind: "unsupported", label: en[EVENTS_ONLY_MSG].replace("{agent}", name), adoptable: false },
        stillRunning: false,
        busy: false,
      });
      expect(eventsOnlyPhase(ref.provider)).toEqual(r.last().phase);
      ctl.dispose();
    }
  });

  it("neither Reopen here nor Check again reaches the engine", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    ctl.show({ kind: "session", ref: CP });
    await flush();
    ctl.adopt();
    ctl.retry();
    await flush();
    expect(r.adopt).not.toHaveBeenCalled();
    expect(r.open).not.toHaveBeenCalled();
    expect(r.launch).not.toHaveBeenCalled();
    expect(r.last().phase.kind).toBe("not-attachable");
    ctl.dispose();
  });

  it("a Claude session shown after it attaches as before", async () => {
    const { r, ctl } = rig();
    ctl.mount(HOST, { theme: THEME, fontFamily: "monospace" });
    ctl.show({ kind: "session", ref: OC });
    await flush();
    await attach(r, ctl, REF);
    expect(r.open).toHaveBeenCalledTimes(1);
    expect(r.open.mock.calls[0][0]).toEqual(REF);
    expect(r.last().phase.kind).toBe("live");
    ctl.dispose();
  });
});
