// The fake API's feedback conversations: /v1/device/feedback/* the way the
// conversations design (sections 3.2-3.3, 3.9) says the real API answers them,
// and the team's side of a thread for a suite to play — a reply, a status, an
// event.
//
// THE REAL ENDPOINTS DO NOT EXIST YET. The API's contracts and fixtures were
// written first; every body here starts from one of those fixtures
// (fixtures/account-contract/feedback-*.json, byte-identical copies), and the
// request checks are the API's parsers written out field for field:
// FeedbackDeviceRequests.ParseCreate / Fields / ParseReply / ParseRead, over
// FeedbackRequest's Validate. A body this refuses names the field the API would. The fixtures
// carry the shapes; this carries the behaviour: items numbered from 0 without
// gaps, read markers that only move forward and clamp, the two daily limits
// with their Retry-After, a reply on Fixed or Won't do reopening the thread,
// and another account's thread answering 404 thread_not_found, never 403.
//
// Every create body the fake was sent is kept (`created`) with the names of
// its fields, so a suite can say what was never sent: a contact, a device id.
import { randomUUID } from "node:crypto";

export interface Recorded { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: any; raw: string; bytes: Buffer }
export interface Reply { status: number; body?: unknown; headers?: Record<string, string> }

export interface StatusView { code: string; label: string; fixedIn: string | null; reason: string | null; released: boolean }
export interface Item {
  seq: number; at: string; type: string; side: "user" | "team"; text: string;
  via?: string; signature?: string; status?: StatusView; issue?: { number: number; url: string }; version?: string;
  images?: { id: string; type: string; width: number; height: number; bytes: number }[];
}
export interface Thread {
  id: string; accountId: string; deviceId: string | null; kind: string; title: string; status: StatusView;
  createdAt: string; items: Item[]; readSeq: number; trackedIssue: { number: number; url: string } | null;
  releaseNotified: string | null;
}
export interface Created { via: "json" | "form"; fields: string[]; values: Record<string, string>; images: number }

export const NEW_PER_DAY = 10;
export const REPLIES_PER_DAY = 50;
export const JSON_MAX = 64 * 1024;
export const FORM_MAX = 12 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 50;

const TOKEN = /^[0-9A-Za-z.+_-]+$/;
const CURSOR = /^[A-Za-z0-9_-]{1,64}$/;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** FeedbackRequest.AsTyped: each CR LF, and each lone CR, the LF that was typed. */
const asTyped = (text: string | null) => (text == null ? null : text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
/** FeedbackRequest.Blank. */
const blank = (v: string | null) => (v == null || v.trim() === "" ? null : v.trim());
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** UtcTimestampConverter: UTC with a Z, no fraction when there is none. */
export const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

/** FeedbackRequest.Validate over already-read text fields, problems by field. */
function validateFields(errors: Map<string, string>, f: Record<string, string | null>) {
  const add = (k: string, m: string) => { if (!errors.has(k)) errors.set(k, m); };
  const kind = f.kind?.trim().toLowerCase();
  if (!["bug", "idea", "other"].includes(kind ?? "")) add("kind", "Kind is bug, idea or other.");
  const require = (k: string, min: number, max: number) => {
    const n = asTyped(f[k])?.trim().length ?? 0;
    if (n < min || n > max) add(k, `Between ${min} and ${max} characters.`);
  };
  require("title", 3, 120);
  require("body", 1, 10_000);
  for (const k of ["appVersion", "platform"]) {
    const v = blank(f[k]);
    if (v == null) continue;
    if (v.length > 32) add(k, "At most 32 characters.");
    else if (!TOKEN.test(v)) add(k, "Letters, digits, dots, dashes, underscores and plus signs only.");
  }
}

/** FeedbackDeviceRequests' Text: a string, absent/null as null, anything else a problem. */
function text(errors: Map<string, string>, body: Record<string, unknown>, name: string): string | null {
  if (!Object.hasOwn(body, name) || body[name] === null) return null;
  if (typeof body[name] === "string") return body[name] as string;
  errors.set(name, "Text.");
  return null;
}

/** FeedbackDeviceRequests.ParseCreate, as the problems it reports by field. */
export function createProblems(body: unknown): string[] {
  const errors = new Map<string, string>();
  if (!isObj(body)) return ["body"];
  const fields: Record<string, string | null> = {};
  for (const k of ["kind", "title", "body", "appVersion", "platform"]) fields[k] = text(errors, body, k);
  validateFields(errors, fields);
  if (Object.hasOwn(body, "contact") && body.contact !== null) errors.set("contact", "Account conversations have no contact field.");
  return [...errors.keys()];
}

/** FeedbackDeviceRequests.ParseReply. */
export function replyProblems(body: unknown): string[] {
  if (!isObj(body)) return ["body"];
  const errors = new Map<string, string>();
  const raw = text(errors, body, "body");
  if (errors.size) return ["body"];
  const n = asTyped(raw)?.trim().length ?? 0;
  return n >= 1 && n <= 10_000 ? [] : ["body"];
}

/** FeedbackDeviceRequests.ParseRead: `seq`, a whole number from 0. */
export function readProblems(body: unknown): string[] {
  if (!isObj(body)) return ["body"];
  const seq = body.seq;
  return Number.isInteger(seq) && (seq as number) >= 0 && (seq as number) <= 2_147_483_647 ? [] : ["seq"];
}

/** An image's kind by its first bytes, as ImageScrub decides it. */
function imageType(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (bytes.length >= 8 && PNG.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

/** A PNG's sides from its IHDR; a JPEG's from its first SOF marker. */
function imageSize(bytes: Uint8Array, type: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png" && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    const length = view.getUint16(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
    i += 2 + length;
  }
  return { width: 1, height: 1 };
}

export const LABELS: Record<string, string> = {
  received: "Received", looking: "Looking into it", planned: "Planned", wont_do: "Won't do",
};
/** ThreadStatuses: the label and the event line the API writes for a status. */
export function statusView(code: string, { fixedIn = null as string | null, reason = null as string | null, released = false } = {}): StatusView {
  const label = code === "fixed" ? `Fixed in ${fixedIn}` : LABELS[code] ?? code;
  return { code, label, fixedIn: code === "fixed" ? fixedIn : null, reason: code === "wont_do" ? reason : null, released };
}
export function statusLine(s: StatusView): string {
  if (s.code === "fixed") return `Fixed in ${s.fixedIn}. You'll hear here when it's out.`;
  if (s.code === "wont_do") return `Won't do: ${s.reason}`;
  return `Status changed to ${s.label}.`;
}

export function createFeedbackFake({
  now, appBase, fixture, problem, validation,
}: {
  now: () => number;
  appBase: () => string;
  fixture: (name: string) => any;
  problem: (status: number, error: string, extra?: Record<string, unknown>) => Reply;
  validation: (errors: Record<string, string[]>) => Reply;
}) {
  const threads = new Map<string, Thread>();
  const created: Created[] = [];
  /** When each account opened a conversation, and wrote a reply — the two
   *  daily limits' counts. Deleted rows count too, so nothing here forgets. */
  const opened = new Map<string, number[]>();
  const replied = new Map<string, number[]>();

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply =>
    ({ status, body, headers: { "content-type": "application/json", ...headers } });
  const notFound = () => ({ ...problem(404, "thread_not_found"), body: fixture("feedback-error.thread-not-found.json") });

  const lastSeq = (t: Thread) => t.items.length - 1;
  const lastTeamSeq = (t: Thread) => t.items.reduce((n, i) => (i.side === "team" ? i.seq : n), 0);
  const hasUnread = (t: Thread) => t.items.some(i => i.side === "team" && i.seq > t.readSeq);
  const lastAt = (t: Thread) => t.items[t.items.length - 1].at;

  function summary(t: Thread) {
    const last = t.items[t.items.length - 1];
    const preview = last.text.replace(/\s+/g, " ").trim();
    return {
      id: t.id, kind: t.kind, title: t.title, status: { ...t.status },
      createdAt: t.createdAt, lastActivityAt: lastAt(t), lastSeq: lastSeq(t), readSeq: t.readSeq,
      hasUnread: hasUnread(t), preview: { side: last.side, text: preview.length > 140 ? preview.slice(0, 140) : preview },
      trackedIssue: t.trackedIssue, images: t.items[0].images?.length ?? 0,
      webUrl: `${appBase()}/conversations/${t.id}`,
    };
  }

  /** The account level: conversations with an unseen team item, and when the
   *  latest team item was written. */
  function accountSummary(accountId: string) {
    const mine = [...threads.values()].filter(t => t.accountId === accountId);
    const team = mine.flatMap(t => t.items.filter(i => i.side === "team").map(i => i.at)).sort();
    return { unread: mine.filter(hasUnread).length, latestAt: team.at(-1) ?? null };
  }

  function view(t: Thread, before?: number) {
    const shown = before == null ? t.items : t.items.filter(i => i.seq < before);
    const page = shown.slice(-PAGE);
    return { thread: summary(t), items: page.map(i => ({ ...i })), earlier: page.length && page[0].seq > 0 ? page[0].seq : null };
  }

  /** The list's cursor: the last activity and the id, base64url, 32 characters. */
  const cursorOf = (t: Thread) => {
    const bytes = Buffer.alloc(24);
    bytes.writeBigInt64BE(BigInt(Date.parse(lastAt(t))));
    Buffer.from(t.id.replace(/-/g, ""), "hex").copy(bytes, 8);
    return bytes.toString("base64url");
  };
  const order = (a: Thread, b: Thread) => Date.parse(lastAt(b)) - Date.parse(lastAt(a)) || (a.id < b.id ? 1 : -1);

  /** The oldest of `times` inside the last day, as the seconds until it is a day old. */
  function limited(times: number[], max: number): number | null {
    const t = now();
    const inDay = times.filter(x => t - x < DAY_MS);
    if (inDay.length < max) return null;
    return Math.max(1, Math.ceil((Math.min(...inDay) + DAY_MS - t) / 1000));
  }
  const limitReply = (error: "too_many_conversations" | "too_many_replies", seconds: number) => {
    const name = error === "too_many_conversations" ? "feedback-error.too-many-conversations.json" : "feedback-error.too-many-replies.json";
    return json(429, { ...fixture(name), limit: error === "too_many_conversations" ? NEW_PER_DAY : REPLIES_PER_DAY, retryAfterSec: seconds },
      { "content-type": "application/problem+json", "retry-after": String(seconds) });
  };

  function open(accountId: string, deviceId: string | null, fields: Record<string, string | null>, images: Item["images"]): Thread {
    const at = stamp(now());
    const t: Thread = {
      id: randomUUID(), accountId, deviceId, kind: fields.kind!.trim().toLowerCase(), title: asTyped(fields.title)!.trim(),
      status: statusView("received"), createdAt: at, readSeq: 0, trackedIssue: null, releaseNotified: null,
      items: [{ seq: 0, at, type: "message", side: "user", text: asTyped(fields.body)!.trim(), via: "deck", images: images ?? [] }],
    };
    threads.set(t.id, t);
    return t;
  }

  async function readForm(req: Recorded): Promise<{ fields: Record<string, string | null>; names: string[]; files: { name: string; bytes: Uint8Array }[]; textImages: boolean } | null> {
    try {
      const form = await new Request("http://fake/", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: new Uint8Array(req.bytes) }).formData();
      const fields: Record<string, string | null> = {};
      const names: string[] = [];
      const files: { name: string; bytes: Uint8Array }[] = [];
      let textImages = false;
      for (const [name, value] of form.entries()) {
        if (!names.includes(name)) names.push(name);
        if (typeof value === "string") {
          if (name === "images") textImages = true;
          // StringValues joins repeated parts with a comma.
          else fields[name] = fields[name] == null ? value : `${fields[name]},${value}`;
        } else {
          files.push({ name, bytes: new Uint8Array(await value.arrayBuffer()) });
        }
      }
      return { fields, names, files, textImages };
    } catch {
      return null;
    }
  }

  /** POST /v1/device/feedback/threads, JSON or the form with images. */
  async function create(req: Recorded, accountId: string, deviceId: string): Promise<Reply> {
    const multipart = /^multipart\/form-data\s*;/i.test(String(req.headers["content-type"] ?? ""));
    let fields: Record<string, string | null>;
    const errors = new Map<string, string>();
    const imageProblems: string[] = [];
    let images: NonNullable<Item["images"]> = [];
    if (multipart) {
      if (req.bytes.length > FORM_MAX) return problem(413, "too_large");
      const form = await readForm(req);
      if (!form) return validation({ body: ["A form."] });
      fields = {};
      for (const k of ["kind", "title", "body", "appVersion", "platform"]) fields[k] = form.fields[k] ?? null;
      created.push({ via: "form", fields: form.names, values: Object.fromEntries(Object.entries(form.fields).map(([k, v]) => [k, v ?? ""])), images: form.files.length });
      validateFields(errors, fields);
      if (form.names.includes("contact")) errors.set("contact", "Account conversations have no contact field.");
      // FeedbackForm.ImagesAsync, and ImageScrub's first check.
      if (form.files.some(f => f.name.toLowerCase() !== "images")) imageProblems.push("Only parts named images may carry a file.");
      if (form.textImages) imageProblems.push("Send each image as a file part.");
      const files = form.files.filter(f => f.name.toLowerCase() === "images");
      if (files.length > 3) imageProblems.push("At most 3 images.");
      else {
        files.forEach((f, i) => {
          const type = f.bytes.length > 5 * 1024 * 1024 ? null : imageType(f.bytes);
          if (f.bytes.length > 5 * 1024 * 1024) imageProblems.push(`Image ${i + 1} is over 5 MB.`);
          else if (!type) imageProblems.push(`Image ${i + 1} is not a PNG or a JPEG.`);
          else images.push({ id: randomUUID(), type, ...imageSize(f.bytes, type), bytes: f.bytes.length });
        });
      }
    } else {
      if (req.bytes.length > JSON_MAX) return problem(413, "too_large");
      let body: unknown;
      try { body = JSON.parse(req.raw); } catch { return validation({ body: ["A JSON object."] }); }
      if (isObj(body)) created.push({ via: "json", fields: Object.keys(body), values: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])), images: 0 });
      const bad = createProblems(body);
      if (bad.length) return validation(Object.fromEntries(bad.map(f => [f, [`${f} is not valid.`]])));
      const b = body as Record<string, unknown>;
      fields = {};
      for (const k of ["kind", "title", "body", "appVersion", "platform"]) fields[k] = (b[k] as string | null | undefined) ?? null;
      images = [];
    }
    if (errors.size || imageProblems.length) {
      const out: Record<string, string[]> = Object.fromEntries([...errors].map(([k, m]) => [k, [m]]));
      if (imageProblems.length) out.images = imageProblems;
      return validation(out);
    }
    const times = opened.get(accountId) ?? [];
    const wait = limited(times, NEW_PER_DAY);
    if (wait != null) return limitReply("too_many_conversations", wait);
    times.push(now());
    opened.set(accountId, times);
    const t = open(accountId, deviceId, fields, images);
    return json(201, view(t), { location: `/v1/device/feedback/threads/${t.id}` });
  }

  function reply(req: Recorded, t: Thread): Reply {
    if (/^multipart\//i.test(String(req.headers["content-type"] ?? ""))) {
      return json(415, { type: "https://tools.ietf.org/html/rfc9110#section-15.5.16", title: "Unsupported Media Type", status: 415 }, { "content-type": "application/problem+json" });
    }
    if (req.bytes.length > JSON_MAX) return problem(413, "too_large");
    if (replyProblems(req.body).length) return validation({ body: ["Between 1 and 10000 characters."] });
    const times = replied.get(t.accountId) ?? [];
    const wait = limited(times, REPLIES_PER_DAY);
    if (wait != null) return limitReply("too_many_replies", wait);
    times.push(now());
    replied.set(t.accountId, times);
    const at = stamp(now());
    const item: Item = { seq: t.items.length, at, type: "message", side: "user", text: asTyped(req.body.body)!.trim(), via: "deck" };
    t.items.push(item);
    // A reply on Fixed or Won't do reopens it, as the item right after.
    if (t.status.code === "fixed" || t.status.code === "wont_do") {
      t.status = statusView("received");
      t.items.push({ seq: t.items.length, at, type: "reopened", side: "user", text: "Reopened by your reply." });
    }
    return json(201, { item: { ...item }, thread: summary(t) });
  }

  /** Every /v1/device/feedback request from an authenticated device. */
  async function route(req: Recorded, device: { id: string; accountId: string }): Promise<Reply | null> {
    const url = new URL(req.path, "http://fake");
    const path = url.pathname;
    if (path !== "/v1/device/feedback/threads" && !path.startsWith("/v1/device/feedback/threads/")) return null;
    if (path === "/v1/device/feedback/threads") {
      if (req.method === "POST") return create(req, device.accountId, device.id);
      if (req.method !== "GET") return null;
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit == null ? PAGE : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE || (rawLimit != null && !/^\d+$/.test(rawLimit))) return validation({ limit: ["A whole number from 1 to 50."] });
      const before = url.searchParams.get("before");
      if (before != null && !(CURSOR.test(before) && before.length === 32 && Buffer.from(before, "base64url").length === 24)) {
        return validation({ before: ["Not a cursor this list gave."] });
      }
      const mine = [...threads.values()].filter(t => t.accountId === device.accountId).sort(order);
      const from = before == null ? 0 : mine.findIndex(t => cursorOf(t) === before) + 1;
      const page = mine.slice(from, from + limit);
      const more = from + limit < mine.length;
      return json(200, { threads: page.map(summary), next: more ? cursorOf(page[page.length - 1]) : null, ...accountSummary(device.accountId) });
    }
    const m = /^\/v1\/device\/feedback\/threads\/([^/]+)(\/replies|\/read)?$/.exec(path);
    if (!m) return null;
    const t = threads.get(m[1].toLowerCase());
    // Not mine is not found, never forbidden.
    if (!t || t.accountId !== device.accountId) return notFound();
    if (!m[2] && req.method === "GET") {
      const raw = url.searchParams.get("before");
      if (raw != null && !/^\d{1,10}$/.test(raw)) return validation({ before: ["A whole number from 0."] });
      return json(200, view(t, raw == null ? undefined : Number(raw)));
    }
    if (m[2] === "/replies" && req.method === "POST") return reply(req, t);
    if (m[2] === "/read" && req.method === "POST") {
      if (req.bytes.length > JSON_MAX) return problem(413, "too_large");
      if (readProblems(req.body).length) return validation({ seq: ["A whole number from 0 to 2147483647."] });
      // Read markers only move forward, and never past the last item.
      t.readSeq = Math.max(t.readSeq, Math.min(req.body.seq, lastSeq(t)));
      return json(200, accountSummary(t.accountId));
    }
    return null;
  }

  function thread(id?: string): Thread {
    const t = id ? threads.get(id) : [...threads.values()].at(-1);
    if (!t) throw new Error("no such thread");
    return t;
  }
  const push = (t: Thread, item: Omit<Item, "seq" | "at"> & { at?: string }) => {
    const full = { at: stamp(now()), ...item, seq: t.items.length } as Item;
    t.items.push(full);
    return full;
  };

  return {
    route,
    threads,
    created,
    accountSummary,
    view,
    /** The team replies, signed as the admin is shown to users. */
    teamReply(id: string | undefined, text: string, signature = "Constantin · ccdeck team") {
      return push(thread(id), { type: "message", side: "team", text, signature });
    },
    /** The team changes the status: the item and the thread's own. */
    teamStatus(id: string | undefined, code: string, extra: { fixedIn?: string; reason?: string } = {}) {
      const t = thread(id);
      t.status = statusView(code, { fixedIn: extra.fixedIn ?? null, reason: extra.reason ?? null });
      return push(t, { type: "status", side: "team", text: statusLine(t.status), status: { ...t.status } });
    },
    /** Any other item — an issue, a duplicate, a release notice, or a type
     *  this deck has never heard of. */
    teamItem(id: string | undefined, item: Omit<Item, "seq" | "at" | "side"> & { side?: "user" | "team"; at?: string }) {
      const t = thread(id);
      if (item.type === "issue" && item.issue) t.trackedIssue = item.issue;
      return push(t, { side: "team", ...item });
    },
    /** A conversation of `accountId` that the team has already answered: the
     *  thread fixture's items, under a new id. */
    seed(accountId: string, { title, items }: { title?: string; items?: Item[] } = {}) {
      const tpl = fixture("feedback-thread.response.json");
      const t: Thread = {
        id: randomUUID(), accountId, deviceId: null, kind: tpl.thread.kind, title: title ?? tpl.thread.title,
        status: { ...tpl.thread.status }, createdAt: tpl.thread.createdAt, readSeq: tpl.thread.readSeq,
        trackedIssue: tpl.thread.trackedIssue, releaseNotified: null, items: items ?? tpl.items,
      };
      threads.set(t.id, t);
      return t;
    },
    thread,
  };
}

export type FeedbackFake = ReturnType<typeof createFeedbackFake>;
