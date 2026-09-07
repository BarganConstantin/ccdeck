// The two questions a notification setting has to keep apart, and the one it
// must never put on screen.
//
//   WANT     — the switch. One press, no conditions, and it governs both of the
//              deck's notifiers at once.
//   CAN      — the browser's permission, which is not the deck's to set. It
//              gates ONE of the two notifiers, so it is a channel rather than a
//              condition of the switch.
//   WHICH    — which notifier carries a given alert. Never a control, never a
//              row, and only ever a clause: src/web/notify.ts needs a live page
//              and src/server/block-notify.mjs needs none, so a refusal in the
//              browser does not mean silence. That fact changes what the user
//              can expect, which is the whole reason it survives at all.
//
// The first two builds of this menu had all three sharing one column, and the
// symptom each time was a control contradicting itself: a switch reading "on"
// above a line saying the browser had never been asked. The fix is not shorter
// copy. It is that "Notifications" and "Browser notifications" are two named
// things, so "on" and "not yet allowed" stop being a contradiction and become
// a feature and one of its channels.
//
// The vocabulary is the user's throughout. Not "permission", not "tab hidden",
// not "sseClients": away, this tab, closed.

/** What `Notification.permission` can say, plus the case where the API is not
 *  there at all. Mirrored rather than imported from lib.dom so this still
 *  typechecks in the bare-node suite. */
export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

/** What the switch itself covers. Says WHEN, because that is the only thing
 *  separating it from the Sound switch above it — sound fires on every finished
 *  turn, this fires only when something has stopped and needs a person. */
export const NOTIFY_NOTE = "Notify me when a session needs my attention.";

/** AGENTS_DECK_NO_NOTIFY=1 at launch. Not the same as the switch being off:
 *  somebody else decided it, the press cannot undo it until the next start, and
 *  it silences BOTH notifiers — which is more than any browser setting can do.
 *  So it replaces the note above and hides the channel below: there is nothing
 *  to say about a channel when the whole feature is held. */
export const NOTIFY_VETO_NOTE =
  "Held off for this run — the deck was started with alerts disabled. Your choice is saved for the next start.";

export interface Channel {
  /** Right of the heading: a word when there is nothing to do, and `null` when
   *  the button takes that slot instead. */
  status: string | null;
  /** True only for `default`. The one state a button can act on — a refusal
   *  cannot be re-raised by any page, and a control that silently does nothing
   *  is worse than no control. */
  ask: boolean;
  /** Whether `status` is the good one, which is the only thing the sheet needs
   *  to know to draw its tick. */
  ok: boolean;
  /** One line under the heading. Deliberately IDENTICAL for the two states a
   *  user moves between, so granting the permission changes a word on the right
   *  and nothing else — the layout does not jump under the press that caused
   *  it, and the promise reads the same before and after. */
  note: string;
}

/** What this channel buys, in both of the states where it can still be had. */
const AWAY = "Get notified when you're away from this tab.";

export function browserChannel(permission: NotifyPermission): Channel {
  switch (permission) {
    case "granted":
      return { status: "Enabled", ask: false, ok: true, note: AWAY };
    case "default":
      return { status: null, ask: true, ok: false, note: AWAY };
    case "denied":
      // Where the remedy lives, and then the half that is still working — a
      // refusal here costs the page's notifier, not the deck's.
      return {
        status: "Blocked", ask: false, ok: false,
        note: "Your browser is blocking them; only its own site settings can undo that. You'll still be told once this tab is closed.",
      };
    default:
      return {
        status: "Unavailable", ask: false, ok: false,
        note: "This browser cannot show them. You'll still be told once this tab is closed.",
      };
  }
}
