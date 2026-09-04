// Three values the deck hands to a CLI could still decide their own position in
// an argument vector, which is a different bug from the one alias-charset.test.ts
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
//   • `autoswitch.model` is the THIRD field of this shape and it was not part of
//     that pass, because it lives in another module (#584).
//     `setCswapConfig`'s free-text branch tested
//     `/^[A-Za-z0-9 ,._-]{1,120}$/`, whose character class admits a dash and
//     admits it in first position, and the value then reaches
//     `run(await cswapBin(), ["config", "set", key, str])` as its own argv
//     element. `{ key: "autoswitch.model", value: "-h" }` built
//     `cswap config set autoswitch.model -h`; argparse ate the `-h`, printed
//     help and exited 0, so `r.ok` was true and the deck reported a setting
//     saved that was never written. Verified live against the installed
//     claude-swap rather than reasoned about.
//
// ── the census, which is the point of the #584 half ─────────────────────────
//
// This file was thorough about the two fields #543 named and asked nothing about
// how many fields there are, so a third one in a different module was never a
// case. That is the gap rather than a flaw in the cases: what was missing is
// something that COUNTS.
//
// So the first block below derives the list rather than restating it. It reads
// the three modules that spawn claude-swap, finds every `run` / `runInteractive`
// / `runDetached` call, resolves each argument vector — through a `const`, a
// ternary and an `args.push(…)` where it has to — and classifies every element
// as one of three things: a fixed word, a slot number (`String(n)`, and every
// setter that produces one is asked for a flag-shaped slot below), or a value
// somebody typed. The values somebody typed are the whole population of this
// file, and the census asserts that population is exactly the one the battery
// exercises. A FOURTH field is a new name in that list, and a new name fails the
// census before anyone has to notice it by review.
//
// The auto-switch settings are enumerated the same way, out of `SETTINGS`
// itself: every key whose type is neither `number` nor `enum` falls through to
// the free-text branch, so the battery runs over each of them by construction
// and a fifth setting of that shape arrives already covered.
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
// BOTH SIDES of that have to be normalised, and the first version of this file
// only did one. The assertions read the recording through `spawnedArgv`; the
// child_process STUB did not, and keyed its sign-in output off `args[0] ===
// "auth"`. On Windows args[0] is `/d`, so the stub never printed a link, every
// `startLogin` polled out its full fifteen seconds, and the five sign-in cases
// failed there — and only there — with `reason: "no_url"`. A stub standing in
// for a real child has to read that child's vector the same way the test does.
//
// The first describe is what keeps that honest without a `skipIf`, which would
// re-create the blindness it is meant to catch by only ever running on one leg.
// `viaCmd` takes its platform as a parameter rather than reading
// process.platform, so the Windows command line can be built — and the stub
// asked about it directly — from a Mac.
//
// The refusals are the stronger half and need no argv at all: a value the
// validator rejects must reach NO subprocess, which is asserted as an empty
// recording rather than as a well-quoted one.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEmitter } from "node:events";
// The MOCK below, not the real one — which is the point: one test calls the stub
// with a Windows-shaped vector directly, so its keying is checked on every leg
// rather than only on the leg that produces that shape.
import { spawn as spawnStub } from "node:child_process";

import { spawnedArgv } from "./spawned-argv";
// viaCmd builds the Windows command line on EVERY platform — it passes "win32"
// to shellQuoteArg explicitly rather than reading process.platform — which is
// what lets the first describe below check the Windows shape from a Mac.
// @ts-expect-error — plain JS module, no types
import { viaCmd } from "../../server/exec.mjs";

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
const { spawns, isLoginSpawn } = vi.hoisted(() => ({
  spawns: [] as { cmd: string; args: string[] }[],
  /**
   * Whether a NORMALISED argv — program already dropped — is `claude auth login`.
   *
   * Hoisted so the stub below and the test that pins it are the same function
   * rather than two spellings of the same intention. The word "normalised" is
   * the whole contract: handed a raw `.args`, this is true on POSIX and false on
   * Windows, which is the defect it exists to make impossible to reintroduce.
   */
  isLoginSpawn: (argv: string[]) => argv[0] === "auth" && argv[1] === "login",
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  // The same normaliser the assertions use, imported inside the factory because
  // vi.mock is hoisted above this file's own imports. Reading the recorded call
  // through it is not a nicety here — see the stub's own note below.
  const { spawnedArgv } = await import("./spawned-argv");

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
    //
    // Through spawnedArgv, and this is where the file first got it wrong. The
    // ASSERTIONS were normalised from the start; the STUB was not, and it asked
    // `args[0] === "auth"` of the raw record. On Windows `claude` is a `.cmd`
    // shim, so exec.mjs routes the call through viaCmd and `args` is
    // ["/d","/s","/c","<one quoted line>"] — args[0] is "/d", the stub stayed
    // silent, startLogin polled for a url that could never arrive, and all five
    // sign-in cases failed on that leg alone with `reason: "no_url"` after
    // burning the full fifteen-second wait. A stub that answers a real child's
    // vector has to read that vector the same way the test does.
    if (isLoginSpawn(spawnedArgv({ cmd, args }).slice(1))) {
      setImmediate(() => proc.stdout.emit("data", `${LOGIN_URL}\n`));
    }
    return proc;
  }

  return { execFile, spawn };
});

// @ts-expect-error — plain JS module, no types
const admin = await import("../../server/cswap-admin.mjs");
const { setAlias, startLogin, cancelLogin, readStore } = admin;
// The third module with a value of its own in a cswap argument vector, and the
// one #543 never reached.
// @ts-expect-error — plain JS module, no types
const { setCswapConfig } = await import("../../server/cswap-auto.mjs");

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
  rmTempDir(FAKE_HOME);
  rmTempDir(FAKE_STORE);
});

describe("the recorded spawn, in both of the shapes a real one has", () => {
  // This file's own scaffolding, pinned — because the scaffolding is what broke,
  // and it broke on exactly one leg of the matrix while the other two stayed
  // green. `viaCmd` needs no Windows to run, so the shape that only occurs there
  // is checked from every platform instead of behind a skipIf that would make
  // this case as blind as the bug was.
  const LOGIN_ARGS = ["auth", "login", "--email", "a@b.example"];

  it("is a plain vector when the tool is spawned directly, as it is on POSIX", () => {
    expect(spawnedArgv({ cmd: CLAUDE_BIN, args: LOGIN_ARGS }).slice(1)).toEqual(LOGIN_ARGS);
  });

  it("is one quoted cmd.exe line when the tool is a .cmd shim, as it is on Windows", () => {
    const win = viaCmd(CLAUDE_BIN, LOGIN_ARGS);

    // The shape the stub used to be blind to, stated rather than described: four
    // arguments, and the first is `/d` — never `auth`.
    expect(win.args).toHaveLength(4);
    expect(win.args[0]).toBe("/d");
    expect(spawnedArgv({ cmd: win.file, args: win.args }).slice(1)).toEqual(LOGIN_ARGS);
  });

  it("is recognised as the sign-in in both shapes, which is what the stub asks", () => {
    const win = viaCmd(CLAUDE_BIN, LOGIN_ARGS);

    // isLoginSpawn is literally the function the child_process stub calls, so a
    // regression here is a regression there. Both must answer true.
    expect(isLoginSpawn(spawnedArgv({ cmd: CLAUDE_BIN, args: LOGIN_ARGS }).slice(1))).toBe(true);
    expect(isLoginSpawn(spawnedArgv({ cmd: win.file, args: win.args }).slice(1))).toBe(true);

    // And the raw record is exactly what it must NOT be read as. This is the bug
    // in one line: true on POSIX, false on Windows, which is how five sign-in
    // cases passed on two legs and failed on the third.
    expect(isLoginSpawn(LOGIN_ARGS)).toBe(true);
    expect(isLoginSpawn(win.args)).toBe(false);
  });

  it("answers a Windows-shaped call with a link, which every leg can check", async () => {
    // The case that makes the rest of this file honest. The five sign-in tests
    // below can only exercise the shape the HOST platform produces, so a stub
    // that reads the raw vector still satisfies them on Linux and macOS — the
    // regression is invisible on two legs out of three, which is exactly how it
    // reached CI. Calling the stub directly with a cmd.exe-shaped vector asks it
    // the Windows question from anywhere.
    const win = viaCmd(CLAUDE_BIN, LOGIN_ARGS);
    const proc = spawnStub(win.file, win.args) as unknown as { stdout: EventEmitter };

    const line = await new Promise<string>((resolve, reject) => {
      const bell = setTimeout(
        () => reject(new Error("the stub wrote no sign-in link for the cmd.exe shape")),
        1_000,
      );
      proc.stdout.on("data", (d: unknown) => { clearTimeout(bell); resolve(String(d)); });
    });

    expect(line).toContain("/oauth/authorize?");
  });
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

// ── the census ──────────────────────────────────────────────────────────────
// Everything from here down is #584: not a third field's worth of cases, but the
// count that makes a fourth field impossible to add quietly.

/** Split `text` on the commas that are not inside brackets, parens or quotes. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map(s => s.trim()).filter(Boolean);
}

/** The arguments of the call whose opening `(` sits at `open`, as source text. */
function callArgs(src: string, open: number): string[] {
  let depth = 0, quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) return splitTop(src.slice(open + 1, i));
    }
  }
  throw new Error("unbalanced call — the scanner is out of step with the source");
}

/** A top-level `a ? b : c`, as its two arms, or null when there is none. */
function ternaryArms(text: string): [string, string] | null {
  let depth = 0, quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "?" && depth === 0) {
      let inner = 0, q: string | null = null;
      for (let j = i + 1; j < text.length; j++) {
        const e = text[j];
        if (q) { if (e === "\\") j++; else if (e === q) q = null; continue; }
        if (e === '"' || e === "'" || e === "`") { q = e; continue; }
        if (e === "(" || e === "[" || e === "{") inner++;
        else if (e === ")" || e === "]" || e === "}") inner--;
        else if (e === ":" && inner === 0) return [text.slice(i + 1, j), text.slice(j + 1)];
      }
    }
  }
  return null;
}

/**
 * One argument vector, reduced to the expressions its elements are written as.
 *
 * Resolved through the three shapes the deck actually uses and no further: an
 * array literal, a `const` holding one — including a ternary between two of them
 * — and the `args.push("--email", email)` that `spawnLogin` appends. Anything
 * else comes back as itself and lands in the census as a slot somebody has to
 * account for, which is the safe direction: an expression this cannot read must
 * never be quietly called constant.
 */
function argvElements(expr: string, src: string, at: number): string[] {
  const text = expr.trim();
  if (text.startsWith("[")) return splitTop(text.slice(1, -1));
  const arms = ternaryArms(text);
  if (arms) return [...argvElements(arms[0], src, at), ...argvElements(arms[1], src, at)];
  if (!/^[A-Za-z_$][\w$]*$/.test(text)) return [text];

  // A bare name: take the nearest declaration above the call, then every push
  // between the two.
  const decl = new RegExp(`(?:const|let|var)\\s+${text}\\s*=`, "g");
  let from = -1;
  for (const d of src.slice(0, at).matchAll(decl)) from = d.index! + d[0].length;
  if (from < 0) return [text];
  const elements = argvElements(src.slice(from, src.indexOf(";", from)), src, from);
  for (const p of src.slice(from, at).matchAll(new RegExp(`${text}\\.push\\s*\\(`, "g"))) {
    elements.push(...callArgs(src, from + p.index! + p[0].length - 1));
  }
  return elements;
}

/** A string literal with nothing interpolated into it — a fixed word. */
function isFixedWord(e: string): boolean {
  const t = e.trim();
  if (/^(["'])(?:[^\\]|\\.)*\1$/s.test(t)) return true;
  const arms = ternaryArms(t);
  return arms ? isFixedWord(arms[0]) && isFixedWord(arms[1]) : false;
}

/** `String(n)` — a slot number on its way to argv, never free text. */
const isSlotNumber = (e: string): boolean => /^String\([A-Za-z_$][\w$]*\)$/.test(e.trim());

/** The three modules that put a value of the deck's into claude-swap's argv. */
const CSWAP_MODULES = ["cswap-auto.mjs", "cswap-admin.mjs", "claude-accounts.mjs"] as const;

const moduleSource = (name: string) =>
  readFileSync(new URL(`../../server/${name}`, import.meta.url), "utf8");

/**
 * Every argv element in those modules that is neither a fixed word nor a slot
 * number, as `<module>:<the name it is written as>`.
 */
function typedValueSlots(): string[] {
  const found = new Set<string>();
  for (const name of CSWAP_MODULES) {
    const src = moduleSource(name);
    // `run`, `runInteractive`, `runDetached` — never `_holder.run` and never the
    // `run` of an import list, hence the lookbehind and the `(`.
    for (const m of src.matchAll(/(?<![.\w$])(runInteractive|runDetached|run)\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const args = callArgs(src, open);
      if (args.length < 2) continue;
      for (const el of argvElements(args[1], src, m.index!)) {
        if (isFixedWord(el) || isSlotNumber(el)) continue;
        found.add(`${name}:${el}`);
      }
    }
  }
  return [...found].sort();
}

/**
 * The census, restated by hand — and the only hand-written half of it. What the
 * scan above supplies is COMPLETENESS: every name it finds has to be in here,
 * and every name in here has to still be out there.
 */
const TYPED_VALUE_SLOTS: Record<string, { guard: "free-text" | "allowlist"; what: string }> = {
  "cswap-admin.mjs:clean": { guard: "free-text", what: "the account alias" },
  "cswap-admin.mjs:email": { guard: "free-text", what: "the sign-in address, after --email" },
  "cswap-auto.mjs:str":    { guard: "free-text", what: "the auto-switch model list" },
  // Not free text: `SETTINGS[key]` is a lookup, so a key that is not one of the
  // five the deck writes is refused before `str` is even looked at.
  "cswap-auto.mjs:key":    { guard: "allowlist", what: "the auto-switch setting name" },
};

/**
 * The auto-switch settings that reach argv as free text, read out of `SETTINGS`
 * rather than listed here: `setCswapConfig` sends `number` down one branch and
 * `enum` down another, and EVERYTHING ELSE falls through to the model-list
 * branch. So the question this parse asks is the question the code asks.
 */
function freeTextSettingKeys(): string[] {
  const src = moduleSource("cswap-auto.mjs");
  const from = src.indexOf("const SETTINGS = {");
  if (from < 0) throw new Error("SETTINGS is gone or renamed — the census is blind");
  const block = src.slice(from, src.indexOf("};", from));
  const keys: string[] = [];
  for (const m of block.matchAll(/"([^"]+)":\s*\{\s*type:\s*"([^"]+)"/g)) {
    if (m[2] !== "number" && m[2] !== "enum") keys.push(m[1]);
  }
  if (!keys.length) throw new Error("no free-text setting at all — the parse has drifted");
  return keys;
}

/** One value the deck lets somebody type into an argument vector. */
type TypedField = {
  slot: string;
  what: string;
  /** The refusal this route answers with — each has its own word for it. */
  reason: string;
  set: (value: unknown) => Promise<{ ok: boolean; reason?: string }>;
  /** Ordinary values that must keep working, and the vector each has to produce. */
  accepted: { value: string; argv: string[] }[];
};

const FIELDS: TypedField[] = [
  {
    slot: "cswap-admin.mjs:clean",
    what: "the account alias",
    reason: "bad_value",
    set: (value) => setAlias(1, value),
    accepted: [
      { value: "acme-corp", argv: ["alias", "1", "acme-corp"] },
      { value: "day job", argv: ["alias", "1", "day job"] },
    ],
  },
  {
    slot: "cswap-admin.mjs:email",
    what: "the sign-in address, after --email",
    reason: "bad_email",
    set: (email) => startLogin({ email }),
    accepted: [
      {
        value: "ana.pop+work@example.co.uk",
        argv: ["auth", "login", "--email", "ana.pop+work@example.co.uk"],
      },
    ],
  },
  // One per free-text setting, derived rather than named, so a fifth one of that
  // shape arrives with this battery already pointed at it.
  ...freeTextSettingKeys().map((key): TypedField => ({
    slot: "cswap-auto.mjs:str",
    what: `the ${key} value`,
    reason: "bad_value",
    set: (value) => setCswapConfig(key, value),
    accepted: [
      { value: "all", argv: ["config", "set", key, "all"] },
      // The comma is why this field's character class is wider than ALIAS_OK's
      // and it has to survive the fix: the field is a comma-separated LIST.
      { value: "opus,sonnet", argv: ["config", "set", key, "opus,sonnet"] },
      // Interior dashes are ordinary here — every real model name carries them —
      // and so is the space after the comma.
      {
        value: "claude-3-5-sonnet-20241022, claude-opus-4-1",
        argv: ["config", "set", key, "claude-3-5-sonnet-20241022, claude-opus-4-1"],
      },
    ],
  })),
];

/**
 * Values a child's own parser reads as an option rather than as data. `-h` is
 * the sharpest of them for the reason the alias block above gives: argparse
 * prints help and exits ZERO, so the deck reports a write that never happened as
 * a success. The padded spelling is here because every one of these fields trims
 * before it validates, which is what makes `"  -h  "` flag-shaped by the time it
 * reaches argv.
 */
const FLAG_SHAPED = ["-h", "--help", "-x", "--debug", "-", "--", "--unset", "-all", "  -h  "];

describe("every value the deck lets somebody type into a cswap argument vector", () => {
  it("is one of the ones this file exercises, and there are no others", () => {
    // The assertion that would have caught #584 the day it was written, and the
    // one that catches the fourth field. A new name in a vector — in any of the
    // three modules, through a const, a ternary or a push — is a new entry here,
    // and adding it means answering which guard it carries.
    expect(typedValueSlots()).toEqual(Object.keys(TYPED_VALUE_SLOTS).sort());
  });

  it("has a guard the battery below actually drives, rather than one merely named", () => {
    const driven = new Set(FIELDS.map(f => f.slot));
    const free = Object.entries(TYPED_VALUE_SLOTS)
      .filter(([, v]) => v.guard === "free-text")
      .map(([slot]) => slot);
    for (const slot of free) expect(driven, slot).toContain(slot);
    // Two before #584, three after it. The number is asserted so that deleting a
    // field's cases cannot quietly shrink the population being counted.
    expect(free).toHaveLength(3);
  });

  it("refuses a setting name that is itself flag-shaped, which is the allowlist half", async () => {
    // `key` is the one typed value that is NOT free text: it indexes SETTINGS, so
    // it can only ever be one of five fixed words, and a dash never reaches argv
    // through it.
    for (const key of FLAG_SHAPED) {
      expect(await setCswapConfig(key, "opus"), key).toEqual({ ok: false, reason: "unknown_setting" });
    }
    expect(spawns).toHaveLength(0);
  });

  it("refuses a flag-shaped slot number too, which is the other class of element", async () => {
    // `String(n)` is the third thing an argv element can be, and the census waves
    // it through on the strength of these bounds. `String(-1)` is "-1", which is
    // exactly as flag-shaped as "-h" — so the bound is what keeps it out.
    for (const n of ["-1", -1, "-h", 0, 1000, 1.5, NaN]) {
      expect(await setAlias(n, "ok"), String(n)).toEqual({ ok: false, reason: "bad_account" });
      expect(await admin.removeAccount(n), String(n)).toMatchObject({ ok: false, reason: "bad_account" });
      // `shareAccounts([n])`: the route's own spelling for one account.
      expect(await admin.shareAccounts([n]), String(n)).toMatchObject({ ok: false, reason: "bad_account" });
      expect(await admin.moveAccount(n, 2), String(n)).toMatchObject({ ok: false, reason: "bad_account" });
      expect(await admin.moveAccount(1, n), String(n)).toMatchObject({ ok: false, reason: "bad_slot" });
    }
    expect(spawns).toHaveLength(0);
  });
});

describe.each(FIELDS)("$what", (field) => {
  it("refuses every leading dash before anything is spawned", async () => {
    for (const value of FLAG_SHAPED) {
      const label = `${field.what} · ${JSON.stringify(value)}`;
      expect(await field.set(value), label).toMatchObject({ ok: false, reason: field.reason });
      expect(spawns.length, label).toBe(0);
    }
  });

  it("still passes an ordinary value through as one element, where the CLI reads it", async () => {
    for (const { value, argv } of field.accepted) {
      spawns.length = 0;
      expect(await field.set(value), value).toMatchObject({ ok: true });
      // Through spawnedArgv: on Windows the tool is a `.cmd` shim and the whole
      // call is one quoted cmd.exe line, so `.args` would read ["/d","/s","/c",…].
      // A value carrying a space or a comma is ONE element in both shapes.
      //
      // `toContainEqual` rather than an index, because a route may spawn more
      // than the one call under test — startLogin reads `claude auth status
      // --json` first — and which of them comes back first is not this file's
      // question. That the vector exists exactly as written is.
      expect(recorded(), value).toContainEqual(argv);
      await cancelLogin();
    }
  });
});
