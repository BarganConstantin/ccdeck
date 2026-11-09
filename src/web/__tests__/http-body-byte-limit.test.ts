import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
// @ts-expect-error — plain .mjs server module, no types
import { readBody, readBytes, send } from "../../server/http-io.mjs";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const read = req.url === "/text" ? readBody : readBytes;
    void read(req, res, 64_000).then((body: string | Buffer) => {
      send(res, 200, { text: body.toString() });
    }).catch(() => {}); // The reader has already answered 413.
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
});

function post(path: string, text: string): Promise<{ status: number; body: { text?: string; error?: string } }> {
  return new Promise((done, fail) => {
    const req = request({
      host: "127.0.0.1", port, path, method: "POST",
      headers: { "content-length": Buffer.byteLength(text) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => done({ status: res.statusCode!, body: JSON.parse(raw) }));
    });
    req.on("error", fail);
    req.end(text);
  });
}

describe("HTTP body caps use wire bytes for text and binary alike", () => {
  it.each(["/text", "/bytes"])("refuses multibyte JSON past 64,000 bytes through %s", async path => {
    const body = JSON.stringify({ note: "界".repeat(22_000) });
    expect(Buffer.byteLength(body)).toBeGreaterThan(64_000);
    const answer = await post(path, body);
    expect(answer.status).toBe(413);
    expect(answer.body).toEqual({ error: "body too large" });
  });

  it.each(["/text", "/bytes"])("accepts exactly 64,000 bytes and refuses the next byte through %s", async path => {
    const body = "界".repeat(21_333) + "a";
    expect(Buffer.byteLength(body)).toBe(64_000);
    expect(await post(path, body)).toEqual({ status: 200, body: { text: body } });
    expect((await post(path, body + "a")).status).toBe(413);
  });

  it("decodes text without corrupting Unicode split across stream chunks", async () => {
    const text = 'a界🙂b';
    const bytes = Buffer.from(text);
    const chunks = Array.from(bytes, (_, i) => bytes.subarray(i, i + 1));
    expect(await readBody(Readable.from(chunks), null, bytes.length)).toBe(text);
  });
});
