// Fixtures for scripts/mock-jira.mjs — the deterministic Jira the mock serves.
//
// Everything here is data plus the code that shapes it into Jira's JSON for one
// flavour ("server" = Jira Server/Data Center REST v2 + Agile 1.0, "cloud" =
// Jira Cloud REST v3 + Agile 1.0). The header of mock-jira.mjs documents what
// the fixtures contain; this file is the source of truth for the details.
//
// Pure Node (node:zlib only), no dependencies, no clock: every timestamp is
// fixed, and relative JQL dates are evaluated against MOCK_NOW.
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CLOUD_ID = "11111111-2222-3333-4444-555555555555";
export const SERVER_PAT = "mock-server-pat";
export const SERVER_USER = "jdoe";
export const CLOUD_EMAIL = "jane@example.com";
export const CLOUD_CLASSIC_TOKEN = "ATATTmockClassicToken0123456789abcdef";
export const CLOUD_SCOPED_TOKEN = "ATATTmockScopedToken0123456789abcdef";

/** The mock's "now": relative JQL dates (-14d, -2w, startOfDay()) count from here. */
export const MOCK_NOW = Date.parse("2026-10-19T12:00:00.000+03:00");
/** Every fixture timestamp is rendered in this fixed offset (+0300). */
const OFFSET_MIN = 180;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2026-10-14 09:12:33" in +03:00 -> epoch ms. */
const at = s => Date.parse(`${s.replace(" ", "T")}.000+03:00`);

const pad = (n, w = 2) => String(n).padStart(w, "0");
function local(ms) { return new Date(ms + OFFSET_MIN * MINUTE); }

/** Jira's REST datetime: 2026-10-14T09:12:33.000+0300 */
export function jiraDateTime(ms) {
  if (ms == null) return null;
  const d = local(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+0300`;
}
/** Jira's date-only fields (duedate): 2026-10-23 */
function jiraDate(ms) {
  if (ms == null) return null;
  const d = local(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** Agile sprint dates: Cloud answers in UTC ("...Z"), Server in the server offset ("+03:00"). */
function agileDate(ms, cloud) {
  if (ms == null) return undefined;
  if (cloud) return new Date(ms).toISOString();
  return jiraDateTime(ms).replace(/\+0300$/, "+03:00");
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** renderedFields date-times: 14/Oct/26 9:12 AM */
function renderedDateTime(ms) {
  if (ms == null) return null;
  const d = local(ms);
  const h = d.getUTCHours();
  return `${pad(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${pad(d.getUTCFullYear() % 100)} ${h % 12 || 12}:${pad(d.getUTCMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
function renderedDate(ms) {
  if (ms == null) return null;
  const d = local(ms);
  return `${pad(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${pad(d.getUTCFullYear() % 100)}`;
}
export { DAY, HOUR, MINUTE, OFFSET_MIN };

// ---------------------------------------------------------------------------
// Durations (Jira "pretty" format: 1w 2d 3h 30m)
// ---------------------------------------------------------------------------

/** "2d 30m" -> seconds, with a day of `hpd` hours and a week of `dpw` days. */
export function parseDuration(text, hpd, dpw) {
  if (text == null) return null;
  const s = String(text).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60); // bare number = minutes
  const compact = s.replace(/\s+/g, "");
  const re = /(\d+(?:\.\d+)?)([wdhm])/g;
  let total = 0, consumed = 0, m;
  while ((m = re.exec(compact))) {
    consumed += m[0].length;
    const n = Number(m[1]);
    total += m[2] === "w" ? n * dpw * hpd * 3600 : m[2] === "d" ? n * hpd * 3600 : m[2] === "h" ? n * 3600 : n * 60;
  }
  if (!consumed || consumed !== compact.length) return NaN;
  return Math.round(total);
}

/** seconds -> "2d 30m" the way Jira formats with timeFormat=pretty. */
export function prettyDuration(seconds, hpd, dpw) {
  if (seconds == null) return undefined;
  let mins = Math.round(seconds / 60);
  if (mins === 0) return "0m";
  const perDay = Math.round(hpd * 60);
  const perWeek = Math.round(dpw * perDay);
  const parts = [];
  const w = Math.floor(mins / perWeek); mins -= w * perWeek;
  const d = Math.floor(mins / perDay); mins -= d * perDay;
  const h = Math.floor(mins / 60); mins -= h * 60;
  if (w) parts.push(`${w}w`);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (mins) parts.push(`${mins}m`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Binary assets: PNGs built with zlib + CRC32, a padded PDF, SVG priority icons
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/**
 * A valid truecolour PNG. `pixel(x, y)` returns [r, g, b]. With `padTo`, a
 * tEXt chunk is added so the file is exactly that many bytes.
 */
export function makePng(width, height, pixel, padTo) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * stride + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const parts = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw))];
  const iend = pngChunk("IEND", Buffer.alloc(0));
  if (padTo) {
    const base = parts.reduce((n, b) => n + b.length, 0) + iend.length;
    const dataLen = padTo - base - 12;
    if (dataLen < 9) throw new Error(`makePng: cannot pad ${base} bytes to ${padTo}`);
    parts.push(pngChunk("tEXt", Buffer.concat([Buffer.from("Comment\0", "latin1"), Buffer.alloc(dataLen - 8, 0x20)])));
  }
  parts.push(iend);
  return Buffer.concat(parts);
}

function hashColor(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return [64 + (h & 0x7f), 64 + ((h >>> 8) & 0x7f), 64 + ((h >>> 16) & 0x7f)];
}
const SIZE_PX = { xsmall: 16, small: 24, medium: 32, large: 48, xlarge: 64 };
const pngCache = new Map();
function cachedPng(key, make) {
  if (!pngCache.has(key)) pngCache.set(key, make());
  return pngCache.get(key);
}
/** A user avatar: a disc in the owner's colour on white. */
export function avatarPng(owner, size) {
  const px = SIZE_PX[size] ?? 48;
  return cachedPng(`u:${owner}:${px}`, () => {
    const c = hashColor(owner); const r = px / 2;
    return makePng(px, px, (x, y) => ((x - r + 0.5) ** 2 + (y - r + 0.5) ** 2 <= r * r ? c : [255, 255, 255]));
  });
}
const ISSUETYPE_COLOURS = { 10307: [0x90, 0x4e, 0xe2], 10315: [0x63, 0xba, 0x3c], 10318: [0x4b, 0xad, 0xe8], 10316: [0x4b, 0xad, 0xe8], 10303: [0xe5, 0x49, 0x3a] };
/** An issue-type / project avatar: a rounded square in the type's colour. */
export function iconPng(avatarId, size) {
  const px = SIZE_PX[size] ?? 16;
  return cachedPng(`i:${avatarId}:${px}`, () => {
    const c = ISSUETYPE_COLOURS[avatarId] ?? hashColor(avatarId);
    return makePng(px, px, (x, y) => (x > 0 && y > 0 && x < px - 1 && y < px - 1 ? c : [255, 255, 255]));
  });
}
export function statusPng(name) {
  return cachedPng(`s:${name}`, () => makePng(16, 16, () => hashColor(name)));
}
/** screenshot.png — exactly 2048 bytes, as its attachment metadata says. */
export function screenshotPng() {
  return cachedPng("screenshot", () => makePng(32, 20, (x, y) => [x * 8, y * 12, 160], 2048));
}
export function thumbnailPng(id) {
  return cachedPng(`t:${id}`, () => makePng(16, 10, (x, y) => [x * 16, y * 24, 160]));
}
/** /images/big.png — a valid PNG of 3.5 MB, for image size-cap tests. */
export function bigPng() {
  return cachedPng("big", () => makePng(1, 1, () => [255, 0, 0], 3_500_000));
}
/** notes.txt — exactly 512 bytes of text. */
export function notesTxt() {
  return cachedPng("notes", () => {
    const head = "Mock Jira attachment notes.txt\n\n- PSP sandbox resets every Monday\n- Amex needs a 4-digit CVV\n- Wallet buttons ship in MOCK Sprint 14\n\n";
    const body = Buffer.alloc(512, 0x2e);
    body.write(head, 0, "utf8");
    body[511] = 0x0a;
    return body;
  });
}
/** design.pdf — a valid one-page PDF padded to exactly 1,258,291 bytes (1.2 MB). */
export function designPdf() {
  return cachedPng("pdf", () => {
    const target = 1_258_291;
    const build = padLen => {
      const content = `BT /F1 24 Tf 72 720 Td (design.pdf - mock attachment) Tj ET\n%${"0".repeat(padLen)}\n`;
      const objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ];
      let out = "%PDF-1.4\n";
      const offsets = [];
      objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
      const xref = Buffer.byteLength(out);
      out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${pad(o, 10)} 00000 n \n`).join("")}`;
      out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return Buffer.from(out, "latin1");
    };
    let padLen = 0;
    let buf = build(padLen);
    for (let i = 0; i < 6 && buf.length !== target; i++) { padLen += target - buf.length; buf = build(padLen); }
    return buf;
  });
}
const chevron = (y, fill) => `<path d="M3.5 ${y + 3.4}a.9.9 0 0 1-.6-1.6l4.6-3.7a.8.8 0 0 1 1 0l4.6 3.7a.9.9 0 1 1-1.1 1.4L8 ${y}l-3.9 3.2a.9.9 0 0 1-.6.2z" fill="${fill}"/>`;
const flip = inner => `<g transform="rotate(180 8 8)">${inner}</g>`;
/** The five priority icons, as small real SVGs (Atlassian's shapes, simplified). */
export const PRIORITY_SVGS = {
  highest: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${chevron(3.1, "#ff5630")}${chevron(6.6, "#ff7452")}</svg>`,
  high: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${chevron(4.9, "#ff5630")}</svg>`,
  medium: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M3 4h10a1 1 0 0 1 0 2H3a1 1 0 1 1 0-2zm0 6h10a1 1 0 0 1 0 2H3a1 1 0 0 1 0-2z" fill="#ffab00"/></svg>`,
  low: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${flip(chevron(4.9, "#0065ff"))}</svg>`,
  lowest: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${flip(chevron(3.1, "#0065ff") + chevron(6.6, "#2684ff"))}</svg>`,
};

// ---------------------------------------------------------------------------
// Static reference data
// ---------------------------------------------------------------------------

export const USERS = {
  jane: { accountId: "5b10ac8d82e05b22cc7d4ef5", name: "jdoe", key: "JIRAUSER10000", displayName: "Jane Doe", email: "jane@example.com", avatarId: 10122, timeZone: "Europe/Chisinau" },
  alex: { accountId: "5b10a0effa615349cb016cd8", name: "amorgan", key: "JIRAUSER10001", displayName: "Alex Morgan", email: "alex@example.com", avatarId: 10123, timeZone: "Europe/London" },
  sam: { accountId: "5d53f3cbc6b9320d9ea5bdc2", name: "slee", key: "JIRAUSER10002", displayName: "Sam Lee", email: "sam@example.com", avatarId: 10124, timeZone: "America/New_York" },
  priya: { accountId: "60f1c2a8d9e7b40069c3a1e5", name: "ppatel", key: "JIRAUSER10003", displayName: "Priya Patel", email: "priya@example.com", avatarId: 10125, timeZone: "Asia/Kolkata" },
};
export const ME = "jane";

export const PROJECTS = {
  MOCK: { id: "10000", key: "MOCK", name: "Mock Project", avatarId: 10324, lead: "jane", style: "scrum" },
  KAN: { id: "10001", key: "KAN", name: "Kanban Ops", avatarId: 10325, lead: "alex", style: "kanban" },
  TWO: { id: "10002", key: "TWO", name: "Team Two", avatarId: 10326, lead: "sam", style: "scrum" },
};

export const STATUSES = {
  "To Do": { id: "10000", cat: "new", icon: "open.png", description: "" },
  "In Progress": { id: "3", cat: "indeterminate", icon: "inprogress.png", description: "This issue is being actively worked on at the moment by the assignee." },
  "In Review": { id: "10002", cat: "indeterminate", icon: "generic.png", description: "Waiting for a reviewer." },
  Done: { id: "10001", cat: "done", icon: "closed.png", description: "" },
};
export const STATUS_CATEGORIES = {
  new: { id: 2, key: "new", colorName: "blue-gray", name: "To Do" },
  indeterminate: { id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" },
  done: { id: 3, key: "done", colorName: "green", name: "Done" },
};

export const ISSUE_TYPES = {
  Epic: { cloudId: "10000", serverId: "10000", avatarId: 10307, hierarchyLevel: 1, subtask: false, description: "A big user story that needs to be broken down. Created by Jira Software - do not edit or delete." },
  Story: { cloudId: "10001", serverId: "10001", avatarId: 10315, hierarchyLevel: 0, subtask: false, description: "Functionality or a feature expressed as a user goal." },
  Task: { cloudId: "10002", serverId: "3", avatarId: 10318, hierarchyLevel: 0, subtask: false, description: "A small, distinct piece of work." },
  "Sub-task": { cloudId: "10003", serverId: "5", avatarId: 10316, hierarchyLevel: -1, subtask: true, description: "A small piece of work that's part of a larger task." },
  Bug: { cloudId: "10004", serverId: "1", avatarId: 10303, hierarchyLevel: 0, subtask: false, description: "A problem or error." },
};

export const PRIORITIES = {
  Highest: { id: "1", icon: "highest" },
  High: { id: "2", icon: "high" },
  Medium: { id: "3", icon: "medium" },
  Low: { id: "4", icon: "low" },
  Lowest: { id: "5", icon: "lowest" },
};

export const COMPONENTS = { Web: "10000", API: "10001", Payments: "10002", Infra: "10003" };
export const VERSIONS = {
  "2.4.0": { id: "10000", released: false, releaseDate: "2026-11-03", project: "MOCK" },
  "2.3.0": { id: "10001", released: true, releaseDate: "2026-09-15", project: "MOCK" },
};

// Sprints. Ids 1..15 belong to board 1 (MOCK), 16..17 to board 3 (TWO).
const SPRINT13_START = at("2026-10-13 09:00:00");
const CLOSED_GOALS = ["", "Basket MVP", "Order history", "Tax rules", "", "Guest checkout", "Coupons v1", "Search spike", "", "Refunds", "Address book", "Payment provider swap"];
function buildSprints() {
  const list = [];
  for (let n = 1; n <= 12; n++) {
    const start = SPRINT13_START - (13 - n) * 14 * DAY;
    list.push({
      id: n, name: `MOCK Sprint ${n}`, state: "closed", boardId: 1, sequence: n,
      start, end: start + 14 * DAY, complete: start + 14 * DAY - 20 * MINUTE,
      activated: start + 5 * MINUTE, created: start - 3 * DAY, goal: CLOSED_GOALS[n - 1],
    });
  }
  list.push({ id: 13, name: "MOCK Sprint 13", state: "active", boardId: 1, sequence: 13, start: SPRINT13_START, end: at("2026-10-27 09:00:00"), activated: SPRINT13_START + 5 * MINUTE, created: SPRINT13_START - 3 * DAY, goal: "Ship the new payment step behind the checkout_v2 flag" });
  list.push({ id: 14, name: "MOCK Sprint 14", state: "future", boardId: 1, sequence: 14, created: at("2026-10-08 15:00:00"), goal: "Wallet buttons and saved cards" });
  list.push({ id: 15, name: "MOCK Sprint 15", state: "future", boardId: 1, sequence: 15, created: at("2026-10-08 15:01:00"), goal: "" });
  list.push({ id: 16, name: "TWO Sprint A", state: "active", boardId: 3, sequence: 16, start: at("2026-10-12 10:00:00"), end: at("2026-10-23 18:00:00"), activated: at("2026-10-12 10:02:00"), created: at("2026-10-09 11:00:00"), goal: "Stabilise the CSV importer" });
  list.push({ id: 17, name: "TWO Sprint B", state: "active", boardId: 3, sequence: 17, start: at("2026-10-14 10:00:00"), end: at("2026-10-28 18:00:00"), activated: at("2026-10-14 10:01:00"), created: at("2026-10-09 11:05:00"), goal: "Billing exports" });
  return list;
}
export const SPRINTS = buildSprints();

// ---------------------------------------------------------------------------
// Rich content (MOCK-10)
// ---------------------------------------------------------------------------

const RICH_WIKI = `h2. Why
The current payment step loses *11%* of shoppers. We want _fewer_ fields, +clear+ errors and no -surprise- fees. Use {{PaymentForm}} for the new layout.

{code:javascript}
const total = items.reduce((sum, i) => sum + i.price, 0);
{code}

bq. Customers want to pay in two taps.

* Card number with inline validation
* Apple Pay / Google Pay

# Ship behind the {{checkout_v2}} flag
# Roll out to 10%

||Step||Owner||
|Design|Alex|
|Build|Jane|

{info}Payment provider sandbox resets every Monday.{info}

See [the spec|https://example.com/spec] and [bad link|javascript:alert(1)].
<script>alert(1)</script>
!x|onerror=alert(1)!
!screenshot.png|alt=screenshot!
!https://evil.example/pixel.png!
{color:red}styled{color} [~amorgan]
----
Tracked in MOCK-1`;

const richHtml = (site, cloud) => `<h2><a name="Why"></a>Why</h2>
<p>The current payment step loses <b>11%</b> of shoppers. We want <em>fewer</em> fields, <ins>clear</ins> errors and no <del>surprise</del> fees. Use <tt>PaymentForm</tt> for the new layout.</p>
<p>Newer renderers also emit <strong>strong</strong>, <u>underline</u> and <code>inline code</code>.</p>
<div class="code panel" style="border-width: 1px;"><div class="codeContent panelContent pdl">
<pre class="code-javascript">const total = items.reduce((sum, i) =&gt; sum + i.price, 0);</pre>
</div></div>
<blockquote><p>Customers want to pay in two taps.</p></blockquote>
<ul>
\t<li>Card number with inline validation</li>
\t<li>Apple Pay / Google Pay</li>
</ul>
<ol>
\t<li>Ship behind the <tt>checkout_v2</tt> flag</li>
\t<li>Roll out to 10%</li>
</ol>
<div class='table-wrap'>
<table class='confluenceTable'><tbody>
<tr>
<th class='confluenceTh'>Step</th>
<th class='confluenceTh'>Owner</th>
</tr>
<tr>
<td class='confluenceTd'>Design</td>
<td class='confluenceTd'>Alex</td>
</tr>
<tr>
<td class='confluenceTd'>Build</td>
<td class='confluenceTd'>Jane</td>
</tr>
</tbody></table>
</div>
<div class="panel" style="background-color: #deebff;border-color: #4c9aff;border-width: 1px;"><div class="panelContent" style="background-color: #deebff;">
<p>Payment provider sandbox resets every Monday.</p>
</div></div>
<p>See <a href="https://example.com/spec" class="external-link" rel="nofollow noreferrer">the spec</a> and <a href="javascript:alert(1)">bad link</a>.</p>
<script>alert(1)</script>
<p><img src="x" onerror="alert(1)"></p>
<p><span class="image-wrap" style=""><img src="${site}/secure/attachment/10001/screenshot.png" alt="screenshot"></span></p>
<p><span class="image-wrap" style=""><img src="https://evil.example/pixel.png" style="border: 0px solid black" /></span></p>
<p><span style="color:red" onclick="alert(1)">styled</span> ${userLinkHtml(site, cloud, "alex")}</p>
<hr />
<p>Tracked in <a href="${site}/browse/MOCK-1" title="Checkout redesign" class="issue-link" data-issue-key="MOCK-1">MOCK-1</a></p>`;

function userLinkHtml(site, cloud, who) {
  const u = USERS[who];
  return cloud
    ? `<a href="${site}/secure/ViewProfile.jspa?accountId=${u.accountId}" class="user-hover" rel="${u.accountId}" data-account-id="${u.accountId}" accountid="${u.accountId}">${u.displayName}</a>`
    : `<a href="${site}/secure/ViewProfile.jspa?name=${u.name}" class="user-hover" rel="${u.name}">${u.displayName}</a>`;
}

const txt = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const para = (...content) => ({ type: "paragraph", content });
const li = text => ({ type: "listItem", content: [para(txt(text))] });
const cells = (type, values) => ({ type: "tableRow", content: values.map(v => ({ type, attrs: {}, content: [para(txt(v))] })) });

function richAdf(site) {
  return {
    type: "doc", version: 1, content: [
      { type: "heading", attrs: { level: 2 }, content: [txt("Why")] },
      para(
        txt("The current payment step loses "), txt("11%", [{ type: "strong" }]), txt(" of shoppers. We want "),
        txt("fewer", [{ type: "em" }]), txt(" fields, "), txt("clear", [{ type: "underline" }]), txt(" errors and no "),
        txt("surprise", [{ type: "strike" }]), txt(" fees. Use "), txt("PaymentForm", [{ type: "code" }]), txt(" for the new layout."),
      ),
      { type: "codeBlock", attrs: { language: "javascript" }, content: [txt("const total = items.reduce((sum, i) => sum + i.price, 0);")] },
      { type: "blockquote", content: [para(txt("Customers want to pay in two taps."))] },
      { type: "bulletList", content: [li("Card number with inline validation"), li("Apple Pay / Google Pay")] },
      { type: "orderedList", attrs: { order: 1 }, content: [li("Ship behind the checkout_v2 flag"), li("Roll out to 10%")] },
      { type: "table", attrs: { isNumberColumnEnabled: false, layout: "default", localId: "4f1a6c8e-2b7d-4e8a-9c1f-0a2b3c4d5e6f" }, content: [cells("tableHeader", ["Step", "Owner"]), cells("tableCell", ["Design", "Alex"]), cells("tableCell", ["Build", "Jane"])] },
      { type: "panel", attrs: { panelType: "info" }, content: [para(txt("Payment provider sandbox resets every Monday."))] },
      para(txt("See "), txt("the spec", [{ type: "link", attrs: { href: "https://example.com/spec" } }]), txt(" and "), txt("bad link", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]), txt(".")),
      para(txt("<script>alert(1)</script>")),
      { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { id: "6e7c7f2e-0d5b-4a7e-9c55-2f0d6b1a9e01", type: "file", collection: "", width: 32, height: 20, alt: "screenshot.png" } }] },
      { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { type: "external", url: "https://evil.example/pixel.png" } }] },
      para(
        txt("styled", [{ type: "textColor", attrs: { color: "#ff5630" } }]), txt(" "),
        { type: "mention", attrs: { id: USERS.alex.accountId, text: "@Alex Morgan", accessLevel: "" } }, txt(" "),
        { type: "emoji", attrs: { shortName: ":thumbsup:", id: "1f44d", text: "\u{1F44D}" } },
        { type: "hardBreak" },
        txt("Status: "), { type: "status", attrs: { text: "IN REVIEW", color: "blue", localId: "a1b2c3d4-0000-4000-8000-000000000001", style: "" } },
        txt(" "), { type: "inlineCard", attrs: { url: "https://example.com/spec" } },
      ),
      { type: "rule" },
      para(txt("Tracked in "), { type: "inlineCard", attrs: { url: `${site}/browse/MOCK-1` } }),
    ],
  };
}

/** ADF document for plain text: one paragraph per blank-line-separated block. */
function adfFromText(text) {
  return { type: "doc", version: 1, content: String(text).split(/\n\n+/).map(block => para(txt(block))) };
}
const escapeHtml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function htmlFromText(text) {
  return String(text).split(/\n\n+/).map(block => `<p>${escapeHtml(block).replace(/\n/g, "<br/>\n")}</p>`).join("\n");
}

// Twelve comments on MOCK-10, oldest first. `html` is the renderedBody.
const MOCK10_COMMENTS = [
  { who: "alex", at: "2026-10-01 10:15:42", text: "Kick-off notes are in the spec. Card first, wallets second.", wiki: "Kick-off notes are in the spec. *Card first*, wallets second.", html: "<p>Kick-off notes are in the spec. <b>Card first</b>, wallets second.</p>" },
  { who: "jane", at: "2026-10-02 14:03:10", text: "Started on the layout using PaymentForm.", wiki: "Started on the layout using {{PaymentForm}}.", html: "<p>Started on the layout using <tt>PaymentForm</tt>.</p>" },
  { who: "sam", at: "2026-10-05 09:41:00", text: "Can we keep the old step behind a flag for a week?", html: "<p>Can we keep the old step behind a flag for a week?</p>" },
  { who: "priya", at: "2026-10-06 16:20:05", text: "Security review booked for Thursday.", html: "<p>Security review booked for Thursday.</p>" },
  { who: "alex", at: "2026-10-08 11:11:11", text: "Mobile mock-ups attached: screenshot.png", wiki: "Mobile mock-ups attached: [^screenshot.png]", html: `<p>Mobile mock-ups attached: <span class="nobr"><a href="{site}/secure/attachment/10001/screenshot.png" title="screenshot.png attached to MOCK-10">screenshot.png</a></span></p>` },
  { who: "jane", at: "2026-10-09 17:45:30", text: "Inline validation works for Visa and Mastercard; Amex pending.", html: "<p>Inline validation works for Visa and Mastercard; Amex pending.</p>" },
  { who: "sam", at: "2026-10-12 10:02:44", text: "Found a bug: the CVV hint overlaps the field on small screens.", html: "<p>Found a bug: the CVV hint overlaps the field on small screens.</p>" },
  { who: "priya", at: "2026-10-13 13:37:00", text: "Paste this into the console: <script>alert(document.cookie)</script>", wiki: "Paste this into the console:\n<script>alert(document.cookie)</script>", html: "<p>Paste this into the console:</p>\n<script>alert(document.cookie)</script>\n<p><a href=\"javascript:alert(2)\">click me</a></p>" },
  { who: "alex", at: "2026-10-14 09:12:33", text: "@Jane Doe can you check the copy?", wiki: "[~jdoe] can you check the copy?", mention: "jane", html: "{mention:jane} can you check the copy?" },
  { who: "jane", at: "2026-10-15 15:58:19", text: "Copy updated, see MOCK-12.", html: `<p>Copy updated, see <a href="{site}/browse/MOCK-12" title="Update payment step copy" class="issue-link" data-issue-key="MOCK-12"><del>MOCK-12</del></a>.</p>` },
  { who: "sam", at: "2026-10-17 08:30:00", text: "Looks good on staging (https://staging.example.com/checkout).", html: `<p>Looks good on staging (<a href="https://staging.example.com/checkout" class="external-link" rel="nofollow noreferrer">https://staging.example.com/checkout</a>).</p>` },
  { who: "jane", at: "2026-10-18 16:40:02", edited: "2026-10-18 17:05:51", text: "Remaining: Amex and the error states. About 1d left.", html: "<p>Remaining: Amex and the error states. About 1d left.</p>" },
];

// ---------------------------------------------------------------------------
// The issues, in global RANK order
// ---------------------------------------------------------------------------

function buildRawIssues() {
  const out = [];
  const add = (key, o) => out.push({ key, labels: [], components: [], fixVersions: [], sprints: [], comments: [], attachments: [], flagged: false, ...o });

  // Epics (no sprint; Agile excludes them from scrum boards' issue lists)
  add("MOCK-1", { type: "Epic", summary: "Checkout redesign", status: "In Progress", priority: "Medium", assignee: "priya", reporter: "priya", created: at("2026-08-18 10:00:00"), updated: at("2026-10-16 12:30:00"), progressAt: at("2026-09-01 09:00:00"), epicColor: 4, epicName: "Checkout redesign", text: "Everything that goes into the new checkout: payment step, wallets, saved cards." });
  add("MOCK-2", { type: "Epic", summary: "Search", status: "To Do", priority: "Medium", assignee: null, reporter: "alex", created: at("2026-08-20 11:20:00"), updated: at("2026-10-02 09:10:00"), epicColor: 9, epicName: "Search", text: "Typeahead, filters and the empty-state work for product search." });

  // Active sprint 13 (MOCK-10 was carried over from sprint 12)
  add("MOCK-10", {
    type: "Story", summary: "Redesign the checkout payment step", status: "In Progress", priority: "High", assignee: "jane", reporter: "priya",
    created: at("2026-09-30 10:04:11"), updated: at("2026-10-18 17:05:51"), progressAt: at("2026-10-01 09:30:00"),
    epic: "MOCK-1", fixVersions: ["2.4.0"], labels: ["checkout"], components: ["Web", "Payments"], sprints: [12, 13], flagged: true,
    est: { orig: "2d", rem: "1d", spent: "1d" }, rich: true, environment: "Chrome 130 / iOS 18 Safari",
    comments: MOCK10_COMMENTS,
    attachments: [
      { id: "10001", filename: "screenshot.png", mimeType: "image/png", size: 2048, who: "alex", at: "2026-10-08 11:10:02", thumb: true },
      { id: "10002", filename: "notes.txt", mimeType: "text/plain", size: 512, who: "jane", at: "2026-10-09 17:40:00" },
      { id: "10003", filename: "design.pdf", mimeType: "application/pdf", size: 1_258_291, who: "alex", at: "2026-10-10 12:00:00" },
    ],
  });
  add("MOCK-11", { type: "Sub-task", parent: "MOCK-10", summary: "Validate the card number inline", status: "To Do", priority: "Medium", assignee: "jane", reporter: "jane", created: at("2026-10-01 09:40:00"), updated: at("2026-10-14 10:00:00"), est: { orig: "2h", rem: "2h" }, text: "Luhn check plus brand detection while typing." });
  add("MOCK-12", { type: "Sub-task", parent: "MOCK-10", summary: "Update payment step copy", status: "Done", priority: "Low", assignee: "alex", reporter: "jane", created: at("2026-10-01 09:42:00"), updated: at("2026-10-15 15:50:00"), resolved: at("2026-10-15 15:50:00"), est: { orig: "1h", rem: "0m", spent: "1h" }, text: "New labels and error strings, reviewed by content design." });
  add("MOCK-20", { type: "Story", summary: "Typeahead suggestions in search", status: "To Do", priority: "Medium", assignee: "alex", reporter: "priya", created: at("2026-10-07 13:00:00"), updated: at("2026-10-16 11:00:00"), epic: "MOCK-2", labels: ["search"], components: ["Web"], sprints: [13], est: { orig: "1d", rem: "1d" }, text: "Show up to 8 suggestions after two characters.", comments: [
    { who: "sam", at: "2026-10-15 10:00:00", text: "Debounce at 150 ms please, the API is slow.", html: "<p>Debounce at 150 ms please, the API is slow.</p>" },
    { who: "alex", at: "2026-10-16 11:00:00", text: "Agreed. Jane is building the API part (MOCK-21).", html: `<p>Agreed. Jane is building the API part (<a href="{site}/browse/MOCK-21" class="issue-link" data-issue-key="MOCK-21">MOCK-21</a>).</p>` },
  ] });
  add("MOCK-21", { type: "Sub-task", parent: "MOCK-20", summary: "Suggestions endpoint", status: "In Progress", priority: "Medium", assignee: "jane", reporter: "alex", created: at("2026-10-13 10:30:00"), updated: at("2026-10-17 14:22:10"), progressAt: at("2026-10-14 09:00:00"), est: { orig: "3h", rem: "3h" }, components: ["API"], text: "GET /api/search/suggest?q= with a 50 ms budget." });
  add("MOCK-22", { type: "Sub-task", parent: "MOCK-20", summary: "Keyboard navigation for suggestions", status: "To Do", priority: "Medium", assignee: "sam", reporter: "alex", created: at("2026-10-13 10:32:00"), updated: at("2026-10-13 10:32:00") });
  add("MOCK-30", { type: "Bug", summary: "Order total rounds incorrectly for JPY", status: "Done", priority: "Highest", assignee: "jane", reporter: "sam", created: at("2026-10-12 08:15:00"), updated: at("2026-10-16 18:00:00"), resolved: at("2026-10-16 17:45:12"), progressAt: at("2026-10-13 09:30:00"), sprints: [13], fixVersions: ["2.4.0"], labels: ["money"], components: ["Payments"], est: { orig: "5h", rem: "0m", spent: "5h" }, text: "Totals in JPY show two decimals and round half-down.", comments: [
    { who: "jane", at: "2026-10-16 17:44:00", text: "Fixed by using the currency's minor units from Intl.NumberFormat.", html: "<p>Fixed by using the currency's minor units from <tt>Intl.NumberFormat</tt>.</p>" },
  ] });
  add("MOCK-31", { type: "Task", summary: "Rotate payment provider API keys", status: "In Progress", priority: "Low", assignee: "priya", reporter: "priya", created: at("2026-10-12 12:00:00"), updated: at("2026-10-15 09:00:00"), progressAt: at("2026-10-15 09:00:00"), sprints: [13], components: ["Infra"], est: { orig: "30m", rem: "30m" }, text: "Quarterly rotation; update the vault and both environments." });
  add("MOCK-32", { type: "Bug", summary: "Search page crashes on an empty query", status: "To Do", priority: "High", assignee: null, reporter: "sam", created: at("2026-10-14 16:45:00"), updated: at("2026-10-14 16:45:00"), sprints: [13], components: ["Web"], text: "Pressing Enter in an empty search box throws in the results reducer." });
  add("MOCK-33", { type: "Task", summary: "Audit checkout form labels for screen readers", status: "To Do", priority: "Medium", assignee: "jane", reporter: "priya", created: at("2026-10-13 11:00:00"), updated: at("2026-10-17 10:10:10"), sprints: [13], labels: ["frontend", "a11y"], components: ["Web"], due: at("2026-10-23 00:00:00"), text: "Every input needs a programmatic label; check with VoiceOver and NVDA." });
  add("MOCK-34", { type: "Story", summary: "Saved addresses list", status: "Done", priority: "Medium", assignee: "sam", reporter: "priya", created: at("2026-10-05 10:00:00"), updated: at("2026-10-17 12:00:00"), resolved: at("2026-10-17 11:58:00"), progressAt: at("2026-10-13 10:00:00"), sprints: [13], epic: "MOCK-1", fixVersions: ["2.4.0"], est: { orig: "2d 30m", rem: "0m", spent: "2d" }, text: "Let returning shoppers pick a saved address." });

  // Future sprints 14 and 15
  add("MOCK-40", { type: "Story", summary: "Wallet buttons (Apple Pay, Google Pay)", status: "To Do", priority: "High", assignee: "jane", reporter: "priya", created: at("2026-10-08 15:10:00"), updated: at("2026-10-12 09:00:00"), sprints: [14], epic: "MOCK-1", est: { orig: "3d", rem: "3d" }, text: "Behind the same flag as the payment step." });
  add("MOCK-41", { type: "Task", summary: "Load-test the payment step", status: "To Do", priority: "Medium", assignee: "alex", reporter: "priya", created: at("2026-10-08 15:12:00"), updated: at("2026-10-08 15:12:00"), sprints: [14], est: { orig: "1d", rem: "1d" }, text: "k6 against staging at 3x Black Friday peak." });
  add("MOCK-42", { type: "Bug", summary: "Coupon field accepts expired codes", status: "To Do", priority: "High", assignee: "jane", reporter: "sam", created: at("2026-10-09 10:00:00"), updated: at("2026-10-11 10:00:00"), sprints: [14], components: ["Payments"], est: { orig: "4h", rem: "4h" }, text: "Expiry is compared in UTC but stored in local time." });
  add("MOCK-43", { type: "Story", summary: "Saved cards", status: "To Do", priority: "Medium", assignee: "sam", reporter: "priya", created: at("2026-10-08 15:20:00"), updated: at("2026-10-08 15:20:00"), sprints: [15], epic: "MOCK-1", est: { orig: "2d", rem: "2d" }, text: "Tokenised cards from the payment provider vault." });

  // Backlog MOCK-50..MOCK-75 (26 issues, 9 of them mine)
  const BACKLOG = [
    "Remember the last payment method", "Explain declined cards in plain words", "Search result count is off by one", "Store locator map lazy-loads",
    "Improve product image zoom", "Add gift wrap option", "Stock badge flickers on PDP", "Recently viewed products rail",
    "Split the order confirmation email", "Faster category pages", "Typo in the returns policy page", "Track search no-result queries",
    "Postcode lookup for UK", "Delivery slot picker", "Newsletter opt-in at checkout", "Product comparison table",
    "Sort by newest", "Accessible colour swatches", "Cache basket totals", "Wishlist sharing",
    "Prefetch next search page", "Retry failed webhooks", "Show VAT breakdown", "Hide sold-out variants",
    "Gift card balance check", "Archive old promotions",
  ];
  const others = ["alex", "sam", "priya", null];
  const types = ["Story", "Task", "Bug", "Story"];
  const prios = ["Medium", "Low", "High", "Medium", "Lowest", "Highest"];
  const ests = ["1d", "4h", null, "2d"];
  BACKLOG.forEach((summary, i) => {
    const n = 50 + i;
    const created = at("2026-08-03 10:00:00") + i * 2 * DAY + (i % 5) * HOUR;
    const updated = Math.max(created, MOCK_NOW - (i % 20) * DAY - (3 + (i % 7)) * HOUR);
    const est = ests[i % 4];
    add(`MOCK-${n}`, {
      type: types[i % 4], summary, status: i === 6 || i === 18 ? "In Progress" : "To Do", priority: prios[i % 6],
      assignee: i % 3 === 0 ? "jane" : others[i % 4], reporter: ["priya", "sam", "alex"][i % 3],
      created, updated, progressAt: updated - DAY,
      epic: i % 3 === 0 ? "MOCK-1" : i % 3 === 1 ? "MOCK-2" : null,
      labels: i % 5 === 0 ? ["frontend"] : [], components: i % 4 === 1 ? ["API"] : [],
      est: est ? { orig: est, rem: est } : undefined,
      text: i % 6 === 5 ? undefined : `${summary}. Backlog item ${i + 1} of 26.`,
    });
  });

  // Closed sprints 1..12: 2-4 done issues each (MOCK-100..MOCK-135)
  const DONE = [
    "Basket page skeleton", "Add to basket API", "Basket badge count", "Order history list", "Order detail page", "Tax rules engine",
    "VAT for EU countries", "Guest checkout", "Email capture step", "Coupon model", "Coupon validation", "Search spike notes",
    "Refund API", "Refund email", "Address book API", "Address autocomplete", "Payment provider adapter", "Provider webhooks",
  ];
  let k = 100;
  for (const s of SPRINTS.filter(x => x.state === "closed")) {
    const count = (s.id % 3) + 2;
    for (let j = 0; j < count; j++, k++) {
      const created = s.start - 2 * DAY + j * 3 * HOUR;
      const resolved = s.start + (3 + j * 3) * DAY + 2 * HOUR;
      const est = ["4h", "1d", "2h", "3h", "6h"][k % 5];
      add(`MOCK-${k}`, {
        type: ["Story", "Task", "Bug"][k % 3], summary: `${DONE[(k - 100) % DONE.length]}${k - 100 >= DONE.length ? " (follow-up)" : ""}`,
        status: "Done", priority: ["Medium", "High", "Low", "Medium"][k % 4],
        assignee: ["jane", "alex", "sam", "priya"][k % 4], reporter: "priya",
        created, updated: resolved + HOUR, resolved, progressAt: s.start + DAY, sprints: [s.id],
        epic: k % 4 === 0 ? "MOCK-1" : null, fixVersions: s.id <= 8 ? ["2.3.0"] : [],
        est: { orig: est, rem: "0m", spent: est }, text: `Delivered in ${s.name}.`,
      });
    }
  }

  // Kanban board 2 (KAN). Rank order deliberately differs from key order.
  const kan = [
    ["KAN-2", "Bug", "Disk alert fires twice", "To Do", "High", "alex", at("2026-10-01 09:00:00"), at("2026-10-16 10:00:00")],
    ["KAN-1", "Task", "Set up staging alerts", "To Do", "Medium", "jane", at("2026-09-30 10:00:00"), at("2026-10-18 09:30:00")],
    ["KAN-3", "Story", "Self-serve log access", "To Do", "Low", null, at("2026-10-03 14:00:00"), at("2026-10-03 14:00:00")],
    ["KAN-4", "Task", "Renew TLS certificates", "To Do", "Highest", "sam", at("2026-10-06 11:00:00"), at("2026-10-15 11:00:00")],
    ["KAN-6", "Bug", "Backups skip the orders table", "In Progress", "Highest", "priya", at("2026-10-08 08:00:00"), at("2026-10-18 15:00:00")],
    ["KAN-5", "Story", "On-call handover checklist", "In Progress", "Medium", "jane", at("2026-10-07 09:30:00"), at("2026-10-17 16:00:00")],
    ["KAN-7", "Task", "Terraform the CDN", "In Review", "Medium", "alex", at("2026-10-09 10:00:00"), at("2026-10-18 11:00:00")],
    ["KAN-8", "Bug", "Grafana panel shows UTC", "Done", "Low", "jane", at("2026-10-10 10:00:00"), at("2026-10-15 12:00:00"), at("2026-10-15 11:59:00")],
    ["KAN-9", "Task", "Rotate SSH keys", "Done", "Medium", "sam", at("2026-10-02 10:00:00"), at("2026-10-10 17:00:00"), at("2026-10-10 16:58:00")],
    ["KAN-10", "Story", "Status page", "Done", "Medium", "priya", at("2026-09-25 10:00:00"), at("2026-10-07 13:00:00"), at("2026-10-07 12:55:00")],
    ["KAN-11", "Task", "Migrate cron jobs", "Done", "Low", "jane", at("2026-09-01 10:00:00"), at("2026-09-20 18:00:00"), at("2026-09-20 17:30:00")],
    ["KAN-12", "Bug", "Pager loops on ack", "Done", "High", "alex", at("2026-08-20 10:00:00"), at("2026-08-30 12:00:00"), at("2026-08-30 11:45:00")],
  ];
  for (const [key, type, summary, status, priority, assignee, created, updated, resolved] of kan) {
    const n = Number(key.split("-")[1]);
    add(key, { type, summary, status, priority, assignee, reporter: "alex", created, updated, resolved, progressAt: created + DAY, components: ["Infra"], est: n % 3 === 0 ? undefined : { orig: n % 2 ? "4h" : "1d", rem: resolved ? "0m" : n % 2 ? "4h" : "1d" }, text: n === 3 ? undefined : `${summary}.` });
  }

  // Board 3 (TWO): two ACTIVE sprints at once, story points
  const two = [
    ["TWO-1", 16, "Story", "Importer: detect delimiters", "In Progress", "High", "jane", 3],
    ["TWO-2", 16, "Task", "Importer: progress bar", "To Do", "Medium", "alex", 5],
    ["TWO-3", 16, "Bug", "Importer drops the last row", "In Review", "Highest", "sam", 2],
    ["TWO-4", 16, "Task", "Importer: sample files", "Done", "Low", "jane", 1],
    ["TWO-5", 17, "Story", "Export invoices as CSV", "To Do", "High", "priya", 8],
    ["TWO-6", 17, "Task", "Export: column picker", "To Do", "Medium", "jane", 3],
    ["TWO-7", 17, "Story", "Export: schedule monthly", "In Progress", "Medium", "alex", 5],
    ["TWO-8", 17, "Bug", "Export ignores time zone", "To Do", "Low", null, 2],
    ["TWO-9", null, "Story", "Import from Google Sheets", "To Do", "Medium", "jane", 5],
    ["TWO-10", null, "Task", "Document import limits", "To Do", "Lowest", "sam", null],
  ];
  two.forEach(([key, sprint, type, summary, status, priority, assignee, sp], i) => {
    const created = at("2026-10-09 12:00:00") + i * HOUR;
    add(key, {
      type, summary, status, priority, assignee, reporter: "sam", created, updated: at("2026-10-18 10:00:00") - i * 3 * HOUR,
      resolved: status === "Done" ? at("2026-10-16 15:00:00") : undefined, progressAt: at("2026-10-14 10:00:00"),
      sprints: sprint ? [sprint] : [], sp, text: key === "TWO-8" ? undefined : `${summary}.`,
    });
  });

  // Ids, ranks, subtasks inherit the parent's sprints, Done issues carry a resolution.
  const byKey = new Map(out.map(r => [r.key, r]));
  const idBase = { MOCK: 10000, KAN: 10200, TWO: 10300 };
  out.forEach((r, i) => {
    const [proj, num] = r.key.split("-");
    r.project = proj;
    r.num = Number(num);
    r.id = String(idBase[proj] + Number(num));
    r.rankIndex = i;
    r.rank = `0|i${(i + 1).toString(36).padStart(5, "0")}:`;
    if (r.parent) r.sprints = byKey.get(r.parent).sprints;
    if (r.status === "Done" && !r.resolved) r.resolved = r.updated;
    r.statusChanged = r.status === "Done" ? r.resolved : STATUSES[r.status].cat === "indeterminate" ? (r.progressAt ?? r.created) : r.created;
    r.creator = r.reporter;
  });
  return out;
}
export const RAW_ISSUES = buildRawIssues();

// ---------------------------------------------------------------------------
// Boards and quick filters
// ---------------------------------------------------------------------------

export const BOARDS = (() => {
  const list = [
    { id: 1, name: "MOCK board", type: "scrum", project: "MOCK", filterId: 10000, backlog: true, estimation: "time", quickFilters: [
      { id: 1, name: "Only bugs", jql: "issuetype = Bug", description: "Bugs only", position: 0 },
      { id: 2, name: "High priority", jql: "priority in (High, Highest)", description: "High and Highest", position: 1 },
      { id: 3, name: "Recently updated", jql: "updated >= -1w", description: "Touched in the last week", position: 2 },
    ] },
    { id: 2, name: "KAN board", type: "kanban", project: "KAN", filterId: 10001, backlog: false, estimation: null, quickFilters: [
      { id: 4, name: "Only My Issues", jql: "assignee = currentUser()", description: "Displays issues which are currently assigned to the current user", position: 0 },
      { id: 5, name: "Recently Updated", jql: "updatedDate >= -1d", description: "Displays issues which have been updated in the last day", position: 1 },
    ] },
    { id: 3, name: "TWO board", type: "scrum", project: "TWO", filterId: 10002, backlog: true, estimation: "points", quickFilters: [
      { id: 6, name: "Only My Issues", jql: "assignee = currentUser()", description: "Displays issues which are currently assigned to the current user", position: 0 },
      { id: 7, name: "Recently Updated", jql: "updatedDate >= -1d", description: "Displays issues which have been updated in the last day", position: 1 },
    ] },
    { id: 4, name: "Empty board", type: "scrum", project: "MOCK", filterId: 10003, backlog: true, estimation: "points", empty: true, quickFilters: [] },
  ];
  for (let n = 5; n <= 62; n++) list.push({ id: n, name: `Filler board ${n}`, type: "scrum", project: "MOCK", filterId: 10000 + n, backlog: true, estimation: "points", empty: true, quickFilters: [] });
  return list;
})();

/** Issues that belong to a board (its filter), in rank order. Epics are not on scrum boards. */
function boardIssuesOf(issues, board) {
  if (board.empty) return [];
  return issues.filter(r => r.project === board.project && !(board.type === "scrum" && r.type === "Epic"));
}

// ---------------------------------------------------------------------------
// The flavour-specific JSON shapes
// ---------------------------------------------------------------------------

/**
 * Everything that depends on the flavour and the mock's base URL.
 * `site` is the site origin (also the base URL); REST self links use it, and
 * the server rewrites them to the api origin for requests that came through it.
 */
export function buildWorld({ flavor = "server", site, hoursPerDay = 8, daysPerWeek = 5 }) {
  const cloud = flavor === "cloud";
  const v = cloud ? 3 : 2;
  const rest = `${site}/rest/api/${v}`;
  const agile = `${site}/rest/agile/1.0`;
  const hpd = hoursPerDay, dpw = daysPerWeek;
  const dur = s => parseDuration(s, hpd, dpw);
  const pretty = s => prettyDuration(s, hpd, dpw);

  // Custom field ids per flavour
  const F = cloud
    ? { sprint: "customfield_10020", flagged: "customfield_10021", rank: "customfield_10019", sp: "customfield_10016", spAlt: "customfield_10028", dev: "customfield_10000" }
    : { epicLink: "customfield_10100", sprint: "customfield_10101", flagged: "customfield_10102", epicColor: "customfield_10103", epicName: "customfield_10104", rank: "customfield_10105", sp: "customfield_10106", epicStatus: "customfield_10107" };
  const flaggedOption = { self: `${rest}/customFieldOption/${cloud ? "10019" : "10200"}`, value: "Impediment", id: cloud ? "10019" : "10200" };

  // Per-instance copies: estimates in seconds depend on this instance's
  // hours-per-day (an estimate entered as "2d" is 2 x hoursPerDay hours).
  const issues = RAW_ISSUES.map(r => ({
    ...r,
    orig: r.est?.orig != null ? dur(r.est.orig) : null,
    rem: r.est?.rem != null ? dur(r.est.rem) : null,
    spent: r.est?.spent != null ? dur(r.est.spent) : null,
  }));
  const byKey = new Map(issues.map(r => [r.key, r]));
  const byId = new Map(issues.map(r => [r.id, r]));
  const sprintById = new Map(SPRINTS.map(s => [s.id, s]));
  const childMap = new Map();
  for (const r of issues) if (r.parent) childMap.set(r.parent, [...(childMap.get(r.parent) ?? []), r]);
  const children = key => childMap.get(key) ?? [];
  const sum = (r, k) => {
    const vals = [r[k], ...children(r.key).map(c => c[k])].filter(x => x != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };

  // --- users ---------------------------------------------------------------
  const avatarUrls = who => {
    const u = USERS[who];
    const owner = cloud ? u.accountId : u.name;
    const url = size => `${site}/secure/useravatar?${size ? `size=${size}&` : ""}ownerId=${owner}&avatarId=${u.avatarId}`;
    return cloud
      ? { "16x16": url("xsmall"), "24x24": url("small"), "32x32": url("medium"), "48x48": url("") }
      : { "48x48": url(""), "24x24": url("small"), "16x16": url("xsmall"), "32x32": url("medium") };
  };
  const userJson = who => {
    if (!who) return null;
    const u = USERS[who];
    return cloud
      ? { self: `${rest}/user?accountId=${u.accountId}`, accountId: u.accountId, ...(who === ME ? { emailAddress: u.email } : {}), avatarUrls: avatarUrls(who), displayName: u.displayName, active: true, timeZone: u.timeZone, accountType: "atlassian" }
      : { self: `${rest}/user?username=${u.name}`, name: u.name, key: u.key, emailAddress: u.email, avatarUrls: avatarUrls(who), displayName: u.displayName, active: true, timeZone: u.timeZone };
  };
  const myself = () => {
    const u = USERS[ME];
    const base = cloud
      ? { self: `${rest}/user?accountId=${u.accountId}`, accountId: u.accountId, accountType: "atlassian", emailAddress: u.email, avatarUrls: avatarUrls(ME), displayName: u.displayName, active: true, timeZone: u.timeZone, locale: "en_US" }
      : { self: `${rest}/user?username=${u.name}`, key: u.key, name: u.name, emailAddress: u.email, avatarUrls: avatarUrls(ME), displayName: u.displayName, active: true, deleted: false, timeZone: u.timeZone, locale: "en_US" };
    return { ...base, groups: { size: 3, items: [] }, applicationRoles: { size: 1, items: [] }, expand: "groups,applicationRoles" };
  };
  const findUser = text => {
    const t = String(text).toLowerCase();
    return Object.keys(USERS).find(k => {
      const u = USERS[k];
      return [u.accountId, u.name, u.key, u.displayName, u.email].some(x => String(x).toLowerCase() === t);
    }) ?? null;
  };

  // --- reference objects -----------------------------------------------------
  const projectAvatars = p => {
    const url = size => `${site}/secure/projectavatar?${size ? `size=${size}&` : ""}pid=${p.id}&avatarId=${p.avatarId}`;
    return cloud
      ? { "16x16": url("xsmall"), "24x24": url("small"), "32x32": url("medium"), "48x48": url("") }
      : { "48x48": url(""), "24x24": url("small"), "16x16": url("xsmall"), "32x32": url("medium") };
  };
  const projectJson = key => {
    const p = PROJECTS[key];
    return { self: `${rest}/project/${p.id}`, id: p.id, key: p.key, name: p.name, projectTypeKey: "software", ...(cloud ? { simplified: false } : {}), avatarUrls: projectAvatars(p) };
  };
  const statusJson = name => {
    const s = STATUSES[name];
    const c = STATUS_CATEGORIES[s.cat];
    return { self: `${rest}/status/${s.id}`, description: s.description, iconUrl: `${site}/images/icons/statuses/${s.icon}`, name, id: s.id, statusCategory: { self: `${rest}/statuscategory/${c.id}`, id: c.id, key: c.key, colorName: c.colorName, name: c.name } };
  };
  const typeId = name => (cloud ? ISSUE_TYPES[name].cloudId : ISSUE_TYPES[name].serverId);
  const issueTypeJson = name => {
    const t = ISSUE_TYPES[name];
    return {
      self: `${rest}/issuetype/${typeId(name)}`, id: typeId(name), description: t.description,
      iconUrl: `${site}/secure/viewavatar?size=xsmall&avatarId=${t.avatarId}&avatarType=issuetype`,
      name, subtask: t.subtask, avatarId: t.avatarId, ...(cloud ? { hierarchyLevel: t.hierarchyLevel } : {}),
    };
  };
  const priorityJson = name => (name ? { self: `${rest}/priority/${PRIORITIES[name].id}`, iconUrl: `${site}/images/icons/priorities/${PRIORITIES[name].icon}.svg`, name, id: PRIORITIES[name].id } : null);
  const resolutionJson = () => ({ self: `${rest}/resolution/10000`, id: "10000", description: "Work has been completed on this issue.", name: "Done" });
  const componentJson = name => ({ self: `${rest}/component/${COMPONENTS[name]}`, id: COMPONENTS[name], name });
  const versionJson = name => {
    const x = VERSIONS[name];
    return { self: `${rest}/version/${x.id}`, id: x.id, description: "", name, archived: false, released: x.released, releaseDate: x.releaseDate };
  };

  // --- sprints ----------------------------------------------------------------
  const agileSprint = s => {
    const o = { id: s.id, self: `${agile}/sprint/${s.id}`, state: s.state, name: s.name };
    if (s.start != null) { o.startDate = agileDate(s.start, cloud); o.endDate = agileDate(s.end, cloud); }
    if (s.complete != null) o.completeDate = agileDate(s.complete, cloud);
    if (cloud) o.createdDate = agileDate(s.created, cloud);
    else if (s.activated != null) o.activatedDate = agileDate(s.activated, cloud);
    o.originBoardId = s.boardId;
    o.goal = s.goal;
    return o;
  };
  const sprintFieldObject = s => {
    const o = { id: s.id, name: s.name, state: s.state, boardId: s.boardId, goal: s.goal };
    if (s.start != null) { o.startDate = agileDate(s.start, true); o.endDate = agileDate(s.end, true); }
    if (s.complete != null) o.completeDate = agileDate(s.complete, true);
    return o;
  };
  // Jira Server/DC still answers the Sprint field with Sprint.toString() in REST v2.
  const sprintFieldString = s => {
    const hash = (0x5f3b7a00 + s.id * 7919).toString(16);
    const d = ms => (ms == null ? "<null>" : agileDate(ms, false));
    return `com.atlassian.greenhopper.service.sprint.Sprint@${hash}[id=${s.id},rapidViewId=${s.boardId},state=${s.state.toUpperCase()},name=${s.name},startDate=${d(s.start)},endDate=${d(s.end)},completeDate=${d(s.complete)},activatedDate=${d(s.activated)},sequence=${s.sequence},goal=${s.goal},autoStartStop=false,synced=false,incompleteIssuesDestinationId=<null>]`;
  };
  const sprintsOf = r => r.sprints.map(id => sprintById.get(id));

  // --- epics --------------------------------------------------------------------
  const epicDone = e => STATUSES[e.status].cat === "done";
  const agileEpic = e => ({ id: Number(e.id), key: e.key, self: `${agile}/epic/${e.id}`, name: e.epicName ?? e.summary, summary: e.summary, color: { key: `color_${e.epicColor}` }, done: epicDone(e) });
  const epicOf = r => (r.epic ? byKey.get(r.epic) : r.parent && byKey.get(r.parent)?.epic ? byKey.get(byKey.get(r.parent).epic) : null);

  // --- text / comments / attachments ---------------------------------------------
  const descriptionOf = r => {
    if (r.rich) return { wiki: RICH_WIKI, html: richHtml(site, cloud), adf: richAdf(site), text: RICH_WIKI };
    if (r.text == null) return null;
    return { wiki: r.text, html: htmlFromText(r.text), adf: adfFromText(r.text), text: r.text };
  };
  const commentRows = r => r.comments.map((c, i) => ({ ...c, id: String((r.rich ? 10000 : 20000 + Number(r.id) * 10) + i + 1), created: at(c.at), updatedAt: c.edited ? at(c.edited) : at(c.at) }));
  const commentHtml = c => {
    let html = c.html.replace(/\{site\}/g, site);
    if (c.mention) html = `<p>${userLinkHtml(site, cloud, c.mention)}${html.replace(/^\{mention:\w+\}/, "")}</p>`;
    return html;
  };
  const commentAdf = c => {
    if (c.mention) {
      const u = USERS[c.mention];
      return { type: "doc", version: 1, content: [para({ type: "mention", attrs: { id: u.accountId, text: `@${u.displayName}`, accessLevel: "" } }, txt(c.text.replace(`@${u.displayName}`, "")))] };
    }
    return adfFromText(c.text);
  };
  const commentJson = (r, c, { rendered = false } = {}) => ({
    self: `${rest}/issue/${r.id}/comment/${c.id}`, id: c.id, author: userJson(c.who),
    body: cloud ? commentAdf(c) : (c.wiki ?? c.text),
    ...(rendered ? { renderedBody: commentHtml(c) } : {}),
    updateAuthor: userJson(c.who), created: jiraDateTime(c.created), updated: jiraDateTime(c.updatedAt),
    ...(cloud ? { jsdPublic: true } : {}),
  });
  const attachmentJson = (a, renderedForm = false) => {
    const created = at(a.at);
    const size = renderedForm ? (a.size >= 1024 * 1024 ? `${(a.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(a.size / 102.4) / 10} kB`.replace(".0 kB", " kB")) : a.size;
    return {
      self: `${rest}/attachment/${a.id}`, id: a.id, filename: a.filename, author: userJson(a.who),
      created: renderedForm ? renderedDateTime(created) : jiraDateTime(created), size, mimeType: a.mimeType,
      content: cloud ? `${rest}/attachment/content/${a.id}` : `${site}/secure/attachment/${a.id}/${encodeURIComponent(a.filename)}`,
      ...(a.thumb ? { thumbnail: cloud ? `${rest}/attachment/thumbnail/${a.id}` : `${site}/secure/thumbnail/${a.id}/_thumb_${a.id}.png` } : {}),
    };
  };
  const attachments = issues.flatMap(r => r.attachments.map(a => ({ ...a, issue: r.key })));

  // --- issue fields ----------------------------------------------------------------
  const shortIssue = r => ({ id: r.id, key: r.key, self: `${rest}/issue/${r.id}`, fields: { summary: r.summary, status: statusJson(r.status), priority: priorityJson(r.priority), issuetype: issueTypeJson(r.type) } });
  const timetracking = r => {
    const o = {};
    if (r.orig != null) o.originalEstimate = pretty(r.orig);
    if (r.rem != null) o.remainingEstimate = pretty(r.rem);
    if (r.spent != null) o.timeSpent = pretty(r.spent);
    if (r.orig != null) o.originalEstimateSeconds = r.orig;
    if (r.rem != null) o.remainingEstimateSeconds = r.rem;
    if (r.spent != null) o.timeSpentSeconds = r.spent;
    return o;
  };
  const progress = (spent, rem) => {
    const total = (spent ?? 0) + (rem ?? 0);
    return total ? { progress: spent ?? 0, total, percent: Math.round(((spent ?? 0) * 100) / total) } : { progress: 0, total: 0 };
  };

  /** Every field of an issue, keyed by field id (fields= filtering happens later). */
  const allFields = r => {
    const desc = descriptionOf(r);
    const comments = commentRows(r);
    const epic = epicOf(r);
    const parentRaw = r.parent ? byKey.get(r.parent) : cloud && r.epic ? byKey.get(r.epic) : null;
    const sprints = sprintsOf(r);
    const aggOrig = sum(r, "orig"), aggRem = sum(r, "rem"), aggSpent = sum(r, "spent");
    const f = {
      summary: r.summary,
      issuetype: issueTypeJson(r.type),
      ...(parentRaw ? { parent: shortIssue(parentRaw) } : {}),
      project: projectJson(r.project),
      status: statusJson(r.status),
      ...(cloud ? { statuscategorychangedate: jiraDateTime(r.statusChanged) } : {}),
      priority: priorityJson(r.priority),
      resolution: r.status === "Done" ? resolutionJson() : null,
      resolutiondate: r.status === "Done" ? jiraDateTime(r.resolved) : null,
      assignee: userJson(r.assignee),
      reporter: userJson(r.reporter),
      creator: userJson(r.creator),
      labels: r.labels,
      components: r.components.map(componentJson),
      fixVersions: r.fixVersions.map(versionJson),
      versions: [],
      duedate: r.due != null ? jiraDate(r.due) : null,
      created: jiraDateTime(r.created),
      updated: jiraDateTime(r.updated),
      lastViewed: r.assignee === ME ? jiraDateTime(r.updated + HOUR) : null,
      description: desc ? (cloud ? desc.adf : desc.wiki) : null,
      environment: r.environment ? (cloud ? adfFromText(r.environment) : r.environment) : null,
      timeoriginalestimate: r.orig,
      timeestimate: r.rem,
      timespent: r.spent,
      aggregatetimeoriginalestimate: aggOrig,
      aggregatetimeestimate: aggRem,
      aggregatetimespent: aggSpent,
      timetracking: timetracking(r),
      progress: progress(r.spent, r.rem),
      aggregateprogress: progress(aggSpent, aggRem),
      workratio: r.orig ? Math.round(((r.spent ?? 0) * 100) / r.orig) : -1,
      subtasks: children(r.key).map(shortIssue),
      issuelinks: [],
      attachment: r.attachments.map(a => attachmentJson(a)),
      comment: { comments: comments.map(c => commentJson(r, c)), ...(cloud ? { self: `${rest}/issue/${r.id}/comment` } : {}), maxResults: comments.length, total: comments.length, startAt: 0 },
      worklog: { startAt: 0, maxResults: 20, total: 0, worklogs: [] },
      watches: { self: `${rest}/issue/${r.key}/watchers`, watchCount: 1, isWatching: r.assignee === ME },
      votes: { self: `${rest}/issue/${r.key}/votes`, votes: 0, hasVoted: false },
      security: null,
      [F.sprint]: sprints.length ? (cloud ? sprints.map(sprintFieldObject) : sprints.map(sprintFieldString)) : null,
      [F.flagged]: r.flagged ? [flaggedOption] : null,
      [F.rank]: r.rank,
      [F.sp]: r.sp ?? null,
    };
    if (cloud) {
      f[F.spAlt] = null;
      f[F.dev] = "{}";
    } else {
      f.thumbnail = null;
      f[F.epicLink] = epic && r.type !== "Sub-task" ? epic.key : null;
      f[F.epicName] = r.type === "Epic" ? r.epicName : null;
      f[F.epicColor] = r.type === "Epic" ? `ghx-label-${r.epicColor}` : null;
      f[F.epicStatus] = r.type === "Epic" ? { self: `${rest}/customFieldOption/${{ new: 10300, indeterminate: 10301, done: 10302 }[STATUSES[r.status].cat]}`, value: STATUS_CATEGORIES[STATUSES[r.status].cat].name, id: String({ new: 10300, indeterminate: 10301, done: 10302 }[STATUSES[r.status].cat]), disabled: false } : null;
    }
    return { fields: f, desc, comments, epic, sprints };
  };

  /** The Agile-only fields that /rest/agile/1.0 adds to each issue. */
  const agileFields = (r, sprints, epic) => {
    const open = sprints.filter(s => s.state !== "closed").sort((a, b) => (a.state === "active" ? -1 : 1) - (b.state === "active" ? -1 : 1))[0];
    const closed = sprints.filter(s => s.state === "closed");
    return {
      sprint: open ? agileSprint(open) : null,
      closedSprints: closed.length ? closed.map(agileSprint) : null,
      flagged: r.flagged,
      epic: epic ? agileEpic(epic) : null,
    };
  };

  // --- the field catalogue (/field) ---------------------------------------------------
  const sys = [
    // [id, cloud name, server name, schema type, items, clauseNames, flags o/n/s]
    ["issuekey", "Key", "Key", null, null, ["id", "issue", "issuekey", "key"], "ns"],
    ["summary", "Summary", "Summary", "string", null, ["summary"], "ons"],
    ["issuetype", "Issue Type", "Issue Type", "issuetype", null, ["issuetype", "type"], "ons"],
    ["parent", "Parent", "Parent", null, null, ["parent"], cloud ? "ons" : "ns"],
    ["project", "Project", "Project", "project", null, ["project"], "ons"],
    ["status", "Status", "Status", "status", null, ["status"], "ns"],
    ...(cloud ? [["statusCategory", "Status Category", null, null, null, ["statusCategory"], "ns"], ["statuscategorychangedate", "Status Category Changed", null, "datetime", null, ["statusCategoryChangedDate"], "ns"]] : []),
    ["priority", "Priority", "Priority", "priority", null, ["priority"], "ons"],
    ["resolution", "Resolution", "Resolution", "resolution", null, ["resolution"], "ons"],
    ["resolutiondate", "Resolved", "Resolved", "datetime", null, ["resolutiondate", "resolved"], "ns"],
    ["assignee", "Assignee", "Assignee", "user", null, ["assignee"], "ons"],
    ["reporter", "Reporter", "Reporter", "user", null, ["reporter"], "ons"],
    ["creator", "Creator", "Creator", "user", null, ["creator"], "ns"],
    ["labels", "Labels", "Labels", "array", "string", ["labels"], "ons"],
    ["components", "Components", "Component/s", "array", "component", ["component"], "ons"],
    ["fixVersions", "Fix versions", "Fix Version/s", "array", "version", ["fixVersion"], "ons"],
    ["versions", "Affects versions", "Affects Version/s", "array", "version", ["affectedVersion"], "ons"],
    ["duedate", "Due date", "Due Date", "date", null, ["due", "duedate"], "ons"],
    ["created", "Created", "Created", "datetime", null, ["created", "createdDate"], "ns"],
    ["updated", "Updated", "Updated", "datetime", null, ["updated", "updatedDate"], "ns"],
    ["lastViewed", "Last Viewed", "Last Viewed", "datetime", null, ["lastViewed"], "ns"],
    ["description", "Description", "Description", "string", null, ["description"], "ons"],
    ["environment", "Environment", "Environment", "string", null, ["environment"], "ons"],
    ["timeoriginalestimate", "Original estimate", "Original Estimate", "number", null, ["originalEstimate", "timeoriginalestimate"], "ns"],
    ["timeestimate", "Remaining Estimate", "Remaining Estimate", "number", null, ["remainingEstimate", "timeestimate"], "ns"],
    ["timespent", "Time Spent", "Time Spent", "number", null, ["timespent"], "ns"],
    ["aggregatetimeoriginalestimate", "Σ Original Estimate", "Σ Original Estimate", "number", null, [], "n"],
    ["aggregatetimeestimate", "Σ Remaining Estimate", "Σ Remaining Estimate", "number", null, [], "n"],
    ["aggregatetimespent", "Σ Time Spent", "Σ Time Spent", "number", null, [], "n"],
    ["timetracking", "Time tracking", "Time Tracking", "timetracking", null, [], "o"],
    ["progress", "Progress", "Progress", "progress", null, ["progress"], "ns"],
    ["aggregateprogress", "Σ Progress", "Σ Progress", "progress", null, [], "n"],
    ["workratio", "Work Ratio", "Work Ratio", "number", null, ["workratio"], "ns"],
    ["subtasks", "Sub-tasks", "Sub-Tasks", "array", "issuelinks", ["subtasks"], "n"],
    ["issuelinks", "Linked Issues", "Linked Issues", "array", "issuelinks", ["issueLink"], "ons"],
    ["attachment", "Attachment", "Attachment", "array", "attachment", ["attachments"], "ons"],
    ["comment", "Comment", "Comment", "comments-page", null, ["comment"], "os"],
    ["worklog", "Log Work", "Log Work", "array", "worklog", ["worklogAuthor", "worklogComment", "worklogDate"], "os"],
    ["watches", "Watchers", "Watchers", "watches", null, ["watchers"], "ns"],
    ["votes", "Votes", "Votes", "votes", null, ["votes"], "ns"],
    ["security", "Security Level", "Security Level", "securitylevel", null, ["level"], "ons"],
    ...(cloud ? [] : [["thumbnail", null, "Images", null, null, [], "n"]]),
  ];
  const customDefs = cloud
    ? [
      [F.dev, "Development", { type: "any", custom: "com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf" }, ["cf[10000]", "development"]],
      [F.sp, "Story point estimate", { type: "number", custom: "com.pyxis.greenhopper.jira:jsw-story-points" }, ["cf[10016]", "Story point estimate"]],
      [F.rank, "Rank", { type: "any", custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" }, ["cf[10019]", "Rank"]],
      [F.sprint, "Sprint", { type: "array", items: "json", custom: "com.pyxis.greenhopper.jira:gh-sprint" }, ["cf[10020]", "Sprint"]],
      [F.flagged, "Flagged", { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" }, ["cf[10021]", "Flagged", "Flagged[Checkboxes]"]],
      [F.spAlt, "Story Points", { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" }, ["cf[10028]", "Story Points", "Story Points[Number]"]],
    ]
    : [
      [F.epicLink, "Epic Link", { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" }, ["cf[10100]", "Epic Link"]],
      [F.sprint, "Sprint", { type: "array", items: "string", custom: "com.pyxis.greenhopper.jira:gh-sprint" }, ["cf[10101]", "Sprint"]],
      [F.flagged, "Flagged", { type: "array", items: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" }, ["cf[10102]", "Flagged"]],
      [F.epicColor, "Epic Color", { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-color" }, ["cf[10103]", "Epic Color"]],
      [F.epicName, "Epic Name", { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-label" }, ["cf[10104]", "Epic Name"]],
      [F.rank, "Rank", { type: "any", custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" }, ["cf[10105]", "Rank"]],
      [F.sp, "Story Points", { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" }, ["cf[10106]", "Story Points"]],
      [F.epicStatus, "Epic Status", { type: "option", custom: "com.pyxis.greenhopper.jira:gh-epic-status" }, ["cf[10107]", "Epic Status"]],
    ];
  const fieldList = [
    ...sys.map(([id, cname, sname, type, items, clauseNames, flags]) => ({
      id, ...(cloud ? { key: id } : {}), name: cloud ? cname : sname, custom: false,
      orderable: flags.includes("o"), navigable: flags.includes("n"), searchable: flags.includes("s"), clauseNames,
      ...(type ? { schema: { type, ...(items ? { items } : {}), system: id } } : {}),
    })),
    ...customDefs.map(([id, name, schema, clauseNames]) => ({
      id, ...(cloud ? { key: id } : {}), name, ...(cloud ? { untranslatedName: name } : {}), custom: true,
      orderable: true, navigable: true, searchable: true, clauseNames,
      schema: { ...schema, customId: Number(id.slice("customfield_".length)) },
    })),
  ];
  const fieldNames = Object.fromEntries(fieldList.map(f => [f.id, f.name]));
  const fieldSchemas = Object.fromEntries(fieldList.filter(f => f.schema).map(f => [f.id, f.schema]));
  const NON_NAVIGABLE = new Set(fieldList.filter(f => !f.navigable).map(f => f.id));

  // --- renderedFields ---------------------------------------------------------------
  const renderedFor = (r, ids, built) => {
    const out = {};
    for (const id of ids) out[id] = null;
    const { desc, comments } = built;
    const set = (id, value) => { if (ids.includes(id)) out[id] = value; };
    set("description", desc ? desc.html : cloud ? "" : null);
    set("environment", r.environment ? `<p>${escapeHtml(r.environment)}</p>` : "");
    set("created", renderedDateTime(r.created));
    set("updated", renderedDateTime(r.updated));
    set("resolutiondate", r.status === "Done" ? renderedDateTime(r.resolved) : null);
    set("statuscategorychangedate", renderedDateTime(r.statusChanged));
    set("lastViewed", r.assignee === ME ? renderedDateTime(r.updated + HOUR) : null);
    set("duedate", r.due != null ? renderedDate(r.due) : null);
    set("timeoriginalestimate", r.orig != null ? pretty(r.orig) : null);
    set("timeestimate", r.rem != null ? pretty(r.rem) : null);
    set("timespent", r.spent != null ? pretty(r.spent) : null);
    const ao = sum(r, "orig"), ar = sum(r, "rem"), as = sum(r, "spent");
    set("aggregatetimeoriginalestimate", ao != null ? pretty(ao) : null);
    set("aggregatetimeestimate", ar != null ? pretty(ar) : null);
    set("aggregatetimespent", as != null ? pretty(as) : null);
    set("timetracking", timetracking(r));
    set("attachment", r.attachments.map(a => attachmentJson(a, true)));
    set("comment", { comments: comments.map(c => ({ ...commentJson(r, c), body: commentHtml(c), created: renderedDateTime(c.created), updated: renderedDateTime(c.updatedAt) })), maxResults: comments.length, total: comments.length, startAt: 0 });
    set("worklog", { startAt: 0, maxResults: 20, total: 0, worklogs: [] });
    return out;
  };

  const ISSUE_EXPAND = "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations";
  const AGILE_FIELDS = ["sprint", "closedSprints", "flagged", "epic"];

  /**
   * Resolve a fields= request to a set of field ids. `def` is the endpoint's
   * default: "all" (GET issue), "navigable" (Server search), "id" (Cloud
   * search/jql), "agile" (navigable + Agile fields).
   */
  const resolveFields = (tokens, def) => {
    const toks = (tokens ?? []).flatMap(t => String(t).split(",")).map(s => s.trim()).filter(Boolean);
    const all = fieldList.map(f => f.id).filter(id => id !== "issuekey" && id !== "statusCategory");
    const navigable = all.filter(id => !NON_NAVIGABLE.has(id));
    const agileExtra = def === "agile" ? AGILE_FIELDS : [];
    const known = new Set([...all, ...AGILE_FIELDS]);
    const set = new Set();
    let positive = false;
    let wildcard = false;
    for (const t of toks) {
      if (t === "*all") { positive = wildcard = true; [...all, ...agileExtra].forEach(x => set.add(x)); }
      else if (t === "*navigable") { positive = wildcard = true; [...navigable, ...agileExtra].forEach(x => set.add(x)); }
      else if (t.startsWith("-")) continue;
      else { positive = true; if (known.has(t) || t === "id" || t === "key") set.add(t); }
    }
    if (!positive) {
      wildcard = true;
      const base = def === "all" ? all : def === "navigable" ? navigable : def === "agile" ? [...navigable, ...AGILE_FIELDS] : ["id"];
      base.forEach(x => set.add(x));
    }
    for (const t of toks) if (t.startsWith("-")) set.delete(t.slice(1));
    // Agile leaves out an empty sprint / closedSprints / epic unless it was asked for by name.
    set.omitEmptyAgile = wildcard;
    return set;
  };

  /** One issue as REST (or Agile, with agile: true) returns it. */
  const issueJson = (r, { fields: sel, expand = new Set(), agile: isAgile = false, self } = {}) => {
    const realIds = [...sel].filter(id => id !== "id" && id !== "key");
    if (!realIds.length && !sel.has("key")) return { id: r.id };
    const built = allFields(r);
    const extra = agileFields(r, built.sprints, built.epic);
    const fields = {};
    for (const id of realIds) {
      if (AGILE_FIELDS.includes(id)) {
        const value = extra[id];
        if (value == null && sel.omitEmptyAgile && id !== "flagged") continue;
        fields[id] = value;
      } else if (id in built.fields) fields[id] = built.fields[id];
      else if (id === "parent") continue;
      else if (fieldNames[id]) fields[id] = null;
    }
    const out = { expand: ISSUE_EXPAND, id: r.id, self: self ?? `${rest}/issue/${r.id}`, key: r.key, fields };
    if (expand.has("renderedFields")) out.renderedFields = renderedFor(r, Object.keys(fields), built);
    if (expand.has("names")) out.names = Object.fromEntries(Object.keys(fields).filter(id => fieldNames[id]).map(id => [id, fieldNames[id]]));
    if (expand.has("schema")) out.schema = Object.fromEntries(Object.keys(fields).filter(id => fieldSchemas[id]).map(id => [id, fieldSchemas[id]]));
    if (expand.has("versionedRepresentations")) {
      out.versionedRepresentations = Object.fromEntries(Object.entries(fields).map(([id, val]) => {
        if (id === F.sprint && val) return [id, { 1: val, 2: built.sprints.map(sprintFieldObject) }];
        return [id, { 1: val }];
      }));
      delete out.fields;
    }
    if (expand.has("changelog")) out.changelog = { startAt: 0, maxResults: 0, total: 0, histories: [] };
    return out;
  };

  // --- boards ---------------------------------------------------------------------
  const boardLocation = b => {
    const p = PROJECTS[b.project];
    return { projectId: Number(p.id), displayName: `${p.name} (${p.key})`, projectName: p.name, projectKey: p.key, projectTypeKey: "software", avatarURI: `${site}/secure/projectavatar?size=small&pid=${p.id}&avatarId=${p.avatarId}`, name: `${p.name} (${p.key})` };
  };
  const boardJson = b => ({ id: b.id, self: `${agile}/board/${b.id}`, name: b.name, type: b.type, location: boardLocation(b), ...(cloud ? { isPrivate: false } : {}) });
  const statusRef = name => ({ id: STATUSES[name].id, self: `${rest}/status/${STATUSES[name].id}` });
  const boardConfig = b => {
    const p = PROJECTS[b.project];
    const columns = b.type === "kanban"
      ? [
        { name: "Backlog", statuses: [] },
        { name: "To Do", statuses: [statusRef("To Do")] },
        { name: "In Progress", statuses: [statusRef("In Progress")], max: 3 },
        { name: "In Review", statuses: [statusRef("In Review")], max: 2 },
        { name: "Done", statuses: [statusRef("Done")] },
      ]
      : [
        { name: "To Do", statuses: [statusRef("To Do")] },
        { name: "In Progress", statuses: [statusRef("In Progress"), statusRef("In Review")] },
        { name: "Done", statuses: [statusRef("Done")] },
      ];
    const estimation = b.estimation === "time"
      ? { type: "field", field: { fieldId: "timeoriginalestimate", displayName: "Original Time Estimate" } }
      : b.estimation === "points" ? { type: "field", field: { fieldId: F.sp, displayName: cloud ? "Story point estimate" : "Story Points" } } : null;
    return {
      id: b.id, name: b.name, ...(cloud ? { type: b.type } : {}), self: `${agile}/board/${b.id}/configuration`,
      ...(cloud ? { location: { type: "project", key: p.key, id: p.id, self: `${rest}/project/${p.id}`, name: p.name } } : {}),
      filter: { id: String(b.filterId), self: `${rest}/filter/${b.filterId}` },
      ...(b.type === "kanban" ? { subQuery: { query: "fixVersion in unreleasedVersions() OR fixVersion is EMPTY" } } : {}),
      columnConfig: { columns, constraintType: b.type === "kanban" ? "issueCount" : "none" },
      ...(estimation ? { estimation } : {}),
      ranking: { rankCustomFieldId: Number(F.rank.slice("customfield_".length)) },
    };
  };
  const boardFeatures = b => {
    const feature = (boardFeature, featureId, state, name, description, extra = {}) => ({
      boardFeature, boardId: b.id, state, localisedName: name, localisedDescription: description,
      learnMoreLink: "https://support.atlassian.com/jira-software-cloud/docs/", imageUri: `${site}/images/agility/${featureId}.svg`,
      featureType: extra.featureType ?? "BASIC", featureId, toggleLocked: extra.toggleLocked ?? false,
      ...(extra.permissibleEstimationTypes ? { permissibleEstimationTypes: extra.permissibleEstimationTypes } : {}),
    });
    const scrum = b.type === "scrum";
    return {
      features: [
        feature("BACKLOG", "jsw.agility.backlog", b.backlog ? "ENABLED" : "DISABLED", "Backlog", "Plan and prioritize work in a dedicated space.", { toggleLocked: scrum }),
        feature("SPRINTS", "jsw.agility.sprints", scrum ? "ENABLED" : "DISABLED", "Sprints", "Work in short, time-boxed iterations.", { toggleLocked: !scrum }),
        feature("ESTIMATION", "jsw.agility.estimation", scrum ? "ENABLED" : "DISABLED", "Estimation", "Estimate work with story points or time.", { featureType: "ESTIMATION", permissibleEstimationTypes: [{ value: "STORY_POINTS", localisedName: "Story points", localisedDescription: "Estimate with points" }, { value: "ORIGINAL_ESTIMATE", localisedName: "Time", localisedDescription: "Estimate with hours and days" }] }),
        feature("REPORTS", "jsw.agility.reports", "ENABLED", "Reports", "Track progress with burndown and velocity charts."),
        feature("RELEASES", "jsw.agility.releases", "ENABLED", "Releases", "Track versions."),
      ],
    };
  };
  const editModel = b => ({
    id: b.id, name: b.name, canEdit: true, sprintSupportEnabled: b.type === "scrum", isKanPlanEnabled: false,
    quickFilterConfig: { rapidViewId: b.id, canEdit: true, quickFilters: b.quickFilters.map(q => ({ id: q.id, name: q.name, query: q.jql, description: q.description, isJqlValid: true })) },
  });

  return {
    flavor, cloud, v, site, rest, agile, F, hoursPerDay: hpd, daysPerWeek: dpw,
    issues, byKey, byId, sprintById, attachments, boardIssues: b => boardIssuesOf(issues, b),
    userJson, myself, findUser, issueJson, resolveFields, commentRows, commentJson, attachmentJson,
    agileSprint, agileEpic, boardJson, boardConfig, boardFeatures, editModel, projectJson,
    fieldList, fieldNames, fieldSchemas, epicOf, children, descriptionOf,
  };
}
