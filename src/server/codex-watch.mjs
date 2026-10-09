// The Codex half of capture: the rollouts directory tailed for the events
// themselves. A session's rollout found by id, for the usage its hook payloads
// never carry, is codex-enrichment.mjs.
//
// These lived in src/server/index.mjs, between the session enrichment and the
// ring's reader. They reach the pipeline through event-sink.mjs, as the
// enrichment does, and take the log election, the live decks, the canonical
// cwd and the chunked reader from the modules that own them — nothing here
// reads the ring or the SSE clients. index.mjs starts the watcher. The bodies
// are unchanged.
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PRODUCT } from "./brand.mjs";
import { STOP, sidFromRolloutName, walkRolloutDays } from "./codex-dir.mjs";
import { codexProfileSessionDirs } from "./codex-profiles.mjs";
// What one rollout line means as a hook payload, and the shape of the header
// record that says whose rollout it is — see codex-translate.mjs. The watcher
// below still decides which lines are read and where each one goes.
import { codexObjToPayload, codexSessionModel, sessionMeta } from "./codex-translate.mjs";
import { canonicalLogPath, codexCwdInWorkspace, writesCodexLog } from "./log-election.mjs";
// The one spelling of a rollout's cwd — see canonical-path.mjs.
import { canonicalCwd } from "./canonical-path.mjs";
import { eventLogPath } from "./event-log.mjs";
// Every deck registered right now that proved it is the deck its record
// describes — what the log election counts. See live-decks.mjs.
import { readLiveDecks } from "./live-decks.mjs";
// The bounded chunk reads the Claude transcripts use — see jsonl-chunks.mjs.
import { readAppendedLines, readByteRange } from "./jsonl-chunks.mjs";
import { maybeResolveCodexMemory } from "./session-enrichment.mjs";
// event-pipeline.mjs's pushEvent, reached without importing it — see
// event-sink.mjs.
import { pushEvent } from "./event-sink.mjs";

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
// path -> { offset, sid, cwd, skip, sawBeginning, rootOpened, seenAt, mtimeMs }
const codexFileState = new Map();
// How long a rollout's tail cursor is kept once nothing has moved it: not
// listed, and its mtime not changing. Leaving the listing is NOT the end of a
// rollout (#1730). `codex resume` appends to the file the session started in,
// in whatever day folder that was, and a session that runs across two later
// calendar days is still writing when its folder drops out of the newest two.
// So a cursor outside the listing is statted every tick and kept while its
// mtime moves, and one that is swept hands its offset to codexOlderRollouts
// below, which is how a rollout that falls silent and then resumes is found.
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
// Every rollout outside the newest two day directories that holds no cursor,
// by path, with the size it had when last looked at — null before the first
// look. The listing below reads two day directories a tick and must stay that
// cheap; this is how the rest of the tree is watched without walking it every
// tick (#1730).
//
// The whole tree is walked for it once at boot and again once per
// CODEX_STATE_TTL_MS, a readdir per day directory, which adds the paths it has
// not got. Each tick then stats at most CODEX_OLDER_STATS_PER_TICK of them, in
// turn, and a rollout that has GROWN since its last look is opened joined late
// from the size it had then: no SessionStart, since the deck did not watch the
// session begin, and nothing before that size, which the deck had either
// already drawn or had never been going to. A path whose first look is still
// to come has no size to grow from, so what is appended before that look is
// skipped, the trade the boot catalog already makes. A directory's mtime would
// be cheaper to watch and says nothing here: an append to a file leaves the
// directory holding it as it was.
//
// A cursor the sweep drops outside the listing hands its offset over, so a
// session that sat idle past the window resumes where the deck stopped reading.
// A path that cannot be statted leaves; a path the listing shows is the
// listing's.
const codexOlderRollouts = new Map();
let codexOlderTurn = null;
let codexOlderWalkedAt = null;
// About three seconds of stats per thousand old rollouts on a slow disk, spread
// over ticks: a resumed session in a history of N rollouts is found within
// ceil(N / 128) ticks, which is ~12s for a thousand and ~2 minutes for ten.
const CODEX_OLDER_STATS_PER_TICK = 128;

/** The next old rollout due a look, round-robin; null when there are none. The
 *  Map's own iterator is the turn: it survives deletions and ends after the
 *  newest key, and a fresh one starts the round again. */
function nextOlderRollout() {
  for (let pass = 0; pass < 2; pass++) {
    codexOlderTurn ??= codexOlderRollouts.keys();
    const next = codexOlderTurn.next();
    if (!next.done) return next.value;
    codexOlderTurn = null;
  }
  return null;
}

// The scan in flight, if any, as its promise. A tick that lands while one is
// still reading joins it rather than starting a second over the same cursors,
// and scanCodexNow can wait it out.
let codexScan = null;
let codexWatchTimer = null;
let codexWorkspace = "";

// List rollout files from the newest 2 day-directories. New sessions always
// land in today's dir, so this captures live activity without scanning years
// of history every tick. With `all`, the rest of the tree is listed too, as
// `older` — the walk codexOlderRollouts is filled from.
async function listRecentCodexRollouts(all = false) {
  const out = [];
  const older = [];
  // Each home needs its own two newest days. Otherwise a busy default account
  // can prevent the newest rollout in an alternate account from being seen.
  for (const sessionsDir of await codexProfileSessionDirs()) {
    let dayDirs = 0;
    await walkRolloutDays((dir, files) => {
      const into = dayDirs < 2 ? out : older;
      for (const f of files) if (f.endsWith(".jsonl")) into.push(join(dir, f));
      if (++dayDirs >= 2 && !all) return STOP;
    }, { sessionsDir });
  }
  return { files: out, older };
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
        const meta = sessionMeta(obj);
        if (meta) {
          // THE ID, WITH THE FILE NAME BEHIND IT (#996). Every other field this
          // file takes off a rollout goes through a type guard, and the event
          // names are read in both spellings because OpenAI has renamed a record
          // once already; this one went straight into `sid`. A renamed or
          // dropped `payload.id` made every header answer undefined, and the
          // scan `continue`s on that — so every rollout was retried on every
          // tick, its first 64KB re-read each time, not one Codex session was
          // drawn, and nothing said why. The file name carries the same id.
          const id = meta.id;
          const sid = typeof id === "string" && id !== "" ? id : sidFromRolloutName(path);
          if (!sid) warnUnplacedRollout("no-id", path, "its session_meta has no id, and its file name carries none");
          // Canonicalised here and nowhere else: everything downstream — the
          // workspace test below, the log election, the cwd on every event this
          // rollout produces — reads state.cwd, and this is the one place it is
          // read off disk. See canonicalCwd.
          return { sid, cwd: await canonicalCwd(meta.cwd) };
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
// that is dropped. See writesCodexLog in log-election.mjs.
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
 * session ever wrote, FALSE when openCodexCursor, on scanRollouts'
 * `firstRun`, skipped a pre-existing file's history by seeking to its current
 * size. That is the same fact the event states, read off the only thing that
 * actually knows it, and it is the same on Linux, macOS and Windows because no
 * platform API is consulted.
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
 * per-batch AGENTS.md resolution in scanRollouts, which asks "is this session
 * being drawn", not "did we announce it".
 */
function ensureCodexRoot(state, persist) {
  if (state.rootOpened) return;
  state.rootOpened = true;
  if (!state.sawBeginning) return;
  emitCodexEvent({ session_id: state.sid, cwd: state.cwd, provider: "codex", hook_event_name: "SessionStart" }, persist);
}

/**
 * A cursor for a rollout this watcher holds none for yet, recorded in
 * codexFileState, and returned when this tick should go on to read from it.
 * Null when it should not: the header cannot be read yet, so the file is
 * retried next tick; the rollout runs outside this deck's workspace, so a
 * skipping cursor is parked at its end; or this is the first scan, and the
 * file's history is skipped.
 */
async function openCodexCursor(path, st, now, firstRun) {
  // New file — read the header for sid + cwd, then decide whether to
  // capture it. Skip files outside our workspace.
  const header = await readCodexHeader(path);
  if (!header || !header.sid) return null; // not ready yet — retry next tick
  if (!codexCwdInWorkspace(header.cwd, codexWorkspace)) {
    codexFileState.set(path, { offset: st.size, sid: header.sid, cwd: header.cwd, skip: true, sawBeginning: false, rootOpened: false, seenAt: now });
    return null;
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
  const state = { offset: fresh ? 0 : st.size, sid: header.sid, cwd: header.cwd, skip: false, sawBeginning: fresh, rootOpened: false, seenAt: now };
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
    // CREATES the node" — and that is false: `applySessionStart`, in
    // src/web/session-lifecycle.ts, clears `root.synthetic` on EVERY
    // `SessionStart`, deliberately, so that one arriving after the event
    // that created the root retracts a marker the deck no longer
    // deserves to be wearing (#677). Which makes the marker exactly as
    // honest as the emitter above it, and is why the rule this branch
    // states — do not emit a `SessionStart` for a beginning this process
    // did not watch — is the whole guarantee rather than a belt beside a
    // brace (#981).
    state.offset = st.size;
    state.sawBeginning = false;
    return null;
  }
  return state;
}

/**
 * Send on each complete line of one batch appended to a rollout, as the hook
 * payload it translates to, opening the session's root before its first event.
 * A line that changes the session's model is preceded by a ModelObserved.
 * `persist` is the batch's one verdict — see emitCodexEvent.
 */
function emitCodexLines(state, consume, persist) {
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
}

/**
 * Rollout files fall out of the newest-2-days listing, but their tail cursors
 * used to live as long as the process did. Expire by "not seen for a while"
 * rather than "absent from this listing": a single unreadable directory
 * mid-scan would otherwise drop a live file's cursor, and re-adding it at
 * offset 0 replays that entire rollout as fresh events. "Seen" is listed, or
 * its mtime moved (#1730).
 *
 * What a swept cursor had read is not forgotten with it: its offset goes to
 * codexOlderRollouts, so a rollout written to again — a `codex resume` of it,
 * or a session that sat idle past the window — is read from where this deck
 * stopped, joined late. The listing takes the entry back if the path is listed.
 */
function sweepCodexCursors(now) {
  for (const [p, s] of codexFileState) {
    if (now - (s.seenAt ?? 0) > CODEX_STATE_TTL_MS) {
      codexFileState.delete(p);
      codexOlderRollouts.set(p, s.offset);
    }
  }
}

/**
 * Take the old rollouts a whole-tree walk found into codexOlderRollouts, each
 * without a size until its first look. A path already held keeps the size it
 * has: that is the one fact about it the walk cannot supply. Nothing is removed
 * here — a walk that could not read a directory answers as though it were
 * empty — so a path leaves only when it cannot be statted.
 */
function catalogOlderRollouts(older) {
  for (const p of older) {
    if (!codexOlderRollouts.has(p) && !codexFileState.has(p)) codexOlderRollouts.set(p, null);
  }
}

/**
 * Look at up to CODEX_OLDER_STATS_PER_TICK old rollouts, and return a cursor
 * for each that has grown since its last look, opened joined late from the
 * size it had then. See codexOlderRollouts.
 */
async function openGrownOlderRollouts(now) {
  const opened = [];
  const due = Math.min(CODEX_OLDER_STATS_PER_TICK, codexOlderRollouts.size);
  for (let i = 0; i < due; i++) {
    const path = nextOlderRollout();
    if (path == null) break;
    const was = codexOlderRollouts.get(path);
    let st;
    try { st = await stat(path); } catch { codexOlderRollouts.delete(path); continue; }
    if (was == null || st.size <= was) { codexOlderRollouts.set(path, st.size); continue; }
    const header = await readCodexHeader(path);
    if (!header || !header.sid) continue; // the size it grew from is kept; next round
    codexOlderRollouts.delete(path);
    const skip = !codexCwdInWorkspace(header.cwd, codexWorkspace);
    // Never `sawBeginning`, whatever this process read of the file before: the
    // lines before `was` are ones this deck has either drawn already or joined
    // too late for, and either way a SessionStart now would be a false one.
    const state = { offset: skip ? st.size : was, sid: header.sid, cwd: header.cwd, skip, sawBeginning: false, rootOpened: false, seenAt: now, mtimeMs: st.mtimeMs };
    codexFileState.set(path, state);
    rememberCodexPath(path);
    opened.push({ path, st, state });
  }
  return opened;
}

function codexScanOnce(firstRun) {
  codexScan ??= scanRollouts(firstRun).finally(() => { codexScan = null; });
  return codexScan;
}

/**
 * One scan that begins after this call, awaited — what the poll does every
 * 1500ms, on demand.
 *
 * A scan already reading when this is called may have listed the tree before
 * whatever the caller just changed, so it is waited out first and not counted.
 * The suite waits on this rather than on the poll's clock: a case that needs
 * "the watcher has looked since I wrote" used to sleep two polls for it, and a
 * case that needs "and nothing more came" two polls more (#994).
 */
export async function scanCodexNow() {
  if (codexScan) await codexScan;
  await codexScanOnce(false);
}

async function scanRollouts(firstRun) {
  try {
    const now = Date.now();
    // Read at most once per scan, and only from the first rollout that actually
    // has new bytes: most ticks read nothing and must not pay a directory
    // listing for the answer to a question nothing is asking.
    let decksRead = null;
    const liveDecks = () => (decksRead ??= readLiveDecks());
    // The whole tree at boot and once per CODEX_STATE_TTL_MS after, for
    // codexOlderRollouts; the newest two day directories on every other tick.
    // `null` rather than 0 for "never", so a clock that starts near the epoch,
    // or a faked one, cannot make boot look recent.
    const walkAll = codexOlderWalkedAt == null || Math.abs(now - codexOlderWalkedAt) >= CODEX_STATE_TTL_MS;
    const { files, older } = await listRecentCodexRollouts(walkAll);
    if (walkAll) { codexOlderWalkedAt = now; catalogOlderRollouts(older); }
    const listed = new Set(files);
    // Every rollout this tick has a reason to read, with its stat and cursor:
    // the listed ones, then the cursors outside the listing, then the old
    // rollouts found grown. One pass reads them all below.
    const due = [];
    for (const path of files) {
      codexOlderRollouts.delete(path); // listed, so the listing's
      let st;
      try { st = await stat(path); } catch { continue; }
      let state = codexFileState.get(path);
      if (state) state.seenAt = now;

      if (!state) {
        state = await openCodexCursor(path, st, now, firstRun);
        if (!state) continue;
      }
      state.mtimeMs = st.mtimeMs;
      due.push({ path, st, state });
    }
    // A cursor whose file has left the listing is still read, and kept for as
    // long as its mtime keeps moving (#1730). One that cannot be statted is left
    // for the sweep, as a listed file that cannot be is.
    for (const [path, state] of codexFileState) {
      if (listed.has(path)) continue;
      let st;
      try { st = await stat(path); } catch { continue; }
      if (st.mtimeMs !== state.mtimeMs) state.seenAt = now;
      state.mtimeMs = st.mtimeMs;
      due.push({ path, st, state });
    }
    due.push(...await openGrownOlderRollouts(now));

    for (const { path, st, state } of due) {
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
        || writesCodexLog({ decks: await liveDecks(), pid: process.pid, cwd: state.cwd,
          codexHome: canonicalLogPath(dirname(dirname(dirname(dirname(dirname(path)))))), });

      emitCodexLines(state, consume, persist);

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

    // AN EMPTY LISTING IS NOT EVIDENCE THAT ANYTHING WENT AWAY, and skipping
    // the sweep on those ticks is the other half of sweepCodexCursors'
    // argument. The "not seen for a while" clock was meant to ride out a
    // directory that is unreadable for a moment, and it did — but it ran on
    // ticks where `seenAt` had been refreshed for NOBODY, because
    // walkRolloutDays swallows its readdir error at every level and answers
    // `[]` rather than throwing. Ten minutes of an unreachable $CODEX_HOME — a
    // network or removable volume, an encrypted home not yet unlocked, a
    // permission change — and every cursor was gone, which is the whole window
    // the clock was sized to survive (#981).
    //
    // Nothing is lost by waiting: an empty listing means no file can be read
    // this tick anyway, and a tree that really is empty stays empty, so the
    // first tick that lists anything at all sweeps what is genuinely stale.
    if (files.length) sweepCodexCursors(now);
  } catch {
    /* swallow — watcher must never crash the server */
  }
}

export function startCodexWatcher(workspace) {
  codexWorkspace = workspace ?? "";
  // Deliberately not gated on CODEX_SESSIONS_DIR existing. `codex login`
  // creates ~/.codex, but sessions/ only appears when the first session
  // starts — and rollout tailing is the only Codex capture path there is, so
  // bailing out here meant a fresh install had to restart the deck before any
  // Codex agent ever showed up, while the banner claimed to be watching.
  // listRecentCodexRollouts lists nothing while the directory is missing, so the
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
