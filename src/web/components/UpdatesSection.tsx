// Settings › General › Updates: whether the deck updates itself when nothing
// is running (#2176).
//
// THE BANNER'S SWITCH, NOT A SECOND ONE. `autoUpdate` in prefs.json had one
// control, "auto when idle" inside the update banner (VersionBanner.tsx), and
// the banner is up only while a restart is waiting — so the one switch that
// decides whether a deck changes its own code could be reached only in the
// moment it was about to matter, and never to look at beforehand. This row is
// the same state and the same toggle (use-auto-restart.ts, toggleAutoRestart),
// handed down from App, so pressing either is pressing both.
//
// WHAT IT DOES, said whole, because the name cannot. There are two paths and
// the switch governs both: a tab somebody is looking at restarts the deck into
// a version already on disk once nothing has run for 30 seconds, while the
// banner offering to stop it is on screen (restart.ts, #804); and with nobody
// looking, the server itself installs a newer release and restarts into it
// after the same quiet (src/server/auto-update.mjs). The 30 seconds is one
// number on both sides — IDLE_BEFORE_RESTART_MS and AWAY_QUIET_MS.
//
// AND WHAT IT CANNOT DO HERE, said the way Notifications says a launch-time
// veto (notify-reach.ts): a deck that cannot restart itself, a deck whose
// update checks were switched off at launch, and the desktop app's own deck,
// whose updates are the app's and which this switch does not reach.
import { inDesktopApp } from "../in-app";
import { CHECKS_OFF } from "../update-check";
import type { VersionInfo } from "../use-version-check";
import { SettingRow, SettingsGroup } from "./SettingsParts";

export const AUTO_UPDATE_LABEL = "Update when idle";
export const AUTO_UPDATE_NOTE =
  "When nothing has been running for 30 seconds, the deck restarts into a newer version. While you are looking at it, that is one already installed, and only while its notice is up; while nobody is, it installs the new version first. Off, it updates only when you press.";
/** /api/version's `checkDisabled` outside the app: AGENTS_DECK_NO_UPDATE_CHECK
 *  or AGENTS_DECK_NO_INSTALL at launch. npm is never asked, so the away path
 *  has nothing to install; a version installed by hand is still restarted
 *  into. */
export const AUTO_UPDATE_CHECKS_OFF_NOTE =
  `${CHECKS_OFF} It hears of no new release from npm, and restarts only into a version installed some other way, once nothing has been running for 30 seconds.`;
/** `canRestart: false` — no supervisor, --no-persist, or an event log it
 *  cannot write (lifecycle.mjs). Neither path runs without a restart, so the
 *  switch records a choice and does nothing yet. */
export const AUTO_UPDATE_NO_RESTART_NOTE =
  "This deck cannot restart itself (it runs without its supervisor, with --no-persist, or cannot write its event log), so nothing updates on its own here. Your choice is saved for the next start.";
/** The desktop app's own deck, where the app updates itself (desktop/auto-update.mjs,
 *  and the README's Desktop app section, whose rule this is). */
export const APP_UPDATES_NOTE =
  "The desktop app keeps itself up to date. It installs a new version once it has been left alone and no agent has been working for a minute, or after waiting a day for that.";

/** Which of the four things the row says. */
export type UpdatesShape = "plain" | "checks-off" | "no-restart" | "app";

/** The row's shape, from what the deck has said about itself. Unknown until
 *  /api/version answers, and said plainly meanwhile: the general rule is true
 *  of every deck that has not said otherwise.
 *
 *  THE APP IS INFERRED, the way What's new infers it (update-check.ts): the
 *  page is in the app's window, and the deck skips npm, which a deck the app
 *  started always does (app-host.mjs). Its updates are Electron's, from the
 *  project's releases, and `autoUpdate` reaches none of it — the deck inside
 *  never has a version on disk it is not running — so a switch there would be
 *  a control that controls nothing, and the row says what does instead.
 *  No restart comes first of the other two: without one, neither path runs,
 *  whatever npm is or is not asked. */
export function updatesShape(version: VersionInfo | null, inApp: boolean): UpdatesShape {
  if (inApp && version?.checkDisabled) return "app";
  if (version?.canRestart === false) return "no-restart";
  if (version?.checkDisabled) return "checks-off";
  return "plain";
}

const NOTES: Record<Exclude<UpdatesShape, "app">, string> = {
  plain: AUTO_UPDATE_NOTE,
  "checks-off": AUTO_UPDATE_CHECKS_OFF_NOTE,
  "no-restart": AUTO_UPDATE_NO_RESTART_NOTE,
};

interface Props {
  /** The banner's switch: on unless prefs.json says `autoUpdate: false`. */
  autoRestart: boolean;
  onToggleAutoRestart: () => void;
  version: VersionInfo | null;
  /** A parameter so a test can be the app's window. */
  inApp?: boolean;
}

export default function UpdatesSection({ autoRestart, onToggleAutoRestart, version, inApp = inDesktopApp() }: Props) {
  const shape = updatesShape(version, inApp);
  return (
    <SettingsGroup id="settings-updates-caption" title="Updates">
      {shape === "app" ? (
        <SettingRow as="div" settingId="auto-update" name="Updates" note={APP_UPDATES_NOTE} />
      ) : (
        <SettingRow
          settingId="auto-update"
          name={AUTO_UPDATE_LABEL}
          nameId="settings-auto-update-label"
          note={NOTES[shape]}
          noteId="settings-auto-update-note"
          control={
            /* Operable in every shape it is drawn in, as Notifications' switch
               is under a veto: the preference is the reader's to record, and
               the note says when it will count. */
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={autoRestart}
              aria-labelledby="settings-auto-update-label"
              aria-describedby="settings-auto-update-note"
              onClick={onToggleAutoRestart}
            >
              <span className="switch-knob" />
            </button>
          }
        />
      )}
    </SettingsGroup>
  );
}
