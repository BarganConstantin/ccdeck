// The accounts panel named the wrong account as active.
//
// sequence.json's activeAccountNumber moves only when a cswap command switches.
// A `/login` in Claude Code signs another account in without touching it, so
// the panel kept marking the previous account while `cswap list` and Claude
// Code's /status both named the new one — and Switch on the new one did
// nothing, because cswap saw it was already on it.
//
// claude-login.mjs reads who Claude Code is signed in as and matches it to a
// slot the way `cswap list` does. The first half of this file is that module
// on its own; the second is the roster over a real store in a temp
// CLAUDE_SWAP_BACKUP, with a real .claude.json beside it, and exec.mjs replaced
// so nothing is ever spawned.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs server module, no types
import { activeFrom, claudeGlobalConfigPath, readLiveLogin, slotOfLogin } from "../../server/claude-login.mjs";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-active-login-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_SWAP_BACKUP", "CLAUDE_CONFIG_DIR",
  "AGENTS_DECK_CSWAP", "AGENTS_DECK_CLAUDE"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
// No CLAUDE_CONFIG_DIR: the login is read from ~/.claude.json, where it is on
// a machine nobody has configured.
delete process.env.CLAUDE_CONFIG_DIR;
process.env.AGENTS_DECK_CSWAP = join(DIR, "no-such-cswap");
process.env.AGENTS_DECK_CLAUDE = join(DIR, "no-such-claude");

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (k !== "CLAUDE_CONFIG_DIR" && !inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

const STORE = join(DIR, "cswap");
const LOGIN = join(DIR, ".claude.json");

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
  return {
    ...real,
    run: async () => okay,
    runDetached: () => {},
    pathLookup: (name: string) => `/usr/bin/${name}`,
  };
});

type Account = { email: string; organizationUuid?: string | null };
type Row = { num: number; email: string; active: boolean };
type Roster = { ok: boolean; accounts: Row[]; activeNum?: number | null; unlistedLogin?: string | null };
type Accounts = {
  fetchClaudeAccounts: (o?: { force?: boolean }) => Promise<Roster>;
  activeAccountUsage: () => Promise<{ num: number; email: string } | null>;
  expiredSwitchTarget: (num: number) => Promise<{ reason: string } | null>;
};

const ALICE = { email: "alice@x", organizationUuid: "org-a" };
const BOB = { email: "bob@x", organizationUuid: "org-b" };

const NOW_S = () => Math.floor(Date.now() / 1000);

/** A usage row claude-swap collected a minute ago, with nothing due. */
const collected = (who: Account, extra: Record<string, unknown> = {}) => ({
  ...who,
  fetchedAt: NOW_S() - 60,
  nextPollAt: NOW_S() + 3600,
  consecutiveFailures: 0,
  lastGood: {
    five_hour: { pct: 80, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() },
    seven_day: { pct: 30, resets_at: new Date(Date.now() + 4 * 86400_000).toISOString() },
  },
  ...extra,
});

/** sequence.json and cache/usage.json as claude-swap writes them. */
function seed({ accounts, usage = {}, active }: {
  accounts: Record<number, Account>;
  usage?: Record<number, unknown>;
  active: number | null;
}) {
  rmTempDir(STORE);
  mkdirSync(join(STORE, "cache"), { recursive: true });
  writeFileSync(join(STORE, "sequence.json"), JSON.stringify({ activeAccountNumber: active, accounts }));
  writeFileSync(join(STORE, "cache", "usage.json"), JSON.stringify({ schemaVersion: 2, accounts: usage }));
}

/** Claude Code's global config, signed in as `who` — or nobody. */
function signIn(who: Account | null) {
  rmSync(LOGIN, { force: true });
  if (who) {
    writeFileSync(LOGIN, JSON.stringify({
      numStartups: 4,
      oauthAccount: { emailAddress: who.email, organizationUuid: who.organizationUuid, accountUuid: "u-1" },
    }));
  }
}

async function freshAccounts(): Promise<Accounts> {
  vi.resetModules();
  return await import("../../server/claude-accounts.mjs") as unknown as Accounts;
}

beforeEach(() => signIn(null));

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k]!;
  }
  rmTempDir(DIR);
});

/** A stat that answers from a table, the way node's would. */
function statOf(files: Record<string, { size?: number; mode?: number; dir?: boolean; mtimeMs?: number }>) {
  return async (path: string) => {
    const f = files[path];
    if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { isFile: () => !f.dir, size: f.size ?? 0, mode: f.mode ?? 0o100644, mtimeMs: f.mtimeMs ?? 0 };
  };
}

describe("claudeGlobalConfigPath, which config file Claude Code is signed in through", () => {
  const home = "/home/u";
  const at = (files: Parameters<typeof statOf>[0], env: Record<string, string> = {}) =>
    claudeGlobalConfigPath({ env, home, platform: "linux", statFile: statOf(files) });

  it("is ~/.claude.json on a machine with nothing configured", async () => {
    expect(await at({})).toBe("/home/u/.claude.json");
  });

  it("moves into CLAUDE_CONFIG_DIR when that is set", async () => {
    expect(await at({}, { CLAUDE_CONFIG_DIR: "/srv/claude" })).toBe("/srv/claude/.claude.json");
  });

  it("is the legacy .config.json while it holds anything", async () => {
    expect(await at({ "/home/u/.claude/.config.json": { size: 120 }, "/home/u/.claude.json": { size: 900 } }))
      .toBe("/home/u/.claude/.config.json");
    expect(await at({ "/srv/claude/.config.json": { size: 120 } }, { CLAUDE_CONFIG_DIR: "/srv/claude" }))
      .toBe("/srv/claude/.config.json");
  });

  it("takes an empty legacy file only when it is writable and there is no global one", async () => {
    // claude-swap's _pick_global_config, which is Claude Code's own choice.
    expect(await at({ "/home/u/.claude/.config.json": { size: 0 } })).toBe("/home/u/.claude/.config.json");
    expect(await at({ "/home/u/.claude/.config.json": { size: 0 }, "/home/u/.claude.json": { size: 900 } }))
      .toBe("/home/u/.claude.json");
    expect(await at({ "/home/u/.claude/.config.json": { size: 0, mode: 0o100444 } })).toBe("/home/u/.claude.json");
  });

  it("ignores a legacy path that is not a file", async () => {
    expect(await at({ "/home/u/.claude/.config.json": { dir: true, size: 4096 } })).toBe("/home/u/.claude.json");
  });

  it("builds Windows paths on Windows", async () => {
    expect(await claudeGlobalConfigPath({ env: {}, home: "C:\\Users\\u", platform: "win32", statFile: statOf({}) }))
      .toBe("C:\\Users\\u\\.claude.json");
  });
});

describe("readLiveLogin, who Claude Code is signed in as", () => {
  // A new mtime per read, so each is a file that changed since the last.
  let written = 0;
  const reading = (text: string | null) => readLiveLogin({
    env: {}, home: "/home/u", platform: "linux",
    statFile: statOf(text == null ? {} : { "/home/u/.claude.json": { size: text.length, mtimeMs: ++written } }),
    read: async (path: string) => {
      if (text == null || path !== "/home/u/.claude.json") throw new Error("ENOENT");
      return text;
    },
  });

  it("answers the email and organization of oauthAccount", async () => {
    expect(await reading(JSON.stringify({ oauthAccount: { emailAddress: "bob@x", organizationUuid: "org-b" } })))
      .toEqual({ email: "bob@x", orgUuid: "org-b" });
  });

  it("reads a file that starts with a byte-order mark", async () => {
    expect(await reading(`\uFEFF${JSON.stringify({ oauthAccount: { emailAddress: "bob@x", organizationUuid: "org-b" } })}`))
      .toEqual({ email: "bob@x", orgUuid: "org-b" });
  });

  it("calls a login with no organization \"\", as claude-swap does", async () => {
    expect(await reading(JSON.stringify({ oauthAccount: { emailAddress: "bob@x" } }))).toEqual({ email: "bob@x", orgUuid: "" });
    expect(await reading(JSON.stringify({ oauthAccount: { emailAddress: "bob@x", organizationUuid: null } })))
      .toEqual({ email: "bob@x", orgUuid: "" });
  });

  it("reads the file again only once it has changed", async () => {
    let reads = 0;
    const file = { "/home/u/.claude.json": { size: 64, mtimeMs: 5_000 } };
    const once = (text: string) => readLiveLogin({
      env: {}, home: "/home/u", platform: "linux", statFile: statOf(file),
      read: async () => { reads += 1; return text; },
    });
    expect(await once(JSON.stringify({ oauthAccount: { emailAddress: "bob@x" } }))).toEqual({ email: "bob@x", orgUuid: "" });
    expect(await once(JSON.stringify({ oauthAccount: { emailAddress: "erin@x" } }))).toEqual({ email: "bob@x", orgUuid: "" });
    expect(reads).toBe(1);
    file["/home/u/.claude.json"].mtimeMs = 6_000;
    expect(await once(JSON.stringify({ oauthAccount: { emailAddress: "erin@x" } }))).toEqual({ email: "erin@x", orgUuid: "" });
    expect(reads).toBe(2);
  });

  it("answers null when there is nobody to read", async () => {
    expect(await reading(null)).toBeNull();
    expect(await reading("{ not json")).toBeNull();
    expect(await reading(JSON.stringify({ numStartups: 3 }))).toBeNull();
    expect(await reading(JSON.stringify({ oauthAccount: { emailAddress: "" } }))).toBeNull();
  });
});

describe("slotOfLogin and activeFrom, the slot `cswap list` would mark", () => {
  const seq = {
    activeAccountNumber: 14,
    accounts: { 9: BOB, 14: ALICE, 20: { email: "bob@x", organizationUuid: "org-c" }, 21: { email: "dan@x" } },
  };

  it("matches the email and the organization exactly", () => {
    expect(slotOfLogin(seq, { email: "bob@x", orgUuid: "org-b" })).toBe("9");
    expect(slotOfLogin(seq, { email: "bob@x", orgUuid: "org-c" })).toBe("20");
    expect(slotOfLogin(seq, { email: "BOB@x", orgUuid: "org-b" })).toBeNull();
    expect(slotOfLogin(seq, { email: "bob@x", orgUuid: "" })).toBeNull();
  });

  it("matches a slot with no organization to a login with none", () => {
    expect(slotOfLogin(seq, { email: "dan@x", orgUuid: "" })).toBe("21");
    // A key that is there but null is not "", in claude-swap either.
    expect(slotOfLogin({ accounts: { 3: { email: "dan@x", organizationUuid: null } } }, { email: "dan@x", orgUuid: "" }))
      .toBeNull();
  });

  it("names the signed-in slot over the stored one", () => {
    expect(activeFrom(seq, { email: "bob@x", orgUuid: "org-b" })).toEqual({ num: "9", unlisted: null, source: "login" });
  });

  it("names no slot, and says whose login it is, for an account claude-swap does not hold", () => {
    expect(activeFrom(seq, { email: "erin@x", orgUuid: "org-e" })).toEqual({ num: null, unlisted: "erin@x", source: "login" });
  });

  it("falls back to the stored number only when there is no login to read", () => {
    expect(activeFrom(seq, null)).toEqual({ num: "14", unlisted: null, source: "store" });
    expect(activeFrom({ ...seq, activeAccountNumber: null }, null)).toEqual({ num: null, unlisted: null, source: "store" });
    expect(activeFrom(null, null)).toEqual({ num: null, unlisted: null, source: "store" });
  });
});

describe("the roster after a sign-in claude-swap did not make", () => {
  it("marks the account Claude Code is signed in as, not the one sequence.json last recorded", async () => {
    // The report: the store still says 14, a /login made 9 the live one.
    seed({ accounts: { 9: BOB, 14: ALICE }, active: 14 });
    signIn(BOB);
    const roster = await (await freshAccounts()).fetchClaudeAccounts({ force: true });
    expect(roster.accounts.map(a => [a.num, a.active])).toEqual([[9, true], [14, false]]);
    expect(roster.activeNum).toBe(9);
    expect(roster.unlistedLogin).toBeNull();
  });

  it("follows the login on the panel's next poll, with nothing in the store changed", async () => {
    seed({ accounts: { 9: BOB, 14: ALICE }, active: 14 });
    signIn(ALICE);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const accounts = await freshAccounts();
      expect((await accounts.fetchClaudeAccounts()).activeNum).toBe(14);
      signIn(BOB);
      vi.setSystemTime(Date.now() + 15_000);
      expect((await accounts.fetchClaudeAccounts()).activeNum).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks nobody, and names the login, when claude-swap does not hold it", async () => {
    seed({ accounts: { 9: BOB, 14: ALICE }, active: 14 });
    signIn({ email: "erin@x", organizationUuid: "org-e" });
    const roster = await (await freshAccounts()).fetchClaudeAccounts({ force: true });
    expect(roster.accounts.map(a => a.active)).toEqual([false, false]);
    expect(roster.activeNum).toBeNull();
    expect(roster.unlistedLogin).toBe("erin@x");
  });

  it("keeps the stored number when Claude Code's config names nobody", async () => {
    seed({ accounts: { 9: BOB, 14: ALICE }, active: 14 });
    const roster = await (await freshAccounts()).fetchClaudeAccounts({ force: true });
    expect(roster.activeNum).toBe(14);
    expect(roster.unlistedLogin).toBeNull();
  });
});

describe("what else reads the active account", () => {
  it("gives the Usage panel the signed-in account's numbers, and nobody's for an unlisted login", async () => {
    seed({ accounts: { 9: BOB, 14: ALICE }, usage: { 9: collected(BOB), 14: collected(ALICE) }, active: 14 });
    signIn(BOB);
    expect(await (await freshAccounts()).activeAccountUsage()).toMatchObject({ num: 9, email: "bob@x" });
    signIn({ email: "erin@x", organizationUuid: "org-e" });
    expect(await (await freshAccounts()).activeAccountUsage()).toBeNull();
  });

  it("guards a switch onto the stale stored slot, and not onto the signed-in one", async () => {
    // Slot 14's stored login was refused. Before, 14 counted as active, so a
    // switch onto it was "already there" and went to cswap unguarded.
    const refused = { consecutiveFailures: 2, lastError: "invalid_grant", lastAttemptAt: NOW_S() - 30, fetchedAt: NOW_S() - 7200 };
    seed({ accounts: { 9: BOB, 14: ALICE }, usage: { 9: collected(BOB, refused), 14: collected(ALICE, refused) }, active: 14 });
    signIn(BOB);
    const accounts = await freshAccounts();
    expect(await accounts.expiredSwitchTarget(14)).toMatchObject({ reason: "login_expired" });
    expect(await accounts.expiredSwitchTarget(9)).toBeNull();
  });
});
