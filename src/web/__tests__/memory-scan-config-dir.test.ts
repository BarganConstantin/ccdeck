// Reported as #608. `scanClaudeMdFiles` — the function behind the context
// modal's memory-file list — spelled Claude Code's config directory by hand as
// `homedir()/.claude` in three places: the user-global CLAUDE.md, the
// CLAUDE.local.md beside it, and the per-project auto-memory directory under
// `projects/<slug>/memory/`. Everything else on the Claude side of the deck
// resolves that directory through `claudeConfigDir()`, which honours
// CLAUDE_CONFIG_DIR.
//
// CLAUDE_CONFIG_DIR is a REPLACEMENT for ~/.claude, not an overlay, so the bug
// ran in both directions at once and either half alone would be enough to make
// the panel lie:
//
//   - Nothing under the configured directory was ever looked at, so the modal
//     dropped the user-global memory file and every auto-memory file the
//     session actually has in context, along with their bytes from the total.
//   - Anything left behind in a stale ~/.claude from before the variable was
//     set WAS looked at, and got listed as though the model were reading it.
//
// So every case below asserts both halves: the file that must appear, and the
// decoy of the same name in the other directory that must not.
//
// WHY THE EXPECTED PATHS ARE WRITTEN OUT AND NOT COMPUTED. A test that asked
// `claudeConfigDir()` where to look would agree with a wrong answer as readily
// as with a right one — it would be checking that the scan is self-consistent,
// which the broken version also was. The two directories here are literals this
// file created itself, and the assertions name them.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// ── two directories, kept apart on purpose ─────────────────────────────────
// The home the process believes it has, and the config dir the override points
// at. Keeping them separate is the whole instrument: it is what distinguishes
// "read the configured directory" from "read ~/.claude and got lucky because
// they were the same place".
//
// HOME and USERPROFILE are both set because `os.homedir()` reads the first on
// POSIX and the second on Windows, and CLAUDE_CONFIG_DIR is set over whatever
// the developer running this may have in their own environment. Between them,
// nothing in this file can reach a real ~/.claude on any of the three OSes.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-608-"));
const FAKE_HOME = join(SANDBOX, "home");
const STALE_CLAUDE = join(FAKE_HOME, ".claude");   // the ~/.claude CC no longer reads
const FAKE_CONFIG = join(SANDBOX, "config");        // where CLAUDE_CONFIG_DIR points
const REPO = join(SANDBOX, "repo");

const PREV = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CONFIG;
// The Codex scanner shares this module; point it somewhere harmless too rather
// than leave one of the two halves reading the developer's real ~/.codex.
process.env.CODEX_HOME = join(SANDBOX, "codex-home");

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(SANDBOX);
});

// Imported after the environment is in place: a module that resolved anything
// at load time would otherwise capture the real machine's answer.
// @ts-expect-error — .mjs server module, no types
const server = await import("../../server/index.mjs");
type MemoryFile = { path: string; bytes: number };
type MemoryScan = (cwd: string) => Promise<MemoryFile[]>;
// @ts-expect-error — .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");
const scanClaudeMdFiles = server.scanClaudeMdFiles as MemoryScan | undefined;
const ccProjectSlug = server.ccProjectSlug as ((cwd: string) => string) | undefined;

/** The scanner, or one named failed assertion — never a thrown TypeError that
 *  collapses the file into a single collection error saying only that something
 *  went wrong. Same defence the sibling context tests use. */
function scan(): MemoryScan {
  expect(scanClaudeMdFiles, "scanClaudeMdFiles is not exported from src/server/index.mjs").toBeTypeOf("function");
  return scanClaudeMdFiles!;
}
const paths = async (cwd: string) => (await scan()(cwd)).map(f => f.path);

/** Fixture-time checks throw plainly rather than through `expect`: they run at
 *  collection, where there is no case to attribute a failed assertion to. */
function must(ok: unknown, msg: string): void {
  if (!ok) throw new Error(msg);
}

// ── the fixture ────────────────────────────────────────────────────────────
// The same four filenames exist in BOTH directories, with different contents so
// a mixed-up read is visible in the byte count as well as in the path. The
// per-project auto-memory folder is reproduced in both too, under the slug CC
// would use for this cwd.
must(typeof ccProjectSlug === "function", "ccProjectSlug is not exported from src/server/index.mjs");
const SLUG = ccProjectSlug!(REPO);
must(SLUG.length > 0, `ccProjectSlug returned nothing for ${REPO}`);
const CONFIG_MEM = join(FAKE_CONFIG, "projects", SLUG, "memory");
const STALE_MEM = join(STALE_CLAUDE, "projects", SLUG, "memory");

mkdirSync(join(REPO, ".claude"), { recursive: true });
mkdirSync(CONFIG_MEM, { recursive: true });
mkdirSync(STALE_MEM, { recursive: true });

writeFileSync(join(REPO, "CLAUDE.md"), "project memory\n");
// The per-directory `.claude/CLAUDE.md` convention, which is a DIFFERENT thing
// from the config dir despite the shared name: one such folder per level of the
// walk up from cwd. A fix that treated the two as one spelling would move this
// file's expected location too, so it is pinned here alongside.
writeFileSync(join(REPO, ".claude", "CLAUDE.md"), "project-local memory\n");

writeFileSync(join(FAKE_CONFIG, "CLAUDE.md"), "USER GLOBAL FROM CONFIG DIR\n");
writeFileSync(join(FAKE_CONFIG, "CLAUDE.local.md"), "user-private, config dir\n");
writeFileSync(join(CONFIG_MEM, "MEMORY.md"), "auto-memory index, config dir\n");
writeFileSync(join(CONFIG_MEM, "note.md"), "one auto-memory note\n");

writeFileSync(join(STALE_CLAUDE, "CLAUDE.md"), "stale ~/.claude global\n");
writeFileSync(join(STALE_CLAUDE, "CLAUDE.local.md"), "stale ~/.claude private\n");
writeFileSync(join(STALE_MEM, "MEMORY.md"), "stale auto-memory index\n");

// Belt and braces, in the shape claude-config-dir.test.ts uses: if the override
// were being ignored in a way none of the cases below happened to name, the
// scan would still be answering out of somewhere real. Fail before any
// assertion gets the chance to look like a pass.
must(typeof scanClaudeMdFiles === "function", "scanClaudeMdFiles is not exported from src/server/index.mjs");
{
  const stray = (await scanClaudeMdFiles!(REPO)).map(f => f.path).filter(p => !p.startsWith(SANDBOX));
  must(stray.length === 0, `refusing to run: the scan reached outside ${SANDBOX} — ${stray.join(", ")}`);
}

// The same directory named the other way round, for the relative-path case.
const RELATIVE_CONFIG = relative(process.cwd(), FAKE_CONFIG);

beforeEach(() => {
  // Cases below move the variable; every one of them starts from it set.
  process.env.CLAUDE_CONFIG_DIR = FAKE_CONFIG;
});

describe("the memory scan reads the configured Claude dir, not ~/.claude", () => {
  it("lists the user-global CLAUDE.md out of $CLAUDE_CONFIG_DIR", async () => {
    const found = await paths(REPO);
    expect(found, "$CLAUDE_CONFIG_DIR/CLAUDE.md is not in the memory list — the user-global memory file was looked for under ~/.claude").toContain(join(FAKE_CONFIG, "CLAUDE.md"));
    expect(found, "~/.claude/CLAUDE.md is in the memory list — a directory Claude Code does not read while CLAUDE_CONFIG_DIR is set").not.toContain(join(STALE_CLAUDE, "CLAUDE.md"));
  });

  it("lists CLAUDE.local.md out of $CLAUDE_CONFIG_DIR too", async () => {
    const found = await paths(REPO);
    expect(found, "$CLAUDE_CONFIG_DIR/CLAUDE.local.md is not in the memory list — the user-private file was looked for under ~/.claude").toContain(join(FAKE_CONFIG, "CLAUDE.local.md"));
    expect(found, "~/.claude/CLAUDE.local.md is in the memory list — a directory Claude Code does not read while CLAUDE_CONFIG_DIR is set").not.toContain(join(STALE_CLAUDE, "CLAUDE.local.md"));
  });

  it("lists every auto-memory file under $CLAUDE_CONFIG_DIR/projects/<slug>/memory", async () => {
    const found = await paths(REPO);
    expect(found, "the auto-memory index under $CLAUDE_CONFIG_DIR/projects/<slug>/memory is missing — the scan looked under ~/.claude/projects").toContain(join(CONFIG_MEM, "MEMORY.md"));
    expect(found, "an auto-memory note under $CLAUDE_CONFIG_DIR/projects/<slug>/memory is missing — the scan looked under ~/.claude/projects").toContain(join(CONFIG_MEM, "note.md"));
    expect(found, "an auto-memory file out of the stale ~/.claude/projects is in the list — Claude Code is not reading it").not.toContain(join(STALE_MEM, "MEMORY.md"));
  });

  it("reports nothing at all out of the stale ~/.claude beside it", async () => {
    // The half that is easy to leave untested and is the reason the panel could
    // be confidently wrong rather than merely short: files Claude Code is not
    // reading, listed as if it were.
    const found = await paths(REPO);
    expect(found.filter(p => p.startsWith(STALE_CLAUDE)), "the memory list carries files out of the stale ~/.claude, which Claude Code does not read while CLAUDE_CONFIG_DIR is set").toEqual([]);
  });

  it("counts the configured file's bytes, so the total is the one in context", async () => {
    // A path can be right while the row beside it is invented; this pins that
    // the entry came from a real stat of the real file.
    const entry = (await scan()(REPO)).find(f => f.path === join(FAKE_CONFIG, "CLAUDE.md"));
    expect(entry?.bytes, "no byte count for $CLAUDE_CONFIG_DIR/CLAUDE.md — its size is missing from the context total the modal prints").toBe(statSync(join(FAKE_CONFIG, "CLAUDE.md")).size);
  });

  it("still walks up from cwd, including the per-level .claude/CLAUDE.md", async () => {
    // The two `.claude/…` entries on the walk are a per-directory project
    // convention, not the config dir, and a relocated config dir must leave
    // them exactly where they are.
    const found = await paths(REPO);
    expect(found, "the project CLAUDE.md on the walk up from cwd was lost").toContain(join(REPO, "CLAUDE.md"));
    expect(found, "the per-directory .claude/CLAUDE.md convention was lost — it is not the config dir and must not move with it").toContain(join(REPO, ".claude", "CLAUDE.md"));
  });

  it("resolves a RELATIVE CLAUDE_CONFIG_DIR against the process cwd", async () => {
    // The variable is a user-typed string and nothing makes it absolute: a
    // dotfiles checkout, or a `./profile/claude` in a launch script, is a
    // config dir like any other. Left unresolved it would be joined onto a
    // filename and stat()ed against whatever cwd the deck happened to have.
    //
    // Two assertions, because the three OSes differ in what can be shown. The
    // first is the rule itself, against a literal relative name and an expected
    // path built out of process.cwd() by hand — true everywhere.
    expect(
      claudeConfigDir({ CLAUDE_CONFIG_DIR: join("profile", "claude") }),
      "a relative CLAUDE_CONFIG_DIR was not made absolute against the process cwd",
    ).toBe(join(process.cwd(), "profile", "claude"));
    // The second drives the same rule through the scanner, with this file's own
    // sandbox named relatively. On a Windows machine whose TEMP sits on another
    // drive from the checkout — GitHub's own runners are exactly that, D: for
    // the workspace and C: for TEMP — a path has no relative form at all and
    // `relative()` hands the absolute one back; there the assertions below
    // repeat the first case instead of adding to it. That is a cheaper honest
    // outcome than a skip gate conditioned on a runtime probe.
    process.env.CLAUDE_CONFIG_DIR = RELATIVE_CONFIG;
    const found = await paths(REPO);
    expect(found, "a relative CLAUDE_CONFIG_DIR did not resolve to the directory it names").toContain(join(FAKE_CONFIG, "CLAUDE.md"));
    expect(found, "a relative CLAUDE_CONFIG_DIR did not reach the auto-memory directory under it").toContain(join(CONFIG_MEM, "MEMORY.md"));
    expect(found.filter(p => p.startsWith(STALE_CLAUDE)), "a relative CLAUDE_CONFIG_DIR fell back to the stale ~/.claude").toEqual([]);
  });

  it("falls back to ~/.claude on a machine that never set the variable", async () => {
    // The other half of the contract, and the reason the resolution is done per
    // call rather than captured at module load: unset the variable and the
    // answer moves back to the home directory, same run, same module instance.
    delete process.env.CLAUDE_CONFIG_DIR;
    const found = await paths(REPO);
    expect(found, "with CLAUDE_CONFIG_DIR unset the user-global ~/.claude/CLAUDE.md is no longer found").toContain(join(STALE_CLAUDE, "CLAUDE.md"));
    expect(found, "with CLAUDE_CONFIG_DIR unset ~/.claude/CLAUDE.local.md is no longer found").toContain(join(STALE_CLAUDE, "CLAUDE.local.md"));
    expect(found, "with CLAUDE_CONFIG_DIR unset the auto-memory under ~/.claude/projects is no longer found").toContain(join(STALE_MEM, "MEMORY.md"));
    expect(found.filter(p => p.startsWith(FAKE_CONFIG)), "the config dir was captured once instead of resolved per call — unsetting the variable did not move the answer back").toEqual([]);
  });

  it("is unmoved by a config dir that does not exist", async () => {
    // A variable pointing at a directory nobody has created yet is not an error
    // state: the walk from cwd still has to answer, and answer without the
    // stale home directory creeping back in as a fallback.
    process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, "nowhere");
    const found = await paths(REPO);
    expect(found, "a CLAUDE_CONFIG_DIR pointing at a directory that does not exist took the walk from cwd down with it").toContain(join(REPO, "CLAUDE.md"));
    expect(found.filter(p => p.startsWith(STALE_CLAUDE)), "a missing config dir silently fell back to ~/.claude").toEqual([]);
  });
});
