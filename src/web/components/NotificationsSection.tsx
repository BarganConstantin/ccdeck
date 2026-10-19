// Settings › Notifications: whether the deck reaches you when nobody is looking
// at it, through which channel, and the three things it says about accounts.
//
// Lifted out of the sound popover (#711), where it was the top half: that
// popover was "how loudly does this deck interrupt me", and notifications were
// the only channel with no off switch anywhere in the app. They have their own
// section now, and Settings is the way to them on every machine, because the
// gear is always on the bar.
import { useRef } from "react";
import { useFocusRescue } from "./use-focus-rescue";
import {
  ACCOUNT_NOTIFY_NOTE, ACCOUNT_NOTIFY_SWITCHES, ACCOUNT_NOTIFY_VETO_NOTE, browserChannel, notifyNote, NOTIFY_VETO_NOTE,
  type NotifyPermission,
} from "../notify-reach";
import type { AccountNotify, AccountNotifyKind } from "../use-os-notifications";
import { inDesktopApp } from "../in-app";
import { SettingRow, SettingsGroup } from "./SettingsParts";

export interface NotificationsProps {
  /** The switch: a notification once no deck tab is open. Held server-side
   *  rather than in localStorage, because it governs the notifier that runs
   *  when no page exists, which could not read a browser's storage. */
  notifyOn: boolean;
  onToggleNotify: () => void;
  /** True when the deck was launched with AGENTS_DECK_NO_NOTIFY=1. A different
   *  question from `notifyOn` being false, and the section says a different
   *  sentence for each — "off" is the user's own press, "off — set at launch"
   *  is somebody else's decision that this press cannot undo until the next
   *  start. The switch stays operable either way: the preference is still the
   *  user's to record. */
  notifyVetoed: boolean;
  /** What the BROWSER says, which is a third question again (#801). The switch
   *  read "on" while the in-page notifier was permanently silent, because that
   *  notifier begins `if (Notification.permission !== "granted") return;` and
   *  nothing had ever mentioned a permission. */
  notifyPermission: NotifyPermission;
  /** Raise the browser's permission prompt. Only offered while the permission
   *  is still askable — a refusal cannot be re-asked by any page, which is why
   *  the row says where the switch is instead. */
  onAskNotify: () => void;
  /** The three account notifications — the deck moved the live Claude account,
   *  a quota window reached 90% or 100%, a high window reset — each its own
   *  switch, and none of them tied to the one above: they are raised whether a
   *  page is open or not, because no page says any of them. */
  accountNotify: AccountNotify;
  onToggleAccountNotify: (kind: AccountNotifyKind) => void;
}

export default function NotificationsSection({
  notifyOn, onToggleNotify, notifyVetoed, notifyPermission, onAskNotify, accountNotify, onToggleAccountNotify,
}: NotificationsProps) {
  /* The channel, and whether it is worth drawing at all. A veto silences both
     notifiers, so there is no channel to report on; the switch's own note says
     what happened instead. */
  const channel = browserChannel(notifyPermission);
  // Not inside the desktop app: its notifications are its own, and the
  // browser's permission that this section reports is never asked there.
  const inApp = inDesktopApp();
  const showChannel = notifyOn && !notifyVetoed && !inApp;

  // Enable is replaced by a status word once the browser's prompt is answered,
  // so the press that asked took its own control away (#1762). Focus goes to
  // the Notifications switch just above it: the switch this channel serves,
  // and a real control with a name, so a screen reader says where focus went.
  // Not the row's heading — a focusable heading is the invented stop
  // canvas-keyboard.test.ts keeps out of the deck.
  const notifySwitchRef = useRef<HTMLButtonElement>(null);
  const rescueChannel = useFocusRescue(!channel.ask, notifySwitchRef);

  return (
    <>
      {/* THE SWITCH FOR A DECK NOBODY IS LOOKING AT, and under it, in the same
          list, the channel it reaches you through. The note is not
          decoration: it is what separates this switch from Sounds — sound
          fires on every finished turn while a tab is open, this fires only
          when something has stopped and no tab is. */}
      <SettingsGroup id="sm-closed-caption" title="While the deck is closed">
        <SettingRow
          settingId="notify-closed"
          name="Notifications while closed"
          nameId="sm-notify-label"
          note={notifyVetoed ? NOTIFY_VETO_NOTE : notifyNote(inApp)}
          noteId="sm-notify-note"
          control={
            <button
              ref={notifySwitchRef}
              type="button"
              role="switch"
              aria-checked={notifyOn}
              aria-labelledby="sm-notify-label"
              aria-describedby="sm-notify-note"
              className="switch"
              onClick={onToggleNotify}
            >
              <span className="switch-knob" />
            </button>
          }
        />

        {/* THE CHANNEL, WHICH IS NOT A THIRD SWITCH. "Notifications" is the
            feature and "Browser notifications" is one of the two channels it
            reaches you through — two named things, so "on" and "not allowed
            yet" stop arguing and start describing different objects. The row
            under the switch it serves, in its list.
            Hidden outright when the switch is off, because telling somebody
            to allow a channel for a feature they have just turned off is
            asking them to work for nothing. Hidden under a veto for the same
            reason: the channel cannot deliver either way, and the note above
            already says so. Turning the switch on raises the prompt itself
            (App.tsx), so `ask` is the way back from a prompt that was
            dismissed rather than the main road to it. A <div>, not a label:
            its name is a capability report, not the name of the button. */}
        {showChannel && (
          <SettingRow
            as="div"
            name="Browser notifications"
            nameId="sm-channel-name"
            note={channel.note}
            control={channel.ask ? (
              <button type="button" className="btn sm-channel-action" onClick={() => { rescueChannel(); onAskNotify(); }}>
                Enable
              </button>
            ) : (
              /* A word, not a control, and it keeps the button's slot so the
                 press that grants the permission changes one label rather than
                 relaying the section under the pointer that caused it. */
              <span className="sm-channel-state" data-ok={channel.ok || undefined}>
                {channel.ok && (
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
                       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M1.5 5.2 3.9 7.6 8.5 2.4" />
                  </svg>
                )}
                {channel.status}
              </span>
            )}
          />
        )}
      </SettingsGroup>

      {/* FOUR MORE, AND NOT UNDER THE ONE ABOVE. That switch is about a deck
          nobody is looking at; these are said whether a page is open or not,
          so each is its own switch and none waits on it. One caption with one
          note, because the note is the same for all four: whose accounts,
          and that the deck need not be closed. What each one says, and when,
          is its own row's note — it was a tooltip, which a reader on a touch
          screen or a keyboard never saw. */}
      <SettingsGroup
        id="sm-accounts-caption"
        title="Accounts"
        note={notifyVetoed ? ACCOUNT_NOTIFY_VETO_NOTE : ACCOUNT_NOTIFY_NOTE}
      >
        {ACCOUNT_NOTIFY_SWITCHES.map(({ kind, label, title }) => (
          <SettingRow
            key={kind}
            settingId={kind}
            name={label}
            nameId={`sm-${kind}-label`}
            note={title}
            noteId={`sm-${kind}-note`}
            control={
              <button
                type="button"
                role="switch"
                aria-checked={accountNotify[kind]}
                aria-labelledby={`sm-${kind}-label`}
                aria-describedby={`sm-${kind}-note`}
                className="switch"
                onClick={() => onToggleAccountNotify(kind)}
              >
                <span className="switch-knob" />
              </button>
            }
          />
        ))}
      </SettingsGroup>
    </>
  );
}
