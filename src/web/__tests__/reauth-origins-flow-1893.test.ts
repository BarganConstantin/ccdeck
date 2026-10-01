// #1893, driven: the moments the deck learns where an account came from, and
// the roster read that turns what it learned into an incident.
//
// reauth-prompt-1893.test.ts pins the rules as functions. This runs the real
// flows they hang off — a sign-in through `claude auth login` and `cswap add`,
// a removal through `cswap remove`, a roster read of a sequence.json and a
// usage.json — with every process faked and the store in a temp directory, in
// the sandbox restore-active-verdict-951.test.ts builds for the same module:
// this is the code that signs accounts in and out, and nothing in it may reach
// the store of whoever runs the suite.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
import { spawnedArgv } from "./spawned-argv";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-1893-home-"));
const FAKE_STORE = mkdtempSync(join(tmpdir(), "ccdeck-1893-store-"));
const SEQ = join(FAKE_STORE, "sequence.json");
const ENV_KEYS = [
  "HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "CCDECK_HOME",
  "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_CLAUDE", "AGENTS_DECK_CSWAP",
] as const;
const prevEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");
process.env.XDG_CONFIG_HOME = join(FAKE_HOME, ".config");
process.env.CCDECK_HOME = join(FAKE_HOME, "ccdeck");
process.env.CLAUDE_SWAP_BACKUP = FAKE_STORE;
process.env.AGENTS_DECK_CLAUDE = join(FAKE_HOME, "no-such-claude");
process.env.AGENTS_DECK_CSWAP = join(FAKE_HOME, "no-such-cswap");

// ── the fakes ────────────────────────────────────────────────────────────────

const AUTHORIZE = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&state=s";
const GREETING = `Opening browser to sign in…\nIf the browser didn't open, visit: ${AUTHORIZE}\nPaste code here if prompted > `;

const fake = vi.hoisted(() => {
  type Sub = (line: string, partial: boolean) => void;
  const children: any[] = [];
  let waiting: ((c: any) => void) | null = null;
  function spawn(argv: string[]) {
    let settle!: (r: any) => void;
    const subs: Sub[] = [];
    const child = {
      argv,
      done: new Promise((r) => { settle = r; }),
      onLine(cb: Sub) { subs.push(cb); },
      write(text: string) { child.written.push(text); if (argv[0] === "remove") settle(OK); },
      written: [] as string[],
      kill() {},
      say(line: string) { for (const s of subs) s(line, false); },
      end(r: unknown) { settle(r); },
    };
    children.push(child);
    if (argv[0] === "remove") {
      // What `cswap remove 2` asks before it does anything, answered by the
      // module with "y" — which is what settles this child above.
      queueMicrotask(() => child.say(`Are you sure you want to permanently remove account-${argv[1]}? [y/N] `));
    }
    waiting?.(child);
    waiting = null;
    return child;
  }
  const OK = { ok: true, code: 0, killed: false, timedOut: false, stdout: "removed", stderr: "" };
  function next(i: number): Promise<any> {
    return children[i] ? Promise.resolve(children[i]) : new Promise((res) => { waiting = res; });
  }
  return { spawn, next, children };
});

const cli = vi.hoisted(() => ({
  identity: null as null | { email: string },
  onAdd: (() => true) as () => boolean,
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, any>>();
  const ok = (stdout = "") => ({ ok: true, code: 0, killed: false, timedOut: false, stdout, stderr: "" });
  return {
    ...real,
    runInteractive: (cmd: string, args: string[]) => {
      const verb = spawnedArgv({ file: cmd, args }).slice(1);
      if ((verb[0] === "auth" && verb[1] === "login") || verb[0] === "remove") return fake.spawn(verb);
      throw new Error(`refusing to run \`${verb.join(" ")}\` for real`);
    },
    run: async (cmd: string, args: string[]) => {
      const verb = spawnedArgv({ file: cmd, args }).slice(1);
      if (verb[0] === "auth" && verb[1] === "status") {
        return ok(JSON.stringify(cli.identity ? { loggedIn: true, email: cli.identity.email } : { loggedIn: false }));
      }
      if (verb[0] === "add") {
        return cli.onAdd() ? ok("added") : { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "no\n" };
      }
      return ok("");
    },
    runDetached: () => {},
  };
});

// @ts-expect-error — plain JS module, no types
const admin = await import("../../server/cswap-admin.mjs");
// @ts-expect-error — plain JS module, no types
const accounts = await import("../../server/claude-accounts.mjs");
// @ts-expect-error — plain JS module, no types
const { accountKey } = await import("../../server/lan-copies.mjs");

// ── the store, proven to be the sandbox's before anything runs ──────────────

type Slot = { email: string; organizationUuid?: string };
const store = (slots: Record<string, Slot>, active: number | null) =>
  writeFileSync(SEQ, JSON.stringify({ activeAccountNumber: active, accounts: slots }));
const usage = (rows: Record<string, Record<string, unknown>>) => {
  mkdirSync(join(FAKE_STORE, "cache"), { recursive: true });
  writeFileSync(join(FAKE_STORE, "cache", "usage.json"), JSON.stringify({ schemaVersion: 2, accounts: rows }));
};

store({ 1: { email: "sandbox@example.invalid" } }, 1);
if (!homedir().startsWith(FAKE_HOME)) throw new Error(`refusing to run: homedir() is ${homedir()}`);
{
  const seen = await admin.readStore();
  if (seen.emails["1"] !== "sandbox@example.invalid") throw new Error("refusing to run: the store resolved outside the sandbox");
}

const OLD = "was.here@example.invalid";
const WORK = "work@example.invalid";

/** Everything the deck was told, in order. */
const told: Array<[string, unknown]> = [];
const hooks = {
  signedIn: async (d: unknown) => { told.push(["signedIn", d]); },
  removed: async (d: unknown) => { told.push(["removed", d]); },
};

async function settled(timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = admin.loginState();
    if (s.state === "done" || s.state === "failed" || s.state === "idle" || Date.now() >= until) break;
    await new Promise(r => setTimeout(r, 10));
  }
  await admin.withStoreLock(async () => {});
  return admin.loginState();
}

/** A sign-in the CLI finishes on its own, as `who`. `added` writes the slot
 *  `cswap add` creates; without it the add refreshes an account in place. */
async function signIn(who: string, after: Record<string, Slot>) {
  const nth = fake.children.length;
  const start = admin.startLogin();
  const child = await fake.next(nth);
  child.say(GREETING);
  await start;
  cli.identity = { email: who };
  cli.onAdd = () => { store(after, 2); return true; };
  child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING, stderr: "" });
  return settled();
}

vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  told.length = 0;
  admin.accountOriginsWith(hooks);
  store({ 1: { email: OLD, organizationUuid: "org-old" } }, 1);
  cli.identity = { email: OLD };
});

afterEach(async () => {
  await admin.cancelLogin();
  for (const c of fake.children) c.end({ ok: false, code: -1, killed: true, timedOut: false, stdout: "", stderr: "" });
  fake.children.length = 0;
  admin.accountOriginsWith(null);
  accounts.accountOriginsWith(null);
});

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
  rmTempDir(FAKE_STORE);
});

// ── where an account came from ──────────────────────────────────────────────

describe("what a sign-in tells the deck", () => {
  it("reports an account the sign-in added, with the identity claude-swap recorded", async () => {
    const state = await signIn(WORK, {
      1: { email: OLD, organizationUuid: "org-old" },
      2: { email: WORK, organizationUuid: "org-work" },
    });
    expect(state).toMatchObject({ state: "done", account: { num: "2", email: WORK, added: true } });
    expect(told).toEqual([["signedIn", { email: WORK, org: "org-work", added: true }]]);
  });

  it("reports a re-sign-in of an account already in the store as not added", async () => {
    store({ 1: { email: OLD, organizationUuid: "org-old" }, 2: { email: WORK, organizationUuid: "org-work" } }, 1);
    const state = await signIn(WORK, {
      1: { email: OLD, organizationUuid: "org-old" },
      2: { email: WORK, organizationUuid: "org-work" },
    });
    // Same slot, same alias and history: claude-swap refreshed it in place.
    expect(state).toMatchObject({ state: "done", account: { num: "2", email: WORK, added: false } });
    expect(told).toEqual([["signedIn", { email: WORK, org: "org-work", added: false }]]);
  });

  it("reports nothing for a sign-in claude-swap did not record", async () => {
    const nth = fake.children.length;
    const start = admin.startLogin();
    const child = await fake.next(nth);
    child.say(GREETING);
    await start;
    cli.identity = { email: WORK };
    cli.onAdd = () => false;
    child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING, stderr: "" });
    expect((await settled()).state).toBe("failed");
    expect(told).toEqual([]);
  });

  it("still finishes the sign-in when the deck cannot keep the note", async () => {
    admin.accountOriginsWith({ signedIn: async () => { throw new Error("prefs.json is not writable"); } });
    const state = await signIn(WORK, {
      1: { email: OLD, organizationUuid: "org-old" },
      2: { email: WORK, organizationUuid: "org-work" },
    });
    expect(state).toMatchObject({ state: "done", account: { email: WORK, added: true } });
  });

  it("is told only by the sign-in and the removal — never by a share or Local network", () => {
    // Every way an account arrives other than + → Sign in goes through
    // importAccount (the paste box) or lan-deck.mjs (a round); neither tells
    // the deck where the account came from, so neither can give it the mark.
    const source = readFileSync(fileURLToPath(new URL("../../server/cswap-admin.mjs", import.meta.url)), "utf8");
    const calls = [...source.matchAll(/tellOrigins\("(\w+)"/g)].map(m => m[1]);
    expect(calls).toEqual(["signedIn", "removed"]);
    const lan = readFileSync(fileURLToPath(new URL("../../server/lan-deck.mjs", import.meta.url)), "utf8");
    expect(lan).not.toMatch(/withSignIn|accountOriginsWith|tellOrigins/);
  });
});

describe("what a removal tells the deck", () => {
  it("names the account the slot held, read before it went", async () => {
    store({ 1: { email: OLD, organizationUuid: "org-old" }, 2: { email: WORK, organizationUuid: "org-work" } }, 1);
    const out = await admin.removeAccount(2);
    expect(out).toMatchObject({ ok: true });
    expect(told).toEqual([["removed", { email: WORK, org: "org-work" }]]);
  });
});

// ── the roster ──────────────────────────────────────────────────────────────

describe("what the roster says about each account", () => {
  const sec = Math.floor(Date.now() / 1000);
  const KEY = accountKey(WORK, "org-work");
  const SHARED = "shared@example.invalid";

  beforeEach(() => {
    store({
      1: { email: OLD, organizationUuid: "org-old" },
      2: { email: WORK, organizationUuid: "org-work" },
      3: { email: SHARED, organizationUuid: "" },
    }, 1);
    const dead = { consecutiveFailures: 2, lastError: "invalid_grant", fetchedAt: sec - 3600, lastAttemptAt: sec - 60, nextPollAt: sec + 3600 };
    usage({
      1: { email: OLD, organizationUuid: "org-old", consecutiveFailures: 0, lastError: null, fetchedAt: sec - 60, lastAttemptAt: sec - 60, nextPollAt: sec + 3600, lastGood: {} },
      2: { email: WORK, organizationUuid: "org-work", ...dead },
      3: { email: SHARED, organizationUuid: "", ...dead },
    });
    accounts.invalidateClaudeAccountsCache();
  });

  const read = async () => {
    accounts.invalidateClaudeAccountsCache();
    const r = await accounts.fetchClaudeAccounts({ force: true });
    return Object.fromEntries(r.accounts.map((a: { email: string }) => [a.email, a]));
  };

  it("marks the deck's own sign-in and names its incident, and leaves a shared account alone", async () => {
    const signedInAt = (sec - 7200) * 1000;
    accounts.accountOriginsWith({ entries: () => ({ [KEY]: { origin: "ccdeck_signin", signedInAt } }), recovered: () => {} });
    const rows = await read();
    expect(rows[WORK]).toMatchObject({ origin: "ccdeck_signin", error: "invalid_grant" });
    expect(rows[WORK].reauth).toEqual({ key: KEY, since: (sec - 3600) * 1000, dismissed: false });
    // Refused the same way, but the deck did not sign it in.
    expect(rows[SHARED]).toMatchObject({ origin: null, reauth: null, error: "invalid_grant" });
    expect(rows[OLD]).toMatchObject({ origin: null, reauth: null });
  });

  it("says nothing about an incident when the refusal came before the last sign-in", async () => {
    accounts.accountOriginsWith({ entries: () => ({ [KEY]: { origin: "ccdeck_signin", signedInAt: sec * 1000 } }), recovered: () => {} });
    const rows = await read();
    expect(rows[WORK]).toMatchObject({ origin: "ccdeck_signin", reauth: null });
  });

  it("carries a put-off, and tells the deck once the account reads well after it", async () => {
    const since = (sec - 3600) * 1000;
    const seen: string[][] = [];
    accounts.accountOriginsWith({
      entries: () => ({ [KEY]: { origin: "ccdeck_signin", signedInAt: since - 1000, dismissed: since } }),
      recovered: (keys: string[]) => { seen.push(keys); },
    });
    expect((await read())[WORK].reauth).toEqual({ key: KEY, since, dismissed: true });
    expect(seen).toEqual([]);

    // A good read after the incident: claude-swap cleared its failure.
    const healthy = JSON.parse(readFileSync(join(FAKE_STORE, "cache", "usage.json"), "utf8"));
    healthy.accounts[2] = { ...healthy.accounts[2], consecutiveFailures: 0, lastError: null, fetchedAt: sec - 5, lastAttemptAt: sec - 5 };
    usage(healthy.accounts);
    const rows = await read();
    expect(rows[WORK].reauth).toBeNull();
    expect(seen).toEqual([[KEY]]);
  });

  it("has no origins at all until the server hands them in", async () => {
    const rows = await read();
    expect(rows[WORK]).toMatchObject({ origin: null, reauth: null });
  });

  it("survives an origins source that throws", async () => {
    accounts.accountOriginsWith({ entries: () => { throw new Error("boom"); }, recovered: () => {} });
    const rows = await read();
    expect(rows[WORK]).toMatchObject({ origin: null, reauth: null, error: "invalid_grant" });
  });
});
