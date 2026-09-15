// Who the `claude` CLI says is signed in, and which `claude` binary answers.
//
// WHY THIS IS ITS OWN MODULE. It was in cswap-admin.mjs, and claude-accounts.mjs
// imported `currentIdentity` from there — the single edge that closed the only
// static import cycle in src/server, because cswap-admin.mjs imports
// claude-accounts.mjs back for `backupRoot`, `invalidateClaudeAccountsCache`
// and `verdictNow`.
//
// A cycle is not merely untidy here. Two dynamic imports that enter one
// concurrently are each handed the other module's HALF-BUILT namespace rather
// than waiting for it, and a half-built namespace has no exports on it at all.
// `startServer` wires cswap-admin's `autoRecapture` into claude-accounts'
// `repairStaleCopyWith` at boot, and on CI both namespaces arrived with zero
// keys: the call was a TypeError in a promise nothing awaited, so the repair
// was silently never wired while every test still passed. See
// boot-module-graph.test.ts, which now asserts that src/server has no cycles at
// all rather than trying to police the call sites of one.
//
// This file imports only leaves — exec.mjs and claude-dir.mjs have no relative
// imports of their own — so it can be reached from either side without closing
// anything. Both functions are re-exported from cswap-admin.mjs, which is where
// their callers and their tests already look for them.
import { pathLookup, run } from "./exec.mjs";
import { claudeCliCandidates } from "./claude-dir.mjs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Which `claude` the account surface runs: the configured one, else the first
 * candidate this machine actually has, else the bare name.
 *
 * WHY THIS IS NOT `AGENTS_DECK_CLAUDE ?? "claude"` ANY MORE (#570). That was
 * the whole of this module's resolution, and it feeds every child the accounts
 * panel starts — `claude auth status --json` for `currentIdentity`, and the
 * `claude auth login` whose output the sign-in dialog reads a link out of. On a
 * machine whose `claude` is at `~/.local/bin/claude` but whose deck was started
 * from something that never sourced a shell rc — a LaunchAgent, a systemd user
 * unit, pm2, a desktop shortcut — the bare name is an ENOENT, so the login
 * child is dead within milliseconds, the flow reports `no_url`, and the dialog
 * shows "the claude CLI could not be run: not on PATH. Set AGENTS_DECK_CLAUDE
 * to its full path." That sentence is a real remedy and it is why this was a
 * smaller bug than #553; it is still a request to spell out a path the deck had
 * already found for itself, because `hasClaudeInstalled()` stat'ed that exact
 * file at boot to decide this was a Claude machine, and since #553 the quota
 * panel beside this one runs the same binary without being told anything.
 *
 * SO IT READS THE SAME LIST, ON THE SAME TERMS #553 SETTLED ON. The list is
 * `claudeCliCandidates` in claude-dir.mjs, whose other two readers are
 * `hasClaudeInstalled()` — the boot question this module's whole surface hangs
 * off — and `quotaClaudeBin` in quota.mjs. This is the same question at a third
 * site, so nothing here is decided again:
 *
 *   - AGENTS_DECK_CLAUDE first, and it is the one thing that skips the list
 *     entirely. It is documented in the README as "full path to the `claude`
 *     CLI", it is what the failure message above tells people to set, and
 *     someone who set it has already been through this once — second-guessing
 *     them with a stat would be answering a question they have closed. An empty
 *     value reads as unset, the way `AGENTS_DECK_CSWAP` does in cswapBin.
 *   - Then the candidate list's own order, unchanged: PATH first on POSIX, the
 *     two known install directories first on Windows. Preferring a different
 *     copy would silently change which binary signs somebody in on every
 *     machine that has two, and a `claude auth login` that suddenly runs a
 *     different binary is a credential path, not a detail.
 *   - The bare name is only answered with when PATH actually holds it, and
 *     `pathLookup` is a yes/no gate rather than the path it found, so spawn's
 *     own resolution — and, on Windows, exec.mjs's PATHEXT walk, since `claude`
 *     there is `claude.exe` or `claude.cmd` and never the bare word — stays in
 *     charge of the PATH case exactly as before.
 *   - The absolute candidates are stat'ed only once PATH has come up empty, so
 *     the common case costs one stat rather than a directory walk. Against what
 *     follows it — a whole Claude Code process, and a browser sign-in a human
 *     is walking through — that is not a cost worth naming.
 *
 * Pure, with the platform, environment, home directory and existence check all
 * parameters, so the Windows branch is checkable from the platforms this repo
 * is actually developed on. Exported for that test rather than for a caller
 * (#383): the real callers are `currentIdentity` below and cswap-admin.mjs's
 * own `claudeBin`, and both take it with no arguments, which is the real
 * machine's answer.
 */
export function adminClaudeBin(platform = process.platform, env = process.env,
                               home = homedir(), exists = existsSync) {
  if (env.AGENTS_DECK_CLAUDE) return env.AGENTS_DECK_CLAUDE;
  const sep = platform === "win32" ? "\\" : "/";
  // process.env is case-insensitive on Windows; an injected plain object in a
  // test is not, and %Path% is how the variable is actually spelled there.
  const pathEnv = env.PATH ?? env.Path ?? env.path ?? "";
  for (const c of claudeCliCandidates(platform, env, home)) {
    if (c.includes(sep)) { if (exists(c)) return c; }
    else if (pathLookup(c, platform, { pathEnv, exists })) return c;
  }
  // Nothing on PATH and nothing at any known install directory. The bare name
  // is still the right last resort — POSIX `execvp` and cmd.exe's own search
  // both deserve their turn at a layout no list here knows — and the ENOENT it
  // produces is what failureText turns into the AGENTS_DECK_CLAUDE sentence.
  return "claude";
}

/**
 * Anthropic's own view of who is signed in. Null when it cannot be read.
 *
 * Exported for its test rather than for a caller (#383). Both callers are inside
 * the login flow and neither can show what was parsed: `spawnLogin` keeps only
 * `identity?.email` as the address to restore to, and `submitLoginCode` turns
 * the whole thing into a pass/fail — a null there is the difference between a
 * sign-in the deck accepts and one it reports as "signed in, but the claude CLI
 * still reports nobody logged in". The success path, where the email read here
 * is what matches the new credential to a cswap slot, is reachable only with a
 * real signed-in CLI on the machine running the suite. See
 * cswap-identity.test.ts.
 */
export async function currentIdentity() {
  const r = await run(adminClaudeBin(), ["auth", "status", "--json"], { timeout: 20_000 });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.stdout);
    return j?.loggedIn ? { email: j.email ?? "", orgId: j.orgId ?? "" } : null;
  } catch {
    return null;
  }
}
