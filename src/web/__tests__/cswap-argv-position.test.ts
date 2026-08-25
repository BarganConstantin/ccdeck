// Two values on the accounts route could still decide their own position in an
// argument vector, which is a different bug from the one alias-charset.test.ts
// closed and is not fixed by any amount of quoting.
//
// That file is about what a SHELL would do with a value: `%VAR%`, an unbalanced
// quote, an interior newline, all of which matter because cswap and claude are
// `.cmd` shims on Windows and exec.mjs routes those through
// `cmd.exe /d /s /c` (see viaCmd). Quoting is the answer to that question, and
// on POSIX the question does not arise at all — `run` and `runInteractive` hand
// the vector to spawn untouched and nothing parses it.
//
// This file is about the question quoting cannot answer. An argument that
// arrives at the child perfectly intact is still read by the CHILD's own parser,
// and every parser involved here treats a leading `-` as "this is an option, not
// data". So:
//
//   • `setAlias(3, "--unset")` built ["alias", "3", "--unset"], which is
//     character for character claude-swap's own command for CLEARING an alias.
//     Its `_alias_command` hands that to argparse, which sets `unset=True` and
//     leaves `alias_name` as None. The user asked to name the account; the deck
//     erased its name, cswap printed "Removed alias for Account 3" and exited 0,
//     and the panel showed a rename that worked. `-h` is the same shape with a
//     louder failure mode: argparse prints help, exits 0, and the deck calls
//     that a successful rename too. `-` was in ALIAS_OK's character class, so
//     the allowlist that closed the quoting half waved all of this through.
//
//   • `--email` never got an allowlist at all. `email.includes("@")` was the
//     whole of its validation, and the value comes straight off the request body
//     (`index.mjs` → `admin.startLogin({ email: parsed.email })`). That admits
//     `-x@y.z`, which is flag-shaped, and it admits both residuals exec.mjs
//     documents for Windows — `"a@b\ncalc.exe"`, whose LF is a command separator
//     inside cmd.exe's single quoted line, and `"%USERPROFILE%@x"`, which
//     expands inside quotes with no escape available. Both satisfy
//     `includes("@")`. Both are payloads the alias tests already pin as refused
//     for the other field.
//
// ── why the test is shaped this way ─────────────────────────────────────────
//
// `node:child_process` is mocked rather than `exec.mjs`, which is the difference
// between reading the vector the deck INTENDED and the vector a child would
// really have received. Everything in exec.mjs runs for real underneath —
// `candidates`, `candidateSpec`, `viaCmd`, `shellQuoteArg` — so on Windows the
// two fake binaries below carry `.cmd` extensions on purpose: `isBatch` is true
// there, the whole call collapses into one `cmd.exe /d /s /c "…"` string, and a
// test reading `.args` would be looking at ["/d","/s","/c",…]. Every assertion
// therefore goes through `spawnedArgv` from ./spawned-argv, which is the one
// place in the suite that takes that line back apart, so the same expectations
// hold on Linux, macOS and Windows.
//
// The refusals are the stronger half and need no argv at all: a value the
// validator rejects must reach NO subprocess, which is asserted as an empty
// recording rather than as a well-quoted one.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { spawnedArgv } from "./spawned-argv";

// The sandbox, in place BEFORE the module under test is imported: cswap-admin
// resolves the claude-swap store from $CLAUDE_SWAP_BACKUP or the home directory,
// and its neighbours resolve marker files out of the home directory at module
// load. A test that reached the real ones would be reading the accounts of
// whoever is running the suite. $HOME and %USERPROFILE% are both set because
// os.homedir() reads one on POSIX and the other on Windows.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-argv543-home-"));
const FAKE_STORE = mkdtempSync(join(tmpdir(), "ccdeck-argv543-store-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_SWAP_BACKUP: process.env.CLAUDE_SWAP_BACKUP,
  AGENTS_DECK_CLAUDE: process.env.AGENTS_DECK_CLAUDE,
  AGENTS_DECK_CSWAP: process.env.AGENTS_DECK_CSWAP,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");
process.env.CLAUDE_SWAP_BACKUP = FAKE_STORE;
// The `.cmd` extension is the point, not decoration. On Windows it makes both
// names batch candidates, so exec.mjs really does build the cmd.exe command line
// this file exists to read back; on POSIX `isBatch` is false and the vector is
// the array as given. One pair of names, two recorded shapes, one assertion.
const CLAUDE_BIN = "claude-under-test.cmd";
const CSWAP_BIN = "cswap-under-test.cmd";
process.env.AGENTS_DECK_CLAUDE = CLAUDE_BIN;
process.env.AGENTS_DECK_CSWAP = CSWAP_BIN;

// The sign-in link a real `claude auth login` prints. Emitting it is what keeps
// this file quick: startLogin polls for a url or a dead child for fifteen
// seconds, and a fake that says nothing would make every login test wait it out.
const LOGIN_URL = "https://claude.ai/oauth/authorize?code=1&state=2";

// No test here may reach a real process. `claude auth login` opens a browser tab
// and starts an OAuth flow against the user's own account, and `cswap alias`
// rewrites the account store — so child_process itself is replaced, one layer
// below everything exec.mjs decides.
const { spawns } = vi.hoisted(() => ({
  spawns: [] as { cmd: string; args: string[] }[],
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");

  // What `run` uses. The callback shape is execFile's: (err, stdout, stderr).
  // Answering asynchronously matters — exec.mjs attaches its stdio listeners and
  // its deadline after execFile returns.
  function execFile(cmd: string, args: string[], _opts: unknown, cb?: Function) {
    spawns.push({ cmd, args });
    const cp: any = new EventEmitter();
    cp.stdout = new EventEmitter();
    cp.stderr = new EventEmitter();
    cp.stdin = { on() {}, end() {}, write() { return true; } };
    cp.kill = () => true;
    setImmediate(() => cb?.(null, "ok", ""));
    return cp;
  }

  // What `runInteractive` uses. No `pid`, deliberately: killTree only reaches
  // for taskkill when the child has one, and a recorded taskkill would be a
  // spawn in this file's log that has nothing to do with what was asked for.
  function spawn(cmd: string, args: string[] = []) {
    spawns.push({ cmd, args });
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { on() {}, end() {}, write() { return true; } };
    proc.killed = false;
    proc.kill = () => { proc.killed = true; proc.emit("close", 0); return true; };
    proc.unref = () => {};
    // Only the sign-in prints anything, and only the link. The listeners are
    // attached synchronously after spawn returns, so a turn of the loop is
    // enough for them to be there.
    if (args[0] === "auth" && args[1] === "login") {
      setImmediate(() => proc.stdout.emit("data", `${LOGIN_URL}\n`));
    }
    return proc;
  }

  return { execFile, spawn };
});

// @ts-expect-error — plain JS module, no types
const admin = await import("../../server/cswap-admin.mjs");
const { setAlias, startLogin, cancelLogin, readStore } = admin;

// Belt and braces. If any override above were ignored — or overridden again by a
// developer's own environment — the store would resolve somewhere in the real
// home directory. Prove it landed in the sandbox by putting an account there and
// reading it back, and fail before a single test gets to run. No
// activeAccountNumber, so cancelLogin has nothing to switch back to.
writeFileSync(
  join(FAKE_STORE, "sequence.json"),
  JSON.stringify({ accounts: { 7: { email: "sandbox@example.invalid" } } }),
);
if (!homedir().startsWith(FAKE_HOME)) {
  throw new Error(`refusing to run: homedir() is ${homedir()}, outside ${FAKE_HOME}`);
}
const sandboxed = await readStore();
if (sandboxed.slots.join(",") !== "7") {
  throw new Error(`refusing to run: the account store resolved outside ${FAKE_STORE}`);
}

/**
 * Every recorded spawn as the child really received it, with the program
 * dropped — on Windows the program is cmd.exe rather than the tool, and every
 * question below is about the arguments.
 */
const recorded = (): string[][] => spawns.map(spawnedArgv).map(argv => argv.slice(1));

/** The arguments of the one `cswap alias …` call, or undefined if none ran. */
const aliasArgv = () => recorded().find(a => a[0] === "alias");

/** The arguments of the one `claude auth login …` call, or undefined. */
const loginArgv = () => recorded().find(a => a[0] === "auth" && a[1] === "login");

beforeEach(() => { spawns.length = 0; });
// Every sign-in started here is stopped here: a live flow holds a child and a
// five-minute deadline, and the module allows one at a time.
afterEach(async () => { await cancelLogin(); });

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmSync(FAKE_STORE, { recursive: true, force: true });
});

describe("an alias that would be read as a flag rather than stored", () => {
  it("refuses `--unset`, which is claude-swap's own command for erasing the name", async () => {
    // The whole bug in one call: this used to build ["alias", "3", "--unset"],
    // argparse read the third element as the flag, and the account lost the
    // alias it was being given while the deck reported `{ok: true}`.
    expect(await setAlias(3, "--unset")).toEqual({ ok: false, reason: "bad_value" });
    expect(spawns, "the refusal has to happen before the spawn, not after it").toHaveLength(0);
  });

  it("refuses every other leading dash, including the ones that exit 0", async () => {
    // `-h` is the sharpest of these: argparse prints help and exits ZERO, so the
    // deck's `r.ok` is true and a rename that never happened is announced as a
    // success. The rest are refused for the same reason rather than for any
    // guess about which options claude-swap happens to define today.
    for (const alias of ["-h", "--help", "-x", "--debug", "--unset extra", "-", "--"]) {
      expect(await setAlias(1, alias), alias).toEqual({ ok: false, reason: "bad_value" });
    }
    expect(spawns).toHaveLength(0);
  });

  it("refuses a leading dash that only appears once the value is trimmed", async () => {
    // The trim happens before the check, which is what makes the padded spelling
    // a real bypass rather than a curiosity: `" --unset"` is not flag-shaped as
    // it arrives and is exactly flag-shaped by the time it reaches argv.
    expect(await setAlias(2, "  --unset  ")).toEqual({ ok: false, reason: "bad_value" });
    expect(spawns).toHaveLength(0);
  });

  it("keeps a dash anywhere else, so the names people actually use still work", async () => {
    // Only the FIRST character is constrained. `acme-corp` is in this suite's
    // existing list of ordinary names and must keep working, and a rule that
    // banned dashes outright would have broken it to fix `--unset`.
    expect(await setAlias(4, "acme-corp")).toEqual({ ok: true, output: "ok" });
    expect(aliasArgv()).toEqual(["alias", "4", "acme-corp"]);
  });

  it("sends a legitimate alias through as one argument, in the position cswap reads it", async () => {
    expect(await setAlias(2, "day job")).toEqual({ ok: true, output: "ok" });
    // Through spawnedArgv, so this reads the array on POSIX and the unpicked
    // `cmd.exe /d /s /c "…"` line on Windows. The space in the alias is the
    // reason that distinction is worth asserting at all: it is one argument in
    // both shapes, never two.
    expect(aliasArgv()).toEqual(["alias", "2", "day job"]);
  });

  it("still clears an alias, which is an empty value rather than a flag-shaped one", async () => {
    // `--unset` is a thing the deck may SAY; it is not a thing a user may TYPE.
    // The refusals above must not have taken the clear path with them.
    expect(await setAlias(5, "")).toEqual({ ok: true, output: "ok" });
    expect(aliasArgv()).toEqual(["alias", "5", "--unset"]);
  });
});

describe("an email that would be read as a flag, or as a second command", () => {
  it("refuses a flag-shaped address before anything is spawned", async () => {
    const out = await startLogin({ email: "-x@y.example" });

    expect(out).toMatchObject({ ok: false, reason: "bad_email" });
    expect(spawns, "no child, and in particular no `claude auth login`").toHaveLength(0);
  });

  it("refuses whitespace and newlines, which is the cmd.exe half of the same field", async () => {
    // The first two are the residuals exec.mjs documents and alias-charset.test.ts
    // already pins as refused for the alias: an LF is a separator inside cmd.exe's
    // single quoted command line, and `%VAR%` expands inside quotes with no escape
    // available. Every one of them satisfies the old `includes("@")` test.
    const hostile = [
      "a@b.example\ncalc.exe",
      "%USERPROFILE%@x.example",
      "a@b.example\r\nwhoami",
      "a b@c.example",
      "a@b.example ",           // …and this one is fine once trimmed, see below
      "a@b.example\tx",
      'a" & calc.exe & "@b.example',
      "a@b.example;id",
      "a@b.example|id",
      "$(id)@b.example",
      "`id`@b.example",
      `${"x".repeat(250)}@b.example`,   // past the SMTP forward-path limit
    ];
    for (const email of hostile) {
      const out = await startLogin({ email });
      // The trailing-space spelling is the one deliberate exception in the list:
      // trimming is normalisation, not mangling, and the address underneath is
      // ordinary — so it is asserted as accepted rather than as refused.
      if (email.trim() === "a@b.example") {
        expect(out, email).toMatchObject({ ok: true });
        expect(loginArgv(), email).toEqual(["auth", "login", "--email", "a@b.example"]);
        await cancelLogin();
      } else {
        expect(out, email).toMatchObject({ ok: false, reason: "bad_email" });
        expect(spawns.length, email).toBe(0);
      }
      spawns.length = 0;
    }
  });

  it("passes an ordinary address through as the value of --email", async () => {
    const out = await startLogin({ email: "ana.pop+work@example.co.uk" });

    expect(out).toMatchObject({ ok: true });
    // Again through spawnedArgv: on Windows `claude` is a `.cmd` shim, so this
    // whole call is one quoted cmd.exe string and `.args` would read
    // ["/d","/s","/c",…]. The address has to be the element AFTER `--email` and
    // an element of its own, which is the property argv position is about.
    expect(loginArgv()).toEqual(["auth", "login", "--email", "ana.pop+work@example.co.uk"]);
  });

  it("still signs in with no address at all, which is what the dialog actually sends", async () => {
    // AddAccountDialog posts a bare `{action:"login"}`, so `undefined` is the
    // only shape this route sees in practice. An absent address is not a bad one
    // and must not grow a `--email` flag with nothing after it.
    const out = await startLogin();

    expect(out).toMatchObject({ ok: true });
    expect(loginArgv()).toEqual(["auth", "login"]);
  });

  it("treats an empty string as no address, and a non-string as a bad one", async () => {
    // An empty field is a user who typed nothing; a number or an object is a
    // caller sending something this route never offered, and guessing at it
    // would be the same silent substitution the fix exists to stop.
    expect(await startLogin({ email: "   " })).toMatchObject({ ok: true });
    expect(loginArgv()).toEqual(["auth", "login"]);
    await cancelLogin();
    spawns.length = 0;

    for (const email of [42, {}, ["a@b.example"], true]) {
      expect(await startLogin({ email }), String(email)).toMatchObject({ ok: false, reason: "bad_email" });
    }
    expect(spawns).toHaveLength(0);
  });

  it("does not cancel a sign-in already in flight to answer a refusal", async () => {
    // startLogin yields to a newer request by cancelling the old flow, so the
    // order of the guards is load-bearing: validating after that point would let
    // a value the deck refuses to run still kill a sign-in someone is in the
    // middle of.
    expect(await startLogin({ email: "first@example.com" })).toMatchObject({ ok: true });
    const before = spawns.length;

    expect(await startLogin({ email: "--email=evil@example.com" }))
      .toMatchObject({ ok: false, reason: "bad_email" });

    expect(spawns.length, "the refusal spawned nothing of its own").toBe(before);
    expect(admin.loginState().state, "and the live flow is untouched").toBe("awaiting_code");
  });
});
