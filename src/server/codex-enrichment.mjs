// What the deck learns about a Codex session that its hook payloads never say:
// the token spend, the model and the context window, read off the session's
// rollout — found by id under $CODEX_HOME/sessions — and sent on as synthetic
// events.
//
// This lived in src/server/codex-watch.mjs, above the rollout watcher, and
// shared nothing with it but the tree they both walk and the chunked reader.
// The watcher tails the rollouts for the events themselves; this reads one for
// what the events of a hook-delivered Codex session leave out. pushEvent
// (event-pipeline.mjs) hands every live event to maybeResolveCodex, and
// session-tracking.mjs forgets a session through forgetCodexSession. The
// bodies are unchanged.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { STOP, walkRolloutDays } from "./codex-dir.mjs";
// The per-session model and approval policy the translation remembers, which
// forgetCodexSession drops with the rest — see codex-translate.mjs.
import { codexSessionApproval, codexSessionModel } from "./codex-translate.mjs";
// The bounded chunk reads the Claude transcripts use — see jsonl-chunks.mjs.
import { readByteRange } from "./jsonl-chunks.mjs";
// event-pipeline.mjs's pushEvent, reached without importing it — see
// event-sink.mjs.
import { pushEvent } from "./event-sink.mjs";
// One read per session at a time, and none inside the window — see
// session-read-gate.mjs.
import { sessionReadGate } from "./session-read-gate.mjs";

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
const CODEX_READ_THROTTLE_MS = 2500;
const codexUsageReads = sessionReadGate(CODEX_READ_THROTTLE_MS);
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
  // in codex-watch.mjs and with codex-usage.mjs, so all three read one tree the
  // same way.
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
  codexUsageReads.run(sid, async () => {
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
  });
}

/**
 * Everything kept about one Codex session by id, dropped: where its rollout is,
 * when its usage was last read, and the model and approval policy the
 * translation remembers. Its one caller is forgetSession.
 */
function forgetCodexSession(sid) {
  codexRolloutPathBySid.delete(sid);
  codexUsageReads.forget(sid);
  codexSessionModel.delete(sid);
  codexSessionApproval.delete(sid);
}

// What event-pipeline.mjs and session-tracking.mjs call besides readCodexRollout
// above. Listed rather than marked at each declaration, so the declarations read
// as they did where they came from.
export { forgetCodexSession, maybeResolveCodex };
