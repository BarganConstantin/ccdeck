// The browser half of the terminal panel's one WebSocket: what the deck sends
// down it, what the panel sends up, and the order the two have to agree on.
//
// WHY THIS KNOWS NOTHING ABOUT XTERM. The socket is the part of the panel that
// has a contract with the server (src/server/terminal-socket.mjs), and a
// contract is the thing worth testing without a browser. So this file takes a
// WebSocket-shaped object, hands back bytes and plain objects, and never
// touches a Terminal: the panel turns "reset to 120×40, then these bytes" into
// xterm calls, and this decides only what those calls are told. The suite has
// no DOM, and a fake socket is twenty lines; a fake xterm would be the test.
//
// THE CONVERSATION, in the order it happens:
//
//   deck  → hello {kind, sizeOwner, readOnly}
//   panel → size {cols, rows}        nothing streams until this arrives
//   deck  → reset {cols, rows}, then ONE binary frame: the seed
//   deck  → binary frames: the pane's output, from the byte after the seed
//   deck  → size {cols, rows}        only when the pane owns the size (case B)
//   deck  → exit {reason, message?}, then close 1000
//
// and, from the panel, input as binary frames, `size` whenever its box changes
// and `paste` for a paste. A `reset` may come again at any moment — tmux paused
// the client and it has to redraw, or the socket fell behind and the deck
// stopped forwarding — and it means exactly what the first one did.
//
// RESET AND ITS SEED ARRIVE AS ONE CALLBACK. On the wire they are two frames,
// because the seed is bytes and the reset is JSON. To the panel they are one
// instruction — "clear the terminal, size it, write this" — and handing them
// over separately would make every consumer hold the half it has until the
// other half lands. The deck sends nothing between them, so pairing them here
// costs no latency and loses nothing.
//
// EXACTLY ONE ENDING. Either the deck says why it is closing (`exit`) or the
// socket closes without saying (`onError`). Never both, never twice: a browser
// fires `error` and then `close` for the same failure, and a panel told twice
// draws its error state twice. `close()` from the panel itself is not an
// ending anyone needs to hear about, so it is silent.
//
// WHAT IS RESTATED FROM THE SERVER. Web code cannot import src/server's .mjs
// (`npm run typecheck` rejects an untyped module), so the attach path and the
// message cap are written out here again. They are the two places this file
// can drift from the deck, and they are exported so a test can hold them to it.

/** Where the deck answers the upgrade. Every other path is refused with a 404. */
export const TERMINAL_ATTACH_PATH = "/api/terminal/attach";

/**
 * The largest message the deck's frame parser will take. Above it the deck
 * closes the socket with 1009 — the session survives, the panel does not — so
 * a paste that would cross it is refused here, where the panel can say so,
 * rather than there, where all anyone sees is a dropped connection.
 */
export const MAX_MESSAGE_BYTES = 1 << 20;

/**
 * Input goes up in pieces no larger than this. Typed input is a few bytes; the
 * only large input is a program's own (a script driving the pty, a drop of
 * text that bypassed paste), and splitting it keeps every frame far under the
 * cap above. Bytes may be split anywhere — the pty reassembles them — which is
 * not true of a paste, and is why a paste is never split.
 */
export const INPUT_CHUNK_BYTES = 64 * 1024;

/** Who decides the terminal's size: the dock (it resizes the pane to fit), or
 *  the pane (it lives in someone's own tmux, and the dock draws at its size). */
export type SizeOwner = "dock" | "pane";

/** Why the deck closed the socket. "detached" is someone else taking the pane
 *  away; "ended" is the session itself finishing. */
export type ExitReason = "ended" | "detached" | "server-shutdown" | "error";

export const EXIT_REASONS: readonly ExitReason[] = ["ended", "detached", "server-shutdown", "error"];

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalHello {
  /** The target's kind as the deck resolved it (A, B, D …). */
  kind: string;
  sizeOwner: SizeOwner;
  readOnly: boolean;
}

/** "Clear the terminal, make it this size, then write `seed`" — the bytes that
 *  make a freshly reset xterm show what tmux shows. */
export interface TerminalReset extends TerminalSize {
  seed: Uint8Array;
}

export interface TerminalExit {
  reason: ExitReason;
  message?: string;
}

/**
 * The socket closed and the deck never said why.
 *
 * `refused` is a socket that never opened: the upgrade was answered with a
 * plain HTTP status — an expired ticket, the flag switched off, four terminals
 * already open — and a browser reports every one of those as the same bare
 * 1006, so there is nothing more specific to say. `lost` is one that opened and
 * then went away without an `exit`.
 */
export interface TerminalFailure {
  kind: "refused" | "lost";
  code: number;
  message: string;
}

export type ServerMessage =
  | ({ t: "hello" } & TerminalHello)
  | ({ t: "reset" } & TerminalSize)
  | ({ t: "size" } & TerminalSize)
  | ({ t: "exit" } & TerminalExit);

/** The part of the browser's WebSocket this file uses, so a test can hand it
 *  a plain object and the real one satisfies it unchanged. */
export type SocketLike = Pick<
  WebSocket,
  "binaryType" | "send" | "close" | "onopen" | "onmessage" | "onerror" | "onclose"
>;

export interface TerminalHandlers {
  onHello?: (hello: TerminalHello) => void;
  onReset?: (reset: TerminalReset) => void;
  onData?: (bytes: Uint8Array) => void;
  onSize?: (size: TerminalSize) => void;
  onExit?: (exit: TerminalExit) => void;
  onError?: (failure: TerminalFailure) => void;
}

export interface ConnectOptions extends TerminalHandlers {
  /** The single-use ticket POST /api/terminal/open, adopt or launch minted. */
  ticket: string;
  /** The attach endpoint. A path is resolved against `base`; http(s) becomes
   *  ws(s), so the socket goes to the same origin the page came from. */
  url?: string;
  /** What a relative `url` is resolved against. The page's own address by
   *  default; a test, which has no page, passes one. */
  base?: string;
  /** How the socket is made. The browser's WebSocket by default. */
  createSocket?: (url: string) => SocketLike;
}

export interface TerminalConnection {
  /** Keystrokes and other raw input. False when it cannot be sent: the
   *  connection has ended, or the deck said the pane is read-only. */
  sendInput(data: Uint8Array | string): boolean;
  /** The panel's box in cells. The first one is what starts the stream. */
  sendSize(cols: number, rows: number): boolean;
  /** A paste, sent whole so the pane sees one bracketed paste and not several.
   *  False when it is over the deck's message cap, read-only, or ended. */
  sendPaste(text: string): boolean;
  /** Leave. The tmux session keeps running; only this view of it ends. */
  close(): void;
}

/**
 * The socket's address: `url` resolved against `base`, its scheme moved from
 * http(s) to ws(s), and the ticket as the one query parameter the deck reads.
 */
export function socketUrl(url: string, ticket: string, base?: string): string {
  const at = new URL(url, base);
  if (at.protocol === "http:") at.protocol = "ws:";
  else if (at.protocol === "https:") at.protocol = "wss:";
  at.searchParams.set("ticket", ticket);
  return at.toString();
}

const cells = (n: unknown): number | null =>
  typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;

/**
 * One text frame from the deck, or null for anything this page does not know.
 *
 * Unknown is ignored rather than fatal: a deck newer than the tab in front of
 * it may say things this bundle has never heard of, and the stream it is
 * already drawing is still good. A `reset` or `size` without two positive
 * whole numbers is unknown too — sizing a terminal to NaN is worse than not
 * resizing it.
 */
export function parseServerMessage(text: string): ServerMessage | null {
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    msg = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (msg.t) {
    case "hello":
      // Lenient on purpose. Dropping a hello would leave the panel not knowing
      // who owns the size, so a field that is missing takes the answer that
      // is safe to act on: the dock owns the size, input is allowed.
      return {
        t: "hello",
        kind: typeof msg.kind === "string" ? msg.kind : "",
        sizeOwner: msg.sizeOwner === "pane" ? "pane" : "dock",
        readOnly: msg.readOnly === true,
      };
    case "reset":
    case "size": {
      const cols = cells(msg.cols);
      const rows = cells(msg.rows);
      return cols && rows ? { t: msg.t, cols, rows } : null;
    }
    case "exit": {
      // A reason this bundle does not know is still an ending, so it is one
      // the panel already knows how to draw.
      const reason = EXIT_REASONS.includes(msg.reason as ExitReason) ? (msg.reason as ExitReason) : "error";
      return typeof msg.message === "string" && msg.message
        ? { t: "exit", reason, message: msg.message }
        : { t: "exit", reason };
    }
    default:
      return null;
  }
}

/** A binary frame's payload as bytes, or null for anything else (a Blob, if a
 *  socket ever ignores the binaryType it was given). */
function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

const encoder = new TextEncoder();

/** What the panel is told when the socket ends without an `exit`. Plain
 *  sentences, because the panel may show them as they are. */
const REFUSED = "The deck did not accept the terminal connection.";
const LOST = "The connection to the terminal was lost.";

/**
 * Open the panel's socket and speak the protocol above over it.
 *
 * Everything sent before the socket opens is queued and goes up, in order, the
 * moment it does — so the panel can fit its box and call `sendSize` straight
 * away without waiting on an event it would otherwise have to track.
 */
export function connectTerminal(options: ConnectOptions): TerminalConnection {
  const { ticket, onHello, onReset, onData, onSize, onExit, onError } = options;
  const base = options.base ?? (typeof location === "undefined" ? undefined : location.href);
  const create = options.createSocket ?? ((at: string) => new WebSocket(at));
  const ws = create(socketUrl(options.url ?? TERMINAL_ATTACH_PATH, ticket, base));
  // Strings for JSON, bytes for the terminal. A Blob would need an async read
  // per frame, which reorders nothing but delays everything.
  ws.binaryType = "arraybuffer";

  let opened = false;
  let finished = false;
  let readOnly = false;
  /** The size half of a reset whose seed has not landed yet. */
  let pendingReset: TerminalSize | null = null;
  const queued: Array<string | Uint8Array> = [];

  const send = (frame: string | Uint8Array): boolean => {
    if (finished) return false;
    if (opened) ws.send(frame);
    else queued.push(frame);
    return true;
  };

  ws.onopen = () => {
    if (finished) return;
    opened = true;
    for (const frame of queued.splice(0)) ws.send(frame);
  };

  ws.onmessage = (event: MessageEvent) => {
    if (finished) return;
    if (typeof event.data === "string") {
      const msg = parseServerMessage(event.data);
      if (!msg) return;
      switch (msg.t) {
        case "hello":
          readOnly = msg.readOnly;
          onHello?.({ kind: msg.kind, sizeOwner: msg.sizeOwner, readOnly: msg.readOnly });
          return;
        case "reset":
          // A second reset before the first one's seed replaces it: the seed
          // that follows was captured for the newer one.
          pendingReset = { cols: msg.cols, rows: msg.rows };
          return;
        case "size":
          onSize?.({ cols: msg.cols, rows: msg.rows });
          return;
        case "exit":
          finished = true;
          pendingReset = null;
          onExit?.(msg.message === undefined ? { reason: msg.reason } : { reason: msg.reason, message: msg.message });
          // The deck closes next. Closing from this side too means a deck that
          // never gets round to it cannot leave the socket open behind a panel
          // that has already drawn the ending.
          ws.close(1000);
          return;
      }
      return;
    }
    const bytes = bytesOf(event.data);
    if (!bytes) return;
    if (pendingReset) {
      const size = pendingReset;
      pendingReset = null;
      onReset?.({ cols: size.cols, rows: size.rows, seed: bytes });
      return;
    }
    onData?.(bytes);
  };

  // Deliberately nothing on `error`: a browser follows every `error` with a
  // `close`, and the close carries the code. Reporting both would be the
  // double ending the header rules out.
  ws.onerror = () => {};

  ws.onclose = (event: CloseEvent) => {
    if (finished) return;
    finished = true;
    pendingReset = null;
    const code = typeof event?.code === "number" ? event.code : 1006;
    onError?.(opened ? { kind: "lost", code, message: LOST } : { kind: "refused", code, message: REFUSED });
  };

  return {
    sendInput(data) {
      if (readOnly || finished) return false;
      const bytes = typeof data === "string" ? encoder.encode(data) : data;
      if (bytes.byteLength === 0) return true;
      for (let at = 0; at < bytes.byteLength; at += INPUT_CHUNK_BYTES) {
        send(bytes.subarray(at, Math.min(at + INPUT_CHUNK_BYTES, bytes.byteLength)));
      }
      return true;
    },
    sendSize(cols, rows) {
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return false;
      const c = Math.floor(cols);
      const r = Math.floor(rows);
      if (c < 1 || r < 1) return false;
      return send(JSON.stringify({ t: "size", cols: c, rows: r }));
    },
    sendPaste(text) {
      if (readOnly || finished) return false;
      const frame = JSON.stringify({ t: "paste", text });
      if (encoder.encode(frame).byteLength > MAX_MESSAGE_BYTES) return false;
      return send(frame);
    },
    close() {
      if (finished) return;
      finished = true;
      pendingReset = null;
      queued.length = 0;
      ws.close(1000);
    },
  };
}
