// Whether this deck got set up, and how long its first session took to arrive —
// the "does a new install actually work" half of the usage reports
// (reports.mjs).
//
// WHAT IT ANSWERS. An "install" event says somebody ran ccdeck once. It does not
// say whether the Claude hooks went in, whether Codex is being watched, or
// whether a session ever reached the deck — and an install that never sees a
// session is somebody who tried ccdeck and left. So two facts ride on the
// reports that carry facts:
//
//   - `claudeHooks`: "ok" when this boot installed the hooks, "failed" when it
//     tried and could not (a settings.json it refuses to rewrite), "off" when it
//     did not try (no Claude Code found, or --no-claude);
//   - `codexWatch`: "on" when the Codex rollout watcher runs, else "off".
//
// and one "activated" event goes out per install, when its first session
// arrives, saying how long after the install that was — in coarse buckets,
// never a time.
//
// The boot (bin/deck.js) is what knows the setup, and it reaches this module
// through noteSetup. A respawn installs the hooks only when the package changed,
// so the supervisor carries the first boot's answer down to it (respawnHooksJob).
// This file imports nothing, so the boot can load it early.

/** Not known yet, until the boot says. */
let setup = null;
let settle;
const known = new Promise(r => { settle = r; });

/** What the boot can say about the Claude hooks. */
const HOOK_STATES = ["ok", "failed", "off"];

/** A hook job's answer as its token: null is "off" (not attempted), `{ ok }` is
 *  "ok" or "failed", and a token — the one a respawn was handed down — is kept
 *  when it is one. Anything else cannot be told, and is left out. */
function hooksState(job) {
  if (job == null) return "off";
  if (typeof job === "string") return HOOK_STATES.includes(job) ? job : undefined;
  return job.ok ? "ok" : "failed";
}

/**
 * What the boot set up. `claude` is the hook install job — a promise of null
 * (not attempted), `{ ok: true }` or `{ ok: false }`, or on a respawn the
 * first boot's token (respawnHooksJob) — or null when Claude is not wanted;
 * `codex` is whether the rollout watcher runs. Never throws, and a job that
 * rejects reads as "failed". Resolves to the setup once it is known, for the
 * boot to hand the hooks' answer to its supervisor.
 */
export function noteSetup({ claude = null, codex = false } = {}) {
  return Promise.resolve(claude)
    .then(hooksState, () => "failed")
    .then(claudeHooks => {
      setup = { codexWatch: codex ? "on" : "off" };
      if (claudeHooks) setup.claudeHooks = claudeHooks;
      settle();
      return { ...setup };
    });
}

/**
 * A respawn's hook job, for noteSetup: what this process saw, never a success
 * it did not. A respawn re-installs the hooks only when the package under the
 * session has changed (respawnHooks, bin/cli/startup.js), and then it is that
 * install's own answer. Otherwise it installed nothing, and the answer is the
 * session's first boot's — `carried`, which the supervisor hands down in
 * AGENTS_DECK_BOOT_HOOKS — or, under a supervisor that handed nothing down,
 * none at all.
 */
export function respawnHooksJob({ wantClaude, reinstall, carried }) {
  if (!wantClaude) return null;
  return Promise.resolve(reinstall).then(job => job ?? String(carried ?? ""));
}

/** The setup facts, or none while the boot has not said. */
export function setupFacts() {
  return setup ? { ...setup } : {};
}

/** Resolves once the boot has said, or after `ms`, whichever is first — so a
 *  report never waits on a boot that will not say (a test, a respawn). */
export function whenSetupKnown(ms = 10_000) {
  let timer;
  return Promise.race([
    known,
    new Promise(r => { timer = setTimeout(r, ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long after the install the first session came, as a bucket: "5m" (under
 *  five minutes), "1h", "1d", "7d", or "later". A clock that went backwards
 *  reads as the shortest. */
export function sinceInstallBucket(installedAt, firstAt) {
  const ms = Date.parse(firstAt) - Date.parse(installedAt);
  if (!Number.isFinite(ms)) return undefined;
  if (ms < 5 * MINUTE) return "5m";
  if (ms < HOUR) return "1h";
  if (ms < DAY) return "1d";
  if (ms < 7 * DAY) return "7d";
  return "later";
}
