// A sign-in that the CLI finishes by itself.
//
// `claude auth login` 2.1.246 — captured from the real binary while writing
// this — does two things in the same run. It prints its link and then the
// unterminated prompt "Paste code here if prompted > " and blocks on stdin; and
// it listens on a loopback port for the OAuth callback. Which of the two ends
// the exchange is not decided by the CLI's version. It is decided by whether
// the browser that opened can reach this machine:
//
//   - on the deck's own machine it can, so the callback arrives at the CLI, the
//     CLI takes the code itself, prints "Login successful." and exits 0. The
//     page says "You're all set up for Claude Code" and shows no code at all.
//   - from a deck opened on another machine it cannot, the page shows the code,
//     and the paste below is the only way through.
//
// The deck only ever knew about the second. Any exit while it still sat in
// `awaiting_code` was written down as a failure — and the reason shown was the
// child's own output, which on the successful path is the prompt followed by
// "Login successful." So a login that worked was reported as SIGN-IN FAILED,
// with the CLI's success line quoted as the cause, and the rest of the flow —
// `cswap add`, learning the new slot, switching the previous account back — was
// never run at all, leaving the account signed in at the CLI and invisible to
// the panel (#708).
//
// Everything below is pinned against a fake child, because the real one opens a
// browser tab and starts an OAuth flow against whoever is running the tests.
// The bytes it emits are the real capture.
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnedArgv } from "./spawned-argv";

// ── the sandbox, at FILE scope and BEFORE the module under test is imported ──
//
// cswap-admin.mjs and its neighbours resolve the claude-swap store and their
// marker files out of the home directory at module load, and this file drives
// the one code path in the deck that writes credentials. A test that reached
// the real ones would be adding, switching and removing the accounts of whoever
// ran it. $HOME and %USERPROFILE% are both set because os.homedir() reads one
// on POSIX and the other on Windows; the teardown is `afterAll` at file scope,
// never inside a describe, so no other block's completion can fire it early.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-708-home-"));
const FAKE_STORE = mkdtempSync(join(tmpdir(), "ccdeck-708-store-"));
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

/** Byte-for-byte what the real `claude auth login` writes before it blocks. */
const AUTHORIZE =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=ipcF4hM7&state=dSuby3fi";
const GREETING =
  "Opening browser to sign in…\n" +
  "If the browser didn't open, visit: " +
  `\x1b]8;;${AUTHORIZE}\x07${AUTHORIZE}\x1b]8;;\x07` +
  "\nPaste code here if prompted > ";
/** …and what it adds when its own loopback callback finished the exchange. */
const SUCCESS_TAIL = "Login successful.\n";
/** …and what it puts on STDERR when the exchange was refused. Captured by
 *  driving the real CLI's own callback server with a bogus code. */
const REFUSED = "Login failed: Request failed with status code 400\n";

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
       *  lines once, then the still-unterminated tail on every chunk — which is
       *  what makes a prompt without a newline arrive again and again. */
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
/** What `claude auth status --json` answers next, and what `cswap add` does. */
const cli = vi.hoisted(() => ({
  identity: null as null | { email: string },
  /** Called for `cswap add`; returns false to make the add fail. */
  onAdd: (() => true) as () => boolean,
}));

// Nothing in this file may reach a real process: this is the module that signs
// accounts in and out. `claude auth login` is the fake above; every other
// command is answered here rather than run.
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
      const argv = spawnedArgv({ file: cmd, args });
      ran.push(argv.slice(1));
      const verb = argv.slice(1);
      if (verb[0] === "auth" && verb[1] === "status") {
        return cli.identity
          ? ok(JSON.stringify({ loggedIn: true, email: cli.identity.email, orgId: "org-708" }))
          : ok(JSON.stringify({ loggedIn: false }));
      }
      if (verb[0] === "add") {
        return cli.onAdd()
          ? ok("added")
          : { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "cswap: could not read the credential\n" };
      }
      if (verb[0] === "switch") return ok("switched");
      return ok("");
    },
    runDetached: (cmd: string, args: string[]) => { ran.push(spawnedArgv({ file: cmd, args }).slice(1)); },
  };
});

// @ts-expect-error — plain JS module, no types
const admin = await import("../../server/cswap-admin.mjs");
const { startLogin, submitLoginCode, cancelLogin, loginState, failureText, readStore, withStoreLock } = admin;

// ── belt and braces ──────────────────────────────────────────────────────────
//
// If any override above were ignored — or overridden again by a developer's own
// environment — the store would resolve inside the real home directory and this
// file would rewrite it. Prove it landed in the sandbox by putting an account
// there and reading it back, and fail before a single test runs.
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
  expect(await start).toMatchObject({ ok: true, state: "awaiting_code", url: AUTHORIZE });
  return child;
}

/**
 * Wait for the flow to stop moving — the done handler settles it off-request,
 * so no test can await it directly.
 *
 * Two waits, because the state is not the last thing to happen: a registration
 * that fails writes `failed` and only THEN puts the previous account back, so a
 * test that stopped at the state would read `ran` a `cswap switch` too early.
 * Queuing an empty mutation behind the store lock waits for the whole of
 * whichever one is in flight.
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

/** What a plain, signed-in machine looks like before anyone presses Sign in. */
function freshStore() {
  store({ 1: { email: OLD } }, 1);
  cli.identity = { email: OLD };
  cli.onAdd = () => { store({ 1: { email: OLD }, 2: { email: NEW } }, 2); return true; };
  ran.length = 0;
}

const didRun = (verb: string) => ran.some(a => a[0] === verb);

// The other half of "not shown as the reason": the child's output is not thrown
// away, it goes to the deck's log. Captured rather than printed, so the suite
// stays quiet and so one test can assert it actually arrives.
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

// ── the sign-in the CLI finishes by itself ───────────────────────────────────

describe("a `claude auth login` that completes through its own callback", () => {
  it("registers the account instead of calling the success a failure", async () => {
    freshStore();
    const child = await waiting();

    // The browser reached this machine, so the CLI took the code itself. What
    // it prints and how it exits, exactly as reported in #708.
    cli.identity = { email: NEW };
    child.out(SUCCESS_TAIL);
    child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING + SUCCESS_TAIL, stderr: "" });

    const state = await settled();
    expect(state.state).toBe("done");
    expect(state.account).toEqual({ num: "2", email: NEW, added: true });
    // The rest of the flow, which a discarded login never got: the account is
    // recorded with claude-swap, the new slot is learned, and the account the
    // user was on is put back in front.
    expect(didRun("add")).toBe(true);
    expect(ran.filter(a => a[0] === "switch")).toEqual([["switch", "1"]]);
    expect(JSON.parse(readFileSync(SEQ, "utf8")).accounts["2"].email).toBe(NEW);
  });

  it("never shows the CLI's own success line as the reason it failed", async () => {
    freshStore();
    const child = await waiting();
    cli.identity = { email: NEW };
    child.out(SUCCESS_TAIL);
    child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING + SUCCESS_TAIL, stderr: "" });

    const state = await settled();
    // The screenshot in the issue: "SIGN-IN FAILED / Paste code here if
    // prompted > Login successful."
    expect(state.state).not.toBe("failed");
    expect(state.error ?? "").not.toMatch(/successful/i);
    expect(state.error ?? "").not.toMatch(/Paste code/i);
  });

  it("counts a re-sign-in of the SAME account as the success it is", async () => {
    // The trap in fixing this by identity CHANGE alone. Signing the account the
    // deck already holds back in leaves the identity exactly where it was, and
    // refusing that would be the same bug wearing different clothes: cswap
    // refreshes the stored credential in place and the panel says so.
    store({ 1: { email: OLD } }, 1);
    cli.identity = { email: OLD };
    cli.onAdd = () => true;           // already managed; no new slot appears
    ran.length = 0;

    const child = await waiting();
    child.out(SUCCESS_TAIL);
    child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING + SUCCESS_TAIL, stderr: "" });

    const state = await settled();
    expect(state.state).toBe("done");
    expect(state.account).toEqual({ num: "1", email: OLD, added: false });
    expect(didRun("add")).toBe(true);
  });

  it("does not throw the sign-in away for lack of a link it never needed", async () => {
    // The same rule at the other end of the flow. startLogin waits for a link
    // and answers "no_url" without one, and it used to answer that over
    // whatever the exit handler had already concluded. Now that the handler can
    // carry a sign-in all the way to `done` by itself, a CLI that completed
    // without printing a link the deck could read — because it was already
    // authorised, or because it printed one this cannot parse — would have had
    // its finished login overwritten with a guess about a missing link.
    //
    // The tight timeout is the assertion's other half: startLogin's wait is
    // fifteen seconds, so an answer that does not notice the flow moved is not
    // merely wrong, it is fifteen seconds late.
    freshStore();
    const nth = fakeLogin.children.length;
    const start = startLogin();
    const child = await fakeLogin.child(nth);
    cli.identity = { email: NEW };
    child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: SUCCESS_TAIL, stderr: "" });

    expect(await start).toMatchObject({ ok: true });
    const state = await settled();
    expect(state.state).toBe("done");
    expect(state.account).toEqual({ num: "2", email: NEW, added: true });
  }, 5_000);

  it("takes a login that landed despite a messy exit, by asking who we are now", async () => {
    freshStore();
    const child = await waiting();
    // Non-zero, but `claude auth status --json` says somebody new is signed in.
    // The identity is the oracle; the exit status is a hint.
    cli.identity = { email: NEW };
    child.end({ ok: false, code: 1, killed: false, timedOut: false, stdout: GREETING, stderr: "warning: could not write telemetry\n" });

    const state = await settled();
    expect(state.state).toBe("done");
    expect(state.account).toMatchObject({ email: NEW, added: true });
  });
});

// ── the sign-ins that really did fail ────────────────────────────────────────

describe("a `claude auth login` that really did fail", () => {
  it("says what the CLI put on stderr, and records nothing", async () => {
    freshStore();
    const child = await waiting();
    // Nobody new signed in — the identity is where it was.
    child.end({ ok: false, code: 1, killed: false, timedOut: false, stdout: GREETING, stderr: REFUSED });

    const state = await settled();
    expect(state.state).toBe("failed");
    expect(state.error).toBe("Login failed: Request failed with status code 400");
    // The stdout tail is the prompt, and the prompt used to win: stderr and
    // stdout were concatenated and the LAST line taken.
    expect(state.error).not.toMatch(/Paste code/i);
    expect(didRun("add")).toBe(false);
    // Kept, not lost: everything the child printed is on the deck's log for
    // whoever is watching the terminal, on one line and with the link's OSC-8
    // escapes taken out of it.
    const note = logged.find(l => l.includes("sign-in"));
    // The complaint survives the length bound; the chatter is what may not.
    expect(note).toContain("Login failed: Request failed with status code 400");
    expect(note).not.toContain("\x1b");
    expect(note!.split("\n")).toHaveLength(1);
  });

  it("writes a sentence of its own when the CLI said nothing worth repeating", async () => {
    freshStore();
    const child = await waiting();
    child.end({ ok: false, code: 1, killed: false, timedOut: false, stdout: GREETING, stderr: "" });

    const state = await settled();
    expect(state.state).toBe("failed");
    expect(state.error).toBe("the sign-in did not complete — nothing new was signed in");
    // Neither the prompt it was sitting on nor an exit status nobody saw.
    expect(state.error).not.toMatch(/Paste code|exited/i);
    expect(didRun("add")).toBe(false);
  });

  it("calls a deadline a deadline, without asking the CLI anything more", async () => {
    freshStore();
    const child = await waiting();
    const asked = ran.filter(a => a[0] === "auth").length;
    child.end({ ok: false, code: "ETIMEDOUT", killed: true, timedOut: true, stdout: GREETING, stderr: "" });

    const state = await settled();
    expect(state.state).toBe("failed");
    expect(state.error).toBe("the sign-in window expired");
    // Nothing was signed in, so there is nothing to ask about — and the answer
    // has to be immediate, because startLogin is still holding its POST open on
    // this state.
    expect(ran.filter(a => a[0] === "auth").length).toBe(asked);
    expect(didRun("add")).toBe(false);
  });

  it("answers a `claude` that cannot be run at all without asking it anything", async () => {
    // The one sentence in this whole flow that names a fix, and the only one
    // startLogin can still be holding its POST open waiting for: a child that
    // was never launched is gone in milliseconds, and putting an identity
    // question in front of that answer would spend the caller's fifteen
    // seconds asking the same unrunnable binary who is logged in.
    freshStore();
    const nth = fakeLogin.children.length;
    const start = startLogin();
    const child = await fakeLogin.child(nth);
    const asked = ran.filter(a => a[0] === "auth").length;
    child.end({ ok: false, code: "ENOENT", killed: false, timedOut: false, stdout: "", stderr: "" });

    expect(await start).toMatchObject({ ok: false, reason: "no_url" });
    const state = loginState();
    expect(state.state).toBe("failed");
    expect(state.error).toContain("AGENTS_DECK_CLAUDE");
    expect(ran.filter(a => a[0] === "auth").length).toBe(asked);
  }, 20_000);

  it("does not leave the dialog spinning when the registration itself throws", async () => {
    // The handler answers nobody's request, so a throw inside it is an
    // unhandled rejection and a flow stuck on `registering` — which the dialog
    // polls forever, since `registering` is a state where something is
    // supposed to be moving.
    freshStore();
    cli.onAdd = () => { throw new Error("708: the store went away mid-add"); };
    const child = await waiting();
    cli.identity = { email: NEW };
    child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING + SUCCESS_TAIL, stderr: "" });

    const state = await settled();
    expect(state.state).toBe("failed");
    expect(state.error).toBe("the sign-in could not be finished — see the deck's log");
    expect(logged.some(l => l.includes("708: the store went away mid-add"))).toBe(true);
  });

  it("says so when the sign-in worked but `cswap add` could not record it", async () => {
    freshStore();
    // The active account has moved meanwhile — by the add itself before it
    // gave up, or by the deck's own auto-switch tick — which is what gives the
    // restore something to undo.
    cli.onAdd = () => { store({ 1: { email: OLD }, 2: { email: NEW } }, 2); return false; };
    const child = await waiting();
    cli.identity = { email: NEW };
    child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING + SUCCESS_TAIL, stderr: "" });

    const state = await settled();
    expect(state.state).toBe("failed");
    expect(state.error).toMatch(/could not read the credential/);
    // And the account the user was on is still put back, exactly as the pasted
    // path puts it back when its own add fails.
    expect(ran.filter(a => a[0] === "switch")).toEqual([["switch", "1"]]);
  });
});

// ── the paste route, still there ─────────────────────────────────────────────

describe("the pasted-code route, which is still reachable", () => {
  it("registers through the same steps when a code is pasted", async () => {
    // A deck opened from another machine: the browser cannot reach this one's
    // loopback, so the page shows the code and this is the only way through.
    freshStore();
    const child = await waiting();
    const verdict = submitLoginCode("ABC-123");
    expect(child.written).toEqual(["ABC-123\n"]);

    cli.identity = { email: NEW };
    child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING, stderr: "" });

    expect(await verdict).toMatchObject({ ok: true, state: "done" });
    expect(loginState().account).toEqual({ num: "2", email: NEW, added: true });
    expect(didRun("add")).toBe(true);
    expect(ran.filter(a => a[0] === "switch")).toEqual([["switch", "1"]]);
  }, 10_000);

  it("keeps the field open when the code is refused, rather than ending", async () => {
    freshStore();
    const child = await waiting();
    const verdict = submitLoginCode("NOPE-1");
    // A typo: the CLI ends the prompt's line, says why, and asks again. It does
    // not exit, so there is no `done` to wait for.
    child.out("\r\nInvalid code.\r\nPaste code here if prompted > ");

    expect(await verdict).toMatchObject({ ok: false, reason: "code_rejected", state: "awaiting_code" });
    expect(loginState().url).toBe(AUTHORIZE);
    expect(didRun("add")).toBe(false);
  }, 10_000);

  it("does not register the same sign-in twice when a paste races the exit", async () => {
    // Both routes in one run, which is what the CLI actually offers: a code is
    // pasted just as the CLI's own callback finishes the exchange. The window
    // is the identity question the exit handler asks — the code arrives while
    // that answer is still out.
    //
    // Whichever route got there first has to own the registration on its own,
    // because `cswap add` assigns the next slot as max+1 and takes no file lock
    // while doing it: two of them pick the same number and the second write
    // drops the first account's record. That is the reason this module has a
    // mutex at all, and it is not a defence against a second add the deck
    // itself started.
    freshStore();
    const child = await waiting();
    cli.identity = { email: NEW };
    child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING + SUCCESS_TAIL, stderr: "" });
    // Let the exit handler get as far as its question, and no further.
    await Promise.resolve();
    await Promise.resolve();

    const verdict = await submitLoginCode("ABC-123");
    // The paste is refused, not queued: the flow has already left the state a
    // code is taken in.
    expect(verdict).toMatchObject({ ok: false, reason: "not_waiting" });

    await settled();
    expect(loginState().state).toBe("done");
    expect(ran.filter(a => a[0] === "add")).toHaveLength(1);
  }, 10_000);
});

// ── what the dialog asks of the user ─────────────────────────────────────────

describe("the sign-in dialog's own copy", () => {
  // Read as source, the way tablist-contract.test.ts reads this same file: the
  // claim is about the words the component ships, and rendering React to ask a
  // question about a string is a worse way to ask it.
  // Comments stripped the way tablist-contract.test.ts strips them, because the
  // file's own comments QUOTE the old copy — that is what they are for — and a
  // claim about what the dialog says has to be asked of what it renders.
  // Whitespace collapsed too: JSX wraps prose across lines and where a sentence
  // happens to break is not part of the claim.
  const dialog = readFileSync(
    fileURLToPath(new URL("../components/AddAccountDialog.tsx", import.meta.url)), "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n")
    .replace(/\s+/g, " ");

  it("no longer instructs the user to paste a code the page will not show", () => {
    // The third half of #708. Step 2 read "Paste the code it gives you" and the
    // primer promised the sign-in "asks for the code it shows you" — both flat
    // statements about a code that, on the deck's own machine, never exists.
    expect(dialog).not.toContain("Paste the code it gives you");
    expect(dialog).not.toContain("asks for the code it shows you");
  });

  it("says instead that a code is the exception, in both places it is mentioned", () => {
    // The heading over the field, and the primer that is read before the
    // browser is ever opened. Both have to hedge, because the common case is
    // that nothing is asked of the user here at all.
    expect(dialog).toContain("Paste a code, if the page shows one");
    expect(dialog).toContain("It usually finishes on its own");
    expect(dialog).toContain("only if the page hands you a code does it need pasting back here");
  });
});

// ── the text itself ──────────────────────────────────────────────────────────

describe("failureText, on output that is not a diagnosis", () => {
  const r = (stderr: string, stdout: string) => ({ ok: false, code: 1, killed: false, timedOut: false, stdout, stderr });

  it("prefers what the CLI put on stderr to what it printed on stdout", () => {
    expect(failureText(r(REFUSED, GREETING), "claude auth login"))
      .toBe("Login failed: Request failed with status code 400");
  });

  it("refuses a line that announces success", () => {
    // The sentence out of the screenshot in #708.
    expect(failureText(r("", GREETING + SUCCESS_TAIL), "claude auth login", "the sign-in did not complete"))
      .toBe("the sign-in did not complete");
  });

  it("refuses the prompt the CLI was still sitting on", () => {
    expect(failureText(r("", GREETING), "claude auth login", "the sign-in did not complete"))
      .toBe("the sign-in did not complete");
  });

  it("still lets a genuine complaint speak for itself, on either stream", () => {
    expect(failureText(r("Error: Account-9 does not exist\n", ""), "cswap remove")).toBe("Account-9 does not exist");
    expect(failureText(r("", "no account 7\n"), "cswap move")).toBe("no account 7");
  });

  it("falls back to the exit status only when no sentence was offered", () => {
    expect(failureText({ ok: false, code: 2, stderr: "", stdout: "" }, "cswap move")).toBe("cswap move exited 2");
  });
});
