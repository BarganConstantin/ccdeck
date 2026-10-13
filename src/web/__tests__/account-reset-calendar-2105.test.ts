import { afterAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../claude-accounts";
import { resetCalendar } from "../account-reset-calendar";
import { REPORT_STALE_MS } from "../accounts-usage-report";
import AccountResetCalendar from "../components/AccountResetCalendar";

const previousZone = process.env.TZ;
process.env.TZ = "America/New_York";
afterAll(() => {
  if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
});

const now = () => new Date(2026, 9, 12, 10).getTime() / 1000;
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute).getTime() / 1000;
function account(num: number, resetAt: number | null, over: Partial<Account> = {}, clock = now()): Account {
  return {
    num, email: `account-${num}@example.test`, alias: null, org: null,
    active: false, disabled: false,
    lanes: [{ id: "seven_day", label: "7d", pct: 60, resetAt }],
    fetchedAt: clock * 1000 - 60_000, nextAt: null, headroom: null, stale: false, error: null,
    ...over,
  };
}

describe("weekly account reset schedule", () => {
  it("uses local calendar dates, with every zero-reset day present", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(240);
    const result = resetCalendar([], now());
    expect(result.days.map(day => day.key)).toEqual([
      "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18",
    ]);
    expect(result.days.map(day => day.scheduled)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("places reported timestamps in their exact local day and time order", () => {
    const result = resetCalendar([
      account(1, at(13, 15), { alias: "Work", active: true }),
      account(2, at(13, 9, 27)), account(3, at(18, 23, 59), { disabled: true }),
    ], now());
    expect(result.days[1].entries.map(entry => entry.at)).toEqual([at(13, 9, 27), at(13, 15)]);
    expect(result.days[1].entries[1]).toMatchObject({ name: "Work", used: 60, active: true, stale: false });
    expect(result.days.map(day => day.scheduled)).toEqual([0, 2, 0, 0, 0, 0, 1]);
    expect(result.days[6].entries[0].heldOut).toBe(true);
  });

  it("separates old readings from scheduled counts, including a held failed poll", () => {
    const list = [
      account(1, at(13), { stale: true }),
      account(2, at(13), { fetchedAt: now() * 1000 - REPORT_STALE_MS - 1 }),
      account(3, at(13), { fetchedAt: null }),
      account(4, at(13), { error: "invalid_grant" }),
      account(5, at(13), { staleCopy: true }),
      account(6, at(13)),
    ];
    const day = resetCalendar(list, now()).days[1];
    expect(day).toMatchObject({ scheduled: 1, outdated: 5 });
    expect(day.entries.map(entry => entry.stale)).toEqual([true, true, true, true, true, false]);
    expect(day.entries[3].note).toMatch(/login expired/i);
    expect(resetCalendar(list, now(), true).days[1]).toMatchObject({ scheduled: 0, outdated: 6 });
  });

  it("keeps unknown, passed and outside-window resets visible without guessing new dates", () => {
    const result = resetCalendar([
      account(1, null), account(2, now()), account(3, at(19, 0)),
      account(4, Number.NaN), account(5, Number.POSITIVE_INFINITY), account(6, 1e20),
    ], now());
    expect(result.unscheduled.map(entry => entry.reason)).toEqual(["unknown", "passed", "outside", "unknown", "unknown", "unknown"]);
    expect(result.days.every(day => day.entries.length === 0)).toBe(true);
    expect(result.unscheduled[1].used).toBe(60);
  });

  it("uses only the overall weekly lane and does not require a five-hour reading", () => {
    const other = account(1, null, { lanes: [{ id: "five_hour", label: "5h", pct: 10, resetAt: at(13) }] });
    expect(resetCalendar([other], now()).unscheduled[0].reason).toBe("unknown");
    const weekly = account(2, at(13));
    expect(resetCalendar([weekly], now()).days[1]).toMatchObject({ scheduled: 1, outdated: 0 });
  });

  it("does not invent usage when a reset timestamp is known but its usage is not", () => {
    const a = account(1, at(13));
    a.lanes[0].pct = Number.NaN;
    expect(resetCalendar([a], now()).days[1].entries[0]).toMatchObject({ used: null, stale: false });
  });

  it("updates dates, usage and freshness as the roster and clock change", () => {
    const a = account(1, at(12, 11));
    expect(resetCalendar([a], now()).days[0].scheduled).toBe(1);
    expect(resetCalendar([a], at(12, 11)).unscheduled[0].reason).toBe("passed");
    const refreshed = account(1, at(17), { lanes: [{ id: "seven_day", label: "7d", pct: 5, resetAt: at(17) }] });
    expect(resetCalendar([refreshed], now()).days[5].entries[0]).toMatchObject({ used: 5, stale: false });
    expect(resetCalendar([refreshed], now() + REPORT_STALE_MS / 1000).days[5].outdated).toBe(1);
    expect(resetCalendar([], at(13, 0)).days[0].key).toBe("2026-10-13");
  });

  it.each([
    { month: 2, first: 6, change: 8, hours: 23 },
    { month: 9, first: 30, change: 1, hours: 25 },
  ])("keeps seven calendar dates over a $hours-hour DST day", ({ month, first, change, hours }) => {
    const clock = new Date(2026, month, first, 10).getTime() / 1000;
    const last = new Date(2026, month, first + 6, 23, 59).getTime() / 1000;
    const beyond = new Date(2026, month, first + 7).getTime() / 1000;
    const result = resetCalendar([account(1, last, {}, clock), account(2, beyond, {}, clock)], clock);
    expect(new Set(result.days.map(day => day.key)).size).toBe(7);
    expect(result.days[6].scheduled).toBe(1);
    expect(result.unscheduled[0].reason).toBe("outside");
    const transitionMonth = hours === 25 ? month + 1 : month;
    const start = new Date(2026, transitionMonth, change);
    const end = new Date(2026, transitionMonth, change + 1);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(hours);
  });
});

describe("Chisinau timezone boundaries", () => {
  it.each([{ month: 2, day: 29, hours: 23 }, { month: 9, day: 25, hours: 25 }])("keeps local dates across a $hours-hour day", ({ month, day, hours }) => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "Europe/Chisinau";
      const start = new Date(2026, month, day);
      const end = new Date(2026, month, day + 1);
      expect((end.getTime() - start.getTime()) / 3_600_000).toBe(hours);
      const clock = start.getTime() / 1000;
      const instant = new Date(2026, month, day + 1, 0, 15).getTime() / 1000;
      const result = resetCalendar([account(1, instant, {}, clock)], clock);
      expect(result.days[1].scheduled).toBe(1);
      expect(new Set(result.days.map(date => date.key)).size).toBe(7);
    } finally { process.env.TZ = before; }
  });
});

describe("reset calendar content", () => {
  const html = (accounts: Account[], held: string | null = null) => renderToStaticMarkup(createElement(AccountResetCalendar, { accounts, nowSec: now(), held }));

  it("shows names, local times, weekly usage and seven explicit daily totals", () => {
    const output = html([account(1, at(13, 9, 27), { alias: "Work account" })]);
    expect(output).toContain("Work account");
    // Windows may use en-GB: the same local instant is "09:27 GMT-4".
    const localTime = new Date("2026-10-13T13:27:00Z").toLocaleTimeString(undefined, {
      hour: "numeric", minute: "2-digit",
    });
    expect(output).toContain(localTime);
    expect(output).toContain("60% used");
    expect(output).toContain('dateTime="2026-10-13T13:27:00.000Z"');
    expect(output.match(/class="ap-reset-count"/g)).toHaveLength(7);
    expect(output).toContain('class="ap-reset-weekday">Today');
    expect(output).toContain("America/New_York");
  });

  it("marks stale usage as a last reading and explains unknown and passed dates", () => {
    const output = html([account(1, at(13), { stale: true }), account(2, null), account(3, now())]);
    expect(output).toContain("Needs a fresh reading");
    expect(output).toContain("Last read: 60% used");
    expect(output).toContain("Reset time unknown");
    expect(output).toContain("Reset due · awaiting a new reading");
    expect(output).toContain("not token amounts");
  });

  it("keeps retained failed-poll data visibly outdated", () => {
    const output = html([account(1, at(13))], "Could not read accounts. Showing the last readings.");
    expect(output).toContain("Could not read accounts");
    expect(output).toContain("Last saved reading");
    expect(output).toContain("excluded from counts");
    expect(output).toContain("Needs a fresh reading");
  });

  it("leads with the next current reset and keeps old readings out of the main agenda", () => {
    const output = html([
      account(1, at(12, 11), { alias: "Old account", stale: true }),
      account(2, at(13), { alias: "Upcoming account" }),
    ]);
    const next = output.slice(output.indexOf('class="ap-reset-next"'), output.indexOf('class="ap-reset-week"'));
    expect(next).toContain("Upcoming account");
    expect(next).not.toContain("Old account");
    const main = output.slice(output.indexOf('class="ap-reset-scheduled"'), output.indexOf('<section class="ap-reset-disclosure"'));
    expect(main).toContain("Upcoming account");
    expect(main).not.toContain("Old account");
    expect(output).toContain("excluded from counts");
    expect(output).not.toContain('<details class="ap-reset-disclosure" open');
    expect(output).toContain("Old account");
  });

  it("groups simultaneous observations under one event time", () => {
    const output = html([account(1, at(13)), account(2, at(13)), account(3, at(14))]);
    const agenda = output.slice(output.indexOf('class="ap-reset-scheduled"'), output.indexOf('<section class="ap-reset-disclosure"'));
    expect(agenda.match(/class="ap-reset-event"/g)).toHaveLength(2);
    expect(agenda.match(/class="ap-reset-entry"/g)).toHaveLength(3);
  });

  it("makes older readings directly selectable without rendering them as upcoming", () => {
    const output = renderToStaticMarkup(createElement(AccountResetCalendar, {
      accounts: [account(1, at(13), { stopped: true })], nowSec: now(), held: null, scope: "older",
    }));
    expect(output).toContain('class="ap-reset-scheduled" hidden=""');
    expect(output).toContain('class="ap-reset-disclosure" aria-label="Accounts needing fresh readings"');
    expect(output).toContain("Last read: 60% used");
    expect(output).toContain("Last reported reset");
    expect(output).toContain("excluded from counts");
  });

  it("explains the empty schedule and escapes account names", () => {
    expect(html([])).toContain("No reported weekly resets in these seven days");
    expect(html([account(1, at(13), { alias: "<script>bad</script>" })])).toContain("&lt;script&gt;bad&lt;/script&gt;");
  });

  it("uses compact date counts without a chart or stale-count inflation", () => {
    const output = html([
      account(1, at(13)), account(2, at(14)), account(3, at(14)),
      account(4, at(13), { stale: true }), account(5, at(13), { stale: true }),
    ]);
    expect(output).not.toContain("ap-reset-chart");
    expect(output).not.toContain("--reset-height");
    expect(output).toContain('1 scheduled resets, 2 readings need updating');
    expect(output).toContain('2 scheduled resets');
    expect(output).toContain("3 weekly resets");
  });

  it("names simultaneous fresh resets without grouping stale observations into the next event", () => {
    const output = html([
      account(1, at(13)), account(2, at(13)), account(3, at(13), { stale: true }),
    ]);
    expect(output).toContain('class="ap-reset-name">2 accounts</span>');
    expect(output).not.toContain('class="ap-reset-name">3 accounts</span>');
  });

  it("renders only the chosen day, with today independent from selection", () => {
    const output = renderToStaticMarkup(createElement(AccountResetCalendar, {
      accounts: [account(1, at(13), { alias: "Tuesday account" }), account(2, at(14), { alias: "Wednesday account" })],
      nowSec: now(), held: null, selectedDate: "2026-10-14",
    }));
    const main = output.slice(output.indexOf('class="ap-reset-scheduled"'), output.indexOf('class="ap-reset-about"'));
    expect(main).toContain("Wednesday account");
    expect(main).not.toContain("Tuesday account");
    expect(output.match(/class="ap-reset-day-button"[^>]*aria-pressed="true"/g)).toHaveLength(1);
    expect(output).toContain("Showing only Wednesday");
    expect(output).toContain("data-today");
  });

  it("preserves both-window context without claiming a weekly reset removes every limit", () => {
    const output = html([account(1, at(13), { lanes: [
      { id: "five_hour", label: "5h", pct: 100, resetAt: at(14) },
      { id: "seven_day", label: "7d", pct: 80, resetAt: at(13) },
    ] })]);
    expect(output).toContain("100% used");
    expect(output).toContain("5-hour");
    expect(output).toContain("A weekly reset does not remove a separate 5-hour limit.");
    expect(output).toContain("A timestamp passing does not confirm renewed capacity.");
    const elapsed = html([account(1, at(13), { lanes: [
      { id: "five_hour", label: "5h", pct: 100, resetAt: at(11) },
      { id: "seven_day", label: "7d", pct: 80, resetAt: at(13) },
    ] })]);
    expect(elapsed).toContain("Estimated unused · awaiting a fresh reading");
    expect(elapsed).toContain("Reset due · awaiting a new reading");
  });
});
