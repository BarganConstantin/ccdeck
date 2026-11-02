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
import { claudeDaysLabel, claudeGroupTitle, claudeOptionLabel, claudeRowLabel, claudeRowNote } from "../claude-settings-text";
import { CLAUDE_SETTING_GROUPS, CLAUDE_SETTINGS, type ClaudeSettingEntry, type ClaudeSettingOption } from "../../server/claude-settings-catalog.mjs";
import { claudeReasonText, refreshClaudeSettings, setClaudeSetting, useClaudeSettings, type ClaudeSettingRow, type ClaudeSettingsState } from "../use-claude-settings";
import ClaudeSettingsIndex from "./ClaudeSettingsIndex";
import { SettingRow, SettingsGroup } from "./SettingsParts";
import SelectShell from "./SelectShell";
import { t as tNow, useT, type TFunction } from "../i18n";
import { useOptimisticSwitch } from "../use-optimistic-switch";
import { WriteState } from "./WriteState";

export const CLAUDE_UNDONE = "Changed back after saving, most likely by a running Claude Code session. Set it again to keep it.";
export const CLAUDE_NO_FILE = "There is no settings.json yet, so Claude Code uses its defaults. The first change here creates it.";

/** The line under the rows: which file they are saved in, and what can
 *  override them without the deck seeing it. */
export function claudeFoot(fileShown?: string, t: TFunction = tNow): string {
  return t("settings.claude.foot", { file: fileShown ?? t("settings.claude.footDefault") });
}

/** What a variable that outranks a row makes of it, and where it is set. */
const EFFECT_KEYS: Record<string, string> = {
  "Off": "settings.claude.effect.off",
  "On": "settings.claude.effect.on",
  "Updates are off": "settings.claude.effect.updatesOff",
  "Background updates are off": "settings.claude.effect.bgUpdatesOff",
};

export function overrideLine(o: NonNullable<ClaudeSettingRow["override"]>, t: TFunction = tNow): string {
  const set = `${o.env}=${o.value}`;
  const effect = EFFECT_KEYS[o.effect] ? t(EFFECT_KEYS[o.effect]) : o.effect;
  if (o.where === "environment") return t("settings.claude.overrideEnv", { effect, set });
  return t(o.where === "user" ? "settings.claude.overrideUser" : "settings.claude.overrideOrg", { effect, set });
}

const CUSTOM = "\u0000custom";

function Control({ entry, row, saving, nameId, noteId, flip }: {
  entry: ClaudeSettingEntry; row: ClaudeSettingRow | undefined; saving: string | null; nameId: string; noteId: string;
  flip: ReturnType<typeof useOptimisticSwitch>;
}) {
  const t = useT();
  const ready = !!row && row.editable && !saving;
  const busy = !row || saving === entry.id;
  const disabled = row ? !row.editable : undefined;
  if (entry.kind === "choice" || entry.kind === "days") {
    const options: ClaudeSettingOption[] = entry.kind === "days"
      ? (entry.options as number[]).map(days => ({ value: String(days), label: claudeDaysLabel(days, t) }))
      : (entry.options as ClaudeSettingOption[]).map(o => ({ ...o, label: claudeOptionLabel(entry.id, o.value, o.label, t) }));
    const current = row ? (row.custom ? CUSTOM : row.value === null ? "" : String(row.value)) : "";
    const shown = entry.kind === "days" && row && !row.custom && !options.some(o => o.value === current)
      ? [...options, { value: current, label: claudeDaysLabel(Number(current), t) }].sort((a, b) => Number(a.value) - Number(b.value))
      : options;
    return (
      <SelectShell>
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
          {row?.custom && <option value={CUSTOM} disabled>{t("settings.claude.customValue")}</option>}
          {shown.map(o => <option key={o.value ?? ""} value={o.value ?? ""}>{o.label}</option>)}
        </select>
      </SelectShell>
    );
  }
  const on = flip.checked;
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
      onClick={() => { if (ready) void flip.flip(); }}
    >
      <span className="switch-knob" />
    </button>
  );
}

/** One row. A switch flips on the press and the write runs behind it; a refused
 *  write slides it back, and the row says Failed as Session recovery does. */
export function ClaudeRow({ entry, row, saving, said }: {
  entry: ClaudeSettingEntry; row: ClaudeSettingRow | undefined; saving: string | null; said: string;
}) {
  const t = useT();
  const flip = useOptimisticSwitch(row ? row.value === true : null, next => setClaudeSetting(entry.id, next));
  const nameId = `claude-${entry.id}-label`, noteId = `claude-${entry.id}-note`;
  return (
    <SettingRow
      settingId={`claude-${entry.id}`}
      name={claudeRowLabel(entry, t)}
      nameId={nameId}
      note={claudeRowNote(entry, t)}
      noteId={noteId}
      control={<Control entry={entry} row={row} saving={saving} nameId={nameId} noteId={noteId} flip={flip} />}
    >
      <span className="settings-row-said settings-row-said-quiet" role="status">{said}</span>
      {flip.failed && <WriteState state="failed" role="alert" sentence={t("settings.recover.saveFail")} />}
    </SettingRow>
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
  const t = useT();
  const { reading, saving, error, undone } = state;
  const common = commonReason(reading);
  const noFile = reading?.userFile === "absent";
  const rowsKnown = reading ? reading.userFile !== "invalid" && reading.userFile !== "unreadable" : !error;
  return (
    <>
      {(reading === null || error || common || noFile) && (
        <SettingsGroup>
          {reading === null && !error && <p className="settings-row settings-row-status" role="status">{t("settings.claude.reading")}</p>}
          {common && <p className="settings-row settings-row-status" role="status">{claudeReasonText(common, t)}</p>}
          {noFile && !common && <p className="settings-row settings-row-status" role="status">{t("settings.claude.noFile")}</p>}
          {error && (
            <div className="settings-row" role="alert">
              <span className="settings-row-name">{claudeReasonText(error, t)}</span>
              <span className="settings-row-control">
                <button type="button" className="btn" aria-busy={!!saving} onClick={() => void refreshClaudeSettings()}>{t("settings.claude.retry")}</button>
              </span>
            </div>
          )}
        </SettingsGroup>
      )}
      {rowsKnown && CLAUDE_SETTING_GROUPS.map(group => (
        <SettingsGroup key={group.id} id={`claude-group-${group.id}`} title={claudeGroupTitle(group.id, group.title, t)}>
          {CLAUDE_SETTINGS.filter(entry => entry.group === group.id).map(entry => {
            const row = reading?.settings.find(r => r.id === entry.id);
            const said = row && !row.editable && !common ? claudeReasonText(row.reason ?? "", t)
              : undone?.id === entry.id ? t("settings.claude.undone")
              : row?.override ? overrideLine(row.override, t) : "";
            return <ClaudeRow key={entry.id} entry={entry} row={row} saving={saving} said={said} />;
          })}
        </SettingsGroup>
      ))}
      {rowsKnown && <p className="settings-foot">{claudeFoot(reading?.fileShown, t)}</p>}
      <ClaudeSettingsIndex present={reading?.present ?? null} noFile={noFile} />
    </>
  );
}
