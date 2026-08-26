// agent-dag server: HTTP ingest + SSE broadcast + static file serving.
// Single-file pure Node HTTP server, zero deps.
// `request` is the client half, and it has exactly one caller: challengeDeck,
// which asks another deck's port to prove it is the deck its discovery record
// describes. Nothing else in this file talks to anything but 127.0.0.1 clients.
import { createServer, request as httpRequest } from "node:http";
import { readFile, stat, mkdir, open, truncate, readdir, unlink } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync, realpath as realpathCb, realpathSync } from "node:fs";
import { extname, join, resolve, sep, dirname as pdirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { claudeConfigDir } from "./claude-dir.mjs";
import { CODEX_HOME, CODEX_SESSIONS_DIR, STOP, walkRolloutDays } from "./codex-dir.mjs";
import { PRODUCT } from "./brand.mjs";
import { invokedName, renameNotice } from "./invoked-as.mjs";
import { appendLogLine, codexCwdInWorkspace, electWriters, foldsCase, writesCodexLog } from "./log-writer.mjs";
import { readProcesses, startSystemMetrics, systemSnapshot } from "./system-metrics.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..", "..");
const WEB_DIST = resolve(PKG_ROOT, "dist", "web");

// Read at import — i.e. at boot, before an upgrade can overwrite these files.
// Reading it later would report whatever npm has since installed and hide the
// exact drift /api/version exists to expose. See src/server/self-update.mjs.
const RUNNING_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"))?.version ?? null; }
  catch { return null; }
})();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".woff2": "font/woff2",
  ".map":  "application/json",
};

// ─── The event ring buffer, and the two bounds it keeps ───────────────────
// MAX_BUFFER is how many events a late SSE subscriber can be replayed.
// MAX_BUFFER_CHARS is how much they are allowed to weigh, and until #625 there
// was no such thing — which is the whole defect, because a count is not a bound
// on memory when the thing being counted has no size of its own. `POST
// /api/event` admits a body of 5,000,000 characters and nothing between that
// door and this array shrinks it: hook/hook.js forwards the payload whole, and
// log-writer.mjs already says in as many words that a PostToolUse carrying a
// large Read or Bash response is routinely a good fraction of that. So the real
// ceiling was MAX_BUFFER multiplied by the largest event ingest accepts.
//
// Measured on Node 22.14 / macOS, posting 4,900,000-character bodies to a real
// server on loopback and reading process.memoryUsage() after a forced GC:
//
//   after  20 events: heapUsed  107MB rss  292MB   per-event 4.94MB
//   after 100 events: heapUsed  481MB rss  739MB   per-event 4.73MB
//   after 200 events: heapUsed  947MB rss 1231MB   per-event 4.69MB
//
// 4.69 MB retained per buffered event, flat as the ring fills. A full ring of
// 2000 of those is 9.4 GB against the 4144 MB heap limit V8 picks on a 32 GB
// machine, so the count cap was not reachable on any developer machine — and
// what happened instead of reaching it was not degradation. The same harness
// under `--max-old-space-size=2048`, roughly the heap an 8 GB laptop gives
// itself:
//
//   after 420 events: heapUsed 1975MB rss 2247MB
//   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
//
// 429 events in, 1571 short of the cap. That abort is not catchable, so the SSE
// stream, the hook ingest and the log all stop together — and `/api/event` is a
// deliberate OPEN_MUTATION, so about 430 posts from a local process holding no
// credential at all end the deck. The comment at OPEN_MUTATIONS says the worst
// a caller does with that route is draw a session that is not there; this is
// the sentence that made it false.
//
// Both bounds are now enforced on every push, evicting oldest-first until each
// holds. See the eviction in pushEvent for why it is one splice and why the
// newest event is never the one evicted.
export const MAX_BUFFER = 2000;     // recent events kept for late SSE subscribers

// The byte budget, counted in CHARACTERS — the unit this file already measures
// payloads in, and the unit MAX_CLIENT_BUFFER_BYTES is really written in
// despite its name (there is a long note there about why, which applies here
// unchanged: a character is one byte of heap while the string stays one-byte
// and two once it does not).
//
// 128 MiB, and the three readings that pick it:
//
//   - It is 26 times the largest single event ingest can admit (5,000,000
//     characters plus this deck's envelope), so a burst of maximum-size tool
//     responses — eight subagents each returning a big Read — is held whole
//     rather than collapsing the ring to nothing.
//   - It is thirteen times a completely FULL 2000-event ring of ordinary
//     traffic. The mean serialized event is about 5 KB, measured over 4.7k real
//     payloads in a 21 MB events.jsonl (the same sample redactDeckToken's note
//     quotes), so 2000 of them are 10 MB. Ordinary traffic therefore never
//     meets this bound at all and keeps the full count-based replay depth; only
//     the traffic that used to kill the process ever sees it.
//   - Its worst case is a bounded fraction of the heap rather than a multiple
//     of it. 128 MiB of charged characters is at most about 320 MiB of retained
//     heap — the charge below tracks real retention within 2.5x across every
//     payload shape measured — which is 16% of the 2 GB heap an 8 GB laptop
//     picks, against the 9.4 GB the count alone permitted.
//
// Exported for the same reason MAX_CLIENT_BUFFER_BYTES is: a bound whose only
// observable failure is the process running out of memory is a bound no test
// can assert. See event-ring-byte-cap.test.ts, which pins all three readings.
export const MAX_BUFFER_CHARS = 128 * 1024 * 1024;

// What one envelope costs on top of its payload — seq, epoch, receivedAt,
// source and the JSON around them. Measured at 127 characters, the same figure
// MAX_CLIENT_BUFFER_BYTES is sized against; 128 here so that an event with an
// empty payload still costs something and a flood of them cannot be free.
const ENVELOPE_CHARS = 128;

const events = [];                  // ring buffer
// The running sum of what `events` holds, in the units payloadChars charges.
// Kept beside the array rather than recomputed, because the alternative is
// walking every buffered payload on every push. It and `events` have to move
// together and nothing outside this section may touch either — see
// clearEventBuffer for the one place that empties both, and what went wrong the
// day only one of them was emptied.
let bufferedChars = 0;

/**
 * What this payload will cost the ring, charged in characters.
 *
 * Not `JSON.stringify(raw).length`, which is the obvious answer and is wrong
 * here twice over. It allocates a full copy of a payload that can be five
 * megabytes, on the hottest path in the process; and it would defeat the
 * deliberate optimization in pushEvent that skips serializing ENTIRELY when
 * nothing is subscribed and nothing is being logged — a headless deck, and the
 * boot replay of a log that only rotates at 50 MB. That optimization is pinned
 * by sse-serialize-once.test.ts, so serializing here would fail the suite as
 * well as the machine.
 *
 * So it is a walk, allocating nothing, in the same iterative shape and for the
 * same stack-overflow reason as redactDeckToken below: a body from JSON.parse
 * is free to nest as deeply as it likes and a recursive scan would be a new way
 * to blow the stack inside the request listener, where nothing catches it.
 *
 * WHAT IT CHARGES, and why it is not just the string lengths. Measured on
 * Node 22.14 by parsing twenty copies of a 4.9M-character body of each shape
 * and reading heapUsed after a forced GC — retained per copy, against what
 * string characters alone would have charged:
 *
 *   one long string             4.67MB retained   4.67M charged   1.0x
 *   array of 8-char strings     3.91MB retained   3.40M charged   1.2x
 *   array of small numbers      4.67MB retained   0.00M charged   ∞
 *   array of tiny objects      10.20MB retained   0.85M charged  12.0x
 *   object of distinct keys    12.38MB retained   2.86M charged   4.3x
 *
 * A payload of numbers is INVISIBLE to a string-length charge while retaining
 * 4.67 MB, and an array of small objects is under-charged twelvefold — so a
 * ring bounded that way would have been the same OOM behind a different
 * payload shape. Adding 8 characters per value (V8 spends a tagged slot on
 * each, and small objects and packed arrays measured at 8–46 bytes an entry)
 * and the length of every key brings the same five shapes to 1.0x, 0.6x, 1.0x,
 * 1.7x and 2.5x — i.e. never blind, and never more than 2.5x under the truth.
 * That 2.5x is what MAX_BUFFER_CHARS is sized against. The one direction it
 * over-charges is arrays of short strings, which shortens replay depth and
 * never the other way.
 *
 * Two-byte strings cost twice what they are charged, exactly as they do for
 * MAX_CLIENT_BUFFER_BYTES: a 4.8M-character CJK payload retains 9.35 MB and is
 * charged 4.67M. Folded into the same 2.5x.
 *
 * Cost, measured against the JSON.parse the same event already pays for:
 * 0.21 µs for a realistic 5 KB hook payload, 0.04 µs for a 4.9M-character
 * single string (it is one node), and 22.6 ms for the pathological 222k-tiny-
 * object body — against 96.4 ms to JSON.parse that same body. So the walk is a
 * fifth of a parse the ingest path is paying anyway, and cheaper than
 * redactDeckToken's walk, which does substring searches this one does not.
 *
 * Exported so the charge itself can be asserted rather than inferred from the
 * ring's behaviour.
 */
export function payloadChars(raw) {
  if (typeof raw === "string") return raw.length;
  // A top-level primitive is a legal body for `POST /api/event`, same as it is
  // for redactDeckToken. One slot's worth.
  if (raw === null || typeof raw !== "object") return 8;

  let n = 0;
  const stack = [raw];
  while (stack.length > 0) {
    const node = stack.pop();
    // Arrays and objects walked separately for the reason redactDeckToken gives:
    // an indexed loop is markedly cheaper than `for…in`, and a single
    // PostToolUse response can be an array of thousands.
    if (Array.isArray(node)) {
      n += 8 * node.length;
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string") n += v.length;
        else if (v !== null && typeof v === "object") stack.push(v);
      }
    } else {
      for (const k in node) {
        const v = node[k];
        n += 8 + k.length;
        if (typeof v === "string") n += v.length;
        else if (v !== null && typeof v === "object") stack.push(v);
      }
    }
  }
  return n;
}

// Where the charge rides. A Symbol key rather than an ordinary field, because
// the envelope is JSON.stringify'd on the hot path into both the SSE frame and
// the events.jsonl line, and JSON.stringify ignores symbol-keyed properties
// entirely. So the number stays welded to the envelope it describes — which is
// what makes it impossible for `bufferedChars` and `events` to drift apart —
// without reaching the wire, the log, the client's HookEnvelope type, or the
// 127-character envelope measurement MAX_CLIENT_BUFFER_BYTES is sized against.
const CHARS = Symbol("ring charge");

/**
 * Empty the ring and the total measuring it, together.
 *
 * `/api/clear` used to be a bare `events.length = 0`, and with a running total
 * beside the array that is a permanent debt: the total would still name events
 * the array no longer holds, and every push after the first clear would evict
 * against a budget already spent — a deck that answers one clear and then keeps
 * a ring of one event for the rest of its life. The two variables move here and
 * nowhere else.
 */
function clearEventBuffer() {
  events.length = 0;
  bufferedChars = 0;
}

/**
 * What the ring holds right now — its length, what it is charged, and the seq
 * range it spans.
 *
 * Exported alongside MAX_BUFFER and MAX_BUFFER_CHARS so a test can watch the
 * bound hold through a real server instead of watching a process die, which is
 * the only other way this bound is observable. The seq range is here for the
 * property eviction has to keep and nothing else checks: what leaves is always a
 * PREFIX, so `newest - oldest + 1` equals the count. An eviction that ever took
 * from the middle would leave a hole no resuming client could ask for again,
 * and that is exactly what `GET /api/events` and the replay loop would then
 * hand out without noticing.
 */
export function eventBufferStats() {
  return {
    events: events.length,
    chars: bufferedChars,
    oldestSeq: events.length > 0 ? events[0].seq : 0,
    newestSeq: events.length > 0 ? events[events.length - 1].seq : 0,
  };
}

let nextSeq = 1;
// Identity of *this* process's seq numbering. nextSeq restarts at 1 on every
// boot and is re-derived by replaying events.jsonl, so it is monotonic only
// within one process: rotation (50MB) or /api/clear shortens that log and the
// next boot starts numbering well below what an already-open tab saw. Stamped
// on every envelope so a client can tell "counter restarted" apart from "old
// duplicate" instead of silently dropping the live stream.
const SEQ_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const sseClients = new Set();       // res handles

let persistPath = null;             // absolute path to events.jsonl, or null

// ─── Which deck records which session ─────────────────────────────────────
// The hook posts an event to every deck whose workspace matches, and by
// default all of them append to one events.jsonl — so each event landed in
// that file once per running deck, and every later replay of it ingested each
// tool call that many times. The hook now elects one writer per log file and
// marks the request to the rest `?persist=0`. That flag covers the hook event
// itself; this map carries it to the ModelObserved/UsageObserved/
// ContextObserved events a deck derives from the same session's transcript,
// which every deck reads for itself and would otherwise duplicate exactly the
// same way. A session is recorded unless we have been told someone else owns
// it, so a lone deck — and a deck the hook is too old to flag — still writes
// everything.
//
// THIS COVERS THE CLAUDE SIDE ONLY, and that is worth stating because reading it
// as the general answer is what produced #447. The only thing that ever fills
// the set is noteLogWriter, called from handleEventIngest — a hook POST. Codex
// events are read off the rollout files inside this process and never reach an
// HTTP handler, and Codex hooks are not installed any more, so a Codex session
// id cannot get in here and writesLogFor answers "mine" for every one of them on
// every deck. The Codex half is decided by writesCodexLog in the watcher's scan
// loop instead, and every event derived from a rollout — including the memory
// scan's ContextObserved — has to carry that verdict explicitly.
const foreignSessions = new Set();  // session ids another deck is logging
const MAX_FOREIGN_SESSIONS = 512;   // bound: insertion order = oldest first

function noteLogWriter(payload, mine) {
  const sid = payload && typeof payload === "object" ? payload.session_id : null;
  if (typeof sid !== "string" || sid === "") return;
  // Delete either way: on re-add it moves the id back to the young end, so the
  // eviction below drops sessions that stopped being posted, not busy ones.
  foreignSessions.delete(sid);
  if (mine) return;
  foreignSessions.add(sid);
  if (foreignSessions.size > MAX_FOREIGN_SESSIONS) {
    foreignSessions.delete(foreignSessions.values().next().value);
  }
}

/**
 * Is this deck the one that writes this payload's session to the log? Every
 * event goes through here on its way to disk, including the ones this deck
 * derives from a transcript on its own — that is the point of remembering the
 * session rather than only honouring the flag on the event that carried it.
 */
export function writesLogFor(payload) {
  const sid = payload && typeof payload === "object" ? payload.session_id : null;
  return typeof sid !== "string" || sid === "" || !foreignSessions.has(sid);
}

/**
 * Who else is holding the log this deck would empty, and whose it is to empty.
 *
 * `events.jsonl` is one file several decks share — that is the whole reason the
 * election above exists — and `POST /api/clear` truncated it from whichever deck
 * happened to be asked. So Clear on a deck scoped to one tree deleted the
 * machine-wide deck's weeks of history, and told nobody: the other deck goes on
 * serving what is still in its ring, so the damage only shows up the next time
 * it boots and replays a file that is now empty (#698). Measured on macOS 15 /
 * Node 22.14: 1407 bytes and five lines before, 134 bytes after — and the 134
 * were the clearing deck's own `__clear` marker, appended to a log it writes
 * nothing else to.
 *
 * The rule this establishes is the one the rest of the file already runs on: a
 * deck may empty the log it WRITES. Ownership is electWriters — the same
 * election, over the same discovery records, that decides which deck appends a
 * line — so the process that truncates the file is the process that fills it,
 * which is also the only way the two operations are ordered on any platform. A
 * deck that is not the elected writer clears its own canvas and leaves the file
 * to the deck that owns it; the confirmation says so before the user presses
 * anything, and says how many decks share the file when the answer is "yours to
 * empty". Nothing here decides the copy — `GET /api/clear` hands these facts to
 * the dialog, which is the half that keeps the user from destroying history they
 * were never told about.
 *
 * Deliberately NOT a scope test. Whether this deck was started with
 * `--workspace` has nothing to do with who owns a file: two machine-wide decks
 * share one log exactly as a scoped one shares it with a machine-wide one, and
 * the harm is the same in both directions.
 *
 * Fail-safe matches writesCodexLog's, for the same reason: with no discovery
 * record of our own — the window before the first heartbeat writes it, or a deck
 * that cannot write one at all — nobody can elect us and we keep what a lone
 * deck does. The COUNT is still every deck sharing the file, so even inside that
 * window the confirmation warns rather than guessing quietly.
 */
export async function logSharing() {
  if (!persistPath) return { path: null, decks: 1, mine: true, owner: null };
  const fold = s => (foldsCase() ? s.toLowerCase() : s);
  const here = fold(persistPath);
  const sameLog = d => typeof d.persist === "string" && d.persist !== "" && fold(d.persist) === here;

  let live = [];
  try { live = await readLiveDecks(); } catch { /* unreadable dir — treated as "alone" below */ }
  const group = live.filter(sameLog);
  const self = group.find(d => d.pid === process.pid) ?? null;
  if (!self) return { path: persistPath, decks: Math.max(group.length + 1, 1), mine: true, owner: null };

  const writers = electWriters(group);
  const mine = writers.has(self);
  // One log path, so the election normally returns exactly one deck. It can
  // return more only when two decks spell the same file differently on a
  // case-sensitive platform, which `sameLog` folded together and electWriters
  // did not — the lowest port of them is the one to name, and `mine` above is
  // the election's own answer either way.
  const owner = mine
    ? self
    : [...writers].sort((a, b) => a.port - b.port || a.pid - b.pid)[0] ?? null;
  return { path: persistPath, decks: group.length, mine, owner };
}

// ─── Persistence rotation ─────────────────────────────────────────────────
// 24/7 dev servers used to grow events.jsonl unbounded — saw it hit GBs
// across weeks. We rotate when the file passes ROTATE_AT_BYTES, archiving
// the previous file to .1 and starting fresh. Last-event-id replay still
// covers the in-memory ring buffer, which is bounded by MAX_BUFFER events AND
// by MAX_BUFFER_CHARS — so how far back a replay reaches depends on how large
// the traffic has been, not on the count alone.
const ROTATE_AT_BYTES = 50 * 1024 * 1024;
let lastRotateCheckAt = 0;
let rotateInProgress = false;
async function maybeRotatePersistFile() {
  if (!persistPath) return;
  const now = Date.now();
  // Throttle disk-stat checks to once per 30s.
  if (now - lastRotateCheckAt < 30_000) return;
  lastRotateCheckAt = now;
  if (rotateInProgress) return;
  rotateInProgress = true;
  try {
    const s = await stat(persistPath).catch(() => null);
    if (!s || s.size < ROTATE_AT_BYTES) return;
    // Roll events.jsonl → events.jsonl.1 (replacing any previous .1).
    const oldPath = persistPath + ".1";
    try { await unlink(oldPath); } catch {}
    const { rename } = await import("node:fs/promises");
    await rename(persistPath, oldPath);
    console.log(`${PRODUCT}: rotated ${persistPath} (${(s.size / 1024 / 1024).toFixed(0)}MB → ${oldPath})`);
  } catch (err) {
    console.error(`${PRODUCT}: persist rotation failed:`, err && err.message ? err.message : err);
  } finally {
    rotateInProgress = false;
  }
}

// ─── Incremental transcript scanning ─────────────────────────────────────
// Model, usage and context enrichment all derive from the same append-only
// transcript JSONL, and each one used to re-read and re-parse the whole file
// on every throttled pass. A session's transcript grows to tens of MB, so
// that cost O(n) per pass, O(n²) over the session, and — because the parse
// loop is one synchronous block — it stalled SSE broadcasts and /api/event
// ingest for as long as it ran.
//
// Instead we keep one cursor per file plus the running totals derived so
// far, read only the bytes appended since the last pass, and fold them into
// that state. The three scanners share it, so the first one to run in a
// cycle pays for the read and the other two reuse the result. This mirrors
// the offset tailing the Codex rollout watcher already does further down.
const transcriptScans = new Map();        // path -> scan state
const transcriptScanInFlight = new Map(); // path -> in-progress scan promise
const transcriptScanSessions = new Map(); // session key -> Set<path>, LRU order

// What the cap protects is unbounded growth across the sessions a long-lived
// deck has seen and will never hear from again — so a SESSION is the unit it
// has to be counted in. It used to count paths, which is not the same thing:
// a session occupies one entry for its own JSONL plus one for every
// `subagents/agent-*.jsonl` beside it, and that count is set by how heavily
// the session delegates, not by anything the deck controls. Measured on this
// machine, the two live sessions that produced #611 hold 198 and 133 subagent
// files — 333 entries between them against a cap of 256, so each session's
// throttled pass evicted the other's cursors and re-read from byte 0. One of
// those directories alone is 130.8 MB and takes 6456 ms to fold cold against
// 18 ms warm, inside a 2500 ms throttle: the pass could not finish before the
// next one was due.
//
// So eviction drops a whole session at a time and never splits one. That is
// also the answer to a session whose subagent count exceeds any fixed number
// of entries: it is never evicted for being big, because the only thing a cap
// can take is some OTHER, older session. A session's cursors live and die
// together, which is the only grouping that makes the next pass cheap.
const MAX_TRANSCRIPT_SCAN_SESSIONS = 256;
// A session cap alone bounds identities, not bytes, so a second ceiling bounds
// the memory — again by dropping whole sessions, never part of one. A scan
// state retains 477 bytes measured, so 8192 entries is under 4 MB; it is also
// ten times every agent-*.jsonl that exists on this machine across its whole
// history (803), and 24x the 333 the two heaviest live sessions need.
const MAX_TRANSCRIPT_SCAN_ENTRIES = 8192;

// The transcript's `message.model`, and the only filter standing between it and
// every model the deck shows. Bedrock and Mantle put a provider namespace in
// front of the id — `us.anthropic.claude-opus-5`, `anthropic.claude-opus-5` —
// so a bare `^claude` dropped every line a Bedrock session writes and the deck
// showed those users no model, no context window and no cost at all (#475).
//
// The prefix list is `VENDOR_PREFIX_RE` in src/web/model-id.ts, written out a
// second time here rather than imported: this file is plain .mjs that node runs
// straight off disk with no build step, so it cannot reach a `.ts` module.
// bedrock-model-ids.test.ts sweeps both against one list of ids so the copies
// cannot drift apart.
const MODEL_ID_RE = /^(?:(?:us-gov|global|apac|us|eu|jp|au)\.anthropic\.|anthropic\.)?claude[-_]/i;
const USAGE_BLOCK_RE = /"usage"\s*:\s*\{([^}]+)\}/g;
// CC `/clear` and `/compact` write a marker into the transcript and reset the
// context window to ~0 while the JSONL keeps growing — everything before the
// last marker is stale.
const CONTEXT_RESET_RE = /<command-name>\s*\/(?:clear|compact)\s*<\/command-name>/g;
const TYPE_USER_RE = /"type"\s*:\s*"user"/g;
const TYPE_ASSISTANT_RE = /"type"\s*:\s*"assistant"/g;
const TYPE_TOOL_USE_RE = /"type"\s*:\s*"tool_use"/g;
const TYPE_TOOL_RESULT_RE = /"type"\s*:\s*"tool_result"/g;
const SYSTEM_REMINDER_RE = /<system-reminder>/g;
const USAGE_FIELD_RE = {
  input_tokens: /"input_tokens"\s*:\s*(\d+)/,
  output_tokens: /"output_tokens"\s*:\s*(\d+)/,
  cache_read_input_tokens: /"cache_read_input_tokens"\s*:\s*(\d+)/,
  cache_creation_input_tokens: /"cache_creation_input_tokens"\s*:\s*(\d+)/,
  ephemeral_1h_input_tokens: /"ephemeral_1h_input_tokens"\s*:\s*(\d+)/,
  ephemeral_5m_input_tokens: /"ephemeral_5m_input_tokens"\s*:\s*(\d+)/,
};
// The flat `cache_creation_input_tokens` says how many tokens were written to
// cache but not at which TTL, and Anthropic bills a 1-hour write at 2x input
// against the 5-minute 1.25x — CC writes 1-hour caches for most of its prefix,
// so pricing the whole lot at the cheaper rate under-reports the bill. The
// split lives in a `cache_creation` sub-object that USAGE_BLOCK_RE cannot
// reach: its `[^}]+` stops at the first `}`, which in a real transcript closes
// `server_tool_use`, several fields earlier. Match the sub-object on the raw
// line instead of on the extracted blob.
const CACHE_CREATION_BLOCK_RE = /"cache_creation"\s*:\s*\{([^}]*)\}/g;
// A finished `Task`/`Agent` call is written into the PARENT's transcript as a
// top-level `toolUseResult`, and that object carries a `usage` block of its own
// — the subagent's LAST API turn, restated on the parent's line. Those same
// tokens are already in the subagent's own `subagents/agent-<id>.jsonl`, which
// #685 folds into the session's totals, so counting the restated copy here
// would charge them twice. Measured on a real transcript: the restated block
// reports 181,387 cache-read tokens and the last usage block inside that
// subagent's file reports 181,387 — the same tokens, written twice.
//
// Matched as a TOP-LEVEL key: a `{` or `,` and then the name unescaped. The
// same text quoted inside a message — an assistant writing about this very
// field, as this comment does — reaches the line as `\"toolUseResult\"`, whose
// preceding character is a backslash, so a transcript that talks about the key
// is not mistaken for one that carries it.
const TOOL_USE_RESULT_KEY_RE = /[{,]"toolUseResult"\s*:/;

/** The stretch of a transcript line whose `usage` blocks are the model's own
 *  billing records — everything before a top-level `toolUseResult`. See
 *  TOOL_USE_RESULT_KEY_RE. A line without one is billed whole, which is every
 *  assistant line and therefore every line that legitimately has usage. */
function billedUsageText(line) {
  const m = TOOL_USE_RESULT_KEY_RE.exec(line);
  return m ? line.slice(0, m.index) : line;
}

function grabUsageField(blob, key) {
  const m = blob.match(USAGE_FIELD_RE[key]);
  return m ? Number(m[1]) : 0;
}

// How many DISTINCT models one transcript may keep a usage bucket for.
//
// A session reaches two or three: `/model` mid-run, CC dropping to Sonnet when
// the weekly Opus allowance runs low, a subagent turn on a different tier. The
// cap is not about those. `MODEL_ID_RE` accepts anything beginning `claude-`,
// and every line of a transcript is bytes this process was handed rather than
// bytes it wrote — so a file naming a fresh `claude-<n>` on every line would
// otherwise grow one bucket per line, inside the same scanner #674 put a
// ceiling on for exactly this shape of reason. Past the cap the extra models'
// tokens still reach `state.usage`, which is what every token count on screen
// reads; they simply stop being attributed, and `usageByModelEntries` on the
// client prices whatever the map does not explain at the session's current
// model — the behaviour the whole deck had before #686.
const MAX_TRANSCRIPT_USAGE_MODELS = 32;

/** The per-model usage bucket for `model`, created on first sight. Null for a
 *  line whose tokens we cannot attribute — no model seen yet in this file, or
 *  the cap above already reached. */
function usageBucketFor(state, model) {
  if (!model) return null;
  const existing = state.usageByModel[model];
  if (existing) return existing;
  if (Object.keys(state.usageByModel).length >= MAX_TRANSCRIPT_USAGE_MODELS) return null;
  const fresh = newUsageTotals();
  state.usageByModel[model] = fresh;
  return fresh;
}

/** Add `src`'s per-model buckets into `dst`, key for key, and return `dst`.
 *  Under the same cap as the per-file map, so a session that delegates to
 *  hundreds of files cannot assemble an unbounded one out of bounded parts. */
function mergeUsageByModel(dst, src) {
  if (!src) return dst;
  for (const [model, u] of Object.entries(src)) {
    let bucket = dst[model];
    if (!bucket) {
      if (Object.keys(dst).length >= MAX_TRANSCRIPT_USAGE_MODELS) continue;
      bucket = newUsageTotals();
      dst[model] = bucket;
    }
    for (const k of Object.keys(bucket)) bucket[k] += u[k] ?? 0;
  }
  return dst;
}

function newContextBreakdown() {
  return {
    msgsUser: 0,
    msgsAssistant: 0,
    toolUses: 0,
    toolResults: 0,
    systemReminders: 0,
    currentContextTokens: 0,
  };
}

/** A zeroed set of the six token counters a transcript reports. One shape, so
 *  the per-file totals and the per-session sum of them add key for key. */
function newUsageTotals() {
  return {
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0,
  };
}

function newTranscriptState() {
  return {
    offset: 0,          // bytes already folded in
    midLine: false,     // the cursor sits inside a line longer than MAX_SCAN_CHUNK
    rootModel: null,
    lastModel: null,    // last claude-* model on any line, sidechain included
    subagentModels: {},
    aiTitle: null,      // newest "ai-title" entry, the session's sentence title
    agentName: null,    // newest "agent-name" entry, the session's short name
    usage: newUsageTotals(),
    // The same totals, split by the model that produced them (#686). The flat
    // bucket above stays the whole-transcript sum and is what every token count
    // reads; this is what the DOLLARS are built from, because a session that
    // switched model has tokens from two rate cards in one file and one rate
    // applied to the lot is wrong by the ratio between them — measured at 60%
    // under on a mostly-Opus session that ended on Sonnet, and 150% over on the
    // mirror of it. Costs no extra read: `message.model` and the `"usage"` block
    // are on the same line, and this pass already parses both.
    usageByModel: {},
    ctx: newContextBreakdown(),
  };
}

// ─── Following an append-only JSONL, one bounded chunk at a time ─────────
// The most bytes ONE read of a transcript may allocate, and the ceiling that
// makes the size of the file irrelevant to the size of the allocation.
//
// #674 is what its absence cost. `readByteRange` was called with `to` set to
// `stat().size` on a path that arrives, unvalidated, in the body of a
// credential-free `POST /api/event`, and it answered by allocating the whole of
// it — once as a zero-filled Buffer and again as the string `toString` builds
// from it. Measured here on Node 22.14 / macOS against a real deck on loopback,
// sampling `process.memoryUsage.rss()` every 5 ms:
//
//   400 MB file, one POST:   51MB -> 848MB   (2x: the Buffer and the string)
//   700 MB file, one POST:   52MB -> 753MB   (1x: 700 MB is past V8's ~512 MB
//                                             max string, so `toString` threw
//                                             into the catch below and only the
//                                             Buffer was paid for)
//
// Both answered 200. Neither is a one-off: see `readAppendedLines` for the
// second half of that defect, the cursor that could not advance.
//
// 8 MiB is picked against the only measurement that bears on it — the longest
// single line in a real transcript. The note above `maybeResolveSessionName`
// measures that at 710 KB in the 46.4 MB session on this machine, one big tool
// result on one line, so the ceiling is about eleven times the worst line seen
// and no real transcript line is ever split by it. Its worst case is 8 MiB of
// Buffer plus up to 8 MiB of string per in-flight scan, which is an eighth of
// the 128 MiB the ring buffer is already allowed to hold.
export const MAX_SCAN_CHUNK = 8 * 1024 * 1024;

// How far ONE pass will walk a file that is behind by more than a chunk.
//
// The cursor makes catching up cheap in steady state, but the FIRST pass over
// an existing transcript has the whole file to fold, and a fix that made that
// take one throttle window (2500 ms) per 8 MiB would have turned a 130.8 MB
// transcript's first attach into forty seconds of a deck showing no model, no
// name and no cost — the reintroduction, by a different route, of exactly the
// stall #611 removed. So a pass loops over chunks until it is caught up, and
// this bounds what one hook event can be made to walk.
//
// 256 MiB is twice the heaviest transcript this repo has ever measured (130.8
// MB, #611), so an honest first attach never meets it and pays nothing for it.
// What it stops is a caller who has got past `isClaudeTranscriptPath` below
// pointing one POST at something arbitrarily large: the read still terminates,
// the cursor keeps whatever it reached, and the next throttled pass continues
// from there.
export const MAX_SCAN_BYTES_PER_PASS = 256 * 1024 * 1024;

const NEWLINE = 0x0a;

/** Up to MAX_SCAN_CHUNK bytes of `path` from `from`, as a Buffer of exactly the
 *  bytes that were read. The cap is here rather than at the call sites so that
 *  no caller — including one added later — can name a range that allocates more
 *  than the ceiling above. */
async function readByteChunk(path, from, to) {
  const len = Math.min(to - from, MAX_SCAN_CHUNK);
  if (len <= 0) return Buffer.alloc(0);
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    return bytesRead === len ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function readByteRange(path, from, to) {
  return (await readByteChunk(path, from, to)).toString("utf8");
}

/**
 * The next batch of COMPLETE lines appended to a JSONL file, and the cursor
 * moved past exactly the bytes they occupy.
 *
 * `cursor` is `{ offset, midLine }` and is written in place; `size` is the
 * caller's `stat()` reading. Returns `{ text, advanced }` where `advanced` is
 * the number of bytes the cursor moved — zero means "nothing complete to fold
 * yet", which is the caller's signal to stop.
 *
 * THE THREE THINGS THIS HAS TO GET RIGHT, and the one it used to get wrong:
 *
 *  1. A partial last line is not an error. A transcript is being appended to
 *     while it is read, so the tail of any chunk that ends at EOF is routinely
 *     half a line. Those bytes stay unread and the cursor does not move —
 *     the next pass sees the whole line once its newline lands.
 *
 *  2. A chunk with no newline in it that DOES NOT end at EOF is a different
 *     thing entirely, and the old code could not tell the two apart: it
 *     returned without advancing in both cases. For any file with no newline in
 *     it — any binary, a sparse file a caller makes for the purpose — that made
 *     the early return permanent, so every later POST re-read the whole file
 *     from byte 0. Measured before the fix, the same 400 MB file: 797 MB on the
 *     first post, 400 MB on the second, 400 MB on the third. Here that case is
 *     what `midLine` names: a full chunk with no line boundary anywhere in it
 *     is a line longer than the ceiling, there is no line there to wait for, so
 *     the cursor walks past it and the fragment that follows is dropped when
 *     the next boundary arrives.
 *
 *  3. The cursor is moved by BYTES, taken from the buffer, never by
 *     `Buffer.byteLength` of the decoded text. Chunking can split a multi-byte
 *     character at the ceiling, and `toString` turns a split character into a
 *     replacement character of a different width — so measuring the advance on
 *     the string would drift the cursor on any transcript containing non-ASCII,
 *     which is most of them. Slicing at the last newline (a byte that cannot be
 *     part of a multi-byte sequence) and advancing by its index is exact.
 */
export async function readAppendedLines(path, cursor, size, chunkMax = MAX_SCAN_CHUNK) {
  const from = cursor.offset;
  const want = Math.min(size - from, chunkMax);
  if (want <= 0) return { text: "", advanced: 0 };
  const buf = await readByteChunk(path, from, from + want);
  if (buf.length === 0) return { text: "", advanced: 0 };

  const lastNl = buf.lastIndexOf(NEWLINE);
  if (lastNl < 0) {
    // Reaching the end of the file with no newline in hand is the ordinary
    // partial last line: wait for its newline. (1) above. The test is where the
    // read STOPPED, not how much was asked for, because `readByteChunk` clamps
    // to MAX_SCAN_CHUNK and a short read is normally that clamp rather than the
    // end of anything.
    if (from + buf.length >= size) return { text: "", advanced: 0 };
    // A chunk with no line boundary in it, and more file after it. (2).
    cursor.offset = from + buf.length;
    cursor.midLine = true;
    return { text: "", advanced: buf.length };
  }

  const advanced = lastNl + 1;            // (3): bytes, up to and including the \n
  let text = buf.toString("utf8", 0, lastNl);
  if (cursor.midLine) {
    // This chunk opens in the middle of a line we already walked past, so
    // everything up to the first boundary is the tail of it and folding it
    // would fold a fragment. Only the lines after it are whole.
    const nl = text.indexOf("\n");
    text = nl < 0 ? "" : text.slice(nl + 1);
    cursor.midLine = false;
  }
  cursor.offset = from + advanced;
  return { text, advanced };
}

// ─── Session naming ──────────────────────────────────────────────────────
// CC writes two whole-line records that name the session, and nothing else in
// the transcript carries either fact:
//
//   {"type":"ai-title","aiTitle":"Inspect repository to understand current state","sessionId":"…"}
//   {"type":"agent-name","agentName":"account-management-oauth-flow","sessionId":"…"}
//
// Both are re-emitted on roughly every turn rather than only when they change.
// Measured on the two largest transcripts on this machine: 685 `ai-title`
// entries carrying 2 DISTINCT values (46.4 MB session) and 406 carrying 1
// (19.6 MB session). So "the last one wins" is right, but the value is nearly
// always the value we already had — which is why the emit below is gated on a
// change rather than fired per pass.
//
// `aiTitle` is NOT reliably the sentence it looks like. In the 46.4 MB session
// the first 332 entries read "Inspect repository to understand current state"
// and every one of the last 353 reads "account-management-oauth-flow" —
// byte-identical to `agentName`, and 353 is exactly the `agent-name` count. CC
// overwrites the title with the slug once a session has a name. The client
// therefore has to treat "title equals name" as "no title", or the tooltip
// would repeat the card.
const AI_TITLE_MARK = '"ai-title"';
const AGENT_NAME_MARK = '"agent-name"';

/** Fold one line's naming records into `out`. Last value wins. Pure: `out` is
 *  the only thing written, and a line that is not one of the two records — or
 *  is a truncated fragment of one — leaves it untouched. */
function foldSessionNamingLine(out, line) {
  if (!line) return;
  const hasTitle = line.includes(AI_TITLE_MARK);
  const hasName = line.includes(AGENT_NAME_MARK);
  if (!hasTitle && !hasName) return;
  let obj = null;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== "object") return;
  if (obj.type === "ai-title" && typeof obj.aiTitle === "string" && obj.aiTitle) {
    out.aiTitle = obj.aiTitle;
  } else if (obj.type === "agent-name" && typeof obj.agentName === "string" && obj.agentName) {
    out.agentName = obj.agentName;
  }
}

/**
 * The session naming carried by a chunk of transcript text, newest wins.
 *
 * Pure and text-in, so the suite can pin the parsing against a handful of lines
 * instead of a 46 MB fixture. Returns `{aiTitle: null, agentName: null}` for a
 * chunk holding neither — a young session, or a stretch of the file that is all
 * tool output — and the caller keeps whatever it already knew rather than
 * clearing a name it has already shown.
 */
export function readSessionNaming(text) {
  const out = { aiTitle: null, agentName: null };
  if (!text || typeof text !== "string") return out;
  for (const line of text.split("\n")) foldSessionNamingLine(out, line);
  return out;
}

/** Fold one transcript line into the running state. Every fact the three
 *  scanners need lives on a single line, so line-at-a-time folding sees
 *  exactly what a whole-file pass would. */
function foldTranscriptLine(state, line) {
  if (!line) return;

  // Rides the scan that is already reading these bytes for the model, the usage
  // totals and the context counts, so naming costs no read of its own — see the
  // block above `maybeResolveSessionName` for why that beat a tail read.
  foldSessionNamingLine(state, line);

  // Model. Only a line that mentions a model can change it, and parsing the
  // rest is what made the full rescan expensive.
  if (line.includes('"model"')) {
    let obj = null;
    try { obj = JSON.parse(line); } catch {}
    const msg = obj && obj.message;
    const model = (msg && typeof msg.model === "string" && MODEL_ID_RE.test(msg.model)) ? msg.model
                : (obj && typeof obj.model === "string" && MODEL_ID_RE.test(obj.model)) ? obj.model
                : null;
    if (model) {
      state.lastModel = model;
      const isSide = obj.isSidechain === true || obj.is_sidechain === true;
      const ptid = obj.parentToolUseID || obj.parent_tool_use_id || obj.parentToolUseId || null;
      if (isSide && ptid) state.subagentModels[ptid] = model;
      else if (!isSide) state.rootModel = model;
    }
  }

  // Usage totals sum every block in the file, resets included — every block the
  // model was actually billed for, which is why the `toolUseResult` tail is cut
  // off first (see billedUsageText) — and are summed a second time into the
  // bucket of the model that produced them (#686).
  //
  // `state.lastModel` is the attribution, and it is the LINE's model whenever
  // the line has one: the block above has already run and assigned it. That is
  // the whole trick — CC writes `message.model` and `message.usage` into the
  // same JSON object, so by the time this loop reads the tokens the model that
  // produced them is the most recent thing the scanner saw. A usage block on a
  // line naming no model falls back to the last model seen, which is the turn it
  // belongs to; a usage block before ANY model line gets no bucket at all and
  // stays in the flat total alone, where the client prices it at the session's
  // current model exactly as it did before.
  //
  // The bucket takes exactly what the flat total takes, off the same `billed`
  // text: a split that read a wider stretch of the line than the total it splits
  // would re-introduce #685's double count on one side of the arithmetic only,
  // and the two would stop summing to each other.
  const billed = billedUsageText(line);
  const bucket = usageBucketFor(state, state.lastModel);
  for (const m of billed.matchAll(USAGE_BLOCK_RE)) {
    const blob = m[1];
    const inTok    = grabUsageField(blob, "input_tokens");
    const outTok   = grabUsageField(blob, "output_tokens");
    const cacheR   = grabUsageField(blob, "cache_read_input_tokens");
    const cacheC   = grabUsageField(blob, "cache_creation_input_tokens");
    state.usage.input_tokens += inTok;
    state.usage.output_tokens += outTok;
    state.usage.cache_read_input_tokens += cacheR;
    state.usage.cache_creation_input_tokens += cacheC;
    if (bucket) {
      bucket.input_tokens += inTok;
      bucket.output_tokens += outTok;
      bucket.cache_read_input_tokens += cacheR;
      bucket.cache_creation_input_tokens += cacheC;
    }
  }
  for (const m of billed.matchAll(CACHE_CREATION_BLOCK_RE)) {
    const h1 = grabUsageField(m[1], "ephemeral_1h_input_tokens");
    const m5 = grabUsageField(m[1], "ephemeral_5m_input_tokens");
    state.usage.ephemeral_1h_input_tokens += h1;
    state.usage.ephemeral_5m_input_tokens += m5;
    if (bucket) {
      bucket.ephemeral_1h_input_tokens += h1;
      bucket.ephemeral_5m_input_tokens += m5;
    }
  }

  // Context counts only what follows the most recent /clear or /compact.
  let ctxText = line;
  let resetEnd = -1;
  for (const m of line.matchAll(CONTEXT_RESET_RE)) resetEnd = (m.index ?? -1) + m[0].length;
  if (resetEnd >= 0) {
    state.ctx = newContextBreakdown();
    ctxText = line.slice(resetEnd);
  }
  const ctx = state.ctx;
  ctx.msgsUser += (ctxText.match(TYPE_USER_RE) ?? []).length;
  ctx.msgsAssistant += (ctxText.match(TYPE_ASSISTANT_RE) ?? []).length;
  ctx.toolUses += (ctxText.match(TYPE_TOOL_USE_RE) ?? []).length;
  ctx.toolResults += (ctxText.match(TYPE_TOOL_RESULT_RE) ?? []).length;
  ctx.systemReminders += (ctxText.match(SYSTEM_REMINDER_RE) ?? []).length;
  // Current context size = the LAST usage block after the reset. Stays 0
  // right after a /clear, which is what CC's own /context reports.
  let lastBlob = null;
  for (const m of ctxText.matchAll(USAGE_BLOCK_RE)) lastBlob = m[1];
  if (lastBlob) {
    ctx.currentContextTokens =
      grabUsageField(lastBlob, "input_tokens") +
      grabUsageField(lastBlob, "cache_read_input_tokens") +
      grabUsageField(lastBlob, "cache_creation_input_tokens");
  }
}

/** The session a transcript path belongs to, and the unit eviction works in.
 *  CC's two layouts collapse onto the same key: the main transcript
 *  `<slug>/<sessionId>.jsonl` loses its extension, and a subagent's
 *  `<slug>/<sessionId>/subagents/agent-<id>.jsonl` loses everything below the
 *  session directory, so both land on `<slug>/<sessionId>`. Anything else — a
 *  Codex rollout, a shape we do not recognise — is a session of its own,
 *  which is the old one-entry-per-path accounting and the safe default.
 *
 *  `resolve` first so the two halves agree on Windows. The main path arrives
 *  from the hook payload as CC wrote it while the subagent path is built with
 *  `join`, so `C:/x/y.jsonl` and `C:\x\y\subagents\agent-1.jsonl` would
 *  otherwise be two sessions instead of one; `resolve` settles the separator
 *  on all three platforms, and leaves a backslash inside a POSIX filename
 *  alone rather than reading it as a directory break. */
export function transcriptSessionKey(path) {
  const full = resolve(path);
  const sub = /^(.*)[\\/]subagents[\\/]agent-[0-9a-f]+\.jsonl$/i.exec(full);
  return sub ? sub[1] : full.replace(/\.jsonl$/i, "");
}

/** Record a use of `path` and keep the cache under both caps. Re-inserting the
 *  session on every touch makes the Map's own insertion order the LRU order,
 *  so eviction reads one key instead of scanning for the smallest timestamp.
 *  Scanning a timestamp is also what broke the cache once: a state is created
 *  with no stamp yet, so the entry the scan had just inserted was the smallest
 *  of all and the one deleted, every time. Whatever the cache freezes on, the
 *  symptom is the same — every later transcript re-reads its whole JSONL from
 *  byte 0 on every throttled pass, the O(n)-per-pass stall the cursor exists
 *  to remove. */
function touchTranscriptScan(path, state) {
  transcriptScans.set(path, state);
  const key = transcriptSessionKey(path);
  const paths = transcriptScanSessions.get(key) ?? new Set();
  transcriptScanSessions.delete(key);   // re-insert = move to the back of the LRU
  paths.add(path);
  transcriptScanSessions.set(key, paths);
  pruneTranscriptScans();
}

function pruneTranscriptScans() {
  // The last session standing is never evicted, however many files it holds:
  // dropping the cursors of the session currently being scanned is precisely
  // the re-read this cache exists to avoid, and no cap can make its file
  // count smaller.
  while (
    transcriptScanSessions.size > 1 &&
    (transcriptScanSessions.size > MAX_TRANSCRIPT_SCAN_SESSIONS ||
     transcriptScans.size > MAX_TRANSCRIPT_SCAN_ENTRIES)
  ) {
    const oldest = transcriptScanSessions.keys().next().value;
    for (const p of transcriptScanSessions.get(oldest)) transcriptScans.delete(p);
    transcriptScanSessions.delete(oldest);
  }
}

/** Bring a transcript's scan state up to date and return it. Concurrent
 *  callers share one read — folding the same appended bytes twice would
 *  double the usage totals. Never throws; an unreadable file just leaves
 *  the state where it was. */
function scanTranscript(path) {
  if (!path || typeof path !== "string") return Promise.resolve(null);
  const inFlight = transcriptScanInFlight.get(path);
  if (inFlight) return inFlight;
  const run = (async () => {
    let state = transcriptScans.get(path);
    if (!state) state = newTranscriptState();
    touchTranscriptScan(path, state);
    try {
      const s = await stat(path);
      // Shorter than the cursor means the file was truncated, rotated or
      // replaced — the offset now points at unrelated bytes, so start over.
      if (s.size < state.offset) {
        state = newTranscriptState();
        // Touch again rather than set: the await above yielded, and another
        // path's scan may have re-ordered or evicted this entry meanwhile.
        touchTranscriptScan(path, state);
      }
      if (s.size <= state.offset) return state;
      // Chunk by chunk rather than in one allocation, and loop rather than
      // leave the rest for the next throttle window — see MAX_SCAN_CHUNK and
      // MAX_SCAN_BYTES_PER_PASS for why it is both of those and not either one
      // alone. `readAppendedLines` advances the cursor BEFORE this folds, which
      // is the same rule the single-shot read kept: a fold that throws half-way
      // must not leave the cursor where the next pass would count those lines
      // again. `advanced === 0` is "nothing complete to fold yet".
      let budget = MAX_SCAN_BYTES_PER_PASS;
      while (budget > 0 && state.offset < s.size) {
        const { text, advanced } = await readAppendedLines(path, state, s.size);
        if (advanced === 0) break;
        budget -= advanced;
        for (const line of text.split("\n")) foldTranscriptLine(state, line);
      }
    } catch { /* keep whatever we already folded */ }
    return state;
  })();
  transcriptScanInFlight.set(path, run);
  return run.finally(() => {
    if (transcriptScanInFlight.get(path) === run) transcriptScanInFlight.delete(path);
  });
}

// ─── Which paths the deck will follow at all ─────────────────────────────
// `payload.transcript_path` is a string in the body of `POST /api/event`, and
// that route is a deliberate OPEN_MUTATION: no token, no Origin, nothing. Until
// #674 the deck took whatever it said and opened it. The bounds above make that
// survivable; this makes it uninteresting, and the two are worth having
// together for different reasons.
//
// WHY VALIDATE AT ALL WHEN THE READ IS ALREADY BOUNDED. Because the caller here
// is not a web page — `isTrustedMutation` refuses `Sec-Fetch-Site: cross-site`
// before any of this — it is a local process: the sandboxed subprocess with
// loopback egress that the comment above `isAuthorizedMutation` already names,
// or another UID on a shared box. Against that caller a ceiling only sets the
// price per request; it does not take the lever away. What takes it away is
// that there is no file it can name. Claude Code writes transcripts in exactly
// one place, `<config dir>/projects/…`, and every legitimate `transcript_path`
// the deck has ever seen is one of those — so the set of things worth opening
// is knowable in advance, and checking membership costs one string comparison
// against a syscall that used to cost the size of the file.
//
// WHAT IS LEFT AFTERWARDS, stated plainly: a caller who can WRITE inside that
// directory can still point the deck at a file of its choosing. That caller is
// this user's own processes — and this user's own processes can read
// `<config dir>/agent-dag/*.json`, which is where HOOK_TOKEN lives at mode
// 0600, so they hold the credential already. The gate reduces the
// credential-free adversary to the one who was never credential-free. That is
// the whole of what it claims, and the ceilings above are what carries the
// rest.
//
// WHY NOT realpath. A symlink planted inside the projects directory would
// defeat the containment test — but planting one needs write access to that
// directory, which is the case above where the caller already holds the token.
// It would also cost a syscall on every hook event, on a path that runs for
// every event of every live session.
//
// WHY TWO ROOTS. CLAUDE_CONFIG_DIR replaces ~/.claude wholesale, and the deck
// reads the variable from its OWN environment while the path is written by
// whatever `claude` process the hook fired in. Those normally agree — the deck
// installs its hook into the directory it resolves, so a session whose events
// arrive here is a session reading that same directory — but a deck launched
// from a desktop shortcut that never sourced the shell rc is a real way for
// them to disagree in one direction. Accepting the default location as well
// costs nothing (it is a directory only this user writes either way) and
// removes half of that failure mode. The other half is why the refusal is
// logged rather than silent.
function claudeTranscriptRoots() {
  // Resolved per call, like every other claudeConfigDir() reader in this file,
  // so nothing captures the answer from an environment that has moved.
  const roots = [resolve(claudeConfigDir(), "projects")];
  const byDefault = resolve(homedir(), ".claude", "projects");
  if (!roots.includes(byDefault)) roots.push(byDefault);
  return roots;
}

/** Is `p` a Claude Code transcript, in a directory Claude Code writes them?
 *
 *  Containment is compared on the RESOLVED path with a trailing separator, so
 *  `…/projects-of-mine/x.jsonl` is not inside `…/projects` and `..` cannot
 *  climb out of it. The comparison is case-insensitive on Windows and macOS,
 *  whose default filesystems are, because the two halves come from two
 *  processes and only one of them chose the casing. */
export function isClaudeTranscriptPath(p, roots = claudeTranscriptRoots()) {
  if (!p || typeof p !== "string") return false;
  if (!/\.jsonl$/i.test(p)) return false;      // the only extension CC writes
  const fold = process.platform === "win32" || process.platform === "darwin";
  const full = fold ? resolve(p).toLowerCase() : resolve(p);
  for (const root of roots) {
    const prefix = (fold ? root.toLowerCase() : root) + sep;
    if (full.startsWith(prefix) && full.length > prefix.length) return true;
  }
  return false;
}

// Refusals are logged once per path and the set is capped, because the point of
// the log is a misconfigured deck saying so on stderr — one line naming the
// path and where transcripts are expected — and a caller posting a fresh path
// per request must not turn that into a second unbounded accumulation.
const refusedTranscriptPaths = new Set();
const MAX_REFUSED_TRANSCRIPT_PATHS = 64;

function noteRefusedTranscript(p) {
  if (refusedTranscriptPaths.has(p)) return;
  if (refusedTranscriptPaths.size >= MAX_REFUSED_TRANSCRIPT_PATHS) return;
  refusedTranscriptPaths.add(p);
  console.warn(`${PRODUCT}: not reading transcript_path outside ${claudeTranscriptRoots().join(" or ")}: ${p}`);
}

// ─── Model enrichment ────────────────────────────────────────────────────
// CC's hook payloads never carry the `model` field — but every hook
// references a `transcript_path` JSONL that contains lines like
// `"model":"claude-opus-4-7"`. We re-read the tail of that file on every
// event for the session (throttled to MODEL_READ_THROTTLE_MS), cache the
// resolved root + subagent models, and (a) inject `model` into subsequent
// payloads for that session before broadcasting, (b) emit a synthetic
// `ModelObserved` event whenever that set CHANGES, so the client backfills
// agents created before the model was resolved. The cache is the emit
// filter, not a read filter: reading once per session meant a subagent
// model that only appears after the root is known was never picked up.
const modelBySession = new Map();         // sessionId -> { rootModel, subsSig }
const pendingTranscriptReads = new Set(); // sessionId currently being read
const modelLastReadAt = new Map();        // sessionId -> ms timestamp (re-read throttle)
const MODEL_READ_THROTTLE_MS = 2500;

/** The cache entry is `{ rootModel, subsSig }`, but `payload.model` is a
 *  model *string* — that is the only shape the client's recursive scanner
 *  reads. Returns the root model id, or null when the session resolved
 *  only subagent models and has no root model yet. */
export function cachedModelId(cached) {
  const rootModel = cached?.rootModel;
  return typeof rootModel === "string" && rootModel ? rootModel : null;
}

/** Read the main session JSONL. Returns the root model and any
 *  legacy-schema subagent models (older CC versions kept subagent blocks
 *  inline with `isSidechain:true` + `parentToolUseID`). Current CC versions
 *  store subagents in `<sessionDir>/subagents/agent-<id>.jsonl` — those are
 *  handled by `readSubagentsFromDir` below. */
export async function readModelFromTranscript(path) {
  const state = await scanTranscript(path);
  if (!state) return null;
  const rootModel = state.rootModel ?? state.lastModel;
  const subagentModels = { ...state.subagentModels };
  if (!rootModel && Object.keys(subagentModels).length === 0) return null;
  return { rootModel, subagentModels };
}

/** Newer CC schema (~2026-06): each subagent turn writes its OWN file at
 *  `<projects>/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` with a
 *  sidecar `.meta.json` carrying `{agentType, description}`. The hook
 *  payload's `agent_id` matches the file's <agentId>, so the reducer can
 *  attribute via the existing `subagentModels` map (it keys by parentToolUseId
 *  but the reducer looks up `${sessionId}::${key}` and the subagent node id
 *  is built from `agent_id` — identical lookup either way).
 *
 *  Returns `{ models: { [agentId]: model }, usage: <summed totals|null> }` over
 *  every agent-*.jsonl in the directory, or null when there is no such
 *  directory — which is every Codex session and every legacy-schema Claude one.
 *
 *  WHY IT RETURNS USAGE AND NOT ONLY MODELS (#685). `scanTranscript` folds a
 *  file's usage totals whether or not anyone asks for them, so this walk has
 *  been computing every subagent's spend and dropping it on the floor, while
 *  the session's totals came from the main transcript alone — and the main
 *  transcript does not restate a subagent's turns. Measured on one real
 *  session on the reporter's machine: 40.4M cache-read tokens in the main
 *  JSONL against 217.7M across its twenty subagent files, so the deck was
 *  reporting about a sixth of what the session actually cost.
 *
 *  WHY THE TOTALS ARE SUMMED HERE RATHER THAN SHIPPED PER AGENT. The obvious
 *  shape is a `{ [agentId]: totals }` map so each subagent card can price its
 *  own spend, and the cost of that shape is set by CC and not by us: #611
 *  measured live sessions holding 198 and 133 of these files, and this machine
 *  has one holding 397. At ~200 bytes an entry on a 2.5 s cadence that is
 *  ~80 KB per pass into the SSE fan-out, the event ring and events.jsonl —
 *  ~115 MB an hour into a log that rotates at 50 MB. One summed object is
 *  ~150 bytes whatever the session delegates, so the session total is exact
 *  and constant-cost, and per-card attribution stays a separate question.
 *
 *  `usageByModel` is summed on the same terms and for the same reason (#686):
 *  a subagent runs on whatever model its Task was given, which is routinely not
 *  its parent's — the deck already reads a per-agent `models` map three lines
 *  up precisely because of that — so folding delegated tokens into the session
 *  total without their model would price a Haiku subagent's spend at the root's
 *  Opus rate. It stays constant-cost the way the flat total does: the key count
 *  is the number of MODELS a session touched, two or three, not the number of
 *  files it delegated to. */
async function readSubagentsFromDir(transcriptPath) {
  // Subagent dir sits next to the main jsonl: <dir>/<sessionId>/subagents/
  // Derive from transcript_path by stripping the .jsonl suffix.
  if (!transcriptPath || typeof transcriptPath !== "string") return null;
  const sessionDir = transcriptPath.replace(/\.jsonl$/i, "");
  const subDir = join(sessionDir, "subagents");
  let entries;
  try { entries = await readdir(subDir); } catch { return null; }
  const models = {};
  const usage = newUsageTotals();
  const usageByModel = {};
  let spent = false;
  for (const f of entries) {
    if (!/^agent-([0-9a-f]+)\.jsonl$/i.test(f)) continue;
    const agentId = f.replace(/^agent-/, "").replace(/\.jsonl$/i, "");
    const full = join(subDir, f);
    try {
      // Same incremental cursor as the main transcript. Last-seen claude-*
      // model wins — subagents may switch model mid-turn (Sonnet → Haiku for
      // tool-call fallback etc.).
      const state = await scanTranscript(full);
      if (!state) continue;
      if (state.lastModel) models[agentId] = state.lastModel;
      // The cursor makes this cumulative and idempotent: `state.usage` is the
      // whole file's totals however many passes it took to fold them, so
      // re-summing every pass restates the same number rather than growing it.
      for (const k of Object.keys(usage)) usage[k] += state.usage[k];
      // Idempotent on the same argument as the line above: each file's split is
      // its own cumulative totals, so re-summing every pass restates the map
      // rather than growing it.
      mergeUsageByModel(usageByModel, state.usageByModel);
      if (state.usage.input_tokens || state.usage.output_tokens
          || state.usage.cache_read_input_tokens || state.usage.cache_creation_input_tokens) {
        spent = true;
      }
    } catch { /* skip unreadable file */ }
  }
  const hasModels = Object.keys(models).length > 0;
  if (!hasModels && !spent) return null;
  return {
    models: hasModels ? models : null,
    usage: spent ? usage : null,
    usageByModel: spent ? usageByModel : null,
  };
}

// One walk of `<sessionDir>/subagents/` serves both the model pass and the
// usage pass. The two are throttled independently but fire from the same hook
// events, so without this the directory — up to a few hundred files — would be
// listed and stat-ed twice per window for the same answer. The TTL sits under
// MODEL_READ_THROTTLE_MS so two callers inside one window share a walk and the
// next window always gets a fresh one.
const subagentDirScans = new Map();  // transcriptPath -> { at, promise }
const SUBAGENT_DIR_TTL_MS = 2000;

function scanSubagentDir(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return Promise.resolve(null);
  const now = Date.now();
  // Expiry is the eviction rule: an entry outlives its window by nothing, so
  // the map holds at most one entry per session read in the last two seconds.
  for (const [k, v] of subagentDirScans) {
    if (now - v.at >= SUBAGENT_DIR_TTL_MS) subagentDirScans.delete(k);
  }
  const memo = subagentDirScans.get(transcriptPath);
  if (memo) return memo.promise;
  const promise = readSubagentsFromDir(transcriptPath).catch(() => null);
  subagentDirScans.set(transcriptPath, { at: now, promise });
  return promise;
}

function maybeResolveModel(payload) {
  if (!payload || typeof payload !== "object") return;
  const sid = payload.session_id;
  const tp = payload.transcript_path;
  if (!sid || !tp) return;
  // Re-read on every event for this session — the cache was preventing us
  // from picking up subagent models that arrive after the root is known.
  // Throttle so we don't thrash the filesystem.
  if (pendingTranscriptReads.has(sid)) return;
  const now = Date.now();
  const last = modelLastReadAt.get(sid) ?? 0;
  if (now - last < MODEL_READ_THROTTLE_MS) return;
  modelLastReadAt.set(sid, now);
  pendingTranscriptReads.add(sid);
  Promise.all([readModelFromTranscript(tp), scanSubagentDir(tp)])
    .then(([result, dir]) => {
      const rootModel = result?.rootModel ?? null;
      // Merge legacy (inline isSidechain) + new (subagents/ dir) maps. Dir
      // wins on conflict since current CC only writes to the dir.
      const subagentModels = { ...(result?.subagentModels ?? {}), ...(dir?.models ?? {}) };
      if (!rootModel && Object.keys(subagentModels).length === 0) return;
      const prev = modelBySession.get(sid);
      const subsSig = JSON.stringify(subagentModels);
      if (prev && prev.rootModel === rootModel && prev.subsSig === subsSig) return;
      modelBySession.set(sid, { rootModel, subsSig });
      pushEvent({
        hook_event_name: "ModelObserved",
        session_id: sid,
        model: rootModel,
        subagentModels,
      }, "internal");
    })
    .catch(() => {})
    .finally(() => pendingTranscriptReads.delete(sid));
}

// ─── Usage enrichment ────────────────────────────────────────────────────
// Same story as the model: token counts (input/output/cache) are missing
// from every CC hook payload but present on every assistant message in
// the transcript JSONL as a `"usage":{…}` block. We sum them across the
// whole transcript and ship a synthetic UsageObserved event so the
// session's root agent gets accurate cumulative usage (and therefore the
// cost columns actually have something to multiply by).
const lastUsageReadAt = new Map();      // sid -> ms timestamp
const pendingUsageReads = new Set();    // sid currently being read
const USAGE_READ_THROTTLE_MS = 2500;

// Every entry carries its own usage object and we sum every occurrence, so
// the totals are cumulative over the whole transcript — the running state
// keeps them across passes and each pass only adds the newly appended blocks.
//
// ONE FILE, which is the whole file and no more. This reads the path it is
// given; the session's delegated spend lives in the sibling `subagents/`
// directory and is added by `sessionUsageTotals` below. Kept separate because
// the two are read on different cadences by different callers and the tests
// that pin the cursor arithmetic pin it one file at a time.
export async function readUsageFromTranscript(path) {
  const state = await scanTranscript(path);
  if (!state) return null;
  const totals = { ...state.usage };
  if (totals.input_tokens === 0 && totals.output_tokens === 0
      && totals.cache_read_input_tokens === 0 && totals.cache_creation_input_tokens === 0) return null;
  return totals;
}

/** One transcript's totals broken out by the model that produced them, or null
 *  when the scan attributed nothing.
 *
 *  A SECOND EXPORT rather than one more key on the object above, and the reason
 *  is that object's contract: `readUsageFromTranscript` is asserted with
 *  `toEqual` on its whole shape, so a key added to it is a key every caller and
 *  every fixture has to learn about. This costs no extra read — `scanTranscript`
 *  hands back the state it already folded and coalesces concurrent callers onto
 *  one pass — so the pair reads the file exactly as often as the single call
 *  did. */
export async function readUsageByModelFromTranscript(path) {
  const state = await scanTranscript(path);
  if (!state) return null;
  const out = {};
  for (const [model, u] of Object.entries(state.usageByModel)) {
    if (u.input_tokens === 0 && u.output_tokens === 0
        && u.cache_read_input_tokens === 0 && u.cache_creation_input_tokens === 0) continue;
    out[model] = { ...u };
  }
  return Object.keys(out).length ? out : null;
}

/** The session's whole spend split by model — its own turns plus every
 *  subagent's, merged (#686).
 *
 *  The counterpart of `sessionUsageTotals` below and read from the same two
 *  places, so the split and the total it splits are always a description of the
 *  same bytes. A subagent runs on the model its Task was given, which is
 *  routinely not its parent's, so a session sum that carried only the root's
 *  models would price delegated tokens at whatever the root is on now — the
 *  same mistake as the one being fixed, one level in. */
export async function sessionUsageByModel(transcriptPath) {
  const [own, dir] = await Promise.all([
    readUsageByModelFromTranscript(transcriptPath),
    scanSubagentDir(transcriptPath),
  ]);
  if (!own && !dir?.usageByModel) return null;
  const out = mergeUsageByModel({}, own);
  mergeUsageByModel(out, dir?.usageByModel);
  return Object.keys(out).length ? out : null;
}

/**
 * Everything a Claude session has spent: its own turns plus every subagent it
 * ran. Returns null when the session has spent nothing yet.
 *
 * WHAT THIS NUMBER MEANS, and why it is one number (#685). A session is a
 * bill, and delegating work does not move any of it somewhere else — the
 * subagent's tokens are charged to the same account on the same invoice. The
 * two halves live in two places on disk because CC writes them there:
 * `<sessionId>.jsonl` for the root's turns, `<sessionId>/subagents/agent-*.jsonl`
 * for each delegated one, with no overlap between them (verified against real
 * transcripts: a session holding 397 subagent files had zero `isSidechain`
 * lines in its main JSONL). Summing the two therefore counts every token
 * exactly once, and the reducer ASSIGNS the result rather than adding it, so a
 * pass that lands twice restates the same total instead of doubling it.
 *
 * The one place the two files did overlap is the `toolUseResult` block a
 * finished Task leaves on the parent's line, which restates the subagent's
 * last turn; `billedUsageText` cuts that out of the scan so this sum stays a
 * sum of distinct tokens.
 */
export async function sessionUsageTotals(transcriptPath) {
  const [own, dir] = await Promise.all([
    readUsageFromTranscript(transcriptPath),
    scanSubagentDir(transcriptPath),
  ]);
  const delegated = dir?.usage ?? null;
  if (!own && !delegated) return null;
  const totals = own ? { ...own } : newUsageTotals();
  if (delegated) for (const k of Object.keys(totals)) totals[k] += delegated[k] ?? 0;
  return totals;
}

function maybeResolveUsage(payload) {
  if (!payload || typeof payload !== "object") return;
  const sid = payload.session_id;
  const tp = payload.transcript_path;
  if (!sid || !tp) return;
  if (pendingUsageReads.has(sid)) return;
  const now = Date.now();
  const last = lastUsageReadAt.get(sid) ?? 0;
  if (now - last < USAGE_READ_THROTTLE_MS) return;
  lastUsageReadAt.set(sid, now);
  pendingUsageReads.add(sid);
  Promise.all([sessionUsageTotals(tp), sessionUsageByModel(tp)])
    .then(([usage, usageByModel]) => {
      if (!usage) return;
      // `usageByModel` rides on the same event because it is the same
      // measurement, read from the same two places by the same walk — the main
      // transcript and the `subagents/` directory — so the split and the total
      // it splits cannot describe two different moments of the session. Sent
      // even when null: an absent split has to CLEAR a stale one on the client,
      // for the reason the flat totals are assigned rather than added.
      pushEvent({ hook_event_name: "UsageObserved", session_id: sid, usage, usageByModel }, "internal");
    })
    .catch(() => {})
    .finally(() => pendingUsageReads.delete(sid));
}

// ─── Session-name enrichment ─────────────────────────────────────────────
// WHY THIS IS NOT A TAIL READ. The obvious shape for "get the newest naming
// record out of a 46 MB file" is to read the last N KB and parse backwards, and
// it is the wrong shape here for two reasons, one of them measured.
//
// The measured one: the density is not uniform, so no N is safe. Back-scanning
// from an arbitrary point in the 46.4 MB transcript to the nearest `ai-title`
// costs p50 38 KB but p95 227 KB, p99 511 KB and 723 KB worst case, because a
// single line in that file reaches 710 KB — one big tool result evicts every
// naming record from any window you picked. A 256 KB tail covers 95.9% of
// positions, 512 KB covers 99.1%, and the last percent still needs a megabyte.
//
// The structural one: it would be a second reader of bytes this process is
// already reading. `scanTranscript` keeps a per-path CURSOR and folds each
// appended line exactly once, for the model, the usage totals and the context
// counts alike. Folding two more fields into that pass (see
// `foldSessionNamingLine`) costs no read at all, sees every record rather than
// a window of them, and cannot be defeated by a 710 KB line.
//
// That also settles the trigger. With a tail read the trigger IS the cost
// control, so you have to pick a boundary and `Stop` is the honest one. With a
// cursor the bytes are read once whoever asks, so the trigger only decides how
// LATE the name appears — and gating on `Stop` would hold a name the scan
// already has until the turn ends, for a saving of zero. So this runs off any
// hook event like its three neighbours, throttled per session, and the throttle
// matches MODEL_READ_THROTTLE_MS so the two passes coincide and share one
// in-flight scan.
//
// The emit is what is actually kept rare, and it is gated on a CHANGE: with 685
// records carrying 2 distinct values, a per-pass emit would be ~683 events
// saying nothing. Sessions that never get named emit nothing at all.
const nameBySession = new Map();        // sid -> `${agentName}\0${aiTitle}`
const lastNameReadAt = new Map();       // sid -> ms timestamp
const pendingNameReads = new Set();     // sid currently being read

/** The naming the cursor has folded so far, or null when the scan has nothing.
 *  Exported beside readContextFromTranscript for the same reason: the rule is
 *  worth pinning directly rather than through a live server. */
export async function readSessionNamingFromTranscript(path) {
  const state = await scanTranscript(path);
  if (!state) return null;
  if (!state.agentName && !state.aiTitle) return null;
  return { agentName: state.agentName, aiTitle: state.aiTitle };
}

function maybeResolveSessionName(payload) {
  if (!payload || typeof payload !== "object") return;
  const sid = payload.session_id;
  const tp = payload.transcript_path;
  if (!sid || !tp) return;
  if (pendingNameReads.has(sid)) return;
  const now = Date.now();
  const last = lastNameReadAt.get(sid) ?? 0;
  if (now - last < MODEL_READ_THROTTLE_MS) return;
  lastNameReadAt.set(sid, now);
  pendingNameReads.add(sid);
  readSessionNamingFromTranscript(tp)
    .then(naming => {
      if (!naming) return;
      const sig = `${naming.agentName ?? ""}\u0000${naming.aiTitle ?? ""}`;
      if (nameBySession.get(sid) === sig) return;
      nameBySession.set(sid, sig);
      pushEvent({
        hook_event_name: "SessionNamed",
        session_id: sid,
        sessionName: naming.agentName ?? null,
        sessionTitle: naming.aiTitle ?? null,
      }, "internal");
    })
    .catch(() => {})
    .finally(() => pendingNameReads.delete(sid));
}

// ─── Context enrichment ──────────────────────────────────────────────────
// Approximation of `/context` since CC doesn't expose its breakdown via
// hooks. We scan the transcript JSONL for message counts (user / assistant
// / tool_use / tool_result / system-reminders) and walk up from cwd for
// any CLAUDE.md files in scope. Cumulative token totals come from
// UsageObserved; this scan produces the structural counts ("what does the
// context contain") plus the current window size — currentContextTokens, the
// last usage block after the most recent /clear or /compact, which is what
// the context donut and the modal's percentage are drawn from.
const lastContextReadAt = new Map();
const pendingContextReads = new Set();
const CONTEXT_READ_THROTTLE_MS = 4000;

// The counts reset at every `/clear` or `/compact` marker (see
// foldTranscriptLine): CC resets its in-memory window there while the JSONL
// keeps growing, and reading the pre-reset blocks made the donut report ~100%
// on an empty context.
export async function readContextFromTranscript(path) {
  const state = await scanTranscript(path);
  // Nothing folded yet — the file is empty, unreadable, or has no complete
  // line. Callers treat that as "no breakdown", same as before.
  if (!state || state.offset === 0) return null;
  return { ...state.ctx };
}

/** Longest slug CC will store verbatim. Anything longer is truncated here and
 *  given a hash suffix, so two deep paths sharing a 200-character prefix still
 *  get separate directories. */
const CC_SLUG_MAX = 200;

/** CC's hash of the *unencoded* path, used only for the truncation suffix:
 *  the classic h*31 + c string hash, kept in a signed 32-bit int. */
function ccPathHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/** Encode an absolute path the way CC stores it under
 *  ~/.claude/projects/<slug>/, so the auto-memory scan below looks in the
 *  directory CC actually wrote.
 *
 *  CC flattens *every* non-alphanumeric character to "-", not just the path
 *  separators and the Windows drive colon this used to replace. Dots are the
 *  ones that bite: a worktree under .claude/worktrees/, or any folder named
 *  like my.app, produced a slug with a literal dot in it, the readdir below
 *  missed, and the project's auto-memory files were quietly left out of the
 *  context panel. Underscores and spaces were wrong the same way. */
export function ccProjectSlug(cwd) {
  if (!cwd) return "";
  // resolve() gives the platform's own absolute form — "/Users/…" on
  // macOS/Linux, "C:\Users\…" on Windows — and this class covers both, so the
  // drive colon and the backslashes fall out of the general rule.
  const abs = resolve(cwd);
  const slug = abs.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= CC_SLUG_MAX) return slug;
  return `${slug.slice(0, CC_SLUG_MAX)}-${Math.abs(ccPathHash(abs)).toString(36)}`;
}

/**
 * Candidate memory-file paths on the walk from `cwd` up to the filesystem root.
 *
 * Both CLIs load their memory file the same way — nearest-first from the
 * working directory outwards — and differ only in what the file is CALLED and
 * in what else they add on top, so the walk is written once here and the two
 * scanners below supply their own names. `rels` is a list of paths RELATIVE to
 * each directory on the walk rather than bare filenames, because CC also honours
 * `.claude/CLAUDE.md` at every level and Codex does not.
 *
 * Sixteen levels is the same depth this has always used: deep enough for any
 * real checkout, shallow enough that a cwd on a network mount cannot turn one
 * context read into an unbounded number of stat() calls.
 *
 * Returns paths without touching the disk. Statting them is collectMemoryFiles'
 * job, so a caller that wants to add its own paths — a user-global file, a
 * per-project memory directory — can splice them into one ordered list and get
 * a single de-duplicated, existence-checked answer back.
 */
function memoryWalkPaths(cwd, rels) {
  const out = [];
  let dir = resolve(cwd);
  for (let depth = 0; depth < 16; depth++) {
    for (const rel of rels) out.push(join(dir, rel));
    const parent = pdirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Which of `paths` are real, non-empty files, in the order given and with
 * duplicates dropped.
 *
 * A zero-byte file is skipped on purpose: it contributes nothing to the model's
 * context, and listing it in the modal would have the reader looking for the
 * bytes it claims to cost. A path that cannot be stat()ed is simply absent —
 * this runs against a tree another process is editing, and a permissions error
 * on one candidate is no reason to lose the other fifteen.
 */
async function collectMemoryFiles(paths) {
  const found = [];
  const seen = new Set();
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      const s = await stat(p);
      if (s.isFile() && s.size > 0) found.push({ path: p, bytes: s.size });
    } catch {}
  }
  return found;
}

/** The memory files a CLAUDE session has in scope. Exported alongside its Codex
 *  counterpart below so a test can check the pair together — the two must agree
 *  on the walk and disagree on the filename, and only one of them showing up in
 *  a test is how they would drift. */
export async function scanClaudeMdFiles(cwd) {
  if (!cwd || typeof cwd !== "string") return [];
  // The CONFIG dir, not the home directory. CLAUDE_CONFIG_DIR relocates it
  // wholesale — it replaces ~/.claude rather than overlaying it — so on a
  // machine where it is set, `homedir()/.claude` is a directory Claude Code
  // does not read. Spelling it by hand here failed in both directions at once:
  // the user-global memory file and every auto-memory file went missing from
  // the modal and from the byte total beside it, while a stale ~/.claude left
  // over from before the variable was set got listed as if it were in context.
  // Resolved per call, like the two other claudeConfigDir() readers in this
  // file, so nothing captures the answer from an environment that has moved.
  const cfg = claudeConfigDir();
  // Walk up from cwd to filesystem root, checking the canonical CC memory
  // filenames plus CLAUDE.local.md (user-private) at each level.
  //
  // The `.claude/` prefix on the last two is NOT the config dir wearing a
  // second spelling: it is CC's per-directory project convention, one such
  // folder per level of the walk, and it stays literal however the config dir
  // moves.
  const paths = memoryWalkPaths(cwd, [
    "CLAUDE.md",
    "CLAUDE.local.md",
    join(".claude", "CLAUDE.md"),
    join(".claude", "CLAUDE.local.md"),
  ]);
  // User-global memory.
  paths.push(join(cfg, "CLAUDE.md"));
  paths.push(join(cfg, "CLAUDE.local.md"));
  // Per-project auto-memory: $CLAUDE_CONFIG_DIR/projects/<slug>/memory/*.md
  // (plus MEMORY.md index). CC injects these into context for sessions whose
  // cwd matches the slug. That directory sits beside the <sessionId>.jsonl
  // transcripts, so it moves with the config dir by construction.
  const slug = ccProjectSlug(cwd);
  if (slug) {
    const memDir = join(cfg, "projects", slug, "memory");
    try {
      const entries = await readdir(memDir);
      for (const f of entries) {
        if (f.toLowerCase().endsWith(".md")) paths.push(join(memDir, f));
      }
    } catch {}
  }
  return collectMemoryFiles(paths);
}

/**
 * The memory files a CODEX session has in scope: AGENTS.md, not CLAUDE.md.
 *
 * WHY THIS FUNCTION EXISTS AT ALL (#399). The context modal's third section was
 * fed by scanClaudeMdFiles for every session regardless of provider, so the
 * moment the donut became reachable for Codex the modal would have told a Codex
 * user "No CLAUDE.md files found on the path from cwd to ~/.claude" — naming a
 * file and a directory Codex does not read. Before this, `AGENTS.md` did not
 * appear anywhere in this repository.
 *
 * That Codex reads it is not an assumption. Sampled every rollout under this
 * machine's CODEX_HOME (structural search, no record content printed): the
 * literal string `AGENTS.md` appears on 9 lines across 5 of the 8 files — in the
 * `response_item/message` role=user preamble Codex prepends to a turn, in a
 * role=developer message, and in a `world_state` record — while `CLAUDE.md`
 * appears on zero lines in any of them.
 *
 * WHY THE FILESYSTEM AND NOT THE ROLLOUT. The rollout does name the files, but
 * only inside message TEXT, and reading the text of a user's conversation to
 * find a filename is not a trade this deck makes anywhere else — the Claude side
 * has always answered the same question by walking the filesystem, and the two
 * halves of one modal section should be derived the same way or the reader
 * cannot compare them.
 *
 * CODEX_HOME comes from codex-dir.mjs like every other Codex path in the
 * process (#375), so a relocated Codex home is honoured here without this
 * module growing a sixth spelling of the rule.
 *
 * Exported for the tests, like readContextFromTranscript beside it: the rule for
 * which files a session has in scope is worth pinning directly, rather than
 * through a watcher, a temp home and a 1.5s poll.
 */
export async function scanAgentsMdFiles(cwd) {
  if (!cwd || typeof cwd !== "string") return [];
  // Codex has no `.codex/AGENTS.md` per-directory convention to mirror CC's
  // `.claude/CLAUDE.md`, so the per-level list is the single filename.
  const paths = memoryWalkPaths(cwd, ["AGENTS.md"]);
  // The user-global instructions file, which Codex loads for every session
  // whatever the cwd — the counterpart of ~/.claude/CLAUDE.md.
  paths.push(join(CODEX_HOME, "AGENTS.md"));
  return collectMemoryFiles(paths);
}

function maybeResolveContext(payload) {
  if (!payload || typeof payload !== "object") return;
  const sid = payload.session_id;
  const tp = payload.transcript_path;
  const cwd = payload.cwd;
  if (!sid || !tp) return;
  if (pendingContextReads.has(sid)) return;
  const now = Date.now();
  const last = lastContextReadAt.get(sid) ?? 0;
  if (now - last < CONTEXT_READ_THROTTLE_MS) return;
  lastContextReadAt.set(sid, now);
  pendingContextReads.add(sid);
  Promise.all([readContextFromTranscript(tp), scanClaudeMdFiles(cwd)])
    .then(([breakdown, memoryFiles]) => {
      if (!breakdown && (!memoryFiles || memoryFiles.length === 0)) return;
      pushEvent({
        hook_event_name: "ContextObserved",
        session_id: sid,
        context: {
          ...(breakdown ?? {}),
          memoryFiles: memoryFiles ?? [],
        },
      }, "internal");
    })
    .catch(() => {})
    .finally(() => pendingContextReads.delete(sid));
}

// Throttle state for the Codex half of the same question. Separate maps rather
// than sharing maybeResolveContext's, because the two run on different triggers
// — a hook payload there, a batch of appended rollout lines here — and one
// session cannot be both.
const lastCodexMemoryReadAt = new Map();
const pendingCodexMemoryReads = new Set();

/**
 * Emit the memory files a Codex session has in scope, throttled per session.
 *
 * WHY THIS IS NOT maybeResolveContext (#399). That function early-returns
 * without `payload.transcript_path`, a field only Claude Code sends, and it
 * would scan for CLAUDE.md if it got that far. It is also unreachable from here
 * on a second count: pushEvent gates all of its enrichment on `source ===
 * "hook"`, and the Codex rollout watcher emits with source "codex" because it is
 * not a hook stream at all. So this is called from the watcher's own scan loop,
 * next to the lazy root, rather than off the back of an event.
 *
 * There is no structural breakdown alongside the file list, and that is the
 * honest answer rather than a gap: the counts the Claude side reports —
 * user/assistant messages, tool uses, tool results, system-reminders — come from
 * a regex scan of a transcript this deck has read from byte zero, and the
 * watcher deliberately SKIPS a pre-existing session's history at startup
 * (`state.offset = st.size`). Counting from the moment the deck attached would
 * produce five confident numbers that are all short by however much of the
 * session happened first, on a panel whose whole purpose is to say what is in
 * the window. ContextModal says so in the slot those counts would have used;
 * see codex-approval.ts for the same move on a different unanswerable question.
 *
 * WHY `persist` IS A PARAMETER (#447). Every other event the rollout watcher
 * produces goes out through emitCodexEvent, which carries the per-batch verdict
 * of writesCodexLog: several decks tailing one rollout all DRAW it, and exactly
 * one of them appends it to the events.jsonl they share. This function pushed
 * with no opts at all, so pushEvent fell back to writesLogFor — and that answers
 * from `foreignSessions`, a set only ever filled by noteLogWriter off an
 * incoming hook POST marked `?persist=0`. A Codex rollout never touches an HTTP
 * handler and Codex hooks are not installed any more (installer.mjs keeps the
 * provider for uninstall only), so a Codex session id can never appear in that
 * set and every deck answered "yes, mine" for this one event. The caller already
 * holds the verdict for the whole batch, so it is threaded in rather than
 * re-derived: recomputing it here would cost a second directory listing and
 * could disagree with the roots and tool calls the same batch just emitted.
 *
 * Omitting the argument keeps the old behaviour — write. That is the same
 * fail-safe writesCodexLog itself takes when a deck cannot find its own
 * discovery record: a line written twice is recoverable, a deck that quietly
 * records nothing is not.
 */
function maybeResolveCodexMemory(sid, cwd, persist) {
  if (!sid || !cwd) return;
  if (pendingCodexMemoryReads.has(sid)) return;
  const now = Date.now();
  const last = lastCodexMemoryReadAt.get(sid) ?? 0;
  if (now - last < CONTEXT_READ_THROTTLE_MS) return;
  lastCodexMemoryReadAt.set(sid, now);
  pendingCodexMemoryReads.add(sid);
  scanAgentsMdFiles(cwd)
    .then(memoryFiles => {
      // Nothing found is not a fact worth an event: the reducer merges a
      // ContextObserved into whatever the session already had, and an empty list
      // would only ever overwrite a real one with nothing. A repo that grows its
      // first AGENTS.md mid-session is picked up by the next throttled pass.
      if (!memoryFiles.length) return;
      // `persist` false means another deck tailing this same rollout was elected
      // to record it. The event is still buffered and broadcast from here, so
      // every deck's context modal lists the AGENTS.md files — it is only the
      // second copy on disk that is dropped, exactly as emitCodexEvent does it.
      pushEvent({
        hook_event_name: "ContextObserved",
        session_id: sid,
        provider: "codex",
        context: { memoryFiles },
      }, "internal", { persist });
    })
    .catch(() => {})
    .finally(() => pendingCodexMemoryReads.delete(sid));
}

// ─── Codex transcript enrichment ──────────────────────────────────────────
// Codex CLI hook payloads carry `session_id` but no transcript path. Sessions
// are persisted to ~/.codex/sessions/YYYY/MM/DD/rollout-<sid>.jsonl with one
// JSON object per line: {type, payload}. Token usage shows up in
//   {type:"event_msg", payload:{type:"token_count",
//     info:{total_token_usage:{input_tokens, cached_input_tokens,
//                              output_tokens, reasoning_output_tokens,
//                              total_tokens}}}}
// We resolve the rollout path lazily (cache sid→path), then read the tail
// for usage + model. CODEX_HOME overrides ~/.codex, and codex-dir.mjs owns that
// rule for every module on the Codex side — this one used to spell it inline,
// which is how five modules ended up with three spellings of it (#375).
//
// Re-exported because bin/deck.js prints this path in the boot banner, and it
// used to build its own `join(homedir(), ".codex", "sessions")` for the purpose
// — which ignored CODEX_HOME and so named a directory that does not exist on any
// machine that sets it. Handing out the binding the watcher itself reads, rather
// than a second computation of the same rule, is what makes the printed path and
// the tailed path unable to disagree.
export { CODEX_SESSIONS_DIR };
const codexRolloutPathBySid = new Map();
const lastCodexUsageReadAt = new Map();
const pendingCodexUsageReads = new Set();
const CODEX_READ_THROTTLE_MS = 2500;

async function findCodexRolloutPath(sid) {
  const cached = codexRolloutPathBySid.get(sid);
  if (cached) return cached;
  // Walk year → month → day → files, newest first. Codex includes the sid in the
  // filename (rollout-...-<sid>.jsonl) so a directory-scoped match is enough.
  // The walk itself lives in codex-dir.mjs, shared with the watcher's listing
  // below and with codex-usage.mjs, so all three read one tree the same way.
  let found = null;
  await walkRolloutDays((dayDir, files) => {
    const hit = files.find(f => f.includes(sid) && f.endsWith(".jsonl"));
    if (!hit) return;
    found = join(dayDir, hit);
    return STOP;
  });
  if (found) codexRolloutPathBySid.set(sid, found);
  return found;
}

/** Tail-read a Codex rollout JSONL. Returns the last token_count info block
 *  plus the most recent observed model + the session's model_context_window
 *  (set once from task_started). */
async function readCodexRollout(path) {
  try {
    const s = await stat(path);
    if (s.size === 0) return null;
    const fh = await open(path, "r");
    let text;
    try {
      const buf = Buffer.alloc(s.size);
      await fh.read(buf, 0, s.size, 0);
      text = buf.toString("utf8");
    } finally {
      await fh.close();
    }
    let lastUsage = null;
    let model = null;
    let contextWindow = null;
    let cwd = null;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const type = obj && obj.type;
      const pl = obj && obj.payload;
      if (type === "session_meta" && pl) {
        if (typeof pl.cwd === "string") cwd = pl.cwd;
        // session_meta sometimes carries the model in newer Codex versions.
        if (typeof pl.model === "string") model = pl.model;
      } else if (type === "event_msg" && pl) {
        if (pl.type === "token_count" && pl.info && pl.info.total_token_usage) {
          lastUsage = pl.info.total_token_usage;
        } else if (pl.type === "task_started" && typeof pl.model_context_window === "number") {
          contextWindow = pl.model_context_window;
        }
      } else if (type === "response_item" && pl && typeof pl.model === "string") {
        // Fallback model source — response items carry the model id.
        model = pl.model;
      }
    }
    if (!lastUsage && !model && !contextWindow) return null;
    return { usage: lastUsage, model, contextWindow, cwd };
  } catch {
    return null;
  }
}

function maybeResolveCodex(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.provider !== "codex") return;
  const sid = payload.session_id;
  if (!sid) return;
  if (pendingCodexUsageReads.has(sid)) return;
  const now = Date.now();
  const last = lastCodexUsageReadAt.get(sid) ?? 0;
  if (now - last < CODEX_READ_THROTTLE_MS) return;
  lastCodexUsageReadAt.set(sid, now);
  pendingCodexUsageReads.add(sid);
  (async () => {
    const path = await findCodexRolloutPath(sid);
    if (!path) return;
    const r = await readCodexRollout(path);
    if (!r) return;
    if (r.usage) {
      pushEvent({
        hook_event_name: "UsageObserved",
        session_id: sid,
        usage: r.usage,
      }, "internal");
    }
    if (r.model) {
      pushEvent({
        hook_event_name: "ModelObserved",
        session_id: sid,
        model: r.model,
      }, "internal");
    }
    if (r.contextWindow) {
      // Piggy-back on the model event with the window — reducer reads
      // model_context_window directly off any payload.
      pushEvent({
        hook_event_name: "ModelObserved",
        session_id: sid,
        model: r.model ?? undefined,
        model_context_window: r.contextWindow,
      }, "internal");
    }
  })()
    .catch(() => {})
    .finally(() => pendingCodexUsageReads.delete(sid));
}

// ─── Codex rollout watcher ────────────────────────────────────────────────
// Codex CLI hooks never fire on Windows — the elevated/unelevated sandbox
// refuses to spawn the hook command (exit 1, child never runs). So instead of
// relying on hooks, we tail the rollout JSONL files Codex writes to
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl and reconstruct the
// agent-dag event stream from them. Each rollout line is one append-only JSON
// object {timestamp, type, payload}; we map the relevant ones to the same
// synthetic hook payloads the reducer already understands:
//   session_meta                       → SessionStart
//   event_msg/user_message             → UserPromptSubmit (Codex ≤ 0.144)
//   event_msg/item_completed/UserMessage → UserPromptSubmit (Codex ≥ 0.147)
//   response_item/function_call        → PreToolUse
//   response_item/function_call_output → PostToolUse / PostToolUseFailure,
//                                        decided by the outcome line Codex
//                                        prepends to the output (codexCallFailed)
//   event_msg/token_count              → UsageObserved, and riding on it the
//                                        session's live context occupancy and
//                                        the CLI's own window (#399)
//   event_msg/task_started (+window)   → ModelObserved (context window)
//   event_msg/task_complete            → Stop (the turn finished)
//   event_msg/turn_aborted             → Stop (the turn was interrupted)
//   turn_context / response_item.model → model snapshot (ModelObserved on change)
//   turn_context.approval_policy       → session snapshot, spread onto every
//                                        payload below (#398); no event of its own
// There is deliberately no SessionEnd here: Codex writes no session-close
// record, so the end of a SESSION is still inferred by sweepStaleSessions.
// Nor is there anything that maps to `Notification`, and no synthetic one is
// invented: Codex writes no approval record to a rollout at all, so the deck
// cannot see a Codex session blocked on a human and does not pretend to — see
// codex-approval.ts for the evidence and for what is said instead of guessing.
// Events are emitted with source "codex" so pushEvent skips the Claude-only
// transcript enrichment (which needs transcript_path / hook events) but still
// broadcasts them exactly like a hook event, and persists them when this deck is
// the one elected to log this rollout — see writesCodexLog. This path is
// entirely additive — the Claude hook flow is untouched.
const codexFileState = new Map();      // path -> { offset, sid, cwd, skip, seenAt }
const codexSessionModel = new Map();   // sid -> last model string
// sid -> the `approval_policy` of the newest `turn_context` seen on this
// session. See codexObjToPayload for why this is read and what it is NOT used
// for; #398 for why the deck holds it at all.
const codexSessionApproval = new Map(); // sid -> last approval_policy string
// How long a rollout's tail cursor is kept after it stops showing up in the
// listing. The listing covers two day-directories, so anything missing from it
// is at least a day old and will never be appended to again.
const CODEX_STATE_TTL_MS = 10 * 60 * 1000;
let codexScanRunning = false;
let codexWatchTimer = null;
let codexWorkspace = "";

// How long one record's challenge verdict is trusted. The rollout scan runs
// every 1.5s and would otherwise pay a round trip per record per tick for an
// answer that changes about once per deck lifetime.
//
// Both answers are cached, and neither one delays a takeover, because the pid
// probe runs first and is not cached at all: a deck killed with SIGTERM or
// SIGKILL loses its pid immediately and its record is dropped on the very next
// tick whatever this map says. What the TTL bounds is only the ghost case — a
// record whose pid was recycled by an unrelated process — where five seconds of
// believing a stale "yes" is at most a few unwritten lines, against a directory
// listing plus an HTTP round trip on every tick of every deck forever.
const DECK_PROOF_TTL_MS = 5000;
// The same deadline hook.js gives a challenge, and for the same reason: a
// bodyless GET to a loopback port is sub-millisecond when a deck is there and an
// instant ECONNREFUSED when nothing is.
const DECK_CHALLENGE_TIMEOUT_MS = 400;
// `${pid}:${port}:${token}` -> { at, ok }. Keyed on the record's own identity so
// a rewritten record — a deck that restarted onto the same port with a fresh
// token — is a new question rather than an inherited answer.
const deckProofs = new Map();

/**
 * Is the process listening on this record's port the deck the record describes?
 *
 * WHY THE SERVER ASKS AT ALL (#695). readLiveDecks used to trust the pid and
 * nothing else, and a pid is not evidence: a record left behind by a deck that
 * is gone — SIGKILL, an OOM kill, a power cut, a console window closed on
 * Windows, none of which run the shutdown that unlinks it — passes a signal-0
 * probe forever once the OS hands that number to some other long-lived process.
 * writesCodexLog then elected it, because it named a lower port than any real
 * deck, and every deck tailing the rollout drew the events while none of them
 * appended a line. The canvas looked perfectly normal and events.jsonl stopped
 * growing, so nothing said so until a restart replayed a log that had stopped
 * days earlier.
 *
 * hook.js has had the answer to this since the handshake landed and the Codex
 * half never got it — this is that half. The record carries the deck's own token
 * in plaintext (mode 0600, same user, and it is written there precisely so that
 * another process can challenge with it), so we can ask its port to hash that
 * token against a nonce it has never seen. A stranger cannot answer; the deck
 * that wrote the file can.
 *
 * Two records pass without being asked:
 *
 *   • our own. We are the process the record describes, and challenging
 *     ourselves over loopback inside our own scan is a question we already know
 *     the answer to. It also must never fail: writesCodexLog looks itself up in
 *     this list, and a deck that cannot find its own record falls back to
 *     writing — so a self-challenge that timed out under load would turn one
 *     unwritten line into a duplicated one.
 *   • a record with no token, written by a deck older than the handshake. That
 *     is exactly requiresProof's fallback in hook.js, kept in step with it on
 *     purpose: refusing those would make every pre-1.33.71 deck invisible to the
 *     election, which elects a writer for a log those decks are still appending
 *     to.
 *
 * A timeout counts as a failure, like a refusal and a wrong answer. That is the
 * same verdict hook.js reaches — a target that misses the deadline is not posted
 * to either — and it errs the direction this file has always erred: the deck
 * writes, and "a line written twice is recoverable; a deck that quietly stops
 * recording anything is not" (writesCodexLog).
 */
async function provesDeck(d) {
  if (d.pid === process.pid) return true;
  if (typeof d.token !== "string" || d.token === "") return true;

  const key = `${d.pid}:${d.port}:${d.token}`;
  const cached = deckProofs.get(key);
  const now = Date.now();
  if (cached && now - cached.at < DECK_PROOF_TTL_MS) return cached.ok;

  const ok = await challengeDeck(d.port, d.token);
  deckProofs.set(key, { at: now, ok });
  // Records come and go; without this the map would grow by one entry per deck
  // that ever registered on this machine while the process is up.
  for (const [k, v] of deckProofs) {
    if (now - v.at >= DECK_PROOF_TTL_MS) deckProofs.delete(k);
  }
  return ok;
}

/**
 * One challenge round trip, resolving true only on a correct proof.
 *
 * The compare is constant-time for the reason hook.js's sameProof is: whatever
 * is on that port may not be a deck, and it must not be able to walk the
 * expected proof out of us one byte at a time by timing how long we take to hang
 * up. The nonce is fresh per call, so an answer overheard earlier is worth
 * nothing, and the token itself never leaves this process.
 */
function challengeDeck(port, token) {
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => { if (settled) return; settled = true; resolve(ok); };
    const nonce = randomBytes(16).toString("hex");
    const want = challengeProof(token, nonce);
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: `/api/hook-challenge?nonce=${nonce}`,
      method: "GET",
      timeout: DECK_CHALLENGE_TIMEOUT_MS,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return res.on("end", () => finish(false)); }
      let answer = "";
      res.setEncoding("utf8");
      res.on("data", c => {
        answer += c;
        // A deck answers in ~100 bytes. Anything pouring data at us is not one,
        // and must not be allowed to grow this buffer without bound.
        if (answer.length > 4096) { req.destroy(); finish(false); }
      });
      res.on("end", () => {
        if (settled) return;
        let proof;
        try { proof = JSON.parse(answer).proof; } catch { return finish(false); }
        finish(sameProof(proof, want));
      });
    });
    req.on("error", () => finish(false));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

/** hook.js's sameProof, for the same reason it is constant-time there. */
function sameProof(got, want) {
  if (typeof got !== "string") return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Every deck registered right now, as its own discovery record spells it — and
 * only the ones that proved they are still the deck their record describes.
 *
 * These are the files hook.js enumerates; this is the server reading them for
 * itself, because the rollout watcher has no hook to do it and still has to know
 * which other decks are tailing the same file into the same log. Dead pids are
 * ignored rather than unlinked — sweepStaleDiscovery owns that, and a poll
 * running every 1.5s is no place to be deleting other decks' registrations. A
 * record that fails the challenge is likewise left alone: see the same argument
 * spelled out in proveTargets in hook/hook.js.
 *
 * The pid probe stays, in front of the challenge, because it is free and it is
 * the one test that answers instantly when a deck is killed — which is what
 * keeps the takeover immediate rather than TTL-bound. See provesDeck.
 */
async function readLiveDecks() {
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const candidates = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(await readFile(join(dir, f), "utf8"));
      // Without both numbers there is nothing to group or tie-break on, so the
      // record cannot take part in an election either way.
      if (!d || typeof d.pid !== "number" || typeof d.port !== "number") continue;
      if (!isProcessAlive(d.pid)) continue;
      candidates.push(d);
    } catch { /* corrupt, or gone between listing and read */ }
  }
  // In parallel: with several decks up this is the difference between one 400ms
  // deadline for the scan and one per record.
  const proven = await Promise.all(candidates.map(provesDeck));
  return candidates.filter((_, i) => proven[i]);
}

// List rollout files from the newest 2 day-directories. New sessions always
// land in today's dir, so this captures live activity without scanning years
// of history every tick.
async function listRecentCodexRollouts() {
  const out = [];
  let dayDirs = 0;
  await walkRolloutDays((dir, files) => {
    for (const f of files) if (f.endsWith(".jsonl")) out.push(join(dir, f));
    // Two day-directories deep is the whole point of this listing: it runs every
    // tick, and anything older than that is a session no process will append to.
    if (++dayDirs >= 2) return STOP;
  });
  return out;
}

// Read the first complete JSON line of a rollout (the session_meta header)
// to learn sid + cwd before we start streaming. The header line can be large
// (base_instructions text runs tens of KB), so we read in growing chunks until
// we hit the first newline rather than guessing a fixed window.
async function readCodexHeader(path) {
  try {
    const size = (await stat(path)).size;
    if (size === 0) return null;
    const CHUNK = 65536;
    let upto = Math.min(CHUNK, size);
    let text = "";
    for (;;) {
      text = await readByteRange(path, 0, upto);
      const nl = text.indexOf("\n");
      if (nl >= 0) {
        const obj = JSON.parse(text.slice(0, nl));
        if (obj && obj.type === "session_meta" && obj.payload) {
          // Canonicalised here and nowhere else: everything downstream — the
          // workspace test below, the log election, the cwd on every event this
          // rollout produces — reads state.cwd, and this is the one place it is
          // read off disk. See canonicalCwd.
          return { sid: obj.payload.id, cwd: await canonicalCwd(obj.payload.cwd) };
        }
        return null;
      }
      if (upto >= size) return null;       // no newline in the whole file yet
      upto = Math.min(upto + CHUNK, size);  // grow and retry
      if (upto > 4 * 1024 * 1024) return null; // 4MB sanity cap on a single line
    }
  } catch {}
  return null;
}

/**
 * The human's prompt out of a 0.147-era `item_completed` item.
 *
 * `item.content` is an array of parts — every UserMessage observed carries a
 * single `{ type: "text", text, text_elements }` — so the parts are joined
 * rather than indexed, and a part with no string `text` contributes nothing
 * instead of printing "undefined" into the prompt the card shows.
 */
function codexItemText(item) {
  const parts = Array.isArray(item && item.content) ? item.content : [];
  return parts.map(p => (p && typeof p.text === "string" ? p.text : "")).join("");
}

// Map one parsed rollout object to a synthetic hook payload (or null to skip).
// Mutates codexSessionModel and returns { payload, modelEvent } where
// modelEvent is an optional ModelObserved to emit first when the model changed.
//
// Exported for the tests: this is the whole of the Codex translation, and the
// lifecycle it produces is worth pinning against the real reducer without
// standing up a watcher, a temp home and a 1.5s poll to get at it.
export function codexObjToPayload(obj, sid, cwd) {
  const type = obj && obj.type;
  const pl = (obj && obj.payload) || {};
  const model = codexSessionModel.get(sid);
  // Rides on every payload this function returns, exactly as `model` does and
  // for the same reason: it is a property of the SESSION rather than of any one
  // event, the rollout restates it on every turn, and a field spread onto each
  // payload needs no event of its own and self-heals on the next line the
  // watcher reads. The reducer stamps it on the root beside `contextWindow`.
  const approval_policy = codexSessionApproval.get(sid);
  const base = { session_id: sid, cwd, provider: "codex", approval_policy };

  // Track model from turn_context / response_item before mapping events.
  if (type === "turn_context") {
    if (typeof pl.model === "string") codexSessionModel.set(sid, pl.model);
    // #398: the deck used to read `model` out of this record and drop
    // everything else, and `approval_policy` was the field that mattered most
    // among the discarded ones. It is the ONLY recorded fact anywhere in a
    // rollout that says whether this session is even capable of stopping to ask
    // a human: at "never" Codex denies an escalation outright rather than
    // prompting, so a quiet session there is genuinely working, while at
    // "on-request" / "on-failure" / "untrusted" a quiet one may be parked on a
    // prompt the deck will never see.
    //
    // It is read to SAY that, and deliberately not to infer a block from it —
    // see codex-approval.ts. Codex persists no approval record of any kind (58
    // turn_contexts and ~1,100 records across the rollouts on this machine
    // carry no approval-shaped type; the persist filter keeps every *_end and
    // drops every request/begin — patch_apply_end with no patch_apply_begin,
    // web_search_end with no begin, item_completed with no item_started), so a
    // "waiting" state derived from this plus a pending call would be a guess
    // wearing the clothes of a measurement.
    //
    // Written on the record even when the value is missing or not a string, so
    // a future Codex that renames or drops the field clears the stale answer
    // rather than pinning the session to whatever it last said.
    if (typeof pl.approval_policy === "string" && pl.approval_policy) {
      codexSessionApproval.set(sid, pl.approval_policy);
    } else {
      codexSessionApproval.delete(sid);
    }
    return null;
  }
  if (type === "response_item" && typeof pl.model === "string") {
    codexSessionModel.set(sid, pl.model);
  }

  if (type === "event_msg") {
    if (pl.type === "user_message") {
      const prompt = typeof pl.message === "string" ? pl.message : "";
      return { ...base, hook_event_name: "UserPromptSubmit", prompt, model };
    }
    // Codex 0.147 stopped writing `user_message` and writes the same submission
    // as an `item_completed` carrying a `UserMessage` item instead. The two are
    // mutually exclusive per CLI version — across the rollouts sampled here the
    // 0.144 files have `user_message` and no `item_completed` at all, and the
    // 0.147 files have exactly one `UserMessage` item per turn and no
    // `user_message` — so handling both names emits one prompt per turn either
    // way rather than two on either version. The item is the human's typed text
    // only: the AGENTS.md preamble Codex prepends is written as a bare
    // `response_item` with role "user" and never gets an item of its own.
    //
    // This matters far beyond the prompt text. `UserPromptSubmit` is what puts
    // a settled root back to `active` (reducer.ts), so on 0.147 it is the ONLY
    // thing that reopens a session for its second turn — without it the `Stop`
    // below would trade "live forever" for "done forever", which is not better.
    if (pl.type === "item_completed" && pl.item && pl.item.type === "UserMessage") {
      return { ...base, hook_event_name: "UserPromptSubmit", prompt: codexItemText(pl.item), model };
    }
    // Codex states THREE numbers on every `token_count` and this branch used to
    // take one of them (#399). The other two are what the context donut is drawn
    // from, so the deck rendered no context readout at all for the only provider
    // that reports its window exactly.
    //
    // Measured across every rollout under this machine's CODEX_HOME — 178
    // `token_count` records, 164 on Codex 0.144.5 and 14 on 0.147.0 — all 178
    // carry `info.last_token_usage`, `info.total_token_usage` and
    // `info.model_context_window`. Nothing here is a new read: the line is
    // already parsed and the object already destructured.
    //
    //   total_token_usage    cumulative SPEND for the session. Every request's
    //                        prompt summed, so it counts the cached prefix again
    //                        on every turn and passes the context window many
    //                        times over inside one session (5,238,700 against a
    //                        258,400 window in the longest file here). Correct
    //                        for cost, meaningless as an occupancy figure.
    //
    //   last_token_usage     the MOST RECENT request: `input_tokens` is the whole
    //                        conversation Codex sent (it already contains the
    //                        cached prefix — see billedInputTokens), plus that
    //                        request's completion. `total_tokens` is exactly
    //                        input + output on 177 of the 178 records.
    //
    //   model_context_window the CLI's own ceiling, 258,400 for gpt-5.6 against
    //                        the 1,050,000 the static table guesses.
    //
    // WHY `last_token_usage.total_tokens` AND NOT `input_tokens`. The prompt-only
    // figure is the closer analogue of the Claude side, which sums the last usage
    // block's input + cache_read + cache_creation and leaves the completion out.
    // The difference is one response — 20 to 2,288 tokens in this sample, under
    // 1% of the window — and `total_tokens` wins on the case where they diverge
    // for real: on `thread_rolled_back` (the user rewinding the conversation)
    // Codex writes a `token_count` whose per-request components are all zero and
    // whose `last_token_usage.total_tokens` is the RECOMPUTED context size —
    // 47,355, down from 58,516 — while `total_token_usage` does not move at all,
    // because no request was made. Codex is using that field as "tokens in the
    // window", and reading `input_tokens` there would collapse the donut to 0%
    // at precisely the moment the number changed most.
    //
    // The window rides along too. `task_started` below is the only other carrier
    // and it fires once per turn, so a deck that attached mid-turn — the ordinary
    // case, since the watcher skips a pre-existing session's history at startup —
    // had to wait for the next turn before the donut could be scaled against
    // anything but the wrong static default.
    if (pl.type === "token_count" && pl.info) {
      const info = pl.info;
      const last = info.last_token_usage;
      const contextTokens = last && typeof last.total_tokens === "number" ? last.total_tokens : undefined;
      const window = typeof info.model_context_window === "number" ? info.model_context_window : undefined;
      // A record that states none of the three says nothing, and emitting an
      // event for it would put an empty envelope in the ring buffer and in the
      // persisted log for every reader to skip forever.
      if (!info.total_token_usage && contextTokens === undefined && window === undefined) return null;
      return {
        ...base,
        hook_event_name: "UsageObserved",
        usage: info.total_token_usage,
        model,
        model_context_window: window,
        context_tokens: contextTokens,
      };
    }
    if (pl.type === "task_started" && typeof pl.model_context_window === "number") {
      return { ...base, hook_event_name: "ModelObserved", model, model_context_window: pl.model_context_window };
    }
    // The end of a turn, which is the only end Codex ever announces. Both names
    // are one outcome as far as the deck is concerned — the turn is over and
    // nothing is running — so both settle the root the way Claude's own Stop
    // hook does. They are also exhaustive: across the rollouts sampled here
    // every `task_started` is answered by exactly one of the two (54 completes
    // + 1 abort for 55 starts), so no turn is left open by this mapping and
    // none is closed twice. `turn_aborted` is the Esc key, and it is the case
    // that matters most on the deck: pressing Esc is precisely when the user is
    // watching to confirm the thing stopped.
    //
    // Per TURN, not per session, and that is correct: Codex writes no
    // session-close record at all — a rollout simply stops growing when the
    // terminal goes away — so `sweepStaleSessions` remains the only thing that
    // ends a Codex *session*, and it must. What changes is that it now only
    // ever sees the sessions it was written for: the ones that died without
    // finishing. A turn that really ended is settled here, at the moment it
    // ended, with no `reaped` flag, because it was a finish and not a guess.
    if (pl.type === "task_complete" || pl.type === "turn_aborted") {
      return { ...base, hook_event_name: "Stop", model };
    }
    return null;
  }
  if (type === "response_item") {
    if (pl.type === "function_call") {
      let input = pl.arguments;
      try { input = JSON.parse(pl.arguments); } catch {}
      return { ...base, hook_event_name: "PreToolUse", tool_name: pl.name ?? "tool", tool_input: input, tool_use_id: pl.call_id, model };
    }
    if (pl.type === "custom_tool_call") {
      return { ...base, hook_event_name: "PreToolUse", tool_name: pl.name ?? "tool", tool_input: codexCustomToolInput(pl.name, pl.input), tool_use_id: pl.call_id, model };
    }
    // #397: the outcome, not just the fact that an outcome arrived. This used
    // to hardcode "PostToolUse" for both output types, and the reducer derives
    // `ok` from the event NAME (`tc.ok = name === "PostToolUse"`) — so `ok` was
    // structurally incapable of being false on the Codex path and a command
    // that exited non-zero drew exactly like one that succeeded. Every surface
    // that reads the flag inherited the lie: the burst dot, the tool row, the
    // ToolModal styling, the detail-panel error count, and the session
    // summary's "Errors" stat, which was therefore pinned at 0 for the life of
    // a Codex session. `PostToolUseFailure` is the name the reducer already
    // understands (it sets `ok = false` and writes an `errorPreview` from the
    // response); nothing but this mapper was missing.
    if (pl.type === "function_call_output" || pl.type === "custom_tool_call_output") {
      const tool_response = pl.output != null ? parseCodexOutput(pl.output) : undefined;
      const name = codexCallFailed(pl.output) ? "PostToolUseFailure" : "PostToolUse";
      return { ...base, hook_event_name: name, tool_use_id: pl.call_id, tool_response, model };
    }
  }
  return null;
}

/**
 * Wrap a `custom_tool_call`'s raw input under the key that describes what it
 * actually is.
 *
 * WHY THIS IS NOT JUST `{ patch: input }` ANY MORE (#417). Codex's
 * `custom_tool_call` container carries a bare string and nothing that says what
 * kind of string it is — the tool's NAME is the only discriminator. When this
 * branch was written the container had exactly one inhabitant, `apply_patch`,
 * so it hardcoded `patch` and was right. It is no longer the only inhabitant,
 * and on 0.147 it is not even the common one:
 *
 *   CLI      custom_tool_call name   count
 *   0.144.5  exec                       77
 *   0.144.5  apply_patch                 2
 *   0.147.0  exec                        6
 *
 * Eighty-three shell scripts were therefore filed on the deck as patches. The
 * client's `commandStringOf` reads `cmd` / `command` / `script` and never
 * `patch`, so no Codex call could show what it ran; `extractFilePath` mean-
 * while reads `patch` and tried to find a `*** Update File:` header in a
 * JavaScript program. Keying off the name fixes both directions at once.
 *
 * WHY `exec` GETS `script` AND NOT `command`. Because it is not a command. The
 * `exec` tool takes a small JavaScript program that calls into a `tools.*` API
 * — 83 of 83 inputs on this machine start with `const `, none parses as JSON,
 * all are multi-line — and Codex's own result wrapper calls it one, prefixing
 * the output with "Script completed" / "Script failed" rather than an exit code
 * (the line #397 reads). Filing a program under `command` would make the deck
 * draw the first token of the program as the command that ran, which is the
 * word `const` on every Codex call in the session. `script` is both true and
 * already understood by the client, which digs the real command out of the
 * program from there.
 *
 * WHY THE FALLBACK IS `input` AND NOT A GUESS. A name this function has never
 * heard of is a string whose meaning is unknown, and the one thing worse than
 * showing it under a neutral key is showing it under a confident wrong one —
 * that is the whole of this bug, repeated. `input` claims nothing; the tool's
 * own name still reaches the bubble, so an unrecognised Codex tool degrades to
 * "a tool I cannot read the arguments of" instead of "a patch".
 */
const CODEX_CUSTOM_TOOL_INPUT_KEY = {
  // A `*** Begin Patch … *** End Patch` document (2/2 observed, both 0.144.5).
  // Unchanged, and it has to stay unchanged: the client's extractFilePath()
  // pulls the edited file's path out of `input.patch` for the sub-bubble.
  apply_patch: "patch",
  // A JavaScript program. See above.
  exec: "script",
};

function codexCustomToolInput(name, input) {
  const key = CODEX_CUSTOM_TOOL_INPUT_KEY[name] ?? "input";
  return { [key]: input };
}

/**
 * The text parts of a Codex tool result, in the order Codex wrote them.
 *
 * Codex writes the result in two different containers and the deck sees both,
 * so this is where the difference stops. Across the rollouts sampled here:
 * `custom_tool_call_output.output` is an ARRAY of `{ type: "input_text", text }`
 * parts (85/85, on 0.144 and 0.147 alike), and `function_call_output.output` is
 * a bare string (32/32). The `{ output, metadata }` envelope `parseCodexOutput`
 * unwraps was written by neither, but it is cheap to keep tolerating and the
 * unwrapping already lives there, so the string case is routed through it
 * rather than duplicating the guess.
 */
function codexOutputParts(output) {
  if (output == null) return [];
  if (Array.isArray(output)) {
    return output.map(p => (p && typeof p.text === "string" ? p.text : ""));
  }
  const unwrapped = parseCodexOutput(output);
  return typeof unwrapped === "string" ? [unwrapped] : [];
}

/**
 * Did this Codex tool call actually fail?
 *
 * Codex prepends its own wrapper line to the tool's output and that line — not
 * any structured field — is where the outcome lives. Verified against every
 * tool result in this machine's CODEX_HOME:
 *
 *   0.144.5  exec         "Script completed"   75    "Script failed"   2
 *   0.147.0  exec         "Script completed"    6    (no failure observed)
 *   0.144.5  apply_patch  "Exit code: 0"        2
 *   0.144.5  exec_command / run — bare string, no wrapper line at all      32
 *
 * The two CLI versions spell it IDENTICALLY, which is why one rule covers both
 * and why this needs no version sniffing: 0.147 renamed the prompt event (see
 * the `item_completed` branch above) but left the exec wrapper alone.
 *
 * Only the FIRST part's FIRST line is read, and that precision is load-bearing
 * rather than tidiness. The wrapper line is at part index 0 in 85 of 85 results
 * that have one; the later parts are the command's own stdout, and the command
 * prints whatever it likes there. On this machine two exec results contain a
 * line reading "Script error:" in part 1 — output from a script that ran fine
 * under a wrapper that says "Script completed" — so a rule that scanned every
 * part would paint two successful calls red. `\r` is stripped because the same
 * wrapper is written by Codex on Windows.
 *
 * Silence means success, deliberately. A result with no wrapper line — every
 * `function_call_output` on 0.144, and whatever container a future Codex
 * invents — keeps today's behaviour of mapping to `PostToolUse`. Reporting an
 * unknown outcome as a failure would trade one wrong colour for another, and
 * this direction is the recoverable one: a missed failure is a call that draws
 * as it always has, while a false failure puts a red dot and an "Errors" count
 * on a session that did nothing wrong.
 */
function codexCallFailed(output) {
  const first = codexOutputParts(output)[0];
  if (typeof first !== "string") return false;
  const head = first.split("\n")[0].replace(/\r$/, "");
  if (/^Script failed\b/.test(head)) return true;
  // apply_patch reports itself with an exit code instead of a word. Anything
  // non-zero is a patch that did not apply.
  const exit = /^Exit code:\s*(\d+)/.exec(head);
  if (exit) return Number(exit[1]) !== 0;
  return false;
}

function parseCodexOutput(raw) {
  if (typeof raw !== "string") return raw;
  try {
    const o = JSON.parse(raw);
    return (o && typeof o.output === "string") ? o.output : raw;
  } catch {
    return raw;
  }
}

// `persist` is false when another deck tailing this same rollout was elected to
// write it to the log they share. The event is still buffered and broadcast —
// every deck watching the session draws it — it is only the second copy on disk
// that is dropped. See writesCodexLog in log-writer.mjs.
function emitCodexEvent(payload, persist) {
  pushEvent(payload, "codex", { persist });
}

// Emit the SessionStart root exactly once per file, lazily — only when the
// session actually produces an event. This keeps long-dead sessions that were
// merely on disk at startup from cluttering the canvas with empty roots.
function ensureCodexRoot(state, persist) {
  if (state.rootEmitted) return;
  state.rootEmitted = true;
  emitCodexEvent({ session_id: state.sid, cwd: state.cwd, provider: "codex", hook_event_name: "SessionStart" }, persist);
}

async function codexScanOnce(firstRun) {
  if (codexScanRunning) return;
  codexScanRunning = true;
  try {
    const now = Date.now();
    // Read at most once per scan, and only from the first rollout that actually
    // has new bytes: most ticks read nothing and must not pay a directory
    // listing for the answer to a question nothing is asking.
    let decksRead = null;
    const liveDecks = () => (decksRead ??= readLiveDecks());
    const files = await listRecentCodexRollouts();
    for (const path of files) {
      let st;
      try { st = await stat(path); } catch { continue; }
      let state = codexFileState.get(path);
      if (state) state.seenAt = now;

      if (!state) {
        // New file — read the header for sid + cwd, then decide whether to
        // capture it. Skip files outside our workspace.
        const header = await readCodexHeader(path);
        if (!header || !header.sid) continue; // not ready yet — retry next tick
        if (!codexCwdInWorkspace(header.cwd, codexWorkspace)) {
          codexFileState.set(path, { offset: st.size, sid: header.sid, cwd: header.cwd, skip: true, rootEmitted: false, seenAt: now });
          continue;
        }
        state = { offset: 0, sid: header.sid, cwd: header.cwd, skip: false, rootEmitted: false, seenAt: now };
        codexFileState.set(path, state);
        if (firstRun) {
          // On startup, skip a pre-existing session's history entirely — no
          // root, no replay. Only future appends (a live session that keeps
          // going) will lazily create the root via ensureCodexRoot.
          state.offset = st.size;
          continue;
        }
      }

      if (state.skip) { state.offset = st.size; continue; }
      if (st.size <= state.offset) continue;

      // Same bounded reader the Claude transcripts use. A rollout is not a
      // caller-chosen path, so this is not the #674 exposure — but the
      // allocation was the size of the appended bytes here too, and one chunk
      // per tick is more than any real rollout appends in a tick.
      const { text: consume, advanced } = await readAppendedLines(path, state, st.size);
      if (advanced === 0) continue; // no complete line yet

      // Decided per file rather than per line: which decks are up, and which of
      // them tail this rollout, cannot change inside one batch of appended
      // lines, and the answer must be the same for every event in it — a root
      // written by one deck and its tool calls by another is worse than either.
      const persist = !persistPath
        || writesCodexLog({ decks: await liveDecks(), pid: process.pid, cwd: state.cwd });

      for (const line of consume.split("\n")) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const prevModel = codexSessionModel.get(state.sid);
        const payload = codexObjToPayload(obj, state.sid, state.cwd);
        // If the model changed (turn_context/response_item), surface it.
        const nowModel = codexSessionModel.get(state.sid);
        if (nowModel && nowModel !== prevModel) {
          ensureCodexRoot(state, persist);
          emitCodexEvent({ session_id: state.sid, cwd: state.cwd, provider: "codex", hook_event_name: "ModelObserved", model: nowModel }, persist);
        }
        if (payload) {
          ensureCodexRoot(state, persist);
          emitCodexEvent(payload, persist);
        }
      }

      // Once per batch of appended lines rather than once per line — the scan
      // throttles itself per session, but the cheapest call is the one that is
      // never made, and a batch can be hundreds of lines. Gated on the root
      // existing so a session the deck has decided not to draw does not cost a
      // directory walk, and repeated rather than done once at root creation so
      // an AGENTS.md written after the session started is still found (#399).
      //
      // Carries the same `persist` verdict as every emit in the loop above, and
      // for the same reason: this is one more event about this batch of appended
      // lines, and a batch whose roots and tool calls went to one deck's log
      // while its memory list went to every deck's is the split the election
      // exists to prevent (#447).
      if (state.rootEmitted) maybeResolveCodexMemory(state.sid, state.cwd, persist);
    }

    // Rollout files fall out of the newest-2-days listing and never come back,
    // but their tail cursors used to live as long as the process did. Expire by
    // "not seen for a while" rather than "absent from this listing": a single
    // unreadable directory mid-scan would otherwise drop a live file's cursor,
    // and re-adding it at offset 0 replays that entire rollout as fresh events.
    for (const [p, s] of codexFileState) {
      if (now - (s.seenAt ?? 0) > CODEX_STATE_TTL_MS) codexFileState.delete(p);
    }
  } catch {
    /* swallow — watcher must never crash the server */
  } finally {
    codexScanRunning = false;
  }
}

export function startCodexWatcher(workspace) {
  codexWorkspace = workspace ?? "";
  // Deliberately not gated on CODEX_SESSIONS_DIR existing. `codex login`
  // creates ~/.codex, but sessions/ only appears when the first session
  // starts — and rollout tailing is the only Codex capture path there is, so
  // bailing out here meant a fresh install had to restart the deck before any
  // Codex agent ever showed up, while the banner claimed to be watching.
  // listRecentCodexRollouts returns [] while the directory is missing, so the
  // poll below is a cheap no-op that doubles as the existence re-check. A
  // filesystem watch is no help: fs.watch on a missing path throws, and
  // watching the parent recursively is macOS/Windows-only.
  //
  // Initial catalog: create roots for in-progress sessions, skip their
  // history, then poll for new lines.
  codexScanOnce(true).catch(() => {});
  codexWatchTimer = setInterval(() => { codexScanOnce(false).catch(() => {}); }, 1500);
  if (codexWatchTimer.unref) codexWatchTimer.unref();
  return codexWatchTimer;
}

/** Envelopes newer than `seq` from the ring buffer, oldest first. */
export function eventsSince(seq) {
  const after = Number(seq) || 0;
  return events.filter(e => e.seq > after);
}

// ─── Per-session cache expiry ────────────────────────────────────────────
// Every enrichment cache above is keyed by session id and nothing ever
// removed an entry: a deck left up for weeks — the 24/7 use this thing is
// built for — kept a model string, a subagent signature and four read-throttle
// stamps for every session it had ever seen, plus the Codex rollout path and
// model of each. SessionEnd is not a usable eviction signal (a killed CLI
// never sends one, and Codex has no such hook at all), so entries expire by
// least-recent use against a cap instead — the same shape pruneTranscriptScans
// already uses for its per-path state. The cap sits far above any plausible
// number of concurrent sessions, so a live session is never evicted; and an
// evicted one that speaks again simply re-reads its transcript.
const sessionTouchedAt = new Map();   // sid -> ms of the last event seen
const MAX_TRACKED_SESSIONS = 256;

function forgetSession(sid) {
  modelBySession.delete(sid);
  // The two the session-naming work added (#520/#522) and did not list here.
  // Both are keyed by session id and nothing else ever removed an entry, which
  // is the exact leak the comment above says this mechanism exists to end —
  // every sibling cache is capped at MAX_TRACKED_SESSIONS and these two were
  // not. The functional half is worse than the leak: nameBySession gates the
  // SessionNamed emit on "has this changed", so a live session evicted past the
  // cap and then heard from again re-emits its model (modelBySession was
  // cleared) and never re-emits its name. A tab that connects after the event
  // ring has rolled past the original SessionNamed shows that session unnamed
  // for the rest of its life.
  nameBySession.delete(sid);
  lastNameReadAt.delete(sid);
  modelLastReadAt.delete(sid);
  lastUsageReadAt.delete(sid);
  lastContextReadAt.delete(sid);
  codexRolloutPathBySid.delete(sid);
  lastCodexUsageReadAt.delete(sid);
  lastCodexMemoryReadAt.delete(sid);
  codexSessionModel.delete(sid);
  codexSessionApproval.delete(sid);
}

function touchSession(sid) {
  if (!sid || typeof sid !== "string") return;
  // Re-insert so the Map's own insertion order *is* the LRU order and eviction
  // below is one key read rather than a scan of every session ever seen.
  sessionTouchedAt.delete(sid);
  sessionTouchedAt.set(sid, Date.now());
  while (sessionTouchedAt.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessionTouchedAt.keys().next().value;
    sessionTouchedAt.delete(oldest);
    forgetSession(oldest);
  }
}

// ─── SSE backpressure ────────────────────────────────────────────────────
// A client that stops reading without closing its socket — a frozen tab, a
// suspended machine, a stalled `ssh -L` tunnel — never fires 'close' and never
// makes write() throw, so the old `try { res.write(line) } catch {}` had no
// way to notice it. On loopback nothing times the connection out either, so
// every event (tool responses run to megabytes) queued in that socket's write
// buffer for as long as the process lived.
//
// We drop the client rather than the events. EventSource reconnects after the
// `retry: 1500` we send on connect and resumes from Last-Event-ID, so the ring
// buffer replays whatever it missed. Dropping individual events instead would
// leave a hole the resume path cannot even see, the client's last id having
// moved past it.
//
// The ceiling has to clear the largest SINGLE frame the deck can emit, because
// one write() of such a frame puts the whole of it in the queue with nothing
// having had the chance to drain any of it — a client reading at full speed
// looks, for that instant, exactly like a frozen tab. #588 was exactly that
// failure: queuedBytes below doubled every reading, so the real ceiling was
// 4 MiB and one 4 MiB tool response hung up on every subscribed tab at once.
//
// So the number is checked against what `POST /api/event` admits rather than
// left to feel. handleEventIngest caps a body at 5,000,000 CHARACTERS. The
// event is re-serialized before it goes out, and re-serializing a value that
// came from JSON.parse of an N-character document cannot exceed N characters —
// every escape the output needs was already paid for in the input, and \uXXXX
// input comes back shorter — so one frame is at most 5,000,000 characters, plus
// this deck's envelope, measured at 127, plus the id/event/data framing. 8 MiB
// clears that by a little over 1.6x, and is the number this constant has always
// named; what #588 changed is that it now means it.
//
// Characters, not bytes, which is the one misleading thing left in the name.
// writeSse and writeResume write STRINGS, and a Writable with decodeStrings
// false — which both an OutgoingMessage and the net.Socket under it are — adds
// `chunk.length`, i.e. UTF-16 units, to its queue. Measured on Node 22.14: a
// 4,800,000-character Read of CJK text is 14,400,184 bytes on the wire and
// `res.writableLength` reports 4,800,311. That is why comparing this against a
// character-denominated ingest limit is the right comparison and comparing it
// against a byte count would not be — and it is worth stating plainly, because
// assuming a unit for writableLength instead of measuring it is the whole
// shape of the bug this comment exists to explain. The memory behind a full
// buffer is larger than the number says, up to two bytes per unit while it is
// held as a string; that is not what the cap is for, which is noticing a client
// that has stopped reading at all.
//
// Exported, with queuedBytes, so the arithmetic can be asserted directly. #588
// survived because it could only be observed through a live socket, where the
// existing tests' tolerances were wider than the error.
export const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * What this response has accepted and not yet handed to the kernel, in the
 * units writableLength reports it in — see MAX_CLIENT_BUFFER_BYTES above, which
 * is the number this is compared against.
 *
 * NOT the sum of the two writableLengths, which is what #588 was: Node's
 * `OutgoingMessage.writableLength` getter is `outputSize + this[kChunkedLength]
 * + (socket ? socket.writableLength : 0)`, so the socket's queue is already
 * inside it. For an SSE response, whose outputSize is zero from the moment the
 * headers flush, the two readings are the same number exactly — measured on
 * Node 22.14 against a paused reader, `res.writableLength=4194615
 * socket.writableLength=4194615` — so adding them reported exactly twice the
 * real backlog and made an 8 MiB constant behave as a 4 MiB one.
 *
 * Why max and not simply `res.writableLength`, which is today's whole answer.
 * That composition is a Node implementation detail and it has moved before, so
 * the expression is chosen to survive it moving again. Read the two as an
 * overlapping pair and take the larger:
 *   - composed as it is today, `own` already contains `sock`, so `own >= sock`
 *     and max is `own` — the exact total;
 *   - were the getter to stop including the socket term, `own` for a flushed
 *     SSE response is zero and max is `sock` — again the exact total;
 *   - with the socket detached (`res.socket` null, which happens between the
 *     response ending and the handle being released) max is `own`, the only
 *     reading there is.
 * Every case is right, and the failure mode if some future composition makes
 * both terms non-zero and disjoint is under-counting by at most 2x — a client
 * held a little longer than intended, which is the harmless direction. Summing
 * fails the other way, and dropping readers that are not behind is the bug.
 */
export function queuedBytes(res) {
  const own = typeof res.writableLength === "number" ? res.writableLength : 0;
  const sock = res.socket && typeof res.socket.writableLength === "number" ? res.socket.writableLength : 0;
  return Math.max(own, sock);
}

/** Hang up on a client we have decided not to keep. `delete` on a response
 *  that never made it into the set — the resume path below hangs up on clients
 *  before they are subscribed — is a harmless no-op. */
function dropSse(res) {
  sseClients.delete(res);
  // Destroying the socket is what makes the request emit 'close', which is
  // where the ping interval is cleared.
  try { res.destroy(); } catch {}
  try { res.socket?.destroy(); } catch {}
}

/** Write one SSE frame, hanging up on a client too far behind to keep. */
function writeSse(res, frame) {
  try {
    res.write(frame);
    if (queuedBytes(res) <= MAX_CLIENT_BUFFER_BYTES) return;
  } catch { /* already dead — drop it below */ }
  dropSse(res);
}

// How long a resuming client is given to accept the bytes already queued for
// it before the deck concludes it is not reading at all. Generous on purpose:
// what it has to work through is a full MAX_CLIENT_BUFFER_BYTES, the link may
// be an `ssh -L` tunnel rather than loopback, and dropping a client that is
// merely slow costs it the whole replay. A tab that is genuinely frozen will
// not accept a byte in any budget, so the only thing a long one buys it is a
// few more seconds of holding its own buffer. The environment override exists
// so the tests can pin the drop without sitting through the real budget.
//
// It is a budget per awaited frame, and what that frame waits on is everything
// queued ahead of it draining — a full MAX_CLIENT_BUFFER_BYTES, by
// construction, since that is what the loop fills to before it stops. So this
// states a minimum rate a resuming client has to manage, and #588 doubled that
// flush in practice without touching this line: the cap it is sized against was
// really 4 MiB and is now the 8 MiB it always said. Still generous — measured
// on loopback a full cap flushes in about a quarter of a second.
const REPLAY_DRAIN_MS = Number(process.env.AGENTS_DECK_REPLAY_DRAIN_MS) > 0
  ? Number(process.env.AGENTS_DECK_REPLAY_DRAIN_MS)
  : 30_000;

/**
 * Write one frame of the resume stream under the same ceiling the live path
 * obeys, waiting rather than dropping when the client is at it. Resolves true
 * while the client is worth keeping, false once it is not.
 *
 * Waiting is the whole difference from writeSse, and the replay is why. The
 * live path writes one frame per event, so a full buffer there means the
 * client stopped reading and the only answer is to hang up. Here the burst is
 * ours: the loop below hands the socket the entire ring buffer in one turn of
 * the event loop, so even a client reading at full speed sees its buffer fill
 * — nothing has drained it yet, because nothing could. Dropping on that would
 * hang up on healthy clients, and hang up on them again every time they came
 * back: EventSource reconnects with the same Last-Event-ID, meets the same
 * oversized replay, and is dropped again 1.5 seconds later, forever. So we
 * stop writing until the socket has taken what it already has, and only give
 * up on a client that takes nothing at all for REPLAY_DRAIN_MS.
 *
 * The wait is on write()'s completion callback rather than on a 'drain' event:
 * 'drain' fires only after a write that was answered false, so waiting on it
 * means depending on an answer this call may never have seen. The cap sits far
 * above the stream's own 16 KiB high-water mark, so by the time queuedBytes is
 * at the cap the `false` that a 'drain' would eventually answer belongs to some
 * frame long since written, and its drain may already have come and gone. The
 * callback fires once this chunk —
 * and therefore everything queued ahead of it — has reached the OS, which is
 * exactly the condition being waited for. It also fires, with an error we do
 * not need to read, if the response is destroyed underneath us, so this cannot
 * hang on a client that goes away.
 */
async function writeResume(res, frame) {
  // Below the cap this is the plain write it has always been. The `await` in
  // the caller costs a microtask and nothing else: the checkpoint drains
  // before the loop can accept I/O, so no live event can slip between two
  // replay frames the way it could across a real wait.
  if (queuedBytes(res) <= MAX_CLIENT_BUFFER_BYTES) {
    try { res.write(frame); return true; } catch { return false; }
  }
  return new Promise(resolve => {
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // Unref'd so a client that stopped reading can never be the reason the
    // process stays alive, and cleared on every path out so a completed replay
    // leaves no timer behind.
    const timer = setTimeout(() => done(false), REPLAY_DRAIN_MS);
    timer.unref?.();
    try { res.write(frame, () => done(!res.destroyed)); }
    catch { done(false); }
  });
}

// What a redacted occurrence of the deck's token is replaced with. A visible
// marker rather than an empty string, because the reader of a mangled Bash
// output deserves to know the deck did it and why, and because the UI renders
// payload strings verbatim — a silent hole would look like a truncated tool
// response and get debugged as one.
const TOKEN_REDACTED = "[redacted: ccdeck token]";

/**
 * Take the deck's own token back out of an event, before anything stores it.
 *
 * #366 made HOOK_TOKEN the one credential separating "may read" from "may
 * mutate", and there is a path that copies it into a store needing no
 * credential to read. `POST /api/event` is deliberately open — hook/hook.js is
 * installed outside this package, into the user's ~/.claude, so requiring a
 * credential there would silence every session whose hook predates that change
 * — while `GET /api/events`, `GET /events` and events.jsonl are all readable
 * without one. So an agent session that merely LOOKS at the discovery file puts
 * the token into the ring buffer, and that is not an exotic act: `cat
 * ~/.claude/agent-dag/<pid>.json`, a `Read` of it, or a plain `grep -r
 * ~/.claude` all do it, and CC records both the tool input and the tool
 * response. From the buffer it is served to exactly the two callers #366 was
 * written for — the other local UID and the sandboxed subprocess — neither of
 * which can open the discovery file itself but both of which reach the API. For
 * them this turned "cannot mutate" back into "can mutate", the token read out
 * of the event log being the whole of the new gate. What keeps those two out of
 * the discovery file itself — a mode bit on Unix, the profile directory's ACL
 * on Windows, where the chmod is a no-op — is spelled out at presentsDeckToken.
 *
 * Why this sits in pushEvent and not in handleEventIngest, which is where the
 * report first put it. Events reach the buffer through more than one door:
 * handleEventIngest is the hook's, emitCodexEvent is the Codex rollout
 * watcher's — those events never pass through an HTTP handler at all —
 * replayLog is the boot replay's, `/api/clear` pushes its own marker, and six
 * enrichment sites push synthetic events off the back of a transcript read.
 * Redacting at the ingest handler covers one of those and leaves the next route
 * somebody adds uncovered. pushEvent is the one point every event passes
 * through exactly once, so the check is written once and cannot be forgotten.
 *
 * Why a walk over the string values rather than
 * `JSON.stringify(payload).includes(token)`, which is the obvious one-liner.
 * Measured rather than assumed, on 4.7k real payloads out of a 21MB
 * events.jsonl (mean 5KB serialized): the walk costs 1.3–3.6 µs per event and
 * serialize-then-search costs 14–48 µs, the same order as the JSON.parse the
 * ingest path already pays for the body. Serializing here would also defeat the
 * deliberate optimization below, which skips serializing ENTIRELY when nothing
 * is subscribed and nothing is being logged — a headless deck, and the boot
 * replay of a log that only rotates at 50MB. The walk allocates nothing at all
 * until it finds something.
 *
 * Iterative rather than recursive on purpose. The payload arrives from
 * JSON.parse of a body capped at 5MB, which is free to nest as deeply as it
 * likes, and a recursive scan would be a new way to overflow the stack inside
 * the request listener — where nothing catches it.
 *
 * Scope is the token and nothing else in the discovery file. pid, port,
 * workspace, the log path and startedAt are not credentials — /api/health
 * already answers with the workspace path — and redacting the workspace would
 * mangle the `cwd` of every honest event the deck draws.
 *
 * What this does NOT catch, stated plainly so nobody mistakes it for more. A
 * token split across two string fields, or across two events, survives — but
 * every substring search has that shape, and the halves are individually
 * worthless: secretEquals is byte-exact, so a partial token authenticates
 * nothing. Case is not folded for the same reason; HOOK_TOKEN is lowercase hex
 * and an uppercased copy would not authenticate either.
 *
 * And this is not a new oracle. A caller who can POST here and read
 * /api/events can post a guess and watch whether it comes back redacted, which
 * tells them precisely what `x-ccdeck-token: <guess>` on any protected route
 * already tells them — against 256 bits with no structure to search.
 *
 * Returns the payload, because a top-level JSON string is a legal body for
 * `POST /api/event` and a primitive cannot be redacted in place.
 */
function redactDeckToken(raw) {
  // Read at call time, not at definition time: HOOK_TOKEN is declared far
  // below this line and nothing calls pushEvent during module evaluation.
  const token = HOOK_TOKEN;
  if (typeof raw === "string") return raw.includes(token) ? raw.replaceAll(token, TOKEN_REDACTED) : raw;
  if (raw === null || typeof raw !== "object") return raw;

  const stack = [raw];
  while (stack.length > 0) {
    const node = stack.pop();
    // Arrays and objects are walked separately because an indexed loop over an
    // array is markedly cheaper than `for…in` over one, and this runs on every
    // event: a single PostToolUse response can be an array of thousands.
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string") {
          if (v.includes(token)) node[i] = v.replaceAll(token, TOKEN_REDACTED);
        } else if (v !== null && typeof v === "object") stack.push(v);
      }
    } else {
      // `for…in` is safe on these: they come from JSON.parse or from an object
      // literal in this file, so the prototype chain is Object.prototype, which
      // has nothing enumerable. A `"__proto__"` key in the posted JSON becomes
      // an OWN data property — JSON.parse does not run the setter — so it both
      // enumerates here and takes the assignment below as an ordinary write,
      // leaving the prototype alone.
      for (const k in node) {
        const v = node[k];
        if (typeof v === "string") {
          if (v.includes(token)) node[k] = v.replaceAll(token, TOKEN_REDACTED);
        } else if (v !== null && typeof v === "object") stack.push(v);
      }
    }
  }
  return raw;
}

function pushEvent(raw, source, opts = {}) {
  // First, before anything below can see it: the deck's own credential does not
  // belong in a store that is served without one. Every entry point to the
  // buffer, the SSE fan-out and events.jsonl passes through here, so this is
  // the single line that keeps it out of all three. See redactDeckToken.
  raw = redactDeckToken(raw);

  // Synchronous enrichment: if we already know this session's model, stamp
  // it on the payload so the client's recursive scanner picks it up.
  if (raw && typeof raw === "object" && raw.session_id && !raw.model) {
    const modelId = cachedModelId(modelBySession.get(raw.session_id));
    if (modelId) raw.model = modelId;
  }

  const seq = nextSeq++;
  const evt = {
    seq,
    epoch: SEQ_EPOCH,
    receivedAt: opts.receivedAt ?? Date.now(),
    source,
    payload: raw,
    // Charged once, here, and carried on the envelope so eviction never has to
    // walk a payload a second time. Symbol-keyed, so it is invisible to the two
    // JSON.stringify calls below and to the `{ ...e }` the replay loop makes.
    // Charged AFTER redactDeckToken, like everything else in this function: the
    // payload being measured is the one that will be stored.
    [CHARS]: ENVELOPE_CHARS + payloadChars(raw),
  };
  events.push(evt);
  bufferedChars += evt[CHARS];

  // Evict oldest-first until BOTH bounds hold — the count that has always been
  // here, and the byte budget #625 added. See MAX_BUFFER_CHARS for the numbers.
  //
  // Counted first and spliced once, rather than shifting in a loop, because the
  // two bounds evict at very different scales. The count bound drops exactly
  // one entry per push; the byte bound can drop hundreds, since twenty-seven
  // maximum-size events fill the whole budget on their own, and a shift per
  // entry would memmove the array once for each of them.
  //
  // `drop < events.length - 1` is what keeps the event just pushed, whatever it
  // weighs. A single event is allowed to be larger than the entire budget —
  // ingest admits 5,000,000 characters, and a Codex rollout line read off disk
  // has no length bound at all — and evicting it on arrival would leave
  // pushEvent returning an envelope that `GET /api/events` never shows and no
  // resuming client can ever be handed: a hole with no id to ask for it again,
  // which is the exact failure the resume path below is written to avoid. So
  // the true ceiling is MAX_BUFFER_CHARS plus one event, and that is stated
  // here rather than pretended away.
  //
  // What this does to a resuming client is what the count bound has always done
  // to one, only sooner: the head of the ring moves, and events that fell off
  // it are gone for anybody who had not been sent them yet. That is the
  // existing bargain for a too-old Last-Event-ID — handleSse replays whatever
  // is still held and the client's `lastSeq` steps forward over the gap — and
  // the byte bound deliberately reuses it rather than inventing a second answer.
  // The difference worth knowing is that the head can now move in jumps rather
  // than one entry at a time; resumeSse's per-pass snapshot is what makes that
  // safe for a replay already in flight.
  let drop = 0;
  let freed = 0;
  while (drop < events.length - 1
    && (events.length - drop > MAX_BUFFER || bufferedChars - freed > MAX_BUFFER_CHARS)) {
    freed += events[drop][CHARS];
    drop++;
  }
  if (drop > 0) {
    events.splice(0, drop);
    bufferedChars -= freed;
  }

  // Does this event reach the log at all? Not on a replay (it came from
  // there), not when the hook told us another deck owns this session's log,
  // and not when we have no log. Decided before serializing because it is half
  // of the answer to whether serializing is worth doing.
  const persisting = persistPath && !opts.replay && opts.persist !== false && writesLogFor(raw);

  // One serialization, shared by both consumers — and skipped entirely when
  // neither wants it. This used to stringify the whole envelope twice on the
  // hottest path in the process (once for the SSE frame, once for the persist
  // line), and built the frame even with nobody subscribed: a headless deck
  // paid a full stringify per event for a string no one read, and boot replay
  // — which runs before the listener exists and never broadcasts — paid one
  // for every line of a log that rotates at 50MB. An event this deck is not
  // logging is still broadcast, so a subscriber alone is reason enough.
  //
  // Contained, because this line was fatal. `JSON.stringify` walks a value
  // recursively while `JSON.parse` does not, and the gap between the two is
  // enormous: measured on Node 22.14, parse accepts a body nested 4,194,303
  // deep and stringify gives up on the result at 4,021. So a payload in that
  // window parses cleanly and then throws `RangeError: Maximum call stack size
  // exceeded` out of here — and there is no promise on this path for the
  // route's `guard` to catch, because pushEvent is reached from inside a raw
  // `req.on("end")` listener. It was an uncaughtException, and Node's answer to
  // those is to exit. Measured against the real server: one POST of 24,378
  // bytes, nested 4,050 deep, to the credential-free `/api/event` — a
  // two-hundredth of the 5,000,000-character ingest cap — and the deck was
  // gone, with nothing on the socket to tell the poster why.
  //
  // The payload leaves the ring, not just this string, and that is the point.
  // `events.push` above already took the envelope, and a value nothing can
  // serialize is a value no reader can ever deliver: every `Last-Event-ID`
  // resume that replays it and every `GET /api/events` that writes it would
  // meet the same throw for as long as it stayed in the buffer, so one small
  // POST would poison both routes for the life of the entry. The envelope
  // therefore keeps its `seq` and loses its payload — the same replacement
  // envelopeJson makes for a reader, made once at the write instead of on every
  // read, and the same bargain about `seq`: a caller paging with `?since=`
  // walks past the hole rather than asking forever for what it cannot be given.
  //
  // Admitted as a stub rather than refused at ingest with a 400, deliberately.
  // Three of pushEvent's four callers have no HTTP peer to answer — Codex
  // rollout lines read off disk, the boot replay of events.jsonl, the synthetic
  // events the transcript scanners emit — so the containment has to live here
  // whatever the ingest route does, and a 400 on top would be a second
  // mechanism for a case this one already covers. It would also have to be paid
  // for: knowing a payload will not serialize means serializing it, which is
  // the second stringify per event on the hottest path in the process that the
  // paragraph above exists to have removed. The reason goes to stderr and not
  // to the wire, under the rule sendInternalError explains.
  let json = null;
  if (sseClients.size > 0 || persisting) {
    try {
      json = JSON.stringify(evt);
    } catch (err) {
      console.error(`${PRODUCT}: event ${seq} could not be serialized:`, err);
      evt.payload = null;
      evt.unserializable = true;
      json = JSON.stringify(evt);
    }
  }

  if (sseClients.size > 0) {
    const line = `id: ${seq}\nevent: hook\ndata: ${json}\n\n`;
    // writeSse may drop a client mid-loop; deleting from a Set while iterating
    // it is well defined and skips only the entry removed.
    for (const res of sseClients) writeSse(res, line);
  }

  if (persisting) {
    // Fire-and-forget append. JSONL = newline-delimited JSON, so the whole line
    // has to reach the file as one write — this used to be `appendFile`, which
    // splits anything over 512 KiB into separate appends and let another
    // event land in the middle of a large tool response. See appendLogLine.
    //
    // Note this runs AFTER redactDeckToken above, as every path to the log
    // does: the string being written is the one serialization of the event the
    // SSE frame also used, and the token was taken out of the payload before
    // either existed.
    appendLogLine(persistPath, json + "\n");
    // Cheap throttled check (every 30s) — only rotates if file > 50MB.
    maybeRotatePersistFile();
  }

  // Note the session so the caches the scanners below fill can expire by
  // least-recent use. Replays are excluded: they fill nothing, and a boot
  // replay of a log spanning weeks would otherwise churn the whole LRU through
  // dead session ids before the first live event even arrives.
  if (!opts.replay && raw && typeof raw === "object") touchSession(raw.session_id);

  // Kick off async transcript scans. Model and usage are both re-read
  // periodically (throttled to 2.5s per session) so the cost columns track
  // running totals as the session progresses and late subagent models still
  // land; ModelObserved is only emitted when the resolved set changes. Both
  // result in synthetic events.
  // Provider gates the path: Claude reads transcript_path; Codex reads its
  // rollout JSONL under ~/.codex/sessions/. The Claude scanners short-circuit
  // when transcript_path is absent (always the case for Codex hooks).
  if (source === "hook" && !opts.replay) {
    if (raw && raw.provider === "codex") {
      maybeResolveCodex(raw);
    } else if (!raw?.transcript_path || isClaudeTranscriptPath(raw.transcript_path)) {
      // The gate is here, once, rather than repeated in the four scanners
      // below it: this is the single door a caller-chosen path comes through,
      // and all four read the same field off the same payload. A payload with
      // no transcript_path at all still goes through — every one of them
      // early-returns without it, and Codex hooks never send one — so the
      // ordinary event costs nothing but the absent-field test.
      maybeResolveModel(raw);
      maybeResolveUsage(raw);
      maybeResolveContext(raw);
      maybeResolveSessionName(raw);
    } else {
      noteRefusedTranscript(raw.transcript_path);
    }
  }

  return evt;
}

/**
 * Which of the log's events belong on THIS deck's canvas — the boot replay's
 * half of `--workspace`, and the half that did not exist (#696).
 *
 * `--workspace` filtered the two LIVE capture paths and nothing else. The log is
 * the machine-wide `<claude config dir>/agent-dag/events.jsonl` that every deck
 * on the box shares by default, and `replayLog` pushed all of it, so a deck
 * started with `--workspace ~/proj` came up with every session on the machine
 * already drawn — including the ones it had just printed it would not capture,
 * contradicting its own `workspace` row, README.md and the empty-state sentence
 * in src/web/scope.ts that exists precisely so the canvas stops asserting things
 * that are not true (#404).
 *
 * THE RULE IS NOT A NEW ONE. Per event it is `codexCwdInWorkspace`, the same
 * predicate the Codex watcher runs and the twin of `capturesSession` in
 * hook/hook.js — the two are pinned equal by a test walking one table of paths
 * through both, so `--workspace` means one thing on every path a payload can
 * reach the ring by, including this one. Nothing about case folding, separators
 * or the sibling-prefix trap (`/srv/projX` is not inside `/srv/proj`) is decided
 * here; it is decided there, once, per platform.
 *
 * WHAT THE MAP IS FOR. Not every line carries a cwd. The synthetic enrichment
 * events the transcript scanners emit — `ModelObserved`, `UsageObserved`,
 * `SessionNamed`, `ContextObserved` — carry `session_id` and nothing else, and
 * they are persisted like any other event. Judging those by the live rule alone
 * (no cwd, so inside no workspace) would keep an in-scope session on the canvas
 * while stripping its model, its token columns and its name until the next live
 * event arrived. So the answer for a session is learned from the events that DO
 * say where they run and carried forward to the ones that do not.
 *
 * That is a reconstruction of the live behaviour rather than a second notion of
 * scope: live, a deck only ever emits `ModelObserved` for a session whose hook
 * event it already accepted, so "follows its session" is what those events
 * already do — the map only re-derives it from a file. It costs one entry per
 * distinct session id in the log (a few thousand at the very most, against a log
 * measured in tens of megabytes) and one lookup per line.
 *
 * TWO CASES DECIDED EXPLICITLY:
 *
 *   * `__clear` — the control marker `/api/clear` writes after truncating, with
 *     `cwd: ""`. It is not a session event; it is the instruction that makes the
 *     reducer forget everything before it. Dropping it on a scoped deck would
 *     replay the state a user had explicitly cleared, so it is always admitted.
 *   * a payload with no cwd and no session the map has seen — refused on a
 *     scoped deck, which is exactly what `capturesSession` decides live for a
 *     session that never said where it runs.
 *
 * An unscoped deck (`workspace === ""`, the default) admits everything, and
 * takes the cheapest possible path to saying so.
 *
 * @param {string} workspace this deck's canonical workspace; "" for machine-wide
 * @returns {(payload: unknown) => boolean} called once per replayed envelope, in
 *   log order — it remembers, so the order matters and it is not reusable across
 *   two replays.
 */
export function replayScope(workspace, platform = process.platform) {
  if (!workspace || typeof workspace !== "string") return () => true;
  const bySession = new Map();
  return function admits(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.hook_event_name === "__clear") return true;
    const sid = typeof payload.session_id === "string" ? payload.session_id : null;
    const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : null;
    if (cwd) {
      const inside = codexCwdInWorkspace(cwd, workspace, platform);
      if (sid) bySession.set(sid, inside);
      return inside;
    }
    if (sid && bySession.has(sid)) return bySession.get(sid);
    return false;
  };
}

/**
 * Read the log back into the ring buffer at boot.
 *
 * A line that will not parse is skipped rather than thrown on, and that is
 * deliberate — it is what lets a log damaged by the pre-#446 writer still
 * replay. Every line before the damage and every line after it is whole, so
 * stopping at the first bad one would throw away the rest of the session for a
 * fault that costs one event. Newline framing is what makes the recovery
 * possible: a torn write leaves the reader resynchronised at the very next
 * `\n`, with no length prefix to have been lost along with the bytes.
 *
 * What changed is that the skip is no longer silent. Before, a deck whose log
 * had been shredded replayed "mostly" and said nothing anywhere: the largest
 * tool responses and whatever ordinary event was spliced into them were gone,
 * with no counter and no line on the terminal. The count below is the only
 * signal that a log carries damage from a writer that has since been fixed, and
 * the byte total is what tells the user whether it was one truncated tail from
 * a kill -9 or a megabyte of shredded tool output.
 *
 * Deliberately one line, and deliberately without the path in it: this prints
 * onto a terminal the deck is about to paint over (see oneLine in term.mjs for
 * what a multi-line message does there), and the path was already printed at
 * boot by the caller.
 *
 * `workspace` is what makes the replay agree with the two live capture paths —
 * see replayScope. An out-of-scope line is NOT counted into `skipped` and is not
 * warned about: `skipped` means "this log has bytes in it no reader can parse",
 * which is damage and is worth a line on the terminal, while a scoped deck
 * declining a session it was told not to capture is the flag doing its job. They
 * are two different things and only the first is ever printed.
 *
 * WHAT THE FILTER COSTS AT BOOT, honestly: nothing is saved on the read. Every
 * line is still streamed off disk and still JSON.parsed, because the cwd being
 * judged is inside the JSON — a 30 MB log is 30 MB of reading and parsing on a
 * scoped deck exactly as on an unscoped one. What it saves is everything after
 * the parse: no redaction pass, no envelope, no ring insert, no character
 * accounting and no eviction pressure for a line this deck should never have
 * held. The ring is bounded by MAX_BUFFER events AND MAX_BUFFER_CHARS, so on a
 * busy machine the out-of-scope traffic was not merely extra — it was evicting
 * the in-scope sessions the user started the deck to watch.
 */
async function replayLog(filePath, workspace = "") {
  if (!existsSync(filePath)) return 0;
  let count = 0;
  let skipped = 0;
  let skippedBytes = 0;
  const admits = replayScope(workspace);
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }) });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line);
      if (evt && typeof evt === "object" && evt.payload) {
        if (!admits(evt.payload)) continue;
        pushEvent(evt.payload, evt.source ?? "replay", { receivedAt: evt.receivedAt, replay: true });
        count++;
      }
    } catch {
      skipped++;
      skippedBytes += Buffer.byteLength(line, "utf8");
    }
  }
  if (skipped > 0) {
    const kb = (skippedBytes / 1024).toFixed(0);
    console.warn(`${PRODUCT}: skipped ${skipped} unreadable line(s) (${kb}KB) while replaying the event log`);
  }
  return count;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * Serialize one envelope, or a stub standing in for it.
 *
 * `JSON.stringify` throws on more than size. V8 walks a value recursively, so a
 * payload nested about five thousand deep overflows the C++ stack and comes
 * back as `RangeError: Maximum call stack size exceeded` — and a 36 KB POST to
 * the open ingest route is enough to put one of those in the ring, measured on
 * Node 22.14. Letting that throw escape would truncate the array mid-write and
 * leave every later read of that ring answering with invalid JSON for as long
 * as the event survives, which is a 36 KB way to poison a route permanently.
 *
 * So the envelope is replaced rather than dropped, and it keeps its `seq`: a
 * caller paging with `?since=` still walks past it, instead of asking again for
 * a hole it can never be given — the same bargain resumeSse makes about the
 * events it cannot deliver. The reason is written to stderr and not to the
 * wire, under the rule sendInternalError explains: this body is readable by a
 * DNS-rebound page and error detail is not.
 */
function envelopeJson(evt) {
  try {
    // `JSON.stringify(undefined)` is undefined, not a string, and inside an
    // array literal that would be the text "undefined" — which is not JSON.
    // `JSON.stringify([undefined])` says "null"; so does this.
    return JSON.stringify(evt) ?? "null";
  } catch (err) {
    console.error(`${PRODUCT}: event ${evt?.seq} could not be serialized:`, err);
    // Every field here is read defensively and typed to a primitive, because
    // this is the path that must not throw twice: the status line has gone out
    // and a second failure would leave the caller a truncated array.
    return JSON.stringify({
      seq: Number(evt?.seq) || 0,
      epoch: typeof evt?.epoch === "string" ? evt.epoch : SEQ_EPOCH,
      receivedAt: Number(evt?.receivedAt) || 0,
      source: typeof evt?.source === "string" ? evt.source : "unknown",
      payload: null,
      unserializable: true,
    });
  }
}

/**
 * Answer with a JSON array without ever holding it as one string.
 *
 * `send` finishes a response by handing the whole body to a single
 * `JSON.stringify`, which for every other route is a few hundred bytes and for
 * `GET /api/events` is the entire ring buffer. V8 will not build a string
 * longer than `2^29 - 24` characters, so past 536,870,888 characters of
 * serialised envelopes that call throws `RangeError: Invalid string length`
 * straight out of the request listener — and there, as requestUrl and `guard`
 * both say in their own words, nothing catches it and the worker exits.
 * Measured on Node 22.14 / macOS: 112 posts of 4,900,061 characters, which
 * `POST /api/event` accepts from anyone with no credential at all, then one
 * plain unauthenticated GET, and the deck was gone — SSE stream, hook ingest
 * and event log with it. 112 events is a twentieth of MAX_BUFFER, so this is
 * not an exotic ring: a deck watching sessions whose Read and Bash responses
 * are "routinely a good fraction of" the five-million-character ingest cap
 * reaches it on its own at an average of 268 KB an event.
 *
 * Writing the array element by element removes the ceiling rather than raising
 * it. One envelope's worth of string exists at a time, so the limit applies per
 * envelope — and ingest caps an envelope at a hundredth of it — and the peak
 * cost is the ring plus one event instead of the ring plus a contiguous copy of
 * itself, which is the quieter half of the same bug: a 400 MB ring used to need
 * 800 MB and a synchronous stall on a route that feels free on a quiet deck.
 * This is the shape resumeSse already uses for the SSE replay, for the same
 * reason, and it borrows the same writeResume, so a caller that stops reading
 * is held at MAX_CLIENT_BUFFER_BYTES here too rather than having the whole ring
 * queued in userland on its behalf.
 *
 * `items` must be a snapshot the caller owns — eventsSince returns one, `filter`
 * always allocating — because each await lets pushEvent splice the head off the
 * live ring, and iterating that while it is spliced skips entries.
 *
 * No Content-Length: it is not knowable without building the string this exists
 * to avoid, so the answer is chunked. HTTP/1.1 requires nothing more and every
 * consumer reads to EOF.
 *
 * Exported so the one property that matters can be asserted directly, on a stub
 * rather than through a socket — the same reason queuedBytes is. "Never builds
 * the whole array as one string" is invisible from outside a real response,
 * which is how it went unnoticed here for as long as it did.
 */
export async function writeJsonArray(res, items) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  let frame = "[";
  for (const item of items) {
    if (res.destroyed) return;
    if (!await writeResume(res, frame + envelopeJson(item))) {
      // Stalled past REPLAY_DRAIN_MS with the cap full. Nothing useful can be
      // said in-band — the status line went out long ago and the array is half
      // written — so hang up, exactly as the replay does.
      try { res.destroy(); } catch {}
      return;
    }
    frame = ",";
  }
  if (res.destroyed) return;
  res.end(frame === "[" ? "[]" : "]");
}

async function serveStatic(req, res, url) {
  // Strip leading slash, default to index.html
  let rel = url.pathname.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel = `${rel}index.html`;
  const filePath = join(WEB_DIST, rel);
  if (!filePath.startsWith(WEB_DIST)) return send(res, 403, { error: "forbidden" });

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) return send(res, 404, { error: "not found" });
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  } catch {
    // SPA fallback to index.html for client-side routes
    try {
      const idx = await readFile(join(WEB_DIST, "index.html"));
      // Same no-cache as the normal path above, which this used to omit. It
      // matters more since the deck upgrades itself: index.html is the file
      // naming the hashed bundle, so a heuristically-cached copy sends the tab
      // back to the OLD assets after an update and the reload achieves nothing.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(idx);
    } catch {
      send(res, 404, { error: "ui not built. run `pnpm build` or `npm run build`." });
    }
  }
}

/** Collect a request body as a string, capped so a bad client can't fill memory. */
function readBody(req, limit = 64_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => {
      body += c;
      if (body.length > limit) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// How long an oversized POST is drained after it has been refused, so the 413
// reaches a poster that is still uploading. Generous next to hook.js's own
// one-second budget, and finite so nothing can sit on the socket indefinitely.
const OVERSIZE_DRAIN_MS = 10_000;

// `persist` is false when the hook posted this event to another deck as well
// and elected that one to write it to the log they share. The event is still
// buffered and broadcast here — every matching deck draws it — it is only the
// second copy on disk that is dropped.
function handleEventIngest(req, res, persist = true) {
  let body = "";
  // Set once the cap is hit, because everything after that point is about an
  // exchange that is already over: more `data` may still be in flight, and
  // `end` must not go on to parse the truncated half.
  let refused = false;
  req.setEncoding("utf8");
  req.on("data", c => {
    if (refused) return;
    body += c;
    if (body.length > 5_000_000) {
      refused = true;
      body = "";              // nothing will read it now; let it go
      // ANSWER, rather than vanish. `req.destroy()` on its own tore the socket
      // down with no status line on it at all, so the poster learned only that
      // the connection had gone — indistinguishable from a deck that died or
      // was never there, and nothing in the exchange to tell those apart. `end`
      // never fires on a destroyed request either, so the handler below got no
      // second chance to speak. readBody above gets this right already, by
      // rejecting into a caller that replies.
      send(res, 413, { error: "event too large" });
      // Then keep reading, and throw it away. Answering is not enough on its
      // own, because the poster is still mid-upload when the answer goes out:
      // hang up now and its next write lands on a dead socket, it aborts with
      // EPIPE, and the 413 that was already sitting in its receive buffer is
      // discarded unread — the same disappearance in a different costume.
      // `Connection: close` is the tempting version of hanging up and has
      // exactly that effect: Node destroys the socket the moment such a
      // response flushes. Draining lets the poster finish and then read the
      // answer, which is the whole point of answering. `body` no longer grows,
      // so it costs no memory.
      req.resume();
      // Bounded, because draining forever is its own denial of service: a
      // poster that stops without ending would otherwise hold the socket for as
      // long as it liked.
      const grace = setTimeout(() => req.destroy(), OVERSIZE_DRAIN_MS);
      grace.unref?.();
      req.on("close", () => clearTimeout(grace));
    }
  });
  req.on("end", () => {
    if (refused) return;
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return send(res, 400, { error: "invalid json" }); }
    // Everything past the parse is inside one net, because this listener is the
    // one place in the route table `guard` cannot reach. The route does wrap the
    // call — `guard(handleEventIngest(req, res, …), res)` — but this function
    // returns undefined and hands its work to a listener the event loop calls
    // later, so `guard` has nothing to attach to and a synchronous throw in here
    // is an uncaughtException: the whole deck, for one POST. That is exactly
    // what the serialization inside pushEvent was until it was contained at the
    // line itself, and this catch is what stops the next thing added below from
    // costing a process the same way. sendInternalError puts the reason on
    // stderr and a bare 500 on the wire, and does nothing but end the response
    // if the status line has already gone out.
    try {
      noteLogWriter(parsed, persist);
      const evt = pushEvent(parsed, "hook", { persist });
      send(res, 200, { ok: true, seq: evt.seq });
    } catch (err) {
      sendInternalError(res, err);
    }
  });
  // Guarded for the same reason `end` is, and more sharply: destroying the
  // request above is itself what raises this, and answering a second time on a
  // response already sent throws ERR_HTTP_HEADERS_SENT out of an error handler,
  // where nothing is waiting to catch it. `refused` covers the 413 that
  // destroyed the request; `headersSent` covers the other half of that
  // sentence, an error arriving after `end` has already answered. That half
  // resisted every attempt to drive it from a socket — once `end` has fired the
  // message is complete and the failure goes to the socket rather than to the
  // request — so it carries no test, and is guarded anyway on the strength of
  // the hazard the sentence above already names: one condition against an
  // uncaughtException, if it turns out to be reachable at all.
  req.on("error", () => { if (!refused && !res.headersSent) send(res, 400, { error: "bad request" }); });
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 1500\n\n`);

  // A stale or absent id replays the whole ring, and so does a malformed one:
  // Number("nonsense") is NaN, every `seq <= NaN` is false, and the catch-up
  // loop below would rather compare against a number.
  //
  // An id OLDER than the ring's oldest event is a stale id and takes exactly
  // that path — nothing special-cases it, and #625 deliberately did not add a
  // second answer when it gave the ring a byte budget. Every `e.seq <=
  // sentThrough` test simply fails, so the client is handed everything still
  // held, contiguously, and the sentinel behind it; the events that were
  // evicted are missing from its HISTORY, never from its stream. The reducer's
  // guard is `env.seq <= state.lastSeq`, so the gap costs it a step forward and
  // nothing else. What the byte budget changed is how often and how far the
  // head moves, not what happens to a client that lands behind it.
  const asked = Number(req.headers["last-event-id"] ?? 0);
  const lastId = Number.isFinite(asked) ? asked : 0;

  // The replay waits on the socket now, so it can no longer be part of this
  // synchronous handler. Nothing is waiting on the result here — the response
  // is already committed to a 200 and its own failure path is to hang up — so
  // start it, keep the router's contract of returning nothing, and make sure a
  // rejection ends the stream rather than the process.
  resumeSse(req, res, lastId).catch(() => dropSse(res));
}

/**
 * Drain the ring buffer into a newly connected client, then subscribe it.
 *
 * Two things had to change when this stopped being one synchronous burst.
 * `close` is registered before the first frame, because a tab closed mid-replay
 * has to stop it. And the replay repeats until it reaches the live tail: an
 * actual wait lets pushEvent run, and an event that lands after we have walked
 * past its place but before the client is in `sseClients` would otherwise be in
 * neither stream — a hole the client cannot even ask for again, its last id
 * having moved past it.
 */
async function resumeSse(req, res, lastId) {
  let sentThrough = lastId;
  let ping = null;
  let closed = false;
  req.on("close", () => {
    closed = true;
    if (ping) clearInterval(ping);
    sseClients.delete(res);
  });

  for (;;) {
    // A snapshot per pass, because a wait lets pushEvent splice the head of
    // `events` off, and iterating an array being spliced from the front skips
    // entries. Events evicted that way are gone for this client, which is the
    // same bargain every resume against a rotated ring already makes.
    //
    // The snapshot earns more since #625 gave the ring a byte budget as well as
    // a count. Under the count alone the head moved one entry per push; under
    // the budget a single 5 MB event can evict hundreds at once. A replay
    // already walking this array would have skipped every one of them — but the
    // snapshot holds its own references, so the pass in flight still delivers
    // what it was given and only a LATER pass sees the shortened ring. It also
    // means a slow resumer pins one ring's worth of envelopes for as long as its
    // pass lasts, which the budget bounds too: that pin used to be unbounded for
    // the same reason the ring was.
    const batch = events.slice();
    for (const e of batch) {
      if (e.seq <= sentThrough) continue;
      if (closed || res.destroyed) return;
      // Marked with `replay:true` on the envelope so the client can suppress
      // turn-cleanup side effects (exitAt stamping, autofit churn) until the
      // live stream takes over. Without this the reducer's UserPromptSubmit
      // handler treats replayed events as a real new turn — hiding prior-turn
      // subagents using the event's stale receivedAt, which collides with
      // wall-clock visibility gates and yields the "nodes appear then vanish"
      // symptom on refresh.
      const tagged = { ...e, replay: true };
      // Through envelopeJson for the reason writeJsonArray is: the ring may be
      // holding an envelope `JSON.stringify` cannot walk. pushEvent takes the
      // payload out of every envelope it serializes, but it serializes nothing
      // when there is no subscriber and no log — which is precisely the deck a
      // browser is about to connect to — so the first read of such an entry can
      // still be this one. Uncontained it rejected into handleSse's `.catch`,
      // which drops the client; the browser reconnects on its own 1.5s timer,
      // replays the same entry, and is dropped again, so a single small POST
      // kept the canvas from ever loading. The stub loses the `replay` tag and
      // nothing turns on that: it carries no payload for the reducer to act on,
      // and the client's own replay gate runs until the `replay-end` sentinel
      // regardless of what any one envelope says.
      if (!await writeResume(res, `id: ${e.seq}\nevent: hook\ndata: ${envelopeJson(tagged)}\n\n`)) {
        return dropSse(res);
      }
      sentThrough = e.seq;
    }
    // Caught up with the tail as it stands right now. Reached in one pass
    // unless a wait let new events in, and it terminates for the same reason
    // the client is still here at all: either it is taking bytes, in which case
    // loopback outruns any hook, or it is not, in which case writeResume gives
    // up on it.
    if (events.length === 0 || events[events.length - 1].seq <= sentThrough) break;
  }

  if (closed || res.destroyed) return;

  // Sentinel: tells client "ring buffer drained, live stream starts now". It
  // goes out under the same rule as the frames before it, so a client that has
  // just been handed a large replay is not hung up on over the last 30 bytes of
  // it before it has had the chance to read any.
  //
  // Subscribing before waiting on that write, rather than after, is what closes
  // the last hole: writeResume puts the bytes on the socket before it returns,
  // so the sentinel still precedes every live frame, and an event pushed while
  // we wait reaches this client through the live fan-out instead of falling
  // into the gap between the two. If the wait then ends in a drop, dropSse
  // takes it back out of the set — the same exit writeSse uses.
  const flushed = writeResume(res, `event: replay-end\ndata: {}\n\n`);
  sseClients.add(res);
  // Through writeSse like every other frame: on a client that has stopped
  // reading, the ping is the one thing still being written between events, and
  // it is what eventually reveals the socket as unrecoverable.
  ping = setInterval(() => writeSse(res, `: ping\n\n`), 15000);
  if (!await flushed) dropSse(res);
}

// True only when a supervisor is listening AND the event log is being written.
// Without persistence a restart wipes the canvas irrecoverably — replayLog has
// no file to read — so the deck must not offer to do it.
let _canRestart = false;

async function handleVersion(req, res) {
  const { versionReport } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href
  );
  // ?refresh=1 asks npm now rather than reusing the cached answer — what the
  // version chip does when clicked, for the user who has just published or is
  // wondering whether the check is working at all.
  const force = new URL(req.url, "http://localhost").searchParams.get("refresh") === "1";
  const report = await versionReport({ running: RUNNING_VERSION, pkgRoot: PKG_ROOT, force });
  // Attached here rather than inside versionReport for the same reason
  // canRestart is: the report is what this package root says about itself,
  // while both of these are facts about the process serving it — the command
  // the user typed lives in this process's environment and argv, not on disk.
  //
  // It is deliberately not folded into `name`, which is documented as the
  // package an upgrade would install and is load-bearing for the update flow.
  // The two answer different questions and give different answers: `name` is
  // read off the install on disk and is always known, while this one is the
  // command that was typed and is silent wherever it cannot be proven — every
  // Windows global install, and every `npm i -g ccdeck`, whose stub spawns the
  // deck by absolute path and leaves nothing in argv to read.
  const invoked = invokedName({ pkgRoot: PKG_ROOT });
  // The second half of that notice, computed here rather than in the browser.
  //
  // The banner needs one more fact than the name: whether typing `ccdeck` is
  // enough (a global install ships all three commands, so it already is) or
  // whether the whole answer is `npx ccdeck`. The browser used to derive that
  // from `upgradeMode`, which reads like the same question and is not — it
  // answers "may this copy install over itself", and `AGENTS_DECK_NO_INSTALL=1`
  // makes it null for EVERY shape including npx, because upgradeBlockedReason
  // tests the opt-out before it tests npx. So an npx user who opted out of
  // installs was told the global-install line and sent to a command that does
  // not exist on their machine, while the terminal row two feet away said
  // `npx ccdeck` — one fact, two surfaces, opposite answers (#363).
  //
  // renameNotice is where that fact is decided for the terminal, so it decides
  // it here too and the browser renders the string rather than a branch. No
  // `dash` argument on purpose: the glyph tier is a terminal concern, and the
  // default em dash is what a browser should get.
  const rename = renameNotice({ invoked, pkgRoot: PKG_ROOT });
  send(res, 200, {
    ...report, canRestart: _canRestart, invokedAs: invoked, renameFix: rename?.fix ?? null,
  });
}

// Runs `npm i -g <this deck>@latest`, and only that: the argument vector is
// fixed inside self-update.mjs — including which of the three published names
// it installs, which comes from the layout npm built rather than from the
// request. Answers immediately — progress is read back from /api/version.
async function handleUpgrade(_req, res) {
  const { startUpgrade } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href
  );
  const out = startUpgrade({ pkgRoot: PKG_ROOT });
  send(res, out.ok ? 200 : 409, out);
}

// Restart is a two-party act: this half answers before it stops listening, so
// the caller learns it was accepted rather than losing the socket mid-reply.
//
// `{ upgrade: true }` asks for the npx variant: come back through
// `npx -y <spec>@latest` instead of re-running the files already here. Granted
// only where that is genuinely how this copy updates — the mode is decided from
// the install on disk, never from the request.
async function handleRestart(req, res) {
  if (!_onRestart) return send(res, 501, { ok: false, reason: "unsupervised" });
  // Enforced here and not only in the UI. Under --no-persist a restart destroys
  // the whole canvas — replayLog has no file to read — and a destructive act
  // must not be prevented by a hidden button alone.
  if (!_canRestart) return send(res, 409, { ok: false, reason: "no_persist" });

  let wantUpgrade = false;
  if (req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    try { wantUpgrade = JSON.parse(body ?? "")?.upgrade === true; } catch { /* a plain restart */ }
  }
  let mode = null;
  if (wantUpgrade) {
    const { upgradeBlock, upgradeMode, npxRestartSpec } = await import(
      pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href
    );
    if (upgradeMode(upgradeBlock(PKG_ROOT)) !== "npx" || !npxRestartSpec(PKG_ROOT)) {
      return send(res, 409, { ok: false, reason: "not_npx" });
    }
    mode = "npx";
  }

  if (_restarting) return send(res, 202, { ok: true, already: true });
  _restarting = true;
  // Accepted either way — the ask is good and the launcher holds on to it — but
  // the two are not the same event and answering 200 to both would be this
  // window's second untruth rather than its first. Between this listener
  // accepting its first connection and bin/deck.js finishing the rest of its
  // startup there is a real stretch during which a restart cannot be run yet,
  // and a caller that reads the body should be able to tell that it is waiting
  // on a boot rather than on a supervisor. See markDeckReady, and requestRestart
  // in bin/deck.js for the half that does the waiting.
  if (_deckReady) send(res, 200, { ok: true, mode });
  else send(res, 202, { ok: true, mode, booting: true, detail: "the deck is still starting up; the restart runs as soon as it has finished booting" });
  // Let the response flush before the listener goes away.
  setTimeout(() => {
    try { _onRestart(mode); }
    catch (err) {
      // This catch is where #448 lived: it released the server's half of the
      // latch and said nothing, while the launcher's half stayed set with
      // nothing left to clear it, and every later restart answered "ok" and did
      // nothing for the rest of the process's life. The launcher now owns its
      // own failures; this stays as the outer net, and it says so — one line,
      // message only, because the terminal underneath is repainted every 800ms
      // by the pulse and a stack dumped into it is a stack nobody can read.
      _restarting = false;
      console.error(`${PRODUCT}: restart request failed: ${err?.message ?? err}`);
    }
  }, 120).unref();
}

/** The other end of the latch above, for the upgrade that never happened.
 *
 * An npx upgrade is now fetched before anything is torn down, so a fetch that
 * fails leaves this process serving — with `_restarting` still set from a
 * restart that is not coming. Nothing would ever clear it: the only path that
 * did was the process ending. Every later click, from any tab, answered 202
 * "already restarting" for the rest of the deck's life. */
export function releaseRestart() {
  _restarting = false;
}

/** The launcher saying its boot is over: everything a shutdown would have to
 *  tear down now exists.
 *
 *  This server starts accepting from inside startServer, before that call has
 *  even returned to bin/deck.js — so /api/restart is answerable for the whole
 *  of the startup that follows it, which on a cold boot includes the discovery
 *  file's first fsynced write and spawning the browser. The listener cannot see
 *  any of that from here; it has to be told. Called once, from bin/deck.js.
 *
 *  Only /api/restart reads it, and only to answer honestly. Nothing is refused
 *  on the strength of it: the restart is still handed to the launcher, which
 *  holds it until it can run it (#448). */
export function markDeckReady() {
  _deckReady = true;
}

async function handleQuota(req, res) {
  const { fetchClaudeQuota } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/quota.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const quota = await fetchClaudeQuota({ force });
  send(res, 200, quota);
}

async function handleCodexUsage(req, res) {
  const { fetchCodexUsage } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/codex-usage.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const usage = await fetchCodexUsage({ force });
  send(res, 200, usage);
}

async function handleCodexQuota(req, res) {
  const { fetchCodexQuota } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/codex-quota.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const quota = await fetchCodexQuota({ force });
  send(res, 200, quota);
}

/**
 * ccusage's `--since`/`--until` grammar: a `YYYYMMDD` calendar date, or nothing
 * at all — an absent parameter lets ccusage.mjs pick the default 30-day range.
 *
 * Eight digits is a shape, not a calendar, and deliberately so. What this gate
 * is for is keeping anything that is not a date out of a child process's
 * argument vector; `99999999` is exactly as inert an argument as `20260101`,
 * and whether a date outside the logs means an empty chart is ccusage's
 * question to answer rather than the deck's to guess at.
 */
export const isCliDate = (v) => v === undefined || /^\d{8}$/.test(v);

async function handleCcusage(req, res) {
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const since = url.searchParams.get("since") || undefined;
  const until = url.searchParams.get("until") || undefined;
  // Refused here, at the boundary, because this is where a string chosen by
  // someone else enters: /api/ccusage is a GET, so it needs no CORS, no
  // preflight and no ability to read the response — any page the user has open
  // can fire it at the loopback port — and both values end up in the argv of a
  // spawned CLI. The spawn no longer goes through a shell (see ccusage.mjs), so
  // this is the second lock rather than the only one, and it is the one that
  // keeps the pair honest if a shell is ever reintroduced downstream.
  if (!isCliDate(since) || !isCliDate(until)) {
    return send(res, 400, {
      ok: false,
      reason: "bad_range",
      error: "since and until must be YYYYMMDD dates, e.g. 20260101",
    });
  }
  const { fetchCcusageDaily } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/ccusage.mjs")).href
  );
  const data = await fetchCcusageDaily({ since, until, force });
  send(res, 200, data);
}

async function handleClaudeAccounts(req, res) {
  const { fetchClaudeAccounts } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  send(res, 200, await fetchClaudeAccounts({ force }));
}

async function handleClaudeAccountSwitch(req, res) {
  const { switchClaudeAccount, invalidateClaudeAccountsCache } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href
  );
  const body = await readBody(req).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });

  const result = await switchClaudeAccount(parsed.account);
  // The active account just moved; the next poll should see it immediately
  // rather than serving the pre-switch roster for another few seconds.
  invalidateClaudeAccountsCache();
  // The 5h/7d percentages moved with it — they are read for whichever account is
  // active — and only this side knows: /api/quota is polled by the usage panel,
  // which has no idea the accounts panel just switched and so never sends
  // ?refresh=1. Without this the two panels sit on one screen disagreeing about
  // the same account for a full poll cycle, and the stale one is the one the
  // user just acted on. Only on a switch that took: a refused one left the
  // account where it was, and throwing away a reading we paid for costs a real
  // answer to fix nothing.
  if (result.ok) {
    const { invalidateQuotaCache } = await import(
      pathToFileURL(join(PKG_ROOT, "src/server/quota.mjs")).href
    );
    invalidateQuotaCache();
  }
  send(res, result.ok ? 200 : 400, result);
}

function cswapAdminModule() {
  return import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-admin.mjs")).href);
}

// Reading the login's progress. The browser polls this while its dialog is
// open, the same way the upgrade notice polls /api/version.
async function handleAccountLoginState(_req, res) {
  const { loginState } = await cswapAdminModule();
  send(res, 200, { ok: true, ...loginState() });
}

/**
 * Everything that changes the account store, behind one verb switch — the shape
 * handleCswapAutoAction already uses.
 *
 * The sign-in code is the one field here that is a credential. It is read out
 * of the body, handed straight to the child's stdin, and never logged, echoed
 * back, or written anywhere — which is also why this is a POST body and not a
 * query parameter.
 */
async function handleClaudeAccountAdmin(req, res) {
  const admin = await cswapAdminModule();
  const body = await readBody(req).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });

  let result;
  switch (parsed.action) {
    case "login":        result = await admin.startLogin({ email: parsed.email }); break;
    case "login-code":   result = await admin.submitLoginCode(parsed.code); break;
    case "login-cancel": result = await admin.cancelLogin(); break;
    case "share":        result = await admin.shareAccount(parsed.account); break;
    case "import":       result = await admin.importAccount(parsed.blob); break;
    case "remove":       result = await admin.removeAccount(parsed.account); break;
    case "alias":        result = await admin.setAlias(parsed.account, parsed.alias); break;
    case "move":         result = await admin.moveAccount(parsed.account, parsed.slot); break;
    default: return send(res, 400, { ok: false, reason: "unknown_action" });
  }
  send(res, result.ok ? 200 : 400, result);
}

function cswapAutoModule() {
  return import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-auto.mjs")).href);
}

async function handleCswapAuto(req, res) {
  const { autoStatus } = await cswapAutoModule();
  send(res, 200, await autoStatus());
}

/**
 * One POST for every auto-switch control, keyed by `action`. Each one can move
 * the user's live Claude account or change when it moves, so nothing here is
 * reachable by GET.
 */
async function handleCswapAutoAction(req, res) {
  const mod = await cswapAutoModule();
  const body = await readBody(req).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });

  let result;
  switch (parsed.action) {
    case "enable":
      result = await mod.setAutoEnabled(parsed.enabled === true);
      break;
    case "setting":
      result = await mod.setCswapConfig(String(parsed.key ?? ""), parsed.value);
      break;
    case "account":
      result = await mod.setAccountEnabled(parsed.account, parsed.enabled === true);
      break;
    default:
      return send(res, 400, { ok: false, reason: "unknown_action" });
  }
  send(res, result.ok ? 200 : 400, result);
}

async function handleSoundHook(req, res) {
  const { soundHookStatus } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/sound-hook.mjs")).href
  );
  send(res, 200, await soundHookStatus());
}

async function handleSoundHookSet(req, res) {
  const { setSoundHook, restoreParkedSoundHooks } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/sound-hook.mjs")).href
  );
  const body = await readBody(req).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });
  if (parsed.action === "restore") return send(res, 200, await restoreParkedSoundHooks());
  send(res, 200, await setSoundHook(parsed.enabled === true));
}

// The tree this deck was told to capture, "" when it captures the whole
// machine. Set by startServer and never changed afterwards.
//
// The browser had no way to learn it: the launcher prints the scope on stdout
// and the hook reads it out of the discovery file, but nothing put it in an
// HTTP response — so the deck's own empty state guessed, and guessed wrong for
// everyone who passed --workspace or --scope. Health is where it belongs: it
// already answers "which deck am I talking to", and it is the one route the UI
// can read before a single event has arrived.
let _workspace = "";

// Which CLIs this deck is actually watching. Decided in bin/deck.js — from
// whether each one is on the machine, and from --claude/--no-claude and
// --codex/--no-codex — and passed in here, because the browser had no way to
// learn it and so drew both sides of the UI on every machine.
//
// That is the whole of #402 and its mirror. A Codex-only machine got the
// accounts panel open on first run, telling it to sign into a CLI it does not
// have; a Claude-only machine permanently carried "Quota unavailable. / Run
// codex login to authenticate." Same missing fact, two directions.
//
// Defaults are both true, which is what an older deck effectively reported by
// saying nothing — and the browser reads a missing field as "could not say" and
// shows both, so the two agree.
let _providers = { claude: true, codex: true };

/**
 * The one spelling of `--workspace` everything downstream compares against.
 * Empty — including a value that is nothing but spaces — stays empty, which is
 * how every reader of it says "machine-wide".
 *
 * Called once, in bin/deck.js, where the flag arrives: that process's cwd is the
 * shell the user typed the command in, and it is the only process on either
 * capture path whose cwd is the one a relative `--workspace ./sub` was written
 * against. The raw string used to go straight into the discovery file, and
 * hook.js resolved it inside its own process — which the host CLI runs with the
 * AGENT's cwd — so `--workspace ./sub` scoped Claude sessions to a `sub`
 * directory under whatever the agent happened to be working in, a different
 * directory per agent and none of them the one asked for. The Codex path
 * resolved the same string in the server process and was right. Resolving here
 * makes both of them right, and for the same reason bin/deck.js already resolves
 * the events log before publishing it: what goes in the discovery file is read
 * by other processes that cannot reconstruct the context it was written in.
 *
 * Symlinks are resolved too, so that `--workspace /tmp/proj` on a Mac is not
 * scoped to /tmp/proj while every session inside it reports /private/tmp/proj,
 * leaving the deck empty. A path that does not exist yet keeps its resolved form
 * rather than failing: scoping a deck to a directory you are about to create is
 * not an error.
 *
 * That resolution is only half the rule. Canonicalising the flag means nothing
 * unless the cwd it is compared against is canonicalised the same way, and that
 * is a separate job on each capture path: hook.js does it with normPath, and the
 * rollout watcher does it with canonicalCwd below. This comment used to claim
 * the second half came for free — that "a process's cwd comes from getcwd() and
 * has none left in it" — which is true on POSIX and false on Windows. See
 * canonicalCwd.
 *
 * WHICH REALPATH, AND WHY IT IS `.native` AT ALL THREE SITES. Node ships two
 * implementations with different Windows behaviour, and picking one per site is
 * how the flag and the two cwd paths end up meaning different things again:
 *
 *   fs.realpathSync / fs.realpath  a JavaScript lstat-and-readlink walk. It
 *                                  resolves symlinks and junctions and NOTHING
 *                                  else — a DOS 8.3 short component survives it
 *                                  untouched.
 *   …Sync.native / …native / the   uv_fs_realpath, which on Windows is
 *   fs/promises realpath           GetFinalPathNameByHandleW: symlinks and
 *                                  junctions, the UNC form of a mapped drive,
 *                                  the LONG form of an 8.3 short name, and the
 *                                  on-disk case of every component.
 *
 * The long form is the canonical one, and not by preference: it is the only
 * spelling that is a fixed point. Short names are an alias for the same
 * directory exactly as a junction is, they cannot be derived back from the long
 * form (8.3 generation can be disabled per volume), and they are not a corner
 * case a test invented — `%TEMP%` under a shortened profile directory answers
 * with one, which is what every GitHub Windows runner has. It is also already
 * this codebase's answer: persistAuth in src/server/codex-auth.mjs resolves
 * through the fs/promises realpath, i.e. this one.
 *
 * So all three sites name `.native` explicitly rather than one of them reaching
 * for whichever realpath came to hand. Being explicit is the point — the reason
 * this had to be said twice is that fs/promises' realpath IS the native one
 * while its sync namesake is not, an equivalence nothing documents and no reader
 * should have to know.
 */
export function canonicalWorkspace(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  const abs = resolve(raw);
  try { return realpathSync.native(abs); } catch { return abs; }
}

// The async half of the rule canonicalWorkspace states above, named the same way
// it is: fs.realpath.native is the documented callback form of uv_fs_realpath,
// and promisifying it says which realpath this is at the point of use. The
// fs/promises realpath is the same call and would have read as if it were the
// JavaScript one.
const realpathNative = promisify(realpathCb.native);

/**
 * The one spelling of the directory a Codex session says it is running in —
 * hook.js's normPath, for the capture path that never goes through the hook.
 *
 * `--workspace` is canonicalised above before anything compares against it, and
 * the Claude side canonicalises the session's cwd to match: hook.js runs every
 * incoming cwd through normPath (resolve + realpath) before asking
 * capturesSession. The Codex side compared the rollout header's `cwd` raw, and
 * the comment above said that was safe because a cwd comes from getcwd(), which
 * has already resolved every link.
 *
 * That is true of getcwd(3) and not true of Windows. There the current directory
 * is stored as the string it was set with, and GetCurrentDirectoryW — what
 * Rust's std::env::current_dir() behind Codex calls — hands that string back
 * without resolving a junction, a `subst` drive or a mapped network drive.
 * realpath does resolve them, and on a mapped drive goes further and returns the
 * UNC form, because libuv asks GetFinalPathNameByHandleW. So a deck started as
 * `--workspace Z:\proj` scoped itself to `\\server\share\proj`, the Claude
 * session in that tree reported `Z:\proj` and was realpath'd into the workspace
 * and drawn, and the Codex session beside it reported `Z:\proj` in its rollout
 * header, was compared raw, and silently never appeared — no error printed
 * anywhere, the banner still claiming the rollout watcher was running. The same
 * asymmetry runs in reverse for a user who passes the resolved path and works
 * through the junction. The log election went wrong with it: writesCodexLog
 * models the OTHER decks' capture with this same predicate against their
 * published (canonical) workspaces, so it was picking the wrong group.
 *
 * Done here, at the one read of the header, rather than inside
 * codexCwdInWorkspace: the result is cached in codexFileState for the life of
 * the file, so it costs one realpath per rollout instead of one per tick, and it
 * leaves the predicate the pure string function that lets it be pinned against
 * hook.js's copy in a test.
 *
 * `.native`, for the reason canonicalWorkspace sets out at length: three sites
 * canonicalise a path against each other and all three must fold the same way,
 * 8.3 short names included. Case IS canonicalised as a side effect — that is
 * what GetFinalPathNameByHandleW and realpath(3) on a case-insensitive volume
 * return — but nothing here DEPENDS on it: the two predicates still fold case
 * per-platform themselves, which is the only place that decision can stay
 * correct on Linux, where /srv/Proj and /srv/proj are two real directories and
 * realpath quite rightly keeps them apart.
 *
 * Async, unlike canonicalWorkspace, because of where each one runs.
 * canonicalWorkspace runs once in bin/deck.js before the server exists, so
 * blocking there costs nothing. This runs inside the watcher's 1.5s tick, in the
 * live event loop, against a path a rollout recorded some time ago — which on
 * the very platform this exists for is quite likely to name a mapped drive that
 * is no longer connected, and a synchronous realpath on one of those blocks the
 * whole dashboard until SMB times out.
 *
 * A cwd that no longer resolves keeps its resolved form, exactly as the flag
 * does: a deleted directory or a disconnected drive is not a reason to drop a
 * session the deck can still draw, and the resolved string is the best answer
 * available — for a rollout recorded in the tree the deck is scoped to and never
 * moved, it is also the right one. Anything that is not a non-empty string is
 * null, which is what readCodexHeader returned before and what both copies of
 * the predicate read as "this session never said where it runs".
 */
export async function canonicalCwd(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const abs = resolve(raw);
  try { return await realpathNative(abs); } catch { return abs; }
}

/**
 * The deck's one irreversible action: empty the ring, and empty the log — but
 * only the log this deck is the one writing.
 *
 * The gate is the whole of #698. `truncate(persistPath, 0)` ran from whichever
 * deck was asked, and `persistPath` is one file several decks share by default,
 * so Clear on a deck scoped to a single tree deleted the machine-wide deck's
 * entire history while its canvas showed no change at all. Ownership is
 * electWriters, the election that already decides which of those decks appends a
 * line, so nothing new gets to disagree with it: the deck that fills the file is
 * the deck that may empty it, and a deck that writes nothing to it cannot
 * destroy it. See logSharing.
 *
 * A deck that does not own the log still clears its own canvas — that is what
 * the user pressed, and the ring is this deck's alone — and says which deck's
 * file it declined to touch, so the answer is a fact the UI can show rather than
 * a silent partial success. The dialog asked `GET /api/clear` before the press
 * and has already said the same thing in words.
 *
 * The `__clear` marker is broadcast and NOT persisted. It never belonged on
 * disk: replaying an empty log and then a marker that empties it produces the
 * same empty state, and appending it was how a deck that writes nothing else to
 * the shared file still left 134 bytes in it — the reproduction's whole
 * remainder. `{ persist: false }` is the same flag the hook sets on the decks it
 * did not elect.
 */
async function handleClear(res) {
  const sharing = await logSharing();
  // Not `events.length = 0`: the ring is measured by a running total now, and
  // emptying the array without the total leaves a debt that never clears. See
  // clearEventBuffer.
  clearEventBuffer();
  if (sharing.path && sharing.mine) truncate(sharing.path, 0).catch(() => {});
  // Drop the caches that gate an emit on "has this changed", because the
  // client is about to forget what they are comparing against: __clear makes
  // the reducer return a fresh state, so every session's name and every
  // subagent's model label go with it. maybeResolveSessionName then computes
  // the same signature, takes its early return, and emits nothing — so the
  // card falls back to cwd/prompt for the rest of that session while the
  // server is sitting on the name.
  //
  // The root model survives without help because pushEvent stamps
  // `raw.model` on every payload; there is no equivalent stamp for the name
  // or for a subagent's model, which is why those two are listed and the
  // rest of the per-session state is not.
  //
  // The rule, for the next cache that gates an emit: anything answering
  // "has this changed" has to appear in BOTH places that mean the client no
  // longer has it — here, and in forgetSession.
  nameBySession.clear();
  modelBySession.clear();
  // The read stamps go with them. Clearing only the signatures would leave
  // the next hook event inside MODEL_READ_THROTTLE_MS, so the transcript
  // would not be re-read at all and the name would stay missing until the
  // throttle expired — a clear followed by a keystroke is exactly when a
  // user is watching.
  lastNameReadAt.clear();
  modelLastReadAt.clear();
  pushEvent({ hook_event_name: "__clear", cwd: "" }, "internal", { persist: false });
  return send(res, 200, {
    ok: true,
    log: !sharing.path ? "none" : sharing.mine ? "cleared" : "kept",
    path: sharing.path,
    decks: sharing.decks,
    mine: sharing.mine,
    owner: sharing.owner ? { port: sharing.owner.port } : null,
  });
}

function handleHealth(_req, res) {
  send(res, 200, {
    ok: true,
    name: "agent-dag",
    seq: nextSeq - 1,
    clients: sseClients.size,
    uptimeMs: Math.round(process.uptime() * 1000),
    workspace: _workspace,
    providers: _providers,
  });
}

// A secret this process, and only this process, knows. It goes into the
// discovery file bin/deck.js writes (mode 0600) and is never sent anywhere:
// hook/hook.js reads it from that file and asks us to hash it against a nonce
// before it will send us a single session payload.
//
// Fresh per start, deliberately. A discovery file that outlives its deck —
// SIGKILL and power cuts both leave one behind — names a pid the OS is free to
// hand to something else and a port that by then may belong to anything. The
// pid probe below cannot tell that apart from a running deck, so the token is
// what actually distinguishes us: the replacement process does not have it, and
// neither does the next deck, so a stale file authenticates nothing.
const HOOK_TOKEN = randomBytes(32).toString("hex");

/** The token this deck expects to be challenged on. Written by writeDiscovery. */
export function hookToken() { return HOOK_TOKEN; }

/**
 * The proof of knowing `token`, for a nonce the challenger chose.
 *
 * hook/hook.js spells this out a second time — it is installed outside the
 * package and cannot import from here — and a test pins the two against each
 * other. Changing one without the other silently blinds the deck.
 */
export function challengeProof(token, nonce) {
  return createHash("sha256").update(`${token}:${nonce}`).digest("hex");
}

// GET /api/hook-challenge?nonce=… — answer a hook's challenge.
//
// The nonce is the caller's, so the answer proves knowledge of the token
// without disclosing it, and proves it for this exchange only. Answering
// freely is what the exchange requires: the hook is asking whether the process
// on this port is the deck that wrote the discovery file, and it asks precisely
// because it does not yet know — a deck that demanded credentials before
// answering could not be told apart from a stranger that refuses.
//
// So this route is an oracle, and it must stay one. That makes its answer
// useless as a credential FOR this server, and nothing here may ever accept it
// as one: a caller who can GET this can obtain a valid proof for any nonce, so
// a gate honouring proofs is a gate honouring anybody. See presentsDeckToken,
// which takes the token itself and refuses the hashed form for this reason.
//
// What the free answer does NOT give away is the token: the response is a
// one-way hash of it, and after the read gate above a rebound page cannot see
// even that.
function handleHookChallenge(_req, res, url) {
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!nonce || nonce.length > 256) return send(res, 400, { error: "bad nonce" });
  send(res, 200, { proof: challengeProof(HOOK_TOKEN, nonce) });
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

async function sweepStaleDiscovery() {
  // Same directory the installer writes and the hooks read — see claude-dir.mjs.
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    try {
      const d = JSON.parse(await readFile(p, "utf8"));
      if (d && typeof d.pid === "number" && !isProcessAlive(d.pid)) {
        await unlink(p).catch(() => {});
        removed++;
      }
    } catch { /* corrupt — leave it */ }
  }
  return removed;
}

function randomPort(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Parse a request target into a URL, or null when it cannot be parsed.
//
// The base is the constant "http://localhost", never the Host header. Node's
// HTTP parser hands the header through verbatim, so a client sending
// `Host: bad host` used to produce `new URL("/", "http://bad host")`, which
// throws ERR_INVALID_URL synchronously inside the request listener. Nothing
// catches that — it becomes an uncaughtException, the worker exits 1 and the
// supervisor tears the whole deck down for a single malformed request. Only
// the path and the query are ever read from this URL, so the authority half
// is free to be a constant — which is what every other new URL call site in
// this file already does. Anything else unparseable answers 400 instead.
export function requestUrl(rawUrl) {
  try { return new URL(rawUrl ?? "/", "http://localhost"); }
  catch { return null; }
}

// Is this request allowed to be answered at all, whatever it asks for?
//
// The rebinding gate below was reached only by mutations, on the reasoning that
// a cross-site page cannot read a loopback reply. That is true of a genuinely
// cross-origin page and false of a rebound one: the browser resolved
// attacker.example to 127.0.0.1 itself, so it calls the reply same-origin and
// hands the body to the page. Every read was therefore open to exactly the
// attack the mutation gate was written to stop — and the reads are where the
// secrets are. GET /api/events is the whole ring buffer: prompt text, the Bash
// command lines the agent ran, the paths and contents it wrote, the contents of
// every file it read back. /api/claude-accounts names the accounts,
// /api/claude-accounts/login carries a live OAuth authorize URL, /api/sound-hook
// the user's own hook command lines, /api/health the absolute workspace path.
//
// So the Host check runs for every method now. What it asks is only the
// rebinding question — did this request arrive addressed to a name that can
// only ever be this machine — and it asks it of browser-shaped requests alone,
// meaning anything carrying an Origin or fetch metadata. A client sending
// neither is not a page and has no ambient authority to borrow: that is
// hook/hook.js, a plain Node http.request from the user's own machine, and it
// keeps reaching the deck under whatever name it used before.
//
// Deliberately not part of this: the Sec-Fetch-Site test that isTrustedMutation
// applies. `cross-site` on a read is an ordinary top-level navigation — a link
// to http://localhost:4317 clicked on any page — and the document it loads is
// the deck's own UI on the deck's own origin, which is not an attack and used
// to work. Rebinding does not need that test either: a rebound page's requests
// report `same-origin`, and it is the Host that gives it away.
export function isTrustedRead({ origin, host, secFetchSite } = {}) {
  const browserShaped = (typeof origin === "string" && origin !== "")
    || (typeof secFetchSite === "string" && secFetchSite.trim() !== "");
  if (!browserShaped) return true;
  return isLoopbackHost(host);
}

// Is this mutating request allowed to be acted on?
//
// The deck binds 127.0.0.1, which sounds private but is reachable from every
// page the user's browser has open: a cross-site POST with a CORS-safelisted
// `Content-Type: text/plain` fires no preflight, so any visited page could
// remove a Claude account, import an attacker-crafted one, switch the live
// account, flip auto-switching, start a global npm upgrade, restart the deck
// or truncate the event log. None of those need to read the response, so the
// same-origin policy alone never stopped them.
//
// Two headers decide it, and both are set by the browser itself — page script
// cannot forge either, they are forbidden header names:
//
//   Sec-Fetch-Site  present on every modern-browser request. `same-origin`
//                   (our own UI) and `none` (the user typed the URL) pass;
//                   `cross-site` and `same-site` are exactly the attack and
//                   are refused. Absent on older Safari, hence the second half.
//   Origin          present on every browser POST, including same-origin ones.
//                   It must name this very server: comparing it to the Host
//                   header the browser filled in from the target URL. A page
//                   on http://evil.com — or on http://localhost:8000, which is
//                   just as cross-origin — cannot make the two agree. The
//                   opaque `null` origin (sandboxed iframe, data: URL) fails
//                   to parse and is refused with it.
//
// Agreement between the two is necessary but not sufficient, because both are
// derived from the URL the page was served from and neither says a word about
// the address the socket actually landed on — so the Host must also name a
// loopback identity. See isLoopbackHost for the attack that gets through
// without it.
//
// A request carrying neither header is not a browser request and is allowed
// whatever Host it names: that is hook/hook.js, a plain Node http.request from
// the user's own machine that sends no Origin at all, plus curl and the deck's
// own tooling. Ambient browser authority is the whole threat here, and those
// clients have none — a process that can POST here can already run anything as
// the user, and nothing it sends is chosen by a page.
export function isTrustedMutation({ origin, host, secFetchSite } = {}) {
  const site = typeof secFetchSite === "string" ? secFetchSite.trim().toLowerCase() : "";
  if (site && site !== "same-origin" && site !== "none") return false;
  const hasOrigin = typeof origin === "string" && origin !== "";
  if (!hasOrigin && !site) return true;
  // Either header present means a browser sent this, so the rebinding gate
  // applies even to the shape that carries fetch metadata but no Origin. Every
  // request reaching this line is browser-shaped by the test just above, so
  // isTrustedRead here is exactly its isLoopbackHost half.
  if (!isTrustedRead({ origin, host, secFetchSite })) return false;
  return hasOrigin ? originMatchesHost(origin, host) : true;
}

// Was this request addressed to a name that can only ever be this machine?
//
// Origin === Host alone is not a defence against DNS rebinding: the page is
// served from http://attacker.example:4317, the attacker re-points that record
// at 127.0.0.1, and the browser then sends Host: attacker.example:4317 with a
// matching Origin and Sec-Fetch-Site: same-origin — every header self-consistent
// and every one attacker-chosen, because fetch metadata comes from the origin
// tuple (scheme, host, port), not from the resolved IP. The browser also treats
// the reply as same-origin, so the page reads the body: that is the account
// share envelope, with the OAuth token in it. A loopback literal has no DNS
// record to re-point, and `localhost` is reserved to loopback, so requiring one
// of them is what separates the deck's own UI from the rebound page.
function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const authority = host.trim().toLowerCase();
  // A real Host header is bare authority. Userinfo or a path would let
  // `evil.example@127.0.0.1` and `127.0.0.1/…` parse to a loopback hostname
  // while naming something else, so refuse them rather than reason about them.
  if (authority === "" || /[/\\?#@\s]/.test(authority)) return false;
  let name;
  try { name = new URL(`http://${authority}`).hostname; } catch { return false; }
  if (name === "localhost" || name === "[::1]") return true;
  // The whole 127.0.0.0/8 is this machine, not just .0.1 — a second deck parked
  // on 127.0.0.2 is as local as the first. URL only produces a dotted quad for
  // something it already validated as an IPv4 address, so shape is enough here.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

// Does `origin` name the same host:port the request was addressed to? Ports are
// part of an origin, so http://127.0.0.1:8000 is not http://127.0.0.1:4317 —
// and the default port is spelled both ways depending on the client, so it is
// normalised off both sides before comparing.
function originMatchesHost(origin, host) {
  if (typeof host !== "string" || host === "") return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  const dropDefaultPort = (h, scheme) =>
    h.replace(scheme === "https:" ? /:443$/ : /:80$/, "");
  const fromOrigin = dropDefaultPort(parsed.host.toLowerCase(), parsed.protocol);
  const fromHost = dropDefaultPort(host.trim().toLowerCase(), parsed.protocol);
  return fromOrigin !== "" && fromOrigin === fromHost;
}

// Mutating routes that ask nothing of the caller beyond the gates above.
//
// Only the hook's ingest, and only because hook/hook.js is installed OUTSIDE
// this package — it lives in the user's ~/.claude and is loaded by whatever
// Claude Code session is already running. Requiring a credential here would
// stop every event from every session whose hook predates this change, on a
// machine where nothing is obviously broken and nothing says why, until each
// one is reinstalled. It also carries no credential and destroys nothing: the
// worst a caller does with it is draw a session on the canvas that is not
// there. See the handshake in hook/hook.js for the authentication that does
// run on this path, which is the deck proving itself to the hook.
//
// That "destroys nothing" is a claim about the whole ingest path and not only
// about this line, and #625 is what it cost the day it stopped being true: the
// ring buffer bounded the events it kept by count and not by size, so about 430
// posts of a maximum-size body — from a local process holding no credential,
// which is exactly what this set permits — reached the heap limit and aborted
// the process. Whatever else is added to this set, the same question has to be
// asked of it: what does an unbounded number of these accumulate in? For this
// one the answer is now MAX_BUFFER_CHARS.
//
// #674 is the same question asked a second time, and the answer was not in the
// ring at all. The body of this POST carries `transcript_path`, and everything
// the deck learns about a session's model, cost, name and context is read out
// of the file it names — so the credential-free route does not stop at the ring
// buffer, it reaches the filesystem, with a path the caller chose. It was read
// by allocating the whole file: 700 MB named in one POST took a fresh deck from
// 52 MB RSS to 753 MB and answered `200 {"ok":true,"seq":1}`, and because a
// file with no newline in it could never advance the scan cursor, every later
// POST paid it again. What bounds it now is three things, in the order they
// were reached for: `isClaudeTranscriptPath` means an unrecognised path is not
// opened at all, so the caller who holds no credential can name nothing;
// MAX_SCAN_CHUNK means no single read allocates more than 8 MiB whatever it is
// pointed at; MAX_SCAN_BYTES_PER_PASS means no single POST walks more than 256
// MiB of a file.
//
// So the claim above holds again, with its scope written out: the worst a
// caller does with this route is draw a session on the canvas that is not
// there. It cannot make the deck open a file of its choosing, and it cannot
// make the deck's memory a function of anything but the two constants named
// here.
const OPEN_MUTATIONS = new Set(["/api/event"]);

// Constant-time comparison of two secrets, and a length test that is not.
// Lengths differ freely in public — a mismatched one only says "not this
// token" — but timingSafeEqual throws rather than answering false when they do.
function secretEquals(given, expected) {
  const a = Buffer.from(String(given ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Does this request carry the deck's own token?
//
// One spelling, `x-ccdeck-token`, carrying the token itself. That is all a
// local process needs, because the only way it can hold the token is to have
// read it out of a file only it can open.
//
// The token is HOOK_TOKEN, fresh per deck and written to the discovery file at
// mode 0600. That mode is the whole of the access control: the answer to "who
// may do this" is "whoever can read that file", which is the user this deck
// runs as and nobody else. On Windows the chmod is a best-effort no-op, so
// there the file's protection is the per-user ACL on the profile directory it
// sits in rather than a mode bit; the token still works identically.
//
// The hashed challengeProof form is deliberately NOT accepted here, and this
// is the paragraph that must be read before anyone adds it. GET
// /api/hook-challenge?nonce=… answers challengeProof(HOOK_TOKEN, nonce) to any
// caller for any nonce, by design — so accepting a proof as a credential means
// the server hands out its own credentials on request, and two unauthenticated
// GETs are a complete bypass of everything below. This gate shipped that way
// for one commit; the regression test in csrf-origin.test.ts pins it shut.
//
// The premise that makes the oracle safe is the one this gate rejects, which is
// exactly why the two cannot share a secret: the challenge is the deck proving
// itself TO the hook, not the hook proving itself to the deck. hook/hook.js
// already holds the token — it read the same 0600 file — and challenges the
// port to find out whether the process listening there is really the deck that
// wrote it, or something else that inherited the port number from a stale
// discovery file. Nothing travels in the other direction, so no caller ever
// needed the hashed form as a way IN, and a client entitled to mutate holds the
// token itself anyway.
function presentsDeckToken(headers = {}) {
  const raw = headers["x-ccdeck-token"];
  return typeof raw === "string" && secretEquals(raw.trim(), HOOK_TOKEN);
}

// Is this the deck's own page in the user's browser?
//
// A strict subset of isTrustedMutation, which every request here has already
// passed: an Origin must actually be present — a browser sends one on every
// POST, including a same-origin one — it must name this very server, the Host
// must be a loopback identity, and any fetch metadata must say `same-origin`.
// `none` is excluded on purpose: that is a top-level navigation the user typed
// or a form submitted from one, never the UI's own fetch.
function isDeckUiRequest({ origin, host, secFetchSite } = {}) {
  const site = typeof secFetchSite === "string" ? secFetchSite.trim().toLowerCase() : "";
  if (site !== "" && site !== "same-origin") return false;
  if (typeof origin !== "string" || origin === "") return false;
  if (!isLoopbackHost(host)) return false;
  return originMatchesHost(origin, host);
}

// May this request change something?
//
// Everything above this line is about the browser: whether a page chose the
// request, and whether it was addressed to this machine. None of it asks who
// the caller is, and for a client that is not a browser at all nothing did —
// a request carrying no Origin and no fetch metadata was waved through on the
// reasoning that a process able to POST here can already run anything as the
// user. That holds on a single-user laptop and fails twice elsewhere. Loopback
// is not scoped to a UID, so on a shared box or a multi-tenant container every
// other account on the machine can reach this port; and a sandboxed subprocess
// denied the credential store but allowed loopback egress — the ordinary shape
// of an agent's Bash sandbox — reaches the same credentials through the API.
// `curl -XPOST localhost:4317/api/claude-accounts/admin -d '{"action":"share"}'`
// answered with the account's live OAuth refresh token in the clear, and the
// same request reached account remove and import, the live account switch, a
// global `npm i -g`, the restart and the event log.
//
// So a mutation must now be either of two things:
//
//   - the user's own browser tab, recognised by the headers a page cannot
//     forge and the deck's own loopback address (isDeckUiRequest), or
//   - a client holding the deck's token, which it can only have read from the
//     0600 discovery file (presentsDeckToken).
//
// What this does NOT do, stated plainly so nobody mistakes it for more: the
// browser clause rests on headers that page script cannot set but any local
// program can. A local attacker who adds `Origin` and `Sec-Fetch-Site` to the
// request is back through. That is not a gap left by laziness — there is no
// fix for it here. Authenticating the tab would mean giving the tab a secret,
// and every channel from this process to a browser on the same machine is
// readable by any other process on that machine: a token in the served
// index.html is read by the same `curl http://localhost:4317/` that the gate
// is meant to stop, and a token in the URL the deck opens is read out of the
// browser's argv by `ps`. What is closed is the free pass — a request that
// presents nothing at all no longer changes anything — and what is opened is
// the honest door, so a script of the user's own authenticates by reading the
// token instead of impersonating a page.
function isAuthorizedMutation(req) {
  const headers = req?.headers ?? {};
  if (presentsDeckToken(headers)) return true;
  return isDeckUiRequest({
    origin: headers.origin,
    host: headers.host,
    secFetchSite: headers["sec-fetch-site"],
  });
}

// A request handler rejected. Two audiences, two different amounts of detail:
// the operator, who needs the whole error — stack included — to find the bug,
// and the HTTP client, which needs to know only that the request failed.
//
// They used to get the same string, on the theory that this server binds
// 127.0.0.1 and its only client is the user's own tab. A DNS-rebound page
// reaches a loopback server as same-origin and can read the body, and the
// errors that land here carry absolute paths out of the user's home directory
// — a failed rename of ~/.claude/settings.json, an ENOENT from an import. So
// stderr keeps every byte and the response body carries none of it; nothing is
// swallowed, it just stops travelling over the wire.
export function sendInternalError(res, err, log = console.error) {
  log(`${PRODUCT}: request handler failed:`, err);
  if (!res.headersSent) send(res, 500, { error: "internal error" });
  else res.end();
}

// One attempt, leaving the server with no more listeners on it than it started
// with. `server.listen(port, host, cb)` registers `cb` for a 'listening' event
// that a failed bind never emits, so the previous shape left one behind per
// attempt — eleven candidates printed Node's "MaxListenersExceededWarning:
// 11 listening listeners added to [Server]" into the middle of a boot that was
// already going wrong. Both sides are removed by whichever fires first.
async function tryListen(server, port, host) {
  return new Promise((res, rej) => {
    const onListening = () => { server.removeListener("error", onError); res(); };
    const onError = (err) => { server.removeListener("listening", onListening); rej(err); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Whether another PORT could fix this failed `listen`.
 *
 * startServer builds ten random fallback candidates and they exist for exactly
 * one situation: "this port is unavailable". Until #552 only EADDRINUSE reached
 * them, which is the POSIX spelling of that answer and not the only one.
 *
 * WINDOWS. `winnat` hands out contiguous TCP blocks to Hyper-V, WSL2 and Docker
 * Desktop, and a bind INSIDE one of those reserved exclusion ranges — the ones
 * `netsh interface ipv4 show excludedportrange protocol=tcp` prints — is refused
 * with WSAEACCES, which libuv reports as EACCES. Any machine with containers or
 * WSL on it can therefore have 4317 blocked without a single socket being open
 * on it. The loop rethrew on the first candidate, bin/deck.js printed
 * `server failed: listen EACCES: permission denied 127.0.0.1:4317`, and the deck
 * exited 1 with the fallback range untouched.
 *
 * On POSIX the same code is what a bind below 1024 gets without privilege.
 * Retrying is right there too: 4317 and the whole fallback range are above 1024,
 * so a random candidate is a port the user can actually have — and the deck
 * coming up on 4322 beats it refusing to come up at all, which is already how
 * EADDRINUSE on a privileged port behaves today.
 *
 * The other direction is the half that keeps this honest. EADDRNOTAVAIL,
 * ENOTFOUND, EAI_AGAIN and EAFNOSUPPORT are about the HOST, not the port: the
 * address does not exist on this machine or does not resolve, and no candidate
 * can help. Walking eleven of them only delays the one sentence that would have
 * explained it, so anything not named here stops the loop.
 */
export const portRetryable = (err) =>
  Boolean(err) && (err.code === "EADDRINUSE" || err.code === "EACCES");

/**
 * The sentence that goes beside a listen errno, or "" when the errno says it
 * all.
 *
 * Pure, and the platform is a parameter, for the reason every Windows answer in
 * this repo is written that way: the branch that matters most is the one the
 * author cannot run. A raw `listen EACCES: permission denied 127.0.0.1:4317` is
 * true and useless — the thing the user needs is the name of the command that
 * lists the ranges their machine has reserved.
 */
export function listenHint(code, { host = "", port = 0, platform = process.platform } = {}) {
  if (code === "EACCES") {
    if (platform === "win32") {
      return "a reserved port range is the usual cause on Windows: Hyper-V, WSL2 and Docker Desktop have winnat hold contiguous TCP blocks. Run `netsh interface ipv4 show excludedportrange protocol=tcp` to see them, then pass --port with a number outside every range";
    }
    if (port > 0 && port < 1024) return "ports below 1024 need root — pass --port with a number above 1024";
    return "the OS refused the bind; a sandbox or a security policy is the usual cause";
  }
  if (code === "EADDRNOTAVAIL") {
    return `no interface on this machine holds ${host || "that address"}, so no other port can help — pass --host with an address it does hold, or 127.0.0.1 for local only`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `${host || "that host"} does not resolve, so no other port can help — pass --host with an address rather than a name`;
  }
  return "";
}

/**
 * The error startServer throws, with the hint already in it.
 *
 * `exhausted` is the difference between "every candidate was refused" and "this
 * one was refused for a reason more candidates cannot fix". The exhausted
 * message keeps its opening words — bin/deck.js prints them and
 * boot-listen-before-report.test.ts reads them — and now names the LAST errno
 * rather than asserting EADDRINUSE, which was a lie the moment EACCES could
 * reach the end of the loop.
 */
export function listenFailure(err, { host = "", port = 0, platform = process.platform, exhausted = false } = {}) {
  const code = err?.code;
  const head = exhausted
    ? `all ports tried — none available (last: ${code ?? "unknown"} on ${host}:${port})`
    : String(err?.message ?? err ?? "listen failed");
  const hint = listenHint(code, { host, port, platform });
  const out = new Error(hint ? `${head} — ${hint}` : head);
  if (code !== undefined) out.code = code;
  if (err) out.cause = err;
  return out;
}

// Set from startServer's options. The server cannot restart itself — the
// process lifecycle belongs to the supervisor in bin/agent-dag.js, which is the
// only thing that can bring a replacement up on the same port without racing
// the dying listener. Absent (running the module directly, or under an older
// launcher), /api/restart answers 501 and the UI hides the control rather than
// offering a button that does nothing.
let _onRestart = null;
// A restart is in flight. Several browser tabs watching the same deck will each
// ask; the second ask must not re-enter the shutdown.
let _restarting = false;
// Whether the launcher has finished booting — see markDeckReady. False for the
// whole window between this listener accepting its first connection and
// bin/deck.js reaching the end of its startup, which is a window /api/restart
// is reachable in and cannot answer for on its own.
let _deckReady = false;

export async function startServer({ port = 4317, host = "127.0.0.1", persist = null, portRange = [4318, 4400], workspace = "", codex = true, claude = true, onRestart = null } = {}) {
  _onRestart = typeof onRestart === "function" ? onRestart : null;
  _canRestart = _onRestart != null && persist != null;
  // A new listener is a new boot, whatever a previous one had got as far as
  // reporting. Nothing but bin/deck.js ever sets this, and it does so once, at
  // the end of the startup that begins with this call.
  _deckReady = false;
  _workspace = typeof workspace === "string" ? workspace : "";
  // `!== false` rather than a cast: a caller that omits the field means "yes",
  // which is how every embedder that predates this option keeps working.
  _providers = { claude: claude !== false, codex: codex !== false };
  const removed = await sweepStaleDiscovery();
  if (removed > 0) console.log(`  swept ${removed} stale discovery file(s)`);
  if (persist) {
    persistPath = resolve(persist);
    try { await mkdir(pdirname(persistPath), { recursive: true }); } catch {}
    // `_workspace`, not `workspace`: the field has just been normalised on the
    // line above, and the replay has to answer the same question the live paths
    // answer with the same string. Passed rather than read off the module scope
    // so replayLog states what it depends on. See replayScope.
    const replayed = await replayLog(persistPath, _workspace);
    if (replayed > 0) {
      // Don't broadcast replays as live; SSE clients catch up via Last-Event-ID
      // already. Just keep the buffer + seq counter primed.
    }
  }
  // The async handlers below are dispatched as floating promises. Node's
  // default for an unhandled rejection is to kill the process, which would
  // take the whole deck down — SSE stream, hook ingest and all — because one
  // background quota poll hit a network error. Answer the request instead.
  const guard = (p, res) => Promise.resolve(p).catch(err => sendInternalError(res, err));

  const route = (req, res) => {
    const url = requestUrl(req.url);
    // Unparseable request target. Nothing below can route it, and throwing here
    // would be an uncaughtException inside the listener — i.e. the whole deck.
    if (!url) return send(res, 400, { error: "bad request target" });

    // Three gates in front of the whole table, so every route is covered and
    // any route added later is covered too, without the author having to
    // remember. They ask three different questions and they run in the order
    // that answers the cheapest first.

    // Was this addressed to this machine? Every method, because a rebound page
    // reads a reply as readily as it writes a request. See isTrustedRead.
    if (!isTrustedRead({
      origin: req.headers.origin,
      host: req.headers.host,
      secFetchSite: req.headers["sec-fetch-site"],
    })) {
      return send(res, 403, { error: "cross-site request blocked" });
    }

    // Did a page choose this? Mutations only — the same-site read this refuses
    // is an ordinary navigation. See isTrustedMutation.
    if (req.method !== "GET" && req.method !== "HEAD" && !isTrustedMutation({
      origin: req.headers.origin,
      host: req.headers.host,
      secFetchSite: req.headers["sec-fetch-site"],
    })) {
      return send(res, 403, { error: "cross-site request blocked" });
    }

    // And who is asking? Refusing by default is the point: a mutating route
    // added later is protected until someone deliberately lists it as open,
    // which is the direction this has to fail in. See isAuthorizedMutation.
    if (req.method !== "GET" && req.method !== "HEAD"
      && !OPEN_MUTATIONS.has(url.pathname) && !isAuthorizedMutation(req)) {
      return send(res, 401, { error: "unauthenticated" });
    }

    // `?persist=0` — another deck was elected to write this event to the log
    // the two of them share. Absent, this deck writes it.
    if (req.method === "POST" && url.pathname === "/api/event") return guard(handleEventIngest(req, res, url.searchParams.get("persist") !== "0"), res);
    if (req.method === "GET"  && url.pathname === "/api/health") return handleHealth(req, res);
    if (req.method === "GET"  && url.pathname === "/api/hook-challenge") return handleHookChallenge(req, res, url);
    if (req.method === "GET"  && url.pathname === "/events")     return handleSse(req, res);
    if (req.method === "GET"  && url.pathname === "/api/version")     return guard(handleVersion(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/upgrade")     return guard(handleUpgrade(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/restart")     return guard(handleRestart(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/quota")       return guard(handleQuota(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/codex-usage")  return guard(handleCodexUsage(req, res), res);
    // Machine state, not session state: sampled on the server's own timer and
    // deliberately kept out of the event stream. See src/server/system-metrics.mjs.
    if (req.method === "GET"  && url.pathname === "/api/system")       return send(res, 200, systemSnapshot());
    // On demand only — the process list costs a subprocess on every platform,
    // so it is fetched while the detail panel is open and never on the timer.
    if (req.method === "GET"  && url.pathname === "/api/system/processes") {
      return guard(readProcesses().then(procs => send(res, 200, { ok: true, procs })), res);
    }
    if (req.method === "GET"  && url.pathname === "/api/codex-quota") return guard(handleCodexQuota(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/ccusage")     return guard(handleCcusage(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/claude-accounts") return guard(handleClaudeAccounts(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/claude-accounts/switch") return guard(handleClaudeAccountSwitch(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/claude-accounts/login")  return guard(handleAccountLoginState(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/claude-accounts/admin")  return guard(handleClaudeAccountAdmin(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/sound-hook") return guard(handleSoundHook(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/sound-hook") return guard(handleSoundHookSet(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/cswap-auto")  return guard(handleCswapAuto(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/cswap-auto")  return guard(handleCswapAutoAction(req, res), res);

    // Through writeJsonArray rather than `send`, and through `guard` like every
    // route above it: this is the one answer whose size is the ring's size, and
    // `send` would build all of it as a single string. See writeJsonArray.
    if (req.method === "GET" && url.pathname === "/api/events") {
      return guard(writeJsonArray(res, eventsSince(url.searchParams.get("since") ?? 0)), res);
    }

    // GET /api/clear — what a POST to this path would do, and to whose log.
    // Asked by the confirmation dialog as it opens, on demand rather than on a
    // timer, for the reason /api/system/processes is: the answer costs a
    // directory read, changes only when a deck starts or stops, and matters at
    // exactly one moment. See logSharing.
    if (req.method === "GET" && url.pathname === "/api/clear") {
      return guard(logSharing().then(s => send(res, 200, {
        ok: true, path: s.path, decks: s.decks, mine: s.mine,
        owner: s.owner ? { port: s.owner.port } : null,
      })), res);
    }

    // POST /api/clear — wipe in-memory buffer + persistence file (UI reset)
    if (req.method === "POST" && url.pathname === "/api/clear") return guard(handleClear(res), res);

    if (req.method === "GET") return serveStatic(req, res, url);
    send(res, 405, { error: "method not allowed" });
  };

  // `guard` covers the routes dispatched as promises. This covers the rest of
  // them — and, more to the point, covers a route added later by someone who
  // did not think to reach for `guard` because their handler looked
  // synchronous and cheap. That was the whole of #626: `GET /api/events` read
  // as a one-liner, and it was a one-liner that ended the process, because a
  // synchronous throw inside the listener is an uncaughtException and Node's
  // answer to those is to exit. `/api/system` and `/api/clear` are called the
  // same bare way and are covered here for free.
  //
  // Deliberately the last line of defence and not the first: a 500 with the
  // detail on stderr is a worse answer than a handler that knew what went
  // wrong, and much better than a dead deck. sendInternalError already knows
  // to keep the detail off the wire and to do nothing but end the response
  // when the headers have gone out — which is the case that matters for a
  // streamed answer, where the throw can arrive after the status line.
  const server = createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  // Try requested port first, then up to 10 random ports from portRange.
  const candidates = [port];
  for (let i = 0; i < 10; i++) candidates.push(randomPort(portRange[0], portRange[1]));

  // The errno the exhaustion message ends up naming, and the port it happened
  // on. Kept because the last candidate's reason is the only one still worth
  // saying by then — the nine before it were random ports nobody asked for.
  let lastErr = null;
  let lastPort = port;
  for (const candidate of candidates) {
    try {
      await tryListen(server, candidate, host);
      // Codex has no working hooks on Windows — tail its rollout files instead.
      if (codex) startCodexWatcher(workspace);
      // Both timers are unref'd, so this never holds the process open.
      startSystemMetrics();
      // Auto-switch resumes only if the user previously turned it on; the
      // module reads its own persisted flag and does nothing otherwise.
      cswapAutoModule().then(m => m.initCswapAuto()).catch(() => {});
      return server;
    } catch (err) {
      lastErr = err;
      lastPort = candidate;
      // "This port is unavailable" — which Windows spells EACCES for a port
      // inside a reserved exclusion range. See portRetryable.
      if (portRetryable(err)) continue;
      // Anything else is about the host or the socket, and the next candidate
      // would fail identically. Say why instead of trying ten more times.
      throw listenFailure(err, { host, port: candidate });
    }
  }
  throw listenFailure(lastErr, { host, port: lastPort, exhausted: true });
}

// Allow running this file directly for dev (`npm run dev:server`). The port
// variable is the CLI's, deliberately: this block spent two renames reading a
// name from the project's first identity that no README ever documented, so
// the one variable people know worked everywhere except here.
//
// argv[1] is a string only when node was handed a script path. `node -e`,
// `--input-type=module` on stdin and a worker started from eval source all
// leave it undefined, and pathToFileURL(undefined) throws instead of answering
// false — which fails the whole import, in the one file whose job is to export
// startServer. Guard the argument, not the comparison (#481).
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const port = Number(process.env.AGENT_DAG_PORT ?? 4317);
  startServer({ port }).then(s => {
    const addr = s.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    console.log(`${PRODUCT} server: http://127.0.0.1:${p}`);
  }).catch(e => {
    console.error(`${PRODUCT} server failed:`, e.message);
    process.exit(1);
  });
}
