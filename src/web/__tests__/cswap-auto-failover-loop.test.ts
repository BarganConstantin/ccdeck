// The deck's auto-switch loop leaving an active login that has died.
//
// `cswap auto --once` builds a new engine per run, so the engine's own failover
// — three unreadable polls in a row, counted on the instance — never fires under
// the deck: every tick says `active-usage-unknown 1/3`. Here the real loop runs
// against a claude-swap that answers exactly that, every time, and the store,
// the CLI and the switch are stand-ins: the loop has to finish the decision
// itself, through the same lock, and stand down if it is turned off meanwhile.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { state } = vi.hoisted(() => ({
  state: {
    signedIn: { loggedIn: false } as unknown,
    switches: [] as number[],
    forced: [] as boolean[],
    enabledAtSwitch: [] as (string | null)[],
    activeAlive: false,
    elsewhere: new Map<string, string[]>(),
  },
}));

// claude-swap: config answers nothing, and every tick could not read the active account.
vi.mock("../../server/exec.mjs", () => ({
  run: async (_cmd: string, args: string[] = []) => {
    const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
    if (args[0] === "config") return { ...okay, stdout: "{}" };
    if (args[0] === "auto") {
      return {
        ...okay,
        stdout: [
          JSON.stringify({ event: "poll", active: { number: 2, email: "dead@x.com" }, threshold: 90 }),
          JSON.stringify({ event: "no-switch", reason: "active-usage-unknown", detail: "1/3 before failover" }),
        ].join("\n"),
      };
    }
    return okay;
  },
  runDetached: () => {},
}));

vi.mock("../../server/claude-accounts.mjs", () => ({
  invalidateClaudeAccountsCache: () => {},
  backupRoot: () => "/nonexistent",
  fetchClaudeAccounts: async () => ({
    ok: true,
    accounts: [
      { num: 2, email: "dead@x.com", active: true, alive: state.activeAlive, staleCopy: false, headroom: null },
      { num: 3, email: "spare@x.com", active: false, alive: true, staleCopy: false, stale: false, stopped: false, disabled: false, headroom: 70 },
    ],
  }),
  switchClaudeAccount: async (num: number, { before, force = false }: { before?: () => Promise<string | null>; force?: boolean } = {}) => {
    const skipped = before ? await before() : null;
    state.enabledAtSwitch.push(skipped);
    if (skipped) return { ok: false, skipped };
    state.switches.push(num);
    state.forced.push(force);
    return { ok: true, output: "" };
  },
}));

// Which of this deck's logins a paired deck is on right now (#2192).
vi.mock("../../server/lan-elsewhere.mjs", async importOriginal => ({
  ...(await importOriginal() as Record<string, unknown>),
  elsewhereNow: () => state.elsewhere,
}));

vi.mock("../../server/claude-identity.mjs", () => ({
  cliSignIn: async () => state.signedIn,
  currentIdentity: async () => null,
}));

const HOME = mkdtempSync(join(tmpdir(), "cswap-auto-failover-"));
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const mod = await import("../../server/cswap-auto.mjs");
const { accountKey } = await import("../../server/lan-copies.mjs");
const rest = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeEach(async () => {
  state.signedIn = { loggedIn: false };
  state.switches.length = 0;
  state.forced.length = 0;
  state.enabledAtSwitch.length = 0;
  state.activeAlive = false;
  state.elsewhere = new Map();
  mod.invalidateCswapAutoCache();
  await mod.setAutoEnabled(false);
});

afterEach(async () => { await mod.setAutoEnabled(false); });

afterAll(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmTempDir(HOME);
});

describe("a tick that cannot read an active login that has died", () => {
  // First: a switch in this file starts the failover's five-minute cooldown,
  // which would hold this tick still for the wrong reason.
  it("does not move onto a login a paired deck is on right now, and says it has nowhere to go", async () => {
    state.elsewhere = new Map([[accountKey("spare@x.com", undefined), ["iMac"]]]);
    await mod.setAutoEnabled(true);
    await rest(80);
    expect(state.switches).toEqual([]);
    const { lastTick } = await mod.autoStatus();
    expect(lastTick).toMatchObject({ event: "no-switch", reason: "login-expired", stuck: true });
  });

  it("switches to an account that can be used, and reports why", async () => {
    await mod.setAutoEnabled(true);
    await rest(80);
    expect(state.switches).toEqual([3]);
    // Forced: Claude Code has cleared the dead login, and a plain switch refuses to back up an empty one.
    expect(state.forced).toEqual([true]);
    const { lastTick } = await mod.autoStatus();
    expect(lastTick).toMatchObject({
      event: "switch", switched: true, trigger: "login-expired",
      from: { number: 2 }, to: { number: 3 },
    });
  });

  it("does nothing the engine did not, while the CLI is still signed in or the stored copy lives", async () => {
    state.signedIn = { loggedIn: true, email: "dead@x.com" };
    await mod.setAutoEnabled(true);
    await rest(80);
    await mod.setAutoEnabled(false);
    state.signedIn = { loggedIn: false };
    state.activeAlive = true;
    await mod.setAutoEnabled(true);
    await rest(80);
    expect(state.switches).toEqual([]);
    const { lastTick } = await mod.autoStatus();
    expect(lastTick).toMatchObject({ event: "no-switch", reason: "active-usage-unknown" });
  });
});
