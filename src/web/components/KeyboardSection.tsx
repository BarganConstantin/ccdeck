// Settings › Keyboard: whether the deck answers its single-key shortcuts
// (single-key-shortcuts.ts, WCAG 2.1.4), and every key it answers.
//
// The section used to be one switch in General, while the list of what that
// switch silences lived only in the `?` sheet — a reader deciding whether to
// turn the letters off had to leave Settings to find out which letters they
// were. The list is here now, from the same table the sheet reads
// (key-help.ts), so the two cannot disagree and a key bound in App.tsx without
// a row still fails key-help.test.ts. With the switch off it is the sheet's
// shorter table: only what still works, which is what the switch just did.
//
// A field above the groups narrows them as it is typed into, by what a key
// does or by the key — the way Raycast's and VS Code's shortcut pages are
// searched — because forty rows are a list somebody scans for one line.
import { useId, useState } from "react";
import { KEY_HELP_NOTE, keyHelpFor, type KeyHelpRow } from "../key-help";
import { isEscapeKey } from "../modal-dismiss";
import { isApplePlatform, platformName } from "../platform";
import { SettingRow, SettingsGroup } from "./SettingsParts";

interface Props {
  singleKeys: boolean;
  onToggleSingleKeys: () => void;
}

export const SINGLE_KEYS_LABEL = "Single-key shortcuts";
export const SINGLE_KEYS_NOTE =
  "Keys like L, U, M, ? and Space open panels and toggle things. Turn this off if you use voice control or press them by accident.";

/** A row's action as the name of a setting row: a capital, and the sheet's
 *  "this sheet" said from outside it. */
export function shortcutName(row: KeyHelpRow): string {
  const action = row.binds.includes("?") ? "the keyboard shortcuts sheet" : row.action;
  return action.charAt(0).toUpperCase() + action.slice(1);
}

/** Whether a row answers what was typed in the filter: its action or its cap,
 *  either platform's spelling, case aside. */
export function shortcutMatches(row: KeyHelpRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.action, row.cap, row.macCap ?? ""].some(text => text.toLowerCase().includes(q));
}

export default function KeyboardSection({ singleKeys, onToggleSingleKeys }: Props) {
  const apple = isApplePlatform(platformName());
  const [query, setQuery] = useState("");
  const filterId = useId();
  const groups = keyHelpFor(singleKeys)
    .map(group => ({ ...group, rows: group.rows.filter(row => shortcutMatches(row, query)) }))
    .filter(group => group.rows.length > 0);

  return (
    <>
      <SettingsGroup>
        <SettingRow
          settingId="single-keys"
          name={SINGLE_KEYS_LABEL}
          nameId="settings-single-keys-label"
          note={SINGLE_KEYS_NOTE}
          noteId="settings-single-keys-note"
          control={
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={singleKeys}
              aria-labelledby="settings-single-keys-label"
              aria-describedby="settings-single-keys-note"
              onClick={onToggleSingleKeys}
            >
              <span className="switch-knob" />
            </button>
          }
        />
      </SettingsGroup>

      {/* Labelled by a visually hidden word rather than a placeholder alone:
          a placeholder is gone the moment somebody types, and is not a name. */}
      <div className="settings-filter">
        <label className="vis-hidden" htmlFor={filterId}>Filter shortcuts</label>
        <input
          id={filterId}
          type="search"
          className="settings-filter-field"
          placeholder="Filter shortcuts"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={event => setQuery(event.target.value)}
          // Escape empties a filled filter first, as every search field does,
          // and only an empty one lets it through to close Settings. Stopped
          // here, it never reaches the window listener that dismisses the
          // dialog (use-deck-shortcuts.ts).
          onKeyDown={event => {
            if (isEscapeKey(event.key) && query) { event.stopPropagation(); setQuery(""); }
          }}
        />
      </div>

      {groups.map(group => {
        const id = `settings-keys-${group.title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
        return (
          <SettingsGroup key={group.title} id={id} title={group.title} className="settings-keys">
            {group.rows.map(row => (
              <SettingRow
                key={`${row.cap}:${row.action}`}
                as="div"
                name={shortcutName(row)}
                control={<kbd className="settings-key">{apple && row.macCap ? row.macCap : row.cap}</kbd>}
              />
            ))}
          </SettingsGroup>
        );
      })}
      {groups.length === 0 && (
        <p className="settings-empty" role="status">No shortcut matches “{query.trim()}”.</p>
      )}
      {query.trim() === "" && <p className="settings-foot">{KEY_HELP_NOTE}</p>}
    </>
  );
}
