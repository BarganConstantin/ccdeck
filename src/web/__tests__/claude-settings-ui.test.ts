// Settings › Claude Code drawn from a reading (ClaudeCodeSettingsView): each
// row's control as the machine reads it, a reason under a row it cannot
// change, one line for a reason every row shares, the line under a row a
// running session wrote back over or a variable outranks, and no row at all
// where the value was not read.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CLAUDE_SETTINGS } from "../../server/claude-settings-catalog.mjs";
import { CLAUDE_NO_FILE, CLAUDE_UNDONE, ClaudeCodeSettingsView, claudeFoot, commonReason, groupVersionNote, overrideLine } from "../components/ClaudeCodeSettings";
import type { ClaudeSettingRow, ClaudeSettingsReading, ClaudeSettingsState, ClaudeUserFile } from "../use-claude-settings";

const defaults = (): ClaudeSettingRow[] => CLAUDE_SETTINGS.map(entry => ({
  id: entry.id, isSet: false, editable: true,
  value: entry.kind === "choice" ? null : entry.kind === "days" ? 30 : entry.kind === "switch" ? (entry.unset as boolean) : true,
}));

const reading = (rows: ClaudeSettingRow[], userFile: ClaudeUserFile = "read", present: Record<string, string> | null = {}): ClaudeSettingsReading => ({
  claudeVersion: "2.1.309", file: "/home/u/.claude/settings.json", fileShown: "~/.claude/settings.json", userFile, settings: rows, present,
});

function draw(rows: ClaudeSettingRow[] | null, over: Partial<ClaudeSettingsState> = {}) {
  const state: ClaudeSettingsState = { reading: rows && reading(rows), saving: null, error: "", undone: null, ...over };
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
    const rows = defaults().map(r => r.id === "autoUpdatesChannel" ? { ...r, editable: false, lockedBy: "managed" as const, reason: "Set by your organization. Ask your administrator to change it." } : r);
    const html = draw(rows);
    expect(rowHtml(html, "autoUpdatesChannel")).toContain("disabled");
    expect(rowHtml(html, "autoUpdatesChannel")).toContain("Set by your organization.");
    expect(rowHtml(html, "spinnerTipsEnabled")).not.toContain("disabled");
  });

  it("says a reason every row shares once, above them", () => {
    const reason = "Settings could not be read. Nothing can be changed until they can.";
    const rows = defaults().map(r => ({ ...r, editable: false, reason }));
    expect(commonReason(reading(rows))).toBe(reason);
    const html = draw(rows);
    expect(html.split(reason)).toHaveLength(2);
  });

  it("says a version every row of a group waits for once, under the group's caption with the info icon, and the rows keep their note height", () => {
    const sessions = CLAUDE_SETTINGS.filter(entry => entry.group === "sessions");
    expect(sessions.length).toBeGreaterThan(1);
    const unread = (since: string) => `Needs Claude Code ${since} or newer, and the version installed here could not be read.`;
    const rows = defaults().map(r => {
      const entry = sessions.find(e => e.id === r.id);
      return entry ? { ...r, editable: false, reason: unread(entry.since as string) } : r;
    });
    const html = draw(rows);
    const said = "Needs Claude Code 2.1.224 or newer. The version here could not be read, so these wait.";
    expect(groupVersionNote(rows.filter(r => sessions.some(e => e.id === r.id)))).toBe(said);
    expect(html.split(said)).toHaveLength(2);
    const group = html.slice(html.indexOf('id="claude-group-sessions"'), html.indexOf('id="claude-group-memory"'));
    // Under the caption's title, with the kit's info mark, and read by none of
    // the rows' own lines.
    expect(group).toMatch(/^id="claude-group-sessions">Your sessions<\/h3><span class="settings-info" id="claude-group-sessions-info"><svg[\s\S]*?<\/svg><span>Needs Claude Code 2\.1\.224 or newer\. The version here could not be read, so these wait\.<\/span><\/span><\/div>/);
    for (const entry of sessions) {
      expect(rowHtml(html, entry.id)).toContain("disabled");
      expect(rowHtml(html, entry.id)).toMatch(/<span class="settings-row-said settings-row-said-quiet" role="status"><\/span>/);
    }
    // When the version could be read, the shorter sentence.
    const known = rows.map(r => r.reason ? { ...r, reason: "Needs Claude Code 2.1.224 or newer." } : r);
    expect(draw(known).split("Needs Claude Code 2.1.224 or newer, so these wait.")).toHaveLength(2);
  });

  it("keeps a row's own reason under it when the group's rows do not all wait for the same version", () => {
    const rows = defaults().map(r => r.id === "listAgents" ? { ...r, editable: false, reason: "Needs Claude Code 2.1.224 or newer." } : r);
    expect(groupVersionNote(rows)).toBeNull();
    const html = draw(rows);
    expect(html).not.toContain("so these wait");
    expect(rowHtml(html, "listAgents")).toContain("Needs Claude Code 2.1.224 or newer.");
    // A reason that is not a version is never folded into the caption.
    const locked = defaults().map(r => ({ ...r, editable: false, reason: "Set by your organization. Ask your administrator to change it." }));
    expect(groupVersionNote(locked.slice(0, 3))).toBeNull();
    // A group of one row keeps the reason under its row: nothing repeats.
    const git = CLAUDE_SETTINGS.filter(entry => entry.group === "git");
    expect(git).toHaveLength(1);
    const attribution = defaults().map(r => r.id === git[0].id ? { ...r, editable: false, reason: "Needs Claude Code 2.1.281 or newer." } : r);
    expect(groupVersionNote(attribution.filter(r => r.id === git[0].id))).toBeNull();
    expect(rowHtml(draw(attribution), git[0].id)).toContain("Needs Claude Code 2.1.281 or newer.");
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

  it("ends with the file the rows are saved in, and the list of every setting", () => {
    const html = draw(defaults());
    expect(html).toContain(claudeFoot("~/.claude/settings.json").replace("'", "&#x27;"));
    expect(html).toContain("Saved in ~/.claude/settings.json.");
    expect(html).toContain('data-setting="claude-all-settings"');
    expect(html).toContain("Filter Claude Code settings");
  });

  it("draws no row from a settings.json it could not read, only why, and does not call that file empty", () => {
    for (const userFile of ["invalid", "unreadable"] as const) {
      const why = userFile === "invalid" ? "Your settings.json is not valid JSON, so Claude Code skips all of it, hooks included." : "Your settings.json could not be read here.";
      const rows = defaults().map(r => ({ ...r, value: null, editable: false, reason: why }));
      const html = renderToStaticMarkup(createElement(ClaudeCodeSettingsView, {
        state: { reading: reading(rows, userFile, null), saving: null, error: "", undone: null },
      }));
      expect(html.split(why), userFile).toHaveLength(2);
      for (const entry of CLAUDE_SETTINGS) expect(html, entry.id).not.toContain(`data-setting="claude-${entry.id}"`);
      expect(html).not.toContain('role="switch"');
      expect(html).not.toContain("sets nothing yet");
      expect(html).not.toContain("The keys your settings.json sets");
      // The list of every setting stays, to look things up.
      expect(html).toContain("Filter Claude Code settings");
    }
  });

  it("draws no row while the deck has not answered at all, only the failure and a retry", () => {
    const html = draw(null, { error: "Could not read Claude Code settings. Try again." });
    expect(html).toContain("Could not read Claude Code settings.");
    expect(html).toContain(">Retry</button>");
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("Saved in");
  });

  it("says once that there is no settings.json yet, and draws Claude Code's defaults as the rows", () => {
    const html = renderToStaticMarkup(createElement(ClaudeCodeSettingsView, {
      state: { reading: reading(defaults(), "absent", {}), saving: null, error: "", undone: null },
    }));
    expect(html.split(CLAUDE_NO_FILE)).toHaveLength(2);
    expect(rowHtml(html, "autoMemoryEnabled")).toContain('aria-checked="true"');
    expect(html).not.toContain("sets nothing yet");
  });

  it("says under a row which variable outranks it and from where, and keeps the switch at what the file holds", () => {
    const override = { env: "DISABLE_AUTO_COMPACT", value: "1", where: "user" as const, effect: "Off" };
    const rows = defaults().map(r => r.id === "autoCompactEnabled" ? { ...r, override } : r);
    const html = draw(rows);
    expect(rowHtml(html, "autoCompactEnabled")).toContain("Off in every session: your settings.json sets DISABLE_AUTO_COMPACT=1.");
    expect(rowHtml(html, "autoCompactEnabled")).toContain('aria-checked="true"');
    expect(rowHtml(html, "autoCompactEnabled")).not.toContain("disabled");
    expect(overrideLine({ ...override, where: "managed" })).toBe("Off in every session: your organization sets DISABLE_AUTO_COMPACT=1.");
    expect(overrideLine({ env: "CLAUDE_CODE_DISABLE_AUTO_MEMORY", value: "0", where: "environment", effect: "On" }))
      .toBe("On in sessions started with CLAUDE_CODE_DISABLE_AUTO_MEMORY=0, as ccdeck was.");
    expect(overrideLine({ env: "DISABLE_UPDATES", value: "1", where: "organization", effect: "Updates are off" }))
      .toBe("Updates are off in every session: your organization sets DISABLE_UPDATES=1.");
  });
});
