// Auto-switch's two rules — a home account it comes back to, and "soonest
// weekly reset" — asked before claude-swap's engine (account-choice.mjs).
//
// Two requests met here. A user asked for the account whose weekly limit
// resets soonest, skipping any more than 95 hours away, and only while
// Auto-switch is on; another asked to come back to one account once its
// 5-hour window resets. Upstream claude-swap measured endless cycles when a
// preferred account was combined with its own reset-ordered strategy, so the
// last block drives a simulated week and counts every move.
import { describe, it, expect } from "vitest";
import {
  chooseAccount, countedModels, landable, readingCurrent, usedOf,
  ROOM_MARGIN_PCT, SETTLE_MS, WEEKLY_HORIZON_H, WEEKLY_LEAD_S,
} from "../../server/account-choice.mjs";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const H = 3600;
const sec = (ms: number) => Math.floor(ms / 1000);

type Lane = { id: string; label: string; pct: number; resetAt: number | null };
type Row = {
  num: number; key: string; email: string; active: boolean; alive: boolean; disabled: boolean;
  error: string | null; reauth: object | null; fetchedAt: number | null; lanes: Lane[];
};

/** One roster row. `five`/`week` are percentages; `weekIn` is hours to the
 *  weekly reset, `fiveIn` hours to the 5-hour one (null: no window running). */
function acct(num: number, o: Partial<Row> & { five?: number; fiveIn?: number | null; week?: number; weekIn?: number | null; model?: [string, number] } = {}): Row {
  const lanes: Lane[] = [
    { id: "five_hour", label: "5h", pct: o.five ?? 10, resetAt: o.fiveIn === undefined ? sec(NOW) + 3 * H : o.fiveIn === null ? null : sec(NOW) + o.fiveIn * H },
    { id: "seven_day", label: "7d", pct: o.week ?? 20, resetAt: o.weekIn === null ? null : sec(NOW) + (o.weekIn ?? 100) * H },
  ];
  if (o.model) lanes.push({ id: "scoped-0", label: o.model[0], pct: o.model[1], resetAt: sec(NOW) + 50 * H });
  return {
    num, key: `k${num}`, email: `a${num}@x.com`, active: false, alive: true, disabled: false,
    error: null, reauth: null, fetchedAt: NOW - 60_000, ...o, lanes: o.lanes ?? lanes,
  };
}

const base = { threshold: 90, models: [] as string[], busy: new Set<string>(), sinceMove: Infinity, cooldownMs: 300_000, optional: true, now: NOW };
const weekly = { next: "weekly", home: null, manual: false, goHome: false };
const room = { next: "room", home: null, manual: false, goHome: false };

describe("nothing set: the engine decides, exactly as before", () => {
  it("returns null for most-room with no home, whatever the roster says", () => {
    const accounts = [acct(1, { active: true, five: 99 }), acct(2, { five: 0 })];
    expect(chooseAccount({ ...base, accounts, choice: room })).toBeNull();
  });
});

describe("soonest weekly reset", () => {
  it("uses the earliest eligible weekly reset in the reported 95% roster", () => {
    const accounts = [
      acct(1, { active: true, five: 9, week: 95, weekIn: 16.25, fetchedAt: NOW - 8 * 60_000 }),
      acct(12, { five: 15, week: 25, weekIn: 118, fetchedAt: NOW - 5 * 60_000 }),
      acct(14, { five: 0, week: 24, weekIn: 70, fetchedAt: NOW - 10 * 60_000 }),
      acct(16, { five: 6, week: 45, weekIn: 125, fetchedAt: NOW - 60_000 }),
      acct(15, { five: 30, week: 49, weekIn: 83, fetchedAt: NOW - 3 * 60_000 }),
      acct(9, { five: 49, week: 65, weekIn: 91, fetchedAt: NOW - 19 * 60_000 }),
      acct(10, { five: 15, week: 99, weekIn: 52 }),
    ];
    expect(chooseAccount({ ...base, threshold: 95, accounts, choice: weekly })?.to.num).toBe(14);
  });

  it("leaving at the threshold, goes to the soonest weekly reset rather than the most room", () => {
    const accounts = [
      acct(1, { active: true, five: 92 }),
      acct(2, { five: 5, week: 10, weekIn: 90 }),
      acct(3, { five: 40, week: 60, weekIn: 20 }),
    ];
    const pick = chooseAccount({ ...base, accounts, choice: weekly });
    expect(pick?.to.num).toBe(3);
    expect(pick?.leaving).toBe(true);
    expect(pick?.trigger).toBe("weekly-reset");
  });

  it("skips accounts more than 95 hours from their weekly reset", () => {
    const accounts = [acct(1, { active: true, five: 95 }), acct(2, { weekIn: WEEKLY_HORIZON_H + 1 })];
    expect(chooseAccount({ ...base, accounts, choice: weekly })).toBeNull();
    const inside = [acct(1, { active: true, five: 95 }), acct(2, { weekIn: WEEKLY_HORIZON_H - 0.1 })];
    expect(chooseAccount({ ...base, accounts: inside, choice: weekly })?.to.num).toBe(2);
  });

  it("with nothing inside the horizon, leaves the move to the engine (most room) — never stuck", () => {
    const accounts = [acct(1, { active: true, five: 100 }), acct(2, { weekIn: 150 }), acct(3, { weekIn: 160 })];
    expect(chooseAccount({ ...base, accounts, choice: weekly })).toBeNull();
  });

  it("below the threshold, moves to an account resetting at least an hour sooner", () => {
    const accounts = [acct(1, { active: true, five: 20, weekIn: 80 }), acct(2, { weekIn: 30 })];
    const pick = chooseAccount({ ...base, accounts, choice: weekly });
    expect(pick?.to.num).toBe(2);
    expect(pick?.leaving).toBe(false);
    expect(pick?.resetAt).toBe(sec(NOW) + 30 * H);
  });

  it("does not trade places with an account resetting within the same hour", () => {
    const lead = WEEKLY_LEAD_S / H;
    const accounts = [acct(1, { active: true, five: 20, weekIn: 40 }), acct(2, { weekIn: 40 - lead / 2 })];
    expect(chooseAccount({ ...base, accounts, choice: weekly })).toBeNull();
  });

  it("does not move below the threshold when the active account's weekly reset is unknown", () => {
    const accounts = [acct(1, { active: true, five: 20, weekIn: null }), acct(2, { weekIn: 10 })];
    expect(chooseAccount({ ...base, accounts, choice: weekly })).toBeNull();
  });

  it("leaves a hand-picked account alone until it fills", () => {
    const accounts = [acct(1, { active: true, five: 20, weekIn: 80 }), acct(2, { weekIn: 30 })];
    expect(chooseAccount({ ...base, accounts, choice: { ...weekly, manual: true } })).toBeNull();
    accounts[0] = acct(1, { active: true, five: 91, weekIn: 80 });
    expect(chooseAccount({ ...base, accounts, choice: { ...weekly, manual: true } })?.to.num).toBe(2);
  });

  it("ties go to the account with more room, then the lower slot", () => {
    const accounts = [acct(1, { active: true, five: 95 }), acct(3, { five: 30, weekIn: 10 }), acct(2, { five: 10, weekIn: 10 })];
    expect(chooseAccount({ ...base, accounts, choice: weekly })?.to.num).toBe(2);
  });

  it("makes no optional move while the engine runs a strategy of its own", () => {
    const accounts = [acct(1, { active: true, five: 20, weekIn: 80 }), acct(2, { weekIn: 30 })];
    expect(chooseAccount({ ...base, accounts, choice: weekly, optional: false })).toBeNull();
    accounts[0] = acct(1, { active: true, five: 91, weekIn: 80 });
    expect(chooseAccount({ ...base, accounts, choice: weekly, optional: false })?.to.num).toBe(2);
  });
});

describe("home account", () => {
  const home = { next: "room", home: "k1", manual: false, goHome: false };

  it("comes back once home is usable again", () => {
    const accounts = [acct(1, { five: 0, fiveIn: null }), acct(2, { active: true, five: 30 })];
    const pick = chooseAccount({ ...base, accounts, choice: home });
    expect(pick?.to.num).toBe(1);
    expect(pick?.trigger).toBe("home");
  });

  it("waits while home is still over the threshold — its window has not reset", () => {
    const accounts = [acct(1, { five: 93 }), acct(2, { active: true, five: 30 })];
    expect(chooseAccount({ ...base, accounts, choice: home })).toBeNull();
  });

  it("waits for a fresh reading after home's window reset, not the number from before it", () => {
    // 5h at 95%, reset an hour ago, read before that.
    const accounts = [acct(1, { five: 95, fiveIn: -1, fetchedAt: NOW - 70 * 60_000 }), acct(2, { active: true, five: 30 })];
    expect(chooseAccount({ ...base, accounts, choice: home })).toBeNull();
  });

  it("never leaves home from under the threshold, whatever the strategy", () => {
    const accounts = [acct(1, { active: true, five: 50, weekIn: 90 }), acct(2, { weekIn: 5 })];
    expect(chooseAccount({ ...base, accounts, choice: { ...home, next: "weekly" } })).toBeNull();
  });

  it("leaving home at the threshold, the strategy picks where to", () => {
    const accounts = [acct(1, { active: true, five: 91 }), acct(2, { five: 5, weekIn: 90 }), acct(3, { five: 50, weekIn: 10 })];
    expect(chooseAccount({ ...base, accounts, choice: { ...home, next: "weekly" } })?.to.num).toBe(3);
    expect(chooseAccount({ ...base, accounts, choice: home })).toBeNull();   // most room: the engine's
  });

  it("an account at the threshold goes home first when home is usable", () => {
    const accounts = [acct(1, { five: 5 }), acct(2, { active: true, five: 95 }), acct(3, { five: 0, weekIn: 2 })];
    const pick = chooseAccount({ ...base, accounts, choice: { ...home, next: "weekly" } });
    expect(pick?.to.num).toBe(1);
    expect(pick?.leaving).toBe(true);
  });

  it("after a switch by hand, does not pull back — unless home was just set", () => {
    const accounts = [acct(1, { five: 0, fiveIn: null }), acct(2, { active: true, five: 30 })];
    expect(chooseAccount({ ...base, accounts, choice: { ...home, manual: true } })).toBeNull();
    expect(chooseAccount({ ...base, accounts, choice: { ...home, manual: true, goHome: true } })?.to.num).toBe(1);
  });

  it("skips a home that is held out, signed out, unread or on another deck", () => {
    const others = [acct(2, { active: true, five: 30 })];
    const tries = [
      acct(1, { five: 0, disabled: true }),
      acct(1, { five: 0, alive: false }),
      acct(1, { five: 0, error: "relogin_required" }),
      acct(1, { five: 0, fetchedAt: NOW - 20 * 60_000 }),
    ];
    for (const h of tries) expect(chooseAccount({ ...base, accounts: [h, ...others], choice: home })).toBeNull();
    const busy = new Set(["k1"]);
    expect(chooseAccount({ ...base, busy, accounts: [acct(1, { five: 0 }), ...others], choice: home })).toBeNull();
  });
});

describe("what a target must be", () => {
  it("sits at least the margin under the threshold, on every counted window", () => {
    const ctx = { threshold: 90, models: [] as string[], busy: new Set<string>(), now: NOW };
    expect(landable(acct(2, { five: 90 - ROOM_MARGIN_PCT - 0.1 }), ctx)).toBe(true);
    expect(landable(acct(2, { five: 90 - ROOM_MARGIN_PCT }), ctx)).toBe(false);
    expect(landable(acct(2, { week: 88 }), ctx)).toBe(false);
  });

  it("counts a model window only when the engine does", () => {
    const a = acct(2, { five: 10, model: ["Fable", 97] });
    expect(usedOf(a, [])).toBe(20);
    expect(usedOf(a, countedModels("fable"))).toBe(97);
    expect(usedOf(a, countedModels("all"))).toBe(97);
    expect(usedOf(a, countedModels("Opus, Sonnet"))).toBe(20);
  });

  it("is never an account with no 5-hour or weekly window (an API key)", () => {
    const ctx = { threshold: 90, models: [] as string[], busy: new Set<string>(), now: NOW };
    expect(landable(acct(2, { lanes: [] }), ctx)).toBe(false);
  });

  it("is never an account claude-swap has quarantined, however much room it shows", () => {
    // Its refresh token is dead, and its usage reads keep working until the
    // access token expires — so the roster still calls it healthy.
    const ctx = { threshold: 90, models: [] as string[], busy: new Set<string>(), now: NOW };
    expect(landable(acct(2, { five: 0 }), { ...ctx, quarantined: new Set(["k2"]) })).toBe(false);
    expect(landable(acct(2, { five: 0 }), { ...ctx, quarantined: new Set(["k3"]) })).toBe(true);
    const quarantined = new Set(["k1", "k3"]);
    const leaving = [acct(1, { five: 0 }), acct(2, { active: true, five: 95 }), acct(3, { weekIn: 10 }), acct(4, { weekIn: 40 })];
    expect(chooseAccount({ ...base, quarantined, accounts: leaving, choice: { ...weekly, home: "k1" } })?.to.num).toBe(4);
  });

  it("needs a reading newer than any reset it carries", () => {
    expect(readingCurrent(acct(2, { fiveIn: 1 }), [], NOW)).toBe(true);
    expect(readingCurrent(acct(2, { fiveIn: -0.1 }), [], NOW)).toBe(false);
    expect(readingCurrent(acct(2, { fetchedAt: null }), [], NOW)).toBe(false);
  });

  it("does nothing during a cooldown or when the active account was not read recently", () => {
    const accounts = [acct(1, { active: true, five: 95 }), acct(2, { weekIn: 10 })];
    expect(chooseAccount({ ...base, accounts, choice: weekly, sinceMove: 60_000 })).toBeNull();
    expect(chooseAccount({ ...base, accounts, choice: weekly, sinceMove: 300_000 })?.to.num).toBe(2);
    accounts[0] = acct(1, { active: true, five: 95, fetchedAt: NOW - 30 * 60_000 });
    expect(chooseAccount({ ...base, accounts, choice: weekly })).toBeNull();
  });

  it("waits half an hour after any move before an optional one — except to a home just set", () => {
    const since = SETTLE_MS - 60_000;
    const nudge = [acct(1, { active: true, five: 20, weekIn: 80 }), acct(2, { weekIn: 30 })];
    expect(chooseAccount({ ...base, accounts: nudge, choice: weekly, sinceMove: since })).toBeNull();
    expect(chooseAccount({ ...base, accounts: nudge, choice: weekly, sinceMove: SETTLE_MS })?.to.num).toBe(2);
    const back = [acct(1, { five: 0, fiveIn: null }), acct(2, { active: true, five: 30 })];
    const home = { next: "room", home: "k1", manual: false, goHome: false };
    expect(chooseAccount({ ...base, accounts: back, choice: home, sinceMove: since })).toBeNull();
    expect(chooseAccount({ ...base, accounts: back, choice: { ...home, goHome: true }, sinceMove: since })?.to.num).toBe(1);
  });
});

// ── a week, minute by minute ───────────────────────────────────────────────
//
// Three accounts, home on the first. The live one spends its 5-hour window in
// about four hours and a slice of its weekly one; idle ones only reset. Where
// this module returns null the engine is played as `best`: at the threshold,
// the account with the most room under it. Cooldowns are the engine's 300s.

type Sim = { num: number; five: number; fiveAt: number | null; week: number; weekAt: number };

function simulate(choiceOf: (manual: boolean) => { next: string; home: string | null; manual: boolean; goHome: boolean }) {
  const start = NOW;
  const sims: Sim[] = [
    { num: 1, five: 0, fiveAt: null, week: 30, weekAt: sec(start) + 140 * H },
    { num: 2, five: 0, fiveAt: null, week: 50, weekAt: sec(start) + 30 * H },
    { num: 3, five: 0, fiveAt: null, week: 10, weekAt: sec(start) + 80 * H },
  ];
  let active = 1;
  let lastMove = -Infinity;
  const moves: { at: number; from: number; to: number; by: string }[] = [];
  for (let t = start; t < start + 7 * 24 * H * 1000; t += 60_000) {
    const now = sec(t);
    for (const s of sims) {
      if (s.fiveAt != null && s.fiveAt <= now) { s.five = 0; s.fiveAt = null; }
      if (s.weekAt <= now) { s.week = 0; s.weekAt += 168 * H; }
    }
    const live = sims.find(s => s.num === active)!;
    if (live.five < 100 && live.week < 100) {
      if (live.fiveAt == null) live.fiveAt = now + 5 * H;
      live.five = Math.min(100, live.five + 0.4);
      live.week = Math.min(100, live.week + 0.05);
    }
    const accounts = sims.map(s => acct(s.num, {
      active: s.num === active, fetchedAt: t,
      lanes: [
        { id: "five_hour", label: "5h", pct: s.five, resetAt: s.fiveAt },
        { id: "seven_day", label: "7d", pct: s.week, resetAt: s.weekAt },
      ],
    }));
    const cooling = t - lastMove < 300_000;
    const pick = chooseAccount({ ...base, now: t, accounts, choice: choiceOf(false), sinceMove: t - lastMove });
    if (pick) {
      moves.push({ at: t, from: active, to: pick.to.num, by: pick.trigger });
      active = pick.to.num; lastMove = t;
      continue;
    }
    const used = Math.max(live.five, live.week);
    if (used >= 90 && !cooling) {
      const best = sims.filter(s => s.num !== active && Math.max(s.five, s.week) < 90)
        .sort((a, b) => Math.max(a.five, a.week) - Math.max(b.five, b.week))[0];
      if (best) { moves.push({ at: t, from: active, to: best.num, by: "engine" }); active = best.num; lastMove = t; }
    }
  }
  return moves;
}

describe("a simulated week", () => {
  for (const [name, next, homeKey] of [
    ["home + soonest weekly reset", "weekly", "k1"],
    ["soonest weekly reset alone", "weekly", null],
    ["home + most room", "room", "k1"],
  ] as const) {
    it(`${name}: no flapping and every move outside the cooldown`, () => {
      const moves = simulate(manual => ({ next, home: homeKey, manual, goHome: false }));
      expect(moves.length).toBeGreaterThan(5);
      // Bounded: a move per filled 5-hour window plus the comebacks, never a churn.
      expect(moves.length).toBeLessThan(7 * 24 / 2);
      for (let i = 1; i < moves.length; i++) {
        expect(moves[i].at - moves[i - 1].at).toBeGreaterThanOrEqual(300_000);
        // No A→B→A inside the settle time: the shape upstream measured as a
        // cycle. The first run of this suite found one five minutes apart.
        if (moves[i].to === moves[i - 1].from) expect(moves[i].at - moves[i - 1].at).toBeGreaterThanOrEqual(SETTLE_MS);
      }
      if (homeKey) expect(moves.some(m => m.by === "home")).toBe(true);
      if (next === "weekly") expect(moves.some(m => m.by === "weekly-reset")).toBe(true);
    });
  }
});
