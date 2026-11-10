// An account row with room to read (V4's Figma): two lines and a 3px meter for
// every account, and a third line only when the account is in a state.
//
// Line 1 is the name — an address's part before the @ in the text ink and its
// domain quieter, the domain cut first — its grey marks, and the first window's
// figure at the right edge. Line 2 is the plan and when the first window
// resets, with the second window's figure under the first. A state (a rate
// limit, a weekly limit, a login that needs signing in again, a reading that
// has gone old) gets its own line under the name, its own glyph and ink, and
// pressing the row opens every window, when it was read and what its
// organization sends, between line 2 and the meter.
//
// What these pin: that shape and its order; the state line for each state;
// the inks a figure and the meter take as a window fills; the held-out row;
// the domain-first truncation and where the whole name goes when it is cut;
// and the one caption over the rows.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountRow from "../components/AccountRow";
import { KitIcon } from "../components/kit-icons";
import type { Account } from "../claude-accounts";
import { codexVoice } from "../codex-accounts";
import { sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";

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
const figure = (html: string, n: 1 | 2) => new RegExp(`<span class="ap-fig ap-fig-${n}"[^>]*>[^]*?</span></span>`).exec(html)?.[0] ?? "";
const stateLines = (html: string) => [...html.matchAll(/class="ap-issue-line" data-tone="([a-z]+)"/g)].map(m => m[1]);
const meter = (html: string) => /<div class="ap-meter" aria-hidden="true">([^]*?)<\/div><\/li>$/.exec(html)?.[1] ?? null;

describe("the row's shape", () => {
  it("is the door, line 1, line 2 and the meter, in that order, with nothing else at rest", () => {
    const html = row(account());
    expect(html).toMatch(new RegExp(
      '^<li class="ap-account"><button type="button" class="ap-row-open"[^]*?</button>'
      + '<div class="ap-account-head">[^]*</div>'
      + '<p class="ap-quota" id="ap-quota-3">[^]*?</p>'
      + '<div class="ap-meter" aria-hidden="true"><div class="ap-meter-fill"[^>]*></div></div></li>$'));
    expect(html).not.toContain("ap-issue-line");
    expect(html).not.toContain("ap-detail");
    expect(html).not.toContain("data-state");
  });

  it("puts the first window's figure on line 1 and the second's under it on line 2", () => {
    const html = row(account());
    const head = /<div class="ap-account-head">[^]*?<p class="ap-quota"/.exec(html)![0];
    const quota = /<p class="ap-quota"[^]*?<\/p>/.exec(html)![0];
    expect(head).toContain(figure(html, 1));
    expect(text(figure(html, 1))).toBe("5h 56%");
    expect(quota).toContain(figure(html, 2));
    expect(text(figure(html, 2))).toBe("7d 21%");
    // Line 2 is the plan, when there is one, and the first window's reset.
    expect(text(quota)).toBe("Resets in 4h 18m 7d 21%");
    expect(text(/<p class="ap-quota"[^]*?<\/p>/.exec(row(account(), false, { planLabel: "Max 5×" }))![0]))
      .toBe("Max 5× Resets in 4h 18m 7d 21%");
  });

  it("opens to every window, when it was read and what its organization sends, between line 2 and the meter", () => {
    const telemetry = { orgName: "Northwind", level: "metrics" as const, content: [], destinations: ["https://otel.northwind.example"], seenAt: (NOW - HOUR) * 1000 };
    const html = row(account({ telemetry }), true);
    expect(html).toMatch(/<\/p><div class="ap-detail" id="ap-detail-3">[^]*<\/div><div class="ap-meter" aria-hidden="true">/);
    const lines = [...html.matchAll(/<(?:div|span) class="ap-(?:lane|meta-line)"[^>]*>([^]*?)<\/(?:div|span)>(?=<(?:div|span) class="ap-(?:lane|meta-line)"|<\/div>)/g)]
      .map(m => text(m[1]));
    expect(lines[0]).toBe("5-hour 56% resets in 4h 18m");
    expect(lines[1]).toMatch(/^7-day 21% resets \S+ /);
    expect(text(html)).toContain("Read 1m ago · next in 4m");
    expect(text(html)).toContain("Telemetry usage data");
    // A window nobody has spent from yet says so instead of a reset.
    const idle = account({ lanes: [{ id: "five_hour", label: "5h", pct: 0, resetAt: null }, account().lanes[1]] });
    expect(text(row(idle, true))).toContain("5-hour 0% not started");
  });
});

describe("the inks of a filling window", () => {
  const at = (pct: number, active = false) => row(account({ active, lanes: [{ id: "five_hour", label: "5h", pct, resetAt: NOW + HOUR }, account().lanes[1]] }));

  it("draws a figure in the waiting ink from 80% and the error ink at 100%", () => {
    expect(figure(at(79), 1)).not.toContain("data-level");
    expect(figure(at(80), 1)).toContain('data-level="mid"');
    expect(figure(at(99), 1)).toContain('data-level="mid"');
    expect(figure(at(100), 1)).toContain('data-level="hi"');
    const css = sheetText();
    expect(css).toContain('.ap-fig .ap-q-pct[data-level="mid"] { color: var(--warn); }');
    expect(css).toContain('.ap-fig .ap-q-pct[data-level="hi"] { color: var(--err); }');
  });

  it("fills the meter in the same inks, the live row's quiet part in the secondary ink", () => {
    expect(meter(at(40))).toContain("width:40%;background:var(--muted)");
    expect(meter(at(40, true))).toContain("width:40%;background:var(--text-secondary)");
    expect(meter(at(85))).toContain("background:var(--warn)");
    expect(meter(at(100))).toContain("width:100%;background:var(--err)");
    expect(sheetText()).toMatch(/\.ap-meter \{\s*height: 3px;/);
  });
});

describe("the state line", () => {
  it("keeps the rate limit and weekly figure on the same compact line", () => {
    const html = row(account({ error: "http-429", fetchedAt: (NOW - 5 * 60) * 1000 }));
    expect(stateLines(html)).toEqual(["wait"]);
    const line = /<div class="ap-issue-line"[^]*?<\/div>/.exec(html)![0];
    expect(line).toContain(glyph("time"));
    expect(line).not.toContain("ap-issue-age");
    expect(text(figure(line, 2))).toBe("7d 21%");
    expect(html).toContain('class="ap-quota vis-hidden"');
    expect(text(row(account({ error: "http-429", fetchedAt: (NOW - 5 * 60) * 1000 }), true))).toContain("Read 5m ago");
    expect(line).not.toContain("ap-sign-in");
    // It sits between the name and line 2, and marks the row.
    expect(html.indexOf("ap-issue-line")).toBeLessThan(html.indexOf('class="ap-quota vis-hidden"'));
    expect(html).toContain("data-state");
  });

  it("says a spent week as a weekly limit, in the error ink with a calendar, and when it comes back", () => {
    const html = row(account({ lanes: [account().lanes[0], { id: "seven_day", label: "7d", pct: 100, resetAt: NOW + 3 * 86_400 }] }));
    expect(stateLines(html)).toEqual(["err"]);
    const line = /<p class="ap-issue-line"[^]*?<\/p>/.exec(html)![0];
    expect(line).toContain(glyph("calendar"));
    expect(text(line)).toMatch(/^Weekly limit · resets \S+ /);
    expect(figure(html, 2)).toContain('data-level="hi"');
  });

  it("says an expired login in the error ink, with Sign in on the line and dashes for figures", () => {
    const html = row(account({ error: "invalid_grant", stale: true, fetchedAt: (NOW - 2 * HOUR) * 1000 }));
    // One state only, the cause rather than the old reading it causes.
    expect(stateLines(html)).toEqual(["err"]);
    const line = /<div class="ap-issue-line"[^]*?<\/div>/.exec(html)![0];
    expect(line).toContain('class="ap-warn-glyph"');
    expect(line).toMatch(/<button type="button" class="ap-sign-in"[^>]*>Sign in<\/button>/);
    expect(text(figure(html, 1))).toBe("5h —");
    expect(text(figure(html, 2))).toBe("7d —");
    expect(meter(html)).toBe("");
    expect(html).not.toContain('class="ap-switch"');
  });

  it("says an old reading quietly, with its age, and draws its figures and meter in the record's ink", () => {
    const html = row(account({ stale: true, fetchedAt: (NOW - 42 * 60) * 1000,
      lanes: [{ id: "five_hour", label: "5h", pct: 90, resetAt: NOW + HOUR }, account().lanes[1]] }));
    expect(stateLines(html)).toEqual(["quiet"]);
    const line = /<p class="ap-issue-line"[^]*?<\/p>/.exec(html)![0];
    expect(line).toContain(glyph("info"));
    expect(text(line)).toBe("Last read 42m ago 7d 21%");
    expect(figure(html, 1)).not.toContain("data-level");
    expect(meter(html)).toContain("background:var(--muted)");
    expect(sheetText()).toContain(".ap-account[data-frozen] .ap-fig .ap-q-pct,");
    // The reset is still said.
    expect(text(/<p class="ap-quota vis-hidden"[^]*?<\/p>/.exec(html)![0])).toContain("Resets in 1h");
  });

  it("is a line of 22 in 12 medium, on the name's column, in the state's ink", () => {
    const css = sheetText();
    expect(css).toMatch(/\.ap-issue-line \{[^}]*min-height: 22px;[^}]*margin: 2px 0 0 var\(--ap-indent\);[^}]*font-weight: 500;/);
    expect(css).toContain('.ap-issue-line[data-tone="err"] { color: var(--err); }');
    expect(css).toContain('.ap-issue-line[data-tone="wait"] { color: var(--warn); }');
  });
});

describe("a held-out account", () => {
  it("says held out where the figure goes, skipped by auto-switch on line 2, and keeps its meter", () => {
    const html = row(account({ disabled: true }));
    expect(html).toContain('<span class="ap-held ap-value">held out</span>');
    expect(figure(html, 1)).toBe("");
    expect(text(/<p class="ap-quota"[^]*?<\/p>/.exec(html)![0])).toBe("Skipped by auto-switch 7d 21%");
    expect(meter(html)).toContain("width:56%");
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
    // The figure never gives up any of itself.
    expect(css).toMatch(/\.ap-fig \{\s*flex: none;/);
  });

  it("is whole in the door's tooltip and in what a screen reader is told", () => {
    const html = row(account({ email: LONG }));
    expect(html).toMatch(new RegExp(`class="ap-row-open" id="ap-row-3" title="${LONG.replace(/[.]/g, "\\.")}\\n`));
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

describe("the caption over the rows", () => {
  it("is said once in each column, over its first list", () => {
    expect(sourceOf("components/AccountsPanel.tsx")).toContain('{head.length > 0 && <p className="ap-caption">{t("accounts.panel.caption")}</p>}');
    expect(sourceOf("components/CodexProfilesSection.tsx")).toContain('{head && <p className="ap-caption">{t("accounts.panel.caption")}</p>}');
    expect(sheetText()).toMatch(/\.ap-caption \{[^}]*font-size: calc\(11px/);
  });
});
