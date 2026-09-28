// What the deck learns about a session that its hooks never say: the model,
// the token spend, the session's name and recap, and the context it is
// carrying — each read off the session's transcript (or, for a Codex session's
// memory files, off its working tree) and sent on as a synthetic event.
//
// This lived in src/server/index.mjs, between the log rotation and the Codex
// rollout reader. pushEvent asks it to look at every live hook event, and it
// answers through pushEvent, which it reaches through event-sink.mjs so that
// the two need not import each other. Its per-session caches are its own:
// index.mjs asks knownModelId for the stamp, forgetEnrichment when it forgets
// a session and clearEnrichmentGates on a Clear. The readers, the throttles
// and the emits are unchanged.
import { readdir, stat } from "node:fs/promises";
import { join, resolve, dirname as pdirname } from "node:path";
import { ccProjectSlug, claudeConfigDir } from "./claude-dir.mjs";
import { CODEX_HOME } from "./codex-dir.mjs";
// Claude Code's "※ recap:" line — see session-recap.mjs.
import { RECAP_MARK } from "./session-recap.mjs";
// The shared transcript cursor every pass below reads through — see
// transcript-scan.mjs.
import { mergeUsageByModel, newUsageTotals, scanTranscript } from "./transcript-scan.mjs";
// event-pipeline.mjs's pushEvent, reached without importing it — see
// event-sink.mjs.
import { pushEvent } from "./event-sink.mjs";

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

/** The root model already resolved for this session, or null — what pushEvent
 *  stamps on a payload that arrives without one. */
function knownModelId(sid) {
  return cachedModelId(modelBySession.get(sid));
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
 *
 *  NOT exported, and the comment here used to say it was — "beside
 *  readContextFromTranscript … the rule is worth pinning directly rather than
 *  through a live server" — which stated a test contract no test had (#798).
 *  What is worth pinning is the parsing, and that is `foldSessionNamingLine`,
 *  which IS exported and which session-name.test.ts drives line at a time the
 *  way `foldTranscriptLine` does. This wrapper is a scan and two null checks.
 *
 *  The recap comes back beside the naming because it comes off the same scan:
 *  `naming` is null when the transcript has no naming record, `recap` when no
 *  recap is standing. See session-recap.mjs, and `noteRecap` below. */
async function readSessionNamingFromTranscript(path) {
  const state = await scanTranscript(path);
  if (!state) return null;
  const naming = (state.agentName || state.aiTitle)
    ? { agentName: state.agentName, aiTitle: state.aiTitle }
    : null;
  return { naming, recap: state.recap ?? null };
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
    .then(read => {
      if (!read) return;
      noteRecap(sid, read.recap);
      const naming = read.naming;
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

// ─── Session recap ───────────────────────────────────────────────────────
// Claude Code's "※ recap:" line (see session-recap.mjs). It comes off the
// transcript cursor like the naming above, and its emit is gated the same way:
// on a CHANGE, keyed by the recap's own timestamp, so a pass that re-reads a
// recap already sent says nothing. A session that never had one emits nothing
// at all — the first word about a session's recap is always a recap.
//
// TWO ROADS IN, BECAUSE NO HOOK FIRES WHEN IT LANDS. The cursor runs off hook
// events, and a recap is written three minutes into a silence that has none.
// So the output watch, which already stats these files between events, hands
// every tail it reads to `onRecapTail`, and a tail carrying a recap asks the
// cursor to fold the file. The cursor stays the one place the rule lives: a
// recap a later turn retired is retired whichever road found it.
const recapBySession = new Map();       // sid -> `${at}` last sent, "" once retired

function noteRecap(sid, recap) {
  const sig = recap ? String(recap.at) : "";
  const prev = recapBySession.get(sid);
  if (prev === sig) return;
  if (prev === undefined && !recap) return;
  recapBySession.set(sid, sig);
  pushEvent({
    hook_event_name: "SessionRecapped",
    session_id: sid,
    recap: recap ? { text: recap.text, at: recap.at } : null,
  }, "internal");
}

/** The output watch's tap. Only a tail carrying the recap mark costs a scan,
 *  and the scan is the cursor's own: it folds the bytes it has not seen yet. */
function onRecapTail(sid, text, path) {
  if (!path || !text.includes(RECAP_MARK)) return;
  scanTranscript(path)
    .then(state => { if (state) noteRecap(sid, state.recap ?? null); })
    .catch(() => {});
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

/**
 * Everything the enrichment passes above keep for one session, dropped. Its
 * one caller is forgetSession, which says when a session is forgotten and why.
 */
function forgetEnrichment(sid) {
  modelBySession.delete(sid);
  // The two the session-naming work added (#520/#522) and did not list here.
  // Both are keyed by session id and nothing else ever removed an entry, which
  // is the exact leak the comment above forgetSession says this mechanism
  // exists to end — every sibling cache is capped at MAX_TRACKED_SESSIONS and
  // these two were not. The functional half is worse than the leak:
  // nameBySession gates the SessionNamed emit on "has this changed", so a live
  // session evicted past the cap and then heard from again re-emits its model
  // (modelBySession was cleared) and never re-emits its name. A tab that
  // connects after the event ring has rolled past the original SessionNamed
  // shows that session unnamed for the rest of its life.
  nameBySession.delete(sid);
  // The recap's gate, for the same reason — see noteRecap.
  recapBySession.delete(sid);
  lastNameReadAt.delete(sid);
  modelLastReadAt.delete(sid);
  lastUsageReadAt.delete(sid);
  lastContextReadAt.delete(sid);
  lastCodexMemoryReadAt.delete(sid);
}

/**
 * Every session's "has this changed" gates, and the read stamps that would hold
 * the next re-read back, dropped at once. Its one caller is handleClear, which
 * says why a Clear has to.
 */
function clearEnrichmentGates() {
  nameBySession.clear();
  recapBySession.clear();
  modelBySession.clear();
  // The read stamps go with them. Clearing only the signatures would leave
  // the next hook event inside MODEL_READ_THROTTLE_MS, so the transcript
  // would not be re-read at all and the name would stay missing until the
  // throttle expired — a clear followed by a keystroke is exactly when a
  // user is watching.
  lastNameReadAt.clear();
  modelLastReadAt.clear();
}

// What index.mjs calls besides the readers exported above. Listed rather than
// marked at each declaration, so the declarations read as they did where they
// came from.
export {
  clearEnrichmentGates, forgetEnrichment, knownModelId, maybeResolveCodexMemory,
  maybeResolveContext, maybeResolveModel, maybeResolveSessionName, maybeResolveUsage,
  onRecapTail,
};
