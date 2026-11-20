// "Sign in again" on an account whose stored login expired (user feedback).
//
// The panel's sentence promises that signing in again replaces the dead login
// and that the account keeps its slot, its alias and its history. The flow did
// half of that: it ran `claude auth login --email <the account>` and then
// recorded WHOEVER signed in, so picking another account on the sign-in page
// added or refreshed that one, said "done" over it, and left the expired
// account expired. This pins the whole contract against fakes:
//
//   - the same account signs in: one `cswap add`, the same slot, the alias and
//     the deck's own record of the account kept;
//   - another account signs in: no `cswap add`, nothing written to the store,
//     the machine put back on the account it was on, and the dialog told who
//     signed in and which account still needs it;
//   - a cancel and a failed sign-in write nothing either, and a cancel that
//     arrives after the browser already signed somebody in puts the live
//     login back;
//   - a plain Add, with no account asked for, is what it always was.
//
// Every process is faked. `claude auth login` is a fake child, and `cswap add`
// / `cswap switch` act on a store and a Claude Code login in temp directories,
// the way claude-swap's own in-place refresh does.
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnedArgv } from "./spawned-argv";

// ── the sandbox, before the module under test is imported ───────────────────
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-relogin-home-"));
const FAKE_STORE = mkdtempSync(join(tmpdir(), "ccdeck-relogin-store-"));
const CONFIG_DIR = join(FAKE_HOME, ".claude");
mkdirSync(CONFIG_DIR, { recursive: true });
const SEQ = join(FAKE_STORE, "sequence.json");
const LIVE = join(CONFIG_DIR, ".claude.json");
const ENV_KEYS = [
  "HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME",
  "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_CLAUDE", "AGENTS_DECK_CSWAP",
] as const;
const prevEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");
process.env.XDG_CONFIG_HOME = join(FAKE_HOME, ".config");
process.env.CLAUDE_SWAP_BACKUP = FAKE_STORE;
process.env.AGENTS_DECK_CLAUDE = join(FAKE_HOME, "no-such-claude");
process.env.AGENTS_DECK_CSWAP = join(FAKE_HOME, "no-such-cswap");

// ── the accounts ─────────────────────────────────────────────────────────────
type Acct = { email: string; organizationUuid: string; alias?: string };
/** The account the machine is on, healthy. */
const HOME_ACCT: Acct = { email: "home@example.invalid", organizationUuid: "org-home", alias: "home" };
/** The account whose stored login expired — the one "Sign in again" is for. */
const WORK: Acct = { email: "work.acct@example.invalid", organizationUuid: "org-work-2", alias: "work" };
/** Somebody else the browser happens to be signed into. */
const OTHER: Acct = { email: "someone.else@example.invalid", organizationUuid: "org-other" };

/** Claude Code's live login, as `claude auth login` and `cswap switch` leave it. */
const liveAs = (a: Acct) =>
  writeFileSync(LIVE, JSON.stringify({ oauthAccount: { emailAddress: a.email, organizationUuid: a.organizationUuid } }));
const liveEmail = () => JSON.parse(readFileSync(LIVE, "utf8")).oauthAccount.emailAddress as string;
const readSeq = () => JSON.parse(readFileSync(SEQ, "utf8"));
const writeSeq = (seq: unknown) => writeFileSync(SEQ, JSON.stringify(seq));

// ── the fakes ────────────────────────────────────────────────────────────────
// Built from its parameters, so no committed line holds a URL whose query
// reads like a credential (the repository's access-material check).
const AUTHORIZE = "https://claude.com/cai/oauth/authorize?" + new URLSearchParams({
  code: "true",
  client_id: "00000000-0000-4000-8000-000000000000",
  response_type: "code",
  redirect_uri: "https://platform.claude.com/oauth/code/callback",
  scope: "user:profile",
  code_challenge: "x",
  state: "y",
}).toString();
const GREETING = `Opening browser to sign in…\nIf the browser didn't open, visit: ${AUTHORIZE}\nPaste code here if prompted > `;
const SUCCESS = "Login successful.\n";
const REFUSED = "Login failed: Request failed with status code 400\n";

const fakeLogin = vi.hoisted(() => {
  type Sub = (line: string, partial: boolean) => void;
  const children: any[] = [];
  let waiting: ((c: any) => void) | null = null;
  function spawn(args: string[]) {
    let settle!: (r: any) => void;
    const subs: Sub[] = [];
    const lines = lineFeed(subs);
    const child = {
      args,
      done: new Promise((r) => { settle = r; }),
      killed: false,
      written: [] as string[],
      onLine(cb: Sub) { subs.push(cb); },
      write(text: string) { child.written.push(text); },
      kill() { child.killed = true; },
      out(text: string) { lines.push(text); },
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

/** Every `run` the module made, as argv without the binary. */
const ran = vi.hoisted(() => [] as string[][]);
/** Who `claude auth status --json` says is signed in. */
const cli = vi.hoisted(() => ({ identity: null as null | { email: string; organizationUuid: string } }));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, any>>();
  const { readFileSync: read, writeFileSync: write } = await import("node:fs");
  const ok = (stdout = "") => ({ ok: true, code: 0, killed: false, timedOut: false, stdout, stderr: "" });
  const seqPath = () => `${process.env.CLAUDE_SWAP_BACKUP}/sequence.json`;
  const livePath = () => `${process.env.CLAUDE_CONFIG_DIR}/.claude.json`;
  return {
    ...real,
    runInteractive: (_cmd: string, args: string[]) => {
      if (args[0] === "auth" && args[1] === "login") return fakeLogin.spawn(args);
      throw new Error(`refusing to run \`${args.join(" ")}\` for real`);
    },
    run: async (cmd: string, args: string[]) => {
      const verb = spawnedArgv({ file: cmd, args }).slice(1);
      ran.push(verb);
      if (verb[0] === "auth" && verb[1] === "status") {
        return cli.identity
          ? ok(JSON.stringify({ loggedIn: true, email: cli.identity.email, orgId: cli.identity.organizationUuid }))
          : ok(JSON.stringify({ loggedIn: false }));
      }
      if (verb[0] === "add" && verb.length === 1) {
        // claude-swap's add_account with no slot: an identity it already holds
        // is refreshed IN PLACE — same slot, its record (alias included) left
        // alone, and the slot made active — and a new one goes to max+1.
        const seq = JSON.parse(read(seqPath(), "utf8"));
        const who = cli.identity!;
        const held = Object.entries(seq.accounts as Record<string, any>)
          .find(([, a]) => a.email === who.email && a.organizationUuid === who.organizationUuid)?.[0];
        const num = held ?? String(Math.max(0, ...Object.keys(seq.accounts).map(Number)) + 1);
        if (!held) seq.accounts[num] = { email: who.email, organizationUuid: who.organizationUuid };
        seq.accounts[num].refreshedAt = "now";
        seq.activeAccountNumber = Number(num);
        write(seqPath(), JSON.stringify(seq));
        return ok(held ? `Updated credentials for Account ${num}` : `Added Account ${num}`);
      }
      if (verb[0] === "switch") {
        const seq = JSON.parse(read(seqPath(), "utf8"));
        const to = seq.accounts[verb[1]];
        if (!to) return { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "no such account\n" };
        seq.activeAccountNumber = Number(verb[1]);
        write(seqPath(), JSON.stringify(seq));
        write(livePath(), JSON.stringify({ oauthAccount: { emailAddress: to.email, organizationUuid: to.organizationUuid } }));
        cli.identity = { email: to.email, organizationUuid: to.organizationUuid };
        return ok("switched");
      }
      return ok("");
    },
    runDetached: (cmd: string, args: string[]) => { ran.push(spawnedArgv({ file: cmd, args }).slice(1)); },
  };
});

// @ts-expect-error — plain JS module, no types
const { lineFeed } = await import("../../server/exec.mjs");
// @ts-expect-error — plain JS module, no types
const admin = await import("../../server/cswap-admin.mjs");
const { startLogin, submitLoginCode, cancelLogin, loginState, readStore, withStoreLock, accountOriginsWith } = admin;
// @ts-expect-error — plain JS module, no types
const { withSignIn } = await import("../../server/account-origins.mjs");
// @ts-expect-error — plain JS module, no types
const { accountKey } = await import("../../server/lan-copies.mjs");
const { REASONS, loginErrorText } = await import("../admin-failure");
const { wrongAccountText } = await import("../login-flow");
const { setLanguage } = await import("../i18n");

// ── belt and braces: the store and the live login are the sandbox's ─────────
function freshMachine() {
  writeSeq({ activeAccountNumber: 1, accounts: { 1: { ...HOME_ACCT }, 2: { ...WORK } } });
  liveAs(HOME_ACCT);
  cli.identity = { email: HOME_ACCT.email, organizationUuid: HOME_ACCT.organizationUuid };
  ran.length = 0;
}
freshMachine();
if (!homedir().startsWith(FAKE_HOME)) throw new Error(`refusing to run: homedir() is ${homedir()}`);
{
  const seen = await readStore();
  if (seen.emails["2"] !== WORK.email || seen.liveNum !== "1") {
    throw new Error(`refusing to run: the store or the live login resolved outside the sandbox`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A sign-in started for `email` (or a plain Add), printed and waiting. */
async function waiting(email?: string) {
  const nth = fakeLogin.children.length;
  const start = startLogin(email === undefined ? {} : { email });
  const child = await fakeLogin.child(nth);
  child.out(GREETING);
  expect(await start).toMatchObject({ ok: true, state: "awaiting_code" });
  return child;
}

/** The browser approved as `who`: `claude auth login` has replaced Claude
 *  Code's live login before it exits, and the CLI now reports `who`. */
function browserSignedIn(who: Acct) {
  liveAs(who);
  cli.identity = { email: who.email, organizationUuid: who.organizationUuid };
}

/** The CLI took the code itself and exited cleanly (#708's ordinary path). */
function exitsSignedIn(child: any) {
  child.out(SUCCESS);
  child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING + SUCCESS, stderr: "" });
}

/** Until the flow stops moving, and whatever it queued on the store lock. */
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

const adds = () => ran.filter(a => a[0] === "add");
const switches = () => ran.filter(a => a[0] === "switch");

const told = [] as Array<{ email: string; org: string; added: boolean }>;
accountOriginsWith({ signedIn: (d: { email: string; org: string; added: boolean }) => { told.push(d); } });

const logged = [] as string[];
vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });

afterEach(async () => {
  await cancelLogin();
  for (const c of fakeLogin.children) c.end({ ok: false, code: -1, killed: true, timedOut: false, stdout: "", stderr: "" });
  fakeLogin.children.length = 0;
  told.length = 0;
  logged.length = 0;
  setLanguage("en");
});

afterAll(() => {
  accountOriginsWith(null);
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
  rmTempDir(FAKE_STORE);
});

// ── the account that was asked for ───────────────────────────────────────────

describe("signing the expired account in again", () => {
  it("refreshes it on its own slot, keeping its alias, with one `cswap add`", async () => {
    freshMachine();
    // Spelled as the row might not: the check is case-insensitive.
    const child = await waiting("Work.Acct@Example.invalid");
    expect(child.args).toEqual(["auth", "login", "--email", "Work.Acct@Example.invalid"]);
    browserSignedIn(WORK);
    exitsSignedIn(child);

    const state = await settled();
    expect(state.state).toBe("done");
    expect(state.wrongAccount).toBeNull();
    expect(state.account).toEqual({ num: "2", email: WORK.email, added: false });
    // One add, with nothing that would move the account (`--slot`) or rename
    // it (`--alias`): claude-swap's in-place refresh.
    expect(adds()).toEqual([["add"]]);
    const seq = readSeq();
    expect(Object.keys(seq.accounts)).toEqual(["1", "2"]);
    expect(seq.accounts["2"]).toMatchObject({ email: WORK.email, organizationUuid: WORK.organizationUuid, alias: "work", refreshedAt: "now" });
    expect(seq.accounts["1"]).toEqual(HOME_ACCT);
    // And the account the user was on is back in front, live login included.
    expect(switches()).toEqual([["switch", "1"]]);
    expect(seq.activeAccountNumber).toBe(1);
    expect(liveEmail()).toBe(HOME_ACCT.email);
    expect(state.restored).toBe(true);
  });

  it("keeps the deck's own record of the account, keyed by who it is and not by slot", async () => {
    freshMachine();
    const child = await waiting(WORK.email);
    browserSignedIn(WORK);
    exitsSignedIn(child);
    await settled();

    // What the deck keeps about an account — where it came from and when it
    // was last signed in, which closes its expired-login incident — is keyed by
    // (email, organization). The sign-in reports the same identity, as a
    // refresh and not an addition.
    expect(told).toEqual([{ email: WORK.email, org: WORK.organizationUuid, added: false }]);
    const key = accountKey(WORK.email, WORK.organizationUuid);
    const before = { accounts: { [key]: { origin: "ccdeck_signin", signedInAt: 1000, dismissed: 1000 } } };
    const after = withSignIn({ ...told[0], now: 5000 })(before);
    expect(Object.keys(after.accounts)).toEqual([key]);
    expect(after.accounts[key]).toEqual({ origin: "ccdeck_signin", signedInAt: 5000 });
  });
});

// ── somebody else ────────────────────────────────────────────────────────────

describe("a sign-in for one account that comes back as another", () => {
  it("records nothing, puts the machine back, and says who signed in", async () => {
    freshMachine();
    const stored = readFileSync(SEQ, "utf8");
    const child = await waiting(WORK.email);
    browserSignedIn(OTHER);
    exitsSignedIn(child);

    const state = await settled();
    expect(state.state).toBe("failed");
    expect(state.wrongAccount).toEqual({ signedIn: OTHER.email, wanted: WORK.email });
    // Left on the stage that found it, with the fixed clause for anything that
    // reads only `error` — the same words the reason map has.
    expect(state.step).toBe("confirm");
    expect(state.error).toBe(REASONS.wrong_account);
    expect(state.account).toBeNull();
    // No add, and nothing about the store changed: no slot for the other
    // account, the expired one untouched.
    expect(adds()).toEqual([]);
    expect(JSON.parse(readFileSync(SEQ, "utf8"))).toEqual(JSON.parse(stored));
    expect(told).toEqual([]);
    // `claude auth login` had put the other account live; the restore is what
    // took it off. The store still said slot 1, so the store alone would have
    // called it "already back".
    expect(switches()).toEqual([["switch", "1"]]);
    expect(liveEmail()).toBe(HOME_ACCT.email);
    expect(state.restored).toBe(true);
  });

  it("refuses the same way when the other account is one the deck already holds", async () => {
    freshMachine();
    const stored = readFileSync(SEQ, "utf8");
    const child = await waiting(WORK.email);
    // The account the user is on — the easiest one to pick by mistake.
    browserSignedIn(HOME_ACCT);
    exitsSignedIn(child);

    const state = await settled();
    expect(state.state).toBe("failed");
    expect(state.wrongAccount).toEqual({ signedIn: HOME_ACCT.email, wanted: WORK.email });
    expect(adds()).toEqual([]);
    expect(readFileSync(SEQ, "utf8")).toBe(stored);
    // Already the live account: nothing to switch.
    expect(switches()).toEqual([]);
    expect(state.restored).toBe(true);
  });

  it("refuses a pasted code that signed in as somebody else, on the request itself", async () => {
    freshMachine();
    const child = await waiting(WORK.email);
    const verdict = submitLoginCode("ABC-123");
    browserSignedIn(OTHER);
    child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING, stderr: "" });

    expect(await verdict).toMatchObject({
      ok: false, reason: "wrong_account", state: "failed",
      wrongAccount: { signedIn: OTHER.email, wanted: WORK.email },
    });
    expect(adds()).toEqual([]);
    expect(switches()).toEqual([["switch", "1"]]);
  }, 10_000);

  it("is said in the reader's language, naming both accounts", async () => {
    const wrongAccount = { signedIn: OTHER.email, wanted: WORK.email };
    expect(wrongAccountText({ state: "failed", wrongAccount }))
      .toBe(`You signed in as ${OTHER.email}, so nothing was saved. ${WORK.email} still needs a new sign-in.`);
    setLanguage("de");
    const de = wrongAccountText({ state: "failed", wrongAccount })!;
    expect(de).toContain(OTHER.email);
    expect(de).toContain(WORK.email);
    expect(de).not.toContain("You signed in");
    // The server's fixed clause has a translation too, for a surface that
    // reads only `error`.
    expect(loginErrorText(REASONS.wrong_account)).not.toBe(REASONS.wrong_account);
    setLanguage("en");
    // Only for the ending it describes.
    expect(wrongAccountText({ state: "registering", wrongAccount })).toBeNull();
    expect(wrongAccountText({ state: "failed", wrongAccount: null })).toBeNull();
  });
});

// ── the sign-ins that end without one ────────────────────────────────────────

describe("a cancelled or failed re-sign-in", () => {
  it("writes nothing when cancelled while waiting", async () => {
    freshMachine();
    const stored = readFileSync(SEQ, "utf8");
    const child = await waiting(WORK.email);
    expect(await cancelLogin()).toMatchObject({ ok: true, state: "idle", restored: true });
    expect(child.killed).toBe(true);
    expect(adds()).toEqual([]);
    expect(switches()).toEqual([]);
    expect(readFileSync(SEQ, "utf8")).toBe(stored);
  });

  it("puts the live login back when the cancel arrives after the browser signed somebody in", async () => {
    freshMachine();
    const child = await waiting(WORK.email);
    // Approved in the browser — the live login has moved — and Escape is
    // pressed before the CLI's exit is read.
    browserSignedIn(OTHER);
    expect(await cancelLogin()).toMatchObject({ ok: true, state: "idle", restored: true });
    expect(child.killed).toBe(true);
    expect(adds()).toEqual([]);
    expect(switches()).toEqual([["switch", "1"]]);
    expect(liveEmail()).toBe(HOME_ACCT.email);
  });

  it("writes nothing when the CLI fails", async () => {
    freshMachine();
    const stored = readFileSync(SEQ, "utf8");
    const child = await waiting(WORK.email);
    child.end({ ok: false, code: 1, killed: false, timedOut: false, stdout: GREETING, stderr: REFUSED });

    const state = await settled();
    expect(state.state).toBe("failed");
    expect(state.error).toBe("Login failed: Request failed with status code 400");
    expect(state.wrongAccount).toBeNull();
    expect(adds()).toEqual([]);
    expect(readFileSync(SEQ, "utf8")).toBe(stored);
  });
});

// ── the plain Add ────────────────────────────────────────────────────────────

describe("a sign-in with no account asked for", () => {
  it("takes whoever signs in, as it always did", async () => {
    freshMachine();
    const child = await waiting();
    expect(child.args).toEqual(["auth", "login"]);
    browserSignedIn(OTHER);
    exitsSignedIn(child);

    const state = await settled();
    expect(state.state).toBe("done");
    expect(state.wrongAccount).toBeNull();
    expect(state.account).toEqual({ num: "3", email: OTHER.email, added: true });
    expect(adds()).toEqual([["add"]]);
    expect(readSeq().accounts["3"]).toMatchObject({ email: OTHER.email });
    expect(switches()).toEqual([["switch", "1"]]);
    expect(liveEmail()).toBe(HOME_ACCT.email);
  });
});
