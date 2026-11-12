// The stage: the right-hand side of the deck while a session is open — its
// header, its terminal or the card that stands in for it, and the keys bar —
// in the lazy chunk StageShell.tsx enters.
//
// LAZY, AND THE ONLY DOOR TO XTERM. The integrator reaches this file only
// through the lazy chunk (components/terminal/StageShell.tsx, behind
// React.lazy), so nothing here — nor xterm, nor its stylesheet, nor the
// session hook — is in the chunk every visit loads (the flag
// off is byte-for-byte today's deck). xterm itself, and its stylesheet
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
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
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
  agentName,
  canType as phaseTakesKeys,
  frameState,
  headerStatus,
  onItsWay,
  spineLive,
  stageAnnouncement,
  type FrameState,
  type KeysOwner,
  type StagePhase, type StagePhaseKind,
  type StageStatus,
} from "./stage-model";
import StageHeader from "./StageHeader";
import StageBody, { catchKeys, type StageContext } from "./StageBody";
import type { HeldKeys } from "../../type-ahead";
import { useFocusRequest } from "./use-focus-request";
import { tellDesktopKeys } from "../../desktop-keys";
import { QUIET_RESCAN_MS, quietPage } from "../../quiet-page";
import { guardLeaving } from "../../leave-guard";
import { isKeptKeysNotice, keptKeysNotice } from "../../tab-keys";
import { useFullStage } from "./use-full-stage";
import { WORKSPACE_PANE_ID } from "../../workspace-pane";
import { usePaneRoom } from "./use-pane-room";
import KeysBar, { type ArrivalView, type AsksView, type EndView } from "./KeysBar";
import PhoneKeys from "./PhoneKeys";
import Divider from "./Divider";
import HostsDialog from "./HostsDialog";
import { t as tNow, useT } from "../../i18n";
import { useScreenFlags } from "../../use-screens";
import { fontSizeFor, stepTerminalText, useTerminalTextStep } from "../../terminal-text-size";
import { chatSessionFor, useSessionTranscript } from "../../use-session-transcript";
import { DialogPresence } from "../Dialog";
import type { HostsApi } from "./older-hosts";
import { useOlderHosts } from "./use-older-hosts";
import type { WaitingCard } from "./stage-board";

/** The phases with no pane to type into, whose cards carry no keys bar. */
const PANELESS: ReadonlySet<StagePhaseKind> = new Set<StagePhaseKind>([
  "empty", "not-attachable", "error", "tmux-missing", "tmux-installing",
]);

/** How long the keys bar holds a refusal before its hints come back. */
const NOTICE_MS = 6000;

/** The phases whose card is the stage's answer, which a request for the keys
 *  lands on: not the ones on their way to a pane. tmux missing while it
 *  checks again is on its way too: Check again asks for the keys, which its
 *  own card would otherwise answer at once, before the check had. So is a
 *  card's Reopen here while it works. */
export function settlesFocus(phase: StagePhase): boolean {
  return phase.kind !== "attaching" && phase.kind !== "starting" && phase.kind !== "tmux-installing"
    && !((phase.kind === "tmux-missing" || phase.kind === "error" || phase.kind === "not-attachable") && phase.busy)
    && !(phase.kind === "live" && !phase.readOnly);
}

/**
 * Focus onto the stage's own answer: the card's action (`data-stage-land`),
 * else the header's ⌨, else ✕, which every stage draws. Only from where a
 * press that opened the stage leaves it — the body, or the board going inert
 * under the stage. Focus already in the stage, or that the reader has taken
 * anywhere else, stays where it is, and the request is done either way.
 *
 * `held`: the request still holds keys for the pane (use-stage.ts
 * holdsTypeAhead), so the reader may be mid-sentence, and the control the
 * sentence now lands on catches it (StageBody's catchKeys) — briefly when
 * nothing was typed yet. Uncaught, its Space or Enter pressed the card's
 * action — Reopen here, or Try again again — and an n took the next ask and
 * typed the rest into another session.
 */
export function landFocus(root: HTMLElement | null, held: HeldKeys | null = null): boolean {
  if (!root) return false;
  const active = document.activeElement;
  const typing = held === "typed";
  // WORKSPACE: a press on a session's row in the list opened the pane, as a
  // press on a card does on the Board; the row is where the press left the
  // focus, not somewhere the reader has since taken it.
  const fromRow = root.dataset?.fill !== undefined && !!active?.closest?.(".session-list");
  // WORKSPACE, the pane just emptied by its ✕: the header's button is still
  // under the focus, and the empty pane's action is where the keys belong.
  const action = root.dataset?.fill !== undefined && root.dataset?.empty !== undefined
    ? root.querySelector<HTMLElement>("[data-stage-land]") : null;
  if (action && active && active !== action && root.contains(active) && (active as HTMLElement).closest?.("[data-stage-close]")) {
    if (held) catchKeys(action, { typing });
    else action.focus();
    return true;
  }
  if (active && active !== document.body && !fromRow && (root.contains(active) || !active.closest?.(".react-flow"))) {
    if (held && root.contains(active) && (active as HTMLElement).tagName === "BUTTON") catchKeys(active as HTMLElement, { typing });
    return true;
  }
  // The header's ⌨ is the one pressed button there is, but for Workspace's Zoom,
  // which reports its state the same way and is not where the keys go.
  const keys = root.querySelector<HTMLElement>(".ts-head button[aria-pressed]");
  const target = root.querySelector<HTMLElement>("[data-stage-land]")
    ?? (keys && keys.dataset?.zoom === undefined ? keys : null)
    ?? root.querySelector<HTMLElement>(".ts-head button[data-stage-close]");
  if (!target) return false;
  if (held) catchKeys(target, { typing });
  else target.focus();
  return true;
}

/** The empty pane's "Open <name>": opens exactly the session the card names
 *  (the oldest waiting), with the keys in its pane as N gives them. */
export function openWaiting(waiting: WaitingCard | null | undefined, open: ((sessionId: string) => void) | undefined): (() => void) | undefined {
  if (!waiting || !open) return undefined;
  return () => open(waiting.id);
}

/** A session from the board, as the stage draws it. */
export interface StageSessionInfo {
  ref: SessionRef;
  name: string;
  hue: number;
  model?: string | null;
  /** The reasoning effort the session runs at, as its card shows it. */
  effort?: string | null;
  /** The face's sentence — stageStatusFrom(board facts, now). */
  status: StageStatus;
  /** How full the session's context window is, the Inspector's two numbers
   *  (contextFill), for the header's chip. */
  contextUse?: { used: number; window: number } | null;
  /** The last line the board knew, shown while the pane attaches. */
  ghostLine?: string | null;
  /** Where the session runs, for the card shown when it cannot be attached. */
  context?: StageContext | null;
  /** "14m ago", for the end bar of a session that ended. */
  endedAgo?: string | null;
  /** This deck launched it from the Command Panel (panel-launch.ts). */
  launched?: boolean;
  /** How many prompts the board has for it: Chat reads its conversation again when this changes. */
  promptCount?: number;
}

/** What the stage is asked to show. */
export type StageShow =
  | { kind: "empty" }
  | { kind: "session"; session: StageSessionInfo; launch?: string }
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
  /** What was typed for a request before the pane could take it, handed over
   *  once and ended by any answer to that request (use-stage.ts). */
  takeTypeAhead?(request: number | string | null | undefined): string;
  /** Whether keys for this request are still held, and any typed yet
   *  (use-stage.ts). */
  holdsTypeAhead?(request: number | string | null | undefined): HeldKeys | null;
  /** Asks for the keys as a card click does: Try again, Check again and
   *  Attach again ask for the session's pane, so the keys go into it once it
   *  is back. A card that answers instead puts them on its own action. */
  onWantKeys?(): void;
  onNextAsk?(): void;
  /** WORKSPACE, the empty pane's "Open <name>": that session, named. Not the
   *  next ask: "Next ask" goes to the arrival the bar names first, which may
   *  be another session than the one this button says. */
  onOpenWaiting?(sessionId: string): void;
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
  /** The keys bar's height as drawn, in whole pixels rounded up, once and on
   *  every change: the geometry fits the rows above it (stage-geometry.ts). */
  onBarH?(height: number): void;
  /** The pane header's height as drawn, said the same way: V4's header is
   *  `--pane-head-h` (36 at Compact, 44 above), and the rows are fitted below it. */
  onHeadH?(height: number): void;
  onLaunched?(launched: LaunchedSession): void;
  /** Start the launch on the stage again, in the same folder with the same
   *  options: its agent exited before the board had its session (endView). */
  onLaunchAgain?(): void;
  /** A sentence for the deck's live region, once per change. */
  onAnnounce?(sentence: string): void;
  /** The deck runs on Windows: sessions live in the session host, not in a
   *  tmux, and older session hosts are worth a line in the keys bar. */
  windows?: boolean;
  /** WORKSPACE, the empty pane when someone waits: the oldest waiting session,
   *  named in the pane with a button to open it. Null, or left out, is the
   *  "nothing is waiting" card. Read only where the geometry fills the cell. */
  waiting?: WaitingCard | null;
  /** The suite's seam into the session. The integrator passes nothing. */
  sessionDeps?: Partial<SessionDeps>;
  /** The suite's seam into the older hosts' routes. */
  hostsApi?: HostsApi;
}

/** The subject the session hook is handed for what the stage shows. */
export function subjectOf(show: StageShow): StageSubject {
  switch (show.kind) {
    case "empty": return { kind: "empty" };
    case "session": return { kind: "session", ref: show.session.ref, ...(show.launch ? { launch: show.launch } : {}) };
    case "launch": return { kind: "launch", agent: show.agent, cwd: show.cwd, key: show.key, ...(show.options ? { options: show.options } : {}) };
  }
}

/** The stage's name for itself: the session's, or the empty stage's title. */
export function stageName(show: StageShow, workspace = false): string {
  return show.kind === "session" ? show.session.name : show.kind === "launch" ? show.name : tNow(workspace ? EMPTY_PANE_NAME_MSG : "board.stage.noSessionOpen");
}

/** The catalog key of the Workspace pane's title when it shows nothing (Figma, "Empty pane"). */
export const EMPTY_PANE_NAME_MSG = "board.stage.emptyPane";

/**
 * The keys bar's sentence and action for a pane that takes no more keys, or
 * null for one that does.
 *
 * A launch that ends while it is still a launch never became a board
 * session: Codex exiting after it updated itself ("Please restart Codex"), a
 * Claude told no at its folder's trust question. There is no conversation to
 * reopen, and for a Codex no id to reopen it by, so Reopen here did nothing.
 * What the reader wants then is the agent again, in the same folder.
 */
export function endView(
  phase: StagePhase,
  show: StageShow,
  act: { reopen(): void; launchAgain?: () => void; attachAgain(): void },
): EndView | null {
  if (phase.kind === "ended") {
    if (show.kind === "launch" && act.launchAgain) {
      const name = agentName(show.agent);
      return { sentence: tNow("board.stage.launchExited", { name }), action: tNow("board.stage.launchAgain", { name }), onAction: act.launchAgain };
    }
    const ago = show.kind === "session" ? show.session.endedAgo : null;
    return { sentence: ago ? tNow("board.stage.sessionEndedAgo", { ago }) : tNow("board.stage.sessionEnded"), action: tNow("board.stage.reopenHere"), onAction: act.reopen };
  }
  if (phase.kind === "detached") {
    return { sentence: tNow("board.stage.tookOver"), action: tNow("board.stage.attachAgain"), onAction: act.attachAgain };
  }
  return null;
}

/**
 * Says how tall the stage drew one of its parts, once it is drawn and again
 * whenever its size changes. Rounded up, so no fraction of a row stays
 * covered; to the hundredth first, so layout's own noise on an exact height
 * is not a pixel more. A part not laid out (0px) says nothing: the rows keep
 * the last height that was drawn rather than run under the part.
 */
function useDrawnHeight(rootRef: RefObject<HTMLElement>, selector: string, onHeight: ((height: number) => void) | undefined, also?: string): void {
  const say = useRef(onHeight);
  say.current = onHeight;
  useEffect(() => {
    // `also` is the same part in a second piece (the note and the phone's key
    // row under it): its height is added, and it says nothing where it is not drawn.
    const parts = [selector, also]
      .map(s => (s ? rootRef.current?.querySelector<HTMLElement>(s) ?? null : null))
      .filter((part): part is HTMLElement => part !== null);
    if (parts.length === 0 || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const total = parts.reduce((sum, part) => sum + part.getBoundingClientRect().height, 0);
      const h = Math.ceil(Math.round(total * 100) / 100);
      if (h > 0) say.current?.(h);
    };
    measure();
    const watch = new ResizeObserver(measure);
    for (const part of parts) watch.observe(part);
    return () => watch.disconnect();
  }, [rootRef, selector, also]);
}

export default function TerminalStage(p: TerminalStageProps) {
  const t = useT();
  const [held, setHeld] = useState(false);
  /** What the pane refused, said in the keys bar for a few seconds. */
  const [notice, setNotice] = useState<string | null>(null);
  const subject = subjectOf(p.show);
  const key = subjectKey(subject);
  const workspace = p.geometry.fill === true;
  const name = stageName(p.show, workspace);

  // CHAT. Offered only with its flag effective here and for a Claude session
  // whose id the deck knows: the conversation is read from that session's own
  // transcript, which a Codex session does not have in the deck. "Term" is
  // where every pane starts, and where one goes back to when Chat is not on offer.
  const screenFlags = useScreenFlags(workspace);
  const chatSession = chatSessionFor(screenFlags.chat, p.show.kind === "session" ? p.show.session.ref : null);
  const [view, setView] = useState<"chat" | "term">("term");
  const chatOn = chatSession !== null && view === "chat";
  const chatSource = useSessionTranscript({
    session: chatSession,
    shown: chatOn,
    working: p.show.kind === "session" && p.show.session.status.state === "working",
    ended: p.show.kind === "session" && p.show.session.status.state === "ended",
    change: p.show.kind === "session" ? `${p.show.session.promptCount ?? 0}:${p.show.session.status.state}` : "",
  });
  useEffect(() => { if (chatSession === null) setView("term"); }, [chatSession]);
  // Workspace's pane is sunken (V4), the terminal with it; beside the board it
  // stays on the panel.
  const theme = useMemo(() => terminalTheme(p.readToken, workspace ? "--sunken" : "--panel"), [p.readToken, workspace]);
  const fontFamily = useMemo(() => p.readToken(TERMINAL_FONT_TOKEN).trim() || "monospace", [p.readToken]);
  const chordLabel = useMemo(() => releaseChordLabel(platformName()), []);
  // The pane's own zoom (terminal-text-size.ts): the header's −/+ and the
  // keys while typing set it, every pane and tab of this browser follow it.
  const textStep = useTerminalTextStep();

  const session = useTerminalSession({
    subject,
    cols: p.geometry.cols,
    rows: p.geometry.rows,
    holdResize: held,
    theme,
    fontFamily,
    fontSize: fontSizeFor(textStep),
    onCell: p.onCell,
    onLaunched: p.onLaunched,
    onNotice: setNotice,
    deps: p.sessionDeps,
    windows: p.windows,
  });
  const { phase } = session;
  // The host's frame from one render to the next, followed as StageBody
  // follows it: the keys bar is not drawn while the pane is only on its way.
  const frameRef = useRef<FrameState>("hidden");
  const frame = frameState(frameRef.current, phase);
  useEffect(() => { frameRef.current = frame; });

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

  // Room for a pane that keeps the size of the user's own terminal (case B).
  usePaneRoom(key, phase.kind === "live" && phase.sizeOwner === "pane" ? session.paneSize?.cols ?? 0 : 0, p.geometry, p.expanded, p.onCols);

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
  // ⤢ pressed while the bar still says the browser keeps Ctrl+W: in full
  // screen it does not, so the sentence goes rather than lingering untrue.
  useEffect(() => {
    if (fullStage.full) setNotice(n => (isKeptKeysNotice(n) ? null : n));
  }, [fullStage.full]);

  const rootRef = useRef<HTMLElement>(null);
  // The keys bar's height goes up as it is drawn: the first-run line wraps to
  // a third line on the narrowest screens and grows the bar, and rows fitted
  // to its nominal height left the last one under it. The header's goes up
  // the same way: V4's header is one row at `--pane-head-h`, which the density
  // changes, so the rows are fitted to the height it was drawn at.
  useDrawnHeight(rootRef, ".ts-bar", p.onBarH, ".ts-keyrow");
  useDrawnHeight(rootRef, ".ts-head", p.onHeadH);
  // The session hook's snapshot is the shown subject's only once it has said
  // so: in the render that moves the stage, it is still the last one's, and
  // a request met on that pane, or answered by its card, would be spent on a
  // session the stage has left.
  const current = session.subject === key;
  useFocusRequest({
    key, request: p.focusRequest, launch: subject.kind === "launch", typing: current && typing,
    from: subject.kind === "session" && subject.launch ? `launch:${subject.launch}` : null,
    focus: request => {
      session.focus();
      const ahead = p.takeTypeAhead?.(request);
      if (ahead) session.type(ahead);
    },
    settled: current && settlesFocus(phase), land: request => landFocus(rootRef.current, p.holdsTypeAhead?.(request) ?? null),
    unmet: request => { p.takeTypeAhead?.(request); },
  });

  // Not while a check is running: the session refuses that press, and a
  // request made for it would have let go of what the first one held.
  const retry = () => {
    if (phase.kind === "tmux-missing" && phase.busy) return;
    session.retry();
    p.onWantKeys?.();
  };

  // Reopen here asks for the keys too, as a launch or an open does: the end
  // bar's button goes as the pane comes back, and with it the focus, so the
  // reopened pane was live with the keys on the board and the next letters
  // ran the deck's shortcuts. A second press while it works asks for nothing.
  const reopen = () => {
    if (phase.kind === "not-attachable" && phase.busy) return;
    session.adopt();
    p.onWantKeys?.();
  };

  const end = endView(phase, p.show, { reopen, launchAgain: p.onLaunchAgain, attachAgain: retry });
  const hosts = useOlderHosts(p.windows === true, key, s => onAnnounce.current?.(s), p.hostsApi);

  const style = {
    "--session-hue": p.show.kind === "session" ? p.show.session.hue : p.show.kind === "launch" ? p.show.hue : 200,
    "--ts-term-top": `${p.geometry.termTop}px`,
  } as CSSProperties;

  return (
    <section
      ref={rootRef}
      className="ts-stage"
      role="region"
      aria-label={t("board.stage.region", { name })}
      data-kind={phase.kind}
      data-empty={p.show.kind === "empty" || undefined}
      data-live={live || undefined}
      data-takeover={p.geometry.takeover || undefined}
      id={workspace ? WORKSPACE_PANE_ID : undefined}
      tabIndex={workspace ? -1 : undefined}
      data-fill={workspace || undefined}
      data-held={held || undefined}
      data-pane-size={(phase.kind === "live" && phase.sizeOwner === "pane") || undefined}
      style={style}
    >
      {/* Expanded, the stage is as wide as it goes and the divider would
          move nothing: ⤢ is the way back. */}
      {!p.geometry.takeover && !p.expanded && !workspace && (
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
        status={status}
        keysOwner={session.keysOwner}
        chordLabel={chordLabel}
        canType={typing}
        expanded={p.expanded}
        canFull={fullStage.can}
        full={fullStage.full}
        takeover={p.geometry.takeover}
        workspace={workspace ? (p.show.kind === "empty" ? "empty" : "pane") : undefined}
        context={p.show.kind === "session" ? p.show.session.contextUse : null}
        view={chatSession !== null ? { current: view, onChange: setView } : undefined}
        // Only while a terminal is on the stage to size: not on the empty
        // pane, a card that has none, or Chat.
        textSize={p.show.kind === "empty" || PANELESS.has(phase.kind) || chatOn ? undefined : { step: textStep, onStep: stepTerminalText }}
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
        paneName={name}
        phase={phase}
        context={p.show.kind === "session" ? p.show.session.context : null}
        windows={p.windows}
        launched={p.show.kind === "session" && (p.show.session.launched === true || !!p.show.launch)}
        onAdopt={reopen}
        onNotNow={p.onClose}
        onRetry={retry}
        onNewSession={p.onNewSession}
        workspace={workspace && p.show.kind === "empty"}
        waiting={workspace ? p.waiting ?? null : null}
        onOpenWaiting={openWaiting(p.waiting, p.onOpenWaiting)}
        screens={chatSession !== null ? { view, source: chatSource } : undefined}
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
        workspace={workspace}
        paneless={p.show.kind === "empty" || PANELESS.has(phase.kind) || onItsWay(phase, frame)}
        onFirstRunDone={p.onFirstRunDone}
        onTypeHere={session.focus}
        end={end}
        asks={p.asks}
        arrival={p.arrival}
        onNextAsk={p.onNextAsk}
        onAnswerArrival={p.onAnswerArrival}
        hosts={hosts.line ? { said: hosts.line, onReview: hosts.canReview ? hosts.review : null } : null}
      />
      {/* The phone's key row (640 and under; hidden by the sheet elsewhere):
          the pane's own input, six keys a screen keyboard lacks. */}
      <PhoneKeys canType={typing} paneless={p.show.kind === "empty" || PANELESS.has(phase.kind)} onKey={session.press} holdsFocus={session.holdsFocus} />
      <DialogPresence when={hosts.open && hosts.view}>{view => (
        <HostsDialog
          view={view}
          now={Date.now()}
          busy={hosts.busy}
          said={hosts.said}
          onEndAll={hosts.endAll}
          onKeep={hosts.keep}
          onCancel={hosts.cancel}
        />
      )}</DialogPresence>
    </section>
  );
}
