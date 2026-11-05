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
// A ROW, NOT A SWITCH. Each is a <div> with Open on the right, drawn as V4's
// link (the accent's words, 12/500, no box): there is nothing to set here, only
// somewhere to go. Open is the panel's own door — its stripe button's toggle,
// opened and never shut (App.tsx) — and it closes Settings first (settings.ts,
// doorOut). V4 draws no key cap beside it; the key that opens the same panel
// from anywhere stays on the button for assistive technology, while single-key
// shortcuts are on, and in the keyboard sheet.
//
// CLAUDE'S ROWS ARE CLAUDE'S. The accounts panel, and Local network inside it,
// are not drawn on a machine without Claude Code (rail-items.tsx), and A does
// nothing there (use-deck-shortcuts.ts); a row pointing at them would be a
// door to a wall.
import type { SettingsDoors } from "../settings";
import { SettingRow, SettingsGroup } from "./SettingsParts";
import { useT } from "../i18n";

export const ACCOUNTS_ROW = "Accounts and auto-switch";
export const CODEX_ACCOUNTS_ROW = "Codex accounts";
export const CODEX_ACCOUNTS_ROW_NOTE = "Your Codex profiles and what each has left, and which one new sessions use.";
export const ACCOUNTS_ROW_NOTE = "Your Claude accounts, and Auto-switch, which moves Claude Code to another one before the account in use runs out.";
export const LAN_ROW = "Local network";
export const LAN_ROW_NOTE = "Pairing with the decks on your other machines, so a login that expires on one is repaired from another.";
export const WATCH_ROW = "Browser Watch";
export const WATCH_ROW_NOTE = "Whether something drove your browser while you were away, and what the deck does about it.";

interface Props {
  /** Whether Claude Code is on this machine — the condition the accounts
   *  panel's own stripe button is drawn under. */
  claudeHere: boolean;
  /** Whether Codex is on this machine: the accounts panel lists its profiles,
   *  so its door is drawn for either provider. Local network repairs Claude
   *  logins and stays behind `claudeHere`. */
  codexHere?: boolean;
  /** Whether single keys answer, so whether Open names its key. */
  singleKeys: boolean;
  doors: Pick<SettingsDoors, "accounts" | "localNetwork" | "browserWatch">;
}

export default function ElsewhereSection({ claudeHere, codexHere = false, singleKeys, doors }: Props) {
  const t = useT();
  return (
    <SettingsGroup id="settings-elsewhere-caption" title={t("lan.ew.group")}>
      {(claudeHere || codexHere) && (
        <DoorRow settingId="accounts" name={claudeHere ? t("lan.ew.accounts") : CODEX_ACCOUNTS_ROW}
          note={claudeHere ? t("lan.ew.accountsNote") : CODEX_ACCOUNTS_ROW_NOTE} onOpen={doors.accounts}
          shortcut={singleKeys ? "A" : null} />

      )}
      {claudeHere && (
        <DoorRow settingId="local-network" name={t("lan.ew.lan")} note={t("lan.ew.lanNote")} onOpen={doors.localNetwork} shortcut={null} />
      )}
      <DoorRow settingId="browser-watch" name={t("lan.ew.watch")} note={t("lan.ew.watchNote")} onOpen={doors.browserWatch} dialog
        shortcut={singleKeys ? "B" : null} />
    </SettingsGroup>
  );
}

/** One door: the row's name and note, and Open. The button is named by its
 *  own word and the row's name together — "Open Local network" — so three
 *  Opens in one list are three different buttons to a screen reader, and the
 *  name starts with the word printed on it (WCAG 2.5.3). */
function DoorRow({ settingId, name, note, onOpen, shortcut, dialog = false }: {
  settingId: string;
  name: string;
  note: string;
  onOpen: () => void;
  /** The single key that opens the same panel, while single keys answer. */
  shortcut: string | null;
  /** Browser Watch opens as a dialog; the accounts panel beside the canvas. */
  dialog?: boolean;
}) {
  // From the row's own id, which is unique in Settings by construction (the
  // search jumps by it), and leaves this component calling no hooks.
  const t = useT();
  const id = `settings-${settingId}`;
  return (
    <SettingRow
      as="div"
      settingId={settingId}
      name={name}
      nameId={`${id}-name`}
      note={note}
      control={
        <button
          type="button"
          className="settings-link"
          id={`${id}-open`}
          aria-labelledby={`${id}-open ${id}-name`}
          aria-haspopup={dialog ? "dialog" : undefined}
          aria-keyshortcuts={shortcut ?? undefined}
          onClick={onOpen}
        >{t("lan.ew.open")}</button>
      }
    />
  );
}
