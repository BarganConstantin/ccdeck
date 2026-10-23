// Settings › Claude Code drawn from a reading (ClaudeCodeSettingsView): each
// row's control as the machine reads it, a reason under a row it cannot
// change, one line for a reason every row shares, and the line under a row a
// running session wrote back over.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CLAUDE_SETTINGS } from "../../server/claude-settings-catalog.mjs";
import { CLAUDE_UNDONE, ClaudeCodeSettingsView, commonReason } from "../components/ClaudeCodeSettings";
import type { ClaudeSettingRow, ClaudeSettingsState } from "../use-claude-settings";

const defaults = (): ClaudeSettingRow[] => CLAUDE_SETTINGS.map(entry => ({
  id: entry.id, isSet: false, editable: true,
  value: entry.kind === "choice" ? null : entry.kind === "days" ? 30 : entry.kind === "switch" ? (entry.unset as boolean) : true,
}));

function draw(rows: ClaudeSettingRow[] | null, over: Partial<ClaudeSettingsState> = {}) {
  const state: ClaudeSettingsState = {
    reading: rows && { claudeVersion: "2.1.309", file: "/home/u/.claude/settings.json", settings: rows, present: {} },
    saving: null, error: "", undone: null, ...over,
  };
  return renderToStaticMarkup(createElement(ClaudeCodeSettingsView, { state }));
}

const rowHtml = (html: string, id: string) => {
  const at = html.indexOf(`data-setting="claude-${id}"`);
  return html.slice(at, html.indexOf("</label>", at));
};

describe("Settings › Claude Code", () => {
  it("draws every row of the table under its caption, busy until the deck answers", () => {
    const html = draw(null);
    expect(html).toContain("Reading Claude Code settings…");
    for (const entry of CLAUDE_SETTINGS) expect(html).toContain(`data-setting="claude-${entry.id}"`);
    expect(html).toContain(">Your sessions</h3>");
    expect(rowHtml(html, "spinnerTipsEnabled")).toContain('aria-busy="true"');
    expect(rowHtml(html, "spinnerTipsEnabled")).not.toContain("disabled");
  });

  it("shows each control as the reading has it", () => {
    const rows = defaults().map(r => r.id === "crossSessionInbound" ? { ...r, value: "refuse", isSet: true }
      : r.id === "spinnerTipsEnabled" ? { ...r, value: false, isSet: true }
      : r.id === "cleanupPeriodDays" ? { ...r, value: 45, isSet: true } : r);
    const html = draw(rows);
    expect(rowHtml(html, "crossSessionInbound")).toContain('<option value="refuse" selected="">Refuse</option>');
    expect(rowHtml(html, "spinnerTipsEnabled")).toContain('aria-checked="false"');
    expect(rowHtml(html, "showTurnDuration")).toContain('aria-checked="true"');
    // A day count off the list is offered as itself, in order.
    expect(rowHtml(html, "cleanupPeriodDays")).toMatch(/30 days<\/option><option value="45" selected="">45 days<\/option><option value="90"/);
  });

  it("disables a row it cannot change and says why under it", () => {
    const rows = defaults().map(r => r.id === "effortLevel" ? { ...r, editable: false, lockedBy: "managed" as const, reason: "Set by your organization. Ask your administrator to change it." } : r);
    const html = draw(rows);
    expect(rowHtml(html, "effortLevel")).toContain("disabled");
    expect(rowHtml(html, "effortLevel")).toContain("Set by your organization.");
    expect(rowHtml(html, "spinnerTipsEnabled")).not.toContain("disabled");
  });

  it("says a reason every row shares once, above them", () => {
    const reason = "Settings could not be read. Nothing can be changed until they can.";
    const rows = defaults().map(r => ({ ...r, editable: false, reason }));
    expect(commonReason({ claudeVersion: null, file: "", settings: rows, present: {} })).toBe(reason);
    const html = draw(rows);
    expect(html.split(reason)).toHaveLength(2);
  });

  it("says under a row that a running session wrote back over it", () => {
    const html = draw(defaults(), { undone: { id: "attribution" } });
    expect(rowHtml(html, "attribution")).toContain(CLAUDE_UNDONE);
    expect(html.split(CLAUDE_UNDONE)).toHaveLength(2);
  });

  it("offers a custom value as what it is, without writing over it", () => {
    const rows = defaults().map(r => r.id === "autoUpdatesChannel" ? { ...r, custom: true, editable: false, reason: "Your settings.json holds a custom value. Edit it there." } : r);
    const html = draw(rows);
    expect(rowHtml(html, "autoUpdatesChannel")).toMatch(/<option value="\u0000custom" disabled="" selected="">Custom value<\/option>/);
  });

  it("ends with the list of every setting", () => {
    const html = draw(defaults());
    expect(html).toContain('data-setting="claude-all-settings"');
    expect(html).toContain("Filter Claude Code settings");
  });
});
