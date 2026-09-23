#!/usr/bin/env node
// agent-dag hook forwarder. Invoked by Claude Code or Codex CLI as a command
// hook. Reads stdin (event JSON), tags it with the provider passed via
// `--provider <name>`, finds every agent-dag server whose workspace contains the
// session — via the discovery files in <claude config dir>/agent-dag/ — makes
// each one prove it is the deck its file describes, and POSTs the payload. Dead
// instances are cleaned up.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const crypto = require("crypto");

// Single shared discovery dir — Claude Code and Codex CLI both register here
// via the installer. Lets one running agent-dag server receive both providers.
//
// This has to name the same directory src/server/claude-dir.mjs does, because
// the installer writes the files read below. It is duplicated rather than
// imported because this script is copied out of the package and run standalone
// by the host CLI, with no path back to the module it came from.
const configOverride = (process.env.CLAUDE_CONFIG_DIR || "").trim();
const CLAUDE_DIR = configOverride
  ? path.resolve(configOverride)
  : path.join(os.homedir(), ".claude");
const DIR = path.join(CLAUDE_DIR, "agent-dag");

function parseProvider(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider" && i + 1 < argv.length) return argv[i + 1];
  }
  return "claude";
}
const PROVIDER = parseProvider(process.argv.slice(2));

/**
 * The one spelling of a directory, so that a path this process reports and a
 * path bin/deck.js published can be compared as strings.
 *
 * Resolving symlinks is the half that is easy to think you can skip, because on
 * POSIX a cwd comes from getcwd(3) and has none left in it. Windows has no such
 * guarantee — GetCurrentDirectoryW returns the string the directory was set
 * with, junction, `subst` drive and all — so a workspace reached that way only
 * matches if BOTH sides go through here. The server's rollout watcher keeps its
 * own copy of this rule under the name canonicalCwd, for the Codex sessions that
 * never reach this file; a test walks one path through both. A path that does
 * not resolve keeps its resolved form, which is also what canonicalWorkspace
 * does with a directory the user has not created yet.
 *
 * `.native` IS THE RULE, not a detail. fs.realpathSync is a JavaScript
 * lstat-and-readlink walk that resolves symlinks and junctions and nothing else;
 * fs.realpathSync.native is GetFinalPathNameByHandleW, which also expands a DOS
 * 8.3 short component to its long form. This used to call the plain one while
 * the server's canonicalCwd went through the native one, so the moment a path
 * arrived short — `%TEMP%` under a shortened profile directory, which is what
 * every GitHub Windows runner has — the two canonicalisers that exist to agree
 * disagreed by a whole path: C:\Users\RUNNER~1\… against C:\Users\runneradmin\….
 * canonicalWorkspace in src/server/index.mjs says the rest of it, including why
 * the long form is the canonical one; all three sites name `.native` out loud.
 *
 * Exported for that test: it is half of what `--workspace` means, and a
 * predicate handed an already-canonical path cannot show that the caller
 * canonicalises.
 */
function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch {}
  return r;
}

/**
 * The same rule, off the main thread — and this is the one main() runs.
 *
 * A SYNCHRONOUS fs CALL CANNOT BE BOUNDED BY A TIMER ON THE SAME THREAD. While
 * fs.realpathSync.native is in the kernel this thread runs nothing, and the
 * `setTimeout` that is supposed to end this process is on that thread. So a
 * path that does not answer does not cost CAP_MS, it costs whatever the path
 * costs. Measured with one registry entry the filesystem never answers for, and
 * a healthy deck registered beside it (#1018):
 *
 *   STILL ALIVE after 12008ms — cap never fired
 *   deck saw: []            — never even challenged
 *
 * The realistic trigger is not exotic and is not the deck's fault: `$HOME` on
 * NFS/autofs/SMB, a CLAUDE_CONFIG_DIR on a network share, or — the widest
 * surface of the three — the SESSION'S OWN cwd on a network or FUSE mount,
 * which is a directory this process is handed rather than one it chose.
 * fs.realpath.native goes to libuv's threadpool instead, so the event loop
 * keeps its turn: the deadline fires, the decks that DID answer are challenged
 * and posted to, and the same run now reads
 *
 *   deck saw: challenge@431ms, POST /api/event@435ms
 *
 * WHAT IS LEFT, said plainly rather than left to be discovered. Node's exit
 * joins libuv's threadpool, so while a request is still executing in one of
 * those threads `process.exit(0)` does not complete either — measured: the
 * timer fires on time, calls exit, and the process is still there. Ending the
 * process by signal instead would trade a slow hook for a hook that looks like
 * it failed, which is the worse of the two in the user's own session. So the
 * residue is: the event is delivered on time, and a filesystem that never
 * answers at all is ended by the host CLI's own timeout — which is why that
 * timeout has to be a value this process can actually finish under, and is now
 * 3s in installer.mjs rather than 2s. A filesystem call that comes back late
 * rather than never — the ordinary stalled mount — costs nothing now.
 *
 * `cb` is called exactly once and never with an error: a path that does not
 * resolve keeps its resolved form, which is exactly what the sync one's empty
 * catch does with it. The sync normPath stays — it is the statement of the rule
 * that workspace-one-meaning.test.ts walks one table of paths through against
 * the server's canonicalCwd, and a predicate is easier to pin than a callback.
 */
function normPathAsync(p, cb) {
  const r = path.resolve(p);
  try { fs.realpath.native(r, (err, out) => cb(err ? r : out)); }
  catch { cb(r); }
}

/**
 * Does this platform's filesystem treat two spellings that differ only in case
 * as the same directory? Exported for tests: the platform is a parameter so
 * both answers can be checked from either kind of machine.
 *
 * Windows always does, and macOS does by default (APFS and HFS+ are formatted
 * case-insensitive unless the user deliberately chose otherwise). Linux does
 * not, and folding case there would be a bug of its own: /srv/Proj and
 * /srv/proj are two real directories, and a deck scoped to one must not be
 * handed the other's events.
 *
 * A case-sensitive macOS volume is therefore over-matched. That is the safe
 * direction to be wrong in — the cost is a deck that also sees a sibling tree
 * it was not scoped to, against the cost of the default configuration seeing
 * nothing at all.
 */
const foldsCase = (platform = process.platform) =>
  platform === "win32" || platform === "darwin";

/**
 * Is `cwd` the workspace directory or somewhere inside it?
 *
 * Both sides arrive already resolved, but resolved is not the same as
 * comparable. Neither path.resolve nor the JS fs.realpathSync canonicalizes
 * character case, so the drive letter and every component keep whatever case
 * the process that reported them happened to use — `c:\proj` from one shell,
 * `C:\Proj` from another, for one directory. A raw === / startsWith then says
 * "not in the workspace", the hook posts to nobody, and a scoped deck stays
 * empty with no error printed anywhere. Re-resolving through the platform's
 * own path flavour also settles separators and a trailing one, so
 * `C:/proj/` and `C:\proj` compare equal too.
 *
 * The platform is a parameter, following spawnSpec/isBatch in
 * src/server/exec.mjs, so the Windows rule is testable from a POSIX machine.
 */
function cwdInWorkspace(cwd, workspace, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = s => (foldsCase(platform) ? s.toLowerCase() : s);
  const a = fold(p.resolve(cwd));
  const b = fold(p.resolve(workspace));
  if (a === b) return true;
  // A root ("C:\", "/") already ends in the separator; appending a second one
  // would match nothing.
  return a.startsWith(b.endsWith(p.sep) ? b : b + p.sep);
}

/**
 * Does a deck scoped to `workspace` capture a session running in `cwd`? This is
 * the whole of what `--workspace` means, and it is a question about ONE deck: it
 * asks nothing about the others that may also be up, so a deck's answer never
 * depends on who else is running.
 *
 * An empty workspace is the default — machine-wide — and captures everything.
 * It is answered before cwdInWorkspace rather than passed to it because
 * p.resolve("") is the resolving process's own cwd, which here is the agent's,
 * so an unscoped deck would be silently scoped to whatever directory the user
 * happened to run their agent in.
 *
 * A session that never said where it runs is inside no workspace, so only an
 * unscoped deck sees it. Unreachable from main(), which exits before this on a
 * payload with no cwd — it is here because the rule has to be stated the same
 * way on both sides to be pinned against the other one.
 *
 * src/server/log-writer.mjs answers this same question, for the sessions the
 * server builds itself out of Codex's rollout files, under the name
 * codexCwdInWorkspace — this script is copied out of the package and run
 * standalone, so it cannot import that copy. A test walks one table of paths
 * through both: a disagreement between them is `--workspace` meaning two
 * different things depending on which CLI produced the session.
 */
function capturesSession(cwd, workspace, platform = process.platform) {
  if (!workspace || typeof workspace !== "string") return true;
  if (!cwd || typeof cwd !== "string") return false;
  return cwdInWorkspace(cwd, workspace, platform);
}

// Signal 0 delivers nothing; it asks whether the pid could be signalled.
//
// BOTH ERRNOS, and the second one is the Windows spelling. POSIX `kill(2)`
// answers EPERM for a process this account may not signal. On Windows
// `uv_kill` calls `OpenProcess`, a denial is ERROR_ACCESS_DENIED, and libuv
// maps that to EACCES — so a deck started from an elevated terminal, or under
// another account, read as DEAD to every probe in this repo. What followed was
// silent: the live deck's discovery file was unlinked on the next hook fire,
// rewritten five seconds later by keepDiscovery, and its banner went on
// claiming it was receiving events it had stopped receiving.
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && (e.code === "EPERM" || e.code === "EACCES"); }
}

/**
 * Of the decks about to be posted this event, which ones should also write it
 * to disk? Returns the subset that should; every other target is asked to
 * display the event and keep no record of it.
 *
 * The fan-out itself is deliberate — several decks can match one session and
 * they should all draw it. Persisting is not: they all default to the same
 * <claude config dir>/agent-dag/events.jsonl, so each of them appending its own
 * copy wrote every event once per running deck. The file then grew N times as
 * fast, rotated N times as often, and every replay of it ingested each tool
 * call N times, which is what put duplicate tools and duplicate bubbles on the
 * canvas after a restart.
 *
 * Decks are therefore grouped by the log file each one names in its discovery
 * record, and one deck per group is elected. Grouping by the file rather than
 * counting decks is what keeps the overrides honest: a deck run with
 * `--history` sits alone in its own group and always writes, a deck run with
 * `--no-persist` reports no file and can never be elected to write for one that
 * does, and a deck too old to report either keeps the behaviour it had before
 * this rule existed. Within a group the lowest port wins — a fixed rule, so the
 * same deck holds the file for as long as it is up and the next one inherits it
 * as soon as that deck is gone.
 *
 * The platform is a parameter, like cwdInWorkspace's, so the case-folding half
 * is testable from any machine.
 *
 * src/server/log-writer.mjs repeats this rule for the events no hook delivers —
 * the ones the server builds itself from Codex's rollout files — because this
 * script is copied out of the package and cannot import it. A test compares the
 * two directly: they decide for the same decks, and a disagreement is a line
 * written twice or not at all.
 */
function electWriters(decks, platform = process.platform) {
  const byLog = new Map();
  for (const d of decks) {
    const key = logGroup(d, platform);
    const held = byLog.get(key);
    if (!held || beforeInLine(d, held) < 0) byLog.set(key, d);
  }
  return new Set(byLog.values());
}

/**
 * Which log a deck is competing for — the group electWriters decides within.
 *
 * Two namespaces, so a deck with no log to share — and a deck too old to report
 * one — is alone in its group and cannot collide with a real path.
 *
 * Named rather than inlined because the hand-on in main() has to ask the same
 * question: when the elected writer cannot take the event, the decks entitled
 * to take it from it are exactly the ones this answers the same for.
 */
function logGroup(d, platform = process.platform) {
  const log = typeof d.persist === "string" ? d.persist : "";
  return log
    ? `log:${foldsCase(platform) ? log.toLowerCase() : log}`
    : `deck:${d.pid}:${d.port}`;
}

/**
 * The order a log's decks stand in to write it. Lowest port first; ports are
 * unique among live decks, so pid only breaks a tie a stale discovery file
 * could invent and the answer stays deterministic.
 *
 * A comparator rather than a "beats" predicate because main() sorts a whole
 * group with it — the second in line matters now, not only the first.
 */
function beforeInLine(a, b) {
  return a.port - b.port || a.pid - b.pid;
}

/**
 * The answer a deck must give to be handed a session payload.
 *
 * Liveness of the recorded pid is not evidence that the thing listening on the
 * recorded port is a deck. A deck killed with SIGKILL or lost to a power cut
 * leaves its discovery file behind — nothing unlinks it — and every cleanup
 * path here and in the server probes the same pid. Once the OS hands that
 * number to some other long-lived process the file passes forever, and the
 * port it names may by then belong to anything at all (4317, the deck's own
 * default, is also the standard OTLP collector port). What was POSTed there is
 * the whole hook event: prompt text, tool inputs, tool results, cwd.
 *
 * So the port has to prove itself before it is told anything. The deck writes a
 * fresh random token into its discovery file at startup; this hook asks the
 * listener to hash that token against a nonce it has never seen, and sends the
 * payload only if the answer matches. A stranger on the port cannot answer
 * without the token, and the nonce is new every time, so an answer overheard
 * earlier is worth nothing. Note the direction: the hook never transmits the
 * token itself, only a challenge, so a wrong listener learns nothing it could
 * replay against the next event.
 *
 * Both sides must derive the proof identically — src/server/index.mjs exports
 * the same function under the same name, and the pair is pinned by a test.
 */
function challengeProof(token, nonce) {
  return crypto.createHash("sha256").update(`${token}:${nonce}`).digest("hex");
}

/**
 * Must this target answer the challenge before it is handed a payload?
 *
 * Only a deck that advertises a token can be asked to prove it holds one. And
 * hook.js is a single shared file — <claude config dir>/agent-dag/hook.js,
 * installed by whichever deck booted most recently — while running several
 * decks at once is ordinary use. So a hook that knows about the handshake
 * routinely reads discovery files written by decks that predate it, which serve
 * no /api/hook-challenge route at all. Refusing those outright leaves every one
 * of them listening and permanently empty, with its banner still saying it is
 * receiving events.
 *
 * THE FALLBACK IS GONE, on the condition this comment set for itself: "drop it
 * once no deck older than 1.33.71 is plausibly still running". That release is
 * two majors back — this package is on 3.x — so the window has closed.
 *
 * What it did while it stood: a tokenless discovery file was handed the payload
 * on pid liveness alone, which is a control an adversary switches off by
 * leaving a key out of a JSON file. It cost that adversary nothing to write
 * one, since writing into the discovery directory at all is the capability in
 * question — but a stale file from an old deck, or a port another program has
 * since taken, is the ordinary case it also covered, and both are better served
 * by refusing.
 *
 * The cost of refusing is stated plainly: a deck older than 1.33.71 running
 * beside a current one receives nothing, while its banner still says it is
 * connected. That was the reason to keep the fallback in the first place, and
 * it is now a machine nobody has.
 */
function requiresProof(d) {
  return true;
}

// Constant-time compare, purely so a hostile listener cannot walk the expected
// proof out of us one byte at a time by timing how long we take to hang up. The
// lengths are public (64 hex chars) and a mismatched one is rejected outright,
// which is what timingSafeEqual requires of its arguments anyway.
function sameProof(got, want) {
  if (typeof got !== "string") return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Two round trips happen per target, and main()'s hard cap is CAP_MS, so the
// pair has to fit inside it with room to spare. The challenge is a bodyless GET
// to a loopback port — sub-millisecond when a deck is there, and instant
// ECONNREFUSED when nothing is.
//
// They are now separated by a barrier: every target is challenged, then the
// election is decided, then the payload goes out (#695). The worst case is
// unchanged — the challenges run in parallel, so it is still one challenge's
// two 400ms attempts followed by one 1000ms deadline, and each 400ms bounds the
// whole answer rather than a silence in it (see prove). What the barrier does
// cost is that an honest deck's POST waits for the slowest challenge in the
// set, which only matters when some OTHER record's port accepts a connection
// and then does not answer in time. A ghost port with nothing behind it refuses
// instantly and delays no one; one with something slow or silent behind it
// costs both attempts once, and its record is then forgotten if no deck has
// been keeping it — see forgetIfAbandoned.
const CHALLENGE_TIMEOUT_MS = 400;
const POST_TIMEOUT_MS = 1000;

// The third phase that can stall, and the one that had no deadline at all:
// reading the registry and canonicalising the paths in it. See discoverTargets
// for what it is bounding and why one unanswering path must not cost the event
// for every other deck on the machine.
const DISCOVERY_TIMEOUT_MS = 400;

// How long the canonical spelling of the session's cwd is worth waiting for
// before the merely-resolved one is used instead. Half the phase, so a cwd that
// never answers still leaves the registry scan a turn — see discoverTargets.
const CWD_TIMEOUT_MS = 200;

/**
 * The whole of this process's life, MEASURED FROM WHEN NODE STARTED rather than
 * from when main() ran — see the deadline main() sets.
 *
 * 1900ms is not the sum of the phase deadlines, and it is not meant to be. Four
 * phases now carry one — discovery 400, the challenge's two attempts 400 + 400,
 * the POST 1000 — and they only stack to 2200 if all three surfaces stall on
 * the same run: an unanswering filesystem, a port that accepts and says
 * nothing, and a deck that takes the body and never replies. Each deadline
 * bounds its own pathology; this one is the backstop over all of them, and it
 * is what a reader should believe rather than the addition.
 *
 * What it is NOT is the whole cost of a hook run, and that was the bug it hid.
 * Claude Code executes the command through `sh -c`, so a fork/exec, Node's own
 * startup and the read of a stdin payload that is routinely megabytes — a Read
 * or a Grep result arrives whole in `tool_response` — all happened BEFORE the
 * old timer was armed, and were charged to the host's clock anyway.
 *
 * Measured through the exact installed command shape, one ghost record stalling
 * the challenge and a deck that answers the handshake and then never answers
 * the POST (#1018):
 *
 *   idle, 16 cores, 134-byte payload:  1.847s  1.837s  1.836s
 *   48 busy workers:                   1.978s  2.010s  2.190s   <- past timeout: 2
 *   48 busy workers + 2MB payload:     2.160s  2.126s  2.165s   <- past timeout: 2
 *
 * The machine the retry in prove() exists for — "the full test suite, 335 files
 * in parallel" — is exactly the machine whose startup is slow enough to push the
 * total past the declared timeout, and being killed there costs the deck a
 * truncated body and the user the full timeout on that turn, because PreToolUse
 * blocks the tool call until every matching hook returns.
 */
const CAP_MS = 1900;

/**
 * Ask the listener to prove it is the deck that wrote `d`. `cb` is called
 * exactly once with true or false — a refused connection, a silent port and a
 * wrong answer are all just "not the deck this record describes" — and, for a
 * port that let BOTH deadlines pass, with "deadline" as a second argument: the
 * one verdict that costs 800ms, and the one proveTargets acts on.
 *
 * A deck that advertised no token cannot be asked and passes: see requiresProof.
 */
function prove(d, cb, attempt = 0) {
  let settled = false;
  // Armed once the request is out, and cleared by whichever verdict comes first.
  let deadline = null;
  // A DEADLINE IS NOT AN ANSWER, and the difference is worth one retry.
  //
  // A wrong proof, a refused connection and a 404 are all verdicts: that port
  // is not the deck this record describes, and asking again would get the same
  // answer. A TIMEOUT is not — it is a machine too busy to reply in 400ms, and
  // the deck on the other side is fine. Measured on the Windows box: the full
  // test suite (335 files in parallel) is enough load to make a healthy deck
  // miss that window, and the event is then dropped with nothing on screen to
  // say so. A big build or a machine running several agents is the same shape.
  //
  // One retry, only on the deadline: 400 + 400 for the challenge and 1000 for
  // the POST, inside the CAP_MS this process gives itself, which is inside the
  // timeout the installed hook entry declares — see CAP_MS for what that
  // relation is and why the second attempt is the expensive half of it when the
  // port answering is not a deck at all.
  const retryOnTimeout = () => {
    if (settled) return;
    if (attempt >= 1) return finish(false, "deadline");
    settled = true;                        // this attempt is over; the next owns `cb`
    prove(d, cb, attempt + 1);
  };
  const finish = (ok, why = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    cb(ok, why);
  };

  if (!requiresProof(d)) return finish(true);

  const nonce = crypto.randomBytes(16).toString("hex");
  const want = challengeProof(d.token, nonce);

  const req = http.request({
    hostname: "127.0.0.1",
    port: d.port,
    path: `/api/hook-challenge?nonce=${nonce}`,
    method: "GET",
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
      // Already given up on this target — a flood we cut off above. Whatever
      // arrived before that is not an answer we are going to act on.
      if (settled) return;
      let proof;
      try { proof = JSON.parse(answer).proof; } catch { return finish(false); }
      finish(sameProof(proof, want));
    });
  });
  req.on("error", () => finish(false));
  // THE DEADLINE IS ON THE WHOLE ANSWER, not on the silences in it (#1172).
  //
  // This was http.request's `timeout`, which is an IDLE timeout: it fires only
  // after that long with no bytes either way. A port that answers one byte
  // every 150ms is never idle and never reaches the 4096-byte cap above, so its
  // prove() never settled — and proveTargets waits for every target before
  // anything is posted. Measured with an honest deck beside such a port: the
  // hook ran to CAP_MS at 1938ms and the deck saw its challenge and no event,
  // on every tool call for as long as the record stood, and the record was
  // never forgotten either, because the "deadline" verdict forgetIfAbandoned
  // needs never came.
  //
  // The idle timeout had a second hole, and a port that sends its status line
  // and then goes quiet fell into it: once a response has begun, destroying the
  // request raises no 'error' on it, so the verdict that used to ride on that
  // event never arrived either. So the timer gives the verdict itself, and
  // gives it first: the destroy's own 'error', if it raises one, finds this
  // attempt already over.
  deadline = setTimeout(() => { retryOnTimeout(); req.destroy(); }, CHALLENGE_TIMEOUT_MS);
  req.end();
}

/**
 * Challenge every target, then hand back the ones that answered — in the order
 * they were given, so the election below is a function of the records alone.
 *
 * WHY THIS RUNS BEFORE THE ELECTION AND NOT AFTER IT (#695). The two round trips
 * per target have always both happened; they used to happen in the wrong order.
 * electWriters ran over every record whose pid was merely alive, and only then
 * did deliver() challenge each target and drop the ones that could not answer.
 * So a record left behind by a deck that is gone — SIGKILL, an OOM kill, a power
 * cut, a console window closed on Windows, none of which run the shutdown that
 * unlinks it — kept passing the one staleness test there is the moment the OS
 * handed its pid to some other long-lived process. If it also named a port below
 * every real deck's, it WON the election, was never posted to because it could
 * not answer, and no other deck was posted to with the flag either: every deck
 * drew the event, all of them were told `?persist=0`, and events.jsonl stopped
 * growing. Silently, for as long as that file sat in the directory.
 *
 * The election has to be decided over the decks that are actually going to be
 * handed the payload, and the only thing that establishes that is the handshake.
 * So: prove, then elect, then post. It costs no extra round trip, only this
 * ordering, and it is the same reordering src/server/index.mjs makes in
 * readLiveDecks for the Codex rollouts no hook ever sees.
 *
 * A FAILED CHALLENGE ON ITS OWN IS STILL NOT PROOF THE DECK IS GONE. A dead pid
 * is, and is swept above; a failed challenge is not — a deck restarting under
 * its supervisor refuses connections for a moment while its record still
 * stands, and a merely busy one can miss the 400ms deadline. Deleting another
 * deck's registration on that evidence alone trades a bug that loses log lines
 * for one that loses a whole deck's events.
 *
 * WHAT THAT COST WHEN SOMETHING WAS LISTENING (#1069). This paragraph used to
 * end "a ghost that survives on disk costs one instant ECONNREFUSED per hook
 * run", which is true only while NOTHING is listening on the port the record
 * names. Measured through the installed command shape, one healthy deck plus
 * one record whose pid is alive and names a port that accepts a connection and
 * then says nothing:
 *
 *   healthy deck alone                        36ms  38ms  39ms
 *   + ghost whose port refuses                36ms  45ms  37ms
 *   + ghost whose port accepts and is silent  849ms  848ms  836ms
 *
 * The retry in prove() turns one 400ms deadline into two, and the barrier makes
 * every honest deck's POST wait for the slowest challenge in the set — so that
 * was the price of EVERY event, for good, because nothing else ever removed the
 * record once the OS had recycled the dead deck's pid onto something
 * long-lived. And 4317, the deck's own default, is also the standard OTLP
 * collector port, so something silent being there is not far-fetched.
 *
 * So one more piece of evidence is asked for, and only on the verdict that
 * costs anything. A running deck keeps its record: keepDiscovery re-asserts it
 * every five seconds, and ensureDiscovery stamps the file's mtime each time even
 * when nothing in it has changed. A record that let both deadlines pass AND has
 * not been stamped for ABANDONED_AFTER_MS belongs to no running deck, whatever
 * its pid says, and is unlinked — see forgetIfAbandoned. The two cases above
 * stay protected: a restarting deck REFUSES, which is a different verdict and
 * never gets here, and a busy deck is still stamping its record every five
 * seconds, so however late its answer, its record is fresh. The table's last row
 * is now paid once, on the first event after the deck died, instead of on every
 * one after it.
 */
function proveTargets(targets, cb) {
  const ok = new Array(targets.length).fill(false);
  let pending = targets.length;
  const settle = () => { if (--pending <= 0) cb(targets.filter((_, i) => ok[i])); };
  targets.forEach((d, i) => prove(d, (answered, why) => {
    ok[i] = answered;
    // Inside the barrier rather than after it, so the unlink has landed before
    // main() can exit on the last POST. It is a stat and at most an unlink, on
    // the one path that has already spent 800ms waiting.
    if (why === "deadline") return forgetIfAbandoned(d, settle);
    settle();
  }));
}

/**
 * How long a record may go unstamped before a silent port is taken to mean that
 * no deck is keeping it. Twelve of keepDiscovery's five-second intervals: a deck
 * whose event loop has not run a timer for a minute is not answering anybody,
 * and if it does come back, its next check writes the record again.
 */
const ABANDONED_AFTER_MS = 60_000;

/** The file each target was read from, for forgetIfAbandoned. A WeakMap rather
 *  than a field on the record, because the record is the deck's own JSON and
 *  every field on it is a field some reader decides by. */
const RECORD_FILE = new WeakMap();

/**
 * Unlink `d`'s record if nothing has stamped it for ABANDONED_AFTER_MS. `done`
 * runs exactly once, whatever the filesystem says: a record that cannot be
 * statted, or that another hook run has already unlinked, is left as it is.
 *
 * A deck judged abandoned wrongly — frozen for a minute, then back — is not
 * lost: keepDiscovery finds its file missing on the next check and writes it
 * again, which is the case that function was written for.
 */
function forgetIfAbandoned(d, done) {
  const file = RECORD_FILE.get(d);
  if (!file) return done();
  fs.stat(file, (err, st) => {
    if (err || Date.now() - st.mtimeMs < ABANDONED_AFTER_MS) return done();
    fs.unlink(file, () => done());
  });
}

/**
 * Hand this deck the payload. `done` runs exactly once, with whether the deck
 * TOOK it — which is a different question from whether this target is finished,
 * and answering only the second one is #1019 — and, for the one ending that
 * answers neither yes nor no, with "deadline" as a second argument: see the
 * last paragraph.
 *
 * `persists` is this deck's answer from electWriters: true for the one deck that
 * logs the event, false for every other one it is also drawn on.
 *
 * THE STATUS LINE WAS NEVER READ. A 200, a 500 and a connection reset all ran
 * the same callback, so the hook counted every POST as delivered and the caller
 * had nothing to branch on. With the elected writer 500ing and one healthy deck
 * beside it, measured against a real deck and a real events.jsonl:
 *
 *   hook exit=0 wall=576ms   4450 (elected) POST /api/event           -> 500
 *                            4460 (healthy) POST /api/event?persist=0
 *                            drew on its canvas: ["tool-1019"]
 *                            events.jsonl lines: 0
 *
 * Same count for a writer that hangs up mid-body (wall=580ms) and for one that
 * takes the body and never answers (wall=1686ms). That is #695's symptom
 * through a different door: every deck draws the event, all the others were
 * told `?persist=0`, and the log silently stops growing.
 *
 * The status line settles this, whichever status it carries, rather than the
 * last byte of the response. The route answers 2xx only once the event is in
 * the ring and queued for the log, so that status IS the receipt and nothing
 * after it can withdraw one — while a socket that dies while the answer is
 * still arriving would otherwise read as a refusal and make main() hand the log
 * to a second deck that then writes the line a second time. Any other status
 * has refused already, and a body that stalls behind it must not run into the
 * deadline below and come out as something softer than a refusal.
 *
 * A DEADLINE AFTER THE BODY WENT OUT IS NOT A REFUSAL (#1133), and reading it as
 * one wrote the line twice. POST_TIMEOUT_MS is an idle timeout: when it fires,
 * it is this process that gave up, while the writer still holds the connection
 * with the whole event in its receive buffer. A busy deck — the load the retry
 * in prove() exists for — reads it when it catches up, appends the line and
 * answers into a socket nobody is listening on any more; by then main() had
 * already asked the next deck in line to append the same line. Measured with a
 * real deck behind a proxy that wins the election, forwards the handshake and
 * the POST at once, and holds back only the writer's 200:
 *
 *   writer's 200 held 1300ms   hook exit=0   lines for the event: 2
 *   writer's 200 held 0ms      hook exit=0   lines for the event: 1
 *
 * where the hook from before #1087 wrote one line in both. A duplicated line
 * does not go away: the replay draws it twice after every restart for as long
 * as the log is kept. So the endings are sorted by WHO ENDED THE EXCHANGE:
 *
 *   • a status line — 2xx took the event, anything else refused it;
 *   • an error this process did not cause — the connection refused, reset or
 *     closed with no answer on it — is the writer ending the exchange without
 *     claiming the event, and is `false`. A deck restarting under its
 *     supervisor refuses, and a deck that tears the socket down stopped short
 *     of the ingest: handleEventIngest queues the line and answers in one
 *     synchronous turn, so it cannot have done one without the other short of
 *     dying between two statements;
 *   • this process's own deadline is `false` only while the body is not all
 *     out — 'finish' is the kernel taking the last byte, and a writer that
 *     stopped reading before that cannot complete the request, let alone log
 *     it — and "deadline" once it is, because that writer may still append.
 *
 * "deadline" is the one ending main() does not hand on. It makes a slow writer
 * one line again, and it makes a writer that took the body and then never
 * answers at all the lost line it was before #1087. That is the trade, taken
 * on purpose: from here the two are the same observation until the process has
 * to end, a deck that answered its challenge within CHALLENGE_TIMEOUT_MS and
 * then stalls for good inside the next second is far rarer than one that is
 * merely slow, and a missing line costs one event where a duplicated one is
 * replayed forever. It is #1019's third measured case, and #1019's refusal and
 * hang-up cases still hand on.
 */
function post(d, body, persists, done) {
  let settled = false;
  let sendDeadline = null;
  const finish = (ok, why = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(sendDeadline);
    done(ok, why);
  };
  // Whether the kernel has taken the whole body, and whether it was this
  // process's deadline rather than the writer that ended the exchange — the
  // two facts the last paragraph above sorts an error by.
  let sent = false;
  let timedOut = false;
  const req = http.request({
    hostname: "127.0.0.1",
    port: d.port,
    // Only the elected deck records the event; the rest are asked to draw it
    // and keep no copy, so one log file ends up with one copy of it.
    path: persists ? "/api/event" : "/api/event?persist=0",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeout: POST_TIMEOUT_MS,
  }, res => {
    res.resume();
    finish(res.statusCode >= 200 && res.statusCode < 300);
  });
  // `destroy()` on a timeout makes 'error' fire with ECONNRESET — the status
  // line has not arrived, or it would have settled this already — so `timedOut`
  // is what tells this process giving up apart from the writer hanging up.
  //
  // AND THE BODY'S STATE IS READ WHEN THE DEADLINE FIRES, NOT WHEN THE ERROR
  // ARRIVES (#1172). `timedOut && sent` was evaluated in the 'error' handler,
  // and by the time that runs the answer is always yes: destroying a request
  // that has been end()ed finalises its writable, which emits 'finish' — so
  // `sent` flips to true on the way out of req.destroy(), one tick before the
  // 'error' it causes. Measured on Node 22 against a listener that takes the
  // headers and then stops reading, with 256MB still queued:
  //
  //   TIMEOUT  sent=false  writableLength=268435608
  //   FINISH   writableFinished=true  pending=0
  //   ERROR    ECONNRESET  sent=true      <- verdict "deadline"
  //
  // which made every deadline a "deadline" and left the paragraph above
  // describing a branch that could not be taken: a writer wedged mid-read kept
  // a log it had not received, and the deck behind it — which could have
  // written the line — was never asked. The snapshot is the rule that paragraph
  // states, taken at the only moment it is still true.
  let sentByDeadline = false;
  const expire = () => {
    if (settled) return;
    timedOut = true;
    sentByDeadline = sent;
    req.destroy();
  };
  req.on("error", () => finish(false, timedOut && sentByDeadline ? "deadline" : null));
  req.on("timeout", expire);
  req.on("finish", () => {
    sent = true;
    clearTimeout(sendDeadline);
    sendDeadline = null;
  });
  req.write(body);
  // `http.request`'s timeout is an idle-socket timeout. While a large body is
  // still being accepted into kernel buffers, those writes keep resetting it
  // even if the peer application stopped reading. Bound the send phase itself
  // so that a wedged writer can still hand the log to the next deck inside the
  // hook's process cap. Once `finish` says the kernel took the whole body, this
  // timer is cleared and the existing idle timeout remains the only deadline
  // on a slow answer, preserving #1133's no-duplicate rule. (#1195)
  sendDeadline = setTimeout(expire, POST_TIMEOUT_MS);
  sendDeadline.unref?.();
  req.end();
}

/**
 * Read one discovery record and decide whether the deck it describes captures
 * this session. `done` runs exactly once; a target that qualifies is pushed onto
 * `found` before it does.
 *
 * Nothing here is synchronous any more, and that is the point: see
 * normPathAsync. The record lives in <claude config dir>/agent-dag/, which is
 * under $HOME by default, and the workspace it names is any directory on the
 * machine — a stalled mount under either used to stop this whole process dead.
 */
function readRecord(file, resolvedCwd, found, done) {
  const full = path.join(DIR, file);
  fs.readFile(full, "utf8", (err, text) => {
    if (err) return done();
    let d;
    try { d = JSON.parse(text); } catch { return done(); }
    // THE SERVER'S GUARD, VERBATIM PLUS THE PORT RANGE. This read
    // `typeof d.workspace !== "string" || !d.pid || !d.port`, which has two
    // holes and both are reachable from one hand-edited file:
    //
    //   • `d.workspace` is a property access, and it sat OUTSIDE the try —
    //     so a record of `null` threw before the guard could refuse it;
    //   • `!d.port` admits any truthy non-port. `"http"`, `-1` and `{}` all
    //     passed, reached http.request({ port }) and threw SYNCHRONOUSLY
    //     inside the forEach below, before a single socket was opened.
    //
    // Either way: exit 1, a Node stack trace on stderr, and — measured — ZERO
    // POSTs to a healthy deck registered alongside. Claude Code surfaces a
    // non-zero exit as `<hook> hook error` with the first stderr line, on
    // every tool call, and nothing removes the record: pid 1 is init, so
    // isAlive is true forever and the unlink below never fires.
    //
    // index.mjs:2156 reads these same files and always refused them. Two
    // readers of one directory disagreeing is the bug; this is the stronger
    // half, which is the one that belongs in the process that cannot afford
    // to throw.
    //
    // IT IS INSIDE THE fs CALLBACK NOW, and that is where it has to be rather
    // than merely where it ended up. The reads are asynchronous (#1018), so the
    // throw this refuses would no longer come out of a loop in main() — it
    // would come out of a callback, where the only thing left to catch it is
    // the process-level handler main() installs. Refusing the record here is
    // what keeps that handler a last resort instead of the mechanism.
    // hook-read-only.test.ts runs the real script against each of these shapes,
    // so the guard is proved on the path it actually sits on.
    if (!d || typeof d.pid !== "number"
        || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535
        || typeof d.workspace !== "string") return done();
    // A missing token is not a reason to drop the file here — prove() decides
    // what a target has to prove, and a deck older than the handshake can
    // prove nothing. See requiresProof.

    if (!isAlive(d.pid)) return fs.unlink(full, () => done());

    // Where this record lives, for the one later verdict that may forget it —
    // see forgetIfAbandoned.
    RECORD_FILE.set(d, full);

    // "" is machine-wide and must never reach normPath: resolving it would
    // produce this hook's own cwd — the agent's — and scope a deck that asked
    // for no scope at all. Any other spelling is canonicalized here, which is
    // now a second pass over a path bin/deck.js already canonicalized before
    // publishing it — kept because a deck old enough to have published a
    // relative one is still entitled to its events.
    if (d.workspace === "") {
      if (capturesSession(resolvedCwd, "")) found.push(d);
      return done();
    }
    normPathAsync(d.workspace, ws => {
      if (capturesSession(resolvedCwd, ws)) found.push(d);
      done();
    });
  });
}

/**
 * Every deck whose workspace contains this cwd, and nothing else decides it.
 *
 * This used to sort the matches by how long each deck's workspace path was
 * and deliver only to the longest — so a deck scoped to /Users/x/proj TOOK
 * that tree's sessions away from a machine-wide deck, which then sat there
 * showing nothing while `--all` promised it captured every session on this
 * machine. Nothing documented that, and the server's own Codex capture never
 * did it: each deck tails the rollout files itself and evaluates its own
 * workspace, so a Codex session inside a scoped tree appeared on both decks
 * while the Claude session beside it appeared on one. One flag, one path,
 * two answers.
 *
 * The fan-out is the documented meaning and the one kept: `--workspace` says
 * which sessions a deck captures, not which sessions it takes from the decks
 * around it. It is also what electWriters assumes — several decks drawing one
 * event is the case it exists to keep from being written to one log several
 * times.
 *
 * AND IT IS A PHASE WITH A DEADLINE, like the challenge and the POST. It is
 * three filesystem calls deep — canonicalise the cwd, list the directory, read
 * and canonicalise each record — and every one of them is a path this process
 * was handed rather than one it chose. One that does not answer used to take
 * the event away from every OTHER deck on the machine as well, because the
 * whole scan had to finish before anything was challenged. Now the deadline
 * hands back whatever answered in time and the rest of the run proceeds: a
 * healthy deck registered beside a stalled record still gets its event.
 *
 * The cwd gets a deadline INSIDE that one, and it does not abort the phase, it
 * downgrades: a session's cwd is the one path here this process did not choose,
 * and if the mount it is on will not canonicalise it, `path.resolve` of it is
 * still an answer. It is the same answer normPath gives for a path that does
 * not resolve at all, it is what a machine-wide deck needs (which is the
 * default), and it is right for a scoped deck too wherever nothing in the path
 * is a symlink, a junction or an 8.3 short name. Giving up on the whole phase
 * instead would hand every deck on the machine nothing.
 *
 * `cb` runs exactly once, with a snapshot — a read that lands after the
 * deadline may still push, and must not change the set already being acted on.
 */
function discoverTargets(cwd, cb) {
  const found = [];
  // The spelling capture was actually decided on, handed back so the payload
  // can carry the same one — see main(). It starts as the merely-resolved form
  // because that is what scan() falls back to, so there is no window in which
  // this names a spelling nothing was compared against.
  let usedCwd = path.resolve(cwd);
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cb(found.slice(), usedCwd);
  };
  const timer = setTimeout(finish, DISCOVERY_TIMEOUT_MS);

  let scanned = false;
  // Assigned below, and read from a callback normPathAsync may run
  // synchronously — so it is declared first rather than closed over as a
  // `const` that would still be in its dead zone.
  let cwdTimer = null;
  const scan = resolvedCwd => {
    if (scanned || settled) return;
    scanned = true;
    usedCwd = resolvedCwd;
    clearTimeout(cwdTimer);
    fs.readdir(DIR, (err, names) => {
      if (settled) return;
      if (err) return finish();
      // `${pid}.json`, which is what writeDiscovery names them — not every
      // `.json` in the directory. DIR is ~/.claude/agent-dag/, and that is not
      // a registry: it is the deck's old home. prefs.json lived there and
      // deck-home.mjs's migration leaves the original where it is, so on every
      // upgraded machine this was reading and parsing the deck's 0600
      // private-key file on every tool call. It was never leaked — no top-level
      // `workspace`, so the guard dropped it — but it is the one file in there
      // guaranteed to have a shape readRecord does not expect.
      const files = names.filter(f => /^\d+\.json$/.test(f));
      if (!files.length) return finish();
      let pending = files.length;
      const one = () => { if (--pending <= 0) finish(); };
      for (const file of files) readRecord(file, resolvedCwd, found, one);
    });
  };
  cwdTimer = setTimeout(() => scan(path.resolve(cwd)), CWD_TIMEOUT_MS);
  normPathAsync(cwd, scan);
}

function main() {
  // Hard cap so a stuck server can never wedge the host CLI: this process ends
  // itself rather than being killed. CAP_MS says what the budget is; this line
  // is about WHEN THE CLOCK STARTED.
  //
  // It starts when Node did, not when main() ran. The old timer was armed here
  // and counted only what came after, so the `sh -c` fork/exec and the
  // interpreter startup that Claude Code is already timing were spent outside
  // the budget and charged to it anyway — which is how a 1900ms cap declared
  // under a `timeout: 2` came out at 2.19s on a loaded box (#1018).
  // process.uptime() is how far into that budget we already are.
  //
  // The floor is deliberate. A startup slow enough to eat the whole budget is a
  // machine under real load, which is exactly when a deck is worth posting to;
  // exiting before opening a loopback socket would drop the event to save
  // nothing. installer.mjs declares the timeout from the other side and has to
  // stay strictly above CAP_MS plus that startup — hook-budget.test.ts pins the
  // two numbers against each other so they cannot drift apart again.
  //
  // AND THIS LINE FIRING IS NOT THE SAME AS THIS PROCESS ENDING. Node's exit
  // joins libuv's threadpool, so `process.exit(0)` does not complete while a
  // filesystem request is still executing in one of those threads — measured,
  // the timer runs on time, calls exit, and the process is still there. Moving
  // the reads off the main thread is what lets the timer run at all and what
  // gets the event delivered; it is NOT on its own a guarantee that this
  // process ends itself. normPathAsync says the whole of it, including why
  // ending by signal instead would be the worse trade. Read that before
  // concluding a timer plus async fs closes this.
  setTimeout(() => process.exit(0), Math.max(200, CAP_MS - Math.round(process.uptime() * 1000)));

  // AND NOTHING THIS PROCESS DOES MAY REACH THE HOST CLI'S TRANSCRIPT.
  //
  // The cap above covers a stuck server. This covers the other way out: a
  // throw. Claude Code surfaces a non-zero exit as `<hook> hook error` plus the
  // first stderr line, so one uncaught TypeError puts a Node stack trace in
  // front of the user on every tool call — which is what a malformed discovery
  // record used to do, forever, because nothing removes such a record.
  //
  // Deliberately last-resort and deliberately silent. Every path in this file
  // is written to end at exit 0 on its own; this is here because
  // hook-read-only.test.ts proves that property by grepping for `process.exit`
  // literals, and a grep cannot see a throw. It covers the async callbacks too,
  // which a try/catch around the stdin handler would not.
  process.on("uncaughtException", () => process.exit(0));
  process.on("unhandledRejection", () => process.exit(0));

  // The deck reads the Claude quota by running `claude --print /usage`, which is
  // a full Claude Code invocation and therefore fires these hooks. Reporting it
  // drew a session onto the canvas for every quota poll — no prompt, no tools,
  // a few seconds long — so the deck filled up with its own measurements. The
  // probe sets this in the environment and hooks inherit it.
  if (process.env.AGENTS_DECK_INTERNAL === "1") process.exit(0);

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", c => { input += c; });
  process.stdin.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(input); } catch { return process.exit(0); }
    const cwd = parsed && parsed.cwd;
    if (!cwd) return process.exit(0);

    // Stamp provider so the server / reducer can branch on it without
    // re-sniffing payload shape.
    if (parsed && typeof parsed === "object" && !parsed.provider) {
      parsed.provider = PROVIDER;
    }

    // Discover, prove, elect, post — four phases, each with a deadline of its
    // own, and none of them able to stop the timer above from ending this
    // process. See discoverTargets for why the first one is a phase at all.
    discoverTargets(cwd, (targets, resolvedCwd) => {
      if (!targets.length) return process.exit(0);

      // POST THE CWD WE DECIDED ON, not the one we were handed.
      //
      // This used to serialise `parsed` before normPath ran, so the payload —
      // and therefore events.jsonl — carried the RAW cwd while capture was
      // decided on the canonical one. The two spellings only coincide where
      // nothing in the path is a symlink, a junction, a subst drive or an 8.3
      // short name, which is why it held on the machine it was written on.
      //
      // Everywhere else it made a `--workspace` deck capture all day and replay
      // nothing: `bin/deck.js:548` canonicalises the flag once, and replayScope
      // compares the logged cwd against it with a pure string predicate. On
      // macOS, `--workspace /tmp/proj` captures (the hook resolves both sides to
      // /private/tmp/proj) and then comes back empty after a restart. Silently —
      // replayLog does not count or warn about an out-of-scope line.
      //
      // The Codex watcher already stores the canonical form (index.mjs:2203,
      // `cwd: await canonicalCwd(...)`, the same resolve+realpath this is), which
      // is why the two providers disagreed on one board. One spelling in the log
      // is the whole fix.
      //
      // THE SPELLING COMES BACK FROM discoverTargets now rather than being
      // computed here, because canonicalising a cwd is a filesystem call and
      // those belong inside that phase's deadline (#1018). What it hands back is
      // whatever capture was actually decided on: the canonical spelling when
      // the mount answered for it, and `path.resolve(cwd)` when it did not.
      // That is this rule, not an exception to it — the log has to carry the
      // spelling the match was made against, whichever one that turned out to
      // be. A deck that captured on the resolved spelling and replayed on the
      // canonical one is the same empty board this comment was written about.
      //
      // It also sits after the early return above, so a machine with no deck
      // listening no longer serialises a payload nobody is going to read: a
      // Read or a Grep result arrives whole in `tool_response` and is routinely
      // megabytes.
      if (parsed && typeof parsed === "object") parsed.cwd = resolvedCwd;
      const taggedInput = JSON.stringify(parsed);

      // See proveTargets for what the other order cost. A record whose pid is
      // merely alive has established nothing: it may be a deck that died and had
      // its pid recycled, and electing one of those to write the log meant
      // nobody wrote it (#695).
      proveTargets(targets, proven => {
        if (!proven.length) return process.exit(0);

        // One deck per events log records this event; the others only draw it.
        const writers = electWriters(proven);

        let pending = proven.length;
        const done = () => { if (--pending <= 0) process.exit(0); };

        // THE ELECTION HAS A SECOND PLACE NOW (#1019).
        //
        // Answering the handshake established that the port belongs to the deck
        // its record describes. It did not establish that the deck will take the
        // event: it can be restarted by its supervisor between the challenge and
        // the POST, it can fail the ingest and say 500, and an oversized body is
        // refused outright (#1014). Electing a writer that then refuses used to
        // mean nobody wrote the line, because every other deck sharing that log
        // had already been told `?persist=0` — the same silent stop #695 was
        // closed on, reached through the answer rather than through the record.
        //
        // So each log keeps the queue the election would have picked from, in
        // electWriters' own order, and a writer that did not take the event —
        // it answered something other than 2xx, or ended the exchange without
        // answering — hands the log to the next deck in it. A writer that only
        // let its deadline pass with the whole body in hand is not that, and
        // keeps the log (#1133): see post(). Only the writers fail over: a deck
        // that was only drawing the event has nothing to hand on.
        //
        // The deck it is handed to has ALREADY been posted this event with
        // `?persist=0`, so it is asked twice. Both halves of that are settled
        // where they land: the reducer treats a re-delivered `tool_use_id` as the
        // call it already has (it names "a hook retry" as one of the three ways
        // that happens), and the server's `noteLogWriter` reads `persist=1` as
        // this deck owning the session again, which is what lets it append the
        // line the first deck refused.
        //
        // The fan-out stays parallel. Posting to the writer first and fanning out
        // only after its 2xx is the ordering that needs no queue, and it costs
        // every OTHER deck the writer's whole deadline before it is drawn on —
        // 1000ms of the 1900ms CAP_MS gives this process, on every event, to
        // insure against a case that is rare. The hand-on is paid for only when a
        // writer actually fails.
        //
        // THE HAND-ON IS STILL THE POST PHASE, and it is bounded the way the
        // other three are. Each deck it reaches is one more post() carrying its
        // own POST_TIMEOUT_MS, and nothing in it can hold this process past the
        // timer main() armed before discovery began: `pending` decides how EARLY
        // the process may exit, never how late. The worst case that reaches a
        // hand-on at all — a writer that stops reading before the body is all
        // out, or refuses a moment before its deadline — is one POST deadline
        // followed by a loopback round trip to the next deck, which fits inside
        // CAP_MS when discovery and the challenge answer normally. A writer that
        // takes the body and never answers no longer reaches one: its deadline
        // ends its slot instead. When they did not, and the timer ends the process with a
        // hand-on still in flight, the line is lost exactly as it was lost before
        // this change and the hook still exits 0. The cap is the backstop over
        // the hand-on too, not something the hand-on gets to argue with.
        const inLine = new Map();
        for (const d of proven) {
          const key = logGroup(d);
          if (!inLine.has(key)) inLine.set(key, []);
          inLine.get(key).push(d);
        }
        for (const queue of inLine.values()) queue.sort(beforeInLine);

        // `queue[0]` is the deck electWriters picked, so dropping the head is
        // exactly "the next one down". An empty queue is a log with one deck on
        // it: there is nobody to hand it to, and nothing here can invent one.
        //
        // "deadline" ends the hand-on the way a 2xx does. That writer has the
        // whole event and may still be about to append it, and asking the next
        // deck to append it as well is how one event became two lines (#1133).
        const writeTo = d => post(d, taggedInput, true, (took, why) => {
          if (took || why === "deadline") return done();
          const queue = inLine.get(logGroup(d));
          queue.shift();
          if (!queue.length) return done();
          // No done() on this path: the group's slot in `pending` stays open
          // for as long as the hand-on is still going, so the process does not
          // exit out from under the deck that is about to be asked.
          writeTo(queue[0]);
        });

        for (const d of proven) {
          if (writers.has(d)) writeTo(d);
          else post(d, taggedInput, false, done);
        }
      });
    });
  });
}

// The host CLI always runs this file as the process entry point — the command
// the installer writes is `"<node>" "<...>/hook.js" --provider <name>`. Under a
// require() it exports the rules it decides by — matching, election, the
// handshake — and starts nothing, which is what lets them be tested without a
// 1.5s exit timer in the test runner.
module.exports = { capturesSession, cwdInWorkspace, foldsCase, normPath, electWriters, challengeProof, requiresProof };
if (require.main === module) main();
