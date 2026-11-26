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
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type RefObject } from "react";
import { saveChatImage, terminalTarget, type LaunchOptions, type SessionRef, type TerminalProvider } from "../../terminal-api";
import { takesImages, type ChatImage } from "../../chat-images";
import { terminalTheme } from "../../terminal-palette";
import { releaseChordLabel } from "../../terminal-keys";
import { platformName } from "../../platform";
import { ASSUMED_CELL, type Cell, type StageGeometry } from "../../stage-geometry";
import {
  TERMINAL_FONT_TOKEN,
  subjectKey,
  useTerminalSession,
  type AskSendResult,
  type LaunchedSession,
  type PromptSendResult,
  type SessionDeps,
  type StageSubject,
} from "../../use-terminal-session";
import {
  agentName,
  canType as phaseTakesKeys,
  CHOOSE_FOLDER_MSG,
  folderGoneBody,
  folderGoneLine,
  frameState,
  headerStatus,
  NOT_RESUMED_MSG,
  onItsWay,
  paneless,
  REOPENING_MSG,
  START_NEW_MSG,
  START_NEW_TIP_MSG,
  resumeCommand,
  spineLive,
  stageAnnouncement,
  type FrameState,
  type KeysOwner,
  type StagePhase,
  type StageStatus,
} from "./stage-model";
import { canChooseFolder, chooseFolder } from "../../desktop-folder";
import StageHeader, { metaRest } from "./StageHeader";
import StageBody, { catchKeys, handoffReason, type HandoffReason, type StageContext } from "./StageBody";
import type { HeldKeys } from "../../type-ahead";
import { useFocusRequest, type FocusRequest } from "./use-focus-request";
import { paneHoldsKeys } from "../../pane-keys";
import { guardLeaving } from "../../leave-guard";
import { isKeptKeysNotice, keptKeysNotice } from "../../tab-keys";
import { useFullStage } from "./use-full-stage";
import { WORKSPACE_PANE_ID } from "../../workspace-pane";
import { usePaneRoom } from "./use-pane-room";
import KeysBar, { useStageStatusSlot, type ArrivalView, type AsksView, type EndView } from "./KeysBar";
import PhoneKeys from "./PhoneKeys";
import Divider from "./Divider";
import HostsDialog from "./HostsDialog";
import { t as tNow, useT } from "../../i18n";
import { ChatComposerSlot, useScreenFlags } from "../../use-screens";
import { useChatReturned } from "../../use-chat-returned";
import { draftFor, keepDraft } from "../../chat-drafts";
import { fontSizeFor, stepTerminalText, useTerminalTextStep } from "../../terminal-text-size";
import { chatSessionFor, useSessionTranscript } from "../../use-session-transcript";
import { isEventOnly } from "../../../server/provider-ids.mjs";
import { askSteps, chatSteps, type AskStep } from "../../ask-keys";
import { stopSteps } from "../../chat-stop";
import { pendingFor, useChatProgress, waitsInChat, type ChatFacts, type ChatPending } from "../../chat-progress";
import { useScreenStatus } from "../../use-screen-status";
import { useLiveScreen } from "../../use-live-compaction";
import { saysCompacting } from "../../screen-status";
import { COMPACT_COMMAND, COMPACT_SAID, compactBlocked, compactedSince, compactOffered, isCompactCommand, lastReply, sessionDetails } from "../../chat-actions";
import { useCompactRun } from "../../use-chat-compact";
import { copyText } from "../../copy-text";
import type { ChatMenuView } from "./ChatMenu";
import { chatLive } from "../../live-activity";
import { noteFeature, useFeatureUse } from "../../feature-use";
import type { ChatAsk, ChatLiveAgent, ChatTurn } from "../chat/chat-model";
import { usePromptDecision } from "../../use-prompt-decision";
import { rememberedView, rememberView } from "../../chat-view-memory";
import { useChatPaneLinks } from "../../use-chat-pane-links";
import NotifyOffer from "../alerts/NotifyOffer";
import { intentTarget, useIntentPress } from "../../use-intent-press";
import { answerIntents, type IntentOutcome } from "../../answer-intent";
import { DialogPresence } from "../Dialog";
import type { HostsApi } from "./older-hosts";
import { useOlderHosts } from "./use-older-hosts";
import type { WaitingCard } from "./stage-board";
import type { RenameFacts } from "../../session-rename";
import { useRenaming } from "../SessionNameField";
import type { PaneTabsView, TabsMenuOpen } from "./PaneTabs";

/** One empty transcript for every render, so the card's words are not rebuilt for nothing. */
const NO_TURNS: readonly ChatTurn[] = [];
const NO_IMAGES: readonly ChatImage[] = [];

/** What the pane says when an answer chosen on an alert was not sent. */
const INTENT_NOTICE: Partial<Record<IntentOutcome["kind"], string>> = {
  changed: "board.chat.alert.notice.changed",
  locked: "board.chat.alert.notice.locked",
  timeout: "board.chat.alert.notice.timeout",
  expired: "board.chat.alert.notice.timeout",
};

/** How long the keys bar holds a refusal before its hints come back. */
const NOTICE_MS = 6000;

/** The phases whose card is the stage's answer, which a request for the keys
 *  lands on: not the ones on their way to a pane. tmux missing while it
 *  checks again is on its way too: Check again asks for the keys, which its
 *  own card would otherwise answer at once, before the check had. So is a
 *  card's Reopen here while it works, and an ended pane's. */
export function settlesFocus(phase: StagePhase): boolean {
  return phase.kind !== "attaching" && phase.kind !== "starting" && phase.kind !== "tmux-installing"
    && !((phase.kind === "tmux-missing" || phase.kind === "error" || phase.kind === "not-attachable" || phase.kind === "ended" || phase.kind === "folder-gone") && phase.busy)
    && !(phase.kind === "live" && !phase.readOnly);
}

/** How long after Move session here or Resume here after exit is pressed a
 *  press on the Cancel that took that button's place still belongs to the
 *  first press: the second click of a double-click, a held Enter repeating. */
export const REPEAT_PRESS_MS = 600;

/** Whether a press on a Cancel that has just replaced the button pressed
 *  before it is that first press again (REPEAT_PRESS_MS, or a click counted
 *  as the second of a double-click), and so cancels nothing: pressing the
 *  button twice starts it once. */
export function repeatedPress(e: { detail?: number } | undefined, sincePressMs: number): boolean {
  return (e?.detail ?? 0) > 1 || sincePressMs < REPEAT_PRESS_MS;
}

/**
 * Focus onto the stage's own answer: the card's action or an ended session's
 * Reopen here (`data-stage-land`), else the header's ⌨, else ✕, which every
 * stage draws. Only from where a
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
  // An ended session's Reopen here (or Attach again) is the pane's own: in its
  // header where the keys bar is out in the window's status bar, in the keys
  // bar inside the pane on a phone (endPlacement). Either way it is under the
  // root, so the shared status bar never holds an action to land on, and a
  // split's other pane, which draws no keys bar, finds its own in its header.
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
  /** The session's spend, as its row in the Sessions list says it, for Chat's
   *  Session details; none where it is not known or nothing was spent. */
  spend?: number;
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
  /** When the board last heard from it (its `lastEventAt`): Chat asks soon after this moves. */
  heardAt?: number;
  /** When its last turn began (its last prompt): Chat's working row counts from it. */
  turnStartedAt?: number;
  /** Its background agents still running once its turn is over (live-activity.ts):
   *  Chat's live row says them. */
  background?: readonly ChatLiveAgent[];
  /** What the header's Rename needs (session-rename.ts renameFacts), for a
   *  session the board has; left out, the name is only drawn. */
  rename?: RenameFacts | null;
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
  /** WORKSPACE, Chat's Show on Board: the Board, with this session's card
   *  brought into view as a jump to it brings it. */
  onShowOnBoard?(sessionId: string): void;
  onAnswerArrival?(): void;
  onClose(): void;
  onToggleExpand(): void;
  onFirstRunDone(): void;
  /** Open the New session popover, hung off the control with this id.
   *  `elsewhere`: the folder-gone card's Choose folder… where the desktop
   *  app's folder dialog is not there — its agent chosen, and the folder that
   *  is gone (`gone`) never offered nor chosen, so the reader picks one. */
  onNewSession(anchorId: string, elsewhere?: { agent: TerminalProvider; gone: string }): void;
  /** A NEW session of `agent` in `cwd`, in this pane: the folder-gone card's
   *  Choose folder…, once the desktop app's dialog chose one. Never a
   *  conversation resumed in another folder. Left out, Choose folder… opens
   *  New session instead. */
  onStartIn?(agent: TerminalProvider, cwd: string): void;
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
  onContinuation?(sessionId: string, cwd: string): boolean;
  /** Start the launch on the stage again, in the same folder with the same
   *  options: its agent exited before the board had its session (endView). */
  onLaunchAgain?(): void;
  /** A new session of the session's agent in its folder, in this pane: the
   *  explicit way on when Reopen here could not bring the session back
   *  (endView's `unresumed`, StageBody's refused reopen). Left out where
   *  there is no agent the deck can start. */
  onStartNew?(): void;
  /** A sentence for the deck's live region, once per change. */
  onAnnounce?(sentence: string): void;
  /** The deck runs on Windows: sessions live in the session host, not in a
   *  tmux, and older session hosts are worth a line in the keys bar. */
  windows?: boolean;
  /** WORKSPACE, the empty pane when someone waits: the oldest waiting session,
   *  named in the pane with a button to open it. Null, or left out, is the
   *  "nothing is waiting" card. Read only where the geometry fills the cell. */
  waiting?: WaitingCard | null;
  /** WORKSPACE with panes side by side (internal #102): this pane's place in
   *  the split. Only the `primary` pane, the one with the keys, wears the
   *  Workspace pane's id. ⤢ fills the Workspace with this pane (`max`) rather
   *  than the screen, and the header drags the pane to another place. Left
   *  out: the one stage, as before. */
  split?: StageSplit | null;
  /** WORKSPACE, a pane holding two tabs or more: the element's id where it
   *  is not the Workspace pane's own, for the strip's tabs to point at. */
  panelId?: string;
  /** WORKSPACE, a pane holding two tabs or more: its strip, drawn in this
   *  stage's header in place of the one name (PaneTabs.tsx). */
  tabs?: PaneTabsView | null;
  /** WORKSPACE, a pane holding two tabs or more: the id of the tab on show,
   *  which names this stage as the panel it shows. */
  tabbedBy?: string;
  /** The suite's seam into the session. The integrator passes nothing. */
  sessionDeps?: Partial<SessionDeps>;
  /** The suite's seam into the older hosts' routes. */
  hostsApi?: HostsApi;
}

/** A pane of a split Workspace (internal #102). */
export interface StageSplit {
  number?: number;
  primary: boolean;
  /** This pane fills the Workspace, the others named in the strip. */
  max: boolean;
  onMax(): void;
  /** A drag from the header: the pane goes where it is dropped. */
  onDragHead?(e: DragEvent<HTMLElement>): void;
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
 *
 * A session's Reopen here says Reopening… while it works (`busy`), and a
 * second press does nothing. One whose agent ended as soon as it was
 * reopened could not resume the conversation (`unresumed`): the bar says so,
 * offers Try again, and beside it a new session in the same folder
 * (`startNew`) — never started without that press.
 *
 * An ended pane whose folder is gone (folder-gone with its frame) offers
 * neither: the bar names the folder, Choose folder… starts a new session
 * elsewhere (`chooseFolder`, its tooltip saying what becomes of the
 * conversation), Check again (`checkAgain`) runs the press again only once
 * the folder is back, and Cancel (`cancel`) puts the ended pane back as it
 * was. Without its frame, the card says all that instead.
 */
export function endView(
  phase: StagePhase,
  show: StageShow,
  act: {
    reopen(): void; launchAgain?: () => void; attachAgain(): void; startNew?: () => void;
    chooseFolder?: () => void; chooseId?: string; checkAgain?: () => void; cancel?: () => void;
  },
): EndView | null {
  if (phase.kind === "folder-gone") {
    if (!phase.frame) return null;
    // One line, said where it is drawn (folderGoneLine): what is gone, then
    // what Choose folder… does; a Check again that found it still gone
    // changes its first half. The full path is its tooltip.
    const line = folderGoneLine(phase);
    const said = { sentence: `${line.lead} ${line.next}`, where: phase.cwd, live: true };
    const check = tNow(phase.busy ? "board.stage.checking" : "board.stage.checkAgain");
    const checkAgain = act.checkAgain ?? act.attachAgain;
    const back = act.cancel ? { back: { action: tNow("common.cancel"), onAction: act.cancel } } : {};
    if (!act.chooseFolder) return { ...said, action: check, busy: phase.busy, onAction: checkAgain, ...back };
    return {
      ...said, action: tNow(CHOOSE_FOLDER_MSG), title: folderGoneBody(phase), id: act.chooseId, onAction: act.chooseFolder,
      alt: { action: check, busy: phase.busy, onAction: checkAgain }, ...back,
    };
  }
  if (phase.kind === "ended") {
    if (show.kind === "launch" && act.launchAgain) {
      const name = agentName(show.agent);
      return { sentence: tNow("board.stage.launchExited", { name }), action: tNow("board.stage.launchAgain", { name }), onAction: act.launchAgain };
    }
    if (phase.unresumed && show.kind === "session") {
      const name = agentName(show.session.ref.provider);
      return {
        sentence: tNow(NOT_RESUMED_MSG, { name }), action: tNow("board.stage.tryAgain"), onAction: act.reopen,
        ...(act.startNew ? { alt: { action: tNow(START_NEW_MSG), title: tNow(START_NEW_TIP_MSG, { name }), onAction: act.startNew } } : {}),
      };
    }
    const ago = show.kind === "session" ? show.session.endedAgo : null;
    const sentence = ago ? tNow("board.stage.sessionEndedAgo", { ago }) : tNow("board.stage.sessionEnded");
    if (phase.busy) return { sentence, action: tNow(REOPENING_MSG), busy: true, onAction: act.reopen };
    return { sentence, action: tNow("board.stage.reopenHere"), onAction: act.reopen };
  }
  if (phase.kind === "detached") {
    return { sentence: tNow("board.stage.tookOver"), action: tNow("board.stage.attachAgain"), onAction: act.attachAgain };
  }
  return null;
}

/**
 * Where the end action is drawn. Beside a mouse the keys bar is out in the
 * window's status bar (KeysBar's placement, `slotPresent`), far from the pane
 * and not drawn at all for a split's other pane: the action goes to the pane's
 * own header, after its state word. On a phone (no status bar) the keys bar is
 * inside the pane and keeps it, as it always has. Never both.
 */
export function endPlacement(slotPresent: boolean, end: EndView | null): { header: EndView | null; bar: EndView | null } {
  return slotPresent ? { header: end, bar: null } : { header: null, bar: end };
}

/**
 * The rows a kept frame keeps under the folder-gone line: the stage's rows
 * less every row the line's height reaches into, so that the frame, moved
 * down by that height, ends no lower than it did and no row of it is cut.
 */
export function rowsUnderNote(rows: number, noteH: number, cellH: number): number {
  if (!(noteH > 0)) return rows;
  const h = cellH > 0 ? cellH : ASSUMED_CELL.h;
  return Math.max(1, rows - Math.ceil(noteH / h));
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
  // The pane's tab menu, held here above the header: the close of the tab on
  // show from it gives the header the identity of the tab that comes on, which
  // draws the strip afresh, and the menu stays open through that (PaneTabs.tsx).
  // A pane whose strip goes takes its menu with it.
  const [tabMenu, setTabMenu] = useState<TabsMenuOpen | null>(null);
  const tabbed = p.tabs != null;
  useEffect(() => { if (!tabbed) setTabMenu(null); }, [tabbed]);
  /** What the pane refused, said in the keys bar for a few seconds. */
  const [notice, setNotice] = useState<string | null>(null);
  const subject = subjectOf(p.show);
  const key = subjectKey(subject);
  const workspace = p.geometry.fill === true;
  const name = stageName(p.show, workspace);

  // Term is the starting view for both providers.
  const screenFlags = useScreenFlags(workspace);
  const chatRef = p.show.kind === "session" ? p.show.session.ref : null;
  const chatSession = chatSessionFor(screenFlags.chat, chatRef);
  const chatProvider = chatRef?.provider ?? "claude";
  // opencode and Copilot: Chat says the deck reads no conversation of theirs,
  // and there is no terminal behind it to write to, so it has no composer.
  const chatReadOnly = isEventOnly(chatProvider);
  const chatDraftKey = `${chatProvider}:${chatSession}`;
  const [view, setView] = useState<"chat" | "term">("term");
  // Each session opens in the view it was left in (chat-view-memory.ts), taken
  // up in the render that brings it, so Term never flashes before Chat; one
  // not remembered keeps the view the pane has.
  const [viewFor, setViewFor] = useState<string | null>(null);
  if (viewFor !== chatSession) { setViewFor(chatSession); const kept = rememberedView(chatSession); if (kept) setView(kept); }
  useEffect(() => { rememberView(chatSession, view); }, [chatSession, view]);
  const chatOn = chatSession !== null && view === "chat";
  // A session's terminal pane shown, and its Chat view: features the usage
  // reports name (feature-use.ts). An empty Workspace pane is neither.
  useFeatureUse("terminal-pane", p.show.kind !== "empty");
  useFeatureUse("chat", chatOn);
  // Drafts belong to session IDs, so switching panes or Chat/Term cannot
  // send one session's draft to another. They outlive the stage
  // (chat-drafts.ts): the Board and back find them where they were.
  const [, setDraftMoved] = useState(0);
  const chatDraft = draftFor(chatDraftKey);
  const putDraft = (at: string, text: string) => { keepDraft(at, text); setDraftMoved(n => n + 1); };
  // And the pictures pasted beside a draft (chat-images.ts): in this page's
  // memory only, until Send hands them to the deck.
  const [chatImages, setChatImages] = useState<Record<string, ChatImage[]>>({});
  // A message sent from Chat until the session says it took it and its turn
  // is over (chat-progress.ts), held per session as the drafts are, so one
  // session's never shows on another.
  const [chatPending, setChatPending] = useState<Record<string, ChatPending>>({});
  const [chatSent, setChatSent] = useState(0);
  // A compaction on screen, or one Chat follows to its end (below): the
  // conversation is read as often as while a turn works, so its end is seen.
  const [compactBrisk, setCompactBrisk] = useState(false);
  const chatSource = useSessionTranscript({
    session: chatSession,
    provider: chatProvider,
    shown: chatOn,
    working: p.show.kind === "session" && p.show.session.status.state === "working",
    brisk: compactBrisk,
    ended: p.show.kind === "session" && p.show.session.status.state === "ended",
    change: p.show.kind === "session" ? `${p.show.session.promptCount ?? 0}:${p.show.session.status.state}:${chatSent}` : "",
    heard: p.show.kind === "session" ? p.show.session.heardAt : undefined,
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
  // The folder-gone line's height as drawn over a kept frame, 0 without one:
  // the frame starts under it, with the rows it reaches into taken away.
  const [noteH, setNoteH] = useState(0);

  const session = useTerminalSession({
    subject,
    cols: p.geometry.cols,
    rows: rowsUnderNote(p.geometry.rows, noteH, p.cell.h),
    holdResize: held,
    theme,
    fontFamily,
    fontSize: fontSizeFor(textStep),
    onCell: p.onCell,
    onLaunched: p.onLaunched,
    onNotice: setNotice,
    // Check again on a launch whose agent ended at once for want of its
    // folder: the launch again, once the folder is back.
    onLaunchAgain: p.onLaunchAgain,
    deps: p.sessionDeps,
    windows: p.windows,
  });
  const { phase } = session;
  const [handoffFrom, setHandoffFrom] = useState<string | null>(null);
  // Why the last move of this source did not happen, or why it still waits.
  const [handoffIssue, setHandoffIssue] = useState<{ source: string; reason: HandoffReason } | null>(null);
  const handoffRequest = useRef<AbortController | null>(null);
  // The source whose move Ghostty took: its wait running out is a slow
  // arrival, not a failure, and Look again asks nothing of Ghostty.
  const handoffSent = useRef<string | null>(null);
  const continuationRef = useRef(p.onContinuation);
  continuationRef.current = p.onContinuation;
  const claudeSource = chatRef?.provider === "claude" && !p.windows ? chatRef.sessionId : null;
  const handoffCwd = chatRef?.cwd ?? "";
  const couldMove = !!p.onContinuation && !!claudeSource && !!handoffCwd && phase.kind === "not-attachable";
  // The move works only for Claude in a Ghostty window on a Mac, with a
  // Ghostty whose scripting can find Claude's surface. The server makes every
  // lookup of the real move without sending anything, and the button shows
  // only when it says yes, so nobody gets a button that fails. A later no
  // takes back an earlier yes.
  const [movableFor, setMovableFor] = useState<string | null>(null);
  // The source the check has answered for, either way. Until then neither
  // Move session here nor Resume here after exit is offered, so one never
  // stands in for the other for a moment.
  const [checkedFor, setCheckedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!couldMove || !claudeSource) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/terminal/background", {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: claudeSource, provider: "claude", cwd: handoffCwd, check: true }),
        });
        if (!response.ok) return;
        const { movable, reason } = await response.json() as { movable?: unknown; reason?: unknown };
        if (controller.signal.aborted) return;
        if (movable === true) setMovableFor(claudeSource);
        else setMovableFor(was => was === claudeSource ? null : was);
        // A Ghostty too old to find Claude's surface: say so before anyone
        // looks for a Move button, with the way by hand, and offer no move.
        if (movable !== true && reason === "ghostty-unsupported") {
          setHandoffIssue(was => was?.source === claudeSource ? was : { source: claudeSource, reason: "ghostty-unsupported" });
        }
      } catch { /* No answer: the button stays as it was. */ }
      finally { if (!controller.signal.aborted) setCheckedFor(claudeSource); }
    })();
    return () => controller.abort();
  }, [couldMove, claudeSource, handoffCwd]);
  // A move under way, or one that stopped, keeps its card after a later check
  // says no: Claude leaving Ghostty is what a move that worked looks like.
  const moving = couldMove && handoffFrom === claudeSource;
  const handoffStopped = handoffIssue && handoffIssue.source === claudeSource ? handoffIssue.reason : undefined;
  const handoffShown = couldMove && (movableFor === claudeSource || moving || handoffStopped !== undefined);
  useEffect(() => {
    setHandoffFrom(null);
    setHandoffIssue(null);
    handoffSent.current = null;
    return () => handoffRequest.current?.abort();
  }, [claudeSource]);
  // When Move session here was pressed: the Cancel that takes its place does
  // not answer the rest of that press (repeatedPress).
  const movedAt = useRef(0);
  const toggleHandoff = async (e?: { detail?: number }) => {
    if (moving) {
      if (repeatedPress(e, Date.now() - movedAt.current)) return;
      handoffRequest.current?.abort();
      setHandoffFrom(null);
      setHandoffIssue(null);
      return;
    }
    if (!claudeSource || handoffRequest.current) return;
    const controller = new AbortController();
    handoffRequest.current = controller;
    setHandoffIssue(null);
    movedAt.current = Date.now();
    setHandoffFrom(claudeSource);
    let said: unknown;
    try {
      const response = await fetch("/api/terminal/background", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: claudeSource, provider: "claude", cwd: handoffCwd }),
      });
      if (response.ok) { handoffSent.current = claudeSource; return; }
      said = (await response.json().catch(() => null) as { reason?: unknown } | null)?.reason;
    } catch { /* The source remains where it was if the request failed. */ }
    finally { handoffRequest.current = null; }
    if (controller.signal.aborted) return;
    const reason = handoffReason(said);
    setHandoffIssue({ source: claudeSource, reason });
    // Sent before, from here or another tab: keep waiting for it, send nothing.
    if (reason === "already-sent") { handoffSent.current = claudeSource; return; }
    setHandoffFrom(null);
    if (reason === "ghostty-unsupported") setMovableFor(null);
  };
  // RESUME HERE AFTER EXIT. Where the move is not on offer — a Ghostty too
  // old to find Claude's window, another terminal, a machine that is not a
  // Mac — or a move did not happen, the card offers to wait for this exact
  // session to end where it runs and reopen it here then, by itself
  // (use-terminal-session's resumeAfterExit). Not while a move that went is
  // awaited: that one arrives as a background session of its own.
  const resumeSource = claudeSource && handoffCwd && phase.kind === "not-attachable" && phase.stillRunning && phase.target.adoptable === true
    ? claudeSource : null;
  const awaitingExit = phase.kind === "not-attachable" && phase.awaitingExit === true;
  const moveAwaited = handoffStopped === "already-sent" || handoffStopped === "continuation-timeout";
  const resumeShown = resumeSource !== null && !moving && (awaitingExit
    || (!moveAwaited && (checkedFor === resumeSource || !couldMove) && (movableFor !== resumeSource || handoffStopped !== undefined)));
  const armedAt = useRef(0);
  // STOP THERE AND RESUME HERE, beside it: the deck stops Claude where it
  // runs, then the same wait reopens the conversation here. A press asks the
  // deck which process holds it (`checking`), then the card asks the reader
  // to confirm (`confirming`); confirmed, the wait is armed and the stop
  // sent (use-terminal-session's checkStopElsewhere, confirmStopElsewhere).
  // Held for the source it was asked for, so another session's card never
  // shows this one's question.
  const [stopAsk, setStopAsk] = useState<{ source: string; checking: boolean } | null>(null);
  const stopAsked = stopAsk && stopAsk.source === resumeSource ? stopAsk : null;
  useEffect(() => { if (!resumeSource) setStopAsk(null); }, [resumeSource]);
  const stopAskedAt = useRef(0);
  const stopElsewhere = resumeSource ? {
    name,
    cwd: handoffCwd,
    checking: stopAsked?.checking === true,
    confirming: stopAsked?.checking === false,
    ask: () => {
      if (stopAsked) return;
      const source = resumeSource;
      stopAskedAt.current = Date.now();
      setStopAsk({ source, checking: true });
      void session.checkStopElsewhere().then(said => {
        setStopAsk(was => (was?.source !== source ? was : said.ok && !said.gone ? { source, checking: false } : null));
      });
    },
    // The second click of a double-click, or a held Enter, on the press
    // that asked lands here too, and confirms nothing (repeatedPress).
    confirm: (e?: { detail?: number }) => {
      if (repeatedPress(e, Date.now() - stopAskedAt.current)) return;
      armedAt.current = Date.now();
      setStopAsk(null);
      session.confirmStopElsewhere();
    },
    // Escape answers at once; a press, as the wait's Cancel does.
    cancel: (e?: { detail?: number }) => {
      if (e && repeatedPress(e, Date.now() - stopAskedAt.current)) return;
      setStopAsk(null);
      session.cancelStopElsewhere();
    },
  } : undefined;
  const afterExit = resumeShown ? {
    arm: () => { armedAt.current = Date.now(); session.resumeAfterExit(); },
    cancel: (e?: { detail?: number }) => { if (!repeatedPress(e, Date.now() - armedAt.current)) session.stopWaitingForExit(); },
    ...(stopElsewhere ? { stop: stopElsewhere } : {}),
  } : undefined;
  // After a move that was sent and has not arrived: wait for it again, and
  // never ask Ghostty a second time.
  const lookAgain = () => {
    if (!claudeSource || handoffSent.current !== claudeSource) return;
    setHandoffIssue(null);
    setHandoffFrom(claudeSource);
  };
  useEffect(() => {
    if (!moving || !claudeSource) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = setTimeout(() => {
      handoffRequest.current?.abort();
      controller.abort();
      setHandoffFrom(null);
      setHandoffIssue({ source: claudeSource, reason: handoffSent.current === claudeSource ? "continuation-timeout" : "failed" });
    }, 40_000);
    const findContinuation = async () => {
      try {
        const query = new URLSearchParams({ session: claudeSource, continuation: "1" });
        const response = await fetch(`/api/session/transcript?${query}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (response.ok) {
          const { sessionId } = await response.json() as { sessionId?: unknown };
          if (!controller.signal.aborted && typeof sessionId === "string") {
            const next = await terminalTarget({ sessionId, provider: "claude", cwd: handoffCwd }, { signal: controller.signal });
            if (!controller.signal.aborted && next.ok && next.target.kind === "D" &&
                continuationRef.current?.(sessionId, handoffCwd)) {
              setView("term");
              setHandoffFrom(null);
              setHandoffIssue(null);
              return;
            }
          }
        }
      } catch { /* A transcript may appear after Claude finishes backgrounding. */ }
      if (!controller.signal.aborted) timer = setTimeout(findContinuation, 2000);
    };
    void findContinuation();
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(deadline); };
  }, [moving, claudeSource, handoffCwd]);
  // The host's frame from one render to the next, followed as StageBody
  // follows it: the keys bar is not drawn while the pane is only on its way.
  const frameRef = useRef<FrameState>("hidden");
  const frame = frameState(frameRef.current, phase);
  useEffect(() => { frameRef.current = frame; });

  const board = p.show.kind === "session" ? p.show.session.status : null;
  const status = headerStatus(board, phase);
  const live = spineLive(status, phase, session.streaming);
  const typing = phaseTakesKeys(phase);

  // Terminal focus requests still show Term before giving xterm the keys.
  // The Chat composer writes through the connection without focusing xterm.
  // Every way into the terminal — the keys bar's
  // "type in Term", the header's keys button, Enter on the deck, the asks run,
  // a card's click — shows Term first and gives it the keys once it is drawn.
  // Under Chat the pane is hidden, and a hidden textarea takes no focus: ↵
  // did nothing there, while keys held for the pane still went to a session
  // nobody could see (internal #99). Keys typed ahead for a request stay held
  // until then and follow the focus, as on a pane already in view; a request
  // whose session the stage left before Term was drawn lets them go.
  const keysAfterTerm = useRef<{ key: string; request?: FocusRequest["request"] } | null>(null);
  const givePane = (request?: FocusRequest["request"]) => {
    session.focus();
    if (request === undefined) return;
    const ahead = p.takeTypeAhead?.(request);
    if (ahead) session.type(ahead);
  };
  const intoPane = (request?: FocusRequest["request"]) => {
    if (chatOn) { keysAfterTerm.current = { key, request }; setView("term"); return; }
    givePane(request);
  };
  useLayoutEffect(() => {
    const want = keysAfterTerm.current;
    if (chatOn || !want) return;
    keysAfterTerm.current = null;
    if (want.key === key) givePane(want.request);
    else if (want.request !== undefined) p.takeTypeAhead?.(want.request);
  });
  // And back to Chat with the keys in the pane: they leave it, so nothing typed
  // next goes to a pane that is no longer on screen (a browser that keeps the
  // focus on the textarea through a click on the switch, as Safari does).
  const showView = (next: "chat" | "term") => {
    if (next === "chat" && session.keysOwner === "pane") session.release();
    setView(next);
  };
  const chatCannotType = chatOn && !chatReadOnly && p.show.kind === "session" && paneless(phase);
  // Why nothing can be sent to the session from Chat: not yet or no longer
  // attached, or read only. A question it asked is answered all the same.
  const chatCannotSend = session.subject !== key ? t("board.chat.connecting") : phase.kind === "live"
    ? phase.readOnly ? t("board.chat.readOnly") : undefined
    : t(phase.kind === "attaching" || phase.kind === "starting" ? "board.chat.connecting" : "board.chat.offline");
  // What the session's own screen shows once its turn is over, on Chat's live
  // row (live-activity.ts): a compaction, and a choice the agent draws itself
  // that the transcript does not hold. Read only while the working row's read
  // (use-screen-status.ts, below) is off.
  const liveScreen = useLiveScreen({
    on: chatOn && status.state !== "working" && chatCannotSend === undefined && (chatProvider === "claude" || chatProvider === "codex"),
    subject: key,
    readScreen: session.readScreen,
  });
  // A message sent while a menu holds Term would land in the menu: its Enter
  // picks the highlighted choice.
  const chatUnavailable = chatCannotSend ?? (board?.state === "waiting" || liveScreen.menu ? t("board.chat.waiting") : undefined);
  // A question Claude Code asked (AskUserQuestion) is answered from its card
  // with the keys Term takes, each sent only once Term shows what it answers
  // (ask-keys.ts). The answer reads back from the transcript, as a reply does.
  // "Chat about this" is the prompt's own last row, picked by its keys through
  // the same send, and counted as an answer from Chat.
  const answerAsk = async (steps: AskStep[] | null): Promise<AskSendResult> => {
    if (!steps) return "unavailable";
    const result = await session.sendAsk(steps, key);
    if (result === "sent" || result === "partial") {
      setChatSent(sent => sent + 1);
      noteFeature("chat-answer");
    }
    return result;
  };
  // Claude Code's permission prompt and plan approval, answered from the
  // Decision card docked under Chat: read off the live screen while the
  // transcript says a call or a plan waits (use-prompt-decision.ts).
  const promptDecision = usePromptDecision({
    on: chatOn && chatProvider === "claude" && screenFlags.decision && chatCannotSend === undefined,
    turns: chatSource.state === "ready" ? chatSource.turns : NO_TURNS,
    session: name,
    subject: key,
    readScreen: session.readScreen,
    sendAsk: session.sendAsk,
    onSent: () => { setChatSent(sent => sent + 1); noteFeature("chat-decision"); },
    onShowTerm: () => showView("term"),
  });
  const chatTurns = chatSource.state === "ready" ? chatSource.turns : NO_TURNS;
  // An answer chosen on an alert (answer-intent.ts), pressed through the card
  // that answers the prompt once its words are checked; a prompt that moved is
  // left to the reader, with a line saying so (use-intent-press.ts).
  const intentPress = useIntentPress({
    sessionId: chatOn && chatProvider === "claude" && chatCannotSend === undefined ? chatSession : null,
    target: intentTarget(promptDecision?.model, chatTurns),
    readScreen: () => session.readScreen(key),
    onOutcome: kind => {
      if (chatSession) answerIntents.report({ sessionId: chatSession, kind, at: Date.now() });
      const said = INTENT_NOTICE[kind];
      if (said) setNotice(t(said));
    },
  });
  const promptCard = promptDecision && intentPress && intentPress.for === promptDecision.model.id ? { ...promptDecision, press: intentPress } : promptDecision;
  // A card that answers the question wins: the menu on Term's screen is then
  // that question's, and Chat already shows it with its real choices.
  const cardAsks = promptCard !== undefined || waitsInChat(chatTurns);
  const termMenu = cardAsks ? null : liveScreen.menu;
  const chatAsk: ChatAsk | undefined = chatSession === null ? undefined : {
    blocked: chatCannotSend,
    // An ended session asks nothing any more: its last question is not waiting.
    ...(phase.kind === "ended" ? { gone: true } : null),
    onShowTerm: () => showView("term"),
    send: (questions, picks) => answerAsk(askSteps(questions, picks)),
    chat: questions => answerAsk(chatSteps(questions)),
    ...(intentPress && !promptDecision ? { press: intentPress } : null),
  };
  // The pane's Chat | Term switch, as alerts, notifications and the chord
  // reach it (use-chat-pane-links.ts).
  useChatPaneLinks({
    chatSession,
    chatOn,
    focused: workspace && (p.split?.primary ?? true),
    showChat: () => showView("chat"),
    toggle: () => {
      if (chatOn) { intoPane(); return; }
      showView("chat");
    },
  });
  // Under Chat's last line: where a message sent from here stands, and what the
  // session is doing, in the header's words (chat-progress.ts) and, while it
  // works, its own screen's ("Pondering…", use-screen-status.ts). The row keeps
  // the turn's clock, so the header's tool time is left out of its words.
  const screenWords = useScreenStatus({
    on: chatOn && status.state === "working" && chatCannotSend === undefined && (chatProvider === "claude" || chatProvider === "codex"),
    subject: key,
    readScreen: session.readScreen,
  });
  // A compaction the session's own screen shows once its turn is over: the
  // same read as the menu (liveScreen, above), off while the working row's
  // read is on.
  const compactionSeen = liveScreen.compacting;
  // Over once the conversation has its /compact line, though the screen's
  // reads hold it a miss or two longer.
  const compaction = compactionSeen && !compactedSince(chatTurns, compactionSeen.since) ? compactionSeen : null;
  // Compacting now, by either read: by hand once the turn is over, or by
  // itself in the middle of one.
  const compactingNow = compaction !== null || (screenWords !== null && saysCompacting(screenWords));
  const chatFacts: ChatFacts = {
    turns: chatTurns,
    prompts: p.show.kind === "session" ? p.show.session.promptCount ?? 0 : 0,
    state: status.state,
    detail: metaRest({ ...status, seconds: undefined }) ?? undefined,
    status: screenWords ?? undefined,
    since: p.show.kind === "session" ? p.show.session.turnStartedAt : undefined,
    tool: !!status.tool,
    heardAt: p.show.kind === "session" ? p.show.session.heardAt : undefined,
    connected: chatCannotSend === undefined,
    asked: cardAsks || termMenu !== null,
    compacting: compactingNow,
  };
  const chatProgress = useChatProgress(chatPending[chatDraftKey], chatFacts, next => setChatPending(all => {
    if (next) return { ...all, [chatDraftKey]: next };
    const rest = { ...all };
    delete rest[chatDraftKey];
    return rest;
  }));
  // What the session still does once its turn is over, on Chat's live row
  // (live-activity.ts): its background agents, as the board's lifecycle has
  // them, and what its own screen shows (liveScreen, above): a compaction
  // until the conversation has its /compact line, and a menu no card asks.
  const chatLiveNow = chatLive({
    agents: p.show.kind === "session" ? p.show.session.background : undefined,
    compacting: compaction,
    menu: termMenu,
    working: chatProgress.activity?.state === "working",
  });
  // A message the session did not take goes back into an empty box (use-chat-returned.ts).
  const chatReturned = useChatReturned(chatDraftKey, chatProgress.outgoing, chatDraft, text => putDraft(chatDraftKey, text));

  // CHAT'S ⋯ (chat-actions.ts says what each is, and whose; ChatMenu.tsx draws
  // them in the header's ⋯). Compact is Claude Code's /compact, sent as the box
  // sends one typed there, and followed to its end, which is said under the
  // box: a run per session, looked at while Chat shows it (use-chat-compact.ts).
  const agentLabel = agentName(chatProvider);
  const compactOn = chatSession !== null && !chatReadOnly && compactOffered(chatProvider);
  const compact = useCompactRun({
    session: chatDraftKey,
    watching: chatOn && compactOn && chatCannotSend === undefined,
    turns: chatTurns,
    compacting: compactingNow,
    untaken: chatProgress.outgoing?.state === "unconfirmed" && isCompactCommand(chatProgress.outgoing.text),
    onEnd: (end, at) => {
      const said = COMPACT_SAID[end];
      if (said && at === chatDraftKey) setNotice(t(said));
    },
  });
  const brisk = chatOn && (compactingNow || compact.running);
  useEffect(() => { setCompactBrisk(brisk); }, [brisk]);
  // Why Compact cannot go now: what keeps the box from sending, a compaction
  // under way, or a turn at work (it would wait in Claude Code's queue).
  const compactWhy = compactOn ? compactBlocked({
    unavailable: chatUnavailable,
    compacting: compactingNow || compact.running,
    working: status.state === "working" || chatProgress.activity?.state === "working" || chatProgress.outgoing?.state === "sending",
  }, t, agentLabel) : null;
  // The one way a message leaves Chat: the box's Send and the menu's Compact.
  // `action`: sent by a menu row, never put back into the box (use-chat-returned.ts).
  const sendFromChat = (text: string, action = false): PromptSendResult => {
    if (chatUnavailable) return "unavailable";
    const result = session.sendPrompt(text, key);
    if (result === "sent") {
      setChatSent(sent => sent + 1);
      noteFeature("chat-reply");
      // On its way, not yet taken: Chat says so under the conversation.
      setChatPending(all => ({ ...all, [chatDraftKey]: pendingFor(text, chatFacts, Date.now(), { action }) }));
      // A /compact typed in the box is followed too, when it would go now.
      if (compactOn && compactWhy === null && isCompactCommand(text)) compact.start();
    }
    return result;
  };
  const runCompact = () => {
    if (compactWhy !== null || compact.running) return;
    const result = sendFromChat(COMPACT_COMMAND, true);
    setNotice(t(result === "sent" ? "board.chat.actions.compact.sent"
      : result === "partial" ? "board.chat.composer.partial" : "board.chat.actions.compact.notSent"));
  };
  const lastWords = chatOn ? lastReply(chatTurns) : "";
  const boardSession = p.show.kind === "session" ? p.show.session.ref.sessionId : null;
  const chatMenu: ChatMenuView | null = chatOn ? {
    ...(compactOn ? { compact: { blocked: compactWhy, run: runCompact } } : null),
    ...(lastWords ? { copy: () => void copyText(lastWords).then(ok => setNotice(t(ok ? "board.chat.actions.copied" : "board.chat.actions.copyFailed"))) } : null),
    ...(p.onShowOnBoard && boardSession ? { board: () => p.onShowOnBoard?.(boardSession) } : null),
    term: () => showView("term"),
    details: sessionDetails({
      context: p.show.kind === "session" ? p.show.session.contextUse : null,
      spend: p.show.kind === "session" ? p.show.session.spend : undefined,
    }, t),
  } : null;

  // RENAMING (internal #101): held here rather than in the header, which is
  // drawn by calling it; the facts are the session on stage, so a switch to
  // another session closes an open field unsaved.
  const renameFacts = p.show.kind === "session" ? p.show.session.rename ?? null : null;
  const renameBack = useRef<HTMLButtonElement>(null);
  const renaming = useRenaming(renameFacts?.sessionId, renameBack);

  // The keyboard's owner goes up so the deck's shortcuts know to step aside.
  const onKeysOwner = useRef(p.onKeysOwner);
  onKeysOwner.current = p.onKeysOwner;
  useEffect(() => { onKeysOwner.current?.(session.keysOwner); }, [session.keysOwner]);
  // And to the desktop app, whose menu would otherwise take Ctrl+R, Ctrl+C and
  // the rest from the pane; given back when the stage goes. The rest of the
  // page holds still while they do (quiet-page.ts). Said for every pane at
  // once (pane-keys.ts): the pane the keys leave does not undo the pane they
  // went to.
  const keysToken = useRef({});
  useEffect(() => { paneHoldsKeys(keysToken.current, session.keysOwner === "pane"); }, [session.keysOwner]);
  useEffect(() => { const me = keysToken.current; return () => paneHoldsKeys(me, false); }, []);

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
  const unresumed = phase.kind === "ended" && phase.unresumed === true;
  // A Check again that found the folder still gone is said too.
  const stillGone = phase.kind === "folder-gone" && phase.checked === true && !phase.busy;
  useEffect(() => {
    const said = stageAnnouncement(name, phase);
    if (said) onAnnounce.current?.(said);
    // Keyed on the kind and the session, not the phase object, which a
    // re-render may rebuild with the same meaning. A reopen that could not
    // resume is said too: it can follow an ended pane without a live one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, key, unresumed, stillGone]);

  // AN AGENT THAT ENDED ITSELF closes its pane (internal #104): /exit, Ctrl+D,
  // anything that exited with status 0 while this pane watched it run
  // (endedCleanly). Only that pane: the Board's stage closes, a Workspace pane
  // empties as its ✕ empties it, and the session stays on the board to
  // reopen. A crash, a kill, a failed start, a lost socket or a restarting
  // deck keeps the pane, its last frame and Reopen. A launch the board never
  // had as a session keeps its "Launch again" too.
  const closeOnEnd = useRef(p.onClose);
  closeOnEnd.current = p.onClose;
  const endedItself = phase.kind === "ended" && phase.clean === true && p.show.kind === "session";
  useEffect(() => { if (endedItself) closeOnEnd.current(); }, [endedItself, key]);

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
  // The conversation came here by itself once Claude exited where it ran
  // (Resume here after exit): the keys go into the pane as soon as it takes
  // them, as after a Reopen here. Not where the reader has since taken the
  // focus — another pane, a field — which keeps it.
  const resumedHere = useRef(false);
  useEffect(() => {
    if (phase.kind === "not-attachable") { resumedHere.current = phase.awaitingExit === true; return; }
    if (phase.kind === "attaching") return;
    const resumed = resumedHere.current;
    resumedHere.current = false;
    if (!resumed || phase.kind !== "live" || phase.readOnly) return;
    const active = document.activeElement;
    if (!active || active === document.body || rootRef.current?.contains(active)) p.onWantKeys?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  // The wait Stop there and resume here armed ended with Claude still running
  // there: its Cancel pressed, or the stop refused. That Cancel stood where the
  // confirm was, a slot the offer does not draw, so the focus it held went to
  // the page. It goes to the card's way on instead: Stop there and resume
  // here, else Resume here after exit. Focus the reader took elsewhere stays.
  const stopWait = phase.kind === "not-attachable" && phase.awaitingExit === true && phase.stopping === true;
  const wasStopWait = useRef(stopWait);
  useLayoutEffect(() => {
    const ended = wasStopWait.current && !stopWait;
    wasStopWait.current = stopWait;
    if (!ended) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    rootRef.current?.querySelector<HTMLElement>('.ts-card [data-stop-elsewhere="stop"], .ts-card [data-after-exit="arm"]')?.focus();
  }, [stopWait]);
  // The session hook's snapshot is the shown subject's only once it has said
  // so: in the render that moves the stage, it is still the last one's, and
  // a request met on that pane, or answered by its card, would be spent on a
  // session the stage has left.
  const current = session.subject === key;
  useFocusRequest({
    key, request: p.focusRequest, launch: subject.kind === "launch", typing: current && typing,
    from: subject.kind === "session" && subject.launch ? `launch:${subject.launch}` : null,
    focus: request => { intoPane(request); },
    settled: current && settlesFocus(phase), land: request => landFocus(rootRef.current, p.holdsTypeAhead?.(request) ?? null),
    unmet: request => { p.takeTypeAhead?.(request); },
  });

  // Not while a check is running: the session refuses that press, and a
  // request made for it would have let go of what the first one held.
  const retry = () => {
    if ((phase.kind === "tmux-missing" || phase.kind === "folder-gone" || (phase.kind === "error" && phase.reopen)) && phase.busy) return;
    session.retry();
    p.onWantKeys?.();
  };

  // Reopen here asks for the keys too, as a launch or an open does: the end
  // bar's button goes as the pane comes back, and with it the focus, so the
  // reopened pane was live with the keys on the board and the next letters
  // ran the deck's shortcuts. A second press while it works asks for nothing.
  const reopen = () => {
    if ((phase.kind === "not-attachable" || phase.kind === "ended") && phase.busy) return;
    session.adopt();
    p.onWantKeys?.();
  };

  // THE FOLDER FIRST. Start again and a new session here start an agent in
  // the pane's own folder: the deck is asked about it before (Reopen here
  // asks in the session hook), and a folder that went away — a removed
  // worktree, a project moved or renamed — is named, with Choose folder… and
  // Check again (folder-gone), never a start the engine could put elsewhere.
  const show = p.show;
  const launchAgain = p.onLaunchAgain;
  const startAgain = launchAgain && show.kind === "launch"
    ? () => session.startIfFolder(show.cwd, { agent: show.agent }, launchAgain)
    : launchAgain;
  const sessionRef = show.kind === "session" ? show.session.ref : null;
  const freshAgent = sessionRef?.provider === "claude" ? "claude" : sessionRef?.provider === "codex" ? "codex" : null;
  const startNewHere = p.onStartNew;
  const startNew = startNewHere && sessionRef && freshAgent
    ? () => session.startIfFolder(sessionRef.cwd, { agent: freshAgent }, startNewHere)
    : startNewHere;
  // Choose folder…: a NEW session of the same agent in the folder chosen,
  // never this conversation resumed somewhere else, and only on that choice.
  // The desktop app's own dialog where there is one; elsewhere — a browser,
  // an app without the dialog — New session, with the agent chosen.
  const chooseId = `ts-choose-${useId()}`;
  const chooseFolderFor = (agent: TerminalProvider, gone: string) => {
    const startIn = p.onStartIn;
    if (startIn && canChooseFolder()) {
      void chooseFolder().then(cwd => {
        if (typeof cwd === "string") startIn(agent, cwd);
        else if (cwd === undefined) p.onNewSession(chooseId, { agent, gone });
      });
      return;
    }
    p.onNewSession(chooseId, { agent, gone });
  };
  const goneAt = phase.kind === "folder-gone" ? { agent: phase.agent, cwd: phase.cwd } : null;
  const chooseFolderHere = goneAt ? () => chooseFolderFor(goneAt.agent, goneAt.cwd) : undefined;

  const end = endView(phase, p.show, {
    reopen, launchAgain: startAgain, startNew, chooseFolder: chooseFolderHere, chooseId, checkAgain: retry,
    cancel: session.cancelFolder, attachAgain: retry });

  // A CODEX THAT UPDATED ITSELF comes back by itself. Its own "Update now"
  // installs the new version, asks to be restarted and exits; the session
  // hook saw the codex on disk replaced while the pane ran (`updated`), and
  // the pane does what its end bar offers, for the reader: Reopen here for a
  // session, which resumes it here with its folder and account, or Launch
  // again for a launch that never had one. Once per session: a restarted
  // Codex that updates again keeps its end bar, and a launch started this
  // way counts as the one it replaced. Never closed as an ending would be.
  // Built once (a lazy useState, as the #612 rule asks), not on every render.
  const restarts = useState(() => ({ done: new Set<string>(), launching: false }))[0];
  const restartAction = useRef<(() => void) | null>(null);
  restartAction.current = end?.onAction ?? null;
  useEffect(() => {
    const r = restarts;
    if (r.launching && p.show.kind === "launch") r.done.add(key);
    r.launching = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const updatedItself = current && phase.kind === "ended" && phase.updated === true;
  useEffect(() => {
    const r = restarts;
    if (!updatedItself || r.done.has(key)) return;
    r.done.add(key);
    r.launching = p.show.kind === "launch";
    restartAction.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedItself, key]);
  // Beside a mouse the keys bar is out in the window's status bar, so the end
  // action is drawn in this pane's header instead; on a phone, in the bar.
  const statusSlot = useStageStatusSlot();
  const endAt = endPlacement(statusSlot !== null, end);
  // Beside a mouse the end bar's buttons are in the header and its sentence
  // only a tooltip there: the kept frame carries the line. On a phone the
  // keys bar in the pane says it (endPlacement).
  const frameNote = endAt.header && phase.kind === "folder-gone" && phase.frame
    ? { ...folderGoneLine(phase), where: phase.cwd } : undefined;
  const noted = frameNote !== undefined;
  // The line is measured as it is drawn and before it is painted, so the
  // frame is never seen under it: its height moves the frame down (the
  // section's --ts-note-h) and takes its rows from the terminal, which is
  // fitted again as it is on any resize. Gone, the frame has the room back.
  useLayoutEffect(() => {
    const line = noted ? rootRef.current?.querySelector?.<HTMLElement>(".ts-frame-note") ?? null : null;
    if (!line) { setNoteH(0); return; }
    const measure = () => setNoteH(Math.ceil(Math.round(line.getBoundingClientRect().height * 100) / 100));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(line);
    return () => watch.disconnect();
  }, [noted, chatOn]);
  const hosts = useOlderHosts(p.windows === true, key, s => onAnnounce.current?.(s), p.hostsApi);

  const composer = chatOn && chatSession !== null && !chatReadOnly ? <ChatComposerSlot
    key={chatDraftKey}
    value={chatDraft}
    onChange={value => putDraft(chatDraftKey, value)}
    unavailable={chatUnavailable}
    onShowTerm={() => showView("term")}
    session={chatDraftKey}
    turns={chatTurns}
    notTaken={chatReturned.text}
    provider={chatProvider}
    images={chatImages[chatDraftKey] ?? NO_IMAGES}
    onImagesChange={images => setChatImages(all => ({ ...all, [chatDraftKey]: images }))}
    imagesInTerm={takesImages(chatProvider)}
    // Each picture is kept by the deck first, then its path goes into the
    // session as Term pastes a dropped file's (chat-images.ts). One the deck
    // did not keep sends nothing at all: the draft and pictures stay.
    onSendImages={takesImages(chatProvider) ? async (text, images) => {
      if (chatUnavailable) return "unavailable";
      const paths: string[] = [];
      for (const image of images) {
        const path = await saveChatImage(image.blob);
        if (!path) return "images-failed";
        paths.push(path);
      }
      const result = await session.sendPromptWithImages(text, paths, key);
      if (result === "sent") {
        setChatSent(sent => sent + 1);
        noteFeature("chat-reply");
        setChatPending(all => ({ ...all, [chatDraftKey]: pendingFor(text, chatFacts, Date.now(), { images: images.length }) }));
      }
      return result;
    } : undefined}
    onSend={text => sendFromChat(text)}
    // Stop is Claude Code's Esc, offered while the board says it works and
    // sent only once Term shows "esc to interrupt" (chat-stop.ts).
    canStop={chatProvider === "claude" && chatCannotSend === undefined && board?.state === "working"}
    onStop={async () => {
      const result = await session.sendAsk(stopSteps(), key);
      if (result === "sent" || result === "partial") {
        setChatSent(sent => sent + 1);
        noteFeature("chat-stop");
      }
      return result;
    }}
  /> : undefined;

  const style = {
    "--ts-term-top": `${p.geometry.termTop}px`,
    ...(noteH > 0 ? { "--ts-note-h": `${noteH}px` } : {}),
  } as CSSProperties;

  return (
    <section
      ref={rootRef}
      className="ts-stage"
      role={p.tabbedBy ? "tabpanel" : "region"}
      aria-label={t("board.stage.region", { name })}
      data-kind={phase.kind}
      data-empty={p.show.kind === "empty" || undefined}
      data-live={live || undefined}
      data-takeover={p.geometry.takeover || undefined}
      id={workspace && (p.split?.primary ?? true) ? WORKSPACE_PANE_ID : p.panelId}
      aria-labelledby={p.tabbedBy}
      tabIndex={workspace ? -1 : undefined}
      data-fill={workspace || undefined}
      data-secondary={p.split?.primary === false || undefined}
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
        rename={renameFacts ? { facts: renameFacts, on: renaming.on, start: renaming.start, done: renaming.done, back: renameBack } : null}
        provider={p.show.kind === "session" ? p.show.session.ref.provider : p.show.kind === "launch" ? p.show.agent : null}
        status={status}
        keysOwner={session.keysOwner}
        chordLabel={chordLabel}
        canType={typing}
        expanded={p.split ? p.split.max : p.expanded}
        canFull={p.split ? false : fullStage.can}
        full={p.split ? false : fullStage.full}
        split={p.split != null}
        paneLink={p.split?.number != null ? { number: p.split.number, active: p.split.primary } : undefined}
        onDragHead={p.split?.onDragHead}
        takeover={p.geometry.takeover}
        workspace={workspace ? (p.show.kind === "empty" ? "empty" : "pane") : undefined}
        context={p.show.kind === "session" ? p.show.session.contextUse : null}
        view={chatSession !== null ? { current: view, onChange: showView } : undefined}
        chat={chatMenu}
        // Only while a terminal is on the stage to size: not on the empty
        // pane, a card that has none, or Chat.
        textSize={p.show.kind === "empty" || paneless(phase) || chatOn ? undefined : { step: textStep, onStep: stepTerminalText }}
        nothingRunning={p.show.kind === "empty" || phase.kind === "ended" || phase.kind === "folder-gone"
          || (subject.kind === "launch" && (phase.kind === "error" || phase.kind === "tmux-missing" || phase.kind === "tmux-installing"))}
        onKeys={() => {
          if (session.keysOwner === "pane") { session.release(); p.onRelease?.(); }
          else intoPane();
        }}
        onExpand={p.split ? p.split.onMax : fullStage.toggle}
        onClose={p.onClose}
        end={endAt.header}
        // The strip: the tab on show says the header's own state, which knows
        // the pane is reconnecting or not attached; the others, the board's.
        tabs={p.tabs ? { ...p.tabs, items: p.tabs.items.map(x => (x.on ? { ...x, status } : x)), menu: { open: tabMenu, set: setTabMenu } } : undefined}
      />
      <StageBody
        hostRef={session.hostRef}
        paneName={name}
        phase={phase}
        context={p.show.kind === "session" ? p.show.session.context : null}
        windows={p.windows}
        launched={p.show.kind === "session" && (p.show.session.launched === true || !!p.show.launch)}
        boardState={board?.state ?? null}
        onAdopt={reopen}
        handoff={handoffShown ? { moving, reason: handoffStopped, toggle: toggleHandoff, lookAgain } : undefined}
        afterExit={afterExit}
        resumeCommand={claudeSource && handoffCwd ? resumeCommand(handoffCwd, claudeSource) : undefined}
        onNotNow={p.onClose}
        onRetry={retry}
        onStartNew={startNew}
        onChooseFolder={chooseFolderHere}
        chooseFolderId={chooseId}
        frameNote={frameNote}
        startNewTip={p.show.kind === "session" ? t(START_NEW_TIP_MSG, { name: agentName(p.show.session.ref.provider) }) : undefined}
        onNewSession={p.onNewSession}
        workspace={workspace && p.show.kind === "empty"}
        waiting={workspace ? p.waiting ?? null : null}
        onOpenWaiting={openWaiting(p.waiting, p.onOpenWaiting)}
        screens={chatSession !== null ? {
          view, source: chatSource, provider: chatProvider, ask: chatAsk, decision: promptCard,
          session: chatDraftKey, outgoing: chatReturned.outgoing, activity: chatProgress.activity, live: chatLiveNow, onShowTerm: () => showView("term"),
        } : undefined}
      />
      {/* Once, in Chat: alerts when a session needs you (notify-offer.ts). */}
      {chatOn && <NotifyOffer />}
      <KeysBar
        primary={p.split?.primary ?? true}
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
        tabbed={workspace && !!p.tabs}
        paneless={p.show.kind === "empty" || paneless(phase) || onItsWay(phase, frame)}
        onFirstRunDone={p.onFirstRunDone}
        chat={chatOn}
        composer={composer}
        chatCannotType={chatCannotType}
        onShowTerm={() => showView("term")}
        onTypeHere={() => intoPane()}
        end={endAt.bar}
        asks={p.asks}
        arrival={p.arrival}
        onNextAsk={p.onNextAsk}
        onAnswerArrival={p.onAnswerArrival}
        hosts={hosts.line ? { said: hosts.line, onReview: hosts.canReview ? hosts.review : null } : null}
      />
      {/* The phone's key row (640 and under; hidden by the sheet elsewhere):
          the pane's own input, six keys a screen keyboard lacks. */}
      <PhoneKeys canType={typing} paneless={p.show.kind === "empty" || paneless(phase)} onKey={session.press} holdsFocus={session.holdsFocus} />
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
