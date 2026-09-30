// Whether one of the deck's dialogs is up, which the single-key shortcuts and
// the Clear flow must not reach past — and, separately, whether that dialog is
// the shortcuts sheet, which still answers the `?` that opened it.
//
// Moved out of App.tsx unchanged; use-dialogs.ts calls it now, with the six
// flags it holds and the two use-welcome-and-notes.ts owns. Both are refs
// assigned during render, the way App's nodesRef is: the keydown listener
// (use-deck-shortcuts.ts) is registered once and must stay that way, so it reads
// what is on screen through them rather than closing over it, and a keystroke in
// the same commit sees the dialogs that were just drawn. requestClear
// (use-clear-flow.ts) asks the same gate.
import { useRef } from "react";
import type { ToolCall } from "./types";
import { useMirroredRef } from "./use-mirrored-ref";
import type { useWelcomeAndNotes } from "./use-welcome-and-notes";

export function useModalGate({
  openedTool, usageHistoryOpen, contextFor, tourOpen, summaryFor, browserWatchOpen, keyHelpOpen, releaseNotes,
  feedbackOpen, reportsQuestionOpen,
}: {
  /** The call the tool modal is showing, while it is still on the board. */
  openedTool: ToolCall | null;
  usageHistoryOpen: boolean;
  /** The session whose context breakdown is open. */
  contextFor: string | null;
  tourOpen: boolean;
  /** The session whose recap is open. */
  summaryFor: string | null;
  browserWatchOpen: boolean;
  /** The shortcuts sheet. */
  keyHelpOpen: boolean;
  releaseNotes: ReturnType<typeof useWelcomeAndNotes>["releaseNotes"];
  /** The feedback dialog, and the one-time reports question (#1853). */
  feedbackOpen: boolean;
  reportsQuestionOpen: boolean;
}) {
  // The same treatment for the shortcuts sheet, because `?` is a toggle and the
  // gate below has to be able to tell "the sheet is the modal" from "a modal is
  // open" — the first still answers `?`, the second must not stack a second one.
  const keyHelpOpenRef = useMirroredRef(keyHelpOpen);
  const modalOpenRef = useRef(false);
  // The shortcuts sheet counts, for the reason clearActionFor gives: a clear
  // prompt raised over another dialog is two things competing for one Escape.
  // It cannot normally happen from the keyboard — the sheet holds focus and a
  // focused control keeps its own keys — but a click on the sheet's own prose
  // drops focus to <body>, and from there a stray "c" would reach Clear.
  modalOpenRef.current = openedTool != null || usageHistoryOpen || contextFor != null
    // The tour, for the same reason as the shortcuts sheet: a click on its
    // caption drops focus to <body>, and from there a stray "c" reaches Clear.
    || tourOpen
    || summaryFor != null || browserWatchOpen || keyHelpOpen || releaseNotes != null
    || feedbackOpen || reportsQuestionOpen;
  return { keyHelpOpenRef, modalOpenRef };
}
