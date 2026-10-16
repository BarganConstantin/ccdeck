// The terminal stage as the rest of the deck sees it: whether it is open, what
// it shows, and the few steps between closed and open — decided without React,
// a terminal or a DOM, so the suite can walk every path a click, a key or the
// detail panel can take it down.
//
// WHY A STATE MACHINE AND NOT A BOOLEAN. "Open" is four different screens. A
// click on a card does not cover the board at once: the stage is mounted
// unseen while its pane attaches, because the morph out of the card has to
// uncover the session already drawn — never a box that boots (DESIGN-UI
// decision 2). So there is a WAITING step, then OPENING (the morph and the
// navigator's fold, one clock), then OPEN, and on the way back CLOSING. Every
// way in and out of the stage is one of the actions below, and the reducer is
// the one place that says what each does from each step.
//
// THE FLAG IS NOT HERE. Whether the terminal exists at all is the hook's
// (use-stage.ts); a deck with the flag off never dispatches anything, so this
// state stays at `closed` and every rule the deck had before still holds.
//
// THE FIRST CLICK OF A DOUBLE-CLICK. A click on a card opens the stage, and a
// double-click still opens the detail panel (DESIGN-UI decision 8). The
// second press of that double-click lands where the first one's stage is
// about to be, so for one double-click interval after an open that came from
// a click the stage and the navigator let presses through to the board, and
// the board stays reachable under them (`grace`). Then the double-click
// reaches the card it was aimed at, the detail panel opens, and that evicts
// the stage.
import type { LaunchOptions, TerminalProvider } from "./terminal-api";

/** Where the stage is between closed and open. */
export type ShellPhase = "closed" | "waiting" | "opening" | "open" | "closing";

/** What the stage is asked to show — by id; the stage itself turns an id into
 *  the session's name, state and pane (components/terminal/stage-board.ts). */
export type StageTarget =
  | { kind: "empty" }
  | { kind: "session"; id: string }
  | { kind: "launch"; agent: TerminalProvider; cwd: string; key: string; options?: LaunchOptions };

/** A box on the page, in CSS pixels from the viewport's top-left corner. */
export interface ShellRect { x: number; y: number; w: number; h: number }

export interface ShellState {
  phase: ShellPhase;
  /** Null exactly when the phase is `closed`. */
  target: StageTarget | null;
  /** Where the stage grows out of — the card that was clicked, or the control
   *  that opened it — and where its name sat on that card, for the rider. */
  origin: ShellRect | null;
  originName: ShellRect | null;
  /** The double-click window after an open from a click (see above). */
  grace: boolean;
  /** Changes whenever the keys are asked into the pane; null when nobody
   *  asked since the stage opened. */
  focusRequest: number | null;
  /** The control the New session popover hangs off, while it is open. */
  popover: string | null;
  /** The session the stage showed last, for the canvas's Terminal button. */
  last: string | null;
}

export type ShellAction =
  | {
    type: "open";
    target: StageTarget;
    origin?: ShellRect | null;
    originName?: ShellRect | null;
    grace?: boolean;
    /** A fresh token when the keys go to the pane, else omitted. */
    focus?: number | null;
  }
  | { type: "focus"; token: number }
  | { type: "reveal" }
  | { type: "revealed" }
  | { type: "close"; instant?: boolean }
  | { type: "closed" }
  | { type: "grace-over" }
  | { type: "popover"; anchor: string | null }
  | { type: "launched"; key: string; sessionId: string }
  | { type: "remember"; sessionId: string };

export function initialShell(): ShellState {
  return {
    phase: "closed", target: null, origin: null, originName: null, grace: false,
    focusRequest: null, popover: null, last: null,
  };
}

/** Whether two targets would show the same thing. */
export function sameTarget(a: StageTarget | null, b: StageTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "session" && b.kind === "session") return a.id === b.id;
  if (a.kind === "launch" && b.kind === "launch") return a.key === b.key;
  return a.kind === "empty";
}

/** The session id on the stage, when what it shows is a board session. */
export function targetSession(target: StageTarget | null): string | null {
  return target?.kind === "session" ? target.id : null;
}

/** Whether the stage is the board's keyboard's business: from the moment it
 *  is asked for until it starts to leave. A closing stage claims nothing. */
export function stageClaimsKeys(phase: ShellPhase): boolean {
  return phase === "waiting" || phase === "opening" || phase === "open";
}

/** Whether the board under the stage is out of reach — after the double-click
 *  window, while the stage covers it. Never while the stage is still unseen
 *  (waiting) or on its way out (closing): the board is what is on screen then. */
export function boardInert(state: Pick<ShellState, "phase" | "grace">): boolean {
  return (state.phase === "opening" || state.phase === "open") && !state.grace;
}

const CLOSED: Omit<ShellState, "last"> = {
  phase: "closed", target: null, origin: null, originName: null, grace: false, focusRequest: null, popover: null,
};

export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case "open": {
      const last = action.target.kind === "session" ? action.target.id : state.last;
      if (state.phase === "closed") {
        return {
          ...state,
          phase: "waiting",
          target: action.target,
          origin: action.origin ?? null,
          originName: action.origin ? action.originName ?? null : null,
          grace: !!action.grace,
          focusRequest: action.focus ?? null,
          popover: null,
          last,
        };
      }
      // Open already, or on its way: this is a switch. The stage stays where
      // it is and shows the other session — never a second morph. A stage
      // asked for again while it is closing comes straight back.
      const focusRequest = action.focus ?? state.focusRequest;
      if (sameTarget(state.target, action.target) && focusRequest === state.focusRequest && state.phase !== "closing") {
        return state;
      }
      return {
        ...state,
        phase: state.phase === "closing" ? "open" : state.phase,
        target: action.target,
        focusRequest,
        last,
      };
    }
    case "focus":
      return state.phase === "closed" ? state : { ...state, focusRequest: action.token };
    case "reveal":
      return state.phase === "waiting" ? { ...state, phase: "opening" } : state;
    case "revealed":
      return state.phase === "opening" ? { ...state, phase: "open" } : state;
    case "close":
      if (state.phase === "closed") return state;
      // Nothing of a waiting stage is on screen yet, so it simply goes; an
      // instant close (the detail panel took the slot) skips the motion.
      if (state.phase === "waiting" || action.instant) return { ...CLOSED, last: state.last };
      if (state.phase === "closing") return state;
      return { ...state, phase: "closing", popover: null, grace: false };
    case "closed":
      return state.phase === "closing" ? { ...CLOSED, last: state.last } : state;
    case "grace-over":
      return state.grace ? { ...state, grace: false } : state;
    case "popover":
      if (state.phase === "closed" || state.popover === action.anchor) return state;
      return { ...state, popover: action.anchor };
    case "launched": {
      // The session a launch started is on the board now: the stage goes on
      // showing it as that session, on the connection it already has.
      const t = state.target;
      if (t?.kind !== "launch" || t.key !== action.key || !action.sessionId) return state;
      return { ...state, target: { kind: "session", id: action.sessionId }, last: action.sessionId };
    }
    case "remember":
      // A launch the board has not heard of yet — Claude's trust question is
      // still on its screen, and no hook has fired — is the session the
      // Terminal button goes back to, without the stage moving off it now.
      return action.sessionId && state.last !== action.sessionId ? { ...state, last: action.sessionId } : state;
  }
}

/**
 * What the canvas's Terminal button opens: the selected session, else the one
 * the stage showed last if it is still on the board, else the empty stage —
 * whose one action is New session.
 */
export function terminalButtonTarget(
  selectedSession: string | null | undefined,
  last: string | null | undefined,
  onBoard: (sessionId: string) => boolean,
): StageTarget {
  if (selectedSession) return { kind: "session", id: selectedSession };
  if (last && onBoard(last)) return { kind: "session", id: last };
  return { kind: "empty" };
}

/** A rect the stage may grow out of: one that shows at least partly inside
 *  `pane`. A card scrolled off the canvas has nowhere on screen to grow from,
 *  and the stage then grows out of its own column instead (stage-morph.ts). */
export function visibleOrigin(rect: ShellRect | null | undefined, pane: ShellRect | null | undefined): ShellRect | null {
  if (!rect || !pane || !(rect.w > 0) || !(rect.h > 0)) return null;
  const inside = rect.x < pane.x + pane.w && rect.x + rect.w > pane.x && rect.y < pane.y + pane.h && rect.y + rect.h > pane.y;
  return inside ? rect : null;
}

/** The reading order j and k walk: every navigator tile, as the document
 *  holds them — down the first column, then the next (board-navigator.ts
 *  lays them out in that order and the navigator renders them so). */
export function navigatorOrder(root: ParentNode | null | undefined): string[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(".board-nav [data-nav-session]")]
    .map(el => el.getAttribute("data-nav-session") ?? "")
    .filter(Boolean);
}

/** The session whose navigator tile holds `target`, if any. */
export function navigatorSessionAt(target: EventTarget | null | undefined): string | null {
  const el = target as { closest?: (s: string) => Element | null } | null | undefined;
  return el?.closest?.("[data-nav-session]")?.getAttribute("data-nav-session") ?? null;
}

/** Whether the keys bar's first-run line has been seen: it is said until the
 *  reader presses "Got it", once per browser. In the agent-dag.* namespace
 *  every key this client stores is in (display-name.test.ts). */
export const STAGE_FIRST_RUN_KEY = "agent-dag.terminal.firstRunDone";
