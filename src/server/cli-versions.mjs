// The versions of the Claude Code and Codex CLIs this machine has, for the
// "which CLIs, at which version" count the reporter sends (reports.mjs).
//
// SPAWNED, BUT NEVER ON THE BOOT PATH. claude-dir.mjs measured a Claude Code
// child at ~3.0s and says out loud that boot is the wrong place to spend one, so
// this runs in the background — reports.mjs starts it once the deck is listening
// and the prefs say reports are on, and asks again on each new UTC day so a deck
// left running reports the CLI it has now. The first report waits a few seconds
// for the answer, beside the wait for the boot's setup, rather than going out
// without it. A version that is not known by then is simply not sent; the field
// is optional and the API records nothing for an absent one.
//
// WHAT LEAVES IS A VERSION AND NOTHING ELSE. parseVersion keeps only a
// dotted-number token (with the `^[0-9A-Za-z.+_-]+$` shape the API enforces, and
// its 32-char cap), so a `claude --version` line that also printed a path, a
// build host or an install directory contributes only the number. Presence is
// asked first, through the deck's existing checks, so a machine without the CLI
// never spawns anything looking for it.
//
// NOTHING HERE THROWS. run() already answers a missing tool with { ok: false }
// rather than an exception, and every call is wrapped besides — a floating
// rejection out of a background probe would be an unhandled one.

import { claudeCliCandidates, hasClaudeInstalled } from "./claude-dir.mjs";
import { run } from "./exec.mjs";
import { hasCodexInstalled } from "./installer.mjs";

/** A `--version` probe is fast when the tool is present (it prints and exits)
 *  and fast when it is absent (ENOENT), so a short deadline is only a guard
 *  against a wedged shim, not the common path. */
const PROBE_TIMEOUT_MS = 5_000;

/** The first dotted-number run in the output — "1.2.3", "1.2.3-beta.1",
 *  "1.2.3+build" — reduced to the API's token shape and length. Everything else
 *  on the line (a leading "claude-code ", a trailing " (Claude Code)", a path)
 *  is dropped. */
export function parseVersion(text) {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[.+-][0-9A-Za-z.+-]*)?)/.exec(String(text ?? ""));
  if (!m) return undefined;
  const token = m[1].replace(/[^0-9A-Za-z.+_-]/g, "");
  return token && token.length <= 32 ? token : undefined;
}

async function probe(runImpl, cand) {
  try {
    const r = await runImpl(cand, ["--version"], { timeout: PROBE_TIMEOUT_MS });
    if (r?.ok) return parseVersion(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch { /* run() does not throw, but a stubbed one might */ }
  return undefined;
}

const ask = (fn) => { try { return Boolean(fn()); } catch { return false; } };

/**
 * `{ claudeVersion?, codexVersion? }` — each present only when its CLI is on the
 * machine and answered with a version. Every dependency is injected so the whole
 * of this is exercised in a test with no real child process: `runImpl` for the
 * spawn, and the two presence gates and the candidate list for what it is asked
 * to spawn.
 */
export async function detectCliVersions({
  runImpl = run,
  claudeCandidates = claudeCliCandidates,
  claudePresent = hasClaudeInstalled,
  codexPresent = hasCodexInstalled,
} = {}) {
  const out = {};
  try {
    if (ask(claudePresent)) {
      // The candidate list is claude-dir.mjs's answer to "where does `claude`
      // live", so a version is found on the same installs the deck already
      // recognises — not only the one on the launcher's PATH. First hit wins; a
      // machine with the CLI answers on its first or second candidate.
      for (const cand of new Set(claudeCandidates())) {
        const v = await probe(runImpl, cand);
        if (v) { out.claudeVersion = v; break; }
      }
    }
  } catch { /* leave claudeVersion unset */ }
  try {
    // No candidate list exists for Codex — the deck reads its sessions off disk
    // and never spawns the CLI — so the bare name goes through run()'s own PATH
    // and shim resolution, which is the same resolution every other spawn uses.
    if (ask(codexPresent)) {
      const v = await probe(runImpl, "codex");
      if (v) out.codexVersion = v;
    }
  } catch { /* leave codexVersion unset */ }
  return out;
}
