// Whether the deck may add the UserPromptExpansion hook that Skill activity
// counts typed slash commands with (#2181). It is the only signal for them: a
// typed skill never calls the Skill tool, and UserPromptSubmit also carries a
// prompt that only starts like a command (`/etc is full`, an unknown command
// Claude Code hands to the model), so without this entry the Skills tab counts
// none of the commands a person types. On by default, behind the version gate.
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
//   - the deck was not started with AGENTS_DECK_SKILL_HOOK turned off (any
//     value but 1; unset or empty is on);
//   - at least one Claude Code was found, the way the deck finds `claude`: the
//     candidate list (claude-dir.mjs) and AGENTS_DECK_CLAUDE;
//   - EVERY one found says which version it is, and every one is 2.1.116 or
//     newer. An old CLI anywhere on the machine still reads the same file, and
//     one that will not say its version is treated as an old one.
// A version is read off disk first (claude-dir.mjs, no child process). Only
// for an install whose layout does not name one — a wrapper script, an unusual
// prefix — and only while the entry is not turned off, is that binary asked
// `--version`, by its full path and as argv, and believed only when it answers
// the way Claude Code does: `<x.y.z> (Claude Code)`.
//
// Every boot re-decides. A machine that stops passing — the entry turned off, a
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

/** Set to "0" to leave the entry out. Unset, empty or "1" is on. */
export const SKILL_HOOK_ENV = "AGENTS_DECK_SKILL_HOOK";

/** Whether the person starting the deck left the entry on. Any value but "1"
 *  turns it off, so a "false", an "off" or a typo is honoured as a no rather
 *  than read as a yes; only unset or empty is no instruction at all. */
export function skillHookEnabled(env = process.env) {
  const value = env?.[SKILL_HOOK_ENV];
  return value === undefined || value === "" || value === "1";
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
 *   { install: false, state: "off",     reason: "turned-off" }
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
  env = process.env,
  enabled = skillHookEnabled(env),
  installs,
  runImpl = run,
  timeout = PROBE_TIMEOUT_MS,
} = {}) {
  const since = SKILL_HOOK_SINCE;
  // Off is decided before anything is looked at: a deck told to leave the
  // entry out spends nothing on the question, and spawns nothing.
  if (!enabled) return { install: false, state: "off", reason: "turned-off", since, versions: [] };
  let found;
  try {
    found = Array.isArray(installs) ? [...installs] : claudeCodeInstalls();
  } catch {
    found = [];
  }
  // AGENTS_DECK_CLAUDE is the other way the deck finds `claude` — the sign-in
  // and the account panel run it ahead of the candidate list
  // (claude-identity.mjs) — so it is one more Claude Code that reads this
  // settings.json. Its layout is not read: it is asked.
  const configured = typeof env?.AGENTS_DECK_CLAUDE === "string" ? env.AGENTS_DECK_CLAUDE.trim() : "";
  if (configured && !found.some(i => i.bin === configured)) found.push({ bin: configured, version: undefined });
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
 * The boot report's row for the entry — `{ ok: false, detail }` — or null when
 * there is nothing to say: installed, which is the default and needs no line,
 * or turned off by the person starting the deck, who knows. Only an entry the
 * gate or the file kept out is said, since then the Skills tab counts no typed
 * command. `dash` is the screen's own (bin/cli/screen.js), so the line carries
 * no punctuation a legacy console cannot draw.
 */
export function skillHookStatus(decision, dash = "-") {
  if (!decision || decision.state === "off" || decision.state === "on") return null;
  const found = (decision.versions ?? []).map(v => v ?? "unknown").join(", ");
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
