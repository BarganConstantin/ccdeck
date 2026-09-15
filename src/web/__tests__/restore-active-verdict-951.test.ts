// The one step of a sign-in that moves the machine's live Claude login BACK,
// and what happened when it did not work.
//
// `cswap add` sets activeAccountNumber to whatever it just added. That is not
// incidental — it is how claude-swap records a new account — so every sign-in
// the deck runs moves the machine onto the account that was just created, and
// `restoreActive` exists to move it back. cswap-admin.mjs says why in as many
// words at the top of the flow: "without this the machine silently changes
// account underneath every running session."
//
// It put the account back on the happy path and said nothing on the unhappy
// one. Two separate things made the verdict unreachable rather than merely
// ignored, and both are worth writing down because either one alone would look
// like a style question:
//
//   1. `run` (exec.mjs) is `new Promise((resolve) => …)` — RESOLVE-ONLY. A
//      failed child comes back as `{ok:false, code, stderr}` and a binary that
//      is not there comes back as `{ok:false, code:"ENOENT"}`. So the
//      `.catch(() => {})` that used to sit on that call could not fire for
//      anything `run` produces; it was catching an exception that does not
//      exist.
//   2. Nothing was assigned. `restoreActive` returned `undefined` whether the
//      switch worked, failed, timed out, or never found a binary, and all three
//      callers went straight on to `flow.state = "done"`.
//
// WHAT WAS OBSERVED against the unfixed module, driving the real
// `registerSignedIn` with `cswap switch` failing the way a dead refresh token
// makes it fail: the flow reached `state: "done"`, the dialog rendered "Account
// 2 added" over the sentence "The account you were using is still active", and
// sequence.json's activeAccountNumber was 2 — the account that had just been
// added. The sentence on screen was not a rounding error, it was the opposite
// of what had happened, and every Claude Code session on that machine was by
// then running as the new account.
//
// So the rule this file pins is not "log the failure". It is that the FLOW
// carries the verdict: a restore that did not restore is reported to the caller
// with the address the machine is actually signed in as, because a silent
// switch of the live account is the one outcome `previousActive` was captured
// to prevent.
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnedArgv } from "./spawned-argv";
import { restoreWarning } from "../login-flow";

// ── the sandbox, at FILE scope and BEFORE the module under test is imported ──
//
// The same sandbox login-completes-itself-708.test.ts builds, and for the same
// reason: this is the one code path in the deck that writes credentials, so a
// test that reached the real store would be adding, switching and removing the
// accounts of whoever ran it. $HOME and %USERPROFILE% are both set because
// os.homedir() reads one on POSIX and the other on Windows; the teardown is
// `afterAll` at file scope, never inside a describe, so no other block's
// completion can fire it early.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-951-home-"));
const FAKE_STORE = mkdtempSync(join(tmpdir(), "ccdeck-951-store-"));
const SEQ = join(FAKE_STORE, "sequence.json");
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  CLAUDE_SWAP_BACKUP: process.env.CLAUDE_SWAP_BACKUP,
  AGENTS_DECK_CLAUDE: process.env.AGENTS_DECK_CLAUDE,
  AGENTS_DECK_CSWAP: process.env.AGENTS_DECK_CSWAP,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");
process.env.XDG_CONFIG_HOME = join(FAKE_HOME, ".config");
process.env.CLAUDE_SWAP_BACKUP = FAKE_STORE;
// Names that cannot resolve to anything, so a mock that failed to bind reaches
// no CLI rather than the real one.
process.env.AGENTS_DECK_CLAUDE = join(FAKE_HOME, "no-such-claude");
process.env.AGENTS_DECK_CSWAP = join(FAKE_HOME, "no-such-cswap");

// ── the fakes ────────────────────────────────────────────────────────────────

/** What the real `claude auth login` writes before it blocks. Both halves are
 *  load-bearing: `startLogin` does not answer until it has seen the authorize
 *  URL, and the unterminated prompt after it is what moves the flow into
 *  `awaiting_code`. */
const AUTHORIZE =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=ipcF4hM7&state=dSuby3fi";
const GREETING =
  "Opening browser to sign in…\n" +
  `If the browser didn't open, visit: ${AUTHORIZE}\n` +
  "Paste code here if prompted > ";
const SUCCESS_TAIL = "Login successful.\n";

const fakeLogin = vi.hoisted(() => {
  type Sub = (line: string, partial: boolean) => void;
  const children: any[] = [];
  let waiting: ((c: any) => void) | null = null;

  function spawn() {
    let settle!: (r: any) => void;
    const subs: Sub[] = [];
    let pending = "";
    const child = {
      done: new Promise((r) => { settle = r; }),
      killed: false,
      written: [] as string[],
      onLine(cb: Sub) { subs.push(cb); },
      write(text: string) { child.written.push(text); },
      kill() { child.killed = true; },
      /** Bytes out, cut into lines exactly as exec.mjs cuts them: complete
       *  lines once, then the still-unterminated tail on every chunk. */
      out(text: string) {
        pending += text;
        let nl;
        while ((nl = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, nl).replace(/\r$/, "");
          pending = pending.slice(nl + 1);
          for (const cb of subs) cb(line, false);
        }
        if (pending) for (const cb of subs) cb(pending, true);
      },
      end(r: unknown) { settle(r); },
    };
    children.push(child);
    waiting?.(child);
    waiting = null;
    return child;
  }

  function child(i: number): Promise<any> {
    return children[i] ? Promise.resolve(children[i]) : new Promise((res) => { waiting = res; });
  }

  return { spawn, child, children };
});

/** Every `run` the module made, as the argv a process would have received. */
const ran = vi.hoisted(() => [] as string[][]);
const cli = vi.hoisted(() => ({
  identity: null as null | { email: string },
  /** Called for `cswap add`; returns false to make the add fail. */
  onAdd: (() => true) as () => boolean,
  /** Called for `cswap switch <n>`. Returning false is the case this whole
   *  file is about: claude-swap exits non-zero and the account does NOT move.
   *  Returning true moves it, the way the real one does. */
  onSwitch: ((_num: string) => true) as (num: string) => boolean,
}));

// Nothing in this file may reach a real process: this is the module that signs
// accounts in and out.
vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, any>>();
  const ok = (stdout = "") => ({ ok: true, code: 0, killed: false, timedOut: false, stdout, stderr: "" });
  return {
    ...real,
    runInteractive: (_cmd: string, args: string[]) => {
      if (args[0] === "auth" && args[1] === "login") return fakeLogin.spawn();
      throw new Error(`refusing to run \`${args.join(" ")}\` for real`);
    },
    run: async (cmd: string, args: string[]) => {
      // Through spawnedArgv rather than off `args`: on Windows a recorded
      // command line can be `["/d","/s","/c", '"…"']`, and a stub that matched
      // args[0] would route every call to the same branch there.
      const verb = spawnedArgv({ file: cmd, args }).slice(1);
      ran.push(verb);
      if (verb[0] === "auth" && verb[1] === "status") {
        return cli.identity
          ? ok(JSON.stringify({ loggedIn: true, email: cli.identity.email, orgId: "org-951" }))
          : ok(JSON.stringify({ loggedIn: false }));
      }
      if (verb[0] === "add") {
        return cli.onAdd()
          ? ok("added")
          : { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "cswap: could not read the credential\n" };
      }
      if (verb[0] === "switch") {
        // The shape claude-swap actually exits with when the stored refresh
        // token for the target slot is dead — which is `authTrouble`'s
        // `relogin_required`, and the likeliest way this step fails in the
        // field. The store is NOT moved, because the real one does not move it
        // either when it cannot load the credential.
        return cli.onSwitch(verb[1])
          ? ok("switched")
          : { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "cswap: account 1 needs to sign in again\n" };
      }
      return ok("");
    },
    runDetached: (cmd: string, args: string[]) => { ran.push(spawnedArgv({ file: cmd, args }).slice(1)); },
  };
});

// @ts-expect-error — plain JS module, no types
const admin = await import("../../server/cswap-admin.mjs");
const { startLogin, submitLoginCode, cancelLogin, loginState, readStore, withStoreLock } = admin;

// ── belt and braces ──────────────────────────────────────────────────────────
//
// If any override above were ignored — or overridden again by a developer's own
// environment — the store would resolve inside the real home directory and this
// file would rewrite it. Prove it landed in the sandbox and fail before a single
// test runs.
const store = (accounts: Record<string, { email: string }>, active: number | null) =>
  writeFileSync(SEQ, JSON.stringify({ activeAccountNumber: active, accounts }));
store({ 1: { email: "sandbox@example.invalid" } }, 1);
if (!homedir().startsWith(FAKE_HOME)) {
  throw new Error(`refusing to run: homedir() is ${homedir()}, outside ${FAKE_HOME}`);
}
if (!SEQ.startsWith(FAKE_STORE)) throw new Error(`refusing to run: the store is at ${SEQ}`);
{
  const seen = await readStore();
  if (seen.slots.join(",") !== "1" || seen.emails["1"] !== "sandbox@example.invalid") {
    throw new Error(`refusing to run: the account store resolved outside ${FAKE_STORE}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const OLD = "was.here@example.invalid";
const NEW = "just.signed.in@example.invalid";

/** A sign-in that has printed its link and is sitting on the prompt. */
async function waiting() {
  const nth = fakeLogin.children.length;
  const start = startLogin();
  const child = await fakeLogin.child(nth);
  child.out(GREETING);
  expect(await start).toMatchObject({ ok: true, state: "awaiting_code" });
  return child;
}

/**
 * Wait for the flow to stop moving — the done handler settles it off-request,
 * so no test can await it directly. Queuing an empty mutation behind the store
 * lock then waits for the whole of whichever mutation is in flight, which is
 * what makes the `cswap switch` inside it observable.
 */
async function settled(timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = loginState();
    if (s.state === "done" || s.state === "failed" || s.state === "idle") break;
    if (Date.now() >= until) break;
    await new Promise(r => setTimeout(r, 10));
  }
  await withStoreLock(async () => {});
  return loginState();
}

/** What a plain, signed-in machine looks like before anyone presses Sign in:
 *  one account, active, and an `add` that does what claude-swap's does —
 *  creates slot 2 AND moves the machine onto it. */
function freshStore() {
  store({ 1: { email: OLD } }, 1);
  cli.identity = { email: OLD };
  cli.onAdd = () => { store({ 1: { email: OLD }, 2: { email: NEW } }, 2); return true; };
  cli.onSwitch = (num: string) => {
    const accounts = { 1: { email: OLD }, 2: { email: NEW } };
    store(accounts, Number(num));
    return true;
  };
  ran.length = 0;
}

/** The sign-in the CLI finishes through its own loopback callback — the path
 *  most machines take, and the shortest way into `registerSignedIn`. */
async function signIn() {
  const child = await waiting();
  cli.identity = { email: NEW };
  child.out(SUCCESS_TAIL);
  child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING + SUCCESS_TAIL, stderr: "" });
  return settled();
}

const activeInStore = () => JSON.parse(readFileSync(SEQ, "utf8")).activeAccountNumber;

// Captured rather than printed, so the suite stays quiet.
const logged = [] as string[];
vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });

afterEach(async () => {
  logged.length = 0;
  await cancelLogin();
  for (const c of fakeLogin.children) c.end({ ok: false, code: -1, killed: true, timedOut: false, stdout: "", stderr: "" });
  fakeLogin.children.length = 0;
  ran.length = 0;
});

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
  rmTempDir(FAKE_STORE);
});

// ── the switch that did not switch ───────────────────────────────────────────

describe("a sign-in whose `cswap switch` back does not take", () => {
  it("says the account was not put back, instead of reporting an unqualified success", async () => {
    freshStore();
    cli.onSwitch = () => false;   // the refresh token for slot 1 is dead

    const state = await signIn();

    // The add itself worked, and that stays true: this is a partial success,
    // not a failure, and calling it a failure would be its own lie.
    expect(state.state).toBe("done");
    expect(state.account).toEqual({ num: "2", email: NEW, added: true });
    // It was attempted — the bug was never that the step was skipped.
    expect(ran.filter(a => a[0] === "switch")).toEqual([["switch", "1"]]);
    // And this is the whole issue: the store says the machine is on the NEW
    // account, and before this the flow had no field in which to say so.
    expect(activeInStore()).toBe(2);
    expect(state.restored).toBe(false);
  });

  it("names the account the machine is actually signed in as", async () => {
    // Without the address the warning is unactionable: "something went wrong"
    // over a dialog that just said an account was added tells the user neither
    // which account they are on nor which one to switch back to. The panel
    // lists accounts by address, so the address is what makes the sentence
    // point at a row.
    freshStore();
    cli.onSwitch = () => false;

    const state = await signIn();

    expect(state.activeAccount).toEqual({ num: "2", email: NEW });
  });

  it("reads the verdict off the store rather than off the exit status", async () => {
    // A `cswap switch` that exits non-zero having ALREADY moved the account is
    // not a failure the user needs telling about, and the reverse — exit 0 with
    // nothing moved — is one they do. `newSlot` in the same module settles the
    // equivalent question the same way, under the comment "The store is the
    // fact", so this step does not get to be the one place that trusts a code.
    freshStore();
    cli.onSwitch = (num: string) => {
      store({ 1: { email: OLD }, 2: { email: NEW } }, Number(num));
      return false;   // moved it, then exited 1 anyway
    };

    const state = await signIn();

    expect(activeInStore()).toBe(1);
    expect(state.restored).toBe(true);
    expect(state.activeAccount).toBe(null);
  });

  it("still reports a clean restore as clean", async () => {
    // The happy path is the one this feature runs on every time, and a warning
    // that appeared on it would train the user straight past the warning that
    // matters.
    freshStore();

    const state = await signIn();

    expect(state.state).toBe("done");
    expect(activeInStore()).toBe(1);
    expect(state.restored).toBe(true);
    expect(state.activeAccount).toBe(null);
  });

  it("carries the verdict out of a cancel too", async () => {
    // Escape is the other way the live credentials end up moved: the sign-in
    // may well have completed before the cancel arrived, which is precisely
    // why cancelLogin calls restoreActive at all. The answer cannot go through
    // loginState() there — cancel clears `_login` first, so loginState() is
    // already `{state:"idle"}` by the time it is spread — so it is returned on
    // the result itself.
    freshStore();
    const child = await waiting();
    cli.identity = { email: NEW };
    // The add landed while the user was reaching for Escape.
    store({ 1: { email: OLD }, 2: { email: NEW } }, 2);
    cli.onSwitch = () => false;
    child.end({ ok: false, code: -1, killed: true, timedOut: false, stdout: "", stderr: "" });

    const res = await cancelLogin();

    expect(res.ok).toBe(true);
    expect(res.restored).toBe(false);
    expect(res.activeAccount).toEqual({ num: "2", email: NEW });
  });

  it("puts the same verdict on the path where the add itself failed", async () => {
    // `registerSignedIn` restores on its failure branch as well, and that is
    // the branch where the machine is MOST likely to be left somewhere
    // unexpected: `cswap add` can fail having already written a slot.
    freshStore();
    cli.onAdd = () => { store({ 1: { email: OLD }, 2: { email: NEW } }, 2); return false; };
    cli.onSwitch = () => false;

    const state = await signIn();

    expect(state.state).toBe("failed");
    expect(state.restored).toBe(false);
    expect(state.activeAccount).toEqual({ num: "2", email: NEW });
  });
});

// ── the sentence the dialog gets to say ──────────────────────────────────────

describe("what the dialog says about a restore that did not happen", () => {
  it("says nothing at all when the account went back", () => {
    // `restored` is absent on every state before the restore has been
    // attempted — awaiting_code, registering — and absent must mean quiet, or
    // the warning flashes up mid-sign-in on every login.
    expect(restoreWarning({ restored: true, activeAccount: null })).toBe(null);
    expect(restoreWarning({})).toBe(null);
    expect(restoreWarning({ restored: null, activeAccount: null })).toBe(null);
  });

  it("names the account the machine is on, and what to do about it", () => {
    const said = restoreWarning({ restored: false, activeAccount: { num: "2", email: NEW } });
    expect(said).toContain(NEW);
    expect(said).toMatch(/accounts panel/i);
  });

  it("still says something when the store has no address for the slot", () => {
    // A slot with a blank email is a real state — readStore maps a missing one
    // to "" — and a sentence built by interpolating that would read "signed in
    // as  —", which is worse than the general form.
    expect(restoreWarning({ restored: false, activeAccount: { num: "2", email: "" } })).toContain("account 2");
    expect(restoreWarning({ restored: false, activeAccount: null })).toBeTruthy();
  });
});
