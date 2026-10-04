// The one screen the deck shows when its React tree throws while rendering
// (#1853). There was none before: a render error blanked the page to nothing,
// with the browser console the only trace and no way for the person in front of
// it to say what happened. Now a calm full pane says so, offers a reload — which
// clears most of them — and a Send report that opens the feedback dialog already
// filled in as a bug, so the makers hear about the crash from the person it hit.
//
// It wraps the whole app in App.tsx rather than a corner of it: a boundary
// catches only what its children throw, and the crash we cannot predict is the
// one anywhere below, so the fallback stands in for the whole tree. That is also
// why it renders its OWN feedback dialog — the app's dialogs went down with the
// tree — and why the reload is a full `location.reload()` and not a state reset.
//
// The error is never swallowed: it is logged, and forwarded to the deck's own
// server the same way a caught page error is (report-errors.ts / reports.mjs),
// which sends it on only while reports are on. What the dialog opens FILLED IN
// with is scrubbed here, because feedback is not scrubbed on its way through the
// server and the words are on screen before Send — see report-errors' scrubReport.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { isEscapeKey, modalStack } from "../modal-dismiss";
import { forwardCaughtError, scrubReport } from "../report-errors";
import FeedbackDialog from "./FeedbackDialog";

/** How much of the component path to seed: enough to place the crash, not a
 *  wall of frames. Sliced before it is scrubbed, both in report-errors' caps. */
const STACK_LINES = 12;

/**
 * The body the crash report opens with: the error, then the component path React
 * gave, if any — each scrubbed of paths, addresses and keys, so nothing that
 * says who someone is reaches the box (see scrubReport). No file paths, no
 * account, no project: the error text and the component names are all it carries.
 */
export function crashReportBody(message: string, componentStack?: string | null): string {
  const parts = [scrubReport(message).trim() || "The deck threw an error with no message."];
  const stack = componentStack?.trim();
  if (stack) {
    const trimmed = stack.split("\n").slice(0, STACK_LINES).join("\n");
    parts.push("", scrubReport(trimmed).trim());
  }
  return parts.join("\n");
}

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** The component path from the last catch, for the report the boundary seeds. */
  componentStack: string | null;
  /** Whether the Send-report dialog is open over the fallback. */
  reportOpen: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, reportOpen: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Not swallowed: logged for anyone with the console open, and forwarded to
    // the deck's own server, which sends it on only while reports are on.
    console.error("ccdeck hit a render error it could not draw past", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
    forwardCaughtError(error.message, error.stack);
  }

  // Escape, for the report dialog. A modal hears it only through
  // modalStack.dismissTop(), and the one listener that calls that is in
  // use-deck-shortcuts.ts, which went down with the tree this pane replaced —
  // so the pane answers the key itself while its dialog is open, and only
  // then: while the deck runs, that listener is Escape's one owner.
  private readonly onKey = (e: KeyboardEvent) => {
    if (isEscapeKey(e.key)) modalStack.dismissTop();
  };

  componentDidUpdate(_prev: Props, prevState: State): void {
    if (this.state.reportOpen === prevState.reportOpen) return;
    if (this.state.reportOpen) window.addEventListener("keydown", this.onKey);
    else window.removeEventListener("keydown", this.onKey);
  }

  componentWillUnmount(): void {
    window.removeEventListener("keydown", this.onKey);
  }

  render(): ReactNode {
    const { error, componentStack, reportOpen } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-fallback" role="alert">
        <div className="error-fallback-card">
          <p className="error-fallback-title">Something went wrong</p>
          <p className="error-fallback-note">
            The deck hit an error it could not draw past. Reloading usually clears it — and if it
            keeps happening, a report tells the people who make ccdeck what broke.
          </p>
          <div className="error-fallback-actions">
            <button type="button" className="btn primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => this.setState({ reportOpen: true })}
              aria-haspopup="dialog"
            >
              Send report
            </button>
          </div>
        </div>
        {reportOpen && (
          <FeedbackDialog
            initialKind="bug"
            initialBody={crashReportBody(error.message, componentStack)}
            onClose={() => this.setState({ reportOpen: false })}
          />
        )}
      </div>
    );
  }
}
