// Auto-switch leaving an active login that has died.
//
// Under the deck, claude-swap's engine runs once per process (`cswap auto
// --once`), and its failover counts unreadable polls on the engine instance: the
// count is 1 on every tick, the threshold is 3, and the user stays on a login
// that cannot answer. The deck finishes that one decision itself. What is pinned
// here is mostly when it must NOT: every one of the three signals alone has a
// known false alarm, so the switch needs all three, and a target has to be an
// account claude-swap can still use, under the threshold.
import { describe, it, expect, vi } from "vitest";
import {
  deadActiveRow, engineLostActive, failOver, failoverTargets, FAILOVER_COOLDOWN_MS,
} from "../../server/autoswitch-failover.mjs";

type Row = Record<string, unknown>;

/** A roster row as fetchClaudeAccounts publishes it, healthy by default. */
const row = (num: number, over: Row = {}): Row => ({
  num, email: `a${num}@x.com`, active: false, disabled: false, alive: true,
  staleCopy: false, stopped: false, stale: false, headroom: 60, ...over,
});

/** The active account, its stored login gone. */
const DEAD = row(2, { active: true, alive: false, error: "invalid_grant" });

/** A tick that could not read the active account, as summarise leaves it. */
const lost = (reason = "active-usage-unknown") => ({ ok: true, event: "no-switch", reason, threshold: 90 });

/** failOver with every outside thing replaced. */
function deps({ accounts = [DEAD, row(3)] as Row[], cli = { loggedIn: false } as unknown, sw = { ok: true } as unknown } = {}) {
  const switchTo = vi.fn(async (_num: number, _opts: unknown) => sw);
  return {
    switchTo,
    opts: {
      roster: async () => ({ ok: true, accounts }),
      signIn: async () => cli,
      switchTo,
      now: 1_000_000,
    },
  };
}

describe("which ticks are about a lost active account", () => {
  it("is the engine's two ways of saying it could not read it, and nothing else", () => {
    expect(engineLostActive(lost("active-usage-unknown"))).toBe(true);
    expect(engineLostActive(lost("active-idle"))).toBe(true);
    for (const reason of ["below-threshold", "cooldown", "no-candidates", "active-api-key"]) {
      expect(engineLostActive(lost(reason)), reason).toBe(false);
    }
    expect(engineLostActive({ ok: true, event: "switch", reason: null })).toBe(false);
    expect(engineLostActive({ ok: false, reason: "tick_timeout" })).toBe(false);
    expect(engineLostActive(null)).toBe(false);
  });
});

describe("an active login counted as dead", () => {
  it("is one whose stored copy claude-swap says is gone", () => {
    expect(deadActiveRow([row(3), DEAD])).toBe(DEAD);
  });

  it("is never a stale copy beside a working session, nor a copy still alive (#721)", () => {
    expect(deadActiveRow([row(2, { active: true, alive: false, staleCopy: true })])).toBeNull();
    expect(deadActiveRow([row(2, { active: true, alive: true })])).toBeNull();
    expect(deadActiveRow([row(3)])).toBeNull();
    expect(deadActiveRow(null)).toBeNull();
  });
});

describe("where a failover may land", () => {
  it("is an account claude-swap can use, under the threshold, freshest reading first, then most room", () => {
    const targets = failoverTargets([
      DEAD,
      row(3, { headroom: 40 }),
      row(4, { headroom: 80, stale: true }),
      row(5, { headroom: 70 }),
    ], 90);
    expect(targets.map(t => t.num)).toEqual([5, 3, 4]);
  });

  it("is never a disabled, dead, unseen, stopped or full one", () => {
    const targets = failoverTargets([
      DEAD,
      row(3, { disabled: true }),
      row(4, { alive: false }),
      row(5, { staleCopy: true }),
      row(6, { stopped: true }),
      row(7, { headroom: null }),
      row(8, { headroom: 5 }),
    ], 90);
    expect(targets).toEqual([]);
  });

  it("reads the threshold the tick ran with, and 90 when it said none", () => {
    expect(failoverTargets([row(3, { headroom: 25 })], 80).map(t => t.num)).toEqual([3]);
    expect(failoverTargets([row(3, { headroom: 25 })], 70)).toEqual([]);
    expect(failoverTargets([row(3, { headroom: 15 })], undefined).map(t => t.num)).toEqual([3]);
  });
});

describe("failing over", () => {
  it("switches to the best account when all three signals agree, and says why", async () => {
    const { opts, switchTo } = deps({ accounts: [DEAD, row(3, { headroom: 40 }), row(4, { headroom: 70 })] });
    const before = async () => null;
    const r = await failOver(lost(), { ...opts, before });
    // Forced: the current login is the empty one, and a plain switch refuses to back it up.
    expect(switchTo).toHaveBeenCalledWith(4, { before, force: true });
    expect(r).toEqual({
      event: "switch", switched: true, trigger: "login-expired",
      from: { number: 2, email: "a2@x.com" }, to: { number: 4, email: "a4@x.com" },
    });
  });

  it("does the same for the engine's idle hold, which never times out under --once", async () => {
    const { opts, switchTo } = deps();
    expect((await failOver(lost("active-idle"), opts))?.switched).toBe(true);
    expect(switchTo).toHaveBeenCalledTimes(1);
  });

  it("leaves the tick alone when the CLI is signed in, or could not be asked", async () => {
    for (const cli of [{ loggedIn: true, email: "a2@x.com" }, { loggedIn: true, email: "other@x.com" }, null]) {
      const { opts, switchTo } = deps({ cli });
      expect(await failOver(lost(), opts), JSON.stringify(cli)).toBeNull();
      expect(switchTo).not.toHaveBeenCalled();
    }
  });

  it("leaves the tick alone when the stored copy is alive, or the roster cannot be read", async () => {
    const alive = deps({ accounts: [row(2, { active: true }), row(3)] });
    expect(await failOver(lost(), alive.opts)).toBeNull();
    const unread = deps();
    expect(await failOver(lost(), { ...unread.opts, roster: async () => ({ ok: false }) })).toBeNull();
    expect(await failOver(lost(), { ...unread.opts, roster: async () => { throw new Error("EIO"); } })).toBeNull();
    expect(alive.switchTo).not.toHaveBeenCalled();
    expect(unread.switchTo).not.toHaveBeenCalled();
  });

  it("never looks at a tick that read the active account", async () => {
    const { opts, switchTo } = deps();
    const roster = vi.fn(opts.roster);
    expect(await failOver(lost("below-threshold"), { ...opts, roster })).toBeNull();
    expect(roster).not.toHaveBeenCalled();
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("says it is stuck when no other account is ready, and moves nothing", async () => {
    const { opts, switchTo } = deps({ accounts: [DEAD, row(3, { headroom: 2 })] });
    expect(await failOver(lost(), opts)).toEqual({
      event: "no-switch", reason: "login-expired", detail: "no other account is ready", stuck: true,
      from: { number: 2, email: "a2@x.com" },
    });
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("waits out the cooldown after its last failover, so dead targets are not walked through in a minute", async () => {
    const { opts, switchTo } = deps();
    const waiting = await failOver(lost(), { ...opts, lastAt: opts.now - FAILOVER_COOLDOWN_MS + 1 });
    expect(waiting).toMatchObject({ event: "no-switch", reason: "login-expired" });
    expect(waiting?.stuck).toBeUndefined();
    expect(switchTo).not.toHaveBeenCalled();
    expect((await failOver(lost(), { ...opts, lastAt: opts.now - FAILOVER_COOLDOWN_MS }))?.switched).toBe(true);
  });

  it("reports a switch the loop stood down from, and one cswap refused", async () => {
    const off = deps({ sw: { ok: false, skipped: "disabled" } });
    expect(await failOver(lost(), off.opts)).toEqual({ event: "skipped", reason: "disabled" });
    const refused = deps({ sw: { ok: false, reason: "switch_failed", output: "locked" } });
    expect(await failOver(lost(), refused.opts)).toMatchObject({ ok: false, reason: "failover_failed", detail: "locked" });
  });
});
