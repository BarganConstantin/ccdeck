// Settings › Claude Code: a short list of Claude Code's own settings, each a
// row with a switch or a choice that writes the user's settings.json, and
// under it every key Claude Code documents, to look up (ClaudeSettingsIndex).
//
// THE LIST IS THE TABLE'S (claude-settings-catalog.mjs), in its groups and its
// words, so a row offers what the server accepts and nothing else. Each row
// reads as the machine does (use-claude-settings.ts): a row an administrator
// decides, or that this Claude Code is too old for, keeps its control but
// disabled, with the reason under it; a row a running session wrote back over
// says so under it until it is set again.
//
// In the shared shape (SettingsParts.tsx, #2176): one group per caption, the
// name and one line on the left, the control on the right. While the deck has
// not answered, a control is busy rather than disabled, as Radar's switch is,
// and the press is refused in the handler.
//
// NO VALUE IT DID NOT READ. When settings.json cannot be read, or the deck
// does not answer, the rows are not drawn at all — a switch has no position
// for "not known", and a default drawn there would read as the user's own.
// A file that is not there yet is Claude Code on its defaults, and is said to
// be. A variable that outranks a row is said under it.
import { CLAUDE_SETTING_GROUPS, CLAUDE_SETTINGS, daysLabel, type ClaudeSettingEntry, type ClaudeSettingOption } from "../../server/claude-settings-catalog.mjs";
import { refreshClaudeSettings, setClaudeSetting, useClaudeSettings, type ClaudeSettingRow, type ClaudeSettingsState } from "../use-claude-settings";
import ClaudeSettingsIndex from "./ClaudeSettingsIndex";
import { SettingRow, SettingsGroup } from "./SettingsParts";

export const CLAUDE_UNDONE = "Changed back after saving, most likely by a running Claude Code session. Set it again to keep it.";
export const CLAUDE_NO_FILE = "There is no settings.json yet, so Claude Code uses its defaults. The first change here creates it.";

/** The line under the rows: which file they are saved in, and what can
 *  override them without the deck seeing it. */
export function claudeFoot(fileShown?: string): string {
  return `Saved in ${fileShown ?? "your settings.json"}. A project's own .claude/settings.json, and policies set through MDM or the Windows registry, can override these rows and are not shown here.`;
}

/** What a variable that outranks a row makes of it, and where it is set. */
export function overrideLine(o: NonNullable<ClaudeSettingRow["override"]>): string {
  const set = `${o.env}=${o.value}`;
  if (o.where === "environment") return `${o.effect} in sessions started with ${set}, as ccdeck was.`;
  return `${o.effect} in every session: ${o.where === "user" ? "your settings.json" : "your organization"} sets ${set}.`;
}

const CUSTOM = "\u0000custom";

function Control({ entry, row, saving, nameId, noteId }: {
  entry: ClaudeSettingEntry; row: ClaudeSettingRow | undefined; saving: string | null; nameId: string; noteId: string;
}) {
  const ready = !!row && row.editable && !saving;
  const busy = !row || saving === entry.id;
  const disabled = row ? !row.editable : undefined;
  if (entry.kind === "choice" || entry.kind === "days") {
    const options: ClaudeSettingOption[] = entry.kind === "days"
      ? (entry.options as number[]).map(days => ({ value: String(days), label: daysLabel(days) }))
      : (entry.options as ClaudeSettingOption[]);
    const current = row ? (row.custom ? CUSTOM : row.value === null ? "" : String(row.value)) : "";
    const shown = entry.kind === "days" && row && !row.custom && !options.some(o => o.value === current)
      ? [...options, { value: current, label: daysLabel(Number(current)) }].sort((a, b) => Number(a.value) - Number(b.value))
      : options;
    return (
      <select
        className="sm-select"
        aria-labelledby={nameId}
        aria-describedby={noteId}
        aria-busy={busy}
        disabled={disabled}
        value={current}
        onChange={event => {
          if (!ready) return;
          const next = event.target.value;
          void setClaudeSetting(entry.id, entry.kind === "days" ? Number(next) : next === "" ? null : next);
        }}
      >
        {row?.custom && <option value={CUSTOM} disabled>Custom value</option>}
        {shown.map(o => <option key={o.value ?? ""} value={o.value ?? ""}>{o.label}</option>)}
      </select>
    );
  }
  const on = row?.value === true;
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={on}
      aria-labelledby={nameId}
      aria-describedby={noteId}
      aria-busy={busy}
      disabled={disabled}
      onClick={() => { if (ready) void setClaudeSetting(entry.id, !on); }}
    >
      <span className="switch-knob" />
    </button>
  );
}

/** The one reason every row is off, when there is one — the file could not
 *  be read, Claude Code is too old — said once above the rows rather than
 *  fourteen times under them. */
export function commonReason(reading: ClaudeSettingsState["reading"]): string | null {
  if (!reading?.settings.length || reading.settings.some(row => row.editable)) return null;
  const reasons = new Set(reading.settings.map(row => row.reason));
  return reasons.size === 1 ? [...reasons][0] ?? null : null;
}

export default function ClaudeCodeSettings() {
  return <ClaudeCodeSettingsView state={useClaudeSettings()} />;
}

export function ClaudeCodeSettingsView({ state }: { state: ClaudeSettingsState }) {
  const { reading, saving, error, undone } = state;
  const common = commonReason(reading);
  const noFile = reading?.userFile === "absent";
  const rowsKnown = reading ? reading.userFile !== "invalid" && reading.userFile !== "unreadable" : !error;
  return (
    <>
      {(reading === null || error || common || noFile) && (
        <SettingsGroup>
          {reading === null && !error && <p className="settings-row settings-row-status" role="status">Reading Claude Code settings…</p>}
          {common && <p className="settings-row settings-row-status" role="status">{common}</p>}
          {noFile && !common && <p className="settings-row settings-row-status" role="status">{CLAUDE_NO_FILE}</p>}
          {error && (
            <div className="settings-row" role="alert">
              <span className="settings-row-name">{error}</span>
              <span className="settings-row-control">
                <button type="button" className="btn" aria-busy={!!saving} onClick={() => void refreshClaudeSettings()}>Retry</button>
              </span>
            </div>
          )}
        </SettingsGroup>
      )}
      {rowsKnown && CLAUDE_SETTING_GROUPS.map(group => (
        <SettingsGroup key={group.id} id={`claude-group-${group.id}`} title={group.title}>
          {CLAUDE_SETTINGS.filter(entry => entry.group === group.id).map(entry => {
            const row = reading?.settings.find(r => r.id === entry.id);
            const nameId = `claude-${entry.id}-label`, noteId = `claude-${entry.id}-note`;
            const said = row && !row.editable && !common ? row.reason
              : undone?.id === entry.id ? CLAUDE_UNDONE
              : row?.override ? overrideLine(row.override) : "";
            return (
              <SettingRow
                key={entry.id}
                settingId={`claude-${entry.id}`}
                name={entry.label}
                nameId={nameId}
                note={entry.note}
                noteId={noteId}
                control={<Control entry={entry} row={row} saving={saving} nameId={nameId} noteId={noteId} />}
              >
                <span className="settings-row-said settings-row-said-quiet" role="status">{said}</span>
              </SettingRow>
            );
          })}
        </SettingsGroup>
      ))}
      {rowsKnown && <p className="settings-foot">{claudeFoot(reading?.fileShown)}</p>}
      <ClaudeSettingsIndex present={reading?.present ?? null} noFile={noFile} />
    </>
  );
}
