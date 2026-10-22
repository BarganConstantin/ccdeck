// Leaving an expired login, beside the deck's own rules: the home account and
// the soonest weekly reset (cswap-auto-choice.mjs).
//
// The failover (autoswitch-failover.mjs) and the rules came separately, and
// each assumed the other was not there. Three places where they meet:
//
//   - the rules keep their cooldown by answering the engine's dry run with
//     "cooldown" — and a tick answered so never reached the failover, so a
//     user whose login died within five minutes of a move stayed on it;
//   - the rules never land on an account claude-swap has set aside, or on one
//     a local `cswap run` session is using, and the failover has to skip the
//     same two: the first is another dead login, the second puts one rotating
//     refresh token in two places;
//   - where the failover leaves the user is a tick's pick. Unrecorded, the
//     next tick read it as a switch made by hand, which the rules then leave
//     alone until it fills.
//
// The real loop runs. claude-swap answers every tick "could not read the
// active account"; the roster, the CLI and the switch are stand-ins; the
// engine's state and session files are real files in a temp store. HOME, the
// deck's data and the store all point inside one temp directory, checked
// before anything is imported.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-failover-rules-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CLAUDE_SWAP_BACKUP", "CCDECK_HOME", "AGENTS_DECK_NO_LAN"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.AGENTS_DECK_NO_LAN = "1";
const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ["HOME", "CLAUDE_SWAP_BACKUP", "CCDECK_HOME"] as const) if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}`);
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

const ROOT = join(DIR, "cswap");

type Row = Record<string, unknown>;

const { proc } = vi.hoisted(() => ({
  proc: {
    calls: [] as string[][],
    roster: [] as Row[],
    switches: [] as { num: number; force: boolean }[],
  },
}));

const CONFIG = [
  "autoswitch.threshold          90      (default)",
  "autoswitch.intervalSeconds    60      (default)",
  "autoswitch.cooldownSeconds    300     (default)",
  "autoswitch.strategy           best    (default)",
  "autoswitch.model              (none)  (default)",
].join("\n");

// claude-swap: its settings, and an engine that could not read the active
// account — on the dry run and on the real one alike.
vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    proc.calls.push([cmd, ...args]);
    const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
    if (args[0] === "config") return { ...okay, stdout: CONFIG };
    if (args[0] === "auto") {
      return {
        ...okay,
        stdout: [
          JSON.stringify({ event: "poll", active: { number: 2, email: "account-2@b.c" }, threshold: 90 }),
          JSON.stringify({ event: "no-switch", reason: "active-usage-unknown", detail: "1/3 before failover" }),
        ].join("\n"),
      };
    }
    return okay;
  },
  runDetached: () => {},
  pathLookup: (name: string) => `/usr/bin/${name}`,
}));

vi.mock("../../server/lan-deck.mjs", () => ({
  lanEngine: { status: () => ({ peers: [] }) },
}));

// The store as the roster reads it, and a `cswap switch` that records itself.
vi.mock("../../server/claude-accounts.mjs", async importOriginal => ({
  ...(await importOriginal<typeof import("../../server/claude-accounts.mjs")>()),
  fetchClaudeAccounts: async () => ({ ok: true, accounts: proc.roster.map(r => ({ ...r })) }),
  switchClaudeAccount: async (num: number, { before, force = false }: { before?: () => Promise<string | null>; force?: boolean } = {}) => {
    const skipped = before ? await before() : null;
    if (skipped) return { ok: false, skipped };
    proc.switches.push({ num, force });
    return { ok: true, output: "" };
  },
}));

// Claude Code says nobody is signed in: what "Login expired" leaves behind.
vi.mock("../../server/claude-identity.mjs", async importOriginal => ({
  ...(await importOriginal<typeof import("../../server/claude-identity.mjs")>()),
  cliSignIn: async () => ({ loggedIn: false }),
}));

/** A roster row as fetchClaudeAccounts publishes it, usable by default. */
const row = (num: number, over: Row = {}): Row => ({
  num, email: `account-${num}@b.c`, orgUuid: `org-${num}`, active: false, disabled: false, alive: true,
  staleCopy: false, stopped: false, stale: false, headroom: 60, ...over,
});
/** The active account, its stored login gone, nothing read for it. */
const DEAD = row(2, { active: true, alive: false, headroom: null, error: "invalid_grant" });

/** claude-swap's own state file, as its engine writes it. */
function writeEngineState(state: { lastSwitchAt?: number; quarantine?: Record<string, { email: string }> }) {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "autoswitch_state.json"), JSON.stringify(state));
}

/** A `cswap run` session on account `num`, in the profile claude-swap made for it. */
function writeSession(num: number, pid: number) {
  const dir = join(ROOT, "sessions", `${num}-account-${num}_b.c`, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: "s", cwd: "/w", startedAt: Date.now() }));
}

const readChoiceFile = () => JSON.parse(readFileSync(join(DIR, "deck", "auto-choice.json"), "utf8"));
const realRuns = () => proc.calls.filter(c => c[1] === "auto" && !c.includes("--dry-run")).length;
const rest = (ms: number) => new Promise(r => setTimeout(r, ms));

type Tick = { event: string; switched?: boolean; trigger?: string | null; reason?: string | null; stuck?: boolean; to?: { number: number } | null } | null;
type Auto = {
  setAutoEnabled: (on: boolean) => Promise<unknown>;
  autoStatus: () => Promise<{ lastTick: Tick }>;
  setNextChoice: (v: unknown) => Promise<{ ok: boolean; reason?: string }>;
};
let auto: Auto;

/** One deck-managed tick, waited out. */
async function tickOnce() {
  const before = (await auto.autoStatus()).lastTick;
  await auto.setAutoEnabled(true);
  for (let i = 0; i < 400 && (await auto.autoStatus()).lastTick === before; i++) await rest(5);
  await auto.setAutoEnabled(false);
  await rest(50);
  return (await auto.autoStatus()).lastTick;
}

beforeEach(async () => {
  proc.calls.length = 0;
  proc.switches.length = 0;
  proc.roster = [DEAD, row(3, { headroom: 80 }), row(4, { headroom: 40 })];
  rmTempDir(ROOT);
  rmTempDir(join(DIR, "deck"));
  vi.resetModules();
  auto = await import("../../server/cswap-auto.mjs") as unknown as Auto;
});

afterEach(async () => { await auto.setAutoEnabled(false); });

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(DIR);
});

describe("an expired login with the weekly rule set", () => {
  it("is left even inside the cooldown of a recent move", async () => {
    // claude-swap switched a minute ago; the deck keeps that cooldown for its
    // own moves. The login that switch landed on has since died.
    writeEngineState({ lastSwitchAt: Math.floor(Date.now() / 1000) - 60 });
    await auto.setNextChoice("weekly");
    const tick = await tickOnce();
    expect(realRuns()).toBe(1);
    expect(proc.switches).toEqual([{ num: 3, force: true }]);
    expect(tick).toMatchObject({ event: "switch", switched: true, trigger: "login-expired", to: { number: 3 } });
  });

  it("is never left for an account claude-swap has set aside", async () => {
    writeEngineState({ quarantine: { "3": { email: "account-3@b.c" } } });
    await auto.setNextChoice("weekly");
    await tickOnce();
    expect(proc.switches).toEqual([{ num: 4, force: true }]);
  });

  it("is never left for an account a `cswap run` session is working on", async () => {
    writeSession(3, process.pid);
    await auto.setNextChoice("weekly");
    await tickOnce();
    expect(proc.switches).toEqual([{ num: 4, force: true }]);
  });

  it("says it is stuck when every account that could take over is held back", async () => {
    writeEngineState({ quarantine: { "3": { email: "account-3@b.c" } } });
    writeSession(4, process.pid);
    await auto.setNextChoice("weekly");
    const tick = await tickOnce();
    expect(proc.switches).toEqual([]);
    expect(tick).toMatchObject({ event: "no-switch", reason: "login-expired", stuck: true });
  });

  it("records where the failover went as a tick's pick, not one made by hand", async () => {
    await auto.setNextChoice("weekly");
    await tickOnce();
    expect(proc.switches).toEqual([{ num: 3, force: true }]);
    expect(readChoiceFile()).toMatchObject({ next: "weekly", manual: false, lastActive: "account-3@b.c@@org-3" });
  });
});

describe("an expired login with nothing set", () => {
  it("skips the same held-back accounts", async () => {
    writeEngineState({ quarantine: { "3": { email: "account-3@b.c" } } });
    await tickOnce();
    expect(proc.switches).toEqual([{ num: 4, force: true }]);
  });
});
