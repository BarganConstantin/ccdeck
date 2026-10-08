// The terminal panel's WebSocket, from the server's side: the handshake, the
// frame codec and one connection's life, all hand-written in ws-frames.mjs
// because the server takes no runtime dependencies.
//
// Framing and masking are dull and easy to get wrong at the edges, and every
// edge here is one a browser or a hostile page can reach: the length that
// switches from 7 to 16 to 64 bits, the ping that arrives between two
// fragments, the character split across them, the message that announces a
// gigabyte, the close reason cut mid-character. Each is pinned here. The
// connection is driven through a stand-in socket where the clock matters
// (keepalive, the close timeout), and end to end through a real http.Server's
// 'upgrade' event with a hand-written client where the bytes on a real wire
// matter. No WebSocket library is involved on either side.
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as nodeBuffer from "node:buffer";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import {
  acceptKey, validateUpgrade, upgradeResponse, httpRefusal, encodeFrame, createFrameParser, wsConnection,
  isValidUtf8, OP, CLOSE_TIMEOUT_MS, DEFAULT_MAX_MESSAGE_BYTES,
// @ts-expect-error — plain .mjs server module, no types
} from "../../server/ws-frames.mjs";

// ─── Test-side wire helpers ──────────────────────────────────────────────
// Written from RFC 6455 §5.2 rather than borrowed from the module, so a bug in
// the module's codec cannot cancel itself out in a round trip.

const MASK = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
const SAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const SAMPLE_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

type Frame = { fin: boolean; rsv: number; opcode: number; masked: boolean; payload: Buffer };

/** One frame as a browser sends it: masked, shortest length encoding. The
 *  options forge the frames a browser never sends. */
function clientFrame(
  opcode: number,
  payload: Buffer | string = Buffer.alloc(0),
  { fin = true, mask = true, rsv = 0, key = MASK }: { fin?: boolean; mask?: boolean; rsv?: number; key?: Buffer } = {},
): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const n = body.length;
  const lengthBytes = n < 126 ? Buffer.from([n]) : n < 65536 ? Buffer.from([126, n >> 8, n & 0xff]) : (() => {
    const b = Buffer.alloc(9);
    b[0] = 127;
    b.writeUInt32BE(Math.floor(n / 2 ** 32), 1);
    b.writeUInt32BE(n % 2 ** 32, 5);
    return b;
  })();
  lengthBytes[0] |= mask ? 0x80 : 0;
  const first = Buffer.from([(fin ? 0x80 : 0) | (rsv << 4) | opcode]);
  if (!mask) return Buffer.concat([first, lengthBytes, body]);
  const masked = Buffer.alloc(n);
  for (let i = 0; i < n; i++) masked[i] = body[i] ^ key[i % 4];
  return Buffer.concat([first, lengthBytes, key, masked]);
}

/** A close frame's payload as a client would write it. */
function closeBody(code: number, reason = ""): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(code, 0);
  return Buffer.concat([b, Buffer.from(reason, "utf8")]);
}

/** The first whole frame in `buf` and how many bytes it took, or null. */
function decodeOne(buf: Buffer): { frame: Frame; size: number } | null {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let length = buf[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = buf.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buf.length < 10) return null;
    length = buf.readUInt32BE(2) * 2 ** 32 + buf.readUInt32BE(6);
    offset = 10;
  }
  const key = masked ? buf.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buf.length < offset + length) return null;
  let payload = Buffer.from(buf.subarray(offset, offset + length));
  if (key) payload = Buffer.from(payload.map((b, i) => b ^ key[i % 4]));
  return {
    frame: { fin: (buf[0] & 0x80) !== 0, rsv: (buf[0] >> 4) & 7, opcode: buf[0] & 0x0f, masked, payload },
    size: offset + length,
  };
}

/** Every whole frame in `buf`; fails on bytes left over. */
function framesIn(buf: Buffer): Frame[] {
  const out: Frame[] = [];
  let rest = buf;
  while (rest.length) {
    const next = decodeOne(rest);
    if (!next) throw new Error(`${rest.length} bytes that are not a whole frame`);
    out.push(next.frame);
    rest = rest.subarray(next.size);
  }
  return out;
}

function closeOf(frame: Frame): { code: number | null; reason: string } {
  expect(frame.opcode, "not a close frame").toBe(OP.CLOSE);
  if (frame.payload.length === 0) return { code: null, reason: "" };
  return { code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString("utf8") };
}

/** Deterministic bytes, so a failure reproduces. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
function bytes(n: number, seed = n): Buffer {
  const rand = seeded(seed);
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rand() * 256);
  return b;
}

/** Lets nextTick and I/O callbacks run. setImmediate is never faked here. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

afterEach(() => { vi.useRealTimers(); });

// ─── The handshake ───────────────────────────────────────────────────────

describe("the opening handshake", () => {
  it("accepts the RFC's sample key with the RFC's sample answer", () => {
    expect(acceptKey(SAMPLE_KEY), "RFC 6455 §1.3 gives this exact pair").toBe(SAMPLE_ACCEPT);
  });

  it("answers 101 with the accept value and nothing it did not agree to", () => {
    expect(upgradeResponse(SAMPLE_KEY)).toBe(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + `Sec-WebSocket-Accept: ${SAMPLE_ACCEPT}\r\n`
      + "\r\n",
    );
    expect(upgradeResponse(SAMPLE_KEY), "an extension answered is an extension the parser must then speak")
      .not.toMatch(/Sec-WebSocket-(Extensions|Protocol)/i);
  });

  it("refuses in plain HTTP, the 404 byte for byte what the upgrade handler writes", () => {
    expect(httpRefusal(404)).toBe("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    expect(httpRefusal(426, { "Sec-WebSocket-Version": "13" }))
      .toBe("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nSec-WebSocket-Version: 13\r\n\r\n");
  });
});

describe("validateUpgrade", () => {
  /** What Chrome sends, extension offer included. */
  const chrome = () => ({
    method: "GET",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    headers: {
      host: "127.0.0.1:4317",
      connection: "Upgrade",
      upgrade: "websocket",
      origin: "http://127.0.0.1:4317",
      "sec-websocket-version": "13",
      "sec-websocket-key": SAMPLE_KEY,
      "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
    } as Record<string, string | undefined>,
  });
  const changed = (change: (r: ReturnType<typeof chrome>) => void) => { const r = chrome(); change(r); return r; };

  it("accepts a browser's handshake and hands back its key", () => {
    expect(validateUpgrade(chrome())).toEqual({ ok: true, key: SAMPLE_KEY });
  });

  it("accepts the spellings real browsers use", () => {
    const firefox = changed(r => { r.headers.connection = "keep-alive, Upgrade"; });
    expect(validateUpgrade(firefox).ok, "Firefox lists keep-alive first").toBe(true);
    const shouty = changed(r => { r.headers.upgrade = "WebSocket"; r.headers.connection = "UPGRADE"; });
    expect(validateUpgrade(shouty).ok, "both headers are case-insensitive").toBe(true);
  });

  it("refuses anything that is not a GET", () => {
    for (const method of ["POST", "PUT", "CONNECT", "get"]) {
      const verdict = validateUpgrade(changed(r => { r.method = method; }));
      expect(verdict.ok, method).toBe(false);
      expect(verdict.status, method).toBe(405);
    }
  });

  it("refuses HTTP/1.0", () => {
    const verdict = validateUpgrade(changed(r => { r.httpVersionMinor = 0; }));
    expect(verdict).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses an upgrade to anything but websocket", () => {
    for (const upgrade of [undefined, "", "h2c", "websocket2", "websocket, h2c"]) {
      const verdict = validateUpgrade(changed(r => { r.headers.upgrade = upgrade; }));
      expect(verdict, String(upgrade)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("refuses a Connection header that does not name upgrade as a token", () => {
    for (const connection of [undefined, "keep-alive", "upgrades", "close, keep-alive"]) {
      const verdict = validateUpgrade(changed(r => { r.headers.connection = connection; }));
      expect(verdict, String(connection)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("refuses another protocol version with 426 and names the one it speaks", () => {
    for (const version of [undefined, "8", "12", "14", "13, 8"]) {
      const verdict = validateUpgrade(changed(r => { r.headers["sec-websocket-version"] = version; }));
      expect(verdict, String(version)).toMatchObject({
        ok: false, status: 426, headers: { "Sec-WebSocket-Version": "13" },
      });
    }
  });

  it("refuses a key that is not base64 of exactly 16 bytes", () => {
    const keys: Record<string, string | undefined> = {
      missing: undefined,
      empty: "",
      "15 bytes": Buffer.alloc(15, 1).toString("base64"),
      "17 bytes": Buffer.alloc(17, 1).toString("base64"),
      "not base64": "!!!!!!!!!!!!!!!!!!!!!!==",
      "non-canonical last character": "dGhlIHNhbXBsZSBub25jZR==",
      "space inside": "dGhlIHNhbXBs ZSBub25jZQ==",
      "two keys Node joined": `${SAMPLE_KEY}, ${SAMPLE_KEY}`,
      "base64url alphabet": "dGhlIHNhbXBsZSBub25jZ_==",
    };
    for (const [name, key] of Object.entries(keys)) {
      const verdict = validateUpgrade(changed(r => { r.headers["sec-websocket-key"] = key; }));
      expect(verdict, name).toMatchObject({ ok: false, status: 400 });
    }
    const fresh = Buffer.alloc(16, 0xab).toString("base64");
    expect(validateUpgrade(changed(r => { r.headers["sec-websocket-key"] = fresh; })).ok, "any 16 bytes will do").toBe(true);
  });

  it("gives every refusal a short reason to log", () => {
    const verdict = validateUpgrade(changed(r => { r.method = "POST"; }));
    expect(typeof verdict.reason).toBe("string");
    expect(verdict.reason.length).toBeGreaterThan(0);
  });
});

// ─── The server's frames ─────────────────────────────────────────────────

describe("encodeFrame", () => {
  it("uses the shortest of the 7-, 16- and 64-bit length encodings", () => {
    const cases: [number, number[]][] = [
      [0, [0x82, 0]],
      [125, [0x82, 125]],
      [126, [0x82, 126, 0x00, 0x7e]],
      [65535, [0x82, 126, 0xff, 0xff]],
      [65536, [0x82, 127, 0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00]],
      [(1 << 20) + 3, [0x82, 127, 0, 0, 0, 0, 0x00, 0x10, 0x00, 0x03]],
    ];
    for (const [n, header] of cases) {
      const payload = bytes(n);
      const frame = encodeFrame(OP.BINARY, payload);
      expect([...frame.subarray(0, header.length)], `${n} bytes`).toEqual(header);
      expect(frame.length, `${n} bytes`).toBe(header.length + n);
      expect(frame.subarray(header.length).equals(payload), `${n} bytes: the payload`).toBe(true);
    }
  });

  it("never masks: a server's frame goes out as it is", () => {
    for (const n of [0, 5, 300, 70_000]) {
      const [frame] = framesIn(encodeFrame(OP.BINARY, bytes(n)));
      expect(frame.masked, `${n} bytes`).toBe(false);
      expect(frame.payload.equals(bytes(n)), `${n} bytes`).toBe(true);
    }
  });

  it("clears FIN only when asked to, for a fragment", () => {
    expect(encodeFrame(OP.TEXT, "a")[0]).toBe(0x81);
    expect(encodeFrame(OP.TEXT, "a", { fin: false })[0]).toBe(0x01);
    expect(encodeFrame(OP.CONTINUATION, "b", { fin: false })[0]).toBe(0x00);
    expect(encodeFrame(OP.CONTINUATION, "c")[0]).toBe(0x80);
  });

  it("writes a string as UTF-8 and a typed array as its own view", () => {
    expect(framesIn(encodeFrame(OP.TEXT, "héllo ✓"))[0].payload.toString("utf8")).toBe("héllo ✓");
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    expect([...framesIn(encodeFrame(OP.BINARY, view))[0].payload], "the view's offset is honoured").toEqual([1, 2, 3]);
    expect(framesIn(encodeFrame(OP.PING))[0].payload.length, "no payload is an empty one").toBe(0);
  });

  it("refuses frames no peer would accept", () => {
    expect(() => encodeFrame(3, "x"), "reserved opcode").toThrow(RangeError);
    expect(() => encodeFrame(0xb, "x"), "reserved control opcode").toThrow(RangeError);
    expect(() => encodeFrame(OP.PING, bytes(126)), "a ping over 125 bytes").toThrow(RangeError);
    expect(() => encodeFrame(OP.CLOSE, closeBody(1000), { fin: false }), "a fragmented close").toThrow(RangeError);
    expect(encodeFrame(OP.PING, bytes(125)).length, "125 is allowed").toBe(127);
  });
});

// ─── The client's frames ─────────────────────────────────────────────────

describe("createFrameParser", () => {
  it("reads a masked frame of each length encoding, at every boundary", () => {
    for (const n of [0, 1, 125, 126, 127, 1000, 65535, 65536, 70_000]) {
      const parser = createFrameParser();
      const out = parser.push(clientFrame(OP.BINARY, bytes(n)));
      expect(out, `${n} bytes`).toHaveLength(1);
      expect(out[0].type, `${n} bytes`).toBe("binary");
      expect(out[0].data.equals(bytes(n)), `${n} bytes: unmasked`).toBe(true);
    }
  });

  it("reads the same messages whether the bytes come at once or one at a time", () => {
    const wire = Buffer.concat([
      clientFrame(OP.TEXT, "héllo"),
      clientFrame(OP.BINARY, bytes(300)),
      clientFrame(OP.PING, "p"),
      clientFrame(OP.BINARY, bytes(70_000)),
    ]);
    const whole = createFrameParser().push(wire);
    const trickled: any[] = [];
    const parser = createFrameParser();
    for (let i = 0; i < wire.length; i++) trickled.push(...parser.push(wire.subarray(i, i + 1)));
    expect(whole.map((m: any) => m.type)).toEqual(["text", "binary", "ping", "binary"]);
    expect(trickled.map((m: any) => m.type)).toEqual(["text", "binary", "ping", "binary"]);
    for (let i = 0; i < whole.length; i++) {
      expect(trickled[i].data.equals(whole[i].data), `message ${i}`).toBe(true);
    }
    expect(whole[0].data.toString("utf8")).toBe("héllo");
  });

  it("reads half a mebibyte dripped one byte per read without slowing to a crawl", () => {
    // A client controls how its bytes are split. One that drips a large frame
    // a byte at a time must cost the deck time in proportion to the bytes,
    // not to their square — the queue of reads is dropped in one splice.
    const payload = bytes(512 * 1024);
    const wire = clientFrame(OP.BINARY, payload);
    const parser = createFrameParser();
    const out: any[] = [];
    const started = performance.now();
    for (let i = 0; i < wire.length; i++) out.push(...parser.push(wire.subarray(i, i + 1)));
    const took = performance.now() - started;
    expect(out).toHaveLength(1);
    expect(out[0].data.equals(payload)).toBe(true);
    expect(took, `took ${Math.round(took)} ms`).toBeLessThan(5_000);
  });

  it("does not rewrite the caller's buffer while unmasking", () => {
    const wire = clientFrame(OP.TEXT, "keep me");
    const copy = Buffer.from(wire);
    createFrameParser().push(wire);
    expect(wire.equals(copy)).toBe(true);
  });

  it("reassembles a fragmented message and lets a ping through between its fragments", () => {
    const parser = createFrameParser();
    expect(parser.push(clientFrame(OP.TEXT, "hel", { fin: false }))).toEqual([]);
    const mid = parser.push(clientFrame(OP.PING, "still there?"));
    expect(mid.map((m: any) => m.type), "the ping comes out at once").toEqual(["ping"]);
    expect(mid[0].data.toString()).toBe("still there?");
    expect(parser.push(clientFrame(OP.CONTINUATION, "lo ", { fin: false }))).toEqual([]);
    const done = parser.push(clientFrame(OP.CONTINUATION, "world"));
    expect(done).toHaveLength(1);
    expect(done[0].type).toBe("text");
    expect(done[0].data.toString("utf8")).toBe("hello world");
  });

  it("reassembles binary fragments, and a pong between them", () => {
    const parser = createFrameParser();
    const a = bytes(200, 1), b = bytes(70_000, 2), c = bytes(3, 3);
    const out = [
      ...parser.push(clientFrame(OP.BINARY, a, { fin: false })),
      ...parser.push(clientFrame(OP.CONTINUATION, b, { fin: false })),
      ...parser.push(clientFrame(OP.PONG)),
      ...parser.push(clientFrame(OP.CONTINUATION, c)),
    ];
    expect(out.map((m: any) => m.type)).toEqual(["pong", "binary"]);
    expect(out[1].data.equals(Buffer.concat([a, b, c]))).toBe(true);
  });

  it("accepts a character split across two fragments", () => {
    const check = Buffer.from("✓", "utf8"); // three bytes
    const parser = createFrameParser();
    parser.push(clientFrame(OP.TEXT, Buffer.concat([Buffer.from("ok "), check.subarray(0, 2)]), { fin: false }));
    const out = parser.push(clientFrame(OP.CONTINUATION, check.subarray(2)));
    expect(out).toEqual([{ type: "text", data: Buffer.from("ok ✓") }]);
  });

  it("reads a frame whose header is split across reads", () => {
    const parser = createFrameParser();
    const wire = clientFrame(OP.BINARY, bytes(65536));
    expect(parser.push(wire.subarray(0, 1))).toEqual([]);
    expect(parser.push(wire.subarray(1, 5))).toEqual([]);
    expect(parser.push(wire.subarray(5, 12))).toEqual([]);
    const out = parser.push(wire.subarray(12));
    expect(out[0].data.equals(bytes(65536))).toBe(true);
  });

  describe("refuses with 1002", () => {
    const cases: [string, Buffer][] = [
      ["an unmasked client frame", clientFrame(OP.TEXT, "hi", { mask: false })],
      ["RSV1 with no extension agreed", clientFrame(OP.TEXT, "hi", { rsv: 4 })],
      ["RSV2", clientFrame(OP.BINARY, "hi", { rsv: 2 })],
      ["RSV3", clientFrame(OP.BINARY, "hi", { rsv: 1 })],
      ...[3, 4, 5, 6, 7].map(op => [`reserved data opcode ${op}`, clientFrame(op, "x")] as [string, Buffer]),
      ...[0xb, 0xc, 0xd, 0xe, 0xf].map(op => [`reserved control opcode ${op}`, clientFrame(op, "x")] as [string, Buffer]),
      ["a ping over 125 bytes", clientFrame(OP.PING, bytes(126))],
      ["a close over 125 bytes", clientFrame(OP.CLOSE, Buffer.concat([closeBody(1000), bytes(124)]))],
      ["a fragmented ping", clientFrame(OP.PING, "x", { fin: false })],
      ["a fragmented close", clientFrame(OP.CLOSE, closeBody(1000), { fin: false })],
      ["a continuation with nothing to continue", clientFrame(OP.CONTINUATION, "x")],
      ["a new message inside a fragmented one",
        Buffer.concat([clientFrame(OP.TEXT, "a", { fin: false }), clientFrame(OP.TEXT, "b")])],
      ["a binary message inside a fragmented text one",
        Buffer.concat([clientFrame(OP.TEXT, "a", { fin: false }), clientFrame(OP.BINARY, "b")])],
      ["a 64-bit length with its top bit set",
        Buffer.from([0x82, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0])],
      ["a close with a one-byte payload", clientFrame(OP.CLOSE, Buffer.from([3]))],
    ];
    for (const [name, wire] of cases) {
      it(`for ${name}`, () => {
        const out = createFrameParser().push(wire);
        expect(out.at(-1), name).toMatchObject({ type: "error", code: 1002 });
        expect(out.filter((m: any) => m.type === "error"), "one refusal, once").toHaveLength(1);
      });
    }

    it("for an unmasked frame as soon as its header arrives", () => {
      const out = createFrameParser().push(clientFrame(OP.BINARY, bytes(1000), { mask: false }).subarray(0, 4));
      expect(out, "no need to wait for a payload that will be refused").toMatchObject([{ type: "error", code: 1002 }]);
    });

    it("for a close code that is never sent on the wire", () => {
      for (const code of [0, 999, 1004, 1005, 1006, 1015, 1016, 2000, 2999, 5000, 65535]) {
        const out = createFrameParser().push(clientFrame(OP.CLOSE, closeBody(code)));
        expect(out, String(code)).toMatchObject([{ type: "error", code: 1002 }]);
      }
    });
  });

  describe("caps a message", () => {
    it("at a mebibyte unless told otherwise, refusing from the header alone", () => {
      expect(DEFAULT_MAX_MESSAGE_BYTES).toBe(1 << 20);
      const header = clientFrame(OP.BINARY, Buffer.alloc((1 << 20) + 1)).subarray(0, 14);
      const out = createFrameParser().push(header);
      expect(out, "a payload over the cap is never waited for").toMatchObject([{ type: "error", code: 1009 }]);
      const atCap = createFrameParser().push(clientFrame(OP.BINARY, Buffer.alloc(1 << 20, 7)));
      expect(atCap[0]?.type, "exactly the cap is allowed").toBe("binary");
    });

    it("on the whole message, not on one fragment", () => {
      const parser = createFrameParser({ maxMessageBytes: 10 });
      expect(parser.push(clientFrame(OP.TEXT, "123456", { fin: false }))).toEqual([]);
      expect(parser.push(clientFrame(OP.PING, "0123456789ab")), "control frames are not counted")
        .toMatchObject([{ type: "ping" }]);
      expect(parser.push(clientFrame(OP.CONTINUATION, "12345"))).toMatchObject([{ type: "error", code: 1009 }]);

      const fits = createFrameParser({ maxMessageBytes: 10 });
      fits.push(clientFrame(OP.TEXT, "123456", { fin: false }));
      expect(fits.push(clientFrame(OP.CONTINUATION, "1234"))).toEqual([{ type: "text", data: Buffer.from("1234561234") }]);
      expect(fits.push(clientFrame(OP.TEXT, "0123456789")), "the count starts again with each message")
        .toMatchObject([{ type: "text" }]);
    });

    it("refuses an announced length far past anything a Buffer could hold", () => {
      const huge = Buffer.from([0x82, 0xff, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
      expect(createFrameParser().push(huge)).toMatchObject([{ type: "error", code: 1009 }]);
    });
  });

  describe("refuses with 1007", () => {
    const broken: [string, number[]][] = [
      ["a lone continuation byte", [0x80]],
      ["an overlong slash", [0xc0, 0xaf]],
      ["an overlong three-byte form", [0xe0, 0x80, 0xaf]],
      ["a UTF-16 surrogate", [0xed, 0xa0, 0x80]],
      ["a code point past U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
      ["a byte UTF-8 never uses", [0xf5, 0x80, 0x80, 0x80]],
      ["a character cut short", [0x61, 0xe2, 0x9c]],
    ];
    for (const [name, raw] of broken) {
      it(`for a text message with ${name}`, () => {
        const out = createFrameParser().push(clientFrame(OP.TEXT, Buffer.from(raw)));
        expect(out).toMatchObject([{ type: "error", code: 1007 }]);
      });
    }

    it("but reads the same bytes as a binary message", () => {
      for (const [name, raw] of broken) {
        const out = createFrameParser().push(clientFrame(OP.BINARY, Buffer.from(raw)));
        expect(out, name).toEqual([{ type: "binary", data: Buffer.from(raw) }]);
      }
    });

    it("for a close reason that is not UTF-8", () => {
      const body = Buffer.concat([closeBody(1000), Buffer.from([0xff, 0xfe])]);
      expect(createFrameParser().push(clientFrame(OP.CLOSE, body))).toMatchObject([{ type: "error", code: 1007 }]);
    });

    it("when the message is whole, once its fragments are joined", () => {
      const parser = createFrameParser();
      expect(parser.push(clientFrame(OP.TEXT, Buffer.from([0x61, 0xe2]), { fin: false }))).toEqual([]);
      expect(parser.push(clientFrame(OP.CONTINUATION, Buffer.from([0x41])))).toMatchObject([{ type: "error", code: 1007 }]);
    });
  });

  describe("reads a close frame", () => {
    it("with its code and reason", () => {
      const out = createFrameParser().push(clientFrame(OP.CLOSE, closeBody(1001, "tab closed — bye")));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ type: "close", code: 1001, reason: "tab closed — bye" });
    });

    it("with no payload as 1005, the code that means none was given", () => {
      expect(createFrameParser().push(clientFrame(OP.CLOSE))).toMatchObject([{ type: "close", code: 1005, reason: "" }]);
    });

    it("with any code a peer may send", () => {
      for (const code of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4000, 4999]) {
        expect(createFrameParser().push(clientFrame(OP.CLOSE, closeBody(code))), String(code))
          .toMatchObject([{ type: "close", code }]);
      }
    });

    it("and reads nothing after it", () => {
      const parser = createFrameParser();
      const out = parser.push(Buffer.concat([clientFrame(OP.CLOSE, closeBody(1000)), clientFrame(OP.TEXT, "late")]));
      expect(out.map((m: any) => m.type)).toEqual(["close"]);
      expect(parser.push(clientFrame(OP.TEXT, "later"))).toEqual([]);
    });
  });

  it("hands over what came before a refusal, then reads nothing more", () => {
    const parser = createFrameParser();
    const out = parser.push(Buffer.concat([
      clientFrame(OP.TEXT, "fine"),
      clientFrame(OP.TEXT, "bad", { mask: false }),
      clientFrame(OP.TEXT, "never read"),
    ]));
    expect(out.map((m: any) => m.type)).toEqual(["text", "error"]);
    expect(parser.push(clientFrame(OP.TEXT, "still never read"))).toEqual([]);
  });
});

describe("isValidUtf8", () => {
  it("agrees with a strict decoder, and with Node's own check where there is one", () => {
    const strict = new TextDecoder("utf-8", { fatal: true });
    const decodes = (b: Buffer) => { try { strict.decode(b); return true; } catch { return false; } };
    const native = (nodeBuffer as { isUtf8?: (b: Buffer) => boolean }).isUtf8;
    const rand = seeded(1234);
    const samples: Buffer[] = [];
    // Valid text from random code points (surrogates skipped), then each with
    // one byte changed, then raw bytes weighted towards UTF-8's lead bytes.
    for (let i = 0; i < 600; i++) {
      let s = "";
      for (let j = 0; j < 1 + Math.floor(rand() * 6); j++) {
        let cp = Math.floor(rand() * 0x110000);
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0x41;
        s += String.fromCodePoint(cp);
      }
      const valid = Buffer.from(s, "utf8");
      samples.push(valid);
      const changed = Buffer.from(valid);
      changed[Math.floor(rand() * changed.length)] = Math.floor(rand() * 256);
      samples.push(changed);
    }
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rand() * 5);
      samples.push(Buffer.from(Array.from({ length: n }, () => (rand() < 0.5 ? 0x80 : 0xc0) + Math.floor(rand() * 64))));
    }
    let invalid = 0;
    for (const sample of samples) {
      const expected = decodes(sample);
      if (!expected) invalid += 1;
      expect(isValidUtf8(sample), sample.toString("hex")).toBe(expected);
      if (native) expect(native(sample), `Node disagrees on ${sample.toString("hex")}`).toBe(expected);
    }
    expect(invalid, "the sweep has to include broken bytes to mean anything").toBeGreaterThan(500);
    expect(isValidUtf8(Buffer.alloc(0)), "nothing is valid").toBe(true);
  });
});

// ─── One connection ──────────────────────────────────────────────────────

/** The socket an 'upgrade' event hands over, as far as wsConnection uses it.
 *  Like the real one it is paused: bytes that arrive before anything listens
 *  for 'data' are kept, and flow on the tick after a listener attaches, which
 *  is when Node's resume() lets them go. */
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  noDelay: boolean | undefined;
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  ends = 0;
  destroys = 0;
  private held: Buffer[] = [];
  constructor() {
    super();
    this.on("newListener", event => {
      if (event !== "data") return;
      process.nextTick(() => { for (const chunk of this.held.splice(0)) this.emit("data", chunk); });
    });
  }
  /** Bytes arriving from the client. */
  feed(chunk: Buffer) {
    if (this.listenerCount("data") > 0) this.emit("data", chunk);
    else this.held.push(chunk);
  }
  setNoDelay(on: boolean) { this.noDelay = on; return this; }
  write(chunk: Buffer) { this.written.push(Buffer.from(chunk)); return true; }
  end() { this.ends += 1; this.writableEnded = true; return this; }
  destroy() {
    this.destroys += 1;
    if (!this.destroyed) {
      this.destroyed = true;
      process.nextTick(() => this.emit("close", false));
    }
    return this;
  }
  frames(): Frame[] { return framesIn(Buffer.concat(this.written)); }
  last(): Frame { return this.frames().at(-1)!; }
}

type Opened = {
  socket: FakeSocket;
  conn: any;
  messages: { type: string; data: Buffer }[];
  closes: [number, string][];
  send: (wire: Buffer) => Promise<void>;
};

async function opened(options: Record<string, unknown> = {}, head?: Buffer): Promise<Opened> {
  const socket = new FakeSocket();
  const messages: Opened["messages"] = [];
  const closes: Opened["closes"] = [];
  const conn = wsConnection(socket, head ?? Buffer.alloc(0), {
    pingMs: 0,
    onMessage: (m: Opened["messages"][number]) => messages.push(m),
    onClose: (code: number, reason: string) => closes.push([code, reason]),
    ...options,
  });
  await settle();
  return {
    socket, conn, messages, closes,
    send: async (wire: Buffer) => { socket.feed(wire); await settle(); },
  };
}

describe("wsConnection", () => {
  it("turns Nagle off, so a keystroke's echo is not held back", async () => {
    const { socket } = await opened();
    expect(socket.noDelay).toBe(true);
  });

  it("reads the bytes past the handshake first, and only once the connection exists", async () => {
    const socket = new FakeSocket();
    const seen: string[] = [];
    // `const`, so a handler called before wsConnection returned would meet
    // `conn` in its temporal dead zone and the reply below would never go out.
    const conn: any = wsConnection(socket, clientFrame(OP.TEXT, "from head"), {
      pingMs: 0,
      onMessage: (m: { data: Buffer }) => { seen.push(m.data.toString()); conn.sendText(`got ${m.data}`); },
    });
    socket.feed(clientFrame(OP.TEXT, "from data"));
    expect(seen, "nothing is delivered before wsConnection has returned").toEqual([]);
    await settle();
    expect(seen, "head before anything the socket read later").toEqual(["from head", "from data"]);
    expect(socket.frames().map(f => f.payload.toString())).toEqual(["got from head", "got from data"]);
  });

  it("gives onMessage text and binary messages, and keeps control frames to itself", async () => {
    const { messages, send } = await opened();
    await send(Buffer.concat([
      clientFrame(OP.TEXT, '{"t":"size","cols":120,"rows":40}'),
      clientFrame(OP.PING, "x"),
      clientFrame(OP.PONG, "y"),
      clientFrame(OP.BINARY, Buffer.from([0x1b, 0x5b, 0x41])),
    ]));
    expect(messages.map(m => m.type)).toEqual(["text", "binary"]);
    expect(JSON.parse(messages[0].data.toString())).toEqual({ t: "size", cols: 120, rows: 40 });
    expect([...messages[1].data]).toEqual([0x1b, 0x5b, 0x41]);
  });

  it("answers a ping with a pong carrying the same bytes", async () => {
    const { socket, send } = await opened();
    await send(clientFrame(OP.PING, "are you there"));
    const [pong] = socket.frames();
    expect(pong.opcode).toBe(OP.PONG);
    expect(pong.masked, "a server never masks").toBe(false);
    expect(pong.payload.toString()).toBe("are you there");
  });

  it("sends unmasked binary and text frames", async () => {
    const { socket, conn } = await opened();
    expect(conn.sendBinary(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(conn.sendText("héllo")).toBe(true);
    expect(conn.sendBinary(bytes(70_000))).toBe(true);
    const [binary, text, big] = socket.frames();
    expect(binary).toMatchObject({ fin: true, opcode: OP.BINARY, masked: false });
    expect([...binary.payload]).toEqual([1, 2, 3]);
    expect(text).toMatchObject({ fin: true, opcode: OP.TEXT, masked: false });
    expect(text.payload.toString("utf8")).toBe("héllo");
    expect(big.payload.equals(bytes(70_000))).toBe(true);
  });

  it("reports what the socket has yet to flush as bufferedAmount", async () => {
    const { socket, conn } = await opened();
    expect(conn.bufferedAmount).toBe(0);
    socket.writableLength = 5 * 1024 * 1024;
    expect(conn.bufferedAmount).toBe(5 * 1024 * 1024);
  });

  describe("closing", () => {
    it("echoes a client's close with its code, ends the socket and reports the close", async () => {
      const { socket, conn, closes, send } = await opened();
      await send(clientFrame(OP.CLOSE, closeBody(1001, "tab closed")));
      expect(closeOf(socket.last())).toEqual({ code: 1001, reason: "" });
      expect(socket.ends, "the server closes TCP first (§7.1.1)").toBe(1);
      expect(conn.open).toBe(false);
      expect(closes).toEqual([[1001, "tab closed"]]);
      socket.destroy();
      await settle();
      expect(closes, "the socket's own close is not a second report").toHaveLength(1);
    });

    it("answers a close with no code with a close with no code, and reports 1005", async () => {
      const { socket, closes, send } = await opened();
      await send(clientFrame(OP.CLOSE));
      expect(closeOf(socket.last())).toEqual({ code: null, reason: "" });
      expect(closes).toEqual([[1005, ""]]);
    });

    it("starts the handshake from this side and ends the socket when the client answers", async () => {
      const { socket, conn, closes, send, messages } = await opened();
      conn.close(4001, "session ended");
      expect(closeOf(socket.last())).toEqual({ code: 4001, reason: "session ended" });
      expect(conn.open).toBe(false);
      expect(conn.sendText("too late"), "nothing goes out after a close").toBe(false);
      expect(conn.sendBinary(Buffer.from("x"))).toBe(false);
      conn.close(1000);
      expect(socket.frames().filter(f => f.opcode === OP.CLOSE), "one close frame, ever").toHaveLength(1);
      expect(socket.ends, "the client gets to answer first").toBe(0);
      expect(closes).toEqual([]);

      await send(clientFrame(OP.TEXT, "crossed in flight"));
      expect(messages, "data after this side's close is dropped").toEqual([]);
      await send(clientFrame(OP.CLOSE, closeBody(4001)));
      expect(socket.ends).toBe(1);
      expect(socket.frames().filter(f => f.opcode === OP.CLOSE), "the answer is not answered").toHaveLength(1);
      expect(closes, "the code of the side that closed first").toEqual([[4001, "session ended"]]);
    });

    it("closes with 1000 and no reason by default", async () => {
      const { socket, conn } = await opened();
      conn.close();
      expect(closeOf(socket.last())).toEqual({ code: 1000, reason: "" });
    });

    it("destroys the socket of a client that never answers, two seconds on", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const { socket, conn, closes } = await opened();
      conn.close(1000, "bye");
      expect(CLOSE_TIMEOUT_MS).toBe(2000);
      vi.advanceTimersByTime(CLOSE_TIMEOUT_MS - 1);
      expect(socket.destroyed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(socket.destroyed).toBe(true);
      await settle();
      expect(closes).toEqual([[1000, "bye"]]);
      expect(vi.getTimerCount(), "nothing is left ticking").toBe(0);
    });

    it("destroys a socket whose client never closes its side after the echo", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const { socket, send } = await opened();
      await send(clientFrame(OP.CLOSE, closeBody(1000)));
      expect(socket.destroyed).toBe(false);
      vi.advanceTimersByTime(CLOSE_TIMEOUT_MS);
      expect(socket.destroyed).toBe(true);
    });

    it("cuts a long reason to 123 bytes without splitting a character", async () => {
      const { socket, conn, closes, send } = await opened();
      conn.close(4000, "é".repeat(100));
      const frame = socket.last();
      expect(frame.payload.length, "a control frame carries at most 125 bytes").toBeLessThanOrEqual(125);
      const { reason } = closeOf(frame);
      expect(reason).toBe("é".repeat(61));
      expect(isValidUtf8(frame.payload.subarray(2)), "a browser fails a connection over a broken reason").toBe(true);
      await send(clientFrame(OP.CLOSE, closeBody(4000)));
      expect(closes).toEqual([[4000, "é".repeat(61)]]);
    });

    it("refuses to send a code that never goes on the wire, and stays open", async () => {
      const { conn, socket } = await opened();
      for (const code of [999, 1004, 1005, 1006, 1015, 2000, 5000, 1000.5]) {
        expect(() => conn.close(code), String(code)).toThrow(RangeError);
      }
      expect(conn.open).toBe(true);
      expect(socket.written).toEqual([]);
      for (const code of [1001, 1011, 1012, 3000, 4999]) {
        const other = await opened();
        expect(() => other.conn.close(code), String(code)).not.toThrow();
      }
    });

    it("reports 1006 when the socket goes away with no close frame either way", async () => {
      const { socket, conn, closes } = await opened();
      socket.emit("error", new Error("read ECONNRESET"));
      socket.emit("close", true);
      expect(closes).toEqual([[1006, ""]]);
      expect(conn.open).toBe(false);
      expect(conn.sendText("x")).toBe(false);
    });

    it("reports 1006 for a socket that was already gone when it was handed over", async () => {
      const socket = new FakeSocket();
      socket.destroyed = true; // its 'close' fired before anything listened
      const closes: [number, string][] = [];
      const conn = wsConnection(socket, clientFrame(OP.TEXT, "never read"), {
        pingMs: 0,
        onMessage: () => { throw new Error("a dead socket has no messages"); },
        onClose: (code: number, reason: string) => closes.push([code, reason]),
      });
      await settle();
      expect(closes).toEqual([[1006, ""]]);
      expect(conn.open).toBe(false);
      expect(socket.written, "nothing is written to a dead socket").toEqual([]);
    });

    it("ends its half of a socket the client half-closed", async () => {
      const { socket, closes } = await opened();
      socket.emit("end");
      expect(socket.ends).toBe(1);
      socket.emit("close", false);
      expect(closes).toEqual([[1006, ""]]);
    });

    it("reports once, however many ways the connection ends at once", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const { socket, conn, closes, send } = await opened({ pingMs: 1000 });
      conn.close(1000);
      await send(clientFrame(OP.CLOSE, closeBody(1000)));
      socket.emit("error", new Error("EPIPE"));
      socket.emit("end");
      socket.emit("close", true);
      vi.advanceTimersByTime(10 * CLOSE_TIMEOUT_MS);
      await settle();
      expect(closes).toHaveLength(1);
    });

    it("is not shaken by an onClose that throws", async () => {
      const { socket, send } = await opened({ onClose: () => { throw new Error("handler bug"); } });
      await send(clientFrame(OP.CLOSE, closeBody(1000)));
      expect(() => socket.emit("close", false)).not.toThrow();
    });
  });

  describe("failing the connection", () => {
    it("answers a protocol error with a 1002 close, ends the socket and reads nothing more", async () => {
      const { socket, conn, closes, messages, send } = await opened();
      await send(clientFrame(OP.TEXT, "unmasked", { mask: false }));
      const { code } = closeOf(socket.last());
      expect(code).toBe(1002);
      expect(socket.ends).toBe(1);
      expect(conn.open).toBe(false);
      expect(closes.map(c => c[0])).toEqual([1002]);
      await send(clientFrame(OP.TEXT, "after"));
      await send(clientFrame(OP.PING, "after"));
      expect(messages).toEqual([]);
      expect(socket.frames(), "no pong, no second close").toHaveLength(1);
    });

    it("answers a message over its cap with 1009", async () => {
      const { socket, closes, messages, send } = await opened({ maxMessageBytes: 16 });
      await send(clientFrame(OP.BINARY, bytes(16)));
      await send(clientFrame(OP.BINARY, bytes(17)));
      expect(messages).toHaveLength(1);
      expect(closeOf(socket.last()).code).toBe(1009);
      expect(closes.map(c => c[0])).toEqual([1009]);
    });

    it("answers a text message that is not UTF-8 with 1007", async () => {
      const { socket, closes, send } = await opened();
      await send(clientFrame(OP.TEXT, Buffer.from([0xed, 0xa0, 0x80])));
      expect(closeOf(socket.last()).code).toBe(1007);
      expect(closes.map(c => c[0])).toEqual([1007]);
    });

    it("closes 1011 when a message handler throws, and the throw goes no further", async () => {
      const { socket, conn, send } = await opened({ onMessage: () => { throw new Error("handler bug"); } });
      await send(clientFrame(OP.TEXT, "boom"));
      expect(closeOf(socket.last()).code).toBe(1011);
      expect(conn.open).toBe(false);
    });

    it("only ends the socket when the refusal comes while this side's close is unanswered", async () => {
      const { socket, conn, closes, send } = await opened();
      conn.close(4002, "mine");
      await send(clientFrame(OP.TEXT, "garbage", { mask: false }));
      expect(socket.frames().filter(f => f.opcode === OP.CLOSE), "one close frame is all §5.5.1 allows").toHaveLength(1);
      expect(socket.ends).toBe(1);
      expect(closes, "the code of the side that closed first").toEqual([[4002, "mine"]]);
    });
  });

  describe("keepalive", () => {
    const fake = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

    it("pings every pingMs and never gives up on a client that answers", async () => {
      fake();
      const { socket, conn, send } = await opened({ pingMs: 1000 });
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(1000);
        const ping = socket.last();
        expect(ping.opcode, `interval ${i}`).toBe(OP.PING);
        await send(clientFrame(OP.PONG, ping.payload));
      }
      expect(conn.open).toBe(true);
      expect(socket.frames().filter(f => f.opcode === OP.PING)).toHaveLength(10);
    });

    it("closes 1001 once a ping has gone unanswered for two intervals, then destroys the socket", async () => {
      fake();
      const { socket, conn, closes } = await opened({ pingMs: 1000 });
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      expect(socket.frames().map(f => f.opcode), "two pings, no answer yet").toEqual([OP.PING, OP.PING]);
      expect(conn.open).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(closeOf(socket.last()).code).toBe(1001);
      expect(conn.open).toBe(false);
      vi.advanceTimersByTime(CLOSE_TIMEOUT_MS);
      expect(socket.destroyed, "a client that does not pong will not echo a close either").toBe(true);
      await settle();
      expect(closes.map(c => c[0])).toEqual([1001]);
      expect(vi.getTimerCount(), "nothing is left ticking").toBe(0);
    });

    it("counts a late pong: one answer clears both outstanding pings", async () => {
      fake();
      const { conn, socket, send } = await opened({ pingMs: 1000 });
      vi.advanceTimersByTime(2000);
      await send(clientFrame(OP.PONG));
      vi.advanceTimersByTime(1000);
      expect(conn.open).toBe(true);
      expect(socket.last().opcode).toBe(OP.PING);
    });

    it("stops pinging once closed and leaves no timer behind", async () => {
      fake();
      const { socket, send } = await opened({ pingMs: 1000 });
      await send(clientFrame(OP.CLOSE, closeBody(1000)));
      socket.destroy();
      await settle();
      const before = socket.written.length;
      vi.advanceTimersByTime(10_000);
      expect(socket.written.length).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("sets no timer at all with pingMs 0", async () => {
      fake();
      await opened({ pingMs: 0 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("pings every 30 seconds unless told otherwise", async () => {
      fake();
      const socket = new FakeSocket();
      wsConnection(socket, Buffer.alloc(0), {});
      await settle();
      vi.advanceTimersByTime(29_999);
      expect(socket.written).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(socket.last().opcode).toBe(OP.PING);
    });
  });
});

// ─── On a real wire ──────────────────────────────────────────────────────

const servers: http.Server[] = [];
const clients: net.Socket[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.destroy();
  for (const s of servers.splice(0)) s.close();
});

/** An http.Server whose upgrade listener checks the handshake, accepts it and
 *  echoes: text back as `echo:<text>`, binary back as it came. A text message
 *  `close <code> <reason>` makes it close from its side. */
async function echoServer({ pingMs }: { pingMs?: number } = {}) {
  const ended: [number, string][] = [];
  const heads: number[] = [];
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    heads.push(head.length);
    const verdict = validateUpgrade(req);
    if (!verdict.ok) {
      socket.end(httpRefusal(verdict.status, verdict.headers));
      return;
    }
    socket.write(upgradeResponse(verdict.key));
    const conn = wsConnection(socket, head, {
      pingMs,
      onMessage: ({ type, data }: { type: string; data: Buffer }) => {
        if (type === "binary") return conn.sendBinary(data);
        const text = data.toString("utf8");
        const asked = /^close (\d+) (.*)$/.exec(text);
        if (asked) return conn.close(Number(asked[1]), asked[2]);
        return conn.sendText(`echo:${text}`);
      },
      onClose: (code: number, reason: string) => ended.push([code, reason]),
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, ended, heads };
}

/** A hand-written client: the raw handshake out, then whatever frames the
 *  test writes, with a reader for the response head and the server's frames. */
async function dial(port: number) {
  const sock = net.connect(port, "127.0.0.1");
  clients.push(sock);
  await new Promise<void>((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
  let buf = Buffer.alloc(0);
  let gone = false;
  let wake: (() => void) | null = null;
  const nudge = () => { const w = wake; wake = null; w?.(); };
  sock.on("data", chunk => { buf = Buffer.concat([buf, chunk]); nudge(); });
  sock.on("end", () => { gone = true; nudge(); });
  sock.on("close", () => { gone = true; nudge(); });
  const wait = () => new Promise<void>(resolve => { wake = resolve; });
  const handshake = (headers: Record<string, string>) => [
    "GET /api/terminal/attach HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "", "",
  ].join("\r\n");
  return {
    handshake,
    write: (b: Buffer | string) => sock.write(b),
    async head(): Promise<string> {
      for (;;) {
        const at = buf.indexOf("\r\n\r\n");
        if (at >= 0) {
          const text = buf.subarray(0, at + 4).toString("latin1");
          buf = buf.subarray(at + 4);
          return text;
        }
        if (gone) throw new Error("the server hung up before it answered");
        await wait();
      }
    },
    async frame(): Promise<Frame> {
      for (;;) {
        const next = decodeOne(buf);
        if (next) {
          buf = buf.subarray(next.size);
          return next.frame;
        }
        if (gone) throw new Error("the server hung up mid-frame");
        await wait();
      }
    },
    async hangup(): Promise<void> {
      while (!gone) await wait();
    },
  };
}

const BROWSER = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Key": SAMPLE_KEY,
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
};

describe("a WebSocket over a real http.Server upgrade", () => {
  it("handshakes, echoes every length and a fragmented message, and closes cleanly", async () => {
    const { port, ended, heads } = await echoServer();
    const client = await dial(port);
    // The first frame goes in the same write as the handshake, so it reaches
    // the server as the upgrade's `head`.
    client.write(Buffer.concat([Buffer.from(client.handshake(BROWSER)), clientFrame(OP.TEXT, "first")]));

    const head = await client.head();
    expect(head.split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols");
    expect(head).toContain(`Sec-WebSocket-Accept: ${SAMPLE_ACCEPT}\r\n`);
    expect(head, "the deflate offer is declined by silence").not.toMatch(/Sec-WebSocket-Extensions/i);

    const first = await client.frame();
    expect(first).toMatchObject({ fin: true, opcode: OP.TEXT, masked: false });
    expect(first.payload.toString()).toBe("echo:first");

    for (const n of [0, 125, 126, 65535, 65536, 300_000]) {
      client.write(clientFrame(OP.BINARY, bytes(n)));
      const echoed = await client.frame();
      expect(echoed.opcode, `${n} bytes`).toBe(OP.BINARY);
      expect(echoed.payload.equals(bytes(n)), `${n} bytes came back intact`).toBe(true);
    }

    client.write(clientFrame(OP.TEXT, "hel", { fin: false }));
    client.write(clientFrame(OP.PING, "mid-message"));
    client.write(clientFrame(OP.CONTINUATION, "lo ", { fin: false }));
    client.write(clientFrame(OP.CONTINUATION, "wörld"));
    const pong = await client.frame();
    expect(pong.opcode).toBe(OP.PONG);
    expect(pong.payload.toString()).toBe("mid-message");
    const joined = await client.frame();
    expect(joined.payload.toString("utf8")).toBe("echo:hello wörld");

    client.write(clientFrame(OP.CLOSE, closeBody(1000, "bye")));
    expect(closeOf(await client.frame())).toEqual({ code: 1000, reason: "" });
    await client.hangup();
    expect(ended).toEqual([[1000, "bye"]]);
    expect(heads, "one connection").toHaveLength(1);
  });

  it("closes from the server's side and hangs up once the client answers", async () => {
    const { port, ended } = await echoServer();
    const client = await dial(port);
    client.write(client.handshake(BROWSER));
    await client.head();
    client.write(clientFrame(OP.TEXT, "close 4000 session ended"));
    expect(closeOf(await client.frame())).toEqual({ code: 4000, reason: "session ended" });
    client.write(clientFrame(OP.CLOSE, closeBody(4000)));
    await client.hangup();
    expect(ended).toEqual([[4000, "session ended"]]);
  });

  it("fails the connection over an unmasked frame with 1002 and hangs up", async () => {
    const { port, ended } = await echoServer();
    const client = await dial(port);
    client.write(client.handshake(BROWSER));
    await client.head();
    client.write(clientFrame(OP.TEXT, "no mask", { mask: false }));
    expect(closeOf(await client.frame()).code).toBe(1002);
    await client.hangup();
    expect(ended.map(e => e[0])).toEqual([1002]);
  });

  /** Node 22 brought a WebSocket client of its own (undici's), written by
   *  other people against the same RFC — the nearest thing to a browser that
   *  runs in this suite. CI runs the newest 22.x, so the real exchange runs on
   *  all three operating systems; one case that asserts whichever half is
   *  reachable rather than a `runIf`, so it needs no entry in skip-gates.mjs
   *  and cannot quietly stop running (see codex-compressed-rollout.test.ts). */
  it("speaks to an independent client: Node's own WebSocket", async () => {
    const Client = (globalThis as { WebSocket?: any }).WebSocket;
    if (typeof Client !== "function") {
      expect(Number(process.versions.node.split(".")[0]), "only a runtime older than 22 lacks one").toBeLessThan(22);
      return;
    }
    // A short keepalive, so the client has to answer real pings while the
    // exchange runs and the server must not take its silence for a hang.
    const { port, ended } = await echoServer({ pingMs: 40 });
    const connect = async () => {
      const ws = new Client(`ws://127.0.0.1:${port}/api/terminal/attach`);
      ws.binaryType = "arraybuffer";
      const closed = new Promise<{ code: number; reason: string; wasClean: boolean }>(resolve => {
        ws.addEventListener("close", (e: any) => resolve({ code: e.code, reason: e.reason, wasClean: e.wasClean }));
      });
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", reject);
      });
      const next = () => new Promise<any>(resolve => ws.addEventListener("message", (e: any) => resolve(e.data), { once: true }));
      return { ws, closed, next };
    };

    const one = await connect();
    expect(one.ws.extensions, "the deflate offer is declined").toBe("");
    let reply = one.next();
    one.ws.send("héllo ✓");
    expect(await reply).toBe("echo:héllo ✓");
    const big = bytes(200_000);
    reply = one.next();
    one.ws.send(big);
    expect(Buffer.from(await reply).equals(big), "200 kB came back intact").toBe(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(one.ws.readyState, "a client that answers pings is never dropped").toBe(Client.OPEN);
    one.ws.close(1000, "bye");
    expect(await one.closed).toEqual({ code: 1000, reason: "", wasClean: true });

    const two = await connect();
    two.ws.send("close 4000 session ended");
    expect(await two.closed).toEqual({ code: 4000, reason: "session ended", wasClean: true });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ended).toEqual([[1000, "bye"], [4000, "session ended"]]);
  });

  it("refuses another version in plain HTTP and never switches protocols", async () => {
    const { port, ended } = await echoServer();
    const client = await dial(port);
    client.write(client.handshake({ ...BROWSER, "Sec-WebSocket-Version": "8" }));
    const head = await client.head();
    expect(head.split("\r\n")[0]).toBe("HTTP/1.1 426 Upgrade Required");
    expect(head).toContain("Sec-WebSocket-Version: 13\r\n");
    await client.hangup();
    expect(ended).toEqual([]);
  });
});

describe("ws-frames.mjs", () => {
  it("imports nothing but Node's own modules", () => {
    const source = readFileSync(new URL("../../server/ws-frames.mjs", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/^import[^"]*"([^"]+)";/gm)].map(m => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier, "the server takes no runtime dependencies").toMatch(/^node:/);
    expect(source, "src/server has named exports only").not.toMatch(/export default/);
  });
});
