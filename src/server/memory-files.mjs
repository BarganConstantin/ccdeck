// Which memory files a session has in scope: the CLAUDE.md family for a Claude
// session and AGENTS.md for a Codex one, found by the walk both CLIs make from
// the working directory up to the filesystem root, plus the user-global file
// each one adds — and, for Claude, the per-project auto-memory directory.
//
// These lived in src/server/session-enrichment.mjs, beside the context pass
// that sends their answer on, and they read no transcript: they stat a working
// tree. So they moved on their own, and session-enrichment.mjs imports the two
// scans its context passes call. index.mjs still re-exports both. The bodies
// are unchanged.
import { readdir, stat } from "node:fs/promises";
import { join, resolve, dirname as pdirname } from "node:path";
import { ccProjectSlug, claudeConfigDir } from "./claude-dir.mjs";
import { CODEX_HOME } from "./codex-dir.mjs";

/**
 * Candidate memory-file paths on the walk from `cwd` up to the filesystem root.
 *
 * Both CLIs load their memory file the same way — nearest-first from the
 * working directory outwards — and differ only in what the file is CALLED and
 * in what else they add on top, so the walk is written once here and the two
 * scanners below supply their own names. `rels` is a list of paths RELATIVE to
 * each directory on the walk rather than bare filenames, because CC also honours
 * `.claude/CLAUDE.md` at every level and Codex does not.
 *
 * Sixteen levels is the same depth this has always used: deep enough for any
 * real checkout, shallow enough that a cwd on a network mount cannot turn one
 * context read into an unbounded number of stat() calls.
 *
 * Returns paths without touching the disk. Statting them is collectMemoryFiles'
 * job, so a caller that wants to add its own paths — a user-global file, a
 * per-project memory directory — can splice them into one ordered list and get
 * a single de-duplicated, existence-checked answer back.
 */
function memoryWalkPaths(cwd, rels) {
  const out = [];
  let dir = resolve(cwd);
  for (let depth = 0; depth < 16; depth++) {
    for (const rel of rels) out.push(join(dir, rel));
    const parent = pdirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Which of `paths` are real, non-empty files, in the order given and with
 * duplicates dropped.
 *
 * A zero-byte file is skipped on purpose: it contributes nothing to the model's
 * context, and listing it in the modal would have the reader looking for the
 * bytes it claims to cost. A path that cannot be stat()ed is simply absent —
 * this runs against a tree another process is editing, and a permissions error
 * on one candidate is no reason to lose the other fifteen.
 */
async function collectMemoryFiles(paths) {
  const found = [];
  const seen = new Set();
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      const s = await stat(p);
      if (s.isFile() && s.size > 0) found.push({ path: p, bytes: s.size });
    } catch {}
  }
  return found;
}

/** The memory files a CLAUDE session has in scope. Exported alongside its Codex
 *  counterpart below so a test can check the pair together — the two must agree
 *  on the walk and disagree on the filename, and only one of them showing up in
 *  a test is how they would drift. */
export async function scanClaudeMdFiles(cwd) {
  if (!cwd || typeof cwd !== "string") return [];
  // The CONFIG dir, not the home directory. CLAUDE_CONFIG_DIR relocates it
  // wholesale — it replaces ~/.claude rather than overlaying it — so on a
  // machine where it is set, `homedir()/.claude` is a directory Claude Code
  // does not read. Spelling it by hand here failed in both directions at once:
  // the user-global memory file and every auto-memory file went missing from
  // the modal and from the byte total beside it, while a stale ~/.claude left
  // over from before the variable was set got listed as if it were in context.
  // Resolved per call, like the two other claudeConfigDir() readers in this
  // file, so nothing captures the answer from an environment that has moved.
  const cfg = claudeConfigDir();
  // Walk up from cwd to filesystem root, checking the canonical CC memory
  // filenames plus CLAUDE.local.md (user-private) at each level.
  //
  // The `.claude/` prefix on the last two is NOT the config dir wearing a
  // second spelling: it is CC's per-directory project convention, one such
  // folder per level of the walk, and it stays literal however the config dir
  // moves.
  const paths = memoryWalkPaths(cwd, [
    "CLAUDE.md",
    "CLAUDE.local.md",
    join(".claude", "CLAUDE.md"),
    join(".claude", "CLAUDE.local.md"),
  ]);
  // User-global memory.
  paths.push(join(cfg, "CLAUDE.md"));
  paths.push(join(cfg, "CLAUDE.local.md"));
  // Per-project auto-memory: $CLAUDE_CONFIG_DIR/projects/<slug>/memory/*.md
  // (plus MEMORY.md index). CC injects these into context for sessions whose
  // cwd matches the slug. That directory sits beside the <sessionId>.jsonl
  // transcripts, so it moves with the config dir by construction.
  const slug = ccProjectSlug(cwd);
  if (slug) {
    const memDir = join(cfg, "projects", slug, "memory");
    try {
      const entries = await readdir(memDir);
      for (const f of entries) {
        if (f.toLowerCase().endsWith(".md")) paths.push(join(memDir, f));
      }
    } catch {}
  }
  return collectMemoryFiles(paths);
}

/**
 * The memory files a CODEX session has in scope: AGENTS.md, not CLAUDE.md.
 *
 * WHY THIS FUNCTION EXISTS AT ALL (#399). The context modal's third section was
 * fed by scanClaudeMdFiles for every session regardless of provider, so the
 * moment the donut became reachable for Codex the modal would have told a Codex
 * user "No CLAUDE.md files found on the path from cwd to ~/.claude" — naming a
 * file and a directory Codex does not read. Before this, `AGENTS.md` did not
 * appear anywhere in this repository.
 *
 * That Codex reads it is not an assumption. Sampled every rollout under this
 * machine's CODEX_HOME (structural search, no record content printed): the
 * literal string `AGENTS.md` appears on 9 lines across 5 of the 8 files — in the
 * `response_item/message` role=user preamble Codex prepends to a turn, in a
 * role=developer message, and in a `world_state` record — while `CLAUDE.md`
 * appears on zero lines in any of them.
 *
 * WHY THE FILESYSTEM AND NOT THE ROLLOUT. The rollout does name the files, but
 * only inside message TEXT, and reading the text of a user's conversation to
 * find a filename is not a trade this deck makes anywhere else — the Claude side
 * has always answered the same question by walking the filesystem, and the two
 * halves of one modal section should be derived the same way or the reader
 * cannot compare them.
 *
 * CODEX_HOME comes from codex-dir.mjs like every other Codex path in the
 * process (#375), so a relocated Codex home is honoured here without this
 * module growing a sixth spelling of the rule.
 *
 * Exported for the tests, like readContextFromTranscript beside it: the rule for
 * which files a session has in scope is worth pinning directly, rather than
 * through a watcher, a temp home and a 1.5s poll.
 */
export async function scanAgentsMdFiles(cwd) {
  if (!cwd || typeof cwd !== "string") return [];
  // Codex has no `.codex/AGENTS.md` per-directory convention to mirror CC's
  // `.claude/CLAUDE.md`, so the per-level list is the single filename.
  const paths = memoryWalkPaths(cwd, ["AGENTS.md"]);
  // The user-global instructions file, which Codex loads for every session
  // whatever the cwd — the counterpart of ~/.claude/CLAUDE.md.
  paths.push(join(CODEX_HOME, "AGENTS.md"));
  return collectMemoryFiles(paths);
}
