// "Can I actually be alerted right now?" — one sentence, derived from the three
// facts that decide it, and kept out of the component so the suite can call it.
//
// THE MODEL THIS FILE EXISTS TO KEEP STRAIGHT. Three different things used to
// share one row of controls, and a reader had to disentangle them:
//
//   what the user WANTS        — the switch. One press, no conditions.
//   what the browser ALLOWS    — a permission, which is not the deck's to set.
//   what the deck CAN DO       — two notifiers, covering different absences.
//
// Rendering all three as peers produced the defect twice in a row: a switch
// reading "on" above a line saying a permission was missing, which is a control
// contradicting itself, and then a two-row map of routes, which answered a
// question ("which mechanism fires when") that nobody outside this repo asks.
//
// So the switch owns the first question and this owns the second. The third —
// which of the two notifiers carries a given alert — is never a control and
// never a row. It survives only as the clause at the end of these sentences,
// because it changes what the user can expect: a refusal in the browser does
// not mean silence. src/server/block-notify.mjs runs with no page at all.
//
// The vocabulary is the user's. Not "permission default", not "tab hidden", not
// "sseClients": away, this page, closed.

/** What `Notification.permission` can say, plus the case where the API is not
 *  there at all. Mirrored rather than imported from lib.dom so this still
 *  typechecks in the bare-node suite. */
export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

export interface Reach {
  /** Drives nothing but the mark beside the line: a tick, a dot, a slash.
   *  Colour is deliberately NOT part of this — see the sheet. */
  tone: "ok" | "todo" | "blocked";
  /** One sentence, in the second person, saying what will happen. */
  line: string;
  /** Whether the browser can still be asked. The only state that earns a
   *  button, because `requestPermission()` is refused for every other one and a
   *  control that silently does nothing is worse than no control. */
  ask: boolean;
}

/**
 * @param vetoed  AGENTS_DECK_NO_NOTIFY=1 at launch. Not the same question as
 *   the switch being off: this is somebody else's decision, the press cannot
 *   undo it until the next start, and the preference is still worth recording.
 *   It outranks the permission because it silences BOTH notifiers, which is
 *   more than any browser setting can do.
 */
export function notifyReach(vetoed: boolean, permission: NotifyPermission): Reach {
  if (vetoed) {
    return {
      tone: "blocked", ask: false,
      line: "This deck was started with alerts held off. Your choice is saved for the next start.",
    };
  }
  switch (permission) {
    case "granted":
      return {
        tone: "ok", ask: false,
        line: "You'll be alerted while you're away — this page open or closed.",
      };
    case "default":
      // The one line that has to earn a press, so it says what the press BUYS
      // rather than what is missing. "Needs this browser's permission" named a
      // deficiency and left the reader to work out the consequence.
      return {
        tone: "todo", ask: true,
        line: "Allow it and you'll also be alerted while this page sits in the background.",
      };
    case "denied":
      return {
        tone: "blocked", ask: false,
        line: "This browser is blocking alerts, so you're only alerted once this page is closed. Its own site settings can undo that.",
      };
    default:
      return {
        tone: "blocked", ask: false,
        line: "This browser cannot show alerts, so you're only alerted once this page is closed.",
      };
  }
}
