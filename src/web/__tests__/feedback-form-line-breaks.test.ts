// A message with a screenshot reaches the API as long as it was typed.
//
// A form's encoding turns every line break in a text field into CRLF. The
// browser did it to the message on its way to this deck, and a FormData built
// here did it again on the way out, so a pasted log of a thousand short lines
// that fitted the box's 10,000 characters arrived a thousand characters longer,
// over the API's limit (ccdeck-api FeedbackRequest counts a CRLF as two), and
// came back as a refusal nobody could act on. The same words with no image go
// as JSON, LF for LF, and were accepted.
//
// So what is checked here is what the API would read: the upstream body as
// fetch would put it on the wire, parsed again as a form — which, like the
// API's reader, keeps every character it is given.
import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { handleFeedback } from "../../server/reports-routes.mjs";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A thousand lines of eight characters: 8,999 with the line breaks, as the box holds it. */
const LOG = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(3, "0")}`).join("\n");

type Sent = { url: string; init: { method: string; headers: Record<string, string>; body: unknown } };

async function forward(body: Buffer | string, contentType: string) {
  const calls: Sent[] = [];
  const fetchImpl = async (url: string, init: Sent["init"]) => {
    calls.push({ url, init });
    return { status: 202, json: async () => ({ id: "fb_1", images: 1 }) };
  };
  const req = Object.assign(Readable.from([body]), { headers: { "content-type": contentType } });
  const res = { headersSent: false, status: 0, text: "", writeHead(s: number) { res.status = s; }, end(t: string) { res.text = t; } };
  await handleFeedback(req, res, { fetchImpl, env: {} });
  return { calls, status: res.status };
}

/** The upstream post as the API reads it: written by fetch, then parsed. */
async function asTheApiReads({ url, init }: Sent) {
  const wire = new Request(url, { method: init.method, headers: init.headers, body: init.body as BodyInit });
  return wire.formData();
}

describe("line breaks in a report with images", () => {
  it("arrive at the API as LF, so the message is as long as it was typed", async () => {
    const page = new FormData();
    page.append("kind", "bug");
    page.append("title", "The log");
    page.append("body", LOG);
    page.append("images", new Blob([PNG], { type: "image/png" }), "shot.png");
    // The browser's multipart encoding, which is where the first CRLFs come from.
    const posted = new Request("http://127.0.0.1/api/feedback", { method: "POST", body: page });
    const bytes = Buffer.from(await posted.arrayBuffer());
    expect(bytes.toString("latin1")).toContain("line 000\r\nline 001");

    const { calls, status } = await forward(bytes, posted.headers.get("content-type")!);
    expect(status).toBe(200);
    expect(calls.length).toBe(1);
    const form = await asTheApiReads(calls[0]);
    const body = form.get("body") as string;
    expect(body.includes("\r")).toBe(false);
    expect(body.length).toBe(LOG.length);
    expect(body).toBe(LOG);
  });

  it("match the same message sent with no image, as JSON", async () => {
    const json = await forward(JSON.stringify({ kind: "bug", title: "The log", body: LOG }), "application/json");
    const viaJson = JSON.parse(json.calls[0].init.body as string).body as string;

    const page = new FormData();
    page.append("kind", "bug");
    page.append("title", "The log");
    page.append("body", LOG);
    page.append("images", new Blob([PNG], { type: "image/png" }), "shot.png");
    const posted = new Request("http://127.0.0.1/api/feedback", { method: "POST", body: page });
    const form = await forward(Buffer.from(await posted.arrayBuffer()), posted.headers.get("content-type")!);
    const viaForm = (await asTheApiReads(form.calls[0])).get("body") as string;

    expect(viaForm).toBe(viaJson);
  });
});
