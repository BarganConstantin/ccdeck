// Which transcript paths the deck will open at all: the gate pushEvent asks
// before any enrichment pass reads the `transcript_path` a hook payload names,
// and the once-per-path note on stderr when it refuses one.
//
// This lived at the end of src/server/transcript-scan.mjs, and nothing in the
// scanner ever called it. event-pipeline.mjs asks it once, at the one door a
// caller-chosen path comes through, and only then hands the path to the
// passes that scan it. The bodies are unchanged, and index.mjs still
// re-exports isClaudeTranscriptPath.
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { claudeConfigDir } from "./claude-dir.mjs";
import { PRODUCT } from "./brand.mjs";
// Whether this platform's filesystem folds case — the one answer every
// server-side path comparison gives. See foldsCase in log-election.mjs.
import { foldsCase } from "./log-election.mjs";

// ─── Which paths the deck will follow at all ─────────────────────────────
// `payload.transcript_path` is a string in the body of `POST /api/event`, and
// that route is a deliberate OPEN_MUTATION: no token, no Origin, nothing. Until
// #674 the deck took whatever it said and opened it. The bounds on the read
// (MAX_SCAN_CHUNK in jsonl-chunks.mjs, MAX_SCAN_BYTES_PER_PASS in
// transcript-scan.mjs) make that survivable; this makes it uninteresting, and
// the two are worth having together for different reasons.
//
// WHY VALIDATE AT ALL WHEN THE READ IS ALREADY BOUNDED. Because the caller here
// is not a web page — `isTrustedMutation` refuses `Sec-Fetch-Site: cross-site`
// before any of this — it is a local process: the sandboxed subprocess with
// loopback egress that the comment above `isAuthorizedMutation` already names,
// or another UID on a shared box. Against that caller a ceiling only sets the
// price per request; it does not take the lever away. What takes it away is
// that there is no file it can name. Claude Code writes transcripts in exactly
// one place, `<config dir>/projects/…`, and every legitimate `transcript_path`
// the deck has ever seen is one of those — so the set of things worth opening
// is knowable in advance, and checking membership costs one string comparison
// against a syscall that used to cost the size of the file.
//
// WHAT IS LEFT AFTERWARDS, stated plainly: a caller who can WRITE inside that
// directory can still point the deck at a file of its choosing. That caller is
// this user's own processes — and this user's own processes can read
// `<config dir>/agent-dag/*.json`, which is where HOOK_TOKEN lives at mode
// 0600, so they hold the credential already. The gate reduces the
// credential-free adversary to the one who was never credential-free. That is
// the whole of what it claims, and those ceilings on the read are what carries
// the rest.
//
// WHY NOT realpath. A symlink planted inside the projects directory would
// defeat the containment test — but planting one needs write access to that
// directory, which is the case above where the caller already holds the token.
// It would also cost a syscall on every hook event, on a path that runs for
// every event of every live session.
//
// WHY TWO ROOTS. CLAUDE_CONFIG_DIR replaces ~/.claude wholesale, and the deck
// reads the variable from its OWN environment while the path is written by
// whatever `claude` process the hook fired in. Those normally agree — the deck
// installs its hook into the directory it resolves, so a session whose events
// arrive here is a session reading that same directory — but a deck launched
// from a desktop shortcut that never sourced the shell rc is a real way for
// them to disagree in one direction. Accepting the default location as well
// costs nothing (it is a directory only this user writes either way) and
// removes half of that failure mode. The other half is why the refusal is
// logged rather than silent.
function claudeTranscriptRoots() {
  // Resolved per call, like every other claudeConfigDir() reader in src/server,
  // so nothing captures the answer from an environment that has moved.
  const roots = [resolve(claudeConfigDir(), "projects")];
  const byDefault = resolve(homedir(), ".claude", "projects");
  if (!roots.includes(byDefault)) roots.push(byDefault);
  return roots;
}

/** Is `p` a Claude Code transcript, in a directory Claude Code writes them?
 *
 *  Containment is compared on the RESOLVED path with a trailing separator, so
 *  `…/projects-of-mine/x.jsonl` is not inside `…/projects` and `..` cannot
 *  climb out of it. The comparison is case-insensitive on Windows and macOS,
 *  whose default filesystems are, because the two halves come from two
 *  processes and only one of them chose the casing. */
export function isClaudeTranscriptPath(p, roots = claudeTranscriptRoots()) {
  if (!p || typeof p !== "string") return false;
  if (!/\.jsonl$/i.test(p)) return false;      // the only extension CC writes
  const fold = foldsCase();
  const full = fold ? resolve(p).toLowerCase() : resolve(p);
  for (const root of roots) {
    const prefix = (fold ? root.toLowerCase() : root) + sep;
    if (full.startsWith(prefix) && full.length > prefix.length) return true;
  }
  return false;
}

// Refusals are logged once per path and the set is capped, because the point of
// the log is a misconfigured deck saying so on stderr — one line naming the
// path and where transcripts are expected — and a caller posting a fresh path
// per request must not turn that into a second unbounded accumulation.
const refusedTranscriptPaths = new Set();
const MAX_REFUSED_TRANSCRIPT_PATHS = 64;

function noteRefusedTranscript(p) {
  if (refusedTranscriptPaths.has(p)) return;
  if (refusedTranscriptPaths.size >= MAX_REFUSED_TRANSCRIPT_PATHS) return;
  refusedTranscriptPaths.add(p);
  console.warn(`${PRODUCT}: not reading transcript_path outside ${claudeTranscriptRoots().join(" or ")}: ${p}`);
}

// What event-pipeline.mjs calls besides isClaudeTranscriptPath above. Listed
// rather than marked, so the declaration reads as it did where it came from.
export { noteRefusedTranscript };
