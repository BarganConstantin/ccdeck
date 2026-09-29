// The note a failed npx relaunch leaves for the worker that comes up instead.
//
// This lived in src/server/self-update.mjs, between the install policy and the
// install itself. It is the one channel between two processes — the supervisor
// in bin/agent-dag.js writes and clears it, the worker's version report reads
// it — and it touches neither npm nor the registry, so it moved to a module of
// its own. It shares npm-latest.mjs's directory and its rule for turning a
// package name into a file name, so the two kinds of file keep agreeing.
// self-update.mjs re-exports every name, so the supervisor still imports them
// from there. The code is unchanged.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// The package's one liveness probe, the Windows errno included. self-update.mjs
// kept a copy of it, comment and all, from before deck-probe.mjs existed.
import { isProcessAlive } from "./deck-probe.mjs";
import { PUBLISHED_NAME } from "./install-layout.mjs";
import { MARKER_DIR, safeNamePart } from "./npm-latest.mjs";

// ── the note a failed npx relaunch leaves behind ─────────────────────────────
//
// The npx upgrade is the one path whose failure the server cannot see. It runs
// in the SUPERVISOR, after this process has already exited: the worker asks to
// come back through `npx -y <spec>@latest`, npx fails, and the supervisor
// relaunches the copy on disk. The new worker boots knowing nothing, so
// /api/version kept answering `upgrade: {state:"idle"}` — the banner still
// offered "Update & restart", the tab said nothing at all, and a user who
// clicked the button without watching the terminal saw the deck blink and come
// back unchanged. Every click then repeated the whole cycle identically.
//
// A file is the only channel between the two processes: the supervisor writes
// one when the relaunch fails, and the worker it starts instead reads it here.
// Same directory as the update markers, and named after the package for the
// same reason they are.
//
// The package name alone was not enough, and one release was enough to show it.
// Two `npx ccdeck` decks resolve into the same content-addressed _npx directory,
// so they run the same package at the same version out of the same home: when
// one user's upgrade failed, the other deck — which had never asked for
// anything — read that note as its own, reported `upgrade: {state:"failed"}`
// and labelled its first ever click "Retry update". The version-staleness rule
// below cannot catch it, because both decks are the same version.
//
// So the name carries WHOSE failure it is as well as which package's: the pid
// of the supervisor that wrote it. That is unique among the decks alive on the
// machine, and it crosses the process boundary on its own — the worker that
// reads the note is a child the supervisor spawns after the failure, and
// inherits the pid through AGENTS_DECK_SUPERVISOR_PID. A worker with no
// supervisor to answer for reads nothing rather than falling back to a shared
// file, which is the bug this whole naming exists to avoid.
const NOTE_PREFIX = ".restart-failed-";

/** Which supervisor a note belongs to, as the file name may spell it. Digits
 *  and nothing else: legal on every filesystem, and readable back as the pid
 *  the sweep below asks about. Anything else is refused rather than scrubbed
 *  into digits, since two keys must never collapse into one file name. */
function safeOwner(key) {
  const raw = String(key ?? "").trim();
  return /^\d{1,12}$/.test(raw) && Number(raw) > 0 ? raw : null;
}

/** This process's own key, set by the supervisor on itself and inherited by
 *  every worker it launches. */
export function restartFailureKey(env = process.env) {
  return safeOwner(env?.AGENTS_DECK_SUPERVISOR_PID);
}

/** Called once by the supervisor, on its own environment, which every worker it
 *  spawns then inherits. Assigned rather than defaulted: a deck launched by
 *  another deck's npx relaunch inherits that supervisor's key and must answer
 *  for itself, not for the parent whose upgrade it is the result of. */
export function claimRestartFailureKey(env = process.env, pid = process.pid) {
  env.AGENTS_DECK_SUPERVISOR_PID = String(pid);
  return safeOwner(pid);
}

/** `ccdeck` under supervisor 4821 → `.restart-failed-ccdeck-4821`, or null when
 *  there is no supervisor, which is not a deck any note can be about. */
export function restartFailureFileName(name = PUBLISHED_NAME, key = restartFailureKey()) {
  const owner = safeOwner(key);
  return owner ? `${NOTE_PREFIX}${safeNamePart(name)}-${owner}` : null;
}

function restartFailurePath(name, key) {
  const file = restartFailureFileName(name, key);
  return file ? join(MARKER_DIR, file) : null;
}

/** Called by the supervisor when an upgrade does not happen — because the fetch
 *  failed, because the fetched copy never served, or because this target has
 *  already failed here and is not being tried again. Best-effort: a read-only
 *  home costs the report, not the deck. */
export function recordRestartFailure({
  name = PUBLISHED_NAME, command = null, error = null, version = null,
  target = null, attempts = 1, at = Date.now(), failedAt = at, key = restartFailureKey(),
} = {}) {
  const file = restartFailureFileName(name, key);
  if (!file) return;
  const path = join(MARKER_DIR, file);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      command,
      error: error ? String(error).slice(0, 300) : null,
      // The version that failed to leave — see restartFailureNotice.
      version,
      // The version that failed to ARRIVE, and how many attempts it has cost.
      // Together they are the whole of what stops an unattended deck retrying
      // the identical fetch forever; see upgradeAttempt in supervisor.mjs.
      target,
      attempts,
      // When the fetch itself failed, which a refusal re-stating that failure
      // carries forward unchanged. `at` moves on every write because the
      // browser ends its attempt on a note it has not seen before — the
      // cooldown must not be pushed out by the act of asking about it.
      failedAt,
      at,
    }));
    sweepOrphanedNotes(file);
  } catch { /* ignore */ }
}

/** Called before each attempt, so a retry is answered by its own outcome rather
 *  than by the last one's. */
export function clearRestartFailure(name = PUBLISHED_NAME, key = restartFailureKey()) {
  const path = restartFailurePath(name, key);
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}

export function readRestartFailure(name = PUBLISHED_NAME, key = restartFailureKey()) {
  const path = restartFailurePath(name, key);
  if (!path) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

// A note is named after a process, so it outlives its deck whenever that
// supervisor is killed before anyone reads the tab, and nothing would ever
// delete it: the retry that clears one is exactly the thing that never happened.
// Swept from the only path that creates notes, and only where the owner is
// provably gone — another deck's note is another deck's to clear. Names without
// a pid are the single shared file of v1.33.82, which nothing reads any more.
function sweepOrphanedNotes(keep) {
  let files;
  try { files = readdirSync(MARKER_DIR); } catch { return; }
  for (const f of files) {
    if (f === keep || !f.startsWith(NOTE_PREFIX)) continue;
    const owner = Number(f.slice(f.lastIndexOf("-") + 1));
    if (Number.isInteger(owner) && owner > 0 && isProcessAlive(owner)) continue;
    try { rmSync(join(MARKER_DIR, f), { force: true }); } catch { /* ignore */ }
  }
}

/**
 * The note as the version report should carry it, or null when it no longer
 * describes this deck. Pure, because the staleness rule is the whole subtlety.
 * WHOSE failure it is was settled by the file name; this decides only whether
 * it is still current.
 *
 * The note names the version that was running when the upgrade failed. While
 * that is still the version on disk, the failure is current: the deck really is
 * stuck where it was. Once the files are a different version the upgrade
 * happened some other way — a `npm i -g`, a fixed npm prefix, a manual npx —
 * and a note about a deck that no longer exists must not keep claiming the
 * update is broken.
 */
export function restartFailureNotice(record, installed = null) {
  if (!record || typeof record.error !== "string" || !record.error) return null;
  if (record.version && installed && record.version !== installed) return null;
  return {
    state: "failed",
    command: typeof record.command === "string" ? record.command : null,
    error: record.error,
    at: typeof record.at === "number" ? record.at : 0,
  };
}
