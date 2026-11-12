// V4's data dialogs: Tool activity, Feedback, Usage history (and a day, failed,
// reading), Session usage, Tool call, Context breakdown, Session recap and the
// JSON box. Each pins the sizes, type and colours V4's Figma draws, and that
// every column, filter and number the deck showed before is still shown.
//
// Plain node, like the rest of the sheet's tests: the stylesheet is read as text
// and the components as source.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sheetText } from "./sheet-source";
import { en } from "../i18n/en";
import { fmtTokens } from "../token-format";
import { dayValue, weekdayShort } from "../usage-history";
import { dialogDuration } from "../duration";
import type { ToolCall } from "../types";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** The value of `prop` in the first rule written for exactly this selector. */
function decl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  const m = rule && new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule[1]);
  return m ? m[1].trim().replace(/\s+/g, " ") : null;
}
const px = (value: string | null): number => {
  const m = /^(?:calc\()?(-?[\d.]+)px/.exec((value ?? "").trim());
  return m ? +m[1] : NaN;
};

const toolAudit = read("components/ToolAuditModal.tsx");
const feedback = read("components/FeedbackDialog.tsx");
const feedbackDetails = read("components/FeedbackDetails.tsx");
const history = read("components/UsageHistoryModal.tsx");
const dayDetail = read("components/UsageDayDetail.tsx");
const session = read("components/SessionUsageModal.tsx");
const toolModal = read("components/ToolModal.tsx");
const context = read("components/ContextModal.tsx");
const recap = read("components/SessionSummary.tsx");
const jsonBox = read("components/JsonInspector.tsx");

describe("Tool activity", () => {
  it("is the shell's dialog, on the overlay fill and not the deck's --bg", () => {
    expect(decl(".modal.ta-report", "background")).toBeNull();
    expect(decl(".modal", "background")).toBe("var(--panel)");
    expect(decl(".modal.ta-report", "width")).toBe("var(--dialog-l)");
  });

  it("puts the period control in the header: 3 of padding, 2 apart, a --bg-soft track on a soft hairline", () => {
    expect(decl(".ta-period", "padding")).toBe("3px");
    expect(decl(".ta-period", "gap")).toBe("2px");
    expect(decl(".ta-period", "border")).toBe("1px solid var(--line-soft)");
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a segmented control is a control, at 4.
    expect(decl(".ta-period", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".ta-period", "background")).toBe("var(--bg-soft)");
    expect(decl(".ta-period-btn", "min-height")).toBe("var(--ctl-h-sm)");
    expect(decl(".ta-period-btn", "padding")).toBe("0 10px");
    expect(decl(".ta-period-btn", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".ta-period-btn", "font-weight")).toBe("500");
    expect(decl(".ta-period-btn", "color")).toBe("var(--muted)");
    expect(decl(".ta-period-btn[aria-pressed=true]", "color")).toBe("var(--text)");
    expect(toolAudit).toMatch(/<SegmentGroup className="ta-period" role="group"/);
    // In the header, before the ×, and every period the deck offers is still a segment.
    expect(toolAudit.indexOf("{periodControl}")).toBeLessThan(toolAudit.indexOf("ref={closeRef}"));
    expect(toolAudit).toMatch(/Object\.keys\(periodLabels\)\.map\(days => <button key=\{days\} type="button" className="ta-period-btn"/);
  });

  it("draws a tool as one 34-high line: the name at 13/500, a neutral 150 x 6 bar, calls muted, time in the text colour", () => {
    expect(decl(".ta-list:not(.sa-list) .ta-row", "min-height")).toBe("34px");
    expect(decl(".ta-list:not(.sa-list) .ta-row", "padding")).toBe("6px 12px");
    expect(decl(".ta-list:not(.sa-list) .ta-op", "font-weight")).toBe("500");
    expect(decl(".ta-list:not(.sa-list) .ta-op", "font-family")).toBe("inherit");
    expect(decl(".ta-list:not(.sa-list) .ta-op", "white-space")).toBe("nowrap");
    expect(decl(".ta-list-head, .ta-row", "grid-template-columns")).toBe("minmax(0, 1fr) 150px 60px 72px 84px 76px");
    expect(decl(".ta-track", "height")).toBe("6px");
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a 6-high bar at 3 is a capsule, the pill token.
    expect(decl(".ta-track", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".ta-track", "background")).toBe("var(--bg-soft)");
    expect(decl(".ta-track > .ta-bar", "background")).toBe("var(--muted)");
    expect(decl(".ta-track > .ta-bar", "border-radius")).toBe("var(--r-pill)");
    expect(decl(":where(.ta-list:not(.sa-list)) .ta-cell[data-col=calls]", "color")).toBe("var(--muted)");
    expect(decl(":where(.ta-list:not(.sa-list)) .ta-cell[data-col=time]", "color")).toBe("var(--text)");
  });

  it("keeps every column, the description and the sort-by-failures colour on that one line", () => {
    for (const col of ["calls", "time", "slowest", "failed"]) {
      expect(toolAudit, col).toContain(`data-col="${col}"`);
    }
    expect(toolAudit).toContain('<span className="ta-desc">{description}</span>');
    expect(toolAudit).toContain('className="ta-track" aria-hidden="true"');
    expect(decl(".ta-list[data-sort=failed] .ta-track > .ta-bar", "background")).toBe("var(--err)");
    // The agent choice, the sort strip and the search are still in the body.
    expect(toolAudit).toContain("insights.audit.agent");
    expect(toolAudit).toContain("toolSorts.map");
    expect(toolAudit).toContain('type="search"');
  });
});

describe("review follow-ups", () => {
  it("wraps Tool activity's period control onto its own row below the title on a narrow window", () => {
    const narrow = /@media \(max-width: 700px\) \{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf(".ta-filters")))![1];
    expect(narrow).toMatch(/\.ta-report-header \{[^}]*flex-wrap: wrap/);
    expect(narrow).toMatch(/\.ta-actions \{ display: contents; \}/);
    expect(narrow).toMatch(/\.ta-period \{ order: 1; flex: 1 0 100%;/);
  });

  it("keeps the failed column's share on the tool's one line", () => {
    expect(decl(".ta-list:not(.sa-list) .ta-cell small", "display")).toBe("inline");
  });

  it("steps the chosen feedback kind's focus ring outside, like every other accent-filled control", () => {
    expect(css).toContain(".fb-kind:has(input:checked:focus-visible),");
  });

  it("narrows a day's table and drops the value over each bar on a phone", () => {
    const phone = /@media \(max-width: 520px\) \{\s*\.uh-day-table th:nth-child\(2\)[\s\S]*?\n\}/.exec(css)![0];
    expect(phone).toContain("width: 64px");
    expect(phone).toContain(".uh-bar-value { display: none; }");
  });

  it("answers forced colours in the one block for the history chips, the period ring, the bars and the context meter", () => {
    const all = sheetText();
    const open = all.indexOf("@media (forced-colors: active) {");
    expect(all.split("@media (forced-colors: active) {").length - 1).toBe(1);
    const forced = all.slice(open);
    for (const sel of [
      '.uh-toolbar .uh-range-btn[aria-pressed="true"]',
      ".ta-period-btn[aria-pressed=true]",
      ".ta-track > .ta-bar",
      ".ta-list[data-sort=failed] .ta-track > .ta-bar",
      ".ctx-modal .ctx-window-fill",
      '.ctx-modal .ctx-window-fill[data-level="high"]',
      '.ctx-modal .ctx-window-fill[data-level="full"]',
    ]) expect(forced, sel).toContain(sel);
  });

  it("leaves no pill, no title dot and no accent modifier behind", () => {
    expect(css).not.toMatch(/\.state-pill/);
    expect(css).not.toMatch(/\.modal-title \.status-dot\.(inflight|done)/);
    expect(history).not.toMatch(/pageHidden|data-paused|uh-head|accent/);
  });
});

describe("Feedback", () => {
  it("draws the three kinds as 24-high pills: a hairline at rest, the accent edge on the accent wash when chosen", () => {
    expect(decl(".fb-kinds", "gap")).toBe("4px");
    expect(decl(".fb-kind", "min-height")).toBe("var(--ctl-h-sm)");
    expect(decl(".fb-kind", "padding")).toBe("0 8px");
    expect(decl(".fb-kind", "border")).toBe("1px solid var(--line)");
    expect(decl(".fb-kind", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".fb-kind", "color")).toBe("var(--text-secondary)");
    expect(decl(".fb-kind", "font-weight")).toBe("400");
    expect(decl(".fb-kind:has(input:checked)", "border-color")).toBe("var(--accent)");
    expect(decl(".fb-kind:has(input:checked)", "background")).toBe("var(--accent-16)");
    expect(decl(".fb-kind:has(input:checked)", "color")).toBe("var(--text)");
  });

  it("sets the message on the sunken fill, 120 high, with the muted 13/20 placeholder and 12/600 label", () => {
    expect(decl(".ap-manage-input.fb-message", "background")).toBe("var(--sunken)");
    expect(decl(".ap-manage-input.fb-message", "min-height")).toBe("120px");
    expect(decl(".ap-manage-input.fb-message", "padding")).toBe("8px 10px");
    expect(decl(".ap-manage-input.fb-message", "line-height")).toBe("calc(20px + var(--ui-text-increase, 0px))");
    expect(decl(".ap-manage-input.fb-message::placeholder", "color")).toBe("var(--muted)");
    expect(decl(".fb-label", "color")).toBe("var(--text-secondary)");
    expect(decl(".fb-label", "font-weight")).toBe("600");
    expect(decl(".fb-field-label", "color")).toBe("var(--text-secondary)");
    expect(decl(".fb-field-label", "font-weight")).toBe("500");
    expect(decl(".fb-hint", "line-height")).toBe("calc(14px + var(--ui-text-increase, 0px))");
  });

  it("opens Add details with a chevron first, then the 12/500 text, and keeps the contact field", () => {
    expect(feedbackDetails.indexOf('className="fb-chev"')).toBeLessThan(feedbackDetails.indexOf("{addDetails()}"));
    expect(decl(".fb-tool", "color")).toBe("var(--text-secondary)");
    expect(decl(".fb-tool", "font-weight")).toBe("500");
    expect(decl(".fb-more[aria-expanded=\"true\"] .fb-chev", "transform")).toBe("rotate(90deg)");
    expect(feedbackDetails).toContain('id="fb-contact"');
  });

  it("puts the facts on the left and the send key as plain mono text on the right of one line", () => {
    expect(decl(".fb-facts", "justify-content")).toBe("space-between");
    expect(decl(".fb-facts", "color")).toBe("var(--muted)");
    expect(decl(".fb-facts", "line-height")).toBe("calc(16px + var(--ui-text-increase, 0px))");
    expect(decl(".fb-shortcut", "font-family")).toBe("var(--font-mono)");
    expect(decl(".fb-shortcut", "color")).toBe("var(--muted)");
    expect(decl(".fb-shortcut kbd", "border")).toBe("0");
    expect(decl(".fb-shortcut kbd", "background")).toBe("none");
    expect(feedback).toMatch(/<p className="fb-facts">[\s\S]*?<span className="fb-shortcut" aria-hidden="true">/);
    // And the foot no longer carries the hint.
    const foot = feedback.slice(feedback.indexOf('<div className="fb-foot">'));
    expect(foot).not.toContain("fb-shortcut");
  });

  it("closes on the shell's footer: a soft rule, 48 high, 16 at the sides", () => {
    expect(decl(".fb-foot", "border-top")).toBe("1px solid var(--line-soft)");
    expect(decl(".fb-foot", "min-height")).toBe("var(--dialog-foot-h)");
    expect(decl(".fb-foot", "padding")).toBe("0 16px");
    expect(decl(".modal-body.fb-body", "gap")).toBe("12px");
  });

  it("arms Discard as V4's quiet button: a --line stroke, the second text step, no red, and 'Confirm discard'", () => {
    expect(decl(".fb-foot .btn.danger.armed", "border-color")).toBe("var(--line)");
    expect(decl(".fb-foot .btn.danger.armed", "color")).toBe("var(--text-secondary)");
    expect(decl(".fb-foot .btn.danger.armed", "background")).toBe("transparent");
    expect(decl(".fb-foot .btn.danger.armed", "font-weight")).toBe("500");
    const shell = read("i18n/areas/shell/en.ts");
    expect(shell).toContain('"shell.feedback.discardConfirm": "Confirm discard"');
  });

  it("says thanks with a comma, and 'sent with it' with a comma", () => {
    const shell = read("i18n/areas/shell/en.ts");
    expect(shell).toContain('"shell.feedback.sent": "Thanks, feedback sent."');
    expect(shell).toContain('"shell.feedback.factsWith": "{facts}, sent with it"');
    expect(shell).not.toContain("Thanks — feedback sent");
  });

  it("takes an armed Discard back when the message or the contact is typed in", () => {
    expect(read("use-feedback-draft.ts")).toContain("const disarm = useCallback(() => setArmed(false), []);");
    expect(feedback).toMatch(/useEffect\(\(\) => \{ if \(discardArmed\) disarmDiscard\(\); \}, \[body, contact\]\)/);
  });
});

describe("Usage history", () => {
  it("holds the medium width in every phase, so the dialog does not move when the answer lands", () => {
    expect(decl(".modal.uh-modal", "width")).toBe("var(--dialog-m)");
    expect(css).not.toMatch(/\.modal\.uh-modal\[data-phase/);
    expect(history).not.toContain("data-phase");
    expect(decl(".uh-status-wait", "min-height")).toBe("var(--uh-chart-h)");
    expect(decl(".uh-chart", "height")).toBe("var(--uh-chart-h)");
    expect(decl(".modal.uh-modal", "--uh-chart-h")).toBe("180px");
    expect(decl(".uh-body", "display")).toBe("flex");
    expect(decl(".uh-body", "flex-direction")).toBe("column");
    expect(decl(".uh-body", "gap")).toBe("12px");
  });

  it("draws the range as pills with a hairline, the chosen one on the accent wash, and keeps the four ranges", () => {
    expect(history).toContain("const PRESETS = [7, 14, 30, 90];");
    expect(decl(".uh-toolbar .uh-range-btn", "min-height")).toBe("var(--ctl-h-sm)");
    expect(decl(".uh-toolbar .uh-range-btn", "padding")).toBe("0 8px");
    expect(decl(".uh-toolbar .uh-range-btn", "border")).toBe("1px solid var(--line)");
    expect(decl(".uh-toolbar .uh-range-btn", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".uh-toolbar .uh-range-btn", "color")).toBe("var(--text-secondary)");
    expect(decl('.uh-toolbar .uh-range-btn[aria-pressed="true"]', "border-color")).toBe("var(--accent)");
    expect(decl('.uh-toolbar .uh-range-btn[aria-pressed="true"]', "background")).toBe("var(--accent-16)");
    expect(decl('.uh-toolbar .uh-range-btn[aria-pressed="true"]', "color")).toBe("var(--text)");
  });

  it("puts where the figures come from and the re-run on the right of the toolbar", () => {
    expect(decl(".uh-source", "margin-left")).toBe("auto");
    expect(decl(".uh-sub", "color")).toBe("var(--muted)");
    expect(px(decl(".uh-sub", "font-size"))).toBe(12);
    expect(decl(".uh-reload", "width")).toBe("24px");
    expect(decl(".uh-reload", "border-radius")).toBe("var(--r-ctl)");
    expect(history.indexOf('className="uh-toolbar"')).toBeLessThan(history.indexOf('className="glyph-btn uh-reload"'));
  });

  it("draws the stats bare: the value over the label, 32 apart, mono 18/24 over sans 12/16", () => {
    expect(decl(".uh-totals", "gap")).toBe("4px 32px");
    expect(decl(".uh-stat-val", "font-family")).toBe("var(--font-mono)");
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a figure at 16.
    expect(px(decl(".uh-stat-val", "font-size"))).toBe(16);
    expect(decl(".uh-stat-val", "font-weight")).toBe("600");
    expect(decl(".uh-stat-val", "line-height")).toBe("calc(24px + var(--ui-text-increase, 0px))");
    expect(px(decl(".uh-stat-label", "font-size"))).toBe(12);
    expect(decl(".uh-stat-label", "color")).toBe("var(--muted)");
    expect(decl(".uh-stat", "background")).toBeNull();
    expect(decl(".uh-stat", "border")).toBeNull();
    for (const key of ["totalCost", "tokens", "inOut", "cacheReads"]) expect(history).toContain(`insights.usage.${key}`);
  });

  it("draws each day as a 24-wide bar with its value over it (mono 11) and its name under it (11), 3 apart", () => {
        expect(decl(".uh-bar", "width")).toBe("min(24px, 78%)");
    expect(decl(".uh-bar-col", "gap")).toBe("3px");
    expect(decl(".uh-bar-plot", "gap")).toBe("3px");
    expect(decl(".uh-bar-value", "font-family")).toBe("var(--font-mono)");
    expect(px(decl(".uh-bar-value", "font-size"))).toBe(11);
    expect(decl(".uh-bar-value", "color")).toBe("var(--muted)");
    expect(px(decl(".uh-bar-label", "font-size"))).toBe(11);
    expect(decl(".uh-bar-label", "color")).toBe("var(--muted)");
    expect(decl(".uh-bar-seg", "box-shadow")).toBe("0 -1px 0 var(--panel)");
  });

  it("names the weekday under a column when there are two weeks or fewer, and a dollar value over its bar", () => {
    expect(weekdayShort("2026-10-27")).toBe("Tue");
    expect(weekdayShort("not a day")).toBe("not a day");
    expect(dayValue(24.4)).toBe("$24");
    expect(dayValue(0.4)).toBe("<$1");
    expect(dayValue(0)).toBe("");
    expect(history).toContain("days.length > 0 && days.length <= 14");
  });

  it("draws the note on the control fill, at the panel radius, 12/16 in the second step", () => {
    expect(decl(".uh-cost-note", "background")).toBe("var(--ctl-fill)");
    expect(decl(".uh-cost-note", "border-radius")).toBe("var(--r-panel)");
    expect(decl(".uh-cost-note", "padding")).toBe("6px 8px");
    expect(decl(".uh-cost-note", "color")).toBe("var(--text-secondary)");
  });

  it("closes on the shell's footer with Done (also while it reads), or Try again when the run failed", () => {
    expect(history).toContain('<footer className="modal-foot">');
    expect(history).toContain('onClick={onClose}>{t("shell.done")}</button>');
    expect(history).toMatch(/className="btn primary uh-retry"/);
    expect(history).not.toMatch(/view\.phase !== "busy" && \(/);
  });

  it("says a failure as V4 does (the heading, the hint) and keeps the reason reachable", () => {
    expect(history).toContain('className="uh-err-title">{t("insights.usage.noReport")}');
    expect(history).toContain('className="uh-err-hint">{t("insights.usage.checkHint")}');
    expect(history).toContain('className="uh-err-reason">{failureReason}');
    expect(history).toContain("title={commandOutput(landed!.resp) || undefined}");
    expect(read("i18n/areas/insights/en.ts")).toContain('"insights.usage.checkHint": "Check that it can run on this machine, then try again."');
    expect(px(decl(".uh-reading-title, .uh-err-title", "font-size"))).toBe(13);
    expect(decl(".uh-reading-title, .uh-err-title", "font-weight")).toBe("600");
    expect(decl(".uh-reading-note, .uh-err-hint, .uh-err-reason", "color")).toBe("var(--muted)");
  });

  it("reads as the words and two skeleton rows: 28 high, a 14 dot and bars of 120 and 48 by 8", () => {
    expect(decl(".uh-skel-row", "height")).toBe("var(--row-table, 28px)");
    expect(decl(".uh-skel-row", "padding")).toBe("0 8px");
    expect(decl(".uh-skel-row", "gap")).toBe("8px");
    expect(decl(".uh-skel-row i", "background")).toBe("var(--ctl-fill)");
    expect(decl(".uh-skel-dot", "width")).toBe("14px");
    expect(decl(".uh-skel-bar", "width")).toBe("120px");
    expect(decl(".uh-skel-bar", "height")).toBe("8px");
    expect(decl(".uh-skel-end", "width")).toBe("48px");
    expect(history).not.toContain("uh-reading-art");
  });

  it("shows a day as a Model, Input, Output and Cost table, with the CLIs, the notes and the cache counts kept", () => {
    expect(dayDetail).toMatch(/<table className="uh-day-table">/);
    for (const key of ["insights.usage.model", "insights.cost.inputTitle", "insights.cost.outputTitle", "insights.usage.cost"]) expect(dayDetail).toContain(`t("${key}")`);
    expect(dayDetail).toContain("fmtTokens(mb.inputTokens)");
    expect(dayDetail).toContain("fmtTokens(mb.outputTokens)");
    expect(dayDetail).toContain("reportedCost(mb.cost, mb.missingPricing)");
    expect(dayDetail).toContain("agentsLine");
    // The head names use the dialog's Input and Output keys, the share is visible, and two or more models get a total row.
    expect(dayDetail).toContain('t("insights.cost.inputTitle")');
    expect(dayDetail).toContain('t("insights.cost.outputTitle")');
    expect(dayDetail).toContain('className="uh-model-share"');
    expect(dayDetail).toContain("selectedDay.modelBreakdowns.length > 1 && (");
    expect(dayDetail).toContain('t("insights.usage.dayTotal")');
    expect(dayDetail).toContain("missingPriceNote()");
    expect(dayDetail).toContain("insights.usage.cacheWrite");
    expect(dayDetail).toContain("insights.usage.cacheRead");
    expect(decl(".uh-day-table thead th", "height")).toBe("24px");
    expect(px(decl(".uh-day-table thead th", "font-size"))).toBe(11);
    expect(decl(".uh-day-table thead th", "font-weight")).toBe("500");
    expect(decl(".uh-day-table tbody th, .uh-day-table tbody td", "height")).toBe("28px");
    expect(decl(".uh-day-table tbody td", "font-family")).toBe("var(--font-mono)");
    expect(decl(".uh-day-table tbody td", "color")).toBe("var(--text-secondary)");
    expect(decl(".uh-day-table tbody th", "color")).toBe("var(--text)");
    expect(decl(".uh-day-table th:nth-child(4), .uh-day-table td:nth-child(4)", "width")).toBe("110px");
  });

  it("keeps the cost-by-CLI split, the legend and the notes in the loaded view", () => {
    expect(history).toContain('className="uh-agents"');
    expect(history).toContain('className="uh-legend"');
    expect(history).toContain("missingPriceNote()");
    expect(history).toContain("storedCostNote(storedCost, totalCost)");
  });
});

describe("Session usage", () => {
  it("draws the two stats bare, the value over the label, mono 18/24 and sans 12/16", () => {
    expect(decl(".su-totals", "gap")).toBe("8px 32px");
    expect(decl(".su-totals > div", "flex-direction")).toBe("column-reverse");
    expect(decl(".su-totals dd", "font-family")).toBe("var(--font-mono)");
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a figure at 16.
    expect(px(decl(".su-totals dd", "font-size"))).toBe(16);
    expect(decl(".su-totals dd", "font-weight")).toBe("600");
    expect(decl(".su-totals dt, .su-tokens dt, .su-dates dt", "color")).toBe("var(--muted)");
    expect(decl(".su-totals", "border-bottom")).toBeNull();
  });

  it("draws the split bar 6 high with 4-radius parts, and the four counts as a value over a name, 16 apart", () => {
    expect(decl(".su-composition", "height")).toBe("6px");
    expect(decl(".su-composition", "gap")).toBe("2px");
    expect(decl(".su-composition > span", "border-radius")).toBe("var(--r-tag)");
    expect(decl(".su-tokens", "gap")).toBe("8px 16px");
    expect(decl(".su-tokens > div", "flex-direction")).toBe("column-reverse");
    expect(decl(".su-tokens dd", "font-family")).toBe("var(--font-mono)");
    expect(decl(".su-tokens dd", "color")).toBe("var(--text)");
    expect(session).toContain("insights.cost.inputTitle");
    expect(session).toContain("insights.usage.cacheWriteTitle");
  });

  it("heads the sections 12/600 in the second step, and the model rows 24 high: the name muted, the figure in mono text", () => {
    expect(decl(".su-section-head h3", "color")).toBe("var(--text-secondary)");
    expect(decl(".su-section-head h3", "font-weight")).toBe("600");
    expect(decl(".su-models th, .su-models td", "height")).toBe("24px");
    expect(decl(".su-models th", "color")).toBe("var(--muted)");
    expect(decl(".su-dates > div", "min-height")).toBe("24px");
    expect(decl(".su-dates dd", "color")).toBe("var(--text-secondary)");
  });

  it("puts the session's name on the right of the header and Done in the footer, and keeps every line it showed", () => {
    expect(session).toMatch(/className="modal-dur su-caption" title=\{session\.label\}/);
    expect(session).toContain('<footer className="modal-foot">');
    expect(session).toContain('t("shell.done")');
    for (const key of ["first", "last", "records", "reuse", "breakdown", "models", "used"]) expect(session).toContain(`insights.session.${key}`);
    expect(session).toContain("insights.session.note.auto");
    // The counts are the deck's compact figures (12.4k, 3.30M), the exact count on each title.
    expect(session).toContain("fmtTokens(detail.totalTokens)");
    expect(session).toContain("title={count(n)}>{fmtTokens(n)}");
  });
});

describe("Tool call", () => {
  const call = (ms: number | null) => ({ id: "t", name: "Bash", startedAt: 0, endedAt: ms == null ? undefined : ms }) as unknown as ToolCall;

  it("has no status dot, and writes the duration as '1.24 s'", () => {
    expect(toolModal).not.toContain("status-dot");
    expect(dialogDuration(call(1240), "in-flight…")).toBe("1.24 s");
    expect(dialogDuration(call(842), "in-flight…")).toBe("842 ms");
    expect(dialogDuration(call(null), "in-flight…")).toBe("in-flight…");
    expect(toolModal).toContain('dialogDuration(tool, t("insights.tool.inflight"))');
  });

  it("is the small dialog (560), as V4 draws it", () => {
    expect(decl(".modal.tool-modal", "width")).toBe("var(--dialog-s)");
  });

  it("sets each payload in a sunken code box: 6 round, no edge, 8 and 10 of padding, mono 12/16, not wrapped", () => {
    expect(decl(".tool-modal .modal-section pre", "background")).toBe("var(--sunken)");
    expect(decl(".tool-modal .modal-section pre", "border")).toBe("0");
    expect(decl(".tool-modal .modal-section pre", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".tool-modal .modal-section pre", "padding")).toBe("8px 10px");
    expect(decl(".tool-modal .modal-section pre", "color")).toBe("var(--text-secondary)");
    expect(decl(".tool-modal .modal-section pre", "white-space")).toBe("pre");
    expect(decl(".modal-section pre", "font-family")).toBe("var(--font-mono)");
    expect(decl(".tool-modal .modal-body", "gap")).toBe("12px");
  });

  it("copies from a 24 icon button that keeps its name and says it was copied", () => {
    expect(decl(".tm-copy.glyph-btn", "width")).toBe("24px");
    expect(decl(".tm-copy.glyph-btn", "height")).toBe("24px");
    expect(decl(".tm-copy.glyph-btn", "border-radius")).toBe("var(--r-ctl)");
    expect(toolModal).toMatch(/const label = t\(copied \? `insights\.tool\.copied\.\$\{what\}` : `insights\.tool\.copy\.\$\{what\}`\);/);
    expect(toolModal).toContain("aria-label={label} title={label}");
    expect(toolModal).toContain('{copied ? <KitStateGlyph name="done" /> : <KitIcon name="copy" />}');
    expect(toolModal).toContain("setCopied(true)");
    expect(toolModal).toContain("1_600");
  });

  it("writes 'error' as plain 12/500 text in the error colour, not a pill, and leaves the response text in the second step", () => {
    expect(decl(".modal-section .err-tag", "color")).toBe("var(--err)");
    expect(decl(".modal-section .err-tag", "font-weight")).toBe("500");
    expect(decl(".modal-section .err-tag", "border")).toBeNull();
    expect(decl(".modal-section .err-tag", "background")).toBeNull();
    expect(decl(".modal-section pre.tm-err", "color")).toBe("var(--text-secondary)");
  });

  it("keeps the small sub-labels, at the kit's smallest step", () => {
    expect(px(decl(".tm-label", "font-size"))).toBe(11);
    expect(decl(".tm-label", "color")).toBe("var(--muted)");
    expect(toolModal).toContain("{block.label && <span className=\"tm-label\">{block.label}</span>}");
  });
});

describe("Context breakdown", () => {
  it("opens with the approximation line at 12/16 muted, in the body, and no subtitle in the header", () => {
    expect(context).toContain('{meta && <p className="ctx-approx">{capitalFirst(copy.subtitle)}</p>}');
    expect(context).not.toContain("ctx-modal-sub");
    expect(px(decl(".ctx-approx", "font-size"))).toBe(12);
    expect(decl(".ctx-approx", "color")).toBe("var(--muted)");
  });

  it("draws the current turn as the label and the whole percent, a 2-high meter, and the compact count", () => {
    expect(decl(".ctx-modal .ctx-window-bar", "height")).toBe("2px");
    expect(decl(".ctx-modal .ctx-window-bar", "border-radius")).toBe("var(--r-tag)");
    expect(decl(".ctx-modal .ctx-window-row", "gap")).toBe("3px");
    expect(decl(".ctx-modal .ctx-window-fill", "background")).toBe("var(--muted)");
    expect(decl('.ctx-modal .ctx-window-fill[data-level="high"]', "background")).toBe("var(--text)");
    expect(decl('.ctx-modal .ctx-window-fill[data-level="full"]', "background")).toBe("var(--err)");
    expect(context).toContain("{Math.round(pct)}%");
    expect(context).toContain('t("insights.context.tokShort", { current: fmtTokens(current), window: fmtTokens(window) })');
    expect(read("i18n/areas/insights/en.ts")).toContain('"insights.context.tokShort": "{current} / {window} tok"');
  });

  it("writes counts in the deck's one spelling and keeps the exact count on the row's title", () => {
    // Deviation from the drawing: V4 writes "12.4K" and "3.2M"; the deck's one formatter writes "12.4k"
    // and "3.20M". One figure has one spelling, as token-format.ts says, so the context and session
    // dialogs use fmtTokens, the same as Usage history.
    expect(fmtTokens(12_400)).toBe("12.4k");
    expect(fmtTokens(3_200_000)).toBe("3.20M");
    expect(context).not.toContain("compactTokens");
    expect(session).not.toContain("compactTokens");
    expect(read("token-format.ts")).not.toContain("compactTokens");
    expect(context).toContain("title={meta && n !== undefined ? fmtN(n) : undefined}");
  });

  it("makes the rows 24 high with lower-case English labels, and keeps the cost and every count", () => {
    expect(decl(".ctx-modal .ctx-row, .ctx-modal .ctx-md-list li", "height")).toBe("24px");
    expect(context).toContain("currentLanguage().startsWith(\"en\")");
    for (const key of ["inputTokens", "outputTokens", "cacheWrites", "total", "cost", "userMsgs", "assistantMsgs", "toolUses", "toolResults", "reminders"]) {
      expect(context, key).toContain(`insights.context.${key}`);
    }
    // CHANGED ON PURPOSE (the UI in every language): named by its key.
    expect(context).toContain('label={t("insights.context.cacheReads")}');
    expect(en["insights.context.cacheReads"]).toBe("Cache reads");
  });

  it("closes on Done in the shell's footer", () => {
    expect(context).toContain('<footer className="modal-foot">');
    expect(context).toContain('t("shell.done")');
  });
});

describe("Session recap", () => {
  it("heads the dialog 'Session recap' with the duration on the right, and names the session on a line of its own", () => {
    expect(recap).toContain('t("insights.summary.title")');
    // CHANGED ON PURPOSE (V4 critique round 3, one state on every surface): the
    // mark is the session's own (sessionMark), the cross when its calls failed,
    // where it was always done's tick.
    expect(recap).toMatch(/<StateMark kind=\{summary\.mark\} \/>\s*<span id="ss-who-name" className="ss-who-name">\{summary\.label\}<\/span>/);
    expect(recap).toContain("mark: sessionMark(root),");
    expect(recap).toContain('labelledBy="ss-title ss-who-name"');
    expect(px(decl(".session-summary .ss-who-name", "font-size"))).toBe(13);
    expect(decl(".session-summary .ss-who-name", "font-weight")).toBe("600");
    expect(decl(".session-summary", "width")).toBe("var(--dialog-s)");
  });

  it("draws the figures bare, in one row: mono 18/24 over a 12/16 muted label, 32 apart", () => {
    expect(decl(".session-summary .ss-stats", "gap")).toBe("8px 32px");
    expect(decl(".session-summary .ss-stat-value", "font-family")).toBe("var(--font-mono)");
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a figure at 16.
    expect(px(decl(".session-summary .ss-stat-value", "font-size"))).toBe(16);
    expect(decl(".session-summary .ss-stat-value", "font-weight")).toBe("600");
    expect(decl(".session-summary .ss-stat-label", "color")).toBe("var(--muted)");
    expect(decl(".session-summary .ss-stat", "background")).toBeNull();
    expect(decl(".session-summary .ss-stat", "border")).toBeNull();
    expect(decl(".session-summary .ss-cost", "font-size")).toBeNull();
  });

  it("keeps spend, agents, subagents, tool calls, prompts and errors (always, even at 0), and the tokens", () => {
    for (const key of ["spend", "agents", "subagents", "toolCalls", "prompts", "errors"]) expect(recap, key).toContain(`insights.summary.${key}`);
    expect(recap).toContain('t("insights.usage.tokens")');
    expect(recap).not.toContain("summary.errCount > 0 && <Stat");
    expect(recap).toContain("title={sessionSpendLabel()}");
  });

  it("keeps the model chips and the cost split, and sets the tools as chips and the opening prompt as plain text", () => {
    expect(recap).toContain("model-chip");
    expect(recap).toContain("<CostBar cost={summary.cost}");
    expect(recap).toContain('<span className="ss-tt" key={name}>{name} <b>{count}</b></span>');
    expect(decl(".session-summary .ss-tt", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".session-summary .ss-tt", "background")).toBe("var(--ctl-fill)");
    expect(decl(".session-summary .ss-tt", "font-family")).toBe("var(--font-mono)");
    expect(decl(".session-summary .ss-prompt", "color")).toBe("var(--text-secondary)");
    expect(px(decl(".session-summary .ss-prompt", "font-size"))).toBe(13);
    expect(decl(".tool-modal .modal-section h4, .session-summary .modal-section h4", "font-weight")).toBe("600");
    expect(recap).toContain('t("shell.done")');
  });
});

describe("JSON box", () => {
  it("is a sunken box at the control radius with 8 and 10 of padding, in the second text step", () => {
    expect(decl(".tr-json-box", "background")).toBe("var(--sunken)");
    expect(decl(".tr-json-box", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".tr-json-box", "padding")).toBe("8px 10px");
    expect(decl(".tr-json-box", "color")).toBe("var(--text-secondary)");
    expect(decl(".tr-json-box", "border")).toBe("0");
    expect(decl("pre.tr-json-box", "line-height")).toBe("calc(16px + var(--ui-text-increase, 0px))");
  });

  it("is the one box in both views, and the tree and the raw text are both still there", () => {
    expect(jsonBox).toContain('<pre className="tr-value tr-json-box">');
    expect(jsonBox).toContain('className="tr-value tr-json-tree tr-json-box"');
    expect(jsonBox).toContain('mode === "raw" ?');
  });
});
