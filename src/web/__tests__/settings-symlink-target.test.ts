// #673: every writer in the deck that touches settings.json renamed its temp
// file onto the NAME it was given, and `~/.claude/settings.json` is a symlink on
// a great many machines — into a dotfiles repo, a stow or chezmoi target, an
// encrypted volume. A rename replaces a directory entry, so the link was deleted
// and an ordinary file left where it had been. The content came through intact,
// which is why this looked fine for so long: nothing was corrupted, the repo
// copy simply stopped being the file Claude Code reads. It never went dirty, so
// there was no signal at all — the user's later edits reached nobody, and every
// launch rewrote the detached copy and widened the gap.
//
// The rule already existed one file over. persistAuth in codex-auth.mjs resolves
// before it stages, for this hazard, named in its own comment — on the file that
// is LESS often linked. The fix puts that resolution at the helper every
// settings writer goes through, and both files now call the same function.
//
// TWO BLOCKS, AND THE SECOND IS THE WINDOWS STORY. Creating a FILE symlink on
// Windows needs SeCreateSymbolicLinkPrivilege (or Developer Mode), so the
// end-to-end cases — the ones that make a link, run a writer, and look at what
// is left — are gated to POSIX and registered in skip-gates.mjs. Windows is not
// left with nothing: `MoveFileExW` with MOVEFILE_REPLACE_EXISTING replaces a
// reparse point rather than following it, so the bug is real there, and what
// the fix rests on is asserted on that leg instead. A DIRECTORY junction is a
// reparse point Windows creates without any privilege at all, and the second
// block resolves through one, writes through one, and reads the rule back out
// of the shipped source — which is what would go red on the Windows leg if
// writeFileAtomic ever stopped resolving. What Windows CI still does not do is
// rename onto a real file symlink; that gap is the privilege, not the code.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// installer.mjs and retire-sound-hook.mjs both resolve the Claude config dir at
// import time — CLAUDE_CONFIG_DIR when set, otherwise ~/.claude via os.homedir(),
// which reads $HOME on POSIX and %USERPROFILE% on Windows — and
// retire-sound-hook.mjs puts its parked-hooks file under os.homedir() as well.
// All four are pointed at a temp directory BEFORE either module is loaded, so
// nothing in this file can reach the developer's own ~/.claude, ~/.codex or
// ~/.agents-deck on any platform. The guard below refuses to run if that ever stops being true.
//
// A realpath because resolveWriteTarget ANSWERS in resolved paths, and macOS
// hands out /var/folders/… temp directories that are really /private/var/… — a
// test comparing the two spellings would fail on the developer's own machine
// while the product was correct. `.native` and not the plain one, for the reason
// workspace-one-meaning.test.ts sets out at length: fs.realpathSync is a
// JavaScript symlink walk, fs.realpathSync.native is uv_fs_realpath — the same
// call fs/promises' realpath makes, which is the one the product uses — and on
// Windows that one also expands an 8.3 short component. Every expectation below
// is computed with the same call, so the two agree by construction.
const FAKE_HOME = realpathSync.native(mkdtempSync(join(tmpdir(), "ccdeck-673-")));
const FAKE_CLAUDE = join(FAKE_HOME, ".claude");
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
const prevCodexHome = process.env.CODEX_HOME;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");

// @ts-expect-error — .mjs server module, no types
const installer = await import("../../server/installer.mjs");
// @ts-expect-error — .mjs server module, no types
const sound = await import("../../server/retire-sound-hook.mjs");

const { installHooks, uninstallHooks, writeFileAtomic, resolveWriteTarget, CLAUDE_DIR } = installer;
const { retireSoundHook, SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH } = sound;

for (const p of [CLAUDE_DIR, SETTINGS_PATH, PARKED_PATH]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: a deck module resolved ${p}, outside ${FAKE_HOME}`);
  }
}

const SETTINGS = String(SETTINGS_PATH);
// The dotfiles repo the link points into: a second directory, so "which file did
// the bytes land in" is a question with two possible answers.
const DOTFILES = join(FAKE_HOME, "dotfiles");
const REPO_COPY = join(DOTFILES, "claude-settings.json");

mkdirSync(FAKE_CLAUDE, { recursive: true });
mkdirSync(DOTFILES, { recursive: true });

const restoreEnv = (
  key: "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR" | "CODEX_HOME",
  was: string | undefined,
) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restoreEnv("HOME", prevHome);
  restoreEnv("USERPROFILE", prevUserProfile);
  restoreEnv("CLAUDE_CONFIG_DIR", prevConfigDir);
  restoreEnv("CODEX_HOME", prevCodexHome);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

/** What the user keeps in their dotfiles repo, and must still have afterwards. */
const REPO_SETTINGS = JSON.stringify({
  model: "opus",
  env: { MY_VAR: "from-dotfiles" },
}, null, 2) + "\n";

/** The deck's own retired sound entry, as one on a real machine is shaped. */
const OUR_SOUND_ENTRY = {
  "__agent-dag-sound": true,
  hooks: [{ type: "command", command: `"${process.execPath}" "${NOTIFY_PATH}"`, timeout: 5 }],
};

const isLink = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true;
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const temps = (dir: string) => readdirSync(dir).filter(n => n.includes(".tmp"));

/** settings.json as a link into the dotfiles repo, the state this issue is about. */
function linkSettingsIntoDotfiles(content = REPO_SETTINGS) {
  rmSync(SETTINGS, { force: true });
  writeFileSync(REPO_COPY, content, "utf8");
  symlinkSync(REPO_COPY, SETTINGS);
}

// ── the link, end to end ─────────────────────────────────────────────────────

describe.skipIf(process.platform === "win32")("a symlinked settings.json stays a symlink", () => {
  beforeEach(() => {
    rmSync(PARKED_PATH, { force: true });
    linkSettingsIntoDotfiles();
  });

  it("takes installHooks' entries through the link into the dotfiles copy", async () => {
    // The one that runs on EVERY launch, which is what made this quiet: a user
    // who never opens the deck's settings UI still had their link replaced the
    // first time they started it.
    chmodSync(REPO_COPY, 0o600);

    const res = await installHooks({ provider: "claude" });
    expect(res.changed).toBe(true);

    expect(isLink(SETTINGS), "settings.json was replaced by a regular file").toBe(true);
    expect(realpathSync.native(SETTINGS)).toBe(REPO_COPY);

    // The hooks reached the file the user's repo tracks, and what was already in
    // it is still there — a write through the link, not a write beside it.
    const written = json(REPO_COPY);
    expect(written.hooks.SessionStart).toHaveLength(1);
    expect(written.env.MY_VAR).toBe("from-dotfiles");
    expect(written.model).toBe("opus");

    // The mode carried over onto the real file, not onto a fresh one in ~/.claude.
    expect(statSync(REPO_COPY).mode & 0o777).toBe(0o600);

    // And the temp file was staged beside the target it landed on, then cleaned
    // up — nothing left in either directory.
    expect(temps(DOTFILES)).toEqual([]);
    expect(temps(CLAUDE_DIR)).toEqual([]);
  });

  it("takes uninstallHooks' removal through the link as well", async () => {
    await installHooks({ provider: "claude" });
    const res = await uninstallHooks({ provider: "claude" });

    expect(res).toMatchObject({ ok: true, changed: true });
    expect(isLink(SETTINGS)).toBe(true);
    expect(realpathSync.native(SETTINGS)).toBe(REPO_COPY);
    // The uninstall has to reach the tracked copy too. Removing our hooks from a
    // detached file leaves them in the repo, to be re-applied by the next sync.
    expect(readFileSync(REPO_COPY, "utf8")).not.toContain("__agent-dag");
    expect(json(REPO_COPY).env.MY_VAR).toBe("from-dotfiles");
  });

  it("takes the retired sound hook out through the link too", async () => {
    // The writer that runs on an upgrade, unasked, on a machine whose owner has
    // never opened the deck's UI — which is exactly the shape #673 is about. A
    // detached copy here would silently stop tracking the file the user's repo
    // syncs, and the next sync would put the retired entry straight back.
    linkSettingsIntoDotfiles(JSON.stringify({
      env: { MY_VAR: "from-dotfiles" },
      hooks: { Stop: [OUR_SOUND_ENTRY] },
    }, null, 2) + "\n");

    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, removed: 1 });
    expect(isLink(SETTINGS), "retireSoundHook replaced the link").toBe(true);
    expect(realpathSync.native(SETTINGS)).toBe(REPO_COPY);
    expect(readFileSync(REPO_COPY, "utf8")).not.toContain("__agent-dag-sound");
    expect(json(REPO_COPY).env.MY_VAR).toBe("from-dotfiles");
  });

  it("keeps the link when the parked hooks are handed back", async () => {
    // The payload that is the user's own hand-written hooks, and the last time
    // anything will ever be in a position to hand them back: restoring them into
    // a detached file is losing them from the file that is actually read.
    linkSettingsIntoDotfiles(JSON.stringify({
      env: { MY_VAR: "from-dotfiles" },
      hooks: { Stop: [OUR_SOUND_ENTRY] },
    }, null, 2) + "\n");
    mkdirSync(dirname(String(PARKED_PATH)), { recursive: true });
    writeFileSync(String(PARKED_PATH), JSON.stringify([{
      hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff || true" }],
    }], null, 2) + "\n", "utf8");

    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, restored: 1 });
    expect(isLink(SETTINGS), "the restore replaced the link").toBe(true);
    expect(readFileSync(REPO_COPY, "utf8")).toContain("afplay");
  });

  it("follows a dangling link to the file it names instead of replacing it", async () => {
    // The case a bare realpath cannot answer, and the one where answering it
    // with the raw path is the original bug: realpath fails on a link whose
    // target does not exist, so falling back to the name renames onto the link.
    // A dotfiles repo before its first `chezmoi apply`, or an encrypted volume
    // not yet unlocked, is exactly this state — and `printf x > link` creates the
    // target rather than eating the link, which is the behaviour to match.
    const notYet = join(DOTFILES, "not-yet.json");
    rmSync(notYet, { force: true });
    rmSync(SETTINGS, { force: true });
    symlinkSync(notYet, SETTINGS);

    await installHooks({ provider: "claude" });

    expect(isLink(SETTINGS)).toBe(true);
    expect(existsSync(notYet), "the link's target was never created").toBe(true);
    expect(json(notYet).hooks.SessionStart).toHaveLength(1);

    // A CHAIN of them, dangling at the far end, is why the walk is a loop and
    // not one readlink: stow pointing at a chezmoi target is two hops.
    const alsoNotYet = join(DOTFILES, "also-not-yet.json");
    const hop = join(DOTFILES, "hop.json");
    rmSync(alsoNotYet, { force: true });
    rmSync(hop, { force: true });
    rmSync(SETTINGS, { force: true });
    symlinkSync(alsoNotYet, hop);
    symlinkSync(hop, SETTINGS);

    await installHooks({ provider: "claude" });

    expect(isLink(SETTINGS), "the near link was replaced").toBe(true);
    expect(isLink(hop), "the far link was replaced").toBe(true);
    expect(json(alsoNotYet).hooks.SessionStart).toHaveLength(1);
  });

  it("fails the write rather than eating a link whose directory is gone", async () => {
    // An unmounted encrypted volume. Staging beside the LINK and renaming used
    // to make this "succeed" — which is the bug at its worst, because the write
    // the user believes happened is sitting in a file nothing reads. There is
    // nowhere for these bytes to go, and saying so is the only honest answer.
    rmSync(SETTINGS, { force: true });
    symlinkSync(join(FAKE_HOME, "not-mounted", "settings.json"), SETTINGS);

    await expect(installHooks({ provider: "claude" })).rejects.toMatchObject({ code: "ENOENT" });
    expect(isLink(SETTINGS)).toBe(true);
  });

  it("refuses a cycle rather than picking one of its links to destroy", async () => {
    const a = join(DOTFILES, "cycle-a.json");
    const b = join(DOTFILES, "cycle-b.json");
    rmSync(a, { force: true });
    rmSync(b, { force: true });
    symlinkSync(b, a);
    symlinkSync(a, b);

    await expect(writeFileAtomic(a, "{}\n")).rejects.toMatchObject({ code: "ELOOP" });
    expect(isLink(a)).toBe(true);
    expect(isLink(b)).toBe(true);
  });
});

// ── the resolver, on every leg ───────────────────────────────────────────────

// Everything below runs on Windows too, and deliberately: a directory junction
// is a reparse point the OS creates without a privilege, so the resolver's
// behaviour against a real reparse point is checkable on the leg where file
// symlinks are not. The last case is the one that would catch a revert there —
// the block above cannot, because it does not run.
describe("resolveWriteTarget answers with the file the name really means", () => {
  const REAL_DIR = join(FAKE_HOME, "resolver", "real");
  const LINK_DIR = join(FAKE_HOME, "resolver", "link");
  mkdirSync(REAL_DIR, { recursive: true });
  // "junction" is what Windows needs and what POSIX ignores, which is how
  // workspace-one-meaning.test.ts and codex-home-one-reader.test.ts already
  // build a link that exists on all three platforms.
  if (!existsSync(LINK_DIR)) symlinkSync(REAL_DIR, LINK_DIR, "junction");

  it("hands back a plain file's own path, which is the common case", async () => {
    const plain = join(REAL_DIR, "plain.json");
    writeFileSync(plain, "{}\n", "utf8");
    expect(await resolveWriteTarget(plain)).toBe(realpathSync.native(plain));
  });

  it("hands back a name nothing exists at, so a first install writes where it was asked to", async () => {
    const fresh = join(REAL_DIR, "never-created.json");
    rmSync(fresh, { force: true });
    expect(await resolveWriteTarget(fresh)).toBe(fresh);
  });

  it("resolves a reparse point on the path — a junction here, a dotfiles link in the field", async () => {
    const through = join(LINK_DIR, "through.json");
    writeFileSync(through, "{}\n", "utf8");
    expect(await resolveWriteTarget(through)).toBe(join(realpathSync.native(REAL_DIR), "through.json"));
  });

  it("stages and renames on the resolved side, leaving the reparse point alone", async () => {
    // The half of the fix that is not about symlinks at all: rename is atomic
    // within one filesystem and fails with EXDEV across two, so the temp file
    // has to be created on the TARGET's filesystem. A dotfiles repo on its own
    // volume is precisely that case, and this is the nearest a portable test
    // gets to it — the write goes through the reparse point and lands, and the
    // junction is still a junction afterwards.
    const through = join(LINK_DIR, "written.json");
    rmSync(through, { force: true });

    await writeFileAtomic(through, '{"written":true}\n');

    expect(json(join(REAL_DIR, "written.json")).written).toBe(true);
    expect(realpathSync.native(LINK_DIR), "the reparse point did not survive the write")
      .toBe(realpathSync.native(REAL_DIR));
    expect(temps(REAL_DIR)).toEqual([]);
  });

  it("is what writeFileAtomic stages against, and what persistAuth resolves with", () => {
    // The assertion that has teeth on the leg where the block above is skipped.
    // Reverting the fix — staging against the raw name again — is invisible to
    // every other case on Windows, because a junction resolves to the same
    // directory it is reached through and a file symlink cannot be made there.
    // This reads the shipped source and says the rule out loud instead.
    const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    // Comments stripped first: this repo's prose quotes the code it is about, and
    // a search over raw source would find the paragraph explaining the rule and
    // conclude the rule was followed.
    const body = (text: string, decl: string) => {
      const at = text.indexOf(decl);
      expect(at, `${decl} is not in the source any more`).toBeGreaterThan(-1);
      const end = text.indexOf("\n}", at);
      return text.slice(at, end === -1 ? undefined : end)
        .split("\n").filter(l => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join("\n");
    };

    const write = body(src("../../server/installer.mjs"), "async function writeFileAtomic(");
    expect(write, "writeFileAtomic does not resolve its target").toContain("resolveWriteTarget(");
    expect(write.indexOf("resolveWriteTarget("), "writeFileAtomic stages before it resolves")
      .toBeLessThan(write.indexOf("createTemp("));
    expect(write, "the temp file is staged against the raw name again").toMatch(/createTemp\(target\b/);
    expect(write, "the raw name is still what something is written against")
      .not.toMatch(/(?:createTemp|renameWithRetry|stat)\([^)]*rawTarget/);

    // codex-auth had this rule first, spelled as its own realpath. It is the
    // same function now, so the two cannot drift apart — and a revert to a bare
    // realpath there would take the dangling-link case with it.
    const persist = body(src("../../server/codex-auth.mjs"), "async function persistAuth(");
    expect(persist, "persistAuth no longer resolves through the shared rule")
      .toContain("resolveWriteTarget(AUTH_PATH)");
  });
});
