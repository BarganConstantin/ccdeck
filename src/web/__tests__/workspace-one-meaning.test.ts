// Reported: `--workspace` meant two different things depending on which CLI
// produced the session. The hook sorted the decks whose workspace matched by how
// long that path was and delivered only to the longest — so a deck scoped to
// /Users/x/proj TOOK that tree's Claude sessions away from a machine-wide deck,
// which sat there empty while `--all` promised it captured every session on the
// machine. The Codex path had no such narrowing: every deck tails the rollout
// files itself and evaluates its own workspace, so a Codex session in the same
// directory appeared on both decks. One flag, one directory, opposite answers.
//
// Two smaller halves of the same flag were wrong with it. A relative
// `--workspace ./sub` went into the discovery file raw and was resolved inside
// the hook's process — which the host CLI runs with the AGENT's cwd — so Claude
// sessions were scoped to a different directory per agent, and none of them the
// one the user meant. And case was folded on every platform on the Codex side
// only, so on Linux a deck scoped to /srv/proj drew Codex sessions out of
// /srv/Proj and Claude sessions out of neither.
//
// The meaning kept is the documented one, and it is a property of ONE deck:
// a deck captures a session when the session's cwd is inside its workspace, and
// what any other deck is scoped to changes nothing. So the table below is walked
// through both implementations of it — hook.js's capturesSession and the
// server's codexCwdInWorkspace — and every row has one expected answer, because
// two answers is the bug.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rmTempDir } from "./rm-temp-dir";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Everything the modules below read at import time is pointed inside a temp
// tree, so nothing here can reach — or be answered by — the developer's own
// ~/.claude or ~/.codex. $HOME and %USERPROFILE% together cover POSIX and
// Windows.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-workspace-"));
const FAKE_HOME = join(SANDBOX, "home");
const FAKE_CONFIG = join(SANDBOX, "claude-config");
const FAKE_CODEX = join(SANDBOX, "codex-home");
for (const d of [FAKE_HOME, FAKE_CONFIG, FAKE_CODEX]) mkdirSync(d, { recursive: true });

const prevEnv: Record<string, string | undefined> = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CONFIG;
process.env.CODEX_HOME = FAKE_CODEX;

// @ts-expect-error — .mjs server module, no types
const { canonicalWorkspace, canonicalCwd, startCodexWatcher, eventsSince } = await import("../../server/index.mjs");
// @ts-expect-error — .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — .mjs server module, no types
const { codexCwdInWorkspace } = await import("../../server/log-writer.mjs");

// Refuse to run at all if the sandbox did not take, rather than assert against
// a developer's real configuration.
if (!String(claudeConfigDir()).startsWith(SANDBOX)) {
  throw new Error(`refusing to run: claude config dir resolved to ${claudeConfigDir()}, outside ${SANDBOX}`);
}

// hook.js is CommonJS inside a "type": "module" package, so it only loads as
// itself once outside that tree — which is also the only way it ever runs, the
// installer having copied it into the Claude config dir. Requiring the copy
// exports the rules and starts nothing: main() is behind require.main.
const HOOK_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
const HOOK_COPY = join(SANDBOX, "hook.cjs");
copyFileSync(HOOK_SRC, HOOK_COPY);
const hook = createRequire(import.meta.url)(HOOK_COPY) as {
  capturesSession: (cwd: string | null, workspace: string, platform?: string) => boolean;
  normPath: (p: string) => string;
};

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(SANDBOX);
});

// ── the one rule, walked through both implementations of it ──────────────────

// hook.js is copied out of the package and run standalone, so it cannot import
// the server's copy of this rule and keeps its own — exactly as it does for the
// writer election. A disagreement between the two is not a style problem: it is
// the same `--workspace` capturing one set of sessions from Claude Code and a
// different set from Codex, which is what this file exists to make impossible to
// reach by accident.
type Row = [name: string, cwd: string | null, workspace: string, platform: string, want: boolean];

const TABLE: Row[] = [
  // The default. Nothing is excluded, including a session that never said where
  // it runs — Codex rollouts can omit cwd, and an unscoped deck is the only kind
  // that can honestly claim one.
  ["an unscoped deck captures everything", "/srv/proj", "", "linux", true],
  ["an unscoped deck captures a session with no cwd", null, "", "linux", true],
  ["a scoped deck captures no session with no cwd", null, "/srv", "linux", false],

  // The subtree rule itself.
  ["the workspace directory is inside itself", "/srv/proj", "/srv/proj", "linux", true],
  ["a directory below it is inside it", "/srv/proj/sub/deeper", "/srv/proj", "linux", true],
  ["a sibling sharing a prefix is not", "/srv/project-two", "/srv/proj", "linux", false],
  ["an unrelated tree is not", "/opt/other", "/srv/proj", "linux", false],
  ["the parent of the workspace is not", "/srv", "/srv/proj", "linux", false],

  // Spelling of the workspace itself: a trailing separator is the same
  // directory, and a root already ends in one.
  ["a trailing separator changes nothing", "/srv/proj/sub", "/srv/proj/", "linux", true],
  ["the filesystem root contains everything", "/srv/proj", "/", "linux", true],

  // Case. Linux keeps /srv/Proj and /srv/proj apart because they are two real
  // directories there, and a deck scoped to one must not be handed the other's
  // sessions.
  ["Linux keeps two spellings apart", "/srv/Proj/sub", "/srv/proj", "linux", false],
  ["Linux keeps the directory itself apart too", "/srv/Proj", "/srv/proj", "linux", false],
  // macOS folds, because APFS and HFS+ are case-insensitive unless deliberately
  // formatted otherwise.
  ["macOS folds case, as its filesystem does", "/Users/john/Proj/sub", "/Users/John/proj", "darwin", true],
  ["macOS still rejects a different tree", "/Users/john/other", "/Users/john/proj", "darwin", false],

  // Windows is its own answer, not a POSIX fallback: backslashes, drive letters,
  // and a filesystem that folds case everywhere.
  ["Windows folds a drive letter spelled the other way", "c:\\proj\\sub", "C:\\proj", "win32", true],
  ["Windows folds every other component too", "C:\\Users\\John\\proj\\sub", "C:\\users\\john\\proj", "win32", true],
  ["Windows rejects a sibling sharing a prefix", "C:\\project-two", "C:\\proj", "win32", false],
  ["Windows rejects another drive entirely", "D:\\other\\sub", "C:\\proj", "win32", false],
  ["Windows accepts forward slashes and a trailing one", "C:/proj/sub", "C:\\proj\\", "win32", true],
  ["a drive root contains everything on it", "C:\\proj\\sub", "c:\\", "win32", true],
];

describe("what --workspace means", () => {
  for (const [name, cwd, workspace, platform, want] of TABLE) {
    it(`${name} (${platform})`, () => {
      expect(hook.capturesSession(cwd, workspace, platform), "the Claude hook's answer").toBe(want);
      expect(codexCwdInWorkspace(cwd, workspace, platform), "the Codex watcher's answer").toBe(want);
    });
  }
});

// The demonstration in the report, as a decision each deck makes about itself:
// one machine-wide deck on 4317, one scoped deck on 4318, one session inside the
// scoped tree. Both decks capture it — on both paths. The Claude half used to
// answer [4318] alone.
describe("which decks a session inside a scoped tree reaches", () => {
  const decks = [
    { port: 4317, workspace: "" },
    { port: 4318, workspace: "/Users/x/proj" },
    { port: 4319, workspace: "/Users/x/other" },
  ];
  const reached = (decide: (cwd: string, ws: string) => boolean) =>
    decks.filter(d => decide("/Users/x/proj/sub", d.workspace)).map(d => d.port);

  it("reaches the machine-wide deck and the scoped one, on both paths", () => {
    const claude = reached((cwd, ws) => hook.capturesSession(cwd, ws, "linux"));
    const codex = reached((cwd, ws) => codexCwdInWorkspace(cwd, ws, "linux"));
    expect(claude).toEqual([4317, 4318]);
    expect(codex).toEqual(claude);
  });
});

// ── the path the user typed ──────────────────────────────────────────────────

describe("the canonical spelling of the flag", () => {
  it("leaves an unscoped deck unscoped, whitespace and all", () => {
    // Every reader of this value spells machine-wide as the empty string, and
    // resolve(" ") is a real directory name — a deck that asked for no scope
    // must not come back scoped to one.
    expect(canonicalWorkspace("")).toBe("");
    expect(canonicalWorkspace("   ")).toBe("");
    expect(canonicalWorkspace(undefined)).toBe("");
    expect(canonicalWorkspace(null)).toBe("");
  });

  it("resolves a relative path against the process the flag was typed in", () => {
    // The whole point of resolving it here: this is the only process whose cwd
    // is the shell the user ran the deck from. The hook's is the agent's.
    const relative = "ccdeck-relative-workspace-that-does-not-exist";
    expect(canonicalWorkspace(relative)).toBe(join(process.cwd(), relative));
    expect(canonicalWorkspace(join(".", relative))).toBe(join(process.cwd(), relative));
  });

  it("drops a trailing separator, so one directory has one spelling", () => {
    const dir = join(SANDBOX, "trailing");
    mkdirSync(dir, { recursive: true });
    expect(canonicalWorkspace(dir + sep)).toBe(realpathSync.native(dir));
  });

  it("resolves symlinks, so a workspace reached through one is not a tree of its own", async () => {
    // On a Mac /tmp is a symlink to /private/tmp, so a workspace left unresolved
    // matches nothing that runs inside it.
    const real = join(SANDBOX, "real-tree");
    mkdirSync(join(real, "proj"), { recursive: true });
    const link = join(SANDBOX, "linked-tree");
    // "junction" is the one directory link Windows creates without elevation;
    // POSIX ignores the type argument entirely.
    symlinkSync(real, link, "junction");

    const viaLink = canonicalWorkspace(join(link, "proj"));
    expect(viaLink).toBe(realpathSync.native(join(real, "proj")));

    // And the session running inside it is captured on both paths — fed the cwd
    // its own caller feeds it, which is the LINK spelling. This assertion used
    // to hand both predicates `realpathSync(join(real, "proj"))`, and that is
    // precisely the input Windows never supplies: GetCurrentDirectoryW returns
    // the string the directory was set with, junction and all. Pre-resolving it
    // here made the test a check on the predicates, which were never the half
    // that was wrong, and passed on a platform where the code failed. See
    // "the cwd each capture path compares" below.
    const asReported = join(link, "proj");
    expect(hook.capturesSession(hook.normPath(asReported), viaLink)).toBe(true);
    expect(codexCwdInWorkspace(await canonicalCwd(asReported), viaLink)).toBe(true);
  });

  it("keeps a directory that does not exist yet", () => {
    // Scoping a deck to a tree you are about to create is not an error, and the
    // resolved form is still the right thing to compare against.
    const missing = join(SANDBOX, "not-created", "sub");
    expect(canonicalWorkspace(missing)).toBe(missing);
  });

  it("is idempotent, so a second pass over it changes nothing", () => {
    const once = canonicalWorkspace(join(SANDBOX, "real-tree"));
    expect(canonicalWorkspace(once)).toBe(once);
  });
});

// ── one realpath, at all three sites ─────────────────────────────────────────

// Three functions canonicalise a path in this product and every one of them is
// compared against the other two: canonicalWorkspace for the flag, normPath in
// hook.js for a Claude session's cwd, canonicalCwd for a Codex rollout's. They
// have to fold identically or the mismatch has merely moved.
//
// Node ships TWO realpaths and they do not fold identically on Windows.
// fs.realpathSync / fs.realpath are a JavaScript lstat-and-readlink walk:
// symlinks and junctions, nothing else. fs.realpathSync.native, fs.realpath
// .native and the fs/promises realpath are uv_fs_realpath — on Windows
// GetFinalPathNameByHandleW, which ALSO expands a DOS 8.3 short component to its
// long form. Two of the three sites called the first and one called the second,
// so the moment a path arrived short they disagreed by a whole path:
// C:\Users\RUNNER~1\AppData\Local\Temp\… against C:\Users\runneradmin\….
//
// That is not a runner artefact. %TEMP% is the short spelling for any Windows
// user whose profile directory is shortened, and it is what os.tmpdir() answers
// with there — which is exactly why the first probe below is the temp directory
// the environment hands us rather than a path this file built.
describe("one realpath, at all three sites", () => {
  const realpathed = join(SANDBOX, "one-realpath", "real");
  const linked = join(SANDBOX, "one-realpath", "link");
  mkdirSync(join(realpathed, "proj", "sub"), { recursive: true });
  symlinkSync(realpathed, linked, "junction");

  it("gives the flag and both cwd paths one spelling, 8.3 short names included", async () => {
    // The long form is the canonical one: short names alias the same directory
    // exactly as a junction does, and they cannot be derived back from the long
    // form at all, since 8.3 generation can be turned off per volume. It is also
    // already this codebase's answer — persistAuth in src/server/codex-auth.mjs
    // resolves through the fs/promises realpath, i.e. the native one.
    //
    // The wrong-case probe is what makes this case fail on a Mac as well as on
    // Windows, so the rule is not left resting on the one platform nobody
    // develops on. The two realpaths differ in a second way: the native one
    // returns each component's ON-DISK case and the JavaScript walk returns
    // whatever it was handed, so on a case-insensitive volume — APFS, NTFS —
    // a path spelled in the wrong case tells them apart. Linux is case-SENSITIVE,
    // and there that spelling is not the directory at all: it is a path that
    // does not exist, and realpath says ENOENT. So the probe asserts the other
    // half of the same rule there — all three sites keep the resolved form when
    // realpath cannot answer — which is why `want` is computed with that
    // fallback rather than by calling realpath bare. Asking realpath bare is
    // what made this case fail its own setup on ubuntu, three lines before it
    // asserted anything.
    //
    // The last probe pins that half on every platform, this one included, so the
    // fallback is not a branch only one runner ever takes.
    const oneSpelling = (p: string) => {
      try { return realpathSync.native(p); } catch { return resolve(p); }
    };
    for (const p of [
      tmpdir(),                                 // whatever the ENVIRONMENT hands us
      SANDBOX,                                  // an mkdtemp under it, so short there too
      join(linked, "proj"),                     // through a link
      join(linked, "proj", "sub"),
      realpathed,
      join(SANDBOX, "ONE-REALPATH", "REAL"),    // the wrong case for a real directory
      join(SANDBOX, "one-realpath", "never-created"),
    ]) {
      const want = oneSpelling(p);
      expect(canonicalWorkspace(p), `canonicalWorkspace on ${p}`).toBe(want);
      expect(await canonicalCwd(p), `canonicalCwd on ${p}`).toBe(want);
      expect(hook.normPath(p), `hook.normPath on ${p}`).toBe(want);
    }
  });

  it("names .native at every site, which is the only platform-independent way to say it", () => {
    // The behaviour above is only observable where the two realpaths differ,
    // and that is Windows alone — so on the two platforms most of this is
    // developed on, a site quietly reverting to the JavaScript walk goes
    // unnoticed until CI. This says the rule itself, on every platform.
    //
    // It also pins the half that caused this: `realpath` imported from
    // fs/promises IS the native one, an equivalence nothing documents, so a site
    // spelled that way is right by accident and reads as if it were the plain
    // one. Every realpath in these two files names .native out loud.
    const sources: Array<[string, string]> = [
      ["hook/hook.js", readFileSync(HOOK_SRC, "utf8")],
      ["src/server/index.mjs", readFileSync(fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8")],
    ];
    for (const [name, src] of sources) {
      const code = src.split("\n").filter(l => {
        const t = l.trimStart();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      }).join("\n");
      expect(code.match(/\brealpath(Sync)?\s*\(/g) ?? [], `${name} calls a realpath that does not name .native`).toEqual([]);
      expect(code.match(/\brealpath\w*\.native\b/g) ?? [], `${name} canonicalises through no native realpath at all`)
        .not.toHaveLength(0);
    }
  });
});

// ── the cwd each capture path compares ───────────────────────────────────────

// Canonicalising the flag is half a rule. It means nothing unless the cwd it is
// compared against is canonicalised the same way, and that is a separate job on
// each capture path: the two predicates above are pure string functions and
// neither of them touches the disk. hook.js runs every cwd through normPath
// before asking capturesSession. The rollout watcher had no equivalent — it
// handed codexCwdInWorkspace the `cwd` out of the rollout header, raw — and the
// comment on canonicalWorkspace said that was safe because a cwd comes from
// getcwd(), which has already resolved every link.
//
// True of getcwd(3), not true of Windows. There the current directory is stored
// as the string it was set with, and GetCurrentDirectoryW — what Rust's
// std::env::current_dir() behind Codex calls — returns that string without
// resolving a junction, a `subst` drive or a mapped network drive. So on a
// workspace reached that way, `ccdeck --workspace Z:\proj` scoped itself to
// \\server\share\proj, drew the Claude sessions in that tree (the hook having
// realpath'd their cwd), and silently drew no Codex ones at all — no error
// anywhere, the banner still claiming the rollout watcher was running.
//
// A POSIX symlink is none of those three mechanisms, but it produces the one
// input that matters — a cwd naming the workspace by a spelling realpath does
// not agree with — so everything here runs on every platform rather than
// skipping off Windows, which is where the defect actually lives.
describe("the cwd each capture path compares", () => {
  const real = join(SANDBOX, "reported-cwd", "real");
  const proj = join(real, "proj");
  const link = join(SANDBOX, "reported-cwd", "link");
  mkdirSync(join(proj, "sub"), { recursive: true });
  symlinkSync(real, link, "junction");

  it("canonicalises a path the same way on both capture paths", async () => {
    // hook.js keeps its own copy of this rule, as it does of the predicate, for
    // the same reason: the host CLI copies that file out of the package and runs
    // it standalone, so it cannot import the server's. Two copies that disagree
    // are `--workspace` meaning two things again, one step earlier.
    for (const p of [
      join(link, "proj"),                        // through the link
      join(link, "proj", "sub"),                 // deeper through the link
      proj,                                      // already canonical
      join(proj, "sub") + sep,                   // trailing separator
      join(proj, "..", "proj", "sub"),           // needs resolving, not just realpath
      join(SANDBOX, "reported-cwd", "deleted"),  // never existed
    ]) {
      expect(await canonicalCwd(p), `canonicalCwd disagrees with hook.normPath on ${p}`)
        .toBe(hook.normPath(p));
    }
  });

  it("captures a session reporting the link spelling of a workspace typed the same way", async () => {
    // `ccdeck --workspace <link>/proj`, and both CLIs report <link>/proj.
    const workspace = canonicalWorkspace(join(link, "proj"));
    const reported = join(link, "proj", "sub");
    expect(hook.capturesSession(hook.normPath(reported), workspace), "the Claude hook's answer").toBe(true);
    expect(codexCwdInWorkspace(await canonicalCwd(reported), workspace), "the Codex watcher's answer").toBe(true);
  });

  it("captures it the other way round, the flag resolved and the session not", async () => {
    // The reverse the report calls out: the user passes the resolved path and
    // works through the link. Same defect, opposite spellings.
    const workspace = canonicalWorkspace(proj);
    const reported = join(link, "proj", "sub");
    expect(hook.capturesSession(hook.normPath(reported), workspace), "the Claude hook's answer").toBe(true);
    expect(codexCwdInWorkspace(await canonicalCwd(reported), workspace), "the Codex watcher's answer").toBe(true);
  });

  it("keeps the resolved spelling of a directory that is gone, and still compares it", async () => {
    // A rollout records where it ran and is read later; by then the directory
    // can have been deleted, or sit on a network drive that is no longer
    // connected — the very kind of drive this exists for. realpath throws on
    // both, and the answer is the flag's own: keep the resolved form. Never
    // throw (readCodexHeader would return null and the watcher would retry the
    // same file every 1.5s forever) and never drop the session, which for a
    // rollout recorded in the scoped tree and never moved would be wrong.
    const workspace = canonicalWorkspace(join(link, "proj"));
    const gone = join(realpathSync.native(proj), "deleted-since");
    expect(await canonicalCwd(gone)).toBe(gone);
    expect(await canonicalCwd(gone)).toBe(hook.normPath(gone));
    expect(codexCwdInWorkspace(await canonicalCwd(gone), workspace), "a deleted subdirectory of the workspace").toBe(true);

    // Still only compared, never assumed in: a directory that is missing AND
    // outside the workspace stays outside it.
    const elsewhere = join(SANDBOX, "reported-cwd", "not-the-workspace", "gone");
    expect(codexCwdInWorkspace(await canonicalCwd(elsewhere), workspace)).toBe(false);

    // The limit of that fallback, pinned rather than papered over: a path is
    // only canonical if it resolves, so one that is BOTH unresolvable and
    // spelled through a link is compared in a spelling the workspace does not
    // share, and misses. Nothing can do better — the link target is exactly what
    // is unreachable. It costs nothing on POSIX, where the recorded cwd came
    // from getcwd() and is already canonical whether or not it still exists (the
    // assertion above), and on Windows it needs a junction or mapped drive whose
    // target is gone, which is a session that has already ended.
    expect(codexCwdInWorkspace(await canonicalCwd(join(link, "proj", "deleted-since")), workspace)).toBe(false);
  });

  it("says nothing about a rollout that never said where it ran", async () => {
    // readCodexHeader's contract before canonicalCwd was in front of it: a
    // header with no usable cwd yields null, which both copies of the predicate
    // read as "inside no workspace, so only an unscoped deck sees it". A blank
    // string must not survive as one either — path.resolve("") is the SERVER's
    // own cwd, which would scope the rollout to wherever the deck was started.
    for (const raw of [null, undefined, "", "   ", 42, {}]) {
      expect(await canonicalCwd(raw), `canonicalCwd(${JSON.stringify(raw)})`).toBe(null);
    }
    expect(codexCwdInWorkspace(await canonicalCwd(""), canonicalWorkspace(proj))).toBe(false);
    expect(codexCwdInWorkspace(await canonicalCwd(""), "")).toBe(true);
  });

  it("draws a real rollout whose header names the workspace through the link", async () => {
    // End to end, through the watcher itself: the unit assertions above prove
    // canonicalCwd answers correctly, this proves the watcher actually calls it.
    // Before the fix this rollout was filed as skip:true on its first tick and
    // never produced an event.
    const sid = "0f3c1e7a-6100-4000-8000-0123456789ab";
    const day = join(FAKE_CODEX, "sessions", "2031", "01", "02");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2031-01-02T10-00-00-${sid}.jsonl`);
    // The cwd Windows reports for a session started in the link's tree: the
    // spelling the directory was set with, junction unresolved.
    const header = JSON.stringify({ type: "session_meta", payload: { id: sid, cwd: join(link, "proj") } }) + "\n";
    const prompt = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello from behind the link" } }) + "\n";

    const timer = startCodexWatcher(canonicalWorkspace(join(link, "proj")));
    try {
      writeFileSync(rollout, header, "utf8");

      // The prompt is appended in the loop rather than written once, and that is
      // about determinism, not impatience. The watcher's first scan skips the
      // history of everything already on disk — root and all — so a rollout
      // written in full before that scan gets CPU produces no event at all,
      // whatever the workspace test said. Only bytes appended AFTER the file is
      // catalogued are replayed. A fixed pause before writing would be a bet on
      // how quickly the first scan is scheduled, and vitest runs this file
      // beside 245 others; appending each time round means whichever pass first
      // lands after the catalogue is the one that draws, and none of it depends
      // on the order the first two happen in.
      const deadline = Date.now() + 15_000;
      let drawn: Array<Record<string, unknown>> = [];
      for (;;) {
        appendFileSync(rollout, prompt, "utf8");
        await new Promise(r => setTimeout(r, 250));
        drawn = (eventsSince(0) as Array<{ source: string; payload: Record<string, unknown> }>)
          .filter(e => e.source === "codex" && e.payload?.session_id === sid)
          .map(e => e.payload);
        if (drawn.some(p => p.hook_event_name === "UserPromptSubmit") || Date.now() >= deadline) break;
      }

      expect(drawn.map(p => p.hook_event_name), "the Codex session in the junction-reached workspace never reached the deck")
        .toContain("UserPromptSubmit");
      // And it is filed under the same spelling the deck's own workspace has, so
      // the log election — which models the other decks with this same predicate
      // against their published, canonical workspaces — puts it in the right
      // group too.
      //
      // Read off the prompt rather than off a leading `SessionStart` (#684).
      // That event is now minted only for a rollout the watcher opened at byte
      // 0, and whether this one existed before the startup catalogue ran is
      // exactly the race the loop above is written to tolerate — so the root
      // event is sometimes there and sometimes not, while the canonical cwd
      // this case is about rides on every payload either way.
      expect(drawn.find(p => p.hook_event_name === "UserPromptSubmit"))
        .toMatchObject({ cwd: realpathSync.native(proj), provider: "codex" });
    } finally {
      clearInterval(timer);
    }
  }, 20_000);
});

// bin/deck.js boots a server and refuses to start without a built UI, so it
// cannot be run from here; what is checkable — and what the bug actually was —
// is whether the flag reaches the discovery file as the user typed it or as the
// one spelling both capture paths compare against.
describe("the flag as bin/deck.js publishes it", () => {
  const deck = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
  const code = deck.split("\n").filter(l => !l.trimStart().startsWith("//"));

  it("hands startServer and the discovery file the canonical path", () => {
    expect(code.some(l => /const workspace = canonicalWorkspace\(/.test(l))).toBe(true);
  });

  it("never binds the raw flag to the name the rest of the file uses", () => {
    // The exact shape that shipped: `const workspace = flags.workspace ...`,
    // which put a relative path into the discovery file for the hook to resolve
    // in the wrong process.
    expect(code.filter(l => /const workspace\b/.test(l) && /flags\./.test(l))).toEqual([]);
  });
});

// ── the whole thing, running ─────────────────────────────────────────────────

type Seen = { method: string; path: string; body: string };

/** The token every deck in this file advertises, and the proof it can give.
 *
 *  Not optional any more: the hook challenges every target it is about to post
 *  to, and a listener that cannot answer receives nothing. The proof is the
 *  same sha256 the deck computes — `${token}:${nonce}` — which is the whole of
 *  the handshake; hook-handshake.test.ts owns the rest of it. */
const DECK_TOKEN = "0".repeat(64);
const proofFor = (nonce: string) =>
  createHash("sha256").update(`${DECK_TOKEN}:${nonce}`).digest("hex");

/** A listener standing in for a deck, plus a log of everything it was told. */
async function deckListener() {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const entry: Seen = { method: req.method ?? "", path: req.url ?? "", body: "" };
    seen.push(entry);
    req.on("data", c => { entry.body += c; });
    req.on("error", () => {});
    res.on("error", () => {});
    req.on("end", () => {
      const url = new URL(entry.path, "http://127.0.0.1");
      if (url.pathname === "/api/hook-challenge") {
        const nonce = url.searchParams.get("nonce") ?? "";
        return res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ proof: proofFor(nonce) }));
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  return { seen, port, close };
}

/** Run the installed-shape hook against a discovery dir of our own. */
async function runHook(decks: Array<Record<string, unknown>>, event: Record<string, unknown>) {
  const home = mkdtempSync(join(SANDBOX, "hook-home-"));
  const dir = join(home, "agent-dag");
  mkdirSync(dir, { recursive: true });
  // Every record carries the token, because the hook challenges every target
  // now — a tokenless file used to fall back to pid liveness and that fallback
  // is retired. The listeners above answer the challenge; what is under test
  // here is still which decks are posted to at all.
  decks.forEach((d, i) => writeFileSync(
    join(dir, `deck-${i}.json`), JSON.stringify({ token: DECK_TOKEN, ...d }), "utf8"));

  const child = spawn(process.execPath, [HOOK_COPY, "--provider", "claude"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(JSON.stringify(event));
  await new Promise<void>((done, fail) => {
    child.on("error", fail);
    child.on("exit", () => done());
  });
}

describe("a Claude session inside a tree one of the running decks is scoped to", () => {
  it("is delivered to that deck AND to the machine-wide one, logged once", async () => {
    // The reported shape: two decks that both match, sharing one events log.
    // Before the fix the machine-wide deck was handed nothing at all, because
    // the scoped deck's workspace was the longer string.
    const proj = join(SANDBOX, "delivered", "proj");
    mkdirSync(join(proj, "sub"), { recursive: true });
    const log = join(SANDBOX, "delivered", "events.jsonl");

    const wide = await deckListener();
    const scoped = await deckListener();
    const elsewhere = await deckListener();
    try {
      await runHook([
        { pid: process.pid, port: wide.port, workspace: "", persist: log },
        { pid: process.pid, port: scoped.port, workspace: canonicalWorkspace(proj), persist: log },
        { pid: process.pid, port: elsewhere.port, workspace: canonicalWorkspace(join(SANDBOX, "delivered", "other")), persist: log },
      ], {
        hook_event_name: "UserPromptSubmit",
        prompt: "hello from inside the scoped tree",
        cwd: join(proj, "sub"),
      });
    } finally {
      await Promise.all([wide.close(), scoped.close(), elsewhere.close()]);
    }

    const posts = (d: { seen: Seen[] }) => d.seen.filter(s => s.method === "POST");
    expect(posts(wide), "the machine-wide deck never saw the session").toHaveLength(1);
    expect(posts(scoped), "the scoped deck never saw the session").toHaveLength(1);
    expect(posts(elsewhere), "a deck scoped elsewhere was posted to anyway").toHaveLength(0);

    // Both drew it; exactly one of them was asked to record it. The election is
    // by lowest port, and these are whatever the OS handed out.
    const writer = wide.port < scoped.port ? wide : scoped;
    const reader = wide.port < scoped.port ? scoped : wide;
    expect(posts(writer)[0].path).toBe("/api/event");
    expect(posts(reader)[0].path).toBe("/api/event?persist=0");

    // And it is the session's own event that arrived, tagged with its provider.
    expect(JSON.parse(posts(wide)[0].body)).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      prompt: "hello from inside the scoped tree",
      provider: "claude",
    });
  }, 20_000);

  it("reaches a deck scoped to it through a relative path, from the deck's own cwd", async () => {
    // `ccdeck --workspace ./proj`, started in a directory that is not the
    // agent's. The canonical form is what goes in the discovery file, so the
    // hook compares against the tree the user meant rather than resolving the
    // string a second time in the agent's process.
    const root = join(SANDBOX, "relative");
    mkdirSync(join(root, "proj", "sub"), { recursive: true });
    const asTyped = join(root, ".", "proj");

    const deck = await deckListener();
    try {
      await runHook(
        [{ pid: process.pid, port: deck.port, workspace: canonicalWorkspace(asTyped), persist: null }],
        { hook_event_name: "UserPromptSubmit", prompt: "relative", cwd: join(root, "proj", "sub") },
      );
    } finally {
      await deck.close();
    }

    expect(deck.seen.filter(s => s.method === "POST")).toHaveLength(1);
  }, 20_000);
});
