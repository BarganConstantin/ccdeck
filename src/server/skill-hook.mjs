// Whether the deck may add the UserPromptExpansion hook that Skill activity
// counts typed slash commands with (#2181) — and, until somebody asks for it,
// the answer is no.
//
// WHY THIS ENTRY IS GATED HARDER THAN STOPFAILURE. A hook event name Claude
// Code does not know is not skipped by every version. Up to 2.1.100 it made
// Claude Code ignore the WHOLE settings.json — the user's permissions, env,
// model and every hook in it, ours included — without a word on screen. 2.1.101
// changed that ("an unrecognized hook event name in settings.json no longer
// causes the entire file to be ignored", Claude Code's CHANGELOG.md, 2.1.101).
// UserPromptExpansion itself arrived later still: the first npm release whose
// CLI carries the name, and whose Agent SDK lists it in HOOK_EVENTS, is 2.1.116
// (2.1.114 has neither, and there is no 2.1.115). Checked offline against the
// published packages, with a scratch config holding the deck's own entry shape:
//
//   2.1.100  the whole file ignored — no hook fired, no env applied
//   2.1.101  the file read, the entry ignored
//   2.1.114  the file read, the entry ignored
//   2.1.116  the file read, the entry fired on a typed custom command
//
// So the gate is the later of the two: 2.1.116, which is where the entry is
// both harmless and useful. Below it the entry buys nothing, and below 2.1.101
// it costs the user every setting they have.
//
// WHAT HAS TO BE TRUE before the entry is written:
//   - the deck was started with AGENTS_DECK_SKILL_HOOK=1 — never by default;
//   - at least one Claude Code was found, the way the deck finds `claude`;
//   - EVERY one found says which version it is, and every one is 2.1.116 or
//     newer. An old CLI anywhere on the machine still reads the same file, and
//     one that will not say its version is treated as an old one.
// A version is read off disk first (claude-dir.mjs, no child process). Only
// for an install whose layout does not name one — a wrapper script, an unusual
// prefix — and only once the user has opted in, is that binary asked
// `--version`, by its full path and as argv, and believed only when it answers
// the way Claude Code does: `<x.y.z> (Claude Code)`.
//
// Every boot re-decides. A machine that stops passing — the opt-in removed, a
// Claude Code rolled back, a second, older one installed — has the entry taken
// back out by the next start (installer.mjs), and the user's own
// UserPromptExpansion hooks are left where they are.
import { claudeCodeInstalls, claudeVersionAtLeast } from "./claude-dir.mjs";
import { run } from "./exec.mjs";

export const USER_PROMPT_EXPANSION = "UserPromptExpansion";

/** The first Claude Code that knows the event: 2.1.116 (npm). */
export const USER_PROMPT_EXPANSION_SINCE = "2.1.116";

/** The first Claude Code that skips an unknown hook event instead of ignoring
 *  the whole settings.json: 2.1.101 (CHANGELOG.md). */
export const UNKNOWN_EVENT_TOLERATED_SINCE = "2.1.101";

/** The gate: a version that is past both of the above. */
export const SKILL_HOOK_SINCE = claudeVersionAtLeast(USER_PROMPT_EXPANSION_SINCE, UNKNOWN_EVENT_TOLERATED_SINCE)
  ? USER_PROMPT_EXPANSION_SINCE
  : UNKNOWN_EVENT_TOLERATED_SINCE;

/** Set to "1" to ask for the entry. Anything else, or nothing, is no. */
export const SKILL_HOOK_ENV = "AGENTS_DECK_SKILL_HOOK";

/** Whether the person starting the deck asked for the entry. Only the exact
 *  string "1": a typo or a "true" does not turn it on. */
export function skillHookOptedIn(env = process.env) {
  return env?.[SKILL_HOOK_ENV] === "1";
}

/** A `--version` that is not quick is not Claude Code's fast path. */
const PROBE_TIMEOUT_MS = 5_000;

/** What Claude Code prints for `--version`, e.g. `2.1.116 (Claude Code)`. A
 *  first line in any other shape — a wrapper's own version, an error, an
 *  update notice — is no answer. */
const VERSION_LINE_RE = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?) \(Claude Code\)$/;

/** The version in Claude Code's own `--version` output, or undefined. */
export function parseClaudeVersionOutput(text) {
  const first = String(text ?? "").split(/\r?\n/).map(l => l.trim()).find(l => l !== "");
  const m = first === undefined ? null : VERSION_LINE_RE.exec(first);
  return m ? m[1] : undefined;
}

async function askVersion(runImpl, bin, timeout) {
  try {
    const r = await runImpl(bin, ["--version"], { timeout });
    return r?.ok ? parseClaudeVersionOutput(r.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The decision, and why:
 *
 *   { install: false, state: "off",     reason: "not-enabled" }
 *   { install: false, state: "skipped", reason: "no-claude" | "version-unknown" | "too-old", versions }
 *   { install: true,  state: "on",      versions }
 *
 * `versions` is what was found, in the order found, with `null` for an install
 * that did not say. `since` is the gate. Never throws: a probe that fails is a
 * version that is unknown, which is a refusal.
 *
 * Every dependency is injected so the suite can lay out any machine: `installs`
 * is claudeCodeInstalls()'s answer, `runImpl` is exec.mjs's run.
 */
export async function skillHookDecision({
  optedIn = skillHookOptedIn(),
  installs,
  runImpl = run,
  timeout = PROBE_TIMEOUT_MS,
} = {}) {
  const since = SKILL_HOOK_SINCE;
  // Off is decided before anything is looked at: a deck that was not asked
  // spends nothing on the question, and spawns nothing.
  if (!optedIn) return { install: false, state: "off", reason: "not-enabled", since, versions: [] };
  let found;
  try {
    found = Array.isArray(installs) ? installs : claudeCodeInstalls();
  } catch {
    found = [];
  }
  if (found.length === 0) return { install: false, state: "skipped", reason: "no-claude", since, versions: [] };
  const versions = [];
  for (const { bin, version } of found) {
    const v = version ?? (typeof bin === "string" && bin ? await askVersion(runImpl, bin, timeout) : undefined);
    versions.push(v ?? null);
  }
  if (versions.some(v => v === null)) return { install: false, state: "skipped", reason: "version-unknown", since, versions };
  if (!versions.every(v => claudeVersionAtLeast(v, since))) {
    return { install: false, state: "skipped", reason: "too-old", since, versions };
  }
  return { install: true, state: "on", since, versions };
}

/**
 * The boot report's row for the entry — `{ ok, detail }` — or null when there
 * is nothing to say, which is the default: nobody asked for it, and a deck
 * that was not asked prints exactly what it printed before. `dash` is the
 * screen's own (bin/cli/screen.js), so the line carries no punctuation a
 * legacy console cannot draw.
 */
export function skillHookStatus(decision, dash = "-") {
  if (!decision || decision.state === "off") return null;
  const found = (decision.versions ?? []).map(v => v ?? "unknown").join(", ");
  if (decision.state === "on") return { ok: true, detail: `on ${dash} typed slash commands are counted (Claude Code ${found})` };
  const why = {
    "no-claude": "no Claude Code found",
    "version-unknown": `a Claude Code here does not say its version (found: ${found})`,
    "too-old": `needs Claude Code ${decision.since} or newer everywhere (found: ${found})`,
    "settings-shape": "the hooks in settings.json are not in a shape the deck can add to",
    "backup-failed": "settings.json could not be backed up first",
    raced: "settings.json changed while installing; the next start tries again",
  }[decision.reason] ?? "not allowed";
  return { ok: false, detail: `not installed ${dash} ${why}` };
}
