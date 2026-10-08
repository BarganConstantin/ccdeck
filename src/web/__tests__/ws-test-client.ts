// A WebSocket client written by hand, for the suites that open the terminal
// panel's socket against a real deck: terminal-socket.test.ts and
// terminal-socket-tmux.test.ts.
//
// Not Node's own WebSocket, for two reasons. The cases that matter most here
// are the ones a browser can never send — no Origin, a rebound Host, a
// Sec-Fetch-Site the page did not choose — and the built-in client sets those
// itself. And a refused upgrade is a plain HTTP status, which the built-in
// client reports as a bare error; these cases need the status line and the
// bytes, exactly, and need to see the socket hung up after them.
//
// It speaks just enough of RFC 6455 to be a client: masked frames out, and
// unmasked frames in, unfragmented, which is all the deck ever sends.
import net from "node:net";
import { randomBytes } from "node:crypto";

export interface Frame {
  op: number;
  fin: boolean;
  data: Buffer;
}

export const OPS = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export interface WsClient {
  /** The status of the answer to the handshake (101 when admitted). */
  status: number;
  /** The answer's status line and headers, as sent. */
  head: string;
  socket: net.Socket;
  /** Every frame read so far, in order. */
  frames: Frame[];
  /** Resolves when the TCP connection has closed. */
  closed: Promise<void>;
  /** True once the server has ended its half of the connection. */
  readonly ended: boolean;
  /** The next frame not yet taken by next(), waiting up to `ms` for it. */
  next(ms?: number): Promise<Frame>;
  /** Frames are taken until one satisfies `pred`, which is answered with it. */
  until(pred: (f: Frame) => boolean, ms?: number): Promise<Frame>;
  sendText(text: string): void;
  sendBinary(bytes: Buffer | string): void;
  sendClose(code?: number): void;
}

export interface OpenOptions {
  port: number;
  path: string;
  /** Request headers. A null value removes one of the handshake's defaults. */
  headers?: Record<string, string | null>;
  /** How long to wait for the handshake's answer. */
  ms?: number;
}

/** One client frame: always masked, as a client must. */
export function clientFrame(op: number, payload: Buffer | string, fin = true): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const mask = randomBytes(4);
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | op;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | op;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const body = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) body[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, body]);
}

/** A key a browser could have sent: 16 random bytes in base64. */
export const handshakeKey = () => randomBytes(16).toString("base64");

/**
 * Open a connection and send the handshake. Resolves once the answer's head
 * has arrived — whatever it says — so a refusal and an admission are both
 * read the same way: by `status`, then by what follows.
 */
export function openWs({ port, path, headers = {}, ms = 5_000 }: OpenOptions): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const defaults: Record<string, string> = {
      Host: `127.0.0.1:${port}`,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": handshakeKey(),
      "Sec-WebSocket-Version": "13",
    };
    const merged: Record<string, string> = { ...defaults };
    for (const [k, v] of Object.entries(headers)) {
      const existing = Object.keys(merged).find(n => n.toLowerCase() === k.toLowerCase());
      if (existing) delete merged[existing];
      if (v !== null) merged[k] = v;
    }
    const request = `GET ${path} HTTP/1.1\r\n${Object.entries(merged).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;

    let buf = Buffer.alloc(0);
    let headDone = false;
    let ended = false;
    const frames: Frame[] = [];
    let taken = 0;
    const waiters: Array<() => void> = [];
    const wake = () => { for (const w of waiters.splice(0)) w(); };
    let closedResolve!: () => void;
    const closed = new Promise<void>(r => { closedResolve = r; });

    const timer = setTimeout(() => { socket.destroy(); reject(new Error("no answer to the handshake")); }, ms);

    const parseFrames = () => {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (b1 & 0x80) off += 4; // the deck never masks; tolerated rather than misread
        if (buf.length < off + len) return;
        frames.push({ op: b0 & 0x0f, fin: (b0 & 0x80) !== 0, data: Buffer.from(buf.subarray(off, off + len)) });
        buf = buf.subarray(off + len);
      }
    };

    const client: WsClient = {
      status: 0,
      head: "",
      socket,
      frames,
      closed,
      get ended() { return ended; },
      next(wait = 5_000) {
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`no frame within ${wait}ms (read ${frames.length})`)), wait);
          const check = () => {
            if (taken < frames.length) {
              clearTimeout(t);
              res(frames[taken++]);
            } else if (ended && socket.destroyed) {
              clearTimeout(t);
              rej(new Error("the connection closed before another frame arrived"));
            } else {
              waiters.push(check);
            }
          };
          check();
        });
      },
      async until(pred, wait = 5_000) {
        const deadline = Date.now() + wait;
        for (;;) {
          const f = await client.next(Math.max(1, deadline - Date.now()));
          if (pred(f)) return f;
        }
      },
      sendText(text) { socket.write(clientFrame(OPS.text, text)); },
      sendBinary(bytes) { socket.write(clientFrame(OPS.binary, bytes)); },
      sendClose(code = 1000) {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        socket.write(clientFrame(OPS.close, payload));
      },
    };

    socket.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!headDone) {
        const at = buf.indexOf("\r\n\r\n");
        if (at < 0) return;
        headDone = true;
        client.head = buf.subarray(0, at + 4).toString("latin1");
        client.status = Number(/^HTTP\/1\.1 (\d{3})/.exec(client.head)?.[1] ?? 0);
        buf = buf.subarray(at + 4);
        clearTimeout(timer);
        resolve(client);
      }
      parseFrames();
      wake();
    });
    socket.on("end", () => { ended = true; wake(); });
    socket.on("error", () => {});
    socket.on("close", () => {
      ended = true;
      closedResolve();
      wake();
      if (!headDone) {
        clearTimeout(timer);
        // Hung up with no answer at all: reported as status 0, which every
        // case reads as "not admitted".
        headDone = true;
        resolve(client);
      }
    });
    socket.write(request);
  });
}

/** The JSON in a text frame. */
export const json = (f: Frame) => JSON.parse(f.data.toString("utf8"));
