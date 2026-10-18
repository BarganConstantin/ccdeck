// The stage's body: the terminal, and the state cards for when there is no
// pane to show.
//
// THE TERMINAL'S HOST IS ALWAYS HERE. xterm is opened once, into this element,
// for the stage's whole life (use-terminal-session.ts), so the host is drawn in
// every state — hidden, not removed, while a card speaks instead. Removing it
// would take the one terminal with it, and the next session would boot a new
// one into an empty box.
//
// EVERY CARD STARTS WHERE THE TERMINAL'S FIRST LINE WOULD (v3): 24px in, at the
// grid's own top, so the eye does not move between "the session" and "why the
// session is not here". A card is a few mono context lines, at most one
// sentence of 60 characters a line, and its actions. Never an empty black box,
// and never a spinner: attaching shows the last line the board knew, with a
// hairline under the header once the wait passes 300ms.
//
// The words are the deck's. Case C and "gone" print describeTarget's one
// sentence from the server; adopt's 409 is answered in place, beside the
// button it refused, never in a confirm().
//
// A BUTTON THAT IS WORKING SAYS SO AND STAYS ENABLED (#620): disabling the
// control a press came from drops keyboard focus to <body>. It carries
// aria-busy instead, and the session controller refuses the second press —
// synchronously, off its own state, before any re-render could catch up.
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { copyText } from "../../copy-text";
import { agentName, frameRun, type FrameRun, type StagePhase } from "./stage-model";
import { CopyGlyph, PlusGlyph, TerminalGlyph } from "./stage-icons";

/** The id the empty card's New session button carries, so the popover can
 *  hang off it. */
export const EMPTY_NEW_SESSION_ID = "ts-empty-new-session";

export const STILL_RUNNING_NOTE =
  "It is still running in that terminal. Reopening needs it stopped first — finish or quit it there, then check again.";

/** What the board knows that helps a card say where the session is. */
export interface StageContext {
  /** The last prompt, printed after "❯ ". */
  prompt?: string | null;
  /** One line of fact: "3 subagents working · running in another terminal". */
  fact?: string | null;
}

export interface StageBodyProps {
  hostRef: MutableRefObject<HTMLDivElement | null>;
  phase: StagePhase;
  /** The last line the board knew, shown while attaching. */
  ghostLine?: string | null;
  context?: StageContext | null;
  onAdopt(): void;
  /** "Not now": leave the stage, the session untouched. */
  onNotNow(): void;
  onRetry(): void;
  onNewSession(anchorId: string): void;
}

/** The first line of the tmux card: what is wrong with tmux, as a fact. */
export function tmuxFact(reason: string): string {
  if (reason === "too-old") return "tmux · older than 3.2 on this machine";
  if (reason === "missing") return "tmux · not found on this machine";
  return "tmux · not available here";
}

/** Why the deck's own tmux is not there, when it tried to fetch it — said
 *  before the install line, which is then the way forward. */
export function downloadNote(reason: string): string {
  if (reason === "download_failed") return "The deck could not download its own tmux. Check the connection, or install tmux yourself.";
  if (reason === "checksum_mismatch" || reason === "too_large") {
    return "The deck downloaded its own tmux, but it was not the build this deck trusts, so it was not used.";
  }
  if (reason === "extract_failed" || reason === "does_not_run") return "The deck's own tmux would not run on this machine.";
  return "The deck could not set up its own tmux.";
}

function InstallPlate({ line }: { line: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ts-cmd">
      <code><span className="ts-prompt">$ </span>{line}</code>
      <button
        type="button"
        className="glyph-btn"
        aria-label={copied ? "Copied" : "Copy the command"}
        title={copied ? "Copied" : "Copy"}
        onClick={() => { void copyText(line).then(ok => setCopied(ok)); }}
      >
        <CopyGlyph />
      </button>
    </div>
  );
}

/** The card for a phase with no pane to show, or null when the frame is
 *  what the body shows. `held`: a switch is holding the last frame up.
 *  Exported so the suite can draw each one. */
export function StateCard(p: Omit<StageBodyProps, "hostRef"> & { held?: boolean }) {
  const { phase } = p;
  switch (phase.kind) {
    case "empty":
      return (
        <div className="ts-card">
          <span className="ts-empty-glyph"><TerminalGlyph /></span>
          <p className="ts-text ts-text-first">Click a session on the board to watch it here, or start a new one.</p>
          <div className="ts-acts">
            <button type="button" id={EMPTY_NEW_SESSION_ID} className="btn primary" aria-haspopup="dialog" data-stage-land onClick={() => p.onNewSession(EMPTY_NEW_SESSION_ID)}>
              <PlusGlyph />New session
            </button>
          </div>
        </div>
      );
    case "attaching":
      // The last frame stays up while the next one attaches: no line over it.
      if (phase.reconnect || p.held) return null;
      return (
        <div className="ts-card">
          <div className="ts-ghost">{p.ghostLine || " "}</div>
        </div>
      );
    case "starting":
      return (
        <div className="ts-card">
          <div className="ts-ghost">Starting {agentName(phase.agent)} in {phase.cwd}</div>
        </div>
      );
    case "not-attachable": {
      const { target } = phase;
      return (
        <div className="ts-card">
          {p.context?.prompt && <div className="ts-ctx"><span className="ts-prompt">❯ </span>{p.context.prompt}</div>}
          {p.context?.fact && <div className="ts-ctx ts-fact"><i className="ts-fact-mark" data-kind={target.kind} aria-hidden="true" />{p.context.fact}</div>}
          <p className="ts-text">{target.label}</p>
          {phase.stillRunning && <p className="ts-note" role="status">{STILL_RUNNING_NOTE}</p>}
          <div className="ts-acts">
            {target.adoptable && (
              <button type="button" className={phase.stillRunning ? "btn" : "btn primary"} aria-busy={phase.busy || undefined} data-stage-land onClick={p.onAdopt}>
                {phase.stillRunning ? "Check again" : "Reopen here"}
              </button>
            )}
            <button type="button" className="btn" data-stage-land={target.adoptable ? undefined : true} onClick={p.onNotNow}>Not now</button>
          </div>
        </div>
      );
    }
    case "tmux-installing":
      return (
        <div className="ts-card">
          <div className="ts-ctx ts-fact"><i className="ts-fact-mark" data-kind="tmux" aria-hidden="true" />tmux · setting up</div>
          <p className="ts-text">
            This machine has no tmux the stage can use, so the deck is fetching its own: about a megabyte, once. It
            stays in the deck's folder; nothing is installed on the system.
          </p>
          <div className="ts-acts">
            <button type="button" className="btn" onClick={p.onNotNow}>Not now</button>
          </div>
        </div>
      );
    case "tmux-missing":
      return (
        <div className="ts-card">
          <div className="ts-ctx ts-fact"><i className="ts-fact-mark" data-kind="tmux" aria-hidden="true" />{tmuxFact(phase.reason)}</div>
          {phase.download && <p className="ts-note">{downloadNote(phase.download)}</p>}
          <p className="ts-text">
            The stage runs each session inside the deck's own tmux, which is what lets it keep running when you close
            the stage or the deck restarts. {phase.reason === "too-old" ? "Update it" : "Install it"}, then check again.
          </p>
          {phase.install && <InstallPlate line={phase.install} />}
          <div className="ts-acts">
            <button type="button" className="btn" aria-busy={phase.busy || undefined} data-stage-land onClick={p.onRetry}>
              {phase.busy ? "Checking…" : "Check again"}
            </button>
          </div>
        </div>
      );
    case "error":
      return (
        <div className="ts-card">
          <p className="ts-text ts-text-first">{phase.message}</p>
          <div className="ts-acts">
            <button type="button" className="btn" data-stage-land onClick={p.onRetry}>Try again</button>
            <button type="button" className="btn" onClick={p.onNotNow}>Not now</button>
          </div>
        </div>
      );
    default:
      return null;
  }
}

/** The host before its first render: nothing shown, nothing held. */
const NOTHING_SHOWN: FrameRun = { state: "hidden", afterHold: false };

export default function StageBody(p: StageBodyProps) {
  // What the host did on the last render: a switch holds the frame it was
  // showing, and the frame that follows a hold rises from the dim rather
  // than from nothing (stage-model's frameRun).
  const last = useRef<FrameRun>(NOTHING_SHOWN);
  const run = frameRun(last.current, p.phase);
  const { state, afterHold } = run;
  useEffect(() => { last.current = run; });
  const { hostRef, ...card } = p;
  // Out of the accessibility tree whenever a card speaks or a held frame is
  // only the last session's — but never over a focused textarea: Chrome
  // refuses aria-hidden on an element whose descendant keeps focus, and says
  // so in the console. A pane that stops showing a live session cannot take
  // keys anyway (the controller drops them), so its focus goes back to the
  // page first, and the keys bar then says the board has them. Set here
  // rather than in the markup, so the blur is in place before the attribute.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (state === "shown") { host.removeAttribute("aria-hidden"); return; }
    const active = typeof document === "undefined" ? null : document.activeElement as { blur?: () => void } | null;
    if (active && typeof active.blur === "function" && host.contains(active as Node)) active.blur();
    host.setAttribute("aria-hidden", "true");
  }, [state, hostRef]);
  return (
    <div className="ts-body">
      {/* The pane: every key pressed in here is the session's, Escape
          included (terminal-keys.ts reads this attribute). */}
      <div
        ref={hostRef}
        className="ts-host"
        data-terminal-panel=""
        data-shown={state === "shown" || undefined}
        data-held={state === "held" || undefined}
        data-after-hold={afterHold || undefined}
      />
      <StateCard {...card} held={state === "held"} />
    </div>
  );
}
