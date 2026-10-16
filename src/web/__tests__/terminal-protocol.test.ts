// The terminal panel's socket protocol, driven through a fake WebSocket.
//
// The panel's half of the conversation is the half a browser hides: whether a
// size sent before the socket opened ever goes up, whether a seed is paired
// with the reset it belongs to, whether a close after an `exit` is reported as
// a second ending. None of that is visible until a terminal draws the wrong
// thing, so every case below plays the deck's side frame by frame and reads
// back exactly what the panel was told and what it sent.
//
// The fake is the WebSocket surface terminal-protocol.ts declares it uses
// (SocketLike) and nothing more, so a case cannot pass by leaning on a method
// the real socket lacks.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  INPUT_CHUNK_BYTES,
  MAX_MESSAGE_BYTES,
  TERMINAL_ATTACH_PATH,
  connectTerminal,
  hexColour,
  parseServerMessage,
  socketUrl,
  type TerminalExit,
  type TerminalFailure,
  type TerminalHello,
  type TerminalReset,
  type TerminalSize,
} from "../terminal-protocol";
import { withoutComments } from "./tsx-scan";
// @ts-expect-error — plain .mjs server module, no types
import { DEFAULT_MAX_MESSAGE_BYTES } from "../../server/ws-frames.mjs";

/** A WebSocket the test drives: it records what the panel sent and lets the
 *  case play the deck's frames and the browser's events. */
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
    // Copied, because the panel may hand over a view of a buffer it reuses.
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data));
  }
  close(code?: number) {
    this.closedWith.push(code);
    this.readyState = 2;
  }

  // The deck's side, and the browser's.
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  text(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  binary(bytes: number[] | Uint8Array) {
    const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.onmessage?.({ data: view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) });
  }
  fail(code = 1006) {
    this.onerror?.({});
    this.readyState = 3;
    this.onclose?.({ code });
  }
  sentText() {
    return this.sent.filter((f): f is string => typeof f === "string").map(f => JSON.parse(f));
  }
  sentBytes() {
    return this.sent.filter((f): f is Uint8Array => typeof f !== "string");
  }
}

/** A connection over a fresh fake, with every callback recorded in order. */
function connect(extra: { ticket?: string; url?: string; base?: string } = {}) {
  const sockets: FakeSocket[] = [];
  const told: Array<[string, unknown]> = [];
  const conn = connectTerminal({
    ticket: extra.ticket ?? "t1ck3t",
    url: extra.url,
    base: extra.base ?? "http://127.0.0.1:4318/",
    createSocket: (url: string) => {
      const ws = new FakeSocket(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
    onHello: (h: TerminalHello) => told.push(["hello", h]),
    onReset: (r: TerminalReset) => told.push(["reset", { cols: r.cols, rows: r.rows, seed: [...r.seed] }]),
    onData: (b: Uint8Array) => told.push(["data", [...b]]),
    onSize: (s: TerminalSize) => told.push(["size", s]),
    onTmux: (v: readonly [number, number]) => told.push(["tmux", v]),
    onExit: (e: TerminalExit) => told.push(["exit", e]),
    onError: (f: TerminalFailure) => told.push(["error", f]),
  });
  expect(sockets, "connectTerminal should open exactly one socket").toHaveLength(1);
  return { conn, ws: sockets[0], told };
}

describe("where the socket goes", () => {
  it("asks the page's own origin for the attach path, over ws, with the ticket", () => {
    const { ws } = connect({ ticket: "abc_DEF-123" });
    expect(ws.url).toBe("ws://127.0.0.1:4318/api/terminal/attach?ticket=abc_DEF-123");
    expect(TERMINAL_ATTACH_PATH, "the server refuses every other upgrade path").toBe("/api/terminal/attach");
  });

  it("moves an https page to wss, so a deck behind TLS is not asked in clear", () => {
    expect(socketUrl("/api/terminal/attach", "x", "https://deck.example:8443/board"))
      .toBe("wss://deck.example:8443/api/terminal/attach?ticket=x");
  });

  it("encodes a ticket that is not URL-safe rather than letting it split the query", () => {
    const url = new URL(socketUrl(TERMINAL_ATTACH_PATH, "a+b/c=&d", "http://localhost:1/"));
    expect(url.searchParams.get("ticket"), "the deck must read back the ticket it minted").toBe("a+b/c=&d");
    expect([...url.searchParams.keys()]).toEqual(["ticket"]);
  });

  it("takes an absolute ws URL as it is", () => {
    expect(socketUrl("ws://127.0.0.1:9/api/terminal/attach", "t")).toBe("ws://127.0.0.1:9/api/terminal/attach?ticket=t");
  });

  it("asks for binary frames as ArrayBuffers, which arrive in order without an async read", () => {
    expect(connect().ws.binaryType).toBe("arraybuffer");
  });
});

describe("what the panel sends", () => {
  it("holds a size sent before the socket opened and sends it first thing on open", () => {
    // The deck streams nothing until the first size arrives, so a size lost
    // to a not-yet-open socket is a panel that attaches and stays blank.
    const { conn, ws } = connect();
    expect(conn.sendSize(120, 40)).toBe(true);
    expect(conn.sendInput("ls\r")).toBe(true);
    expect(ws.sent, "nothing may be sent on a connecting socket").toEqual([]);
    ws.open();
    expect(ws.sentText()).toEqual([{ t: "size", cols: 120, rows: 40 }]);
    expect(ws.sentBytes().map(b => new TextDecoder().decode(b))).toEqual(["ls\r"]);
    expect(typeof ws.sent[0], "the size has to go up before the input queued after it").toBe("string");
  });

  it("sends whole cells only, and refuses a size that is not one", () => {
    const { conn, ws } = connect();
    ws.open();
    expect(conn.sendSize(80.9, 24.2)).toBe(true);
    for (const [c, r] of [[0, 24], [80, 0], [-3, 10], [NaN, 10], [80, Infinity]]) {
      expect(conn.sendSize(c, r), `${c}×${r}`).toBe(false);
    }
    expect(ws.sentText()).toEqual([{ t: "size", cols: 80, rows: 24 }]);
  });

  it("sends typed text as UTF-8 bytes in a binary frame, never as JSON", () => {
    const { conn, ws } = connect();
    ws.open();
    conn.sendInput("é→✓\x1b[A");
    expect(ws.sentText(), "input in a text frame would be read as a control message").toEqual([]);
    expect(ws.sentBytes().map(b => [...b])).toEqual([[...new TextEncoder().encode("é→✓\x1b[A")]]);
  });

  it("passes raw bytes through untouched", () => {
    const { conn, ws } = connect();
    ws.open();
    conn.sendInput(Uint8Array.from([0x1b, 0x0d, 0x00, 0xff]));
    expect(ws.sentBytes().map(b => [...b])).toEqual([[0x1b, 0x0d, 0x00, 0xff]]);
  });

  it("splits large input into pieces under the deck's message cap, losing nothing", () => {
    const { conn, ws } = connect();
    ws.open();
    const big = new Uint8Array(INPUT_CHUNK_BYTES * 2 + 17).map((_, i) => i % 251);
    conn.sendInput(big);
    const pieces = ws.sentBytes();
    expect(pieces.length).toBe(3);
    for (const p of pieces) expect(p.byteLength).toBeLessThanOrEqual(INPUT_CHUNK_BYTES);
    expect(INPUT_CHUNK_BYTES).toBeLessThan(MAX_MESSAGE_BYTES);
    const joined = new Uint8Array(pieces.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of pieces) { joined.set(p, at); at += p.byteLength; }
    expect(Buffer.from(joined).equals(Buffer.from(big)), "the pieces, rejoined, are not the input").toBe(true);
  });

  it("sends a paste whole, newlines and all, as one paste message", () => {
    const { conn, ws } = connect();
    ws.open();
    const text = "line one\nline two\r\n\ttabbed \"quoted\" \\ back end";
    expect(conn.sendPaste(text)).toBe(true);
    expect(ws.sentText()).toEqual([{ t: "paste", text }]);
    expect(ws.sentBytes(), "a paste must not leak out as raw keystrokes").toEqual([]);
  });

  it("holds its message cap to the one the deck's frame parser enforces", () => {
    // The web copy exists because web code cannot import the server's .mjs
    // under typecheck. A cap set higher here than there is a paste the panel
    // allows and the deck answers by closing the socket with 1009.
    expect(MAX_MESSAGE_BYTES).toBe(DEFAULT_MAX_MESSAGE_BYTES);
  });

  it("refuses a paste the deck would close the socket over, and sends none of it", () => {
    // Splitting it would turn one bracketed paste into several, which the
    // agent reads as several pastes; sending it whole costs the connection.
    const { conn, ws } = connect();
    ws.open();
    expect(conn.sendPaste("x".repeat(MAX_MESSAGE_BYTES))).toBe(false);
    expect(ws.sent).toEqual([]);
    expect(conn.sendPaste("x".repeat(MAX_MESSAGE_BYTES - 64))).toBe(true);
  });

  it("refuses input and paste on a read-only pane but still sends its size", () => {
    const { conn, ws } = connect();
    ws.open();
    ws.text({ t: "hello", kind: "B", sizeOwner: "pane", readOnly: true });
    expect(conn.sendInput("rm -rf ~\r")).toBe(false);
    expect(conn.sendPaste("anything")).toBe(false);
    expect(conn.sendSize(100, 30)).toBe(true);
    expect(ws.sentBytes()).toEqual([]);
    expect(ws.sentText()).toEqual([{ t: "size", cols: 100, rows: 30 }]);
  });

  it("sends the theme's colours as #rrggbb, once per change, and nothing it cannot read", () => {
    const { conn, ws } = connect();
    ws.open();
    expect(conn.sendColours("#E6E6E6", "rgb(20, 22, 27)")).toBe(true);
    expect(conn.sendColours("#e6e6e6", "#14161b"), "the same pair, spelled otherwise").toBe(true);
    expect(conn.sendColours("#1f2328", "#fafaf8")).toBe(true);
    expect(conn.sendColours("var(--text)", "#fff")).toBe(false);
    expect(conn.sendColours(undefined, "#fff")).toBe(false);
    expect(ws.sentText()).toEqual([
      { t: "colours", fg: "#e6e6e6", bg: "#14161b" },
      { t: "colours", fg: "#1f2328", bg: "#fafaf8" },
    ]);
  });

  it("sends no colours for a read-only pane, or once it has ended", () => {
    const ro = connect();
    ro.ws.open();
    ro.ws.text({ t: "hello", kind: "B", sizeOwner: "pane", readOnly: true });
    expect(ro.conn.sendColours("#ffffff", "#000000")).toBe(false);
    const done = connect();
    done.ws.open();
    done.conn.close();
    expect(done.conn.sendColours("#ffffff", "#000000")).toBe(false);
    expect([...ro.ws.sentText(), ...done.ws.sentText()]).toEqual([]);
  });
});

describe("hexColour", () => {
  it("reads the colours a theme holds into six lowercase hex digits", () => {
    expect(hexColour("#14161B")).toBe("#14161b");
    expect(hexColour(" #abc ")).toBe("#aabbcc");
    expect(hexColour("#abcd"), "alpha dropped").toBe("#aabbcc");
    expect(hexColour("#11223344")).toBe("#112233");
    expect(hexColour("rgb(250, 250, 248)")).toBe("#fafaf8");
    expect(hexColour("rgba(0 128 255 / 50%)")).toBe("#0080ff");
    expect(hexColour("rgb(12.6, 0, 255)")).toBe("#0d00ff");
  });

  it("is null for anything it cannot be sure of", () => {
    for (const v of ["", "red", "var(--panel)", "#12", "#1234567", "rgb(256, 0, 0)", "rgb(1, 2)", "hsl(0 0% 0%)", null, undefined, 7]) {
      expect(hexColour(v), String(v)).toBeNull();
    }
  });
});

describe("what the panel is told", () => {
  it("hands over the hello as the deck sent it", () => {
    const { ws, told } = connect();
    ws.open();
    ws.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    expect(told).toEqual([["hello", { kind: "A", sizeOwner: "dock", readOnly: false }]]);
  });

  it("pairs a reset with the binary frame after it, and streams everything after that as output", () => {
    const { ws, told } = connect();
    ws.open();
    ws.text({ t: "reset", cols: 120, rows: 40 });
    expect(told, "a reset is not delivered until its seed has landed").toEqual([]);
    ws.binary([0x1b, 0x5b, 0x48, 0x68, 0x69]);
    ws.binary([0x21]);
    ws.binary([0x0d, 0x0a]);
    expect(told).toEqual([
      ["reset", { cols: 120, rows: 40, seed: [0x1b, 0x5b, 0x48, 0x68, 0x69] }],
      ["data", [0x21]],
      ["data", [0x0d, 0x0a]],
    ]);
  });

  it("treats a second reset exactly like the first, mid-stream", () => {
    // tmux paused the client, or the socket fell behind: the deck redraws.
    const { ws, told } = connect();
    ws.open();
    ws.text({ t: "reset", cols: 80, rows: 24 });
    ws.binary([1]);
    ws.binary([2]);
    ws.text({ t: "reset", cols: 100, rows: 30 });
    ws.binary([3, 3]);
    ws.binary([4]);
    expect(told).toEqual([
      ["reset", { cols: 80, rows: 24, seed: [1] }],
      ["data", [2]],
      ["reset", { cols: 100, rows: 30, seed: [3, 3] }],
      ["data", [4]],
    ]);
  });

  it("pairs a seed with the newer of two resets that arrived back to back", () => {
    const { ws, told } = connect();
    ws.open();
    ws.text({ t: "reset", cols: 80, rows: 24 });
    ws.text({ t: "reset", cols: 132, rows: 50 });
    ws.binary([7]);
    expect(told).toEqual([["reset", { cols: 132, rows: 50, seed: [7] }]]);
  });

  it("reports the pane's own size when the pane owns it", () => {
    const { ws, told } = connect();
    ws.open();
    ws.text({ t: "size", cols: 211, rows: 57 });
    expect(told).toEqual([["size", { cols: 211, rows: 57 }]]);
  });

  it("ignores what it does not understand and keeps streaming", () => {
    // A deck newer than this tab may say things this bundle never heard of.
    const { ws, told } = connect();
    ws.open();
    for (const junk of ["not json", "[1,2]", "null", '"str"', { t: "telemetry", x: 1 }, { t: "reset", cols: "80", rows: 24 },
                        { t: "size", cols: 0, rows: 10 }, { t: "reset", cols: 80.5, rows: 24 }]) {
      expect(() => ws.text(junk)).not.toThrow();
    }
    ws.binary([9]);
    expect(told, "a malformed reset must not swallow the next output frame as its seed").toEqual([["data", [9]]]);
  });
});

describe("how it ends — exactly once", () => {
  it("reports the deck's exit, closes its side, and says nothing more when the socket closes", () => {
    const { conn, ws, told } = connect();
    ws.open();
    ws.text({ t: "exit", reason: "ended" });
    expect(ws.closedWith).toEqual([1000]);
    ws.fail(1000);
    expect(told).toEqual([["exit", { reason: "ended" }]]);
    expect(conn.sendInput("x"), "nothing may be sent after the ending").toBe(false);
    expect(conn.sendSize(80, 24)).toBe(false);
  });

  it("passes the exit's message along, and reads an unknown reason as an error", () => {
    const a = connect();
    a.ws.open();
    a.ws.text({ t: "exit", reason: "detached", message: "Another client took the pane." });
    expect(a.told).toEqual([["exit", { reason: "detached", message: "Another client took the pane." }]]);
    const b = connect();
    b.ws.open();
    b.ws.text({ t: "exit", reason: "vanished" });
    expect(b.told).toEqual([["exit", { reason: "error" }]]);
  });

  it("says when the session had already ended before the socket attached, and only when the deck says so plainly", () => {
    const a = connect();
    a.ws.open();
    a.ws.text({ t: "exit", reason: "ended", atOpen: true });
    expect(a.told).toEqual([["exit", { reason: "ended", atOpen: true }]]);
    const b = connect();
    b.ws.open();
    b.ws.text({ t: "exit", reason: "ended", atOpen: "yes" });
    expect(b.told).toEqual([["exit", { reason: "ended" }]]);
  });

  it("drops a reset still waiting for its seed when the session exits", () => {
    const { ws, told } = connect();
    ws.open();
    ws.text({ t: "reset", cols: 80, rows: 24 });
    ws.text({ t: "exit", reason: "server-shutdown" });
    ws.binary([1, 2, 3]);
    expect(told).toEqual([["exit", { reason: "server-shutdown" }]]);
  });

  it("calls a socket that closed after opening, without an exit, lost — once, though the browser fires error and close", () => {
    const { ws, told } = connect();
    ws.open();
    ws.fail(1006);
    expect(told).toEqual([["error", { kind: "lost", code: 1006, message: "The connection to the terminal was lost." }]]);
  });

  it("calls a socket that never opened refused — an expired ticket, the flag off, too many terminals", () => {
    const { conn, ws, told } = connect();
    conn.sendSize(80, 24);
    ws.fail(1006);
    expect(told).toEqual([["error", { kind: "refused", code: 1006, message: "The deck did not accept the terminal connection." }]]);
    expect(ws.sent, "the queued size must not be flushed into a socket that failed").toEqual([]);
  });

  it("stays silent when the panel itself closes, before or after the socket opened", () => {
    const early = connect();
    early.conn.sendSize(80, 24);
    early.conn.close();
    early.ws.fail(1006);
    expect(early.told).toEqual([]);
    expect(early.ws.closedWith).toEqual([1000]);
    expect(early.ws.sent).toEqual([]);

    const late = connect();
    late.ws.open();
    late.conn.close();
    late.conn.close();
    late.ws.binary([1]);
    late.ws.fail(1000);
    expect(late.told).toEqual([]);
    expect(late.ws.closedWith, "a second close() must not close twice").toEqual([1000]);
    expect(late.conn.sendPaste("x")).toBe(false);
  });
});

describe("parseServerMessage", () => {
  it("reads every message the deck sends and nothing else", () => {
    expect(parseServerMessage('{"t":"hello","kind":"D","sizeOwner":"pane","readOnly":true}'))
      .toEqual({ t: "hello", kind: "D", sizeOwner: "pane", readOnly: true });
    expect(parseServerMessage('{"t":"reset","cols":120,"rows":40}')).toEqual({ t: "reset", cols: 120, rows: 40 });
    expect(parseServerMessage('{"t":"size","cols":90,"rows":30}')).toEqual({ t: "size", cols: 90, rows: 30 });
    expect(parseServerMessage('{"t":"exit","reason":"error","message":"tmux went away"}'))
      .toEqual({ t: "exit", reason: "error", message: "tmux went away" });
    expect(parseServerMessage('{"t":"paste","text":"x"}'), "paste only ever goes up, never down").toBeNull();
  });

  it("reads the tmux version as [major, minor], and nothing that is not two numbers", () => {
    expect(parseServerMessage('{"t":"tmux","version":"3.8"}')).toEqual({ t: "tmux", version: [3, 8] });
    expect(parseServerMessage('{"t":"tmux","version":"10.12"}')).toEqual({ t: "tmux", version: [10, 12] });
    for (const v of ['"3.6a"', '"openbsd-7.4"', '"3"', '"3.8.1"', "3.8", '""', "null", '"1234.1"']) {
      expect(parseServerMessage(`{"t":"tmux","version":${v}}`), v).toBeNull();
    }
  });

  it("hands the version to the panel when the deck says it", () => {
    const { ws, told } = connect();
    ws.open();
    ws.text({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    ws.text({ t: "tmux", version: "3.4" });
    ws.text({ t: "tmux", version: "three" });
    expect(told.filter(([k]) => k === "tmux")).toEqual([["tmux", [3, 4]]]);
  });

  it("takes a hello with fields missing as the dock owning a writable pane", () => {
    // Dropping a hello would leave the panel not knowing who sizes the pane,
    // so a partial one takes the answer that is safe to act on.
    expect(parseServerMessage('{"t":"hello"}')).toEqual({ t: "hello", kind: "", sizeOwner: "dock", readOnly: false });
    expect(parseServerMessage('{"t":"hello","readOnly":"yes","sizeOwner":"window"}'))
      .toEqual({ t: "hello", kind: "", sizeOwner: "dock", readOnly: false });
  });
});

describe("the module's footprint", () => {
  it("imports nothing at all, so it can never be what drags xterm into a chunk", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../terminal-protocol.ts", import.meta.url)), "utf8"));
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bimport\(/);
  });
});
