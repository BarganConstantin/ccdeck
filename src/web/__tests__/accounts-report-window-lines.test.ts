// What the Account capacity table says under each of its cells, as V4's Figma
// draws it: four columns (Account, State, 5-hour window, 7-day window), a
// window's bar and percentage with when it resets under them, and the state's
// word with how current the reading is under it. The reset and the age are no
// columns, so there is nothing to press to order by them — the Reset calendar
// answers "when".
//
// What these pin: the three cases of a window's second line (a reset ahead, a
// reset that has passed, and none recorded); the freshness line's three kinds
// (now, an age, a reason); the bar's inks by how much is used; what a screen
// reader still hears of the recorded time; and the Reset calendar's heading,
// which names the window once. And the words exist in all ten languages.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../claude-accounts";
import { updatedLine, usageReport } from "../accounts-usage-report";
import { UsageReportBody } from "../components/AccountsUsageReport";
import AccountResetCalendar from "../components/AccountResetCalendar";

const NOW = 1_790_000_000;
const MIN = 60;
const HOUR = 3600;

function acct(five: [number, number | null] | null, seven: [number, number | null] | null, over: Partial<Account> = {}): Account {
  return {
    num: 1, email: "reader@example.com", alias: null, org: null, active: false, disabled: false,
    lanes: [
      ...(five ? [{ id: "five_hour", label: "5h", pct: five[0], resetAt: five[1] }] : []),
      ...(seven ? [{ id: "seven_day", label: "7d", pct: seven[0], resetAt: seven[1] }] : []),
    ],
    headroom: null, fetchedAt: NOW * 1000, nextAt: null, stale: false, error: null, ...over,
  } as Account;
}

const body = (accounts: Account[]) => renderToStaticMarkup(createElement(UsageReportBody, { accounts, nowSec: NOW, held: null }));
/** The window cells of the first row, as markup. */
const windows = (out: string) => [...out.matchAll(/<td class="ap-report-cell"[^]*?<\/td>/g)].map(m => m[0]);
/** The visible words of a cell's second line, or null when it draws none. */
const line = (cell: string) => /<span class="ap-report-win-sub" data-sub="" title="[^"]*"><time [^>]*>([^<]*)<\/time>/.exec(cell)?.[1] ?? null;

describe("a window's second line: when it resets", () => {
  it("reads Resets in, with the countdown the accounts panel uses, for a reset ahead", () => {
    const [five, seven] = windows(body([acct([62, NOW + 2 * HOUR + 9 * MIN], [31, NOW + 44 * HOUR])]));
    expect(line(five)).toBe("Resets in 2h 9m");
    expect(line(seven)).toBe("Resets in 1d 20h");
  });

  it("reads Reset due · awaiting read once the reported time has passed", () => {
    const [five] = windows(body([acct([88, NOW - 4 * MIN], [44, NOW + 2 * HOUR])]));
    expect(line(five)).toBe("Reset due · awaiting read");
    expect(five).not.toContain("Resets in");
  });

  it("draws no line for a window with no recorded reset, and keeps its words for a screen reader", () => {
    const [five] = windows(body([acct([40, null], [10, NOW + HOUR])]));
    expect(line(five)).toBeNull();
    expect(five).not.toContain("ap-report-win-sub");
    expect(five).toContain('<span class="vis-hidden" data-sub="">No reset time</span>');
  });

  it("keeps the exact recorded time, on hover and for a screen reader, on the line", () => {
    const [five] = windows(body([acct([62, NOW + 2 * HOUR], [31, NOW + 44 * HOUR])]));
    const when = new Date((NOW + 2 * HOUR) * 1000);
    expect(five).toContain(`<time dateTime="${when.toISOString()}">`);
    expect(five).toMatch(/title="Recorded reset: [^"]+"/);
    expect(five).toMatch(/<span class="vis-hidden"> · Recorded reset: [^<]+<\/span>/);
  });

  it("gives a cell that is not current its line by the same three rules", () => {
    const old = { stale: true, fetchedAt: (NOW - HOUR) * 1000 } as Partial<Account>;
    const [ahead] = windows(body([acct([33, NOW + 2 * HOUR], [20, null], old)]));
    expect(ahead).toContain('data-uncounted=""');
    expect(line(ahead)).toBe("Resets in 2h 0m");
    const [passed] = windows(body([acct([96, NOW - 15 * HOUR], [20, null], { stale: true, fetchedAt: (NOW - 18 * HOUR) * 1000 })]));
    expect(line(passed)).toBe("Reset due · awaiting read");
    // Never read in the window: no figure, no bar, and no line without a reset.
    const [never] = windows(body([acct(null, [20, null])]));
    expect(never).not.toContain("ap-report-meter");
    expect(line(never)).toBeNull();
  });
});

describe("a window's bar", () => {
  const bar = (pct: number) => windows(body([acct([pct, NOW + HOUR], [10, NOW + HOUR])]))[0];

  it("fills by how much is used, muted below 70%, the text ink to 89% and the error ink from 90%", () => {
    expect(bar(62)).toContain('<span class="ap-report-meter" aria-hidden="true"><i style="--left:0.62"></i></span>');
    expect(bar(70)).toContain('<span class="ap-report-meter" data-level="mid" aria-hidden="true"><i style="--left:0.7"></i></span>');
    expect(bar(89)).toContain('data-level="mid"');
    expect(bar(90)).toContain('<span class="ap-report-meter" data-level="hi" aria-hidden="true"><i style="--left:0.9"></i></span>');
    expect(bar(100)).toContain('data-level="hi"');
    // Never amber: the only levels are the two of the sums' own meter.
    expect(bar(75)).not.toMatch(/data-level="(?!mid|hi)/);
  });

  it("wears the ink of its last number when the reading is not current, with the percentage dimmed", () => {
    const [cell] = windows(body([acct([96, NOW + HOUR], [10, NOW + HOUR], { stale: true, fetchedAt: (NOW - HOUR) * 1000 })]));
    expect(cell).toContain('data-uncounted=""');
    expect(cell).toContain('<span class="ap-report-meter" data-level="hi" aria-hidden="true"><i style="--left:0.96"></i></span>');
  });

  it("puts the percentage after the bar, in the same figure", () => {
    expect(bar(62)).toMatch(/<span class="ap-report-fig"><span class="ap-report-meter"[^]*?<\/span><span class="ap-report-pct">62%<\/span><\/span>/);
  });

  it("is the sums' own meter, drawn at 140 by 2 in the sheet, with the edge a Contrast theme keeps", () => {
    const css = readFileSync(fileURLToPath(new URL("../styles/account-projects.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.ap-report-fig \.ap-report-meter \{[^}]*max-width: 140px;[^}]*height: 2px;[^}]*background: var\(--ctl-fill\)/);
    expect(css).toMatch(/\.ap-report-fig \.ap-report-meter i \{ background: var\(--muted\); \}/);
    expect(css).toMatch(/\.ap-report-fig \.ap-report-meter\[data-level="hi"\] i \{ background: var\(--err\); \}/);
  });
});

describe("the state's line: how current the reading is", () => {
  const rowOf = (a: Account) => usageReport([a], NOW).rows[0];

  it("says Updated now for a current reading", () => {
    expect(updatedLine(rowOf(acct([10, NOW + HOUR], [10, NOW + HOUR])), NOW)).toEqual({ text: "Updated now", old: false });
  });

  it("says Updated with the age for an older one", () => {
    const a = acct([10, NOW + HOUR], [10, NOW + HOUR], { stale: true, fetchedAt: (NOW - 4 * MIN) * 1000 });
    expect(updatedLine(rowOf(a), NOW)).toEqual({ text: "Updated 4m ago", old: true });
  });

  it("says the reason as it is when there is no time to give", () => {
    const login = rowOf(acct([10, NOW + HOUR], [10, NOW + HOUR], { error: "invalid_grant", alive: false } as Partial<Account>));
    expect(updatedLine(login, NOW).text).toMatch(/login expired/i);
    expect(updatedLine(login, NOW).text).not.toMatch(/^Updated/);
    expect(updatedLine(rowOf(acct([10, NOW + HOUR], null)), NOW)).toEqual({ text: expect.stringMatching(/no 7d reading/i), old: true });
    const never = rowOf(acct([10, NOW + HOUR], [10, NOW + HOUR], { fetchedAt: null } as Partial<Account>));
    expect(updatedLine(never, NOW)).toEqual({ text: "never read", old: true });
  });

  it("is drawn under the state's word, and the State cell no longer carries an Awaiting read note", () => {
    const out = body([acct([96, NOW - 15 * HOUR], [84, NOW - 17 * HOUR], { stale: true, fetchedAt: (NOW - 18 * HOUR) * 1000 })]);
    expect(out).toMatch(/<td class="ap-report-state" data-status="ready"><span class="ap-report-mobile-label"[^>]*>State<\/span><span class="ap-report-state-word">Ready<\/span><span class="ap-report-win-sub" data-old="">Updated 18h ago<\/span><\/td>/);
    // The windows' own line says it, once each; the state does not say it again.
    expect(out.match(/awaiting read/gi)).toHaveLength(2);
  });
});

describe("on a phone, where each cell is stacked", () => {
  it("labels a window's cell with the window, and the state's with State", () => {
    const out = body([acct([10, NOW + HOUR], [10, NOW + HOUR])]);
    expect(out).toContain('<span class="ap-report-mobile-label" aria-hidden="true">5-hour window</span>');
    expect(out).toContain('<span class="ap-report-mobile-label" aria-hidden="true">7-day window</span>');
    expect(out).toContain('<span class="ap-report-mobile-label" aria-hidden="true">State</span>');
  });
});

describe("the Reset calendar's list heading", () => {
  const calendar = (selectedDate: string | null = null) => renderToStaticMarkup(createElement(AccountResetCalendar, {
    accounts: [acct(null, [30, NOW + 3 * HOUR])], nowSec: NOW, held: null, selectedDate,
  }));
  const heading = (out: string) => /<div class="ap-reset-list-head"><h3[^>]*>([^]*?)<\/h3>/.exec(out)?.[1] ?? "";

  it("names the window once, with no count beside it", () => {
    expect(heading(calendar())).toBe("All upcoming resets · 7-day window");
  });

  it("sets that heading as a label, 12 Medium in the secondary text, and a picked day's as before", () => {
    expect(calendar()).toContain('<h3 class="ap-reset-all-head">');
    const css = readFileSync(fileURLToPath(new URL("../styles/account-projects.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.ap-reset-list-head h3\.ap-reset-all-head \{ font-size: calc\(12px \+ var\(--ui-text-increase, 0px\)\); font-weight: 500; color: var\(--text-secondary\); \}/);
    const day = new Date((NOW + 3 * HOUR) * 1000);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    expect(calendar(key)).not.toContain("ap-reset-all-head");
  });

  it("keeps a picked day's heading and its count as they were", () => {
    const day = new Date((NOW + 3 * HOUR) * 1000);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const picked = heading(calendar(key));
    expect(picked).not.toContain("All upcoming resets");
    expect(picked).toMatch(/<span>\d+<\/span>$/);
  });
});

describe("the words, in every language", () => {
  const codes = ["en", "ro", "de", "es", "fr", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"];
  const catalog = (code: string) => readFileSync(fileURLToPath(new URL(`../i18n/areas/accounts/${code}.ts`, import.meta.url)), "utf8");
  // Quoted, so "accounts.rep.due" is not found inside "accounts.rep.dueAwaiting".
  const gone = ["colUsed", "colReset", "colUpdated", "due", "awaitingRead", "resetInSr", "resetSr"].map(k => `"accounts.rep.${k}"`);

  it("has the new lines, and not the keys of the columns that are gone, in all ten", () => {
    for (const code of codes) {
      const src = catalog(code);
      expect(src, code).toContain('"accounts.rep.dueAwaiting"');
      expect(src, code).toContain('"accounts.report.updatedNow"');
      for (const key of gone) expect(src, `${code} ${key}`).not.toContain(key);
    }
  });

  it("says the window in the calendar's heading in each language, translated", () => {
    const heads = codes.map(code => new RegExp(`"accounts\\.cal\\.allUpcoming": "([^"]*)"`).exec(catalog(code))![1]);
    for (const [i, head] of heads.entries()) expect(head, codes[i]).toContain(" · ");
    expect(new Set(heads).size).toBe(codes.length);
  });

  it("reads nothing in the sources of the keys that were removed", () => {
    const src = ["../components/AccountsUsageReport.tsx", "../accounts-usage-report.ts", "../components/AccountResetCalendar.tsx"]
      .map(f => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")).join("\n");
    for (const key of gone) expect(src, key).not.toContain(key);
  });
});
