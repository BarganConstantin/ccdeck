// Settings › General › Elsewhere on the deck: the preferences that live in a
// panel of their own, with the way to each (#2176).
//
// Settings is where a reader looks for a preference, and three of the deck's
// most consequential ones are not in it: Auto-switch and its threshold are in
// the accounts panel, pairing is in that panel's Local network view, and what
// Browser Watch does about a finding is in Browser Watch. Each belongs where it
// is — beside the accounts, the machines and the findings it is about — so
// they stay there, and Settings lists them with the door to each, the way
// macOS System Settings and Windows 11 point at a setting another pane owns
// rather than copying it.
//
// A ROW, NOT A SWITCH. Each is a <div> with a button on the right: there is
// nothing to set here, only somewhere to go. The button is the panel's own
// door — its stripe button's toggle, opened and never shut (App.tsx) — and it
// closes Settings first (settings.ts, doorOut). Beside it, while single-key
// shortcuts are on, the key that opens the same panel from anywhere, as
// Appearance draws T beside the themes: a cap for a key that does nothing
// would be a promise the deck breaks, so it is not drawn while they are off.
//
// CLAUDE'S ROWS ARE CLAUDE'S. The accounts panel, and Local network inside it,
// are not drawn on a machine without Claude Code (rail-items.tsx), and A does
// nothing there (use-deck-shortcuts.ts); a row pointing at them would be a
// door to a wall.
import type { SettingsDoors } from "../settings";
import { SettingRow, SettingsGroup } from "./SettingsParts";

export const ACCOUNTS_ROW = "Accounts and auto-switch";
export const ACCOUNTS_ROW_NOTE = "Your Claude accounts, and Auto-switch, which moves Claude Code to the one with the most room left.";
export const LAN_ROW = "Local network";
export const LAN_ROW_NOTE = "Pairing with the decks on your other machines, so a login that expires on one is repaired from another.";
export const WATCH_ROW = "Browser Watch";
export const WATCH_ROW_NOTE = "Whether something drove your browser while you were away, and what the deck does about it.";

interface Props {
  /** Whether Claude Code is on this machine — the condition the accounts
   *  panel's own stripe button is drawn under. */
  claudeHere: boolean;
  /** Whether single keys answer, so whether a cap is drawn. */
  singleKeys: boolean;
  doors: Pick<SettingsDoors, "accounts" | "localNetwork" | "browserWatch">;
}

export default function ElsewhereSection({ claudeHere, singleKeys, doors }: Props) {
  return (
    <SettingsGroup id="settings-elsewhere-caption" title="Elsewhere on the deck">
      {claudeHere && (
        <DoorRow settingId="accounts" name={ACCOUNTS_ROW} note={ACCOUNTS_ROW_NOTE} onOpen={doors.accounts}
          cap={singleKeys ? { key: "A", title: "Press A anywhere to show or hide the accounts panel" } : null} />
      )}
      {claudeHere && (
        <DoorRow settingId="local-network" name={LAN_ROW} note={LAN_ROW_NOTE} onOpen={doors.localNetwork} cap={null} />
      )}
      <DoorRow settingId="browser-watch" name={WATCH_ROW} note={WATCH_ROW_NOTE} onOpen={doors.browserWatch} dialog
        cap={singleKeys ? { key: "B", title: "Press B anywhere to open or close Browser Watch" } : null} />
    </SettingsGroup>
  );
}

/** One door: the row's name and note, the key cap, and Open. The button is
 *  named by its own word and the row's name together — "Open Local network"
 *  — so three Opens in one list are three different buttons to a screen
 *  reader, and the name starts with the word printed on it (WCAG 2.5.3). */
function DoorRow({ settingId, name, note, onOpen, cap, dialog = false }: {
  settingId: string;
  name: string;
  note: string;
  onOpen: () => void;
  cap: { key: string; title: string } | null;
  /** Browser Watch opens as a dialog; the accounts panel beside the canvas. */
  dialog?: boolean;
}) {
  // From the row's own id, which is unique in Settings by construction (the
  // search jumps by it), and leaves this component calling no hooks.
  const id = `settings-${settingId}`;
  return (
    <SettingRow
      as="div"
      settingId={settingId}
      name={name}
      nameId={`${id}-name`}
      note={note}
      control={
        <>
          {cap && <kbd className="settings-key" aria-hidden title={cap.title}>{cap.key}</kbd>}
          <button
            type="button"
            className="btn"
            id={`${id}-open`}
            aria-labelledby={`${id}-open ${id}-name`}
            aria-haspopup={dialog ? "dialog" : undefined}
            aria-keyshortcuts={cap ? cap.key : undefined}
            onClick={onOpen}
          >Open</button>
        </>
      }
    />
  );
}
