// #2184: never switch onto a login that already expired.
//
// Every Claude Code session on a machine shares one login, so `cswap switch N`
// onto a slot whose stored refresh token is dead stops every running session
// within seconds ("Login expired · Please run /login"). It was three of seven
// interruptions in a month on the owner's machine. On 2026-10-12 the deck's own
// Switch put slot 5 live at 17:36:28; claude-swap's last good read of it was
// 17:26:27, its poll was overdue, and the invalid_grant that proved it dead was
// recorded at 17:36:29 — one second after.
//
// So the switch reads claude-swap's store first, asks for a collection when one
// would read the target, and refuses only on evidence: a dead-login error on
// the slot's own row, newer than its last good read and its last sign-in.
// Anything it cannot tell lets the switch go ahead, as before.
//
// exec.mjs's `run` is a script, AGENTS_DECK_CSWAP names a path that does not
// exist, and the store is a temp CLAUDE_SWAP_BACKUP with fake accounts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import AccountRow from "../components/AccountRow";
import { type Account } from "../claude-accounts";
import { COMMAND_REASONS, explainCommandFailure } from "../admin-failure";
import { STILL_EXPIRED, afterRemoval, expiredSwitch } from "../expired-switch";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-dead-login-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_CSWAP", "AGENTS_DECK_CLAUDE"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
process.env.AGENTS_DECK_CSWAP = join(DIR, "no-such-cswap");
process.env.AGENTS_DECK_CLAUDE = join(DIR, "no-such-claude");

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

const STORE = join(DIR, "cswap");

// `onList` is what claude-swap's collection does to the store while it runs,
// `list` what it prints, and `hold` a promise every list waits on.
const { proc } = vi.hoisted(() => ({
  proc: {
    calls: [] as string[][],
    list: { ok: true } as Record<string, unknown>,
    onList: null as null | (() => void),
    hold: null as null | Promise<void>,
  },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
  return {
    ...real,
    run: async (_cmd: string, args: string[] = []) => {
      proc.calls.push(args);
      if (args[0] === "list") {
        if (proc.hold) await proc.hold;
        proc.onList?.();
        return { ...okay, stdout: JSON.stringify({ accounts: [] }), ...proc.list };
      }
      return okay;
    },
    runDetached: (_cmd: string, args: string[] = []) => { proc.calls.push(args); },
  };
});

// @ts-expect-error — plain .mjs server module, no types
const guard = await import("../../server/login-guard.mjs");
// @ts-expect-error — plain .mjs server module, no types
const accounts = await import("../../server/claude-accounts.mjs");

const SEC = 1000;
const MIN = 60 * SEC;
const nowS = () => Math.floor(Date.now() / 1000);
const ran = (first: string) => proc.calls.filter(a => a[0] === first);
const acct = (n: number) => ({ email: `user${n}@example.test`, organizationUuid: `org-${n}`, alias: n === 3 ? "work" : undefined });

/** A row claude-swap read well a minute ago, with nothing due. */
const healthy = (n: number, over: Record<string, unknown> = {}) => ({
  ...acct(n),
  fetchedAt: nowS() - 60,
  lastAttemptAt: nowS() - 60,
  nextPollAt: nowS() + 600,
  consecutiveFailures: 0,
  lastError: null,
  authDeadStrikes: 0,
  lastGood: { five_hour: { pct: 10 }, seven_day: { pct: 5 } },
  ...over,
});
/** A row whose last refresh was refused — claude-swap's quarantine, as the
 *  owner's store spells it. */
const struck = (n: number, over: Record<string, unknown> = {}) => healthy(n, {
  fetchedAt: nowS() - 20 * MIN / SEC,
  lastAttemptAt: nowS() - 19 * MIN / SEC,
  consecutiveFailures: 1,
  lastError: "invalid_grant",
  authDeadStrikes: 1,
  struckFingerprint: "f".repeat(16),
  backoffUntil: nowS() - 18 * MIN / SEC,
  ...over,
});

function seed(rows: Record<number, unknown>, active = 1) {
  rmTempDir(STORE);
  mkdirSync(join(STORE, "cache"), { recursive: true });
  writeFileSync(join(STORE, "sequence.json"), JSON.stringify({
    activeAccountNumber: active,
    sequence: [1, 2, 3],
    accounts: { 1: acct(1), 2: acct(2), 3: acct(3) },
  }));
  writeUsage(rows);
}
function writeUsage(rows: Record<number, unknown>) {
  writeFileSync(join(STORE, "cache", "usage.json"), JSON.stringify({ schemaVersion: 2, accounts: rows }));
}
function readUsage() {
  return JSON.parse(readFileSync(join(STORE, "cache", "usage.json"), "utf8")).accounts;
}

beforeEach(() => {
  proc.calls.length = 0;
  proc.list = { ok: true };
  proc.onList = null;
  proc.hold = null;
  accounts.accountOriginsWith(null);
});

afterAll(() => {
  accounts.accountOriginsWith(null);
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k]!;
  }
  rmTempDir(DIR);
});

describe("what counts as a login known to be dead", () => {
  const matches = true;

  it("is claude-swap's strike, or its two permanent refusals on a failing row", () => {
    expect(guard.deadLoginOf(struck(2), { matches })).toMatchObject({ error: "invalid_grant" });
    // A store written before the strike count existed still says it in words.
    expect(guard.deadLoginOf(struck(2, { authDeadStrikes: undefined }), { matches })).toMatchObject({ error: "invalid_grant" });
    expect(guard.deadLoginOf(struck(2, { authDeadStrikes: 0, lastError: "no_refresh_token" }), { matches }))
      .toMatchObject({ error: "no_refresh_token" });
  });

  it("is never a transient failure, which says nothing about the login either way", () => {
    for (const lastError of ["http-429", "timeout", "network", "transient", "refresh-failed", "http-401", "consume-busy"]) {
      expect(guard.deadLoginOf(struck(2, { authDeadStrikes: 0, lastError }), { matches }), lastError).toBeNull();
    }
    expect(guard.deadLoginOf(healthy(2), { matches })).toBeNull();
  });

  it("is never a row left by somebody else, or no row at all", () => {
    expect(guard.deadLoginOf(struck(2), { matches: false })).toBeNull();
    expect(guard.deadLoginOf(null, { matches })).toBeNull();
    expect(guard.deadLoginOf(undefined, { matches })).toBeNull();
  });

  it("stops being one once the login has been read well, or signed in again, since", () => {
    const row = struck(2);
    expect(guard.deadLoginOf({ ...row, fetchedAt: row.lastAttemptAt + 5 }, { matches })).toBeNull();
    const failedMs = row.lastAttemptAt * 1000;
    expect(guard.deadLoginOf(row, { matches, signedInAt: failedMs + 1000 })).toBeNull();
    // A sign-in from before the refusal is about the login that was refused.
    expect(guard.deadLoginOf(row, { matches, signedInAt: failedMs - 1000 })).toMatchObject({ since: failedMs });
  });
});

describe("whether a collection asked for now would read the target", () => {
  const now = Date.now();
  const matches = true;

  it("is claude-swap's own on-demand rule: older than three minutes and past its plan", () => {
    expect(guard.collectionWouldRead(healthy(2, { fetchedAt: nowS() - 600, nextPollAt: nowS() - 30 }), { matches, now })).toBe(true);
    // The 2026-10-12 row: read ten minutes earlier, its poll 27 seconds overdue.
    expect(guard.collectionWouldRead(healthy(2, { fetchedAt: nowS() - 601, nextPollAt: nowS() - 27 }), { matches, now })).toBe(true);
    expect(guard.collectionWouldRead(healthy(2, { fetchedAt: nowS() - 600, nextPollAt: null }), { matches, now })).toBe(true);
  });

  it("is not, for a row read inside the serve TTL or one whose plan is not due", () => {
    expect(guard.collectionWouldRead(healthy(2, { fetchedAt: nowS() - 60, nextPollAt: nowS() - 30 }), { matches, now })).toBe(false);
    expect(guard.collectionWouldRead(healthy(2, { fetchedAt: nowS() - 600, nextPollAt: nowS() + 60 }), { matches, now })).toBe(false);
  });

  it("is not, for a struck row, one in backoff or one another collector has claimed", () => {
    const due = { fetchedAt: nowS() - 600, nextPollAt: nowS() - 30 };
    expect(guard.collectionWouldRead(struck(2, due), { matches, now })).toBe(false);
    expect(guard.collectionWouldRead(healthy(2, { ...due, backoffUntil: nowS() + 60 }), { matches, now })).toBe(false);
    expect(guard.collectionWouldRead(healthy(2, { ...due, claimUntil: nowS() + 60 }), { matches, now })).toBe(false);
  });

  it("is, for an account claude-swap has no row of its own for yet", () => {
    expect(guard.collectionWouldRead(undefined, { matches: false, now })).toBe(true);
    expect(guard.collectionWouldRead(healthy(2), { matches: false, now })).toBe(true);
  });
});

describe("a switch onto an account whose stored login is dead", () => {
  it("is refused before claude-swap is asked, naming the account", async () => {
    seed({ 1: healthy(1), 2: healthy(2), 3: struck(3) });
    const out = await accounts.switchClaudeAccount(3);
    expect(out).toMatchObject({
      ok: false,
      reason: "login_expired",
      account: { num: 3, email: "user3@example.test", alias: "work" },
      error: "invalid_grant",
    });
    expect(ran("switch"), "cswap switch ran onto a dead login").toEqual([]);
    // A struck row is never read again by claude-swap, so nothing was spent on it.
    expect(ran("list")).toEqual([]);
  });

  it("goes ahead for a healthy account, with no collection when one would read nothing", async () => {
    seed({ 1: healthy(1), 2: healthy(2), 3: struck(3) });
    expect(await accounts.switchClaudeAccount(2)).toMatchObject({ ok: true });
    expect(ran("switch")).toEqual([["switch", "2"]]);
    expect(ran("list")).toEqual([]);
  });

  it("asks claude-swap to read a target that is due first, and refuses what that finds", async () => {
    // 2026-10-12, replayed: the row looks healthy but is overdue, and the
    // collection is what discovers the refresh token is dead.
    seed({ 1: healthy(1), 2: healthy(2, { fetchedAt: nowS() - 600, lastAttemptAt: nowS() - 600, nextPollAt: nowS() - 27 }) });
    proc.onList = () => writeUsage({ ...readUsage(), 2: struck(2, { lastAttemptAt: nowS() }) });
    const out = await accounts.switchClaudeAccount(2);
    expect(out).toMatchObject({ ok: false, reason: "login_expired", account: { num: 2 } });
    expect(ran("list")).toEqual([["list", "--json"]]);
    expect(ran("switch")).toEqual([]);
  });

  it("goes ahead when that collection reads the target well", async () => {
    seed({ 1: healthy(1), 2: healthy(2, { fetchedAt: nowS() - 600, lastAttemptAt: nowS() - 600, nextPollAt: nowS() - 27 }) });
    proc.onList = () => writeUsage({ ...readUsage(), 2: healthy(2) });
    expect(await accounts.switchClaudeAccount(2)).toMatchObject({ ok: true });
    expect(proc.calls.map(a => a[0])).toEqual(["list", "switch"]);
  });

  it("is not asked about the account that is already active", async () => {
    seed({ 1: struck(1), 2: healthy(2) }, 1);
    expect(await accounts.switchClaudeAccount(1)).toMatchObject({ ok: true });
    expect(ran("switch")).toEqual([["switch", "1"]]);
  });
});

describe("a switch the check cannot judge", () => {
  it("goes ahead on a transient failure", async () => {
    seed({ 1: healthy(1), 2: struck(2, { authDeadStrikes: 0, lastError: "http-429" }) });
    expect(await accounts.switchClaudeAccount(2)).toMatchObject({ ok: true });
    expect(ran("switch")).toEqual([["switch", "2"]]);
  });

  it("goes ahead when the usage file will not parse, or is a schema it does not know", async () => {
    seed({});
    writeFileSync(join(STORE, "cache", "usage.json"), "{ not json");
    expect(await accounts.switchClaudeAccount(2)).toMatchObject({ ok: true });
    writeFileSync(join(STORE, "cache", "usage.json"), JSON.stringify({ schemaVersion: 3, accounts: { 2: struck(2) } }));
    expect(await accounts.switchClaudeAccount(2)).toMatchObject({ ok: true });
    expect(ran("switch")).toEqual([["switch", "2"], ["switch", "2"]]);
  });

  it("goes ahead when the collection fails, offline or otherwise", async () => {
    seed({ 1: healthy(1), 2: healthy(2, { fetchedAt: nowS() - 600, nextPollAt: nowS() - 27 }) });
    proc.list = { ok: false, code: 1, stdout: "", stderr: "network unreachable" };
    expect(await accounts.switchClaudeAccount(2)).toMatchObject({ ok: true });
    expect(ran("switch")).toEqual([["switch", "2"]]);
  });

  it("does not wait on a collection longer than it said it would", async () => {
    seed({ 1: healthy(1), 2: healthy(2, { fetchedAt: nowS() - 600, nextPollAt: nowS() - 27 }) });
    const started = Date.now();
    const asked = await accounts.readBeforeSwitch(2, { collect: () => new Promise(() => {}), waitMs: 40 });
    expect(asked).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("goes ahead for a row that belongs to the slot's previous occupant", async () => {
    seed({ 1: healthy(1), 2: struck(2, { email: "someone-else@acme.example" }) });
    // Due, too: claude-swap has no row of its own for this account yet.
    expect(await accounts.switchClaudeAccount(2)).toMatchObject({ ok: true });
    expect(ran("switch")).toEqual([["switch", "2"]]);
  });
});

describe("signing in again", () => {
  it("clears the verdict the moment claude-swap clears the row", async () => {
    seed({ 1: healthy(1), 2: struck(2) });
    expect(await accounts.switchClaudeAccount(2)).toMatchObject({ reason: "login_expired" });
    // `cswap add`, an import, or the deck's own sign-in all lift the strike
    // (usage_store.clear_dead_token) — and nothing else is needed here.
    writeUsage({ 1: healthy(1), 2: healthy(2, { fetchedAt: nowS() - 20 * 60, lastError: null, consecutiveFailures: 0, authDeadStrikes: 0 }) });
    proc.calls.length = 0;
    expect(await accounts.switchClaudeAccount(2)).toMatchObject({ ok: true });
    expect(ran("switch")).toEqual([["switch", "2"]]);
  });

  it("through the deck counts even before claude-swap has written anything", async () => {
    seed({ 1: healthy(1), 2: struck(2) });
    const row = struck(2);
    accounts.accountOriginsWith({
      entries: () => ({ "user2@example.test@@org-2": { origin: "ccdeck_signin", signedInAt: row.lastAttemptAt * 1000 + 5_000 } }),
    });
    expect(await accounts.switchClaudeAccount(2)).toMatchObject({ ok: true });
  });
});

describe("removing the active account", () => {
  const roster = (over: Record<number, Partial<Account> & Record<string, unknown>>) => ({
    ok: true,
    accounts: [1, 2, 3, 4].map(num => ({
      num, email: `user${num}@example.test`, alias: null, active: num === 1, disabled: false,
      alive: true, staleCopy: false, stopped: false, error: null, collector: null,
      stale: false, headroom: 50, ...over[num],
    })),
  });
  const deps = (r: unknown, switches: Record<number, unknown> = {}) => {
    const order: string[] = [];
    return {
      order,
      roster: async () => { order.push("roster"); return r; },
      remove: async (n: number) => { order.push(`remove ${n}`); return { ok: true, output: "Removed" }; },
      switchTo: async (n: number) => { order.push(`switch ${n}`); return switches[n] ?? { ok: true }; },
    };
  };

  it("moves Claude Code to the working account with the most room once an expired one is gone", async () => {
    const d = deps(roster({
      1: { alive: false, error: "invalid_grant" },
      2: { headroom: 20 }, 3: { headroom: 70, alias: "work" }, 4: { headroom: 90, disabled: true },
    }));
    const out = await guard.removeLeavingLiveLogin(1, d);
    expect(out).toMatchObject({ ok: true, movedTo: { num: 3, alias: "work" } });
    // Read before it is gone, removed, and only then moved: after the removal
    // the dead login belongs to no slot, so claude-swap activates the target
    // directly instead of refusing to back the empty login up.
    expect(d.order).toEqual(["roster", "remove 1", "switch 3"]);
  });

  it("tries the next account when the first is refused for its own expired login", async () => {
    const d = deps(roster({ 1: { alive: false, error: "invalid_grant" }, 2: { headroom: 80 }, 3: { headroom: 40 }, 4: { headroom: 10 } }),
      { 2: { ok: false, reason: "login_expired" } });
    expect(await guard.removeLeavingLiveLogin(1, d)).toMatchObject({ ok: true, movedTo: { num: 3 } });
    expect(d.order).toEqual(["roster", "remove 1", "switch 2", "switch 3"]);
  });

  it("says when nothing could take over, and does not walk on past another kind of refusal", async () => {
    const none = deps(roster({ 1: { alive: false, error: "no_refresh_token" }, 2: { alive: false }, 3: { stopped: true }, 4: { disabled: true } }));
    expect(await guard.removeLeavingLiveLogin(1, none)).toMatchObject({ ok: true, stillExpired: true });
    expect(none.order).toEqual(["roster", "remove 1"]);

    const broke = deps(roster({ 1: { stopped: true, collector: "relogin_required" } }), { 2: { ok: false, reason: "no_cswap" } });
    expect(await guard.removeLeavingLiveLogin(1, broke)).toMatchObject({ ok: true, stillExpired: true });
    expect(broke.order.filter(s => s.startsWith("switch"))).toHaveLength(1);
  });

  it("leaves a working login where it is, and moves nothing for any other account", async () => {
    for (const [num, over] of [[1, {}], [1, { alive: false, staleCopy: true }], [2, {}], [2, { error: "invalid_grant" }]] as const) {
      const d = deps(roster({ [num]: over }));
      const out = await guard.removeLeavingLiveLogin(num, d);
      expect(out, JSON.stringify(over)).toEqual({ ok: true, output: "Removed" });
      expect(d.order).toEqual(["roster", `remove ${num}`]);
    }
  });

  it("moves nothing when the removal itself was refused, or the roster could not be read", async () => {
    const refused = deps(roster({ 1: { alive: false, error: "invalid_grant" } }));
    refused.remove = async () => ({ ok: false, reason: "not_confirmed" }) as never;
    expect(await guard.removeLeavingLiveLogin(1, refused)).toEqual({ ok: false, reason: "not_confirmed" });
    expect(refused.order).toEqual(["roster"]);

    const blind = deps(null);
    blind.roster = async () => { throw new Error("store unreadable"); };
    expect(await guard.removeLeavingLiveLogin(1, blind)).toEqual({ ok: true, output: "Removed" });
  });

  it("goes through the switch route's own path, guard and bookkeeping included", () => {
    const routes = readFileSync(new URL("../../server/account-routes.mjs", import.meta.url), "utf8");
    expect(routes).toMatch(/case "remove":\s+result = await removeAccount\(admin, parsed\.account\); break;/);
    expect(routes).toMatch(/switchTo: async n => \(await switchAndTell\(n, accounts\)\)\[1\]/);
  });
});

describe("what the panel says", () => {
  const NOW = 1_800_000_000;
  const row = (over: Partial<Account> = {}): Account => ({
    num: 3, email: "user3@example.test", alias: "work", org: null, active: false, disabled: false,
    lanes: [], headroom: 50, fetchedAt: (NOW - 60) * 1000, nextAt: null, stale: false, error: null, ...over,
  });
  const draw = (a: Account, refusal: unknown, onSignIn?: (email: string | null) => void) => renderToStaticMarkup(createElement(AccountRow, {
    a, nowSec: NOW, opened: false, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
    onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal,
    onDismissRefusal: () => {}, onSignIn, switchedHere: false, swapped: null, displaced: undefined,
    issueExpanded: false, onOpenIssue: () => {},
  } as never));
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

  it("names the account the deck would not switch to, and how to fix it", () => {
    expect(expiredSwitch({ reason: "login_expired" }, "work", 3))
      .toEqual({ text: "work's login expired · sign in again to use it", row: 3, signIn: true });
    expect(expiredSwitch({ reason: "switch_failed" }, "work", 3)).toBeNull();
    expect(expiredSwitch(null, "work", 3)).toBeNull();
    // A surface with only the reason still has a sentence for it.
    expect(explainCommandFailure({ reason: "login_expired" }, "the switch failed")).toBe(COMMAND_REASONS.login_expired);
    expect(COMMAND_REASONS.login_expired).toMatch(/login expired/);
  });

  it("says it on the row, as an alert, with the sign-in beside it", () => {
    const html = draw(row(), expiredSwitch({ reason: "login_expired" }, "work", 3), () => {});
    const box = /<div class="ap-failure ap-row-failure" role="alert">[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    expect(text(box)).toContain("work's login expired · sign in again to use it");
    expect(box).toMatch(/<button type="button" class="ap-fix ap-failure-fix" aria-label="Sign in again as user3@example\.test"[^>]*>\s*Sign in again\s*<\/button>/);
    expect(box).toContain('aria-label="Dismiss this message"');
  });

  it("offers no sign-in for any other refusal, or where the panel wired none", () => {
    const other = draw(row(), { text: "claude-swap refused the switch", row: 3 }, () => {});
    expect(other).not.toContain("ap-failure-fix");
    const unwired = draw(row(), expiredSwitch({ reason: "login_expired" }, "work", 3));
    expect(unwired).not.toContain("ap-failure-fix");
    expect(text(unwired)).toContain("work's login expired");
  });

  it("does not offer Switch on a row the roster already knows is expired", () => {
    const html = draw(row({ error: "invalid_grant" }), null, () => {});
    expect(html).not.toContain('class="ap-switch"');
    expect(text(html)).toContain("Login expired");
  });

  it("says what a removal of an expired live account did", () => {
    expect(afterRemoval({ ok: true, movedTo: { num: 3, email: "user3@example.test", alias: "work" } }))
      .toEqual({ switched: { num: 3, name: "work" } });
    expect(afterRemoval({ ok: true, movedTo: { num: 2, email: "user2@example.test", alias: null } }))
      .toEqual({ switched: { num: 2, name: "user2@example.test" } });
    expect(afterRemoval({ ok: true, stillExpired: true })).toEqual({ failure: { text: STILL_EXPIRED } });
    expect(afterRemoval({ ok: true })).toBeNull();
    expect(afterRemoval({ ok: false, stillExpired: true })).toBeNull();
  });

  it("wires the sign-in to the dialog, filled in with that account", () => {
    const panel = readFileSync(new URL("../components/AccountsPanel.tsx", import.meta.url), "utf8");
    expect(panel).toMatch(/onDismissRefusal=\{\(\) => clearFailure\(\)\} onSignIn=\{signInAgain\}/);
    expect(panel).toMatch(/<AddAccountDialog\s+email=\{signInAs\}/);
  });
});
