// An account row with room to read: the name, then a bar for every window the
// account reports, and a line under the name only when the account is in a
// state.
//
// CHANGED ON PURPOSE (#2644). V4's Figma had given every row two lines and a
// 3px meter — the first window's figure beside the name, the second's under
// it, the first window's reset on the line between and its meter last — with
// every window only on pressing the row. A user said the 3.x overview, a bar
// per window on every account, was clearer: the V4 rows read as text, and
// comparing accounts meant reading each one. So every row, the live one and
// every other, shut or open, draws each window it reports — 5h, 7d, a model's
// own such as Fable — as a lane of four columns: its short name, a bar, how
// full it is with its mark, and how long until it resets.
//
// Line 1 is still the name — an address's part before the @ in the text ink
// and its domain quieter, the domain cut first — and its grey marks, with no
// figure. A state (a rate limit, a weekly limit, a login that needs signing in
// again, a reading that has gone old) gets its own line under the name, its
// own glyph and ink, and pressing the row opens when it was read and what its
// organization sends, under the lanes.
//
// What these pin: that shape and its order; the lanes and their columns; the
// state line for each state; the inks a figure and its bar take as a window
// fills, always the same; a window at 0% against an account nobody has read;
// the held-out row; the domain-first truncation and where the whole name goes
// when it is cut; and the one caption over the rows.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountRow, { resetFloor } from "../components/AccountRow";
import { KitIcon } from "../components/kit-icons";
import type { Account } from "../claude-accounts";
import { codexVoice } from "../codex-accounts";
import { sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";
import { resetPhrase } from "../accounts-time";
import type { TFunction } from "../i18n";

const NOW = 1_790_000_000;
const HOUR = 3600;

const account = (over: Partial<Account> = {}): Account => ({
  num: 3, email: "dana.ilieva@northwind.example", alias: null, org: null, active: false, disabled: false,
  lanes: [
    { id: "five_hour", label: "5h", pct: 56, resetAt: NOW + 4 * HOUR + 18 * 60 },
    { id: "seven_day", label: "7d", pct: 21, resetAt: NOW + 3 * 86_400 },
  ],
  headroom: 44, fetchedAt: (NOW - 60) * 1000, nextAt: (NOW + 240) * 1000, stale: false, error: null,
  ...over,
});

const row = (a: Account, opened = false, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AccountRow, {
  a, nowSec: NOW, opened, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
  onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
  onDismissRefusal: () => {}, onSignIn: () => {}, switchedHere: false, swapped: null, displaced: undefined,
  issueExpanded: false, onOpenIssue: () => {}, ...extra,
} as never));

const text = (html: string) => html
  .replace(/<span class="vis-hidden">[^<]*<\/span>/g, "")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const glyph = (name: "time" | "calendar" | "info") =>
  renderToStaticMarkup(createElement(KitIcon, { name, className: "ap-state-glyph" }));
const stateLines = (html: string) => [...html.matchAll(/class="ap-issue-line" data-tone="([a-z]+)"/g)].map(m => m[1]);
/** One lane: a window's four cells. A lane draws no box of its own. */
const LANE = '<div class="ap-lane">[^]*?</div>';
/** The row's lanes, whole. */
const lanesOf = (html: string) => new RegExp(`<div class="ap-lanes" id="ap-lanes-3">(?:${LANE})*</div>`).exec(html)?.[0] ?? "";
/** What each lane shows the eye, in order. */
const lanes = (html: string) => [...lanesOf(html).matchAll(/<div class="ap-lane">([^]*?)<\/div>/g)].map(m => text(m[1]));
/** One window's lane, by its short name. */
const laneOf = (html: string, label: string) =>
  new RegExp(`<div class="ap-lane"><span class="ap-lane-label" title="[^"]*">${label}</span>[^]*?</div>`).exec(html)?.[0] ?? "";
/** A lane's figure cell. */
const pctOf = (lane: string) => /<span class="ap-lane-pct"[^>]*>[^]*?<\/span>(?=<span class="ap-lane-reset")/.exec(lane)?.[0] ?? "";
/** A lane's bar: the fill's style, or null for an empty track. */
const fillOf = (lane: string) => /<span class="ap-lane-fill" style="([^"]*)"><\/span>/.exec(lane)?.[1] ?? null;

describe("the row's shape", () => {
  it("is the door, line 1 and a lane per window, in that order, with nothing else at rest", () => {
    const html = row(account());
    expect(html).toMatch(new RegExp(
      '^<li class="ap-account"><button type="button" class="ap-row-open"[^]*?</button>'
      + '<div class="ap-account-head">[^]*?</div>'
      + `<div class="ap-lanes" id="ap-lanes-3">(?:${LANE}){2}</div></li>$`));
    expect(html).not.toContain("ap-issue-line");
    expect(html).not.toContain("ap-detail");
    expect(html).not.toContain("data-state");
    // No meter of its own and no line of figures: the lanes are both.
    expect(html).not.toContain("ap-meter");
    expect(html).not.toContain("ap-quota");
  });

  it("draws every window as its short name, a bar, its figure and its reset, and no figure beside the name", () => {
    const html = row(account());
    expect(lanes(html)).toEqual(["5h 56% 4h 18m", "7d 21% 3d 0h"]);
    expect(laneOf(html, "5h")).toBe('<div class="ap-lane">'
      + '<span class="ap-lane-label" title="5-hour">5h</span>'
      + '<span class="ap-lane-track" aria-hidden="true"><span class="ap-lane-fill" style="width:56%;background:var(--accent);opacity:1"></span></span>'
      + '<span class="ap-lane-pct">56%</span>'
      + `<span class="ap-lane-reset" data-widest="${resetFloor(NOW, "not started")}" title="5h resets in 4h 18m"><span class="vis-hidden">resets in </span>4h 18m</span>`
      + "</div>");
    // The week is "Weekly" in full, on hover.
    expect(laneOf(html, "7d")).toContain('<span class="ap-lane-label" title="Weekly">7d</span>');
    // Line 1 is the name and its acts, and nothing of the windows.
    const head = /<div class="ap-account-head">[^]*?<\/div>/.exec(html)![0];
    expect(head).not.toMatch(/%|ap-q-pct|ap-fig|ap-lane/);
    // The door is described by the lanes, so a screen reader hears every
    // window with the row: "5h 56% resets in 4h 18m".
    expect(html).toContain('aria-describedby="ap-lanes-3"');
  });

  it("keeps the plan on a line of its own, between the name and the lanes", () => {
    const html = row(account(), false, { planLabel: "Max 5×" });
    expect(html).toMatch(new RegExp('</div><p class="ap-quota" id="ap-quota-3"><span class="ap-q-plan">Max 5×</span></p>'
      + `<div class="ap-lanes" id="ap-lanes-3">(?:${LANE}){2}</div></li>$`));
    expect(html).toContain('aria-describedby="ap-quota-3 ap-lanes-3"');
  });

  it("shows the windows the account reports, a model's own too, and nothing for one it does not", () => {
    // A provider with no 5-hour window draws the one it has.
    const weekOnly = account({ lanes: [{ id: "seven_day", label: "7d", pct: 21, resetAt: NOW + 5 * HOUR }] });
    expect(lanes(row(weekOnly))).toEqual(["7d 21% 5h 00m"]);
    // A model's own window, Fable's, is a lane like the others, shut or open.
    const fable = account({ lanes: [...account().lanes, { id: "scoped-0", label: "Fable", pct: 99, resetAt: NOW + 3 * 86_400 }] });
    expect(lanes(row(fable))).toEqual(["5h 56% 4h 18m", "7d 21% 3d 0h", "Fable 99% 3d 0h"]);
    expect(lanes(row(fable, true))).toEqual(lanes(row(fable)));
    expect(pctOf(laneOf(row(fable), "Fable"))).toContain('data-level="err"');
    expect(fillOf(laneOf(row(fable), "Fable"))).toBe("width:99%;background:var(--err);opacity:1");
  });

  it("reads the same on the live account and on every other", () => {
    const live = row(account({ active: true }));
    expect(lanesOf(live)).toBe(lanesOf(row(account())));
    // The live one is marked by its tick and carries no Switch; the others do.
    expect(live).toContain('class="ap-live"');
    expect(live).not.toContain('class="ap-switch"');
    expect(row(account())).toContain('class="ap-switch"');
    expect(row(account())).toContain('class="ap-more"');
    // Other accounts are drawn by the very row the live one is, in both columns.
    expect(sourceOf("components/AccountsPanel.tsx")).toContain("{head.map(accountRow)}");
    expect(sourceOf("components/AccountsPanel.tsx")).toContain("{rest.map(accountRow)}");
    expect(sourceOf("components/CodexProfilesSection.tsx")).toContain("{rest.map(accountRow)}");
  });

  it("opens to when it was read and what its organization sends, under the same lanes", () => {
    const telemetry = { orgName: "Northwind", level: "metrics" as const, content: [], destinations: ["https://otel.northwind.example"], seenAt: (NOW - HOUR) * 1000 };
    const html = row(account({ telemetry }), true);
    expect(html).toMatch(new RegExp(`<div class="ap-lanes" id="ap-lanes-3">(?:${LANE}){2}</div><div class="ap-detail" id="ap-detail-3">[^]*</div></li>$`));
    expect(lanesOf(html)).toBe(lanesOf(row(account({ telemetry }))));
    expect(text(html)).toContain("Read 1m ago · next in 4m");
    expect(text(html)).toContain("Telemetry usage data");
    expect(html).not.toContain("ap-meter");
    // A window nobody has spent from yet says so instead of a reset.
    const idle = account({ lanes: [{ id: "five_hour", label: "5h", pct: 0, resetAt: null }, account().lanes[1]] });
    expect(lanes(row(idle, true))[0]).toBe("5h 0% not started");
    expect(lanes(row(idle))[0]).toBe("5h 0% not started");
  });
});

// User feedback: the open card printed every window twice — on line 2 and on
// the lanes under it — and its lanes ran the name, the figure and the reset
// together, so nothing lined up and the telemetry line ran into an ellipsis.
describe("the open row", () => {
  const quotaLine = (html: string) => /<p class="ap-quota[^"]*" id="ap-quota-3">[^]*?<\/p>/.exec(html)?.[0] ?? null;

  it("draws the lanes it had shut, and says each window once", () => {
    // CHANGED ON PURPOSE (#2644): the lanes are on the shut row too, so
    // opening adds only what the lanes do not say.
    const shut = row(account());
    const open = row(account(), true);
    expect(lanesOf(open)).not.toBe("");
    expect(lanesOf(open)).toBe(lanesOf(shut));
    expect(quotaLine(shut)).toBeNull();
    expect(quotaLine(open)).toBeNull();
    // Each window is said once, on its lane.
    expect(text(open).match(/4h 18m/g)).toHaveLength(1);
    expect(text(shut).match(/4h 18m/g)).toHaveLength(1);
    // And the door is described by the lanes, open or shut.
    expect(open).toContain('aria-describedby="ap-lanes-3"');
  });

  it("keeps what only line 2 says: the plan, and that auto-switch skips a held-out account", () => {
    expect(quotaLine(row(account(), true, { planLabel: "Max 5×" })))
      .toBe('<p class="ap-quota" id="ap-quota-3"><span class="ap-q-plan">Max 5×</span></p>');
    expect(text(quotaLine(row(account({ disabled: true }), true)) ?? "")).toBe("Skipped by auto-switch");
    // A row in a state keeps its state line, figure and all, open or shut.
    const limited = row(account({ error: "http-429", fetchedAt: (NOW - 5 * 60) * 1000 }), true, { planLabel: "Max 5×" });
    expect(stateLines(limited)).toEqual(["wait"]);
    expect(quotaLine(limited)).toBeNull();
  });

  it("lines the lanes up in four columns, one width on every account", () => {
    // CHANGED ON PURPOSE (#2644): three columns of words on the open row
    // became four on every row — name, bar, figure, reset — and they line up
    // from one account to the next, so the eye runs down a column.
    const css = sheetText();
    expect(css).toMatch(/\.ap-lanes \{\s*display: grid;\s*grid-template-columns: fit-content\(4\.5em\) minmax\(16px, 1fr\) minmax\(3\.5em, max-content\) minmax\(7ch, max-content\);/);
    expect(css).toMatch(/\.ap-lane \{\s*display: contents;/);
    expect(css).toMatch(/\.ap-lane-label \{\s*grid-column: 1;/);
    expect(css).toMatch(/\.ap-lane-track \{\s*grid-column: 2;\s*height: 4px;/);
    expect(css).toContain(".ap-lane-pct { grid-column: 3; text-align: right; white-space: nowrap;");
    expect(css).toMatch(/\.ap-lane-reset \{\s*grid-column: 4;\s*text-align: right;/);
    // The reset column's floor is the widest of what it prints in the language
    // — the longest countdowns and "not started", one to a line — an invisible
    // copy no screen reader hears, the same on every row whatever its own
    // resets, so a row of short countdowns lines up under a long one and an
    // account whose window has not started under one whose window has.
    expect(css).toMatch(/\.ap-lane-reset::after \{\s*content: attr\(data-widest\);\s*display: block;\s*height: 0;\s*overflow: hidden;\s*visibility: hidden;\s*white-space: pre;/);
    expect(resetFloor(NOW, "not started")).toBe("23h 59m\n6d 23h\nnot started");
    const soon = account({ lanes: [{ id: "five_hour", label: "5h", pct: 10, resetAt: NOW + 5 * 60 }] });
    const idle = account({ lanes: [{ id: "five_hour", label: "5h", pct: 0, resetAt: null }] });
    const cells = [row(account()), row(soon), row(idle), row(account(), true)]
      .flatMap(html => [...html.matchAll(/<span class="ap-lane-reset"([^>]*)>/g)].map(m => m[1]));
    expect(cells).toHaveLength(6);
    for (const cell of cells) expect(cell).toContain(`data-widest="${resetFloor(NOW, "not started")}"`);
    // The open detail measured a container for its old columns; nothing does now.
    expect(css).not.toContain("@container ap-detail");
    // The dot that joined a lane's figure and reset went with the columns.
    expect(css).not.toContain('.ap-lane-value > :not(:first-child)::before');
  });

  it("still shuts on a press anywhere on its lines: the detail takes no pointer but its titled words", () => {
    const css = sheetText();
    expect(css).toMatch(/\.ap-detail \{[^}]*pointer-events: none;/);
    expect(css).toContain(".ap-detail :is(.ap-age, .ap-lane-pct[data-reset]) { pointer-events: auto; }");
  });

  it("wraps a long value onto a second line instead of cutting it", () => {
    // Every rule that names the selector in its list, comments aside.
    const rules = (sel: string) => [...sheetText().replace(/\/\*[^]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(m => m[1].split(",").map(x => x.trim()).includes(sel)).map(m => m[2]).join(";");
    for (const sel of [".ap-meta-value", ".ap-age", ".ap-meta-email"]) {
      expect(rules(sel), sel).not.toMatch(/white-space: nowrap|text-overflow: ellipsis|overflow: hidden/);
      expect(rules(sel), sel).toContain("overflow-wrap: anywhere");
    }
    // And a lane's reset wraps inside its column before it would run past it
    // ("nicht begonnen" in a German panel at its narrowest).
    expect(rules(".ap-lane-reset")).not.toMatch(/white-space: nowrap/);
    // CHANGED ON PURPOSE (#2644): where the panel is narrow the bar gives way
    // first, down to 16px, and a long window name ends in an ellipsis with its
    // whole name in its title.
    expect(rules(".ap-lane-label")).toMatch(/overflow: hidden;[^]*text-overflow: ellipsis/);
    const sonnet = row(account({ lanes: [{ id: "scoped-1", label: "Sonnet (7d)", pct: 12, resetAt: NOW + 2 * 86_400 }] }));
    expect(sonnet).toContain('<span class="ap-lane-label" title="Sonnet (7d)">Sonnet (7d)</span>');
  });

  it("says a lane's reset as a countdown that never breaks, and \"resets in\" to a screen reader", () => {
    // CHANGED ON PURPOSE (#2644): the lane's reset was a phrase that wrapped
    // between its words ("resets Sun 12:00 PM"); it is now the countdown alone,
    // in its column, the way the 3.x bars said it.
    const resets = [...row(account(), true).matchAll(/<span class="ap-lane-reset"[^>]*><span class="vis-hidden">resets in <\/span>([^<]*)<\/span>/g)].map(m => m[1]);
    expect(resets).toEqual(["4h 18m", "3d 0h"]);
    // The phrase still keeps its time together where it is asked to: the time's
    // own spaces do not break; the words before it still may.
    const say = ((_key: string, v: { time?: string; when?: string }) => `dans ${v.time ?? v.when}`) as unknown as TFunction;
    expect(resetPhrase(NOW + 2 * HOUR, NOW, say, { together: true })).toBe("dans 2h 00m");
    expect(resetPhrase(NOW + 2 * HOUR, NOW, say)).toBe("dans 2h 00m");
  });
});

describe("the inks of a filling window", () => {
  const at = (pct: number, active = false) => row(account({ active, lanes: [{ id: "five_hour", label: "5h", pct, resetAt: NOW + HOUR }, account().lanes[1]] }));

  it("draws a figure in the waiting ink from 70% and the error ink at 90%", () => {
    // The same 70 and 90 as before; the attribute now names the shared quota
    // level (quotaLevel, V4 top-10 #9), "warn" and "err", where it said "mid"
    // and "hi".
    expect(pctOf(laneOf(at(69), "5h"))).toBe('<span class="ap-lane-pct">69%</span>');
    expect(pctOf(laneOf(at(70), "5h"))).toContain('data-level="warn"');
    expect(pctOf(laneOf(at(89), "5h"))).toContain('data-level="warn"');
    expect(pctOf(laneOf(at(90), "5h"))).toContain('data-level="err"');
    const css = sheetText();
    expect(css).toContain('.ap-lane-pct[data-level="warn"] { color: var(--warn); }');
    expect(css).toContain('.ap-lane-pct[data-level="err"] { color: var(--err); }');
  });

  it("fills normal bars with accent and keeps warning and error thresholds", () => {
    expect(fillOf(laneOf(at(40), "5h"))).toContain("width:40%;background:var(--accent)");
    expect(fillOf(laneOf(at(40, true), "5h"))).toContain("width:40%;background:var(--accent)");
    expect(fillOf(laneOf(at(85), "5h"))).toContain("background:var(--warn)");
    expect(fillOf(laneOf(at(100), "5h"))).toContain("width:100%;background:var(--err)");
    expect(sheetText()).toMatch(/\.ap-lane-track \{[^}]*height: 4px;/);
  });

  it("says the same in the bar and the figure at every level", () => {
    const ink = { none: "var(--accent)", warn: "var(--warn)", err: "var(--err)" } as const;
    for (const pct of [0, 1, 40, 69, 70, 89, 90, 100]) {
      const lane = laneOf(at(pct), "5h");
      const level = (/data-level="([a-z]+)"/.exec(pctOf(lane))?.[1] ?? "none") as keyof typeof ink;
      expect(fillOf(lane), `${pct}%`).toContain(`background:${ink[level]}`);
      expect(text(pctOf(lane)), `${pct}%`).toBe(`${pct}%`);
    }
  });
});

describe("a window at 0%, and an account with no reading", () => {
  it("draws a window at 0% as a faint sliver beside 0%, never an empty track", () => {
    const zero = account({ lanes: [
      { id: "five_hour", label: "5h", pct: 0, resetAt: null },
      { id: "seven_day", label: "7d", pct: 0, resetAt: NOW + 6 * 86_400 },
    ] });
    const html = row(zero);
    expect(lanes(html)).toEqual(["5h 0% not started", "7d 0% 6d 0h"]);
    expect(fillOf(laneOf(html, "5h"))).toBe("width:1.5%;background:var(--accent);opacity:0.4");
    expect(fillOf(laneOf(html, "7d"))).toBe("width:1.5%;background:var(--accent);opacity:0.4");
  });

  it("draws no lane, no bar and no figure for an account nobody has read, and says so", () => {
    const never = row(account({ lanes: [], fetchedAt: null, nextAt: null, stale: true }));
    expect(never).not.toContain("ap-lanes");
    expect(never).not.toContain("ap-lane-fill");
    expect(text(never)).not.toMatch(/\d%/);
    expect(stateLines(never)).toEqual(["quiet"]);
    expect(text(never)).toContain("Never collected");
    // Read, but with no window yet: said quietly where the lanes would be,
    // and only once when the row is opened.
    const empty = row(account({ lanes: [] }));
    expect(empty).not.toContain("ap-lanes");
    expect(text(empty)).not.toMatch(/\d%/);
    expect(empty).toMatch(/<\/div><p class="ap-quota"><span class="ap-q-reset">no usage recorded yet<\/span><\/p><\/li>$/);
    expect(text(row(account({ lanes: [] }), true)).match(/no usage recorded yet/gi)).toHaveLength(1);
  });
});

describe("the state line", () => {
  it("keeps the rate limit on its own compact line, over the lanes", () => {
    const html = row(account({ error: "http-429", fetchedAt: (NOW - 5 * 60) * 1000 }));
    expect(stateLines(html)).toEqual(["wait"]);
    const line = /<div class="ap-issue-line"[^]*?<\/div>/.exec(html)![0];
    expect(line).toContain(glyph("time"));
    expect(line).not.toContain("ap-issue-age");
    // CHANGED ON PURPOSE (#2644): the line says the state alone; the week's
    // figure it carried is on the week's lane under it, with the others.
    expect(line).not.toMatch(/%|ap-lane|ap-fig/);
    expect(lanes(html)).toEqual(["5h 56% 4h 18m", "7d 21% 3d 0h"]);
    expect(html).not.toContain("ap-quota");
    expect(text(row(account({ error: "http-429", fetchedAt: (NOW - 5 * 60) * 1000 }), true))).toContain("Read 5m ago");
    expect(line).not.toContain("ap-sign-in");
    // It sits between the name and the lanes, and marks the row.
    expect(html.indexOf("ap-issue-line")).toBeLessThan(html.indexOf('class="ap-lanes"'));
    expect(html).toContain("data-state");
  });

  it("says a spent week as a weekly limit, in the error ink with a calendar, and when it comes back", () => {
    const html = row(account({ lanes: [account().lanes[0], { id: "seven_day", label: "7d", pct: 100, resetAt: NOW + 3 * 86_400 }] }));
    expect(stateLines(html)).toEqual(["err"]);
    const line = /<p class="ap-issue-line"[^]*?<\/p>/.exec(html)![0];
    expect(line).toContain(glyph("calendar"));
    expect(text(line)).toMatch(/^Weekly limit · resets \S+ /);
    const week = laneOf(html, "7d");
    expect(pctOf(week)).toContain('data-level="err"');
    expect(fillOf(week)).toBe("width:100%;background:var(--err);opacity:1");
  });

  it("says an expired login in the error ink, with Sign in on the line and no numbers on the shut row", () => {
    const expired = account({ error: "invalid_grant", stale: true, fetchedAt: (NOW - 2 * HOUR) * 1000 });
    const html = row(expired);
    // One state only, the cause rather than the old reading it causes.
    expect(stateLines(html)).toEqual(["err"]);
    const line = /<div class="ap-issue-line"[^]*?<\/div>/.exec(html)![0];
    expect(line).toContain('class="ap-warn-glyph"');
    expect(line).toMatch(/<button type="button" class="ap-sign-in"[^>]*>Sign in<\/button>/);
    // CHANGED ON PURPOSE (#2644): no lanes where the dashes were, so last
    // week's quota never reads as this week's beside "Login expired".
    expect(html).not.toContain("ap-lanes");
    expect(text(html)).not.toMatch(/\d%|—/);
    expect(html).not.toContain('class="ap-switch"');
    // Opened, its lanes are the record they are: no level, the quiet ink.
    const open = row(expired, true);
    expect(lanes(open)).toEqual(["5h 56% 4h 18m", "7d 21% 3d 0h"]);
    expect(open).not.toContain("data-level");
    expect(fillOf(laneOf(open, "5h"))).toBe("width:56%;background:var(--muted);opacity:1");
  });

  it("says an old reading quietly, with its age, and draws its figures and bars in the record's ink", () => {
    const html = row(account({ stale: true, fetchedAt: (NOW - 42 * 60) * 1000,
      lanes: [{ id: "five_hour", label: "5h", pct: 90, resetAt: NOW + HOUR }, account().lanes[1]] }));
    expect(stateLines(html)).toEqual(["quiet"]);
    const line = /<p class="ap-issue-line"[^]*?<\/p>/.exec(html)![0];
    expect(line).toContain(glyph("info"));
    // CHANGED ON PURPOSE (#2644): the week's figure moved off this line onto
    // its lane.
    expect(text(line)).toBe("Last read 42m ago");
    const five = laneOf(html, "5h");
    expect(pctOf(five)).toBe('<span class="ap-lane-pct">90%</span>');
    expect(fillOf(five)).toBe("width:90%;background:var(--muted);opacity:1");
    expect(sheetText()).toContain(".ap-account[data-frozen] .ap-lane-pct,");
    // The reset is still said, with its window — on its lane, to the eye too.
    expect(text(five)).toBe("5h 90% 1h 00m");
    expect(five).toContain('title="5h resets in 1h 00m"');
  });

  it("is a line of 22 in 12 medium, on the name's column, in the state's ink", () => {
    const css = sheetText();
    expect(css).toMatch(/\.ap-issue-line \{[^}]*min-height: 22px;[^}]*margin: 2px 0 0 var\(--ap-indent\);[^}]*font-weight: 500;/);
    expect(css).toContain('.ap-issue-line[data-tone="err"] { color: var(--err); }');
    expect(css).toContain('.ap-issue-line[data-tone="wait"] { color: var(--warn); }');
  });
});

describe("a held-out account", () => {
  it("says held out where Switch goes, skipped by auto-switch under the name, and keeps its lanes", () => {
    const html = row(account({ disabled: true }));
    expect(html).toContain('<span class="ap-held ap-value">held out</span>');
    expect(html).not.toContain('class="ap-switch"');
    // CHANGED ON PURPOSE (#2644): its windows are lanes like every row's — it
    // is still spent from by hand — and the plan line says only what they do not.
    expect(text(/<p class="ap-quota"[^]*?<\/p>/.exec(html)![0])).toBe("Skipped by auto-switch");
    expect(lanes(html)).toEqual(["5h 56% 4h 18m", "7d 21% 3d 0h"]);
    expect(fillOf(laneOf(html, "5h"))).toContain("width:56%");
  });
});

describe("a long name", () => {
  const LONG = "petra.munteanu-consulting-group@northwind-enterprise-partners.example";

  it("is drawn in two parts, the address's domain quieter than the name before it", () => {
    const html = row(account({ email: LONG }));
    expect(html).toContain(`<span class="ap-alias" title="${LONG}"><span class="ap-alias-local">petra.munteanu-consulting-group</span><span class="ap-alias-domain">@northwind-enterprise-partners.example</span></span>`);
    // An alias is one name, with the address it stands for in the title.
    const aliased = row(account({ alias: "consulting" }));
    expect(aliased).toContain('<span class="ap-alias" title="consulting · dana.ilieva@northwind.example"><span class="ap-alias-local">consulting</span></span>');
  });

  it("gives up its domain first, then the name before it, each with an ellipsis", () => {
    const css = sheetText();
    // Every rule that names this selector on its own line, its bodies joined.
    const body = (sel: string) => [...css.matchAll(new RegExp(`\\n${sel.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`, "g"))].map(m => m[1]).join(";");
    const shrink = (sel: string) => Number(/flex: 0 (\d+) auto/.exec(body(sel))?.[1]);
    expect(shrink(".ap-alias-domain")).toBeGreaterThanOrEqual(1000 * shrink(".ap-alias-local"));
    expect(css).toMatch(/\.ap-alias-local,\s*\.ap-alias-domain \{\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;/);
    expect(body(".ap-alias-domain")).toContain("color: var(--muted)");
    // CHANGED ON PURPOSE (#2644): the figures left the name's line. The row's
    // acts never give up any of themselves to the name, and a lane's figure
    // never gives up any of itself to its bar.
    expect(css).toMatch(/\.ap-acts \{[^}]*flex: none;/);
    expect(css).toContain(".ap-lane-pct { grid-column: 3; text-align: right; white-space: nowrap;");
  });

  it("is whole in the door's tooltip and in what a screen reader is told", () => {
    const html = row(account({ email: LONG }));
    expect(html).toMatch(new RegExp(`class="ap-row-open" id="ap-row-3" title="${LONG.replace(/[.]/g, "\\.")}"`));
    expect(html).toContain(`<span class="vis-hidden">${LONG}, details</span>`);
  });
});

describe("the marks after the name", () => {
  it("are one grey set, with a provider's word for its live account as a tag", () => {
    const live = row(account({ active: true }), false, { voice: codexVoice(), home: "Auto-switch comes back here" });
    expect(live).toMatch(/<span class="ap-marks">[^]*class="ap-home"[^]*<span class="ap-tag">default<\/span><\/span>/);
    // Only the live account wears the word.
    expect(row(account(), false, { voice: codexVoice() })).not.toContain("ap-tag");
    expect(sheetText()).toMatch(/\.ap-marks \{[^}]*color: var\(--muted\);/);
  });
});

describe("the account column", () => {
  it("does not add the redundant usage caption above the cards", () => {
    for (const file of ["components/AccountsPanel.tsx", "components/CodexProfilesSection.tsx"])
      expect(sourceOf(file)).not.toContain('<p className="ap-caption">');
  });
});
