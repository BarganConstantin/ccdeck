// Screenshots with feedback (#1853's dialog): the rules, apart from React.
//
// An image arrives three ways — dropped on the dialog, pasted (⌘V of a
// screenshot is the common one), or picked — and each is checked here before
// it is shown: PNG or JPEG by its first bytes, never by its name, since the API
// reads the bytes too (ccdeck-api ImageScrub). Nothing converts a GIF, a WebP
// or a HEIC, and the refusal says so rather than leaving a person to guess.
//
// THE COMMON SCREENSHOT MUST GO AS IT IS TAKEN. A full capture of a 5K screen
// is 5120 × 2880, and as a PNG it is often over the API's 5 MB. So an image
// over its budget, or over 8192 pixels on a side, is drawn again through a
// canvas: first the same format with the long side brought down by about the
// square root of the overshoot, since bytes go roughly as the area; then, only
// if that smaller PNG is still too big, a JPEG at a high quality at the same
// size, resolution being worth more to a screenshot than its format; then
// smaller again, until it fits or would no longer be worth reading. An image
// already inside every limit is sent as its own bytes, never redrawn.
//
// Each image's budget is 5 MB or what the others leave of the request's 12,
// less room for the text, so three large screenshots still go together.
import type { FeedbackFields } from "./feedback";

export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
export const MAX_SIDE = 8192;
/** Kept out of the 12 MB for the text and the form's own framing: a message of
 *  10,000 characters is at most 40 KB of UTF-8. */
export const TEXT_ALLOWANCE = 64 * 1024;
/** Less room than this is no room: nothing worth reading fits in it. */
export const MIN_BUDGET = 256 * 1024;
export const JPEG_QUALITY = 0.92;
/** Below this on its long side a screenshot is a thumbnail, not evidence. */
const MIN_LONG_SIDE = 640;
/** How far under the budget an estimate aims, since the estimate is rough. */
const SAFETY = 0.9;
/** Each retry is at least this much smaller, so the loop always ends. */
const SHRINK_AT_MOST = 0.85;
const MAX_ATTEMPTS = 6;
/** Enough of a file to read its type and, nearly always, its size. */
const HEAD_BYTES = 512 * 1024;

export type ImageFormat = "png" | "jpeg";
export interface Size { width: number; height: number }

const MIME: Record<ImageFormat, string> = { png: "image/png", jpeg: "image/jpeg" };
const EXTENSION: Record<ImageFormat, string> = { png: "png", jpeg: "jpg" };
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_START = [0xff, 0xd8, 0xff];

/** What a file is by its first bytes, or null for anything but a PNG or a JPEG. */
export function imageFormat(bytes: Uint8Array): ImageFormat | null {
  const starts = (signature: number[]) => bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
  if (starts(PNG_SIGNATURE)) return "png";
  if (starts(JPEG_START)) return "jpeg";
  return null;
}

/** The pixel size a PNG's IHDR or a JPEG's frame header says, or null when the
 *  bytes given stop before it. A JPEG's is before any EXIF rotation, which
 *  changes neither its long side nor its area. */
export function imageSize(bytes: Uint8Array): Size | null {
  const format = imageFormat(bytes);
  if (format === "png") return pngSize(bytes);
  if (format === "jpeg") return jpegSize(bytes);
  return null;
}

function pngSize(bytes: Uint8Array): Size | null {
  const IHDR = [0x49, 0x48, 0x44, 0x52];
  if (bytes.length < 24 || !IHDR.every((b, i) => bytes[12 + i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Start of frame: C0 to CF, but for C4, C8 and CC, which share the range. */
function isFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(bytes: Uint8Array): Size | null {
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    while (at < bytes.length && bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return null;
    const length = (bytes[at] << 8) | bytes[at + 1];
    if (length < 2) return null;
    if (isFrame(marker)) {
      if (at + 7 > bytes.length) return null;
      return { height: (bytes[at + 3] << 8) | bytes[at + 4], width: (bytes[at + 5] << 8) | bytes[at + 6] };
    }
    at += length;
  }
  return null;
}

/** Whether an image has to be drawn again before it can go. */
export function needsFitting(image: Size & { bytes: number }, budget: number): boolean {
  return image.bytes > budget || image.width > MAX_SIDE || image.height > MAX_SIDE;
}

/** What one image may weigh, given what the others already do. */
export function imageBudget(otherBytes: number): number {
  return Math.min(MAX_IMAGE_BYTES, MAX_REQUEST_BYTES - TEXT_ALLOWANCE - otherBytes);
}

function scaled(size: Size, factor: number): Size {
  return { width: Math.max(1, Math.floor(size.width * factor)), height: Math.max(1, Math.floor(size.height * factor)) };
}

/** The first size to try: inside 8192 on the long side, and with the area cut
 *  by the overshoot in bytes, a little more to be safe. */
export function firstFit(image: Size & { bytes: number }, budget: number): Size {
  const bySide = MAX_SIDE / Math.max(image.width, image.height);
  const byBytes = image.bytes > budget ? Math.sqrt(budget / image.bytes) * SAFETY : 1;
  return scaled(image, Math.min(1, bySide, byBytes));
}

/** Draws the decoded image at a size, in a format, and hands back the file — or
 *  null when the canvas will not. The seam the tests stand a fake in. */
export type Encoder = (size: Size, format: ImageFormat, quality: number | undefined) => Promise<Blob | null>;
export interface Fitted extends Size { blob: Blob; format: ImageFormat }

/** The image drawn again until it fits its budget, or null when nothing worth
 *  reading does. See the top of this file for the order it tries things in. */
export async function fitImage(source: Size & { bytes: number; format: ImageFormat }, budget: number, encode: Encoder): Promise<Fitted | null> {
  let size = firstFit(source, budget);
  let format = source.format;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const blob = await encode(size, format, format === "jpeg" ? JPEG_QUALITY : undefined);
    if (!blob) return null;
    if (blob.size <= budget) return { ...size, blob, format };
    if (format === "png") {
      format = "jpeg";
      continue;
    }
    size = scaled(size, Math.min(SHRINK_AT_MOST, Math.sqrt(budget / blob.size) * SAFETY));
    if (Math.max(size.width, size.height) < MIN_LONG_SIDE) return null;
  }
  return null;
}

/** An image the browser has decoded: its size, a way to draw it, and a way to let it go. */
export interface Decoded extends Size { encoder: Encoder; release(): void }
export type Decoder = (file: Blob) => Promise<Decoded | null>;

export type Problem = "type" | "too_large" | "no_room" | "unreadable";
export type Prepared =
  | { ok: true; blob: Blob; resized: Size | null }
  | { ok: false; problem: Problem };

/** A dropped, pasted or picked file, made ready to send: as it is when it is
 *  inside every limit, drawn again when it is not, or refused with a reason. */
export async function prepareImage(file: Blob, budget: number, decode: Decoder): Promise<Prepared> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const format = imageFormat(head);
  if (!format) return { ok: false, problem: "type" };
  if (budget < MIN_BUDGET) return { ok: false, problem: "no_room" };
  const typed = file.type === MIME[format] ? file : new Blob([file], { type: MIME[format] });
  const known = imageSize(head);
  if (known && !needsFitting({ ...known, bytes: file.size }, budget)) return { ok: true, blob: typed, resized: null };

  const decoded = await decode(file).catch(() => null);
  if (!decoded) return { ok: false, problem: "unreadable" };
  try {
    const source = { width: decoded.width, height: decoded.height, bytes: file.size, format };
    if (!needsFitting(source, budget)) return { ok: true, blob: typed, resized: null };
    const fitted = await fitImage(source, budget, decoded.encoder);
    if (!fitted) return { ok: false, problem: "too_large" };
    return { ok: true, blob: fitted.blob, resized: { width: fitted.width, height: fitted.height } };
  } finally {
    decoded.release();
  }
}

/** The canvas the fit draws on. A JPEG has no transparency, so it is laid on
 *  white first: a window captured with its shadow would otherwise come out on
 *  black. */
export function canvasEncoder(image: CanvasImageSource): Encoder {
  return ({ width, height }, format, quality) => new Promise(resolve => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return resolve(null);
    if (format === "jpeg") {
      context.fillStyle = "white";
      context.fillRect(0, 0, width, height);
    }
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    canvas.toBlob(blob => {
      canvas.width = 0;
      canvas.height = 0;
      resolve(blob);
    }, MIME[format], quality);
  });
}

/** The browser's own decoder. */
export const browserDecoder: Decoder = async file => {
  const bitmap = await createImageBitmap(file);
  return { width: bitmap.width, height: bitmap.height, encoder: canvasEncoder(bitmap), release: () => bitmap.close() };
};

/** Whether a drag is carrying files, rather than a selection of text. */
export function carriesFiles(types: readonly string[]): boolean {
  return types.includes("Files");
}

/** Whether a paste is an image to attach. A clipboard holding words as well —
 *  a spreadsheet's cells come with a picture of themselves — pasted into a
 *  field is the words. */
export function shouldAttachPaste({ files, hasText, intoTextField }: { files: number; hasText: boolean; intoTextField: boolean }): boolean {
  return files > 0 && (!hasText || !intoTextField);
}

/** Where focus goes when an image is removed: the next one's remove, else the
 *  one before, else (null) the add button. */
export function focusAfterRemove<T>(ids: readonly T[], removed: T): T | null {
  const at = ids.indexOf(removed);
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** What Send posts: the JSON it always did when there are no images, a
 *  multipart form with each image as an `images` part when there are. */
export function feedbackRequest(fields: FeedbackFields, images: readonly Blob[]): RequestInit {
  if (images.length === 0) {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) };
  }
  const form = new FormData();
  form.append("kind", fields.kind);
  form.append("title", fields.title);
  form.append("body", fields.body);
  if (fields.contact !== undefined) form.append("contact", fields.contact);
  images.forEach((image, index) => {
    const format: ImageFormat = image.type === MIME.jpeg ? "jpeg" : "png";
    form.append("images", image, `image-${index + 1}.${EXTENSION[format]}`);
  });
  return { method: "POST", body: form };
}

export const ADD_LABEL = "Add screenshot";
export const ADD_HINT = "PNG or JPEG, up to three. You can also paste one, or drop it on this dialog.";
export const SHOTS_NOTE = "A screenshot can show emails, costs and paths. Crop out what should not be seen.";
export const FULL_MESSAGE = "Three images at most. Remove one to add another.";
/** Why a send stopped: an image was refused while it waited for the fits. */
export const REFUSED_WHILE_SENDING = "An image could not be attached, so nothing was sent. Check the images and send again; your text is still here.";

/** What a thumbnail says it does, and which image it is: pressed, it opens the
 *  picker and the file chosen takes this image's place. A redrawn image says
 *  so here, since a person should know it did not go as it was. */
export function replaceLabel(index: number, name: string, resized: Size | null): string {
  const fit = resized ? `, resized to ${resized.width} × ${resized.height} to fit` : "";
  return `Replace image ${index + 1}: ${name}${fit}`;
}

/** "2 of 3", and how many of them were drawn again to fit, since a person
 *  should know their image did not go as it was. */
export function shotsSummary(count: number, resized: number): string {
  const of = `${count} of ${MAX_IMAGES}`;
  return resized > 0 ? `${of} · ${resized} resized to fit` : of;
}

export function leftOutMessage(count: number): string {
  return `Three images at most, so ${count === 1 ? "one was" : `${count} were`} left out.`;
}

/** A file name as a message quotes it: whole, unless it would take the line. */
function quoted(name: string): string {
  const NAME_MAX = 40;
  const short = name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 10)}…${name.slice(-9)}` : name;
  return `“${short}”`;
}

export function problemMessage(problem: Problem, name: string): string {
  const file = quoted(name);
  if (problem === "type") return `${file} is not a PNG or a JPEG, so it was not added. GIF, WebP and HEIC are not converted; save it as a PNG or a JPEG first.`;
  if (problem === "no_room") return `There is no room left for ${file}: images go at up to 12 MB in all. Remove one to add it.`;
  if (problem === "unreadable") return `${file} could not be read as an image.`;
  return `${file} could not be made small enough to send: images go at up to 5 MB each.`;
}
