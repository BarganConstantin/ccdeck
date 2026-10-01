// The seven dialogs the reader opens: the tool inspector, the context breakdown,
// the session recap, the shortcuts sheet, Usage history, Browser Watch and the
// feedback dialog (#1853).
// Whether each is open, and on what; the two callbacks the canvas opens them
// through; what the two that name an agent resolve to on the board; and the
// modal gate, which reads all seven.
//
// Moved out of App.tsx's `Inner` unchanged. The flags were in three places a
// hundred lines apart: four near the top, the two toolbar dialogs beside the
// Browser Watch badge, and what they resolve to further down beside the gate.
// The tour and the release notes are dialogs too and the gate counts them, but
// they open on their own and are use-welcome-and-notes.ts's; they come in here
// only for the gate. The clear prompt is use-clear-flow.ts's, and it asks the
// gate rather than being counted by it.
//
// Every setter is React's own and both callbacks are made once, so handing
// them to the board tick, the canvas and the keydown listener subscribes
// nothing again. The gate is still assigned during render, from the values
// this render resolved, so a keystroke in the same commit sees the dialogs
// that were just drawn.
import { useCallback, useState, type MutableRefObject } from "react";
import type { FeedbackPrefill } from "./feedback";
import { findToolOnBoard, type GraphState } from "./reducer";
import type { ToolCall } from "./types";
import { useModalGate } from "./use-modal-gate";
import type { useWelcomeAndNotes } from "./use-welcome-and-notes";

export function useDialogs({ stateRef, tourOpen, releaseNotes }: {
  stateRef: MutableRefObject<GraphState>;
  /** The two dialogs that open on their own, which the gate counts as well. */
  tourOpen: boolean;
  releaseNotes: ReturnType<typeof useWelcomeAndNotes>["releaseNotes"];
}) {
  // Which call the tool modal shows: its agent and its id, since an id alone
  // can name two sessions' calls (#1483).
  const [openedToolKey, setOpenedToolKey] = useState<{ agentId: string; toolId: string } | null>(null);
  const openTool = useCallback((agentId: string, toolId: string) => setOpenedToolKey({ agentId, toolId }), []);
  /** Session ID for which we're showing the end-of-session recap modal,
   *  or null when no modal is open. Opened from the detail panel's
   *  `Show recap` on a finished session. */
  const [summaryFor, setSummaryFor] = useState<string | null>(null);
  /** Session id whose context-breakdown modal is open, or null. Driven by
   *  clicking the donut on the session's root node. */
  const [contextFor, setContextFor] = useState<string | null>(null);
  const openContext = useCallback((sid: string) => setContextFor(sid), []);
  /** Whether the shortcuts sheet is up. Deliberately not persisted: it is a
   *  reference someone reaches for and closes again, and a deck that reopened
   *  it on every refresh would be answering a question nobody asked twice. */
  const [keyHelpOpen, setKeyHelpOpen] = useState(false);
  // ccusage history modal — transient (not persisted), opened from the toolbar.
  const [usageHistoryOpen, setUsageHistoryOpen] = useState(false);
  const [browserWatchOpen, setBrowserWatchOpen] = useState(false);
  /** The feedback dialog, opened from the topbar's Feedback button, the account
   *  issue popover and the error boundary (#1853). */
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  /** What the dialog opens filled in with, or null for a blank one. Cleared on
   *  close so the next blank open cannot inherit the last seed. */
  const [feedbackPrefill, setFeedbackPrefill] = useState<FeedbackPrefill | null>(null);
  /** The one door the openers use: a blank report, or one seeded for a caller. */
  const openFeedback = useCallback((prefill?: FeedbackPrefill) => {
    setFeedbackPrefill(prefill ?? null);
    setFeedbackOpen(true);
  }, []);

  // The tool the modal is showing, found without building a list of the ones it
  // is not (#997). In the render body and not skippable — the modal gate below
  // reads `openedTool != null` — so while the modal is open this runs on every
  // render, four times a second on an idle deck. What it must not do on that
  // tick is why the walk lives in the reducer; see findToolOnBoard.
  const openedTool: ToolCall | null =
    openedToolKey ? findToolOnBoard(stateRef.current.agents, openedToolKey.agentId, openedToolKey.toolId) : null;
  // The agent the context modal is about, while it is still on the board: once
  // it is evicted the modal draws nothing, and the tick closes it (#781).
  const contextAgent = contextFor ? stateRef.current.agents.get(contextFor) : undefined;

  // Whether a dialog is up that the keys must not reach past, and whether it
  // is the shortcuts sheet — use-modal-gate.ts.
  const { keyHelpOpenRef, modalOpenRef } = useModalGate({
    openedTool, usageHistoryOpen, contextFor, tourOpen, summaryFor, browserWatchOpen, keyHelpOpen, releaseNotes,
    feedbackOpen,
  });
  return {
    setOpenedToolKey, openTool, openedTool,
    summaryFor, setSummaryFor,
    contextFor, setContextFor, openContext, contextAgent,
    keyHelpOpen, setKeyHelpOpen,
    usageHistoryOpen, setUsageHistoryOpen,
    browserWatchOpen, setBrowserWatchOpen,
    feedbackOpen, setFeedbackOpen, feedbackPrefill, setFeedbackPrefill, openFeedback,
    keyHelpOpenRef, modalOpenRef,
  };
}
