// Screenshots with feedback: the dialog's half.
//
// The owner asked for images to be dropped onto the feedback dialog; a
// screenshot arrives most often by ⌘V, so paste takes one too, and a button
// opens the file picker. Each shows as a thumbnail with its own remove, under a
// count of three.
//
// The API takes PNG or JPEG, 5 MB each, 12 MB in all, each side at most 8192
// pixels. A full capture of a 5K screen is 5120 × 2880 and, as a PNG, often
// over 5 MB, so the common screenshot would fail if it were sent as it came:
// one over a limit is redrawn through a canvas first — smaller, and a JPEG only
// if a smaller PNG still does not fit. Other formats are refused, by their
// bytes, and the refusal says GIF, WebP and HEIC are not converted.
//
// The images stay with the people who make ccdeck, as the contact does: the
// note before Send says so, and a line by the thumbnails says what a screenshot
// can show.
//
// Plain node, no renderer (see feedback-dialog-form.test.ts): the rules are the
// pure functions feedback-images.ts exports, the canvas is a seam a fake stands
// in for, and the wiring is read off the source.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_IMAGES, MAX_IMAGE_BYTES, MAX_REQUEST_BYTES, MAX_SIDE, JPEG_QUALITY, MIN_BUDGET,
  imageFormat, imageSize, needsFitting, imageBudget, firstFit, fitImage, prepareImage,
  carriesFiles, shouldAttachPaste, focusAfterRemove, feedbackRequest, shotsSummary,
  problemMessage, leftOutMessage, FULL_MESSAGE, SHOTS_NOTE, ADD_LABEL, ADD_HINT,
  type Encoder, type Decoder, type ImageFormat, type Size,
} from "../feedback-images";
import { feedbackFailure } from "../components/FeedbackDialog";
import { withoutComments } from "./tsx-scan";

const MB = 1024 * 1024;
const read = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const dialog = read("../components/FeedbackDialog.tsx");
const flatDialog = dialog.replace(/\s+/g, " ");
const shotsView = read("../components/FeedbackShots.tsx").replace(/\s+/g, " ");
const hook = read("../use-feedback-images.ts").replace(/\s+/g, " ");

// ── the bytes ────────────────────────────────────────────────────────────────

/** A PNG's signature and IHDR, the way a real file starts, padded to `total` bytes. */
function pngHead(width: number, height: number, total = 64): Uint8Array {
  const out = new Uint8Array(Math.max(total, 33));
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

/** A JPEG's start, an APP segment of `appBytes`, then a frame header. */
function jpegHead(width: number, height: number, { frame = 0xc0, appBytes = 16, total = 0 } = {}): Uint8Array {
  const app = [0xff, 0xe1, (appBytes + 2) >> 8, (appBytes + 2) & 0xff, ...new Array(appBytes).fill(0x45)];
  const sof = [0xff, frame, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const bytes = [0xff, 0xd8, ...app, ...sof];
  const out = new Uint8Array(Math.max(total, bytes.length));
  out.set(bytes);
  return out;
}

const ascii = (s: string) => new Uint8Array([...s].map(c => c.charCodeAt(0)));

describe("an image is known by its bytes", () => {
  it("reads PNG and JPEG off their first bytes, whatever the name says", () => {
    expect(imageFormat(pngHead(10, 10))).toBe("png");
    expect(imageFormat(jpegHead(10, 10))).toBe("jpeg");
  });

  it("refuses GIF, WebP and HEIC, which the API does not take and nothing here converts", () => {
    expect(imageFormat(ascii("GIF89a\0\0\0\0"))).toBeNull();
    expect(imageFormat(ascii("RIFF\0\0\0\0WEBPVP8 "))).toBeNull();
    expect(imageFormat(new Uint8Array([0, 0, 0, 0x18, ...ascii("ftypheic")]))).toBeNull();
    expect(imageFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(imageFormat(new Uint8Array())).toBeNull();
  });

  it("reads a PNG's size off its IHDR", () => {
    expect(imageSize(pngHead(5120, 2880))).toEqual({ width: 5120, height: 2880 });
  });

  it("reads a JPEG's size off its frame, past the EXIF before it, baseline or progressive", () => {
    expect(imageSize(jpegHead(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpegHead(1920, 1080, { frame: 0xc2, appBytes: 6000 }))).toEqual({ width: 1920, height: 1080 });
  });

  it("says it does not know rather than guess, for a header cut short", () => {
    expect(imageSize(pngHead(10, 10).slice(0, 20))).toBeNull();
    expect(imageSize(jpegHead(10, 10, { appBytes: 6000 }).slice(0, 100))).toBeNull();
    expect(imageSize(ascii("GIF89a"))).toBeNull();
  });
});

// ── fitting a screenshot to the API's limits ─────────────────────────────────

describe("what has to be redrawn before it can go", () => {
  it("holds the limits the API holds", () => {
    expect(MAX_IMAGES).toBe(3);
    expect(MAX_IMAGE_BYTES).toBe(5 * MB);
    expect(MAX_REQUEST_BYTES).toBe(12 * MB);
    expect(MAX_SIDE).toBe(8192);
  });

  it("leaves an image inside every limit as it is, to the byte", () => {
    expect(needsFitting({ width: 2880, height: 1800, bytes: 3 * MB }, 5 * MB)).toBe(false);
    expect(needsFitting({ width: MAX_SIDE, height: MAX_SIDE, bytes: 5 * MB }, 5 * MB)).toBe(false);
  });

  it("redraws one over its budget, or over 8192 on either side", () => {
    expect(needsFitting({ width: 5120, height: 2880, bytes: 5 * MB + 1 }, 5 * MB)).toBe(true);
    expect(needsFitting({ width: MAX_SIDE + 1, height: 100, bytes: 1000 }, 5 * MB)).toBe(true);
    expect(needsFitting({ width: 100, height: MAX_SIDE + 1, bytes: 1000 }, 5 * MB)).toBe(true);
    // Inside 5 MB but not inside what the others leave of the 12.
    expect(needsFitting({ width: 1000, height: 1000, bytes: 3 * MB }, 2 * MB)).toBe(true);
  });

  it("budgets each image at 5 MB, or what the others leave of 12 with room for the text", () => {
    expect(imageBudget(0)).toBe(5 * MB);
    expect(imageBudget(5 * MB)).toBe(5 * MB);
    const third = imageBudget(9.5 * MB);
    expect(third).toBeLessThan(2.5 * MB);
    expect(third).toBeGreaterThan(2 * MB);
    expect(imageBudget(12 * MB)).toBeLessThan(MIN_BUDGET);
  });

  it("scales the long side down, keeping the shape, by about the square root of the overshoot", () => {
    const size = firstFit({ width: 5120, height: 2880, bytes: 12 * MB }, 5 * MB);
    expect(size.width).toBeLessThan(5120);
    expect(size.width / size.height).toBeCloseTo(5120 / 2880, 2);
    // Area goes as bytes do, with a margin under the budget.
    expect((size.width * size.height) / (5120 * 2880)).toBeLessThan(5 / 12);
    expect((size.width * size.height) / (5120 * 2880)).toBeGreaterThan(0.25);
  });

  it("brings a side over 8192 to 8192 even when the bytes are fine", () => {
    const size = firstFit({ width: 10000, height: 4000, bytes: 1 * MB }, 5 * MB);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_SIDE);
    expect(size.width).toBeGreaterThan(8100);
  });
});

/** An encoder that costs `perPixel` bytes a pixel for each format, and says what it was asked. */
function fakeEncoder(perPixel: Record<ImageFormat, number>) {
  const calls: { size: Size; format: ImageFormat; quality: number | undefined }[] = [];
  const encode: Encoder = async (size, format, quality) => {
    calls.push({ size, format, quality });
    // Only the size and type are read, so no bytes are made: at 500 bytes a
    // pixel a real Blob of that size would be gigabytes.
    const size_ = Math.round(size.width * size.height * perPixel[format]);
    return { size: size_, type: format === "png" ? "image/png" : "image/jpeg" } as Blob;
  };
  return { calls, encode };
}

describe("fitting, through the canvas seam", () => {
  const retina = { width: 5120, height: 2880, bytes: 12 * MB, format: "png" as const };

  it("fits a 12 MB 5K PNG as a smaller PNG when a smaller PNG fits", async () => {
    const { calls, encode } = fakeEncoder({ png: 0.8, jpeg: 0.15 });
    const fitted = await fitImage(retina, 5 * MB, encode);
    expect(fitted).not.toBeNull();
    expect(fitted!.format).toBe("png");
    expect(fitted!.blob.size).toBeLessThanOrEqual(5 * MB);
    expect(fitted!.width).toBeLessThan(5120);
    expect(calls.map(c => c.format)).toEqual(["png"]);
  });

  it("turns to a high-quality JPEG only when the smaller PNG is still too big", async () => {
    const { calls, encode } = fakeEncoder({ png: 3, jpeg: 0.15 });
    const fitted = await fitImage(retina, 5 * MB, encode);
    expect(fitted!.format).toBe("jpeg");
    expect(fitted!.blob.size).toBeLessThanOrEqual(5 * MB);
    expect(calls.map(c => [c.format, c.quality])).toEqual([["png", undefined], ["jpeg", JPEG_QUALITY]]);
    // The JPEG is tried at the same size first: resolution is kept over format.
    expect(calls[1].size).toEqual(calls[0].size);
    expect(JPEG_QUALITY).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps a JPEG a JPEG and shrinks it again until it fits", async () => {
    const { calls, encode } = fakeEncoder({ png: 3, jpeg: 1.2 });
    const fitted = await fitImage({ width: 6000, height: 4000, bytes: 9 * MB, format: "jpeg" }, 5 * MB, encode);
    expect(fitted!.format).toBe("jpeg");
    expect(fitted!.blob.size).toBeLessThanOrEqual(5 * MB);
    expect(calls.every(c => c.format === "jpeg")).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
    for (let i = 1; i < calls.length; i++) expect(calls[i].size.width).toBeLessThan(calls[i - 1].size.width);
  });

  it("gives up, rather than sending a thumbnail, when nothing readable fits", async () => {
    const { encode } = fakeEncoder({ png: 500, jpeg: 500 });
    expect(await fitImage(retina, 5 * MB, encode)).toBeNull();
  });

  it("gives up when the canvas cannot encode", async () => {
    expect(await fitImage(retina, 5 * MB, async () => null)).toBeNull();
  });
});

describe("preparing a dropped or pasted file", () => {
  function decoderFor(size: Size, perPixel: Record<ImageFormat, number>) {
    const encoder = fakeEncoder(perPixel);
    let decoded = 0;
    let released = 0;
    const decode: Decoder = async () => {
      decoded++;
      return { ...size, encoder: encoder.encode, release: () => { released++; } };
    };
    return { decode, encoder, counts: () => ({ decoded, released }) };
  }

  it("downscales a PNG over 5 MB before it is sent", async () => {
    const file = new Blob([pngHead(5120, 2880, 12 * MB)], { type: "image/png" });
    const { decode, counts } = decoderFor({ width: 5120, height: 2880 }, { png: 0.8, jpeg: 0.15 });
    const prepared = await prepareImage(file, 5 * MB, decode);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.blob.size).toBeLessThanOrEqual(5 * MB);
    expect(prepared.resized!.width).toBeLessThan(5120);
    expect(prepared.blob.type).toBe("image/png");
    expect(counts()).toEqual({ decoded: 1, released: 1 });
  });

  it("sends a screenshot inside the limits untouched, without decoding it", async () => {
    const bytes = pngHead(2880, 1800, 900_000);
    const file = new Blob([bytes], { type: "image/png" });
    const { decode, counts } = decoderFor({ width: 2880, height: 1800 }, { png: 1, jpeg: 1 });
    const prepared = await prepareImage(file, 5 * MB, decode);
    expect(prepared.ok && prepared.resized).toBe(null);
    if (!prepared.ok) return;
    // The file itself, not a copy drawn from it.
    expect(prepared.blob).toBe(file);
    expect(counts().decoded).toBe(0);
  });

  it("types the blob by its bytes, so a PNG saved as .jpg goes as a PNG", async () => {
    const file = new Blob([pngHead(100, 100, 400)], { type: "image/jpeg" });
    const prepared = await prepareImage(file, 5 * MB, decoderFor({ width: 100, height: 100 }, { png: 1, jpeg: 1 }).decode);
    expect(prepared.ok && prepared.blob.type).toBe("image/png");
  });

  it("refuses a file that is not a PNG or a JPEG by its bytes, whatever it is called", async () => {
    const gif = new Blob([ascii("GIF89a\0\0\0\0\0\0")], { type: "image/png" });
    expect(await prepareImage(gif, 5 * MB, decoderFor({ width: 1, height: 1 }, { png: 1, jpeg: 1 }).decode))
      .toEqual({ ok: false, problem: "type" });
  });

  it("says there is no room when the others have spent the 12 MB", async () => {
    const file = new Blob([pngHead(100, 100, 400)], { type: "image/png" });
    expect(await prepareImage(file, MIN_BUDGET - 1, decoderFor({ width: 100, height: 100 }, { png: 1, jpeg: 1 }).decode))
      .toEqual({ ok: false, problem: "no_room" });
  });

  it("says it could not be read when the browser cannot decode it", async () => {
    const file = new Blob([pngHead(9000, 100, 400)], { type: "image/png" });
    expect(await prepareImage(file, 5 * MB, async () => null)).toEqual({ ok: false, problem: "unreadable" });
  });

  it("says it is too large when no fit was found, and lets go of the decoded image", async () => {
    const file = new Blob([pngHead(5120, 2880, 12 * MB)], { type: "image/png" });
    const { decode, counts } = decoderFor({ width: 5120, height: 2880 }, { png: 500, jpeg: 500 });
    expect(await prepareImage(file, 5 * MB, decode)).toEqual({ ok: false, problem: "too_large" });
    expect(counts().released).toBe(1);
  });
});

// ── paste, drop, remove ──────────────────────────────────────────────────────

describe("how an image arrives, and what happens when one goes", () => {
  it("takes a drag that carries files and ignores one that carries text", () => {
    expect(carriesFiles(["Files"])).toBe(true);
    expect(carriesFiles(["text/plain", "Files"])).toBe(true);
    expect(carriesFiles(["text/plain", "text/html"])).toBe(false);
    expect(carriesFiles([])).toBe(false);
  });

  it("attaches a pasted screenshot, and leaves text pasted into a field as text", () => {
    // ⌘⇧⌃4 on a Mac puts an image and nothing else on the clipboard.
    expect(shouldAttachPaste({ files: 1, hasText: false, intoTextField: true })).toBe(true);
    // A spreadsheet's cells come as text and a picture of the text; into the
    // message, the words are what was meant.
    expect(shouldAttachPaste({ files: 1, hasText: true, intoTextField: true })).toBe(false);
    expect(shouldAttachPaste({ files: 1, hasText: true, intoTextField: false })).toBe(true);
    expect(shouldAttachPaste({ files: 0, hasText: true, intoTextField: false })).toBe(false);
  });

  it("moves focus to the next image's remove, then the one before, then the add button", () => {
    expect(focusAfterRemove([1, 2, 3], 1)).toBe(2);
    expect(focusAfterRemove([1, 2, 3], 3)).toBe(2);
    expect(focusAfterRemove([1, 2, 3], 2)).toBe(3);
    expect(focusAfterRemove([7], 7)).toBeNull();
  });
});

// ── what is sent ─────────────────────────────────────────────────────────────

describe("what Send posts", () => {
  const fields = { kind: "bug", title: "The usage panel is empty", body: "It was fine yesterday.", contact: "bob@example.org" };

  it("posts the same JSON as before when there are no images", () => {
    expect(feedbackRequest(fields, [])).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
    const noContact = { ...fields, contact: undefined };
    expect(feedbackRequest(noContact, []).body).toBe(JSON.stringify(noContact));
  });

  it("posts a multipart form only when there are images, each an `images` part", async () => {
    const shot = new Blob([pngHead(10, 10)], { type: "image/png" });
    const photo = new Blob([jpegHead(10, 10)], { type: "image/jpeg" });
    const init = feedbackRequest(fields, [shot, photo]);
    expect(init.method).toBe("POST");
    // fetch writes the multipart type and its boundary itself.
    expect(init.headers).toBeUndefined();
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()]).toEqual(["kind", "title", "body", "contact", "images", "images"]);
    expect(form.get("title")).toBe(fields.title);
    const images = form.getAll("images") as File[];
    expect(images.map(i => [i.name, i.type])).toEqual([["image-1.png", "image/png"], ["image-2.jpg", "image/jpeg"]]);
    expect(new Uint8Array(await images[0].arrayBuffer())).toEqual(pngHead(10, 10));
  });

  it("leaves the contact out of the form when there is none", () => {
    const form = feedbackRequest({ ...fields, contact: undefined }, [new Blob([pngHead(1, 1)], { type: "image/png" })]).body as FormData;
    expect(form.has("contact")).toBe(false);
  });

  it("names the new failures: too large together, and an image the API would not take", () => {
    expect(feedbackFailure(413, "too_large")).toMatch(/too large/);
    expect(feedbackFailure(413, "too_large")).toContain("your text is still here");
    const refused = feedbackFailure(400, "invalid", { images: ["Image 2 is a damaged PNG."] });
    expect(refused).toContain("Image 2 is a damaged PNG.");
    expect(refused).toContain("your text is still here");
    // A 400 about the words still says so.
    expect(feedbackFailure(400, "invalid", { title: ["Between 3 and 120 characters."] })).toContain("title");
  });
});

// ── the words ────────────────────────────────────────────────────────────────

describe("what the dialog says about images", () => {
  it("counts them against three, and says when one was redrawn", () => {
    expect(shotsSummary(2, 0)).toBe("2 of 3");
    expect(shotsSummary(2, 1)).toBe("2 of 3 · 1 resized to fit");
    expect(shotsSummary(3, 2)).toBe("3 of 3 · 2 resized to fit");
  });

  it("says a GIF, WebP or HEIC is not converted, and what to do instead", () => {
    const said = problemMessage("type", "clip.gif");
    expect(said).toContain("“clip.gif”");
    expect(said).toMatch(/not a PNG or a JPEG/);
    expect(said).toMatch(/GIF, WebP and HEIC are not converted/);
  });

  it("says why each of the others was left out", () => {
    expect(problemMessage("too_large", "big.png")).toMatch(/“big\.png”.*5 MB/);
    expect(problemMessage("no_room", "big.png")).toMatch(/12 MB/);
    expect(problemMessage("unreadable", "x.png")).toMatch(/could not be read/);
    expect(FULL_MESSAGE).toMatch(/Three images at most/);
    expect(leftOutMessage(1)).toBe("Three images at most, so one was left out.");
    expect(leftOutMessage(2)).toBe("Three images at most, so 2 were left out.");
  });

  it("cuts a long file name in what it says, so one line stays one line", () => {
    const said = problemMessage("type", `${"x".repeat(200)}.gif`);
    expect(said.length).toBeLessThan(220);
    expect(said).toContain("…");
  });

  it("warns what a screenshot can show, in one line, without a claim it cannot keep", () => {
    expect(SHOTS_NOTE).toBe("A screenshot can show emails, costs and paths. Crop out what should not be seen.");
  });

  it("names the add button and says where else an image can come from", () => {
    expect(ADD_LABEL).toBe("Add a screenshot");
    expect(ADD_HINT).toMatch(/PNG or JPEG/);
    expect(ADD_HINT).toMatch(/paste/i);
    expect(ADD_HINT).toMatch(/drop/i);
  });

  it("says nothing with an exclamation mark, a 'simply' or a 'just'", () => {
    const words = [
      SHOTS_NOTE, ADD_LABEL, ADD_HINT, FULL_MESSAGE, leftOutMessage(2),
      ...(["type", "too_large", "no_room", "unreadable"] as const).map(p => problemMessage(p, "a.png")),
    ];
    for (const w of words) expect(w, w).not.toMatch(/!|\bsimply\b|\bjust\b/i);
  });
});

describe("the images stay with the people who make ccdeck", () => {
  it("keeps every promise the note made, and adds the images to what is never put on an issue", () => {
    expect(flatDialog).toContain(
      "This goes to the people who make ccdeck, with your ccdeck version and system. They may open a " +
      "public GitHub issue from it; your images and how to reach you stay with them and are never put there.",
    );
    expect(flatDialog.indexOf("are never put there")).toBeLessThan(flatDialog.indexOf('type="submit"'));
  });
});

// ── the wiring, read off the source ──────────────────────────────────────────

describe("the dialog takes an image three ways", () => {
  it("takes a paste anywhere in the dialog, through the paste rule", () => {
    expect(flatDialog).toMatch(/onPaste=\{/);
    expect(flatDialog).toMatch(/shouldAttachPaste\(/);
  });

  /** The attributes of the tag that opens at `from`, up to the next one named. */
  const between = (from: string, to: string) => flatDialog.slice(flatDialog.indexOf(from), flatDialog.indexOf(to, flatDialog.indexOf(from)));

  it("is a drop target as a whole, and shows it while a file is over it", () => {
    const dialogTag = between('className="modal feedback-dialog"', 'role="dialog"');
    for (const handler of ["onDragEnter={dragEnter}", "onDragOver={dragOver}", "onDragLeave={dragLeave}", "onDrop={drop}", "onPaste={paste}"]) {
      expect(dialogTag, handler).toContain(handler);
    }
    expect(flatDialog).toMatch(/<div className="fb-drop" aria-hidden="true" data-active=\{dragging \|\| undefined\}>/);
    expect(flatDialog).toMatch(/if \(accepting\) images\.add\(Array\.from\(e\.dataTransfer\.files\)\);/);
  });

  it("keeps a file dropped beside the dialog from opening in place of the deck", () => {
    // The browser's own answer to a file dropped on a page is to open it,
    // which would throw away everything typed.
    expect(flatDialog).toMatch(/<div className="modal-backdrop" onClick=\{onClose\} role="presentation" onDragOver=\{refuseBesideDialog\} onDrop=\{dropBesideDialog\}>/);
    expect(flatDialog).toMatch(/function refuseBesideDialog\(e: DragEvent\) \{ if \(e\.target !== e\.currentTarget \|\| !fileDrag\(e\)\) return; e\.preventDefault\(\); e\.dataTransfer\.dropEffect = "none"; \}/);
    expect(flatDialog).toMatch(/function dropBesideDialog\(e: DragEvent\) \{ if \(fileDrag\(e\)\) e\.preventDefault\(\); \}/);
  });

  it("opens the picker for PNG and JPEG from a button that says what it adds", () => {
    expect(shotsView).toMatch(/<input ref=\{pickRef\} type="file" accept="image\/png,image\/jpeg" multiple hidden/);
    expect(shotsView).toMatch(/className="fb-attach"/);
    expect(shotsView).toMatch(/\{ADD_LABEL\}/);
    expect(shotsView).toMatch(/title=\{ADD_HINT\}/);
  });

  it("draws each image in a fixed box, named, with a remove of its own", () => {
    expect(shotsView).toMatch(/<ul className="fb-shots-list">/);
    expect(shotsView).toMatch(/<img className="fb-shot-img" src=\{shot\.url\} alt=\{/);
    expect(shotsView).toMatch(/aria-label=\{`Remove image \$\{index \+ 1\}`\}/);
    expect(shotsView).toMatch(/const summary = shotsSummary\(shots\.length, shots\.filter\(shot => shot\.resized\)\.length\);/);
    expect(shotsView).toMatch(/<span className="fb-shots-count">\{summary\}<\/span>/);
    expect(shotsView).toMatch(/\{SHOTS_NOTE\}/);
  });

  it("says each change out loud, since a paste makes no sound", () => {
    expect(shotsView).toMatch(/<p className="vis-hidden" role="status">\{images\.announcement\}<\/p>/);
  });

  it("names what went wrong beside the images", () => {
    expect(shotsView).toMatch(/\{images\.problem && <p ref=\{problemRef\} className="fb-error" role="alert">\{images\.problem\}<\/p>\}/);
    // And brought into view, since on a short window it lands below the fold.
    expect(shotsView).toMatch(/if \(images\.problem\) problemRef\.current\?\.scrollIntoView\(\{ block: "nearest" \}\);/);
  });

  it("finishes every fit before it sends, and sends the fitted images", () => {
    expect(flatDialog).toMatch(/const attached = await images\.ready\(\);/);
    expect(flatDialog).toMatch(/feedbackRequest\(\{ kind, title: sentTitle, body: body\.trim\(\), contact: contact\.trim\(\) \|\| undefined \}, attached\)/);
    expect(hook).toMatch(/prepareImage\(/);
  });

  it("says the same refusal twice when the same file is refused twice", () => {
    // Found in the browser: a second GIF pasted left the alert's text as it
    // was, so nothing was read out and nothing scrolled into view. The problem
    // is cleared as each add begins, before anything is awaited.
    const addAll = hook.slice(hook.indexOf("const addAll = useCallback(async"), hook.indexOf("}, [addOne]);"));
    expect(addAll).toMatch(/^const addAll = useCallback\(async \(files: readonly File\[\]\) => \{ setProblem\(""\);/);
  });

  it("describes the add button once, not again as text after it", () => {
    // A visually hidden hint is still read in browse mode, straight after the
    // description that already said it.
    expect(shotsView).toMatch(/<span id="fb-attach-hint" hidden>\{ADD_HINT\}<\/span>/);
    expect(shotsView).toMatch(/aria-describedby="fb-attach-hint"/);
  });

  it("gives every object URL back", () => {
    expect(hook).toMatch(/URL\.revokeObjectURL/);
  });
});
