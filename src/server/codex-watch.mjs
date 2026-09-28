// The Codex half of capture: a Codex session's rollout, found by id for the
// usage its payloads never carry, and the rollouts directory tailed for the
// events themselves.
//
// These lived in src/server/index.mjs, between the session enrichment and the
// ring's reader. They reach the pipeline through event-sink.mjs, as the
// enrichment does, and take the log election, the live decks, the canonical
// cwd and the chunked reader from the modules that own them — nothing here
// reads the ring or the SSE clients. index.mjs starts the watcher, hands every
// live event to maybeResolveCodex, and forgets a session through
// forgetCodexSession. The bodies are unchanged.
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { PRODUCT } from "./brand.mjs";
import { STOP, walkRolloutDays } from "./codex-dir.mjs";
// What one rollout line means as a hook payload — see codex-translate.mjs. The
// watcher below still decides which lines are read and where each one goes.
import { codexObjToPayload, codexSessionApproval, codexSessionModel } from "./codex-translate.mjs";
import { codexCwdInWorkspace, writesCodexLog } from "./log-writer.mjs";
// The one spelling of a rollout's cwd — see canonical-path.mjs.
import { canonicalCwd } from "./canonical-path.mjs";
import { eventLogPath } from "./event-log.mjs";
// Every deck registered right now that proved it is the deck its record
// describes — what the log election counts. See live-decks.mjs.
import { readLiveDecks } from "./live-decks.mjs";
// The bounded chunk reads the Claude transcripts use — see transcript-scan.mjs.
import { readAppendedLines, readByteRange } from "./transcript-scan.mjs";
import { maybeResolveCodexMemory } from "./session-enrichment.mjs";
// index.mjs's pushEvent, reached without importing index.mjs — see
// event-sink.mjs.
import { pushEvent } from "./event-sink.mjs";

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
// sid -> the rollout's path, or, once a walk of the whole tree came back without
// one, the moment that walk began. See findCodexRolloutPath for why a miss is
// kept (#992), and why only for CODEX_MISS_TTL_MS (#1134).
const codexRolloutPathBySid = new Map();
const lastCodexUsageReadAt = new Map();
const pendingCodexUsageReads = new Set();
const CODEX_READ_THROTTLE_MS = 2500;
// How many of the newest day directories a lookup reads when it is not owed
// the whole tree: the bound listRecentCodexRollouts keeps for the watcher.
const CODEX_RECENT_DAY_DIRS = 2;
// How long a miss from the whole tree is believed before its id is owed one
// more walk of it. See findCodexRolloutPath for why ten minutes.
const CODEX_MISS_TTL_MS = 10 * 60 * 1000;
// True while one lookup is walking the whole tree. One at a time; see below.
let codexWholeTreeWalk = false;

/**
 * Where is this session's rollout, if it is anywhere under this tree?
 *
 * WHAT WAS WRONG (#992). A hit was kept and a miss was not, and the walk that
 * answers a miss is the whole tree: one readdir per year, per month and per day
 * under $CODEX_HOME/sessions, which only a hit ends early. So an id with no
 * rollout here paid for that walk again on every pass maybeResolveCodex's
 * 2.5-second throttle let through, for as long as its hooks kept firing. A Codex
 * hook left over from an older install, for a session whose rollout lives
 * under another CODEX_HOME, is enough. The id also arrives on `/api/event`,
 * which takes no credential and throttles per id, so a local process could post
 * a few hundred fresh ids and have every one of them walk every directory at
 * once. Both were measured in codex-unresolved-session-walk-992.test.ts, over a
 * tree holding one year of history. The same unresolvable id, posted twice one
 * throttle window apart, read all 37 of that year's directories both times, and
 * six fresh ids posted together had six walks of it in flight at once.
 *
 * THE FIRST LOOKUP STILL WALKS THE WHOLE TREE, newest first, as it always did.
 * A session resumed from last month appends to last month's rollout, and one
 * that has been running for three days has dropped out of the newest two
 * directories. Bounding the first walk the way the watcher's listing is bounded
 * would find neither, and their usage would never show.
 *
 * A MISS FROM THE WHOLE TREE IS KEPT, as the moment that walk began, and every
 * later lookup for that id reads only the newest two day directories. Those are
 * the only place a rollout written after the walk can land, because Codex names
 * a file for the moment it creates it, and they are the bound
 * listRecentCodexRollouts already trusts for live sessions. So a hook that
 * fires a moment before its rollout is on disk is still answered on a later
 * pass, and an id nothing will ever carry costs about five readdirs a pass
 * instead of the whole history. One caveat: walkRolloutDays swallows every
 * error it meets, so a walk that could not read a directory still counts as
 * having looked there. That is the one way a wrong miss gets kept.
 *
 * BUT NOT FOREVER (#1134). The newest two directories are where a rollout
 * written after the walk lands, and they do not stay the newest two. A session
 * whose first hook fired before its rollout existed, and whose next hook came
 * after two newer day directories had appeared — a `codex resume` two days
 * later — had its rollout in the third-newest directory, behind a miss that
 * only forgetSession or a restart would ever clear. Its usage never showed,
 * where the tree before #1111 found it; codex-kept-miss-expires-1134.test.ts
 * has the measurement.
 *
 * So a kept miss is believed for CODEX_MISS_TTL_MS, and the first lookup after
 * that is owed one more whole walk, on the same one-at-a-time terms as the
 * first. Ten minutes closes the hole outright. A rollout drops out of the newest
 * two directories only once two later calendar days have begun, which is never
 * less than about a day after it was written (23 hours across a DST change), so
 * by then every miss that could be hiding it has expired and the next lookup
 * walks to it. It also keeps #992 fixed: an id nothing carries walks the whole
 * tree once in ten minutes where it used to walk it every 2.5-second throttle
 * window, 240 times as often, and reads its five directories in between. And
 * the caveat above now costs a session ten minutes of usage rather than the
 * rest of the process's life. It is the same ten minutes CODEX_STATE_TTL_MS
 * keeps a rollout's cursor for, the other bound on this side that leans on the
 * two-directory window. A clock that has gone backwards leaves a miss's age
 * unknown, and such a miss is treated as expired: it costs one walk, where
 * believing it would reopen the hole for however far the clock went back.
 *
 * AND ONE WHOLE-TREE WALK AT A TIME. Keeping the miss handles an id that comes
 * back; it does nothing for a caller that sends a new one every time. So a
 * lookup that is owed the whole tree while another lookup is walking it reads
 * the newest two directories instead, keeps nothing, and gets its full walk on
 * a later pass. A burst of fresh ids costs one walk of the history plus a few
 * readdirs each, not one walk each, all at once.
 *
 * The map is bounded as it was: forgetSession evicts it with every other
 * per-session cache, and a number is smaller than the path it stands in for.
 */
async function findCodexRolloutPath(sid) {
  const cached = codexRolloutPathBySid.get(sid);
  if (typeof cached === "string") return cached;
  // Owed the whole tree: never looked for yet, or the whole tree's last miss is
  // no longer believed — and nobody else is walking it.
  const startedAt = Date.now();
  const age = typeof cached === "number" ? startedAt - cached : -1;
  const missHolds = age >= 0 && age < CODEX_MISS_TTL_MS;
  const whole = !missHolds && !codexWholeTreeWalk;
  if (whole) codexWholeTreeWalk = true;
  // Walk year → month → day → files, newest first. Codex includes the sid in the
  // filename (rollout-...-<sid>.jsonl) so a directory-scoped match is enough.
  // The walk itself lives in codex-dir.mjs, shared with the watcher's listing
  // below and with codex-usage.mjs, so all three read one tree the same way.
  let found = null;
  let dayDirs = 0;
  try {
    await walkRolloutDays((dayDir, files) => {
      const hit = files.find(f => f.includes(sid) && f.endsWith(".jsonl"));
      if (hit) {
        found = join(dayDir, hit);
        return STOP;
      }
      if (!whole && ++dayDirs >= CODEX_RECENT_DAY_DIRS) return STOP;
    });
  } finally {
    if (whole) codexWholeTreeWalk = false;
  }
  // A hit is kept, as it always was. A miss is kept only when it is the whole
  // tree's answer — a miss in the newest two directories says nothing about the
  // rest of them — and it is kept as the moment that walk began, which is when
  // it read the directories a rollout written since would be in.
  if (found) codexRolloutPathBySid.set(sid, found);
  else if (whole) codexRolloutPathBySid.set(sid, startedAt);
  return found;
}

/**
 * The head and the tail of a Codex rollout, never the middle.
 *
 * WHAT THIS FIXES (#792). It called itself a tail-read and read the whole file:
 * `Buffer.alloc(s.size)` in one go, then `split` and `JSON.parse` over every
 * line. Measured against this machine's own largest rollout — 44.4 MB — that is
 * 181ms to read and decode, 95ms of SYNCHRONOUS parsing blocking the event
 * loop, and 185 MB of resident memory for the buffer, the string and the split
 * array together. Past about 512 MB `toString` throws outright, the catch
 * answers null, and the deck reports no Codex usage or model for the rest of
 * its life.
 *
 * It is reached from `/api/event`, which is in OPEN_MUTATIONS — no token, no
 * browser identity — so any local process can ask for it, and the per-session
 * throttle is keyed on `sid`, which means distinct sid strings each get their
 * own budget. That note's own rule is the one this violated: the deck's memory
 * "cannot be a function of anything but the two constants named here".
 *
 * WHY HEAD AND TAIL RATHER THAN A CURSOR. The four fields do not live in one
 * place. `session_meta` is the FIRST record — cwd, sometimes the model — while
 * the last `token_count`, the last `task_started` and the newest
 * `response_item` model are all at the END. A forward cursor would have to keep
 * the head's answers across polls, which is a second cache to invalidate; two
 * bounded reads answer the same question with no state at all.
 *
 * A file smaller than both windows is read once, so nothing changes for the
 * ordinary rollout — the median here is well under a megabyte.
 */
const CODEX_HEAD_BYTES = 256 * 1024;
const CODEX_TAIL_BYTES = 2 * 1024 * 1024;

// Exported for the suite, which is the only way to drive the head-and-tail
// branch: building a rollout larger than both windows is cheap, and reaching
// this function through /api/event would mean a server, a discovery file and a
// throttle that all have nothing to do with what is being measured.
export async function readCodexRollout(path) {
  try {
    const s = await stat(path);
    if (s.size === 0) return null;
    let text;
    if (s.size <= CODEX_HEAD_BYTES + CODEX_TAIL_BYTES) {
      text = await readByteRange(path, 0, s.size);
    } else {
      // A newline between them so the two windows cannot splice a half line
      // from the head onto a half line from the tail and hand the parser a
      // record that never existed. The tail's own first line is partial by
      // construction and is dropped the same way: `JSON.parse` refuses it and
      // the loop below skips it.
      const head = await readByteRange(path, 0, CODEX_HEAD_BYTES);
      const tail = await readByteRange(path, s.size - CODEX_TAIL_BYTES, s.size);
      text = `${head}\n${tail}`;
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
//   session_meta                       → SessionStart, but ONLY for a rollout
//                                        this watcher read from byte 0 (#684).
//                                        See ensureCodexRoot.
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
// path -> { offset, sid, cwd, skip, sawBeginning, rootOpened, seenAt }
const codexFileState = new Map();
// How long a rollout's tail cursor is kept after it stops showing up in the
// listing. The listing covers two day-directories, so anything missing from it
// is at least a day old and will never be appended to again.
const CODEX_STATE_TTL_MS = 10 * 60 * 1000;
// Every rollout path this PROCESS has ever held a cursor for, which the TTL
// sweep deliberately does not clear — that is the whole of its job.
//
// A cursor dropped and then re-created is indistinguishable, to the code that
// creates it, from a rollout nobody has ever read: both are "no entry in
// codexFileState". The difference matters enormously, because a new file is
// opened at byte 0 and told it has its own beginning, so a re-discovery
// replayed the entire rollout as fresh events AND minted a `SessionStart` for a
// session this deck joined late. This set is what lets the second case answer
// "no, we have seen this one" and park at the end instead (#981).
//
// Capped, in insertion order, for the reason codexFileState is swept at all: a
// long-lived deck on a busy machine would otherwise accumulate a path per
// session for as long as it runs. A path is far cheaper than a cursor, so the
// cap is generous — but it is a cap, and it is the same LRU shape
// sessionTouchedAt uses.
const codexSeenEver = new Set();
const MAX_CODEX_SEEN_EVER = 512;
function rememberCodexPath(path) {
  // Delete-then-add so the Set's own insertion order IS the LRU order, and
  // eviction is one key read rather than a scan.
  codexSeenEver.delete(path);
  codexSeenEver.add(path);
  while (codexSeenEver.size > MAX_CODEX_SEEN_EVER) {
    codexSeenEver.delete(codexSeenEver.values().next().value);
  }
}
let codexScanRunning = false;
let codexWatchTimer = null;
let codexWorkspace = "";

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

/**
 * The session id a rollout's own file name carries, or null.
 *
 * Codex names every rollout `rollout-<YYYY-MM-DDTHH-MM-SS>-<uuid>.jsonl` —
 * codex-usage.mjs reads the timestamp half as parseRolloutTime — and the uuid
 * is the id `session_meta.payload.id` states. findCodexRolloutPath already leans
 * on that, matching a session id against file names, so the name is the
 * fallback when the header stops saying it (#996). A compressed `.jsonl.zst`
 * is not matched: this reader never opens one.
 */
export function sidFromRolloutName(path) {
  const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(basename(String(path ?? "")));
  return m ? m[1] : null;
}

/** Which of the two ways a rollout can fail to say whose it is has been printed
 *  already. Once per kind for the life of the process, not once per file: the
 *  scan retries a rollout it cannot place on every tick, and a change to the
 *  format would hit every rollout at once, so per file would be the same
 *  sentence once for each of them. */
const codexHeaderWarned = new Set();
function warnUnplacedRollout(kind, path, why) {
  if (codexHeaderWarned.has(kind)) return;
  codexHeaderWarned.add(kind);
  console.warn(`${PRODUCT}: cannot tell which Codex session ${path} belongs to: ${why}. If Codex has changed its rollout format, its sessions will not be drawn until the deck reads the new one.`);
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
          // THE ID, WITH THE FILE NAME BEHIND IT (#996). Every other field this
          // file takes off a rollout goes through a type guard, and the event
          // names are read in both spellings because OpenAI has renamed a record
          // once already; this one went straight into `sid`. A renamed or
          // dropped `payload.id` made every header answer undefined, and the
          // scan `continue`s on that — so every rollout was retried on every
          // tick, its first 64KB re-read each time, not one Codex session was
          // drawn, and nothing said why. The file name carries the same id.
          const id = obj.payload.id;
          const sid = typeof id === "string" && id !== "" ? id : sidFromRolloutName(path);
          if (!sid) warnUnplacedRollout("no-id", path, "its session_meta has no id, and its file name carries none");
          // Canonicalised here and nowhere else: everything downstream — the
          // workspace test below, the log election, the cwd on every event this
          // rollout produces — reads state.cwd, and this is the one place it is
          // read off disk. See canonicalCwd.
          return { sid, cwd: await canonicalCwd(obj.payload.cwd) };
        }
        // The other rename the scan would otherwise retry in silence: a first
        // line that is whole but is not a session_meta will never become one.
        // Said, not guessed around — which record a renamed header would be is
        // not something to infer from one line. Only for a file named like a
        // rollout, so some other `.jsonl` left in the tree is not reported as a
        // format change.
        if (obj && typeof obj === "object" && sidFromRolloutName(path)) {
          warnUnplacedRollout("no-header", path, `its first line is a ${JSON.stringify(String(obj.type ?? "record with no type"))}, not a session_meta`);
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

// `persist` is false when another deck tailing this same rollout was elected to
// write it to the log they share. The event is still buffered and broadcast —
// every deck watching the session draws it — it is only the second copy on disk
// that is dropped. See writesCodexLog in log-writer.mjs.
function emitCodexEvent(payload, persist) {
  pushEvent(payload, "codex", { persist });
}

/**
 * Open this rollout's session on the canvas, once, lazily — only when it
 * actually produces an event. Emitting eagerly for every file on disk at
 * startup would fill the canvas with empty roots for sessions nobody will ever
 * append to again.
 *
 * WHETHER A `SessionStart` IS EMITTED AT ALL IS THE WHOLE OF #684.
 *
 * This used to mint one unconditionally, and for a rollout the deck joined
 * partway through that event is a false statement. #683 made the falsehood
 * visible rather than merely wrong: a root created by anything OTHER than a
 * `SessionStart` is marked `synthetic` in the reducer — "the deck joined this
 * session after it had already begun, so the start time, the prompt history and
 * the early tool calls on this card are incomplete rather than empty" — and a
 * Codex session that carries a minted `SessionStart` clears that marker and
 * asserts a beginning nobody watched. The Claude side never had the problem: a
 * deck that starts mid-session simply never receives a `SessionStart` hook for
 * it, which is exactly the case the marker was built for.
 *
 * `sawBeginning` is the one fact that separates the two, and it is not a
 * filesystem question. It is set where the tail cursor is: TRUE when this
 * watcher opened the rollout at byte 0 and therefore holds every line the
 * session ever wrote, FALSE when codexScanOnce's `firstRun` skipped a
 * pre-existing file's history by seeking to its current size. That is the same
 * fact the event states, read off the only thing that actually knows it, and it
 * is the same on Linux, macOS and Windows because no platform API is consulted.
 *
 * WHY NOT `fs.watch`, AND WHY NOT `birthtime` — both measured rather than
 * assumed, on Node 22.14 / darwin, plus the documented behaviour elsewhere:
 *
 *   • `fs.watch` on a path that does not exist throws ENOENT, and
 *     ~/.codex/sessions/YYYY/MM/DD does not exist until the day's first
 *     session — the same reason startCodexWatcher polls instead of watching.
 *   • a NON-recursive watch on ~/.codex/sessions reports only `rename:2026`
 *     when a rollout appears three levels below it; the file's creation is
 *     invisible to it.
 *   • `recursive: true` works here and on Windows, and on Linux only from a
 *     Node 20.x release — while this package declares `"node": ">=18"`, so on
 *     the OS Codex users most often run servers on it may simply not be there.
 *   • even where it works the event does not mean "created": writing the file
 *     and then rewriting it produced `rename:rollout.jsonl` BOTH times, and
 *     Node documents the event type as not guaranteed and `filename` as
 *     possibly null.
 *   • `stat().birthtimeMs` is real on APFS, but Node documents it as falling
 *     back to ctime or to the Unix epoch on filesystems that do not carry it —
 *     so on some Linux hosts every rollout would look newborn.
 *
 * WHAT ANOTHER DECK SEES. Nothing new: the fix REMOVES a line from
 * events.jsonl, it does not add one or change a shape. A joined-late Codex
 * session now reaches the shared log looking exactly like a joined-late Claude
 * one — a root conjured by its first real event — which every deck, including
 * one older than #683 that has no marker to light, has always been able to
 * replay. The events that create the root instead (`UserPromptSubmit`,
 * `PreToolUse`, `ModelObserved`, …) each carry `provider: "codex"`, `cwd` and
 * `approval_policy` from `base` in codexObjToPayload, so nothing an older deck
 * read off the `SessionStart` is lost with it.
 *
 * `rootOpened` still flips in both cases, and deliberately: it gates the
 * per-batch AGENTS.md resolution in codexScanOnce, which asks "is this session
 * being drawn", not "did we announce it".
 */
function ensureCodexRoot(state, persist) {
  if (state.rootOpened) return;
  state.rootOpened = true;
  if (!state.sawBeginning) return;
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
          codexFileState.set(path, { offset: st.size, sid: header.sid, cwd: header.cwd, skip: true, sawBeginning: false, rootOpened: false, seenAt: now });
          continue;
        }
        // Opened at byte 0, so every line this session ever wrote is about to
        // be read: this watcher HAS its beginning, and ensureCodexRoot may say
        // so. The `firstRun` branch below is the one case that takes it away.
        //
        // UNLESS THIS PROCESS HAS SEEN THE PATH BEFORE, in which case there is
        // no beginning to claim and nothing to replay: the cursor was dropped
        // by the TTL sweep and this is a RE-discovery. Parking at the current
        // size costs whatever was appended while the tree was unreachable,
        // which is the same trade `firstRun` already makes below — against
        // re-emitting every prompt, every PreToolUse/PostToolUse and every
        // UsageObserved in the file to every tab, and re-appending the lot to
        // the shared events.jsonl if this deck is the elected writer (#981).
        const fresh = !codexSeenEver.has(path);
        state = { offset: fresh ? 0 : st.size, sid: header.sid, cwd: header.cwd, skip: false, sawBeginning: fresh, rootOpened: false, seenAt: now };
        codexFileState.set(path, state);
        rememberCodexPath(path);
        if (firstRun) {
          // On startup, skip a pre-existing session's history entirely — no
          // replay. Only future appends (a live session that keeps going) will
          // lazily open the root via ensureCodexRoot.
          //
          // And it opens WITHOUT a `SessionStart` (#684). Seeking to the
          // current size is precisely the admission that this deck did not
          // watch the session begin, so it must not go on to emit the event
          // that says it did — that is the input #683's joined-late marker is
          // entitled to trust. A deck RESTARTING over a session that is still
          // running lands here too, and correctly: the new process holds none
          // of the old one's history either. If the log it replays at boot
          // already contains a `SessionStart` this deck minted honestly in an
          // earlier life, the root is rebuilt unmarked from that line and stays
          // unmarked, because nothing here emits a second one to disturb it.
          //
          // NOT because the reducer would refuse to listen. It used to say so
          // here — "the reducer only honours `synthetic` on the call that
          // CREATES the node" — and that is false: `reducer.ts` clears
          // `root.synthetic` on EVERY `SessionStart`, deliberately, so that one
          // arriving after the event that created the root retracts a marker
          // the deck no longer deserves to be wearing (#677). Which makes the
          // marker exactly as honest as the emitter above it, and is why the
          // rule this branch states — do not emit a `SessionStart` for a
          // beginning this process did not watch — is the whole guarantee
          // rather than a belt beside a brace (#981).
          state.offset = st.size;
          state.sawBeginning = false;
          continue;
        }
      }

      if (state.skip) { state.offset = st.size; continue; }
      // A cursor sitting PAST the end of the file is a different thing from
      // "nothing new", and the two used to collapse into one `continue` — where
      // the Claude scanner beside this one starts the file over (scanTranscript).
      // Not reachable today: rollouts are append-only and uniquely named, and
      // readAppendedLines cannot advance a cursor past `size`. It is resynced
      // FORWARD rather than back to zero because re-reading a rollout from the
      // beginning is precisely the full replay #981 is about.
      if (st.size < state.offset) state.offset = st.size;
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
      const persist = !eventLogPath()
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
      if (state.rootOpened) maybeResolveCodexMemory(state.sid, state.cwd, persist);
    }

    // Rollout files fall out of the newest-2-days listing and never come back,
    // but their tail cursors used to live as long as the process did. Expire by
    // "not seen for a while" rather than "absent from this listing": a single
    // unreadable directory mid-scan would otherwise drop a live file's cursor,
    // and re-adding it at offset 0 replays that entire rollout as fresh events.
    //
    // AN EMPTY LISTING IS NOT EVIDENCE THAT ANYTHING WENT AWAY, and skipping
    // the sweep on those ticks is the other half of the same argument. The
    // "not seen for a while" clock was meant to ride out a directory that is
    // unreadable for a moment, and it did — but it ran on ticks where `seenAt`
    // had been refreshed for NOBODY, because walkRolloutDays swallows its
    // readdir error at every level and answers `[]` rather than throwing. Ten
    // minutes of an unreachable $CODEX_HOME — a network or removable volume, an
    // encrypted home not yet unlocked, a permission change — and every cursor
    // was gone, which is the whole window the clock was sized to survive (#981).
    //
    // Nothing is lost by waiting: an empty listing means no file can be read
    // this tick anyway, and a tree that really is empty stays empty, so the
    // first tick that lists anything at all sweeps what is genuinely stale.
    if (files.length) {
      for (const [p, s] of codexFileState) {
        if (now - (s.seenAt ?? 0) > CODEX_STATE_TTL_MS) codexFileState.delete(p);
      }
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
  // Initial catalog: park a cursor at the end of every rollout already on disk,
  // skipping its history, then poll for new lines. The `true` is what tells
  // codexScanOnce that these files pre-date this deck, and so that the roots
  // they eventually open must arrive without a `SessionStart` (#684).
  codexScanOnce(true).catch(() => {});
  codexWatchTimer = setInterval(() => { codexScanOnce(false).catch(() => {}); }, 1500);
  if (codexWatchTimer.unref) codexWatchTimer.unref();
  return codexWatchTimer;
}

/**
 * Everything kept about one Codex session by id, dropped: where its rollout is,
 * when its usage was last read, and the model and approval policy the
 * translation remembers. Its one caller is forgetSession.
 */
function forgetCodexSession(sid) {
  codexRolloutPathBySid.delete(sid);
  lastCodexUsageReadAt.delete(sid);
  codexSessionModel.delete(sid);
  codexSessionApproval.delete(sid);
}

// What index.mjs calls besides the three exported above. Listed rather than
// marked at each declaration, so the declarations read as they did where they
// came from.
export { forgetCodexSession, maybeResolveCodex };
