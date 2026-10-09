// Which of the running decks writes an event to the log they share?
//
// The hook already answers that for the events it delivers: it groups the decks
// it is about to post to by the log file each one names in its discovery record,
// elects one per file, and marks the request to every other one `?persist=0`.
// See electWriters in hook/hook.js.
//
// The Codex rollout watcher never goes through the hook — it builds its events
// inside the server by tailing ~/.codex/sessions/**/rollout-*.jsonl — so nothing
// suppressed the copies on that path: every deck tailing the same rollout
// appended its own line to the one events.jsonl they all default to, so each
// Codex tool call, prompt and session start landed there once per running deck.
// That is the duplication the hook election was added to end, still open on the
// path that is the only Codex capture there is on Windows, where Codex hooks
// never fire at all.
//
// So the server runs the same election, over the same discovery records, with
// the same tie-break. The rule is repeated here rather than imported from
// hook/hook.js because that file is copied out of the package and run standalone
// by the host CLI, with no path back to the module it came from — the same
// reason it re-derives the Claude config dir inline. The two copies are pinned
// equal by a test, as challengeProof's pair already is.
//
// These lived at the top of log-writer.mjs, above the appender they decide
// for. They are pure rules over discovery records and paths and the appender
// never called one, so they moved on their own: event-log.mjs asks the
// election who owns the log, the rollout watcher and the boot replay ask it
// whose rollout a cwd is, and discovery.mjs and the launcher spell the log's
// path through it. The bodies are unchanged.
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, win32, posix } from "node:path";

/**
 * The one spelling of an events log, so two decks pointed at one file land in
 * one group (#793).
 *
 * `resolve` alone was what shipped, and it settles relative-vs-absolute and
 * nothing else. The election below then only case-folds — so two spellings of
 * one file read as two files, which is the exact thing `bin/deck.js`'s comment
 * over this value says must not happen. On Windows it needs no odd user action:
 * `claudeConfigDir()` derives from `homedir()`, and a shell whose `USERPROFILE`
 * is 8.3-shortened yields a different default string than one with the long
 * form. `subst` and mapped drives and junctions do it too, and on macOS so does
 * `/tmp` against `/private/tmp`.
 *
 * What it cost was not merely a duplicate group. BOTH decks were then elected,
 * so every hook event was appended twice — the duplicate-tools-after-restart
 * symptom the election exists to end — and `logSharing()` compares the same
 * string, so both answered `mine: true` and `POST /api/clear` truncated a file
 * this deck does not own. That is the #698 history loss the ownership gate was
 * added to prevent.
 *
 * THE DIRECTORY IS CANONICALISED EVEN WHEN THE FILE IS NOT THERE, which is the
 * half a plain realpath misses. On a first run, or against a `--history` naming
 * a file the deck will create, `realpath` throws ENOENT — and falling back to
 * the resolved string would leave the two spellings different for exactly the
 * run that creates the file. The parent exists (or is about to be created under
 * one canonical name), so it is canonicalised and the basename rejoined.
 *
 * `canonicalWorkspace` in canonical-path.mjs is the same rule for the other
 * path this deck publishes, with three comments naming 8.3 expansion as its
 * reason. This is that rule reaching the value two lines away from it.
 */
export function canonicalLogPath(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  const abs = resolve(raw);
  try { return realpathSync.native(abs); } catch { /* not created yet */ }
  try { return join(realpathSync.native(dirname(abs)), basename(abs)); } catch { return abs; }
}

/**
 * Does this platform's filesystem treat two spellings that differ only in case
 * as the same file? The platform is a parameter so both answers can be checked
 * from either kind of machine.
 *
 * Windows always does, and macOS does by default (APFS and HFS+ are formatted
 * case-insensitive unless the user deliberately chose otherwise). Linux does
 * not, and folding case there would be a bug of its own: /srv/a/events.jsonl and
 * /srv/A/events.jsonl are two real files, each of which needs a writer.
 */
export const foldsCase = (platform = process.platform) =>
  platform === "win32" || platform === "darwin";

/**
 * Of these decks, which ones write to disk? Returns the subset that should;
 * every other one is expected to draw the event and keep no record of it.
 *
 * Decks are grouped by the log file each one names in its discovery record and
 * one deck per group is elected. Grouping by the file rather than counting decks
 * is what keeps the overrides honest: a deck run with `--history` sits alone in
 * its own group and always writes, a deck run with `--no-persist` reports no
 * file and can never be elected to write for one that does, and a deck too old
 * to report either keeps the behaviour it had before this rule existed. Within a
 * group the lowest port wins — a fixed rule, so the same deck holds the file for
 * as long as it is up and the next one inherits it as soon as that deck is gone.
 *
 * Kept byte-for-byte equivalent to electWriters in hook/hook.js: the two decide
 * for the same decks over the same records, and a disagreement between them
 * means one log line written twice or none at all.
 */
export function electWriters(decks, platform = process.platform) {
  const byLog = new Map();
  for (const d of decks) {
    const log = typeof d.persist === "string" ? d.persist : "";
    // Two namespaces, so a deck with no log to share — and a deck too old to
    // report one — is alone in its group and cannot collide with a real path.
    const key = log
      ? `log:${foldsCase(platform) ? log.toLowerCase() : log}`
      : `deck:${d.pid}:${d.port}`;
    const held = byLog.get(key);
    // Ports are unique among live decks; pid only breaks a tie a stale
    // discovery file could invent, so the answer stays deterministic.
    if (!held || d.port < held.port || (d.port === held.port && d.pid < held.pid)) {
      byLog.set(key, d);
    }
  }
  return new Set(byLog.values());
}

/**
 * Would a deck scoped to `workspace` capture a rollout running in `cwd`? An
 * empty workspace is unscoped and captures every session; a rollout that never
 * said where it runs is inside no workspace, so only an unscoped deck draws it.
 *
 * This answers two questions with one function — whether THIS deck tails a
 * rollout, and whether another deck tails it too — and that is only sound while
 * the rule below is the rule every deck actually runs. Model another deck's
 * capture with anything else and the election covers the wrong set: a deck that
 * writes without being elected, or an elected deck that never opened the file.
 *
 * It is also the rule hook/hook.js runs for the sessions it delivers, under the
 * name capturesSession — that script is copied out of the package and run
 * standalone, so the two are written twice and pinned equal by a test walking
 * one table of paths through both. They were not equal: case was folded here on
 * every platform, so on Linux a deck scoped to /srv/proj captured Codex sessions
 * from /srv/Proj and Claude sessions from neither. Those are two real
 * directories there, and the hook's own comment says what folding them together
 * costs — a deck handed the events of a tree it was not scoped to. So the fold
 * is per-platform on both sides now, and `--workspace` means one thing.
 *
 * (The narrow window that opens: two decks on Linux whose workspaces differ only
 * in case, one of them old enough to still fold, both containing one rollout's
 * cwd. Each models the other as tailing the file; one of them is wrong, and the
 * cost is a single log line written twice.)
 *
 * The platform is a parameter, following the hook's cwdInWorkspace and
 * spawnSpec in src/server/exec.mjs, so the Windows separator is testable from a
 * POSIX machine.
 */
export function codexCwdInWorkspace(cwd, workspace, platform = process.platform) {
  if (!workspace || typeof workspace !== "string") return true;
  if (!cwd || typeof cwd !== "string") return false;
  const p = platform === "win32" ? win32 : posix;
  const fold = s => (foldsCase(platform) ? s.toLowerCase() : s);
  const a = fold(p.resolve(cwd));
  const b = fold(p.resolve(workspace));
  if (a === b) return true;
  // A root ("C:\", "/") already ends in the separator; appending a second one
  // would match nothing.
  return a.startsWith(b.endsWith(p.sep) ? b : b + p.sep);
}

/**
 * Do two discovery records name the same Codex tree? Each argument is a
 * record's `codexHome`: the canonical path of the CODEX_HOME that deck tails.
 *
 * Anything that is not a non-empty string answers yes. That is a record written
 * before the field existed — a machine halfway through an upgrade is the
 * ordinary way to meet one — and guessing "a different tree" there would elect
 * a second writer for one log on every machine with an older deck still up.
 * Guessing "the same tree" is what every deck did before the field existed,
 * which is the fail-safe writesCodexLog below already takes for a record too old
 * to carry `codex` at all.
 *
 * Case is folded where the filesystem folds it, exactly as electWriters folds
 * the log path: on Windows and macOS two spellings that differ only in case are
 * one directory with one reader, and on Linux they are two directories, each
 * read by its own deck. The other ways to spell one directory — a symlinked
 * ~/.codex, an 8.3-shortened USERPROFILE, /tmp against /private/tmp — are
 * settled before the value is published (writeDiscovery in discovery.mjs runs
 * it through canonicalLogPath), so two records compared here already agree on
 * everything but case.
 */
export function sameCodexTree(a, b, platform = process.platform) {
  if (typeof a !== "string" || a === "" || typeof b !== "string" || b === "") return true;
  return foldsCase(platform) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Does this deck append a rollout's events to its log, or is another deck doing
 * it? `decks` is every deck registered right now, `pid` identifies this one
 * among them, and `cwd` is the workspace the rollout is running in.
 *
 * The group is every deck that tails this same rollout: each deck decides for
 * itself, so all of them whose workspace contains the cwd read the file and all
 * of them would write it. The hook builds the same group the same way for the
 * events it delivers — it used to narrow them to the longest workspace match
 * first, which is the asymmetry the predicate above describes the end of. A deck
 * started with `--no-codex` tails nothing and is left out; electing it would
 * mean the rollout's events reach no log at all. A deck too old to say either
 * way is assumed to be tailing, which is what it was doing before this field
 * existed.
 *
 * A deck reading a different Codex tree is left out for the same reason (#982).
 * CODEX_HOME moves the whole tree, so two decks on one machine can share one
 * events.jsonl while reading two different sets of rollouts — and for an
 * unscoped deck the workspace test above answers yes to every cwd, so it tells
 * them apart not at all. The record's `codex: true` said a deck tails rollouts
 * and never said whose. So the lower-port deck won the line for a rollout its
 * own tree does not hold and appended nothing, the deck that was reading it
 * stood down, and the shared log recorded none of the session while the canvas
 * drew all of it: #695's symptom, from a deck that is alive, answers its
 * challenge, and is simply looking somewhere else. The same deck launched with
 * a stale CODEX_HOME is the duller version of it.
 */
export function writesCodexLog({ decks, pid, cwd, codexHome = null, platform = process.platform }) {
  const live = Array.isArray(decks) ? decks : [];
  const self = live.find(d => d && d.pid === pid) ?? null;
  // No record of our own on disk — the window before the first heartbeat writes
  // it, or a deck that cannot write one at all. Nobody can elect us and we
  // cannot see who else is here, so keep what this deck did before the election
  // existed and write. A line written twice is recoverable; a deck that quietly
  // stops recording anything is not.
  if (!self || typeof self.persist !== "string" || self.persist === "") return true;

  const group = [self];
  for (const d of live) {
    if (!d || d.pid === self.pid) continue;
    if (d.codex === false) continue;
    if (codexHome) {
      const roots = Array.isArray(d.codexHomes) ? d.codexHomes : [d.codexHome];
      if (!roots.some(root => sameCodexTree(root, codexHome, platform))) continue;
    } else if (!sameCodexTree(self.codexHome, d.codexHome, platform)) continue;
    if (!codexCwdInWorkspace(cwd, d.workspace ?? "", platform)) continue;
    group.push(d);
  }
  if (codexHome) {
    // Legacy decks only compare primary homes. Prefer those readers for this
    // log so an alternate-home reader cannot elect itself beside a legacy writer.
    const primary = group.filter(d => typeof d.codexHome === "string" && d.codexHome !== ""
      && sameCodexTree(d.codexHome, codexHome, platform)
      && typeof d.persist === "string" && d.persist !== ""
      && sameCodexTree(d.persist, self.persist, platform));
    if (primary.length) return electWriters(primary, platform).has(self);
  }
  return electWriters(group, platform).has(self);
}
