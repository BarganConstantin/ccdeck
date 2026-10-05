// A report with images (#1853's dialog): the multipart form the page posts,
// read and checked here, and the one this server sends on to api.ccdeck.dev.
//
// THE API'S LIMITS ARE HELD HERE FIRST, so a request it would refuse never
// leaves the machine: at most three images, each at most 5 MB, the whole
// request at most 12 MB, and each a PNG or a JPEG as its first bytes say —
// never as its name or the type the page declared, since a GIF renamed .png is
// still a GIF (ccdeck-api FeedbackForm and ImageScrub, which this mirrors).
// What the API checks and this does not is the image's inside: each side 1 to
// 8192 pixels, and a PNG or JPEG that is whole. The dialog fits the sides
// before sending, and a damaged file comes back as the API's own 400.
//
// WHAT GOES ON is the page's text as it came, this deck's version and system
// from feedbackFacts (the page's own are ignored, as they are for JSON), and
// each image's bytes under a name of this server's making. A file's own name
// can say whose machine it was on — "alice-desk.png" — and the API keeps no
// name, so none is sent. The API strips EXIF, GPS and text chunks itself.
//
// Node's own Request parses the form and the next one is written out by hand
// (upstreamForm says why), so this costs no dependency. Request is there on the
// Node 18 the package promises (undici's multipart reader shipped inside it);
// `File` is not a global before Node 20 and is never named here.

import { randomBytes } from "node:crypto";

export const IMAGES_FIELD = "images";
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The whole request, images and text together. Three images at their limit do not fit, on purpose. */
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_START = [0xff, 0xd8, 0xff];
const TEXT_FIELDS = ["kind", "title", "body", "contact"];

/** What a file is by its first bytes: "png", "jpeg", or null for anything else. */
export function imageFormat(bytes) {
  const starts = sig => sig.every((b, i) => bytes[i] === b);
  if (bytes.length >= PNG_SIGNATURE.length && starts(PNG_SIGNATURE)) return "png";
  if (bytes.length >= JPEG_START.length && starts(JPEG_START)) return "jpeg";
  return null;
}

const FORMAT = {
  png: { type: "image/png", extension: "png" },
  jpeg: { type: "image/jpeg", extension: "jpg" },
};

/** Whether a request's content type says it is a multipart form. */
export function isMultipart(contentType) {
  return typeof contentType === "string" && /^multipart\/form-data\s*;/i.test(contentType.trim());
}

/**
 * The page's form, read: its text fields and its images, each image known by
 * its bytes. `problems` holds one sentence per thing the API would refuse, in
 * the API's own words, and is empty when the form may go on. Null when the
 * body is not a form at all.
 */
export async function readFeedbackForm(bytes, contentType) {
  let form;
  try {
    form = await new Request("http://127.0.0.1/", {
      method: "POST",
      headers: { "content-type": contentType },
      body: bytes,
    }).formData();
  } catch {
    return null;
  }

  const problems = [];
  const fields = {};
  const files = [];
  let fileElsewhere = false;
  let imageAsText = false;
  for (const [name, value] of form.entries()) {
    const isFile = typeof value !== "string";
    if (name === IMAGES_FIELD) {
      if (isFile) files.push(value);
      else imageAsText = true;
    } else if (isFile) {
      fileElsewhere = true;
    } else if (TEXT_FIELDS.includes(name) && !(name in fields)) {
      // Back to the LF the box held. A textarea's value never has a CR in it,
      // so every CRLF here is the form encoding's, not the person's.
      fields[name] = value.replace(/\r\n/g, "\n");
    }
  }
  // Refused rather than ignored, as the API does: a part named "image" would
  // otherwise leave its sender believing the screenshot arrived.
  if (fileElsewhere) problems.push("Only parts named images may carry a file.");
  if (imageAsText) problems.push("Send each image as a file part.");

  const images = [];
  if (files.length > MAX_IMAGES) {
    problems.push(`At most ${MAX_IMAGES} images.`);
  } else {
    for (const [index, file] of files.entries()) {
      const n = index + 1;
      if (file.size > MAX_IMAGE_BYTES) {
        problems.push(`Image ${n} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
        continue;
      }
      const data = new Uint8Array(await file.arrayBuffer());
      const format = imageFormat(data);
      if (!format) problems.push(`Image ${n} is not a PNG or a JPEG.`);
      else images.push({ data, format });
    }
  }
  return { fields, images, problems };
}

/**
 * The form this server posts on: the page's text, this deck's facts
 * (feedbackFacts in reports-routes.mjs), and the images under names of its own.
 *
 * WRITTEN OUT HERE rather than through FormData, for the line breaks. A form's
 * encoding turns every line break in a text field into CRLF, FormData's too,
 * and the API counts a CRLF as two characters of the message's 10,000. A pasted
 * log of a thousand short lines that fitted the box went over with an image
 * attached, while the same words went through as JSON without one. So the text
 * goes on as the box held it, LF for LF, and the limit means the same on both
 * paths.
 *
 * A Blob whose type carries the boundary, so fetch still writes the content
 * type itself. The boundary is lower case because a Blob's type is, and random
 * so no message can contain it.
 */
export function upstreamForm({ fields, images }, facts) {
  const boundary = `ccdeck-${randomBytes(16).toString("hex")}`;
  const parts = [];
  const head = (name, file = "") => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file}\r\n`;
  const text = (name, value) => parts.push(`${head(name)}\r\n${value}\r\n`);
  for (const name of ["kind", "title", "body"]) {
    if (typeof fields[name] === "string") text(name, fields[name]);
  }
  const contact = typeof fields.contact === "string" ? fields.contact.trim() : "";
  if (contact) text("contact", contact);
  text("appVersion", facts.appVersion);
  text("platform", facts.platform);
  for (const [index, { data, format }] of images.entries()) {
    const { type, extension } = FORMAT[format];
    parts.push(`${head(IMAGES_FIELD, `; filename="image-${index + 1}.${extension}"`)}Content-Type: ${type}\r\n\r\n`, data, "\r\n");
  }
  parts.push(`--${boundary}--\r\n`);
  return new Blob(parts, { type: `multipart/form-data; boundary=${boundary}` });
}
