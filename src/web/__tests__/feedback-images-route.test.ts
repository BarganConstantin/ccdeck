// Screenshots with feedback: the deck's own server half.
//
// The dialog posts a multipart form when a report carries images, and this
// server passes it on to api.ccdeck.dev as a multipart form of its own: the
// same text fields, the ccdeck version and system from installFacts rather
// than from the page, and each image as an `images` file part. The API's
// limits are held here first — three images, 5 MB each, 12 MB in all, PNG or
// JPEG as the bytes say — so a request the API would refuse never leaves the
// machine. The JSON post of a report with no images is untouched, and so is
// the veto: AGENTS_DECK_NO_INSTALL=1 still sends nothing.
import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { installFacts } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { handleFeedback } from "../../server/reports-routes.mjs";

const MB = 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_START = [0xff, 0xd8, 0xff, 0xe0];

/** A file of `size` bytes that starts the way its format says it does. */
function bytesOf(start: number[] | string, size = 64): Uint8Array {
  const head = typeof start === "string" ? [...start].map(c => c.charCodeAt(0)) : start;
  const out = new Uint8Array(Math.max(size, head.length));
  out.set(head);
  return out;
}
const png = (size?: number) => bytesOf(PNG_SIGNATURE, size);
const jpeg = (size?: number) => bytesOf(JPEG_START, size);
const gif = () => bytesOf("GIF89a");

type Part = string | { bytes: Uint8Array; name: string; type?: string };

/** The body and content type a browser's FormData would post. */
async function multipart(parts: [string, Part][]) {
  const form = new FormData();
  for (const [name, value] of parts) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, new Blob([value.bytes], { type: value.type ?? "" }), value.name);
  }
  const request = new Request("http://127.0.0.1/api/feedback", { method: "POST", body: form });
  return { type: request.headers.get("content-type")!, bytes: Buffer.from(await request.arrayBuffer()) };
}

function post(bytes: Buffer | string, contentType?: string) {
  const req = Object.assign(Readable.from([bytes]), {
    headers: contentType ? { "content-type": contentType } : {},
  });
  const res = {
    headersSent: false,
    status: 0,
    text: "",
    writeHead(status: number) { res.status = status; res.headersSent = true; },
    end(text: string) { res.text = text; },
  };
  return { req, res, answer: () => ({ status: res.status, body: JSON.parse(res.text) }) };
}

type Sent = { url: string; init: { method: string; headers: Record<string, string>; body: unknown; signal?: AbortSignal } };

function upstream(status = 202, answer: unknown = { id: "fb_1", images: 2 }) {
  const calls: Sent[] = [];
  const fetchImpl = async (url: string, init: Sent["init"]) => {
    calls.push({ url, init });
    return { status, json: async () => answer };
  };
  return { calls, fetchImpl };
}

const TEXT: [string, Part][] = [
  ["kind", "bug"],
  ["title", "The usage panel is empty"],
  ["body", "It was fine yesterday."],
];

async function send(parts: [string, Part][], { status = 202, answer = undefined as unknown, env = {} as Record<string, string> } = {}) {
  const { type, bytes } = await multipart(parts);
  const api = upstream(status, answer);
  const { req, res, answer: reply } = post(bytes, type);
  await handleFeedback(req, res, { fetchImpl: api.fetchImpl, env });
  return { calls: api.calls, reply: reply() };
}

describe("a report with images goes on as a multipart form", () => {
  it("carries the text, this deck's version and system, and each image as an `images` part", async () => {
    const shot = png(300);
    const photo = jpeg(200);
    const { calls, reply } = await send([
      ...TEXT,
      ["contact", "  bob@example.org "],
      ["images", { bytes: shot, name: "Screenshot 2026-09-30 at 10.12.33.png", type: "image/png" }],
      ["images", { bytes: photo, name: "alice-at-home.jpg", type: "image/jpeg" }],
    ]);

    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.ccdeck.dev/v1/feedback");
    expect(calls[0].init.method).toBe("POST");
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("kind")).toBe("bug");
    expect(form.get("title")).toBe("The usage panel is empty");
    expect(form.get("body")).toBe("It was fine yesterday.");
    expect(form.get("contact")).toBe("bob@example.org");
    expect(form.get("appVersion")).toBe(installFacts({ env: {} }).version);
    expect(form.get("platform")).toBe(`${process.platform}-${process.arch}`);

    const images = form.getAll("images") as File[];
    expect(images.length).toBe(2);
    expect(new Uint8Array(await images[0].arrayBuffer())).toEqual(shot);
    expect(new Uint8Array(await images[1].arrayBuffer())).toEqual(photo);
    expect(images.map(i => i.type)).toEqual(["image/png", "image/jpeg"]);
    // The file's own name can say whose machine it was; the API keeps none,
    // so none is sent.
    expect(images.map(i => i.name)).toEqual(["image-1.png", "image-2.jpg"]);
    // fetch writes the boundary itself; a content type set here would lose it.
    expect(Object.keys(calls[0].init.headers).map(k => k.toLowerCase())).not.toContain("content-type");
    expect(calls[0].init.headers["user-agent"]).toBe(`ccdeck/${installFacts({ env: {} }).version}`);
  });

  it("takes the version and the system from this deck, never from the page", async () => {
    const { calls } = await send([
      ...TEXT,
      ["appVersion", "99.0.0-forged"],
      ["platform", "amiga-m68k"],
      ["images", { bytes: png(), name: "a.png", type: "image/png" }],
    ]);
    const form = calls[0].init.body as FormData;
    expect(form.getAll("appVersion")).toEqual([installFacts({ env: {} }).version]);
    expect(form.getAll("platform")).toEqual([`${process.platform}-${process.arch}`]);
  });

  it("leaves the contact out when none was given, or only spaces", async () => {
    const none = await send([...TEXT, ["images", { bytes: png(), name: "a.png" }]]);
    expect((none.calls[0].init.body as FormData).has("contact")).toBe(false);
    const blank = await send([...TEXT, ["contact", "   "], ["images", { bytes: png(), name: "a.png" }]]);
    expect((blank.calls[0].init.body as FormData).has("contact")).toBe(false);
  });

  it("knows an image by its bytes, not by its name or the type the page declared", async () => {
    // A GIF renamed .png, declared image/png, is still a GIF.
    const renamed = await send([...TEXT, ["images", { bytes: gif(), name: "shot.png", type: "image/png" }]]);
    expect(renamed.calls.length).toBe(0);
    expect(renamed.reply).toEqual({
      status: 400, body: { ok: false, reason: "invalid", errors: { images: ["Image 1 is not a PNG or a JPEG."] } },
    });

    // And a PNG named .gif and declared image/gif goes, as the PNG it is.
    const png1 = png(80);
    const mislabelled = await send([...TEXT, ["images", { bytes: png1, name: "shot.gif", type: "image/gif" }]]);
    expect(mislabelled.reply.status).toBe(200);
    const sent = (mislabelled.calls[0].init.body as FormData).getAll("images") as File[];
    expect(sent.map(i => [i.name, i.type])).toEqual([["image-1.png", "image/png"]]);
  });
});

describe("the API's limits, held here first so a bad request never leaves the machine", () => {
  it("refuses a fourth image", async () => {
    const four: [string, Part][] = [1, 2, 3, 4].map(n => ["images", { bytes: png(), name: `${n}.png` }]);
    const { calls, reply } = await send([...TEXT, ...four]);
    expect(calls.length).toBe(0);
    expect(reply).toEqual({ status: 400, body: { ok: false, reason: "invalid", errors: { images: ["At most 3 images."] } } });
  });

  it("sends three", async () => {
    const three: [string, Part][] = [1, 2, 3].map(n => ["images", { bytes: png(), name: `${n}.png` }]);
    const { calls, reply } = await send([...TEXT, ...three]);
    expect(reply.status).toBe(200);
    expect(((calls[0].init.body as FormData).getAll("images")).length).toBe(3);
  });

  it("refuses an image over 5 MB, and names which one", async () => {
    const { calls, reply } = await send([
      ...TEXT,
      ["images", { bytes: png(), name: "small.png" }],
      ["images", { bytes: png(5 * MB + 1), name: "big.png" }],
    ]);
    expect(calls.length).toBe(0);
    expect(reply).toEqual({ status: 400, body: { ok: false, reason: "invalid", errors: { images: ["Image 2 is over 5 MB."] } } });
  });

  it("sends an image of exactly 5 MB", async () => {
    const { calls, reply } = await send([...TEXT, ["images", { bytes: png(5 * MB), name: "edge.png" }]]);
    expect(reply.status).toBe(200);
    expect(((calls[0].init.body as FormData).get("images") as File).size).toBe(5 * MB);
  });

  it("answers too_large for a request over 12 MB in all, each image inside its own 5", async () => {
    const heavy: [string, Part][] = [1, 2, 3].map(n => ["images", { bytes: png(4.5 * MB), name: `${n}.png` }]);
    const { calls, reply } = await send([...TEXT, ...heavy]);
    expect(calls.length).toBe(0);
    expect(reply).toEqual({ status: 413, body: { ok: false, reason: "too_large" } });
  });

  it("refuses a file under any name but images, and an image sent as text", async () => {
    const renamed = await send([...TEXT, ["image", { bytes: png(), name: "a.png" }]]);
    expect(renamed.calls.length).toBe(0);
    expect(renamed.reply).toEqual({
      status: 400, body: { ok: false, reason: "invalid", errors: { images: ["Only parts named images may carry a file."] } },
    });

    const asText = await send([...TEXT, ["images", "iVBORw0KGgo="]]);
    expect(asText.calls.length).toBe(0);
    expect(asText.reply).toEqual({
      status: 400, body: { ok: false, reason: "invalid", errors: { images: ["Send each image as a file part."] } },
    });

    // A text field sent as a file is a file under the wrong name too.
    const titleFile = await send([["kind", "bug"], ["title", { bytes: png(), name: "t.png" }], ["body", "x"]]);
    expect(titleFile.calls.length).toBe(0);
    expect(titleFile.reply.status).toBe(400);
  });

  it("answers bad_request for a form that cannot be read", async () => {
    const api = upstream();
    const { req, res, answer } = post("not a form at all", "multipart/form-data; boundary=----nothing");
    await handleFeedback(req, res, { fetchImpl: api.fetchImpl, env: {} });
    expect(api.calls.length).toBe(0);
    expect(answer()).toEqual({ status: 400, body: { ok: false, reason: "bad_request" } });
  });
});

describe("what the API answers a form with", () => {
  it("passes a 400's errors through, as it does for JSON", async () => {
    const { reply } = await send(
      [...TEXT, ["images", { bytes: png(), name: "a.png" }]],
      { status: 400, answer: { errors: { images: ["Image 1 is a damaged PNG."] } } },
    );
    expect(reply).toEqual({ status: 400, body: { ok: false, reason: "invalid", errors: { images: ["Image 1 is a damaged PNG."] } } });
  });

  it("names a 413 too_large rather than calling the API unavailable", async () => {
    const { reply } = await send([...TEXT, ["images", { bytes: png(), name: "a.png" }]], { status: 413, answer: {} });
    expect(reply).toEqual({ status: 413, body: { ok: false, reason: "too_large" } });
  });

  it("says too_many for the rate limit the form shares with JSON", async () => {
    const { reply } = await send([...TEXT, ["images", { bytes: png(), name: "a.png" }]], { status: 429, answer: {} });
    expect(reply).toEqual({ status: 429, body: { ok: false, reason: "too_many" } });
  });
});

describe("the veto, and the JSON post, as they were", () => {
  it("sends nothing from a deck started with AGENTS_DECK_NO_INSTALL=1, images or not", async () => {
    const { calls, reply } = await send(
      [...TEXT, ["images", { bytes: png(), name: "a.png" }]],
      { env: { AGENTS_DECK_NO_INSTALL: "1" } },
    );
    expect(calls.length).toBe(0);
    expect(reply).toEqual({ status: 403, body: { ok: false, reason: "vetoed" } });
  });

  it("still posts a JSON report as JSON, with the same fields", async () => {
    const api = upstream(202, { id: "fb_1", images: 0 });
    const message = { kind: "idea", title: "A quieter chime", body: "The done chime is loud at night." };
    const { req, res, answer } = post(JSON.stringify(message), "application/json");
    await handleFeedback(req, res, { fetchImpl: api.fetchImpl, env: {} });
    expect(answer()).toEqual({ status: 200, body: { ok: true } });
    expect(api.calls[0].init.headers["content-type"]).toBe("application/json");
    expect(typeof api.calls[0].init.body).toBe("string");
    expect(JSON.parse(api.calls[0].init.body as string)).toEqual({
      ...message, appVersion: installFacts({ env: {} }).version, platform: `${process.platform}-${process.arch}`,
    });
  });

  it("names a 413 on a JSON post too_large as well", async () => {
    const api = upstream(413, {});
    const { req, res, answer } = post(JSON.stringify({ kind: "bug", title: "abc", body: "x" }), "application/json");
    await handleFeedback(req, res, { fetchImpl: api.fetchImpl, env: {} });
    expect(answer()).toEqual({ status: 413, body: { ok: false, reason: "too_large" } });
  });
});
