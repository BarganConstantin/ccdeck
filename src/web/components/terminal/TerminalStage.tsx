// The stage: the right-hand side of the deck while a session is open — its
// header, its terminal or the card that stands in for it, and the keys bar —
// in the lazy chunk StageShell.tsx enters.
//
// LAZY, AND THE ONLY DOOR TO XTERM. The integrator reaches this file only
// through the lazy chunk (components/terminal/StageShell.tsx, behind
// React.lazy), so nothing here — nor xterm, nor its stylesheet, nor the
// session hook — is in the chunk every visit loads (DESIGN-UI decision 9:
// flag off is byte-for-byte today's deck). xterm itself, and its stylesheet
// with it (xterm-sheet.ts), are a further dynamic import inside
// use-terminal-session.ts, so the stage's chrome can draw while the library is
// on its way.
//
// DECLARATIVE. The integrator says what to show — a session from the board, a
// new one to start, or nothing — and the geometry stage-geometry.ts gave it;
// the stage turns that into one terminal session and draws the state it is
// in. Everything the stage learns that the board might want — keys handed
// back, the cell xterm measured, a launched session's id, a sentence for the
// live region — goes back up as a callback. The board-side wiring (the
// navigator, the morph, the asks run, the shortcuts) is the integrator's.
//
// NOT A DIALOG. The stage is a region beside the board, never in the modal
// stack (modal-dismiss.ts's doctrine). Escape inside the pane belongs to the
// TUI: the deck's shortcut handler steps aside for anything inside
// [data-terminal-panel], which only the terminal's own host carries
// (StageBody) — the header and the keys bar are where focus lands when the
// keys go back to the board, and from there j, k and n are the board's.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { LaunchOptions, SessionRef, TerminalProvider } from "../../terminal-api";
import { terminalTheme } from "../../terminal-palette";
import { releaseChordLabel } from "../../terminal-keys";
import { platformName } from "../../platform";
import type { Cell, StageGeometry } from "../../stage-geometry";
import {
  TERMINAL_FONT_TOKEN,
  subjectKey,
  useTerminalSession,
  type LaunchedSession,
  type SessionDeps,
  type StageSubject,
} from "../../use-terminal-session";
import {
  canType as phaseTakesKeys,
  headerStatus,
  spineLive,
  stageAnnouncement,
  type KeysOwner,
  type StagePhaseKind,
  type StageStatus,
} from "./stage-model";
import StageHeader from "./StageHeader";
import StageBody, { type StageContext } from "./StageBody";
import { useFocusRequest } from "./use-focus-request";
import { tellDesktopKeys } from "../../desktop-keys";
import { QUIET_RESCAN_MS, quietPage } from "../../quiet-page";
import { guardLeaving } from "../../leave-guard";
import { keptKeysNotice } from "../../tab-keys";
import { useFullStage } from "./use-full-stage";
import KeysBar, { type ArrivalView, type AsksView, type EndView } from "./KeysBar";
import Divider from "./Divider";

/** How long the keys bar holds a refusal before its hints come back. */
const NOTICE_MS = 6000;

/** A session from the board, as the stage draws it. */
export interface StageSessionInfo {
  ref: SessionRef;
  name: string;
  hue: number;
  model?: string | null;
  /** The face's sentence — stageStatusFrom(board facts, now). */
  status: StageStatus;
  /** The last line the board knew, shown while the pane attaches. */
  ghostLine?: string | null;
  /** Where the session runs, for the card shown when it cannot be attached. */
  context?: StageContext | null;
  /** "14m ago", for the end bar of a session that ended. */
  endedAgo?: string | null;
}

/** What the stage is asked to show. */
export type StageShow =
  | { kind: "empty" }
  | { kind: "session"; session: StageSessionInfo }
  | { kind: "launch"; agent: TerminalProvider; cwd: string; name: string; hue: number; key: string; options?: LaunchOptions };

export interface TerminalStageProps {
  show: StageShow;
  geometry: StageGeometry;
  /** The cell the geometry was computed with — measured, or ASSUMED_CELL. */
  cell: Cell;
  /** A token lookup into the palette snapshot (use-appearance's reader). */
  readToken(token: string): string;
  expanded: boolean;
  /** Show the one-time "typing goes to the session" line. */
  firstRun: boolean;
  /** Some session is waiting: "n next ask" is worth showing. */
  asksWaiting: boolean;
  asks?: AsksView | null;
  arrival?: ArrivalView | null;
  /** Changes whenever the integrator wants keys in the pane (an ask run's
   *  next stop, Enter on the board): focus follows as soon as there is a
   *  pane to take it. */
  focusRequest?: number | string | null;
  onNextAsk?(): void;
  onAnswerArrival?(): void;
  onClose(): void;
  onToggleExpand(): void;
  onFirstRunDone(): void;
  /** Open the New session popover, hung off the control with this id. */
  onNewSession(anchorId: string): void;
  /** The divider moved; `settled` once the gesture is over (persist then). */
  onCols(cols: number, settled: boolean): void;
  onColsReset(): void;
  /** ⌨ gave the keys back: focus belongs on the board. The release chord is
   *  answered by the deck's own key listener (terminal-keys.ts). */
  onRelease?(): void;
  onKeysOwner?(owner: KeysOwner): void;
  onCell?(cell: Cell): void;
  onLaunched?(launched: LaunchedSession): void;
  /** A sentence for the deck's live region, once per change. */
  onAnnounce?(sentence: string): void;
  /** The body's phase changed — once per kind. The open morph waits on it:
   *  the stage is uncovered only once there is a pane (or a card) to show. */
  onPhase?(kind: StagePhaseKind): void;
  /** The suite's seam into the session. The integrator passes nothing. */
  sessionDeps?: Partial<SessionDeps>;
}

/** The subject the session hook is handed for what the stage shows. */
export function subjectOf(show: StageShow): StageSubject {
  switch (show.kind) {
    case "empty": return { kind: "empty" };
    case "session": return { kind: "session", ref: show.session.ref };
    case "launch": return { kind: "launch", agent: show.agent, cwd: show.cwd, key: show.key, ...(show.options ? { options: show.options } : {}) };
  }
}

/** The stage's name for itself: the session's, or the empty stage's title. */
export function stageName(show: StageShow): string {
  return show.kind === "session" ? show.session.name : show.kind === "launch" ? show.name : "Nothing on the stage";
}

export default function TerminalStage(p: TerminalStageProps) {
  const [held, setHeld] = useState(false);
  /** What the pane refused, said in the keys bar for a few seconds. */
  const [notice, setNotice] = useState<string | null>(null);
  const subject = subjectOf(p.show);
  const key = subjectKey(subject);
  const name = stageName(p.show);
  const theme = useMemo(() => terminalTheme(p.readToken), [p.readToken]);
  const fontFamily = useMemo(() => p.readToken(TERMINAL_FONT_TOKEN).trim() || "monospace", [p.readToken]);
  const chordLabel = useMemo(() => releaseChordLabel(platformName()), []);

  const session = useTerminalSession({
    subject,
    cols: p.geometry.cols,
    rows: p.geometry.rows,
    holdResize: held,
    theme,
    fontFamily,
    onCell: p.onCell,
    onLaunched: p.onLaunched,
    onNotice: setNotice,
    deps: p.sessionDeps,
  });
  const { phase } = session;

  const board = p.show.kind === "session" ? p.show.session.status : null;
  const status = headerStatus(board, phase);
  const live = spineLive(status, phase, session.streaming);
  const typing = phaseTakesKeys(phase);

  // The keyboard's owner goes up so the deck's shortcuts know to step aside.
  const onKeysOwner = useRef(p.onKeysOwner);
  onKeysOwner.current = p.onKeysOwner;
  useEffect(() => { onKeysOwner.current?.(session.keysOwner); }, [session.keysOwner]);
  // And to the desktop app, whose menu would otherwise take Ctrl+R, Ctrl+C and
  // the rest from the pane; given back when the stage goes.
  useEffect(() => { tellDesktopKeys(session.keysOwner === "pane"); }, [session.keysOwner]);
  useEffect(() => () => tellDesktopKeys(false), []);
  // And the rest of the page holds still while they do (quiet-page.ts): its
  // endless animations kept every echo waiting a frame.
  useEffect(() => {
    if (session.keysOwner !== "pane") return;
    quietPage(true);
    const again = setInterval(() => quietPage(true), QUIET_RESCAN_MS);
    return () => { clearInterval(again); quietPage(false); };
  }, [session.keysOwner]);

  // ⤢: full screen too, where that is what hands the pane Ctrl+W (tab-keys.ts).
  const fullStage = useFullStage(p.expanded, p.onToggleExpand);
  // And in a tab, leaving asks first while the keys are the pane's — Ctrl+W
  // closes the deck before the page sees it. A leave called off is answered
  // with how to give the session those keys (leave-guard.ts).
  useEffect(() => {
    if (session.keysOwner !== "pane") return;
    return guardLeaving(() => {
      const said = keptKeysNotice(fullStage.can);
      if (said) setNotice(said);
    });
  }, [session.keysOwner, fullStage.can]);

  // One sentence per change of what the stage shows — never per byte (#372).
  const onAnnounce = useRef(p.onAnnounce);
  onAnnounce.current = p.onAnnounce;
  useEffect(() => {
    const said = stageAnnouncement(name, phase);
    if (said) onAnnounce.current?.(said);
    // Keyed on the kind and the session, not the phase object, which a
    // re-render may rebuild with the same meaning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, key]);

  useEffect(() => {
    if (!notice) return;
    onAnnounce.current?.(notice);
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => { setNotice(null); }, [key]);

  // The phase itself, for the integrator's morph, which waits for the pane.
  const onPhase = useRef(p.onPhase);
  onPhase.current = p.onPhase;
  useEffect(() => { onPhase.current?.(phase.kind); }, [phase.kind]);

  useFocusRequest({ key, request: p.focusRequest, launch: subject.kind === "launch", typing, focus: session.focus });

  let end: EndView | null = null;
  if (phase.kind === "ended") {
    const ago = p.show.kind === "session" ? p.show.session.endedAgo : null;
    end = {
      sentence: `The session ended${ago ? ` ${ago}` : ""} — this is its last frame.`,
      action: "Reopen here",
      onAction: session.adopt,
    };
  } else if (phase.kind === "detached") {
    end = { sentence: "Another view took this pane over — the session keeps running.", action: "Attach again", onAction: session.retry };
  }

  const style = {
    "--session-hue": p.show.kind === "session" ? p.show.session.hue : p.show.kind === "launch" ? p.show.hue : 200,
    "--ts-term-top": `${p.geometry.termTop}px`,
    "--ts-head-h": `${p.geometry.headH}px`,
  } as CSSProperties;

  return (
    <section
      className="ts-stage"
      role="region"
      aria-label={`Terminal — ${name}`}
      data-kind={phase.kind}
      data-empty={p.show.kind === "empty" || undefined}
      data-live={live || undefined}
      data-takeover={p.geometry.takeover || undefined}
      data-held={held || undefined}
      style={style}
    >
      {/* Expanded, the stage is as wide as it goes and the divider would
          move nothing: ⤢ is the way back. */}
      {!p.geometry.takeover && !p.expanded && (
        <Divider
          cols={p.geometry.cols}
          rows={p.geometry.rows}
          range={p.geometry.range}
          appW={p.geometry.stageW + p.geometry.navW}
          navW={p.geometry.navW}
          cellW={p.cell.w}
          onCols={p.onCols}
          onReset={p.onColsReset}
          onHold={setHeld}
        />
      )}
      <StageHeader
        identity={key}
        name={name}
        provider={p.show.kind === "session" ? p.show.session.ref.provider : p.show.kind === "launch" ? p.show.agent : null}
        model={p.show.kind === "session" ? p.show.session.model : null}
        status={status}
        keysOwner={session.keysOwner}
        chordLabel={chordLabel}
        canType={typing}
        expanded={p.expanded}
        canFull={fullStage.can}
        full={fullStage.full}
        takeover={p.geometry.takeover}
        nothingRunning={p.show.kind === "empty" || phase.kind === "ended"
          || (subject.kind === "launch" && (phase.kind === "error" || phase.kind === "tmux-missing" || phase.kind === "tmux-installing"))}
        onKeys={() => {
          if (session.keysOwner === "pane") { session.release(); p.onRelease?.(); }
          else session.focus();
        }}
        onExpand={fullStage.toggle}
        onClose={p.onClose}
      />
      <StageBody
        hostRef={session.hostRef}
        phase={phase}
        ghostLine={p.show.kind === "session" ? p.show.session.ghostLine : null}
        context={p.show.kind === "session" ? p.show.session.context : null}
        onAdopt={session.adopt}
        onNotNow={p.onClose}
        onRetry={session.retry}
        onNewSession={p.onNewSession}
      />
      <KeysBar
        owner={session.keysOwner}
        name={name}
        chordLabel={chordLabel}
        canType={typing}
        asksWaiting={p.asksWaiting}
        reconnecting={phase.kind === "attaching" && phase.reconnect}
        takeover={p.geometry.takeover}
        notice={notice}
        firstRun={p.firstRun}
        onFirstRunDone={p.onFirstRunDone}
        onTypeHere={session.focus}
        end={end}
        asks={p.asks}
        arrival={p.arrival}
        onNextAsk={p.onNextAsk}
        onAnswerArrival={p.onAnswerArrival}
      />
    </section>
  );
}
