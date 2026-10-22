// #2183 against the two rules the deck already had when the commands came to
// it: `ccdeck switch --best` lands where Auto-switch's own chooser would
// (#2200: a home account, "soonest weekly reset"), and `ccdeck switch <n>`
// refuses exactly the rows the Accounts panel will not switch to.
//
// THE CHOOSER IS THE ORACLE. Every pick below is checked against
// account-choice.mjs's chooseAccount asked the way --best asks it — a tick
// right after a person's request: nothing picked by hand to protect, the home
// asked for, no cooldown — so the two cannot drift apart without this failing.
// THE PANEL IS THE ORACLE for the refusal: account-issue.ts's `blocksSwitch`,
// row by row.
import { describe, it, expect } from "vitest";
import { chooseAccount } from "../../server/account-choice.mjs";
import { accountKey } from "../../server/lan-copies.mjs";
import { accountIssue } from "../account-issue";

// @ts-expect-error — plain .mjs module, no types
const { bestAccount, blocksSwitch, switchable } = await import("../../server/account-pick.mjs");

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const H = 3600;
const sec = (ms: number) => Math.floor(ms / 1000);

type Lane = { id: string; label: string; pct: number; resetAt: number | null };
type Row = Record<string, unknown> & { num: number; email: string; orgUuid: string; lanes: Lane[] };

/** One roster row as /api/claude-accounts sends it. `five`/`week` are
 *  percentages used; `weekIn` is hours to the weekly reset. */
function acct(num: number, o: Record<string, unknown> & { five?: number; week?: number; weekIn?: number | null } = {}): Row {
  const five = o.five ?? 10;
  const week = o.week ?? 20;
  const lanes: Lane[] = [
    { id: "five_hour", label: "5h", pct: five, resetAt: sec(NOW) + 3 * H },
    { id: "seven_day", label: "7d", pct: week, resetAt: o.weekIn === null ? null : sec(NOW) + (o.weekIn ?? 100) * H },
  ];
  const { five: _f, week: _w, weekIn: _i, ...rest } = o;
  return {
    num, email: `a${num}@x.example`, orgUuid: `org-${num}`, alias: null,
    active: false, alive: true, disabled: false, error: null, reauth: null, staleCopy: false, stopped: false,
    fetchedAt: NOW - 60_000, stale: false, headroom: Math.max(0, 100 - Math.max(five, week)),
    lanes, ...rest,
  };
}
const key = (num: number) => accountKey(`a${num}@x.example`, `org-${num}`);

type Rules = {
  next: "room" | "weekly"; home: string | null; threshold: number; models: string[];
  busy: Set<string>; quarantined: Set<string>; optional: boolean; now: number;
};
const rules = (o: Partial<Rules> = {}): Rules => ({
  next: "room", home: null, threshold: 90, models: [], busy: new Set(), quarantined: new Set(), optional: true, now: NOW, ...o,
});

/** chooseAccount, asked as `--best` asks it. */
function tick(accounts: Row[], r: Rules) {
  return chooseAccount({
    accounts: accounts.map(a => ({ ...a, key: accountKey(a.email, a.orgUuid) })),
    choice: { next: r.next, home: r.home, manual: false, goHome: true },
    threshold: r.threshold, models: r.models, busy: r.busy, quarantined: r.quarantined,
    sinceMove: Infinity, optional: r.optional, now: r.now,
  });
}

/** The slot --best switches to, or `stay:<slot>`, or `none`. */
function best(accounts: Row[], r: Rules | null) {
  const b = bestAccount(accounts, r);
  return b.account ? b.account.num : b.already ? `stay:${b.already.num}` : "none";
}

describe("switch --best picks what Auto-switch would (#2200)", () => {
  it("goes to the home account rather than the one with the most room", () => {
    const accounts = [acct(1, { active: true, five: 95 }), acct(2, { five: 5, week: 5 }), acct(3, { five: 40, week: 30 })];
    const r = rules({ home: key(3) });
    expect(tick(accounts, r)?.to.num).toBe(3);
    expect(bestAccount(accounts, r)).toMatchObject({ account: { num: 3 }, rule: "home" });
    // Without the rule it is the engine's own choice, as it always was.
    expect(best(accounts, null)).toBe(2);
    expect(best(accounts, rules())).toBe(2);
  });

  it("leaving a full account, goes to the soonest weekly reset inside 95 hours, not the most room", () => {
    const accounts = [
      acct(1, { active: true, five: 95 }),
      acct(2, { five: 0, week: 5, weekIn: 120 }),   // most room, but past the horizon
      acct(3, { five: 10, week: 40, weekIn: 30 }),
      acct(4, { five: 10, week: 30, weekIn: 60 }),
    ];
    const r = rules({ next: "weekly" });
    expect(tick(accounts, r)?.to.num).toBe(3);
    expect(bestAccount(accounts, r)).toMatchObject({ account: { num: 3 }, rule: "weekly-reset" });
    expect(best(accounts, null)).toBe(2);
  });

  it("under the threshold, moves only for a weekly reset at least an hour sooner, and otherwise stays", () => {
    const close = [acct(1, { active: true, five: 30, weekIn: 20 }), acct(2, { five: 0, week: 0, weekIn: 19.5 })];
    const r = rules({ next: "weekly" });
    expect(tick(close, r)).toBeNull();
    expect(bestAccount(close, r)).toMatchObject({ already: { num: 1 }, rule: "rules" });
    const sooner = [acct(1, { active: true, five: 30, weekIn: 20 }), acct(2, { five: 50, week: 50, weekIn: 10 }), acct(3, { five: 0, week: 0 })];
    expect(tick(sooner, r)?.to.num).toBe(2);
    expect(best(sooner, r)).toBe(2);
  });

  it("never leaves the home account under the threshold, though another has more room", () => {
    const accounts = [acct(1, { active: true, five: 60 }), acct(2, { five: 0, week: 0 })];
    const r = rules({ home: key(1) });
    expect(tick(accounts, r)).toBeNull();
    expect(bestAccount(accounts, r)).toMatchObject({ already: { num: 1 }, rule: "home" });
    expect(best(accounts, null)).toBe(2);
  });

  it("leaves a full home account by the next rule: the soonest weekly reset, or the most room", () => {
    const accounts = [acct(1, { active: true, five: 95 }), acct(2, { five: 0, week: 0, weekIn: 90 }), acct(3, { five: 20, week: 20, weekIn: 40 })];
    expect(tick(accounts, rules({ home: key(1), next: "weekly" }))?.to.num).toBe(3);
    expect(best(accounts, rules({ home: key(1), next: "weekly" }))).toBe(3);
    // The engine's turn: chooseAccount names nobody, and the most room is the engine's pick.
    expect(tick(accounts, rules({ home: key(1) }))).toBeNull();
    expect(bestAccount(accounts, rules({ home: key(1) }))).toMatchObject({ account: { num: 2 }, rule: "most-room" });
  });

  it("skips what Auto-switch skips: a home held by `cswap run`, set aside by the engine, read too long ago, or too near the threshold", () => {
    const roster = (home: Record<string, unknown> = {}) =>
      [acct(1, { active: true, five: 95 }), acct(2, { five: 0, week: 0 }), acct(3, { five: 30, week: 30, ...home })];
    const cases: [string, Row[], Rules][] = [
      ["cswap run", roster(), rules({ home: key(3), busy: new Set([key(3)]) })],
      ["quarantined", roster(), rules({ home: key(3), quarantined: new Set([key(3)]) })],
      ["stale reading", roster({ fetchedAt: NOW - 20 * 60_000 }), rules({ home: key(3) })],
      ["near the threshold", roster({ five: 86 }), rules({ home: key(3) })],
      ["held out of rotation", roster({ disabled: true }), rules({ home: key(3) })],
      ["refused login", roster({ error: "invalid_grant", alive: false }), rules({ home: key(3) })],
    ];
    for (const [why, accounts, r] of cases) {
      expect(tick(accounts, r), why).toBeNull();
      expect(best(accounts, r), why).toBe(2);
    }
  });

  it("agrees with chooseAccount whenever it names an account, across rosters, rules and thresholds", () => {
    let named = 0;
    for (const activeFive of [20, 70, 89, 92, 100]) {
      for (const threshold of [80, 90, 95]) {
        for (const next of ["room", "weekly"] as const) {
          for (const home of [null, 1, 2, 3, 4]) {
            const accounts = [
              acct(1, { active: true, five: activeFive, weekIn: 50 }),
              acct(2, { five: 5, week: 60, weekIn: 30 }),
              acct(3, { five: 0, week: 10, weekIn: 140 }),
              acct(4, { five: 40, week: 40, weekIn: 10, fetchedAt: NOW - 16 * 60_000 }),
              acct(5, { five: 20, week: 20, weekIn: 70 }),
            ];
            const r = rules({ next, home: home == null ? null : key(home), threshold });
            const pick = tick(accounts, r);
            const label = `5h ${activeFive}, threshold ${threshold}, ${next}, home ${home}`;
            if (pick) {
              named++;
              expect(best(accounts, r), label).toBe(pick.to.num);
            } else if (next === "room" && home == null) {
              expect(best(accounts, r), label).toBe(best(accounts, null));
            }
          }
        }
      }
    }
    expect(named).toBeGreaterThan(20);
  });

  it("keeps the active account below the threshold when the rules name nobody, and never answers none while one can take the login", () => {
    const accounts = [acct(1, { active: true, five: 50 }), acct(2, { five: 95 })];
    expect(best(accounts, rules({ next: "weekly" }))).toBe("stay:1");
    expect(best([acct(1, { active: true, disabled: true, five: 99 })], rules({ next: "weekly" }))).toBe("none");
  });
});

describe("switch <n> refuses what the Accounts panel refuses (3.43.4)", () => {
  it("withholds the switch from exactly the rows the panel withholds its button from", () => {
    const errors = [null, "invalid_grant", "no_refresh_token", "http-401", "http-429", "transient", "timeout", "network", "error", "something_new"];
    const collectors = [null, "no_credentials", "relogin_required", "keychain_unavailable", "token_expired", "foreign_credential"];
    let blocked = 0;
    for (const error of errors) {
      for (const stopped of [false, true]) {
        for (const collector of collectors) {
          for (const staleCopy of [false, true]) {
            const row = { error, stopped, collector, staleCopy, repair: null };
            const panel = accountIssue(row, sec(NOW))?.blocksSwitch ?? false;
            expect(blocksSwitch(row), JSON.stringify(row)).toBe(panel);
            expect(switchable({ ...row, disabled: false }), JSON.stringify(row)).toBe(!panel);
            if (panel) blocked++;
          }
        }
      }
    }
    expect(blocked).toBeGreaterThan(0);
    expect(switchable({ error: null, disabled: true })).toBe(false);
  });

  it("switches by name to an account that is only rate limited, as the panel does, but never lands there by room", () => {
    const limited = acct(2, { error: "http-429", headroom: 90 });
    expect(switchable(limited)).toBe(true);
    expect(best([acct(1, { active: true, five: 95 }), limited, acct(3, { five: 50, week: 50 })], null)).toBe(3);
    // A login claude-swap stopped reading because it must be signed in again.
    expect(switchable(acct(4, { stopped: true, collector: "relogin_required", alive: false }))).toBe(false);
  });
});
