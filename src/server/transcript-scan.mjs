// Reading a Claude Code transcript: one cursor per JSONL, and the fold of each
// appended line into the running totals. The bounded chunk read that moves the
// cursor is jsonl-chunks.mjs, which the Codex side reads rollouts through as
// well, and the rule for which paths are worth opening at all is
// transcript-gate.mjs.
//
// These lived in src/server/index.mjs, between the log rotation and the model
// enrichment, and nothing in them ever reached the event pipeline: the
// enrichment passes (session-enrichment.mjs now) ask `scanTranscript` for a
// state and decide what to emit from it, the Codex watcher borrows the chunked
// reader, and pushEvent asks the path gate before any of that runs. So the whole
// reader moved as one piece, with its caches, and its callers import the
// operations they call. The names are the ones the bodies always used, and
// index.mjs still re-exports the five it exported: two from here, and the
// rest from jsonl-chunks.mjs and transcript-gate.mjs, where they have since
// moved.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
// Claude Code's "※ recap:" line — see session-recap.mjs.
import { foldRecapLine } from "./session-recap.mjs";
// The bounded, cursor-moving chunk read every pass below goes through — see
// jsonl-chunks.mjs.
import { readAppendedLines } from "./jsonl-chunks.mjs";

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
// the offset tailing the Codex rollout watcher in codex-watch.mjs already does.
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

/** The counters a `"usage"` block carries flat, and the two its
 *  `cache_creation` sub-object splits cache writes into by TTL. */
const USAGE_BLOCK_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
const CACHE_SPLIT_FIELDS = ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"];

/** Charge `fields` of one usage blob to the file's flat totals and, when the
 *  tokens can be attributed, to their model's bucket too — the same number
 *  into both, read once, so the split and the total it splits go on summing
 *  to each other. */
function chargeUsage(state, bucket, blob, fields) {
  for (const k of fields) {
    const n = grabUsageField(blob, k);
    state.usage[k] += n;
    if (bucket) bucket[k] += n;
  }
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

/** Have these totals been billed for anything at all?
 *
 *  The four flat counters are the whole of what a usage block charges. The two
 *  `ephemeral_*` counters split cache_creation_input_tokens by TTL rather than
 *  adding to it, so they are not asked. One file's totals, one model's bucket,
 *  each subagent file's totals and each line the Projects report folds
 *  (account-projects.mjs) are all asked this, and each of those four used to
 *  spell the four tests out for itself. */
function hasSpend(u) {
  return USAGE_BLOCK_FIELDS.some(k => u[k] !== 0);
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
    recap: null,        // newest "away_summary" no later turn retired — session-recap.mjs
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
// always the value we already had — which is why the emit in
// session-enrichment.mjs is gated on a change rather than fired per pass.
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
export function foldSessionNamingLine(out, line) {
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

/** Fold one transcript line into the running state. Every fact the three
 *  scanners need lives on a single line, so line-at-a-time folding sees
 *  exactly what a whole-file pass would. */
function foldTranscriptLine(state, line) {
  if (!line) return;

  // Rides the scan that is already reading these bytes for the model, the usage
  // totals and the context counts, so naming costs no read of its own — see the
  // block above `maybeResolveSessionName` in session-enrichment.mjs for why
  // that beat a tail read.
  foldSessionNamingLine(state, line);
  // The recap rides the same pass for the same reason, and costs the ordinary
  // line two substring tests. See session-recap.mjs.
  foldRecapLine(state, line);
  // Parsed once, and only when the line mentions a model: no other line can
  // change the model, and every assistant line names its model, so the usage
  // and context folds read the record off this same parse.
  const record = line.includes('"model"') ? parseRecord(line) : null;
  // Model before usage, always: a usage block is charged to the model the same
  // line names, which is the one foldModelLine has just read off it.
  foldModelLine(state, record);
  foldUsageLine(state, line, record);
  foldContextLine(state, line, record);
}

/** One transcript line as the object it records, or null when it is not JSON. */
function parseRecord(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** The model a line's record names, folded in: the newest one seen, and the
 *  root's or a legacy inline subagent's. `obj` is null for a line that names no
 *  model — only a line that mentions one can change it, and parsing the rest is
 *  what made the full rescan expensive. */
function foldModelLine(state, obj) {
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

/**
 * Does this record repeat the usage an earlier line of the same API request
 * already carried?
 *
 * Claude Code writes one assistant line per content block of a response —
 * thinking, text, each tool call — and every one of them carries the whole
 * request's `usage`. Only the first, `apiBlockIndex` 0, bills it (#1641).
 * Measured across the forty most recent transcripts on one machine: 6,765 of
 * 14,138 assistant usage records were such repeats, identical to the block 0
 * before them, and summing them all came to 1.94x the request-by-request
 * total. This is the rule the Projects report (account-projects.mjs) and
 * ccusage count by, and the Projects report asks this function. A record
 * without the field was written before Claude Code marked its blocks, and is
 * counted as it always was.
 *
 * The same lines are one reply, so the context breakdown asks this too before
 * it counts an assistant message (#1650).
 */
function repeatsRequestUsage(record) {
  return record?.apiBlockIndex !== undefined && record.apiBlockIndex !== 0;
}

/** The usage blocks a line was billed for, charged to the file's totals and to
 *  their model's bucket. Runs after foldModelLine on the same line — see
 *  below for why the order is the attribution. `record` is the line parsed,
 *  or null when it names no model. */
function foldUsageLine(state, line, record) {
  // A later content block of a request already charged — see
  // repeatsRequestUsage.
  if (repeatsRequestUsage(record)) return;
  // Usage totals sum every block in the file, resets included — every block the
  // model was actually billed for, which is why the `toolUseResult` tail is cut
  // off first (see billedUsageText) — and are summed a second time into the
  // bucket of the model that produced them (#686).
  //
  // `state.lastModel` is the attribution, and it is the LINE's model whenever
  // the line has one: foldModelLine has already run on it and assigned it.
  // That is the whole trick — CC writes `message.model` and `message.usage`
  // into the same JSON object, so by the time this loop reads the tokens the
  // model that produced them is the most recent thing the scanner saw. A usage
  // block on a line naming no model falls back to the last model seen, which
  // is the turn it belongs to; a usage block before ANY model line gets no
  // bucket at all and stays in the flat total alone, where the client prices it
  // at the session's current model exactly as it did before.
  //
  // The bucket takes exactly what the flat total takes, off the same `billed`
  // text: a split that read a wider stretch of the line than the total it splits
  // would re-introduce #685's double count on one side of the arithmetic only,
  // and the two would stop summing to each other.
  const billed = billedUsageText(line);
  const bucket = usageBucketFor(state, state.lastModel);
  for (const m of billed.matchAll(USAGE_BLOCK_RE)) {
    chargeUsage(state, bucket, m[1], USAGE_BLOCK_FIELDS);
  }
  for (const m of billed.matchAll(CACHE_CREATION_BLOCK_RE)) {
    chargeUsage(state, bucket, m[1], CACHE_SPLIT_FIELDS);
  }
}

/** The line's share of the context breakdown. Context counts only what follows
 *  the most recent /clear or /compact. `record` is the line parsed, or null
 *  when it names no model — see foldTranscriptLine. */
function foldContextLine(state, line, record) {
  let ctxText = line;
  let resetEnd = -1;
  for (const m of line.matchAll(CONTEXT_RESET_RE)) resetEnd = (m.index ?? -1) + m[0].length;
  if (resetEnd >= 0) {
    state.ctx = newContextBreakdown();
    ctxText = line.slice(resetEnd);
  }
  const ctx = state.ctx;
  ctx.msgsUser += (ctxText.match(TYPE_USER_RE) ?? []).length;
  // One reply is one message, however many content blocks it was written in:
  // a later block's line is a reply block 0 has already counted — see
  // repeatsRequestUsage. Its tool call is its own, and is counted below.
  if (!repeatsRequestUsage(record)) ctx.msgsAssistant += (ctxText.match(TYPE_ASSISTANT_RE) ?? []).length;
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
// What it stops is a caller who has got past `isClaudeTranscriptPath` in
// transcript-gate.mjs pointing one POST at something arbitrarily large: the read still terminates,
// the cursor keeps whatever it reached, and the next throttled pass continues
// from there.
const MAX_SCAN_BYTES_PER_PASS = 256 * 1024 * 1024;

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
      // leave the rest for the next throttle window — see MAX_SCAN_CHUNK in
      // jsonl-chunks.mjs and MAX_SCAN_BYTES_PER_PASS above for why it is both
      // of those and not either one alone. `readAppendedLines` advances the
      // cursor BEFORE this folds, which is the same rule the single-shot read
      // kept: a fold that throws half-way must not leave the cursor where the
      // next pass would count those lines again. `advanced === 0` is "nothing
      // complete to fold yet".
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

// What session-enrichment.mjs calls, and the two rules the Projects report
// (account-projects.mjs) reads its own pass of the transcripts by. Listed here
// rather than marked at each declaration so that every declaration above reads
// exactly as it did where it came from.
export {
  scanTranscript, newUsageTotals, hasSpend, mergeUsageByModel, repeatsRequestUsage,
};
