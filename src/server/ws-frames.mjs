// WebSocket (RFC 6455) from the server's side: the opening handshake, the frame
// codec, and the life of one connection — as much of the protocol as the
// terminal panel needs and nothing beyond it.
//
// The terminal panel streams a pane's bytes to the page and the keys typed
// there back again. That traffic gets a socket of its own rather than riding
// the event stream the deck already has, for three reasons: concurrent POSTs
// can land out of order, which turns fast typing into transposed letters
// rather than into lag; the one SSE channel carries a resume window and
// backpressure accounting that a firehose of terminal output would disturb;
// and SSE is text, so every byte a TUI writes would be escaped on its way out.
// A WebSocket is ordered, binary, and touches nothing else.
//
// HAND-WRITTEN BECAUSE THE SERVER TAKES NO RUNTIME DEPENDENCIES. Everything
// here is node:crypto, node:buffer and node:http, and it must run on the
// Node 18 floor the packed tarball is booted on. The browser is the only
// client, so this speaks exactly what a browser speaks when nothing is
// negotiated: no extensions (every browser offers permessage-deflate, and it
// is declined by not answering it), no subprotocol, version 13 only.
//
// THE PARSER IS STRICT, AND A REFUSAL ENDS THE CONNECTION. Every frame read
// here came off the network before anybody was trusted, so anything the RFC
// says a client must not send — an unmasked frame, a reserved bit or opcode, a
// control frame that is long or fragmented, a close code that is never sent on
// the wire — is a protocol error (1002); a message over the cap is refused as
// its header arrives, before its payload is buffered (1009); a text message or
// close reason that is not UTF-8 is refused once it is whole (1007). The
// connection answers a refusal with a close frame carrying that code and stops
// reading, which is what "fail the WebSocket connection" means in RFC 6455 §7.
//
// NOTHING HERE THROWS OUT OF A SOCKET EVENT. An exception inside a socket's
// 'data' or 'close' event has nothing above it to catch it, so it would take
// the whole deck down with every other terminal and count towards the
// supervisor's crash ceiling. A message handler that throws ends its own
// connection (1011); an onClose that throws is swallowed.
import { createHash } from "node:crypto";
// A namespace import, not `{ isUtf8 }`: the named export arrived in Node 18.14,
// and on an older 18 a named import of a missing export fails the whole module
// at link time. Read off the namespace it is merely undefined, and the
// hand-written check below stands in.
import * as nodeBuffer from "node:buffer";
import { STATUS_CODES } from "node:http";

/** The GUID RFC 6455 §1.3 appends to the client's key before hashing it. */
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Opcodes (RFC 6455 §5.2). Every other value is reserved and refused. */
export const OP = Object.freeze({ CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });
const KNOWN_OPCODES = new Set(Object.values(OP));

/** The most one message may be unless the caller says otherwise. A terminal's
 *  input is keystrokes and the odd paste, so a mebibyte is far above anything
 *  legitimate and low enough that a page cannot make the deck hold much. */
export const DEFAULT_MAX_MESSAGE_BYTES = 1 << 20;

/** The most frames one message may arrive in. The byte cap alone does not
 *  bound what assembling a message costs: an empty fragment adds no bytes, and
 *  a one-byte fragment costs a buffer of its own, so a client could hold the
 *  deck's memory far past the cap a byte or none at a time. A browser sends a
 *  message in one frame; a thousand is room for any client that splits. */
export const MAX_FRAGMENTS = 1024;

/** How long a closing connection waits for the other side before the socket is
 *  destroyed. A browser echoes a close within a round trip; a peer that has not
 *  in two seconds is gone or not listening, and its socket is not worth more. */
export const CLOSE_TIMEOUT_MS = 2_000;

/** A control frame carries at most 125 bytes (§5.5), and a close frame spends
 *  two of them on its code — so a close reason is at most 123 bytes. */
const MAX_CONTROL_PAYLOAD = 125;
const MAX_CLOSE_REASON = MAX_CONTROL_PAYLOAD - 2;

const EMPTY = Buffer.alloc(0);

/**
 * The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key: the key and
 * the RFC's GUID, SHA-1'd and base64'd. It proves to the browser that this
 * server read its handshake rather than replaying a cached response.
 */
export function acceptKey(secKey) {
  return createHash("sha1").update(`${secKey}${HANDSHAKE_GUID}`).digest("base64");
}

/**
 * Whether an HTTP request is a WebSocket opening handshake this server can
 * answer, read from its method, version and headers alone (Node lower-cases
 * header names and trims their values).
 *
 * Answers `{ ok: true, key }` with the client's key, or `{ ok: false, status,
 * reason }` with the HTTP status to refuse with. A version mismatch is 426 and
 * also carries `headers` naming the one version spoken here, which §4.4 asks
 * for so a client can retry with it. This checks the protocol only: the Host,
 * Origin and ticket checks that decide WHO may connect are the caller's.
 */
export function validateUpgrade(req) {
  const headers = req?.headers ?? {};
  if (req?.method !== "GET") return refusal(405, "a WebSocket handshake is a GET");
  if (olderThanHttp11(req)) return refusal(400, "a WebSocket handshake needs HTTP/1.1");
  if (headerText(headers.upgrade).toLowerCase() !== "websocket") return refusal(400, "not a WebSocket upgrade");
  if (!headerTokens(headers.connection).includes("upgrade")) {
    return refusal(400, "the Connection header does not ask to upgrade");
  }
  if (headerText(headers["sec-websocket-version"]) !== "13") {
    return { ...refusal(426, "only WebSocket version 13 is spoken here"), headers: { "Sec-WebSocket-Version": "13" } };
  }
  const key = headerText(headers["sec-websocket-key"]);
  if (!isHandshakeNonce(key)) return refusal(400, "the Sec-WebSocket-Key is not 16 bytes of base64");
  return { ok: true, key };
}

function refusal(status, reason) {
  return { ok: false, status, reason };
}

/** Only when the request says which version it is: Node always does, and a
 *  hand-built request in a test that leaves it out is not refused for that. */
function olderThanHttp11(req) {
  const major = req?.httpVersionMajor;
  const minor = req?.httpVersionMinor;
  if (typeof major !== "number" || typeof minor !== "number") return false;
  return major < 1 || (major === 1 && minor < 1);
}

function headerText(value) {
  return String(value ?? "").trim();
}

/** A comma-separated header as lower-cased tokens. Firefox sends
 *  `Connection: keep-alive, Upgrade`, so a plain equality would refuse it. */
function headerTokens(value) {
  return headerText(value).toLowerCase().split(",").map(token => token.trim());
}

/** The key must be base64 of exactly 16 bytes (§4.1). The pattern pins the
 *  shape; the round trip refuses the non-canonical spellings Buffer would
 *  otherwise decode leniently (stray bits in the last character). Two keys
 *  that Node joined with ", " fail both. */
function isHandshakeNonce(key) {
  return /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, "base64").toString("base64") === key;
}

/**
 * The exact 101 response that completes the handshake for a client key: no
 * extensions and no subprotocol, so a browser that offered either goes on
 * without it, as §4.2.2 provides. Write it to the socket, then hand the socket
 * to wsConnection.
 */
export function upgradeResponse(key) {
  return "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n`
    + "\r\n";
}

/**
 * A plain HTTP refusal to write on an upgrade socket before destroying it —
 * the only answer an upgrade request that will not be accepted gets, since no
 * http.ServerResponse exists for it. `headers` is a refusal's own extra
 * headers (validateUpgrade's 426 names the version). With none, a 404 is
 * exactly `HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n`.
 */
export function httpRefusal(status, headers = {}) {
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  return `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\n${extra}\r\n`;
}

/**
 * One frame as the server writes it: never masked (§5.1 forbids a server to
 * mask), with the payload length in 7, 16 or 64 bits — always the shortest
 * that holds it, as §5.2 requires. `payload` is a Buffer, any typed-array
 * view, or a string (written as UTF-8). Throws on an unknown opcode or a
 * control frame that is fragmented or over 125 bytes: those are bugs in the
 * caller, and a peer would fail the connection over them anyway.
 */
export function encodeFrame(opcode, payload = EMPTY, { fin = true } = {}) {
  if (!KNOWN_OPCODES.has(opcode)) throw new RangeError(`unknown WebSocket opcode ${opcode}`);
  const body = asBuffer(payload);
  if (opcode >= 0x8 && !fin) throw new RangeError("a control frame cannot be fragmented");
  if (opcode >= 0x8 && body.length > MAX_CONTROL_PAYLOAD) {
    throw new RangeError(`a control frame carries at most ${MAX_CONTROL_PAYLOAD} bytes`);
  }
  const length = body.length;
  const headerBytes = length < 126 ? 2 : length < 0x10000 ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerBytes + length);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  if (length < 126) {
    frame[1] = length;
  } else if (length < 0x10000) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    // Two 32-bit halves rather than writeBigUInt64BE, so no BigInt is made per
    // frame; `>>> 0` keeps the low 32 bits of any length a Buffer can have.
    frame[1] = 127;
    frame.writeUInt32BE(Math.floor(length / 0x100000000), 2);
    frame.writeUInt32BE(length >>> 0, 6);
  }
  body.copy(frame, headerBytes);
  return frame;
}

function asBuffer(payload) {
  if (payload == null) return EMPTY;
  if (typeof payload === "string") return Buffer.from(payload, "utf8");
  if (Buffer.isBuffer(payload)) return payload;
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  throw new TypeError("a frame's payload is a Buffer, a typed array or a string");
}

/**
 * Whether a close code may appear in a close frame (§7.4): the defined codes
 * other than 1004 (reserved) and 1005/1006 (which only ever describe a close
 * locally), the IANA-registered 1012–1014, and the 3000–4999 ranges left to
 * libraries and applications.
 */
function isSendableCloseCode(code) {
  return Number.isInteger(code)
    && ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
      || (code >= 3000 && code <= 4999));
}

/**
 * Whether bytes are well-formed UTF-8 in the strict sense RFC 3629 gives it:
 * no overlong forms, no UTF-16 surrogates, nothing past U+10FFFF. This is the
 * stand-in for Node's native `buffer.isUtf8` on a Node 18 older than 18.14,
 * and is exported so a test holds the two to the same answers.
 */
export function isValidUtf8(bytes) {
  const length = bytes.length;
  let i = 0;
  while (i < length) {
    const lead = bytes[i];
    if (lead < 0x80) { i += 1; continue; }
    if (lead >= 0xc2 && lead <= 0xdf) {
      if (i + 1 >= length || !isContinuation(bytes[i + 1])) return false;
      i += 2;
      continue;
    }
    if (lead >= 0xe0 && lead <= 0xef) {
      if (i + 2 >= length) return false;
      const second = bytes[i + 1];
      if (!isContinuation(second) || !isContinuation(bytes[i + 2])) return false;
      if (lead === 0xe0 && second < 0xa0) return false; // overlong
      if (lead === 0xed && second > 0x9f) return false; // a UTF-16 surrogate
      i += 3;
      continue;
    }
    if (lead >= 0xf0 && lead <= 0xf4) {
      if (i + 3 >= length) return false;
      const second = bytes[i + 1];
      if (!isContinuation(second) || !isContinuation(bytes[i + 2]) || !isContinuation(bytes[i + 3])) return false;
      if (lead === 0xf0 && second < 0x90) return false; // overlong
      if (lead === 0xf4 && second > 0x8f) return false; // past U+10FFFF
      i += 4;
      continue;
    }
    return false;
  }
  return true;
}

function isContinuation(byte) {
  return (byte & 0xc0) === 0x80;
}

const isUtf8 = typeof nodeBuffer.isUtf8 === "function" ? nodeBuffer.isUtf8 : isValidUtf8;

/**
 * A parser for the frames a client sends, fed whatever the socket hands over.
 *
 * `push(chunk)` takes the next bytes, in pieces of any size, and answers an
 * array of the MESSAGES they completed, in order: `{ type: "text" | "binary",
 * data }` once every fragment of a message is in, and `{ type: "ping" |
 * "pong", data }` or `{ type: "close", data, code, reason }` as each control
 * frame arrives — so a ping between two fragments comes out before the message
 * it interrupted, which is what §5.4 means control frames to be able to do.
 * `data` is always a Buffer, unmasked. A close with no code reports 1005,
 * which is how §7.1.5 says to describe it.
 *
 * A refusal comes out as `{ type: "error", code, reason }`, after any message
 * completed before it, and the parser reads nothing more. Nor does it after a
 * close: §5.5.1 has a client send nothing once it has sent one.
 *
 * Bytes are queued as they come and copied once, when a frame's payload is
 * whole, so a mebibyte arriving in many small reads is not re-copied per read.
 * The queue never holds more than one frame's header and payload, and a
 * payload over the cap is refused from its header, before it is buffered.
 */
export function createFrameParser({ maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
  const queue = [];
  let queued = 0;
  let finished = false;

  // The frame being read: which part of it comes next and how many bytes that
  // part needs.
  let step = "header";
  let need = 2;
  let fin = false;
  let opcode = 0;
  let length = 0;
  let mask = EMPTY;

  // The message being assembled from fragments; `messageOpcode` is 0 between
  // messages, TEXT or BINARY while one is open.
  let messageOpcode = 0;
  let fragments = [];
  let fragmentBytes = 0;
  let fragmentCount = 0;

  /** Consume exactly `n` queued bytes: a view when one chunk holds them all,
   *  one copy when they span chunks.
   *
   *  The chunks used up are dropped with one splice at the end, NOT a shift
   *  per chunk: shift moves every element behind it, so a payload that came
   *  in as a million one-byte reads — which a client can arrange by dripping
   *  it — cost a million moves of a million-long array. */
  function take(n) {
    if (n === 0) return EMPTY;
    const first = queue[0];
    if (first.length >= n) {
      queued -= n;
      if (first.length === n) { queue.shift(); return first; }
      queue[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    let used = 0;
    while (offset < n) {
      const chunk = queue[used];
      const wanted = n - offset;
      if (chunk.length <= wanted) {
        chunk.copy(out, offset);
        offset += chunk.length;
        used += 1;
      } else {
        chunk.copy(out, offset, 0, wanted);
        queue[used] = chunk.subarray(wanted);
        offset += wanted;
      }
    }
    queue.splice(0, used);
    queued -= n;
    return out;
  }

  function stop() {
    finished = true;
    queue.length = 0;
    queued = 0;
    fragments = [];
    fragmentBytes = 0;
    fragmentCount = 0;
  }

  function fail(out, code, reason) {
    out.push({ type: "error", code, reason });
    stop();
  }

  function readHeader(bytes, out) {
    const first = bytes[0];
    const second = bytes[1];
    fin = (first & 0x80) !== 0;
    opcode = first & 0x0f;
    length = second & 0x7f;
    if (first & 0x70) return fail(out, 1002, "reserved bits set with no extension agreed");
    if (!KNOWN_OPCODES.has(opcode)) return fail(out, 1002, `reserved opcode ${opcode}`);
    if (!(second & 0x80)) return fail(out, 1002, "a client frame must be masked");
    if (opcode >= 0x8) {
      if (!fin) return fail(out, 1002, "a control frame cannot be fragmented");
      if (length > MAX_CONTROL_PAYLOAD) return fail(out, 1002, "a control frame carries at most 125 bytes");
    } else if (opcode === OP.CONTINUATION) {
      if (!messageOpcode) return fail(out, 1002, "a continuation with no message to continue");
    } else if (messageOpcode) {
      return fail(out, 1002, "a new message before the last one finished");
    }
    if (length === 126) { step = "length16"; need = 2; return; }
    if (length === 127) { step = "length64"; need = 8; return; }
    lengthKnown(out);
  }

  function readLength64(bytes, out) {
    const high = bytes.readUInt32BE(0);
    // §5.2: the most significant bit of a 64-bit length MUST be 0.
    if (high >= 0x80000000) return fail(out, 1002, "a 64-bit length with its top bit set");
    length = high * 0x100000000 + bytes.readUInt32BE(4);
    lengthKnown(out);
  }

  /** The cap is checked here, from the header, so a peer that announces a
   *  gigabyte is refused before it has sent one. Fragments count together. */
  function lengthKnown(out) {
    if (opcode < 0x8 && fragmentBytes + length > maxMessageBytes) {
      return fail(out, 1009, `a message over ${maxMessageBytes} bytes`);
    }
    if (opcode < 0x8 && fragmentCount >= MAX_FRAGMENTS) {
      return fail(out, 1009, `a message in more than ${MAX_FRAGMENTS} frames`);
    }
    step = "mask";
    need = 4;
  }

  function readPayload(masked, out) {
    // Unmasked into a fresh buffer rather than in place: `masked` may be a view
    // of the caller's own chunk, which is not this parser's to rewrite.
    const payload = Buffer.allocUnsafe(masked.length);
    for (let i = 0; i < masked.length; i++) payload[i] = masked[i] ^ mask[i & 3];
    step = "header";
    need = 2;
    if (opcode >= 0x8) return controlFrame(payload, out);
    if (opcode !== OP.CONTINUATION) messageOpcode = opcode;
    fragmentCount += 1;
    // An empty fragment is counted, never kept: it adds nothing to the message.
    if (payload.length) fragments.push(payload);
    fragmentBytes += payload.length;
    if (!fin) return;
    const data = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
    const type = messageOpcode === OP.TEXT ? "text" : "binary";
    messageOpcode = 0;
    fragments = [];
    fragmentBytes = 0;
    fragmentCount = 0;
    // Checked once the message is whole, not per fragment: a character may be
    // split across two fragments, and only the joined bytes say whether it is.
    if (type === "text" && !isUtf8(data)) return fail(out, 1007, "a text message that is not UTF-8");
    out.push({ type, data });
  }

  function controlFrame(payload, out) {
    if (opcode === OP.PING) return void out.push({ type: "ping", data: payload });
    if (opcode === OP.PONG) return void out.push({ type: "pong", data: payload });
    if (payload.length === 1) return fail(out, 1002, "a close frame with a one-byte payload");
    if (payload.length === 0) {
      out.push({ type: "close", data: payload, code: 1005, reason: "" });
    } else {
      const code = payload.readUInt16BE(0);
      if (!isSendableCloseCode(code)) return fail(out, 1002, `close code ${code} is never sent`);
      const reason = payload.subarray(2);
      if (!isUtf8(reason)) return fail(out, 1007, "a close reason that is not UTF-8");
      out.push({ type: "close", data: payload, code, reason: reason.toString("utf8") });
    }
    stop();
  }

  return {
    push(chunk) {
      const out = [];
      if (finished || !chunk || chunk.length === 0) return out;
      queue.push(chunk);
      queued += chunk.length;
      while (!finished && queued >= need) {
        if (step === "header") readHeader(take(2), out);
        else if (step === "length16") { length = take(2).readUInt16BE(0); lengthKnown(out); }
        else if (step === "length64") readLength64(take(8), out);
        else if (step === "mask") { mask = take(4); step = "payload"; need = length; }
        else readPayload(take(length), out);
      }
      return out;
    },
  };
}

/** A close frame's payload: the code and a reason cut to the 123 bytes there is
 *  room for — on a character boundary, so the cut never makes the reason
 *  invalid UTF-8 (which the browser would fail the connection over). */
function closePayload(code, reason) {
  if (code == null) return EMPTY;
  const text = Buffer.from(String(reason ?? ""), "utf8");
  let end = Math.min(text.length, MAX_CLOSE_REASON);
  if (end < text.length) while (end > 0 && isContinuation(text[end])) end -= 1;
  const payload = Buffer.allocUnsafe(2 + end);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2, 0, end);
  return payload;
}

/**
 * Run one accepted WebSocket over `socket` — call it after writing
 * upgradeResponse(key) to the socket. `head` is the bytes Node read past the
 * handshake (the 'upgrade' event's third argument); they are the start of the
 * first frame and are read before anything later.
 *
 * `onMessage({ type: "text" | "binary", data })` gets each data message while
 * the connection is open; control frames are handled here. Pings are answered
 * with a pong carrying the same bytes. A close from the client is echoed with
 * its code and the socket ended. `close(code, reason)` starts the close
 * handshake from this side; a socket whose peer has not finished it within
 * CLOSE_TIMEOUT_MS is destroyed. Every `pingMs` (0 turns it off) the client is
 * pinged, and a connection whose ping has gone unanswered for two intervals is
 * closed 1001 — a laptop that slept or a tunnel that stalled never says
 * goodbye, and its socket would otherwise sit there for good.
 *
 * `onClose(code, reason)` fires exactly once, as soon as the connection is
 * over: with the code of whichever side closed first (1005 for a client close
 * with no code), the refusal's code when this side failed the connection, and
 * 1006 when the socket went away with no close frame either way.
 *
 * Answers `{ sendBinary(bytes), sendText(string), close(code = 1000, reason =
 * ""), bufferedAmount, open }`. The two senders answer false and drop the
 * frame once the connection is no longer open. `bufferedAmount` is the bytes
 * the socket has yet to flush, for the caller's backpressure.
 */
export function wsConnection(socket, head, {
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  pingMs = 30_000,
  onMessage,
  onClose,
} = {}) {
  const parser = createFrameParser({ maxMessageBytes });
  // "open" until either side sends a close; "closing" while this side waits
  // for the client to answer its close; "closed" once nothing more is read.
  let state = "open";
  let closedWith = null;
  let notified = false;
  let unanswered = 0;
  let destroyTimer = null;
  let pingTimer = null;

  // Typing is a stream of tiny frames, and Nagle would hold each keystroke's
  // echo back waiting for the last one's ACK.
  socket.setNoDelay?.(true);
  // An error is always followed by 'close', which is where the connection's end
  // is handled; the listener is here so the error is not thrown.
  socket.on("error", () => {});
  // The client closed its half, after a close handshake or without one.
  // Upgrade sockets come from an http.Server, which allows half-open sockets,
  // so this half is ended here or the socket would wait for good.
  socket.on("end", () => endSocket());
  socket.on("close", socketGone);

  if (pingMs > 0) {
    pingTimer = setInterval(keepalive, pingMs);
    pingTimer.unref?.();
  }

  // The head and the 'data' listener wait one tick, so onMessage is never
  // called before this function has returned the connection a handler may
  // want to answer through. Attaching 'data' in the same tick as reading the
  // head keeps them in order: until a listener is attached the upgrade socket
  // is not flowing, so anything that arrived meanwhile is still buffered.
  process.nextTick(() => {
    // A client that vanished between the upgrade and this call left a socket
    // whose 'close' may already have fired, before anything here listened —
    // and onClose is promised exactly once, not "unless it was quick".
    if (socket.destroyed) return socketGone();
    if (head && head.length) receive(head);
    socket.on("data", receive);
  });

  function socketGone() {
    clearTimeout(destroyTimer);
    finish(closedWith?.code ?? 1006, closedWith?.reason ?? "");
  }

  function receive(chunk) {
    if (state === "closed") return;
    for (const message of parser.push(chunk)) handle(message);
  }

  function handle(message) {
    switch (message.type) {
      case "text":
      case "binary":
        if (state !== "open") return;
        try {
          onMessage?.(message);
        } catch {
          close(1011, "the server could not handle a message");
        }
        return;
      case "ping":
        if (state === "open") write(encodeFrame(OP.PONG, message.data));
        return;
      case "pong":
        unanswered = 0;
        return;
      case "close":
        peerClosed(message.code, message.reason);
        return;
      case "error":
        failConnection(message.code, message.reason);
        return;
    }
  }

  function peerClosed(code, reason) {
    if (state === "closed") return;
    if (state === "open") {
      // §5.5.1: answer with a close, typically echoing the code received. A
      // close that carried no code is answered with none.
      write(encodeFrame(OP.CLOSE, closePayload(code === 1005 ? null : code, "")));
      closedWith = { code, reason };
    }
    state = "closed";
    // §7.1.1: once both closes have crossed, the server closes the TCP
    // connection first, so the client is not left in TIME_WAIT.
    endSocket();
    finish(closedWith.code, closedWith.reason);
  }

  function failConnection(code, reason) {
    if (state === "closed") return;
    // While this side waits for its own close to be answered it has already
    // sent the one close frame it may send; the refusal only ends the socket.
    if (state === "open") {
      const payload = closePayload(code, reason);
      write(encodeFrame(OP.CLOSE, payload));
      closedWith = { code, reason: payload.subarray(2).toString("utf8") };
    }
    state = "closed";
    endSocket();
    finish(closedWith.code, closedWith.reason);
  }

  function close(code = 1000, reason = "") {
    if (!isSendableCloseCode(code)) throw new RangeError(`${code} is not a close code that can be sent`);
    if (state !== "open") return;
    state = "closing";
    const payload = closePayload(code, reason);
    closedWith = { code, reason: payload.subarray(2).toString("utf8") };
    write(encodeFrame(OP.CLOSE, payload));
    armDestroy();
  }

  function keepalive() {
    if (state !== "open") return;
    if (unanswered >= 2) {
      close(1001, "no answer to ping");
      return;
    }
    unanswered += 1;
    write(encodeFrame(OP.PING));
  }

  function endSocket() {
    try { socket.end(); } catch { /* already gone */ }
    armDestroy();
  }

  function armDestroy() {
    if (destroyTimer) return;
    destroyTimer = setTimeout(() => socket.destroy(), CLOSE_TIMEOUT_MS);
    destroyTimer.unref?.();
  }

  function write(frame) {
    if (socket.destroyed || socket.writableEnded) return false;
    try {
      socket.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  function finish(code, reason) {
    if (notified) return;
    notified = true;
    state = "closed";
    clearInterval(pingTimer);
    try { onClose?.(code, reason); } catch { /* see the header: nothing throws out of a socket event */ }
  }

  return {
    sendBinary(bytes) {
      if (state !== "open") return false;
      return write(encodeFrame(OP.BINARY, bytes));
    },
    sendText(text) {
      if (state !== "open") return false;
      return write(encodeFrame(OP.TEXT, String(text)));
    },
    close,
    get bufferedAmount() {
      return socket.writableLength ?? 0;
    },
    get open() {
      return state === "open";
    },
  };
}
