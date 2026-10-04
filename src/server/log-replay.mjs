// The boot replay: what a starting deck reads back out of its log, and which of
// those events belong on this deck's canvas.
//
// These lived in src/server/index.mjs, after pushEvent. They push through
// event-sink.mjs as every other emitter outside index.mjs does, size their
// read against the ring's own two bounds (ring-bounds.mjs), and judge scope by
// the same predicate the Codex watcher runs (log-election.mjs) — nothing here
// reads the ring. startServer calls replayLog once, with the log openEventLog
// resolved. The bodies are unchanged.
import { existsSync } from "node:fs";
import { PRODUCT } from "./brand.mjs";
import { codexCwdInWorkspace } from "./log-election.mjs";
import { linesFromEnd, linesFromStart } from "./log-tail.mjs";
import { ENVELOPE_CHARS, MAX_BUFFER, MAX_BUFFER_CHARS, MAX_RING_ENTRIES, isEnrichment, isReservedEventName, payloadChars } from "./ring-bounds.mjs";
// event-pipeline.mjs's pushEvent, reached without importing it — see
// event-sink.mjs.
import { pushEvent } from "./event-sink.mjs";

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
 *   * `__clear` — the control marker `/api/clear` pushes, with `cwd: ""`. It is
 *     not a session event; it is the instruction that makes the reducer forget
 *     everything before it. It has not been written to the log since #698, but
 *     logs the decks before that wrote still carry it, and dropping it on a
 *     scoped deck would replay the state a user had explicitly cleared, so it
 *     is always admitted — when the server recorded it, which replayLog
 *     checks before asking this (see `usable` there).
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
export function replayScope(workspace, platform = process.platform, providers = null) {
  // WHICH CLIS THIS DECK IS WATCHING, and the half of `--no-codex` that did not
  // exist (#1004). Live capture is gated on the provider — `if (codex)
  // startCodexWatcher(...)`, and the Claude hook is only installed when
  // `deckProviders().claude` — and the boot replay was not, so a deck started
  // with `--no-codex` printed
  //
  //     Codex sessions   skipped — no ~/.codex/, or --no-codex
  //
  // and then filled its canvas with Codex sessions out of the machine-wide
  // events.jsonl, frozen mid-turn, which no live path could ever close because
  // the watcher that would have is the one that was skipped. Measured on a log
  // of two Claude lines and two Codex lines replayed with `codex: false`:
  //
  //     in the ring: [ 'claude:claude-1:SessionStart', 'claude:claude-1:PreToolUse',
  //                    'codex:codex-1:SessionStart',  'codex:codex-1:PreToolUse' ]
  //
  // The mirror case is worse: a `--no-claude` deck replays Claude sessions while
  // `providers.claude` is false, so App.tsx hides the accounts panel and the
  // sound controls — sessions on screen the deck has deliberately taken the
  // controls for away.
  //
  // It costs one comparison per line. `provider: "codex"` is stamped on every
  // payload the Codex watcher emits, its cwd-less enrichment included, and the
  // Claude side is the complement — which is what types.ts already says
  // `provider` means ("defaults to claude for replay events written before
  // multi-provider support"). So this needs no per-session memory of its own and
  // leaves `orderDependent` alone.
  const claudeOn = providers?.claude !== false;
  const codexOn = providers?.codex !== false;
  const scoped = !!workspace && typeof workspace === "string";
  if (!scoped && claudeOn && codexOn) {
    const all = () => true;
    // Every caller gets the same answer for the same payload, forever. That is
    // what lets replayLog read the log from its end — see `orderDependent` on
    // the scoped predicate below for the half that cannot.
    all.orderDependent = false;
    return all;
  }
  const bySession = new Map();
  /**
   * THE ANSWER DEPENDS ON WHAT CAME BEFORE, and #742 is why that is now stated
   * out loud rather than left as an implementation detail.
   *
   * The synthetic enrichment events — ModelObserved, UsageObserved,
   * SessionNamed, ContextObserved — carry a session_id and no cwd, so the only
   * thing that can decide them is a cwd-bearing event for the same session,
   * and that event is EARLIER in the log. Fed the log backwards, this predicate
   * meets the enrichment first, has nothing in `bySession`, and drops it: the
   * session lands on the canvas with no model and no tokens.
   *
   * So the flag is not advice. replayLog reads it, and reads the file forwards
   * whenever it is set. Making a scoped replay cheap needs an index of where a
   * workspace's lines are, which is a different change from this one.
   */
  admits.orderDependent = scoped;
  return admits;

  function admits(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.hook_event_name === "__clear") return true;
    // The provider gate, ahead of the workspace one and exempting `__clear` for
    // the same reason it does: the marker carries no provider, and a deck that
    // dropped it would replay a canvas the user had explicitly cleared.
    if (!(payload.provider === "codex" ? codexOn : claudeOn)) return false;
    if (!scoped) return true;
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
 * The ring's three bounds, counted the way the ring counts them, for a reader
 * that stages the log newest-first and has to know when to stop.
 *
 * MAX_BUFFER is HOOK events since #1032: the enrichment interleaved among them
 * (LAST_VALUE_WINS) rides free, bounded only by MAX_RING_ENTRIES and
 * MAX_BUFFER_CHARS. This used to count every line toward MAX_BUFFER, and at the
 * ~1.6 enrichment lines a real deck logs per hook event that stopped the boot
 * replay with about a third of the ring's window rebuilt (#1750). `add` stages
 * one payload and answers whether the ring is now full.
 */
function ringBudget(maxEvents, maxEntries, maxChars) {
  let hookEvents = 0;
  let entries = 0;
  let chars = 0;
  const full = () => hookEvents >= maxEvents || entries >= maxEntries || chars >= maxChars;
  return {
    full,
    add(payload) {
      entries++;
      if (!isEnrichment(payload)) hookEvents++;
      chars += ENVELOPE_CHARS + payloadChars(payload);
      return full();
    },
  };
}

/**
 * Can this log fill the ring on its own?
 *
 * Read from the END and bounded by the ring, so the answer costs at most one
 * ring's worth of parsing however large the file is — and on a full log it
 * stops within the first few thousand lines. Deliberately UNSCOPED: the number
 * it returns is an upper bound on what any workspace predicate will admit, so
 * `false` is a certainty that the archive is needed while `true` is only the
 * absence of evidence that it is. See the order-dependent branch of replayLog
 * for why that asymmetry is the right way round.
 *
 * Counted by `ringBudget`, the same rule the unscoped replay stops by, so
 * "fills the ring" means MAX_BUFFER hook events and not MAX_BUFFER lines of
 * which most are enrichment (#1750).
 */
async function fillsRing(filePath, maxEvents, maxEntries, maxChars) {
  const budget = ringBudget(maxEvents, maxEntries, maxChars);
  for await (const line of linesFromEnd(filePath)) {
    if (!line) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt || typeof evt !== "object" || !evt.payload) continue;
    if (budget.add(evt.payload)) return true;
  }
  return false;
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
 * WHAT THE FILTER COSTS AT BOOT, honestly: nothing is saved on the read of any
 * line this reaches, because the cwd being judged is inside the JSON. What it
 * saves is everything after the parse: no redaction pass, no envelope, no ring
 * insert, no character accounting and no eviction pressure for a line this deck
 * should never have held. The ring is bounded by MAX_BUFFER events AND
 * MAX_BUFFER_CHARS, so on a busy machine the out-of-scope traffic was not
 * merely extra — it was evicting the in-scope sessions the user started the
 * deck to watch.
 *
 * READ BACKWARDS, AND ONLY AS FAR AS THE RING (#742). This used to stream the
 * whole file from the front, and the whole file is where the boot's time went:
 * 12,079 lines and 31 MB on the machine it was measured on, 690ms of
 * JSON.parse, growing with every session until rotation cuts it at 50 MB — to
 * fill a ring that holds two thousand events. Five sixths of that parse was
 * feeding the eviction loop, on the critical path of a boot, every time.
 *
 * So the lines arrive newest-first and the loop stops the moment the ring is
 * full, which makes the cost a property of the ring's bounds rather than of how
 * long the user has been running the deck. Nothing is lost by it: what a
 * forward replay left in the ring was always the NEWEST admitted events that
 * fit, and that is the set this collects — provided "full" is counted the way
 * the ring counts it. Since #1032 that is MAX_BUFFER hook events with their
 * enrichment riding along, and counting every line toward MAX_BUFFER instead
 * rebuilt about a third of the window (#1750); see ringBudget. A young log —
 * too few events to fill the ring — is read to its start, and costs what it
 * always did.
 *
 * The order of the pushes is still oldest-first. `seq` is assigned by pushEvent
 * in the order it is called, and a ring numbered backwards would hand every
 * resuming client a Last-Event-ID that means the opposite of what it says.
 *
 * A SCOPED DECK STILL READS FORWARDS, and that is not an oversight. Its
 * predicate decides the cwd-less enrichment events — ModelObserved,
 * UsageObserved, SessionNamed, ContextObserved — from the cwd-bearing event
 * earlier in the log, so backwards it meets the answer after the question and
 * drops them: the session arrives on the canvas with no model and no tokens.
 * `replayScope` says which kind of predicate it handed over rather than this
 * inferring it from the workspace string, so the two cannot drift apart. Making
 * that case cheap needs an index of where a workspace's lines are, which is a
 * different change from this one.
 */
/* Exported for the suite, with the ceilings as parameters. The byte budget is
 * 128 MiB, so a test that wanted to reach it honestly would have to write 128
 * MiB — which is why the count bound was the only one anything pinned, and why
 * the byte bound was the one that broke. Production passes none of them. */
export async function replayLog(filePath, workspace = "", {
  maxEvents = MAX_BUFFER, maxEntries = MAX_RING_ENTRIES, maxChars = MAX_BUFFER_CHARS, providers = null,
} = {}) {
  // THE ARCHIVE IS PART OF THE HISTORY, and for two years nothing read it.
  // `maybeRotatePersistFile` renames events.jsonl to events.jsonl.1 at 50 MB;
  // a grep for `.1` across src/ and bin/ finds the write, the copy deck-home's
  // migration makes, and two comments. replayLog is called once, with
  // `persistPath` alone. So the boot immediately after a rotation replays a
  // file holding a handful of lines while 50 MB of history sits beside it
  // unread — and the next rotation's `unlink` deletes it outright. Measured:
  // one rotation, then `replayLog(events.jsonl)` returning 1.
  //
  // The reader below already stops the moment EITHER of the ring's bounds is
  // reached, so on a log that can fill the ring on its own this costs nothing
  // at all: the archive is never opened. It is read only when the live log
  // cannot fill the ring, which is exactly the window a rotation opens.
  //
  // A Clear opens the same window and means the opposite by it. It empties the
  // live log, which can then fill nothing, so reading on into the archive put
  // back precisely what the user had cleared (#1130) — which is why a Clear
  // removes the archive as well as emptying the live log, rather than this
  // learning to tell the two kinds of empty apart. See handleClear.
  const archivePath = filePath + ".1";
  const liveThere = existsSync(filePath);
  const archiveThere = existsSync(archivePath);
  if (!liveThere && !archiveThere) return 0;
  let skipped = 0;
  let skippedBytes = 0;
  // `providers` is the second scope this deck has, and it goes the same way the
  // first one does — into the predicate, so the replay rule stays pinned equal
  // to the live rule rather than being a second notion of it. See replayScope.
  const admits = replayScope(workspace, process.platform, providers);
  const replay = (evt) =>
    pushEvent(evt.payload, evt.source ?? "replay", { receivedAt: evt.receivedAt, replay: true });
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      skipped++;
      skippedBytes += Buffer.byteLength(line, "utf8");
      return null;
    }
  };
  // A control marker counts only when the server itself recorded it: the one
  // writer of `__clear` has always stamped it `internal`, and since #698 it is
  // not written at all. A line under a reserved name from anywhere else is not
  // the deck's instruction, and replaying it would hide everything before it.
  const usable = (evt) => evt && typeof evt === "object" && evt.payload
    && (evt.source === "internal" || !isReservedEventName(evt.payload.hook_event_name));

  let count = 0;
  if (admits.orderDependent) {
    // Oldest first, so the archive comes BEFORE the live log — `admits` is
    // stateful and answers from what it has already seen, which is the whole
    // reason this branch reads forwards at all.
    //
    // Whether the archive is worth reading is decided by a probe rather than by
    // this branch's own reader, because this branch has no stopping rule: it
    // pushes everything and lets the ring evict. The probe reads the LIVE log
    // backwards, unscoped, and is bounded by the ring, so it costs at most one
    // ring's worth of parsing from the end of the file and nothing more. An
    // unscoped count is an upper bound on what scoping will admit, so "this
    // cannot fill the ring" is certain when the probe says so — and when it
    // says the opposite a scoped deck may still under-fill, which is precisely
    // what it does today. Nothing regresses; the case a rotation creates, where
    // the live log holds a handful of lines, is the one that is fixed.
    const files = [];
    if (archiveThere && !(liveThere && await fillsRing(filePath, maxEvents, maxEntries, maxChars))) files.push(archivePath);
    if (liveThere) files.push(filePath);
    for (const file of files) {
      for await (const line of linesFromStart(file)) {
        if (!line) continue;
        const evt = parse(line);
        if (!usable(evt) || !admits(evt.payload)) continue;
        replay(evt);
        count++;
      }
    }
  } else {
    // Newest first, so this is filled back to front and then walked in reverse
    // to push. Bounded by ALL of the ring's limits (see ringBudget), which is
    // what makes the memory here a property of the ring rather than of the file.
    //
    // The count alone was not enough, and the comment that used to say it was
    // predates #625. Eviction is the only thing that applies MAX_BUFFER_CHARS,
    // and eviction happens inside pushEvent — which does not run until this
    // array is already full. Measured on a 187 MB log of 40 events of 4.9M
    // characters each, every one of them under the ingest cap: RSS went from
    // 215 MB to a peak of 505 MB, and the ring that survived held 27 events and
    // 126 MiB. About 290 MB staged for a ring capped at 128.
    //
    // Rotation at 50 MB normally keeps logs well under this, but rotation is
    // best-effort and its failure is only logged, and the rotation's own note
    // in event-log.mjs records logs reaching gigabytes.
    const newestFirst = [];
    const budget = ringBudget(maxEvents, maxEntries, maxChars);
    // Newest generation first. The second pass runs only if the first stopped
    // because it ran out of FILE rather than because it reached a bound, which
    // is the "cannot fill the ring" test stated exactly and for free — and it
    // is also why a full live log never opens the archive at all.
    for (const file of liveThere ? [filePath, archivePath] : [archivePath]) {
      if (!existsSync(file)) continue;
      if (budget.full()) break;
      for await (const line of linesFromEnd(file)) {
        if (!line) continue;
        const evt = parse(line);
        if (!usable(evt) || !admits(evt.payload)) continue;
        newestFirst.push(evt);
        // Everything older than this would be evicted by the events already held,
        // so reading further is work whose only result is throwing it away.
        // Any of the three limits reaching its ceiling means exactly that.
        if (budget.add(evt.payload)) break;
      }
    }
    for (let i = newestFirst.length - 1; i >= 0; i--) replay(newestFirst[i]);
    count = newestFirst.length;
  }
  if (skipped > 0) {
    // "in the part of the log it read", because that is now a part rather than
    // the whole: a damaged line older than the ring is never reached, and
    // claiming to have counted every unreadable line in the file would be a
    // number this no longer has.
    const kb = (skippedBytes / 1024).toFixed(0);
    console.warn(`${PRODUCT}: skipped ${skipped} unreadable line(s) (${kb}KB) while replaying the event log`);
  }
  return count;
}
