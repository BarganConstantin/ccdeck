import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  MiniMap,
  type Edge,
  type Node,
  ReactFlowProvider,
  useReactFlow,
} from "reactflow";
import AgentNode from "./components/AgentNode";
// Keeps a side panel mounted long enough to animate out — see panel-exit.ts
// for why `{open && <Panel/>}` cannot do that on its own.
import { usePanelPresence, isMounted } from "./panel-exit";
import ToolModal from "./components/ToolModal";
import SessionClusters from "./components/SessionClusters";
import SessionGroupNode from "./components/SessionGroupNode";
import RecapNoteNode from "./components/RecapNoteNode";
import RecapTieEdge from "./components/RecapTieEdge";
import ToolBursts from "./components/ToolBursts";
import SessionSummary from "./components/SessionSummary";
import ContextModal from "./components/ContextModal";
import SessionList from "./components/SessionList";
import UsagePanel from "./components/UsagePanel";
import MachinePanel from "./components/MachinePanel";
import AccountsPanel from "./components/AccountsPanel";
import { snapshotToFlow, type FlowNodeData } from "./canvas-flow";
import { exportFileName, sessionExport } from "./session-export";
import ClearConfirm from "./components/ClearConfirm";
import KeyboardHelp from "./components/KeyboardHelp";
import GuideModal from "./components/GuideModal";
import { WELCOME_STEPS } from "./components/guide-art";
import SoundMenu from "./components/SoundMenu";
import AppearanceMenu from "./components/AppearanceMenu";
import ClaudeFm from "./components/ClaudeFm";
import {
  customFmId, customFmSelection,
} from "./fm-stations";
import ReleaseNotesModal from "./components/ReleaseNotesModal";
import { clearActionFor, type ClearSource } from "./clear-confirm";
import { sweepTick } from "./prune";
import { REMOVED_NODES_KEY, readRemovedNodes, removalHiddenIds, removalsLiftedByWork, removalTimes, saveRemovedNodes, sessionsCalledBack, visibleBoard, withoutRemovals } from "./remove-node";
import { useDragTrash } from "./use-drag-trash";
import { useBubbleAnimation } from "./use-bubble-animation";
import { useZoomLod } from "./use-zoom-lod";
import { useEventStream } from "./use-event-stream";
import { useSelection } from "./use-selection";
import { useBoardTick } from "./use-board-tick";
import { useAgentFocus } from "./use-agent-focus";
import { usePeekReaders } from "./use-peek-readers";
import { useBoardLayout } from "./use-board-layout";
import { useReframe } from "./use-reframe";
import { useCanvasSize } from "./use-canvas-size";
import { useNodeMeasurements } from "./use-node-measurements";
import { useLayoutFrame } from "./use-layout-frame";
import { useCamera } from "./use-camera";
import { usePointerFocus } from "./use-pointer-focus";
import { clearStoredLayout, loadViewport, saveLayout, saveViewport } from "./layout-storage";
import { isCanvasNodeElement } from "./canvas-node-element";
import { useDeckShortcuts } from "./use-deck-shortcuts";
import { useNodeDrag } from "./use-node-drag";
import { EmptyHero, TabCapHero } from "./components/EmptyHero";
import Detail from "./components/Detail";
import VersionChip from "./components/VersionChip";
import { SessionRun, SourceRun } from "./components/TopbarRuns";
import { NotifySaid, StatusStrip, WaitingStat } from "./components/TopbarReadouts";
import SelectedRibbon from "./components/SelectedRibbon";
import CanvasControls from "./components/CanvasControls";
import CategoryFilterBar from "./components/CategoryFilterBar";
import AutoFitChip from "./components/AutoFitChip";
import DragTrashZone from "./components/DragTrashZone";
import VersionBanner from "./components/VersionBanner";
import ConnectionBanner from "./components/ConnectionBanner";
import OldNameBanner from "./components/OldNameBanner";
import { spotlightUnion } from "./spotlight";
import { usePauseGate } from "./use-pause-gate";
import { useDeckScope } from "./use-deck-scope";
import { useDeckUpgrade } from "./use-deck-upgrade";
import { useBrowserWatchBadge } from "./use-browser-watch-badge";
import { useAppearance } from "./use-appearance";
import { useCategoryFilterBar } from "./use-category-filter-bar";
import { useChimePlayer } from "./use-chime-player";
import { useClaudeFm } from "./use-claude-fm";
import { useDesktopUpdate } from "./use-desktop-update";
import { useAutoRestart } from "./use-auto-restart";
import { useLanPairRequests } from "./use-lan-pair-requests";
import { useLeftColumn } from "./use-left-column";
import { useLiveAnnouncements } from "./use-live-announcements";
import { useOsNotifications } from "./use-os-notifications";
import { useMirroredRef } from "./use-mirrored-ref";
import { useOldNameNotice } from "./use-old-name-notice";
import { useCustomTones } from "./use-custom-tones";
import { useTonePrefs } from "./use-tone-prefs";
import { usePresenceBeacon } from "./use-presence-beacon";
import { useVersionCheck } from "./use-version-check";
import { useWelcomeAndNotes } from "./use-welcome-and-notes";
import { readStored } from "./storage";
import { PRODUCT } from "./brand";
import { ambientSignal, FAVICON_HREF, type AmbientSignal } from "./ambient";
import { blockedSessions, runningSessionCount } from "./ambient-counts";
import { canAsk } from "./notify";
import type { NotifyPermission } from "./notify";
// Loaded when they open (#883). Both are opened rarely and each is a large
// file; imported here, they were in the one bundle every reload and every deck
// opened from another machine had to fetch before drawing anything. The topbar
// needs only Browser Watch's unseen count, which lives in browser-watch-seen.
const UsageHistoryModal = lazy(() => import("./components/UsageHistoryModal"));
const BrowserWatchModal = lazy(() => import("./components/BrowserWatchModal"));
import LanPairRequestModal, { nextRequest } from "./components/LanPairRequestModal";
import { findToolOnBoard, initialState, type GraphState } from "./reducer";
import { isAgentVisible, computeVisibleIds } from "./visibility";
import { sessionGroupNodes } from "./session-group-nodes";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from "./stored-viewport";
import { selfPressProps } from "./panel-press";
import { isUserViewportGesture } from "./viewport-intent";
import { shouldAnimateViewport } from "./viewport-motion";
import { shouldRefit, type NodeBox } from "./drift";
import SessionPeek, { hidePeek, showPeek } from "./components/SessionPeek";
import { useMonthlyUsage } from "./use-monthly-usage";
import { useSoundSwitch } from "./use-sound-switch";
import { useAutoFitSwitch } from "./use-auto-fit-switch";
import {
  readDesktopUpdate,
  readyDesktopUpdate,
  UPDATE_RESTART_WAIT_MS,
  updateRestartFailureText,
  updateRestartRefusal,
  type DesktopUpdateState,
  type UpdateRestartFailure,
} from "./desktop-update";
import { useRecapNotesVersion } from "./recap-note";
import type { Providers } from "./providers";
import { finishSoundTitle } from "./provider-copy";
import { createChimePlayer } from "./sound";
import type { AgentNodeData, ToolCall } from "./types";

const nodeTypes = { agent: AgentNode, sessionGroup: SessionGroupNode, recapNote: RecapNoteNode };
/** The recap note's tie to its card — see RecapTieEdge. At module scope like
 *  nodeTypes, since a new object each render makes React Flow warn and remount. */
const edgeTypes = { recapTie: RecapTieEdge };

/** What a mouse press can put focus on: the elements the browser looks for,
 *  walking up from whatever was pressed, when it decides where a click's focus
 *  goes. Written out here because releasePointerFocus has to predict that walk
 *  before the browser makes it — a press whose nearest candidate is the canvas
 *  itself is one the canvas should not answer (#434).
 *
 *  `[tabindex]` is the entry that makes the rule work at all: <main> carries
 *  tabindex="-1" for the skip link, which is exactly what puts it in this list.
 *  The disabled controls are excluded because the browser skips them too and
 *  keeps walking — a click on a disabled button lands its focus on the nearest
 *  enabled ancestor, which on this canvas is <main>. */
const FOCUS_CANDIDATES = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  "[tabindex]",
].join(",");


/** How long React Flow's own opening fit takes, when there is anyone watching
 *  it. Named because the answer to "should this animate" is asked of it too. */
const OPENING_FIT_MS = 400;
const DETAIL_OPEN_KEY = "agent-dag.detailOpen";
const USAGE_PANEL_OPEN_KEY = "agent-dag.usagePanelOpen";
/** Named for the panel it opens rather than for the button, which is how it
 *  survived the button changing: this key was written by a topbar meter that
 *  no longer exists, and a tab that had the panel open still finds it open. */
const MACHINE_PANEL_OPEN_KEY = "agent-dag.systemPanelOpen";
// First-run layout: Usage and Accounts open, everything else closed. Those two
// answer "how much have I got left, and on which account" — the questions you
// have before you have a graph worth looking at. The session list and detail
// panel are for navigating work that already exists, so they stay shut until
// asked for, and the canvas gets the width.
function loadDetailOpen(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(DETAIL_OPEN_KEY) === "1"; } catch { return false; }
}
function saveDetailOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(DETAIL_OPEN_KEY, open ? "1" : "0"); } catch {}
}
// Reads through storage.ts rather than window.localStorage directly: this runs
// inside a useState initialiser, and the property read throws outright on a
// browser that blocks site data, which takes App's first render with it.
function loadUsagePanelOpen(): boolean {
  const stored = readStored(USAGE_PANEL_OPEN_KEY);
  return stored === null ? true : stored === "1";
}
function saveUsagePanelOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(USAGE_PANEL_OPEN_KEY, open ? "1" : "0"); } catch {}
}
/**
 * Whether the machine panel was open when this tab was last looked at.
 *
 * OPEN ON A FIRST RUN, and never reopened after that — the same shape the
 * usage and accounts panels already use. This used to default to closed, on
 * the argument that "a machine readout that reopens itself on every refresh
 * would be occupying the rail on behalf of a decision nobody made". That
 * argument is about REOPENING, and the null check is exactly what prevents it:
 * a tab that has never expressed a preference gets the panel, and a tab that
 * has closed it once has expressed one and keeps it closed for good.
 *
 * The two cases were worth separating because they answer different people. A
 * first run is somebody who has not met the deck yet and cannot ask for a
 * panel they do not know is there; every run after that is somebody who has,
 * and whose answer is on record. Opening it starts the /api/system poll, which
 * stops with the panel and while the tab is hidden.
 */
function loadMachinePanelOpen(): boolean {
  const stored = readStored(MACHINE_PANEL_OPEN_KEY);
  return stored === null ? true : stored === "1";
}
function saveMachinePanelOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(MACHINE_PANEL_OPEN_KEY, open ? "1" : "0"); } catch {}
}

/** Build a portable JSON snapshot of a single session (root + every subagent)
 *  and trigger a browser download.
 *
 *  What goes IN the file, and what the file is called, are session-export.ts's
 *  — the format is the half people keep, and it was unreachable by any test
 *  while it lived in here (#1175). This is the download around it. */
function exportSessionJson(state: GraphState, sessionId: string): void {
  const payload = sessionExport(state, sessionId, new Date().toISOString());
  if (!payload) return;
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(payload.label, sessionId);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}

function Inner() {
  const rf = useReactFlow();
  // The graph itself, held in a ref because `applyEvent` mutates it and hands
  // the SAME object back — `revision` is what moves so a `useMemo` has anything
  // to watch. Built in a `useState` initialiser rather than as the `useRef`
  // argument: that argument is re-evaluated on every render and the result
  // discarded (#612), which is five fresh Maps a render for a value that is
  // wanted once. `stateRef.current` is still assigned from `applyEvent`, so the
  // ref stays.
  const initialGraph = useState(initialState)[0];
  const stateRef = useRef(initialGraph);
  const [removedNodes, setRemovedNodes] = useState<Set<string>>(() =>
    readRemovedNodes(typeof window === "undefined" ? null : window.localStorage));
  /** The last card taken off the board, for the sentence a screen reader
   *  hears. Nothing is drawn for it: the session list (L) is the way back. */
  const [lastRemoval, setLastRemoval] = useState<{ id: string; label: string } | null>(null);
  const [, force] = useState(0);
  const rerender = useCallback(() => force(x => x + 1), []);
  /** Right detail panel visibility — persisted across refresh. Declared ahead
   *  of the selection below, because a plain selection opens it (#814). */
  const [detailOpen, setDetailOpen] = useState<boolean>(loadDetailOpen);
  useEffect(() => { saveDetailOpen(detailOpen); }, [detailOpen]);

  const { selectedIds, primarySelectedId, selectAgent, clearSelection, pruneSelectionToBoard } =
    useSelection(stateRef, setDetailOpen);
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
  /** Whether the Clear confirmation is up. Clear truncates the server's event
   *  log, so nothing destructive happens until this dialog is answered. */
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  /** Whether the shortcuts sheet is up. Deliberately not persisted: it is a
   *  reference someone reaches for and closes again, and a deck that reopened
   *  it on every refresh would be answering a question nobody asked twice. */
  const [keyHelpOpen, setKeyHelpOpen] = useState(false);
  // The left column: the session list and the accounts panel share one slot,
  // and opening one evicts the other (#824). Both panels' state, persistence and
  // the eviction live in use-left-column.ts; only its toggles can open either.
  const { sessionListOpen, accountsPanelOpen, toggleSessionList, toggleAccountsPanel,
          closeSessionList, closeAccountsPanel } = useLeftColumn();
  /** Usage panel visibility — persisted across refresh. */
  const [usagePanelOpen, setUsagePanelOpen] = useState<boolean>(loadUsagePanelOpen);
  useEffect(() => { saveUsagePanelOpen(usagePanelOpen); }, [usagePanelOpen]);
  const { monthlyUsage, monthlyUsageUnavailable, monthUsageRef } = useMonthlyUsage();
  const [machinePanelOpen, setMachinePanelOpen] = useState<boolean>(loadMachinePanelOpen);
  useEffect(() => { saveMachinePanelOpen(machinePanelOpen); }, [machinePanelOpen]);
  /** The panel outlives its own `false` by the length of its exit, so closing
   *  it animates instead of cutting 288px out of the layout in one frame.
   *  Must match `--side-exit` in the sheet. */
  const accountsPhase = usePanelPresence(accountsPanelOpen, 200);
  /** The rail's two panels leave the same way — see --rail-exit in the sheet.
   *  Faster than the accounts panel because they travel less: 8px and a fade,
   *  against 288px of layout. */
  const usagePhase = usePanelPresence(usagePanelOpen, 130);
  const machinePhase = usePanelPresence(machinePanelOpen, 130);

  // ── the deck's own two tones (#704) ───────────────────────────────────────
  // Built lazily on the first gesture rather than here: an AudioContext
  // constructed before the page has been interacted with is created suspended,
  // and a suspended one is what you are then stuck with. The ref holds null
  // until `unlock` runs — and holds a FUNCTION rather than the result, because
  // a `useRef` seed that does work runs on every render and throws the result
  // away (#612).
  const chimesRef = useRef<ReturnType<typeof createChimePlayer> | null>(null);

  const { soundOn, toggleSound, activateSoundRef, soundOnRef } = useSoundSwitch(chimesRef);

  // What each tone is set to, how a change is written and auditioned, and the
  // preview timer behind it, live in use-tone-prefs.ts. The chime player reads
  // the settings through `tonePrefsRef` at play time; the custom-sound layer
  // below writes `setTonePrefs` when a clip it points at goes away.
  const { tonePrefs, setTonePrefs, tonePrefsRef, previewTone, changeTone } = useTonePrefs(chimesRef);

  // Custom sounds — the clips somebody imported or recorded, which tone points
  // at which, and every way one is added, renamed, chosen or removed — live in
  // use-custom-tones.ts. It sits on the tone settings above: removing a clip a
  // tone points at resets that tone's figure, which is the one write it makes
  // outside its own state.
  const { customSelections, customSelectionsRef, customAssets, clearCustomOnly, fallbackCustomRef,
          selectCustomTone, importNotificationAudio, createNotificationVoice, renameCustomAsset,
          deleteCustomAsset, previewCustomAsset }
    = useCustomTones({ chimesRef, setTonePrefs, tonePrefsRef, previewTone });

  /** The menu the topbar button opens (#711). Not persisted: a popover is a
   *  thing you are doing, not a thing you have set, and a deck that reloaded
   *  with a menu hanging open would be reporting a gesture nobody made. */
  const [soundMenuOpen, setSoundMenuOpen] = useState(false);
  /** The button itself, so the menu's outside-press rule can leave it alone —
   *  its own onClick already toggles, and both running would close the menu and
   *  reopen it in the same gesture. */
  const soundButtonRef = useRef<HTMLButtonElement | null>(null);
  const [appearanceMenuOpen, setAppearanceMenuOpen] = useState(false);
  const appearanceButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (soundMenuOpen) setAppearanceMenuOpen(false); }, [soundMenuOpen]);

  // The player behind the deck's own two tones, built once on mount and woken by
  // the first gesture anywhere — use-chime-player.ts. It reads every setting
  // through a ref at play time, so it never has to be rebuilt.
  const { chimeState } = useChimePlayer({ chimesRef, soundOnRef, tonePrefsRef, customSelectionsRef, fallbackCustomRef });

  // ── version drift ─────────────────────────────────────────────────────────
  // The stream of hook events from the server, and what it says about the
  // connection, in use-event-stream.ts. Called here, above everything that
  // keys off `live`: the version check, the desktop updater and the scope all
  // re-ask when a restart ends with the stream reconnecting. The pause gate
  // comes first because every envelope passes through it. Pause freezes the
  // canvas; it does not drop the connection. The gate, the mirrored flag and
  // the toggle's eviction accounting live in use-pause-gate.ts, which carries
  // the reasoning.
  const { pauseGate, paused, togglePause } = usePauseGate(stateRef);
  // The desktop app's update frames arrive on the same stream, and the handler
  // for them comes out of useDesktopUpdate below, which itself keys off `live`.
  // Bound once that hook has run; it is a stable callback.
  const desktopUpdateRef = useRef<(data: string) => void>(() => {});
  const { live, tabCapped, everConnected, liveSince } =
    useEventStream({ stateRef, rerender, pauseGate, chimesRef, desktopUpdateRef });
  // The deck's own version check — the banner, the chip and the poll behind
  // them — lives in use-version-check.ts. `live` drives the reconnect refresh.
  const { version, notice, noticeOpen, showNotice, dismissNotice,
          versionChecking, loadVersion } = useVersionCheck(live);
  // Everything about the desktop app's own updater — its state, the press rule
  // behind Restart to update, and the stream event that releases a press — is in
  // use-desktop-update.ts. `live` drives the read on every (re)connect.
  const { desktopUpdateRestarting, desktopUpdateFailure, readyAppUpdate,
          askDesktopUpdateRestart, onDesktopUpdateEvent } = useDesktopUpdate(live);
  desktopUpdateRef.current = onDesktopUpdateEvent;

  // Telling the server somebody is looking at this deck lives in
  // use-presence-beacon.ts. It takes nothing and returns nothing.
  usePresenceBeacon();

  // What changed since you last looked (#712), and the four-picture tour that
  // comes before it the first time: when each one opens, the notes an upgrade
  // holds back until the tour is closed, and the version chip's way back to
  // them. All of it, closing included, is in use-welcome-and-notes.ts.
  const { tourOpen, openTour, closeTour, releaseNotes, closeReleaseNotes, chipVersion,
          openReleaseNotes } = useWelcomeAndNotes({ version, readyAppUpdate });

  // What this deck may see — its workspace scope and which CLIs it watches —
  // comes from /api/health, re-asked on every reconnect, in use-deck-scope.ts.
  const { workspace, providers, providersRef } = useDeckScope(live);

  // The "started under an old npm name" notice lives in use-old-name-notice.ts.
  const { oldName, oldNameOpen, dismissOldName } = useOldNameNotice(version);
  // Upgrading the deck from its banner — the press, the faster poll while npm
  // runs, and copying the command for anyone who would rather type it — lives
  // in use-deck-upgrade.ts.
  const { upgradeState, upgradeFailure, startUpgrade, copyCommand, cmdCopied }
    = useDeckUpgrade({ version, loadVersion });

  // ccusage history modal — transient (not persisted), opened from the toolbar.
  const [usageHistoryOpen, setUsageHistoryOpen] = useState(false);
  const [browserWatchOpen, setBrowserWatchOpen] = useState(false);
  // The Browser Watch badge — what it counts, the slow poll behind it, and when
  // the reader last looked — lives in use-browser-watch-badge.ts.
  const { watchOn, setWatchOn, watchUnseen, markWatchSeen } = useBrowserWatchBadge();

  // A LAN pairing request waiting on this deck — the poll that finds one, and
  // the one answer at a time the dialog over the canvas gives — lives in
  // use-lan-pair-requests.ts.
  const { lanPending, lanDeferred, lanBusy, answerLanPair, deferLanPair } = useLanPairRequests();

  /** Bumped on each group-drag move so snapshotToFlow recomputes immediately
   *  (reads the freshly-pinned positions) rather than waiting for the 250ms
   *  tick. A plain counter — value is irrelevant, only the change matters. */
  const [dragTick, setDragTick] = useState(0);

  // The category filter row over the canvas: which categories are on the board,
  // which ones somebody muted, and the bar dimming itself when a card or a
  // bubble slides under it — in use-category-filter-bar.ts.
  const { presentCats, hiddenCats, toggleCat, catBarRef, catBarOccluded }
    = useCategoryFilterBar(stateRef);

  /**
   * Live positions of whatever is being dragged, applied over the rendered
   * array. Held in a ref and paired with a counter: the values change on every
   * pointer move, and putting them in state would deep-compare a Map on each
   * one for no benefit.
   */
  const dragPatchRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const [dragMoveTick, setDragMoveTick] = useState(0);

  // The deck's 250ms clock, and the sweeps that run on it — use-board-tick.ts.
  const now = useBoardTick({ stateRef, rerender, pruneSelectionToBoard, setContextFor, setSummaryFor });

  // Restarting the deck: the auto-update switch, the press behind the banner's
  // Restart, the idle stretch an automatic one waits for, and what the banner
  // says about it — in use-auto-restart.ts.
  const { autoRestart, toggleAutoRestart, restarting, restartMode, restartedTo, askRestart,
          restartCopy, restartFuseMs, loadAutoRestartPrefs }
    = useAutoRestart({ now, stateRef, version, notice, noticeOpen, upgradeFailure });

  const restoredViewport = useState(() => loadViewport())[0];
  // The deck's look — the theme, the pixel character, and the canvas palette
  // read from the theme's tokens — with the effects that keep the DOM, storage
  // and the window's title bar in step, in use-appearance.ts.
  const { theme, setTheme, characterEnabled, setCharacterEnabled, palette, minimapNodeFill }
    = useAppearance();
  // Claude FM's configuration — volume, mute, which station, the stations
  // somebody added, and which of them are not answering — with its storage, in
  // use-claude-fm.ts. Stations and the selection change only through its named
  // operations, which keep the two consistent.
  const { fmVolume, setFmVolume, fmMuted, setFmMuted, fmSource, customFmStations,
          unavailableFmStations, fmPlayRequest, addFmStation, renameFmStation,
          removeFmStation, pickFmSource, markFmStationAvailability } = useClaudeFm();

  // The camera's primitives — the one door every viewport the deck sets goes
  // through, the fit every structural change runs, and the bookkeeping that
  // lets a move tell it has been superseded: see use-camera.ts.
  const camera = useCamera();
  const { applyViewport, moveCamera, fitLeft, cameraEpochRef, lastFitTimeRef } = camera;

  // The board's arrangement — the stored positions and pins it was restored
  // from, the placeholders, the layout signature, the epoch R and the reframe
  // move, and the frame it was packed for — and R itself, in use-board-layout.ts.
  const layout = useBoardLayout(fitLeft);
  const { restoredLayout, pinnedRef, positionsRef, provisionalRef, lastLayoutSigRef, layoutEpoch, setLayoutEpoch, lastLayoutFrameRef,
          handleRelayout } = layout;

  /** The card the last focus framed, and when — so a re-pack that lands just
   *  after it (the reframe effect below) can frame it again where it went. */
  const lastFocusRef = useRef<{ id: string; at: number } | null>(null);
  /** focusAgent, for an effect declared above it. */
  const focusAgentRef = useRef<(id: string) => void>(() => {});

  // Apply restored viewport once ReactFlow's instance is ready. We skip
  // the initial fitView in that case (see <ReactFlow fitView={…}/> below).
  useEffect(() => {
    if (!restoredViewport) return;
    const id = window.setTimeout(() => {
      // Through applyViewport, not `setViewport(…, { duration: 0 })`: this one
      // runs 60ms after boot, and a deck that opened its own tab while the user
      // was looking elsewhere is a hidden tab at exactly that moment.
      try { applyViewport(restoredViewport, 0); } catch {}
      // Stamped like every other viewport the deck asks for. This one never
      // needed it while onMoveStart was the only signal, because a programmatic
      // setViewport carries no source event and never reached it; onMove does
      // see it, and an unstamped restore would read as the user's first gesture
      // and switch auto-fit off before they had touched anything.
      lastFitTimeRef.current = Date.now();
    }, 60);
    return () => window.clearTimeout(id);
  }, [applyViewport, restoredViewport]);

  /** The same boundary as a flag, for the layout: positions restored from
   *  storage are only pruned against the agents once all of them are back. */
  const historyReplayed = liveSince !== null;


  // The auto-fit's trailing timer (see effect after layoutSig is computed below).
  const fitTimerRef = useRef<number | null>(null);

  const lastLayoutSigForFitRef = useRef("");
  // Debounce timer for persisting the viewport on pan/zoom.
  const vpSaveTimerRef = useRef<number | null>(null);

  // Auto-recover from "drifted off-screen": every 1.5s check whether ANY
  // agent's bounding box intersects the visible viewport. If none have at
  // all, fit-view immediately. Skipped only when the user is actively
  // interacting (pan/zoom/drag in the last 800ms) so we don't yank the view
  // mid-gesture. This is the failsafe that recovers from layout reflows
  // when a new session arrives and dagre shifts everything off-screen.
  const lastInteractRef = useRef(0);
  const markInteract = useCallback(() => { lastInteractRef.current = Date.now(); }, []);
  // How big the canvas is, measured once by one observer and kept two ways:
  // quantised for the layout, whole for the drift watchdog below. See
  // use-canvas-size.ts.
  const { canvasRef, canvasSize, paneSizeRef } = useCanvasSize();
  // When a press or a wheel last landed anywhere inside the canvas element,
  // which contains the pane, the Controls stack and the minimap alike.
  //
  // This is the half of "the user took the wheel" that React Flow cannot tell
  // us: a minimap pan and a Controls zoom move the viewport through the store,
  // so they reach onMove with no source event and are indistinguishable there
  // from a fit the deck asked for itself. They are distinguishable here — a
  // gesture starts with the user touching something, and no programmatic fit
  // does. See viewport-intent.ts for the rule that reads it.
  const lastCanvasInputRef = useRef(0);
  const markCanvasInput = useCallback(() => { lastCanvasInputRef.current = Date.now(); }, []);
  /** Every input the rule in viewport-intent.ts needs, read at the moment a
   *  viewport change arrives. */
  const viewportMove = useCallback((sourceEvent: unknown) => ({
    hasSourceEvent: !!sourceEvent,
    at: Date.now(),
    lastDeckFitAt: lastFitTimeRef.current,
    lastCanvasInputAt: lastCanvasInputRef.current,
  }), []);
  const { autoFitDisabled, autoFitDisabledRef, disableAutoFit, enableAutoFitAndRefit } = useAutoFitSwitch(fitLeft);
  useEffect(() => {
    const id = setInterval(() => {
      if (autoFitDisabledRef.current) return;
      if (Date.now() - lastInteractRef.current < 800) return;
      const state = stateRef.current;
      const t = Date.now();
      const liveAgents: { id: string }[] = [];
      for (const a of state.agents.values()) {
        // Mirror isAgentVisible — was inline `exitAt + EXIT_ANIM_MS` only,
        // which skipped the ghost-session filter and disagreed with the node
        // renderer when stale-exitAt replays excluded subagents that the
        // canvas was still showing. Use the single source of truth.
        if (!isAgentVisible(a, t)) continue;
        liveAgents.push({ id: a.id });
      }
      if (liveAgents.length === 0) return;
      const boxes: NodeBox[] = [];
      for (const { id } of liveAgents) {
        const size = measuredRef.current.get(id);
        const pos = pinnedRef.current.get(id) ?? positionsRef.current.get(id);
        // An agent with no measurement or no position is not evidence either
        // way, so it is left out rather than counted as off-screen.
        if (!size || !pos) continue;
        boxes.push({ x: pos.x, y: pos.y, width: size.width, height: size.height });
      }
      // The decision itself lives in drift.ts, against the pane the deck
      // measured rather than a rectangle guessed from the window. `getViewport`
      // returns the pane's transform, so a node projected through it is in
      // pane-relative pixels — and the only rectangle in the same coordinate
      // space is the pane's own size. It used to be tested against
      // `innerWidth - 360`, which is the window minus a detail panel assumed
      // always open: right in one of the six layouts `.app` grids itself into,
      // wrong in the five others including the one the deck starts in (#615).
      if (shouldRefit({ pane: paneSizeRef.current, viewport: rf.getViewport(), boxes })) {
        fitLeft(600);
      }
    }, 1500);
    return () => clearInterval(id);
  }, [rf]);

  // True for the length of a drag gesture. A ref as well as state: the
  // measurement effect below reads it without wanting to re-run when it
  // changes, and the layout memo needs the state to recompute.
  const draggingRef = useRef(false);

  // Every card's size, from React Flow's store and from the DOM, with the two
  // counters the layout keys off: see use-node-measurements.ts.
  const { measuredRef, measuredVersionRef, sizeVersion, domSizeVersion } = useNodeMeasurements(draggingRef);

  // Everything "Remove node" has taken off the board: the removed agents, what
  // descends from them, and every agent of a removed session. Worked out once
  // and subtracted from BOTH layoutSig and visibleAgentIds below, so the cards,
  // the tool bubbles and the layout drop a removed agent together.
  const removedAgentIds = useMemo(
    () => removalHiddenIds(stateRef.current.agents.values(), removedNodes),
    [stateRef.current, stateRef.current.revision, removedNodes],
  );
  const layoutSig = useMemo(() => {
    const ids: string[] = [];
    for (const a of stateRef.current.agents.values()) {
      // Mirror isAgentVisible exactly — layoutSig and visibleAgentIds must
      // agree, otherwise dagre re-runs for agents that never render and
      // the cached positions drift relative to what's actually on canvas.
      if (!isAgentVisible(a, now) || removedAgentIds.has(a.id)) continue;
      ids.push(a.id + (a.parentId ? `>${a.parentId}` : ""));
    }
    ids.sort();
    return `${ids.join("|")}#sv${sizeVersion}.${domSizeVersion}`;
  }, [stateRef.current, stateRef.current.revision, now, sizeVersion, domSizeVersion, removedAgentIds]);

  // Persist the arrangement whenever it changes, not only when the user drags.
  // Auto-placed nodes are part of what gets restored on reload, so a session
  // that was never touched still comes back where it was. Debounced: layoutSig
  // moves on every structural change and localStorage writes are synchronous.
  const layoutSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (layoutSaveTimerRef.current != null) window.clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = window.setTimeout(() => {
      saveLayout(positionsRef.current, pinnedRef.current);
    }, 1500);
    return () => { if (layoutSaveTimerRef.current != null) window.clearTimeout(layoutSaveTimerRef.current); };
  }, [layoutSig]);

  // Auto-fit on layout-signature changes — the single source of truth for
  // structural shifts: agent added/removed, parent relationship changed, or
  // a measurement that moved a node. Catches the "14 agents in state but
  // none visible" case where count is stable but the layout reflowed.
  // Suspended entirely when the user has taken manual control of the
  // viewport (see autoFitDisabledRef + recenter button in Controls).
  useEffect(() => {
    if (lastLayoutSigForFitRef.current === layoutSig) return;
    const prev = lastLayoutSigForFitRef.current;
    lastLayoutSigForFitRef.current = layoutSig;
    if (!prev) return; // first render — let initial fitView prop handle it
    if (autoFitDisabledRef.current) return;
    const tnow = Date.now();
    if (tnow - lastFitTimeRef.current > 1200) {
      fitLeft(400);
    }
    if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
    fitTimerRef.current = window.setTimeout(() => {
      if (autoFitDisabledRef.current) return;
      fitLeft(500);
    }, 280);
  }, [layoutSig, rf, fitLeft]);

  // Union spotlight set — lineage of every selected agent merged. Multi-
  // select widens the spotlight without losing the "follow the chain"
  // semantics for a single click.
  const spotlightSet = useMemo<Set<string> | null>(
    () => spotlightUnion(stateRef.current, selectedIds),
    [stateRef.current, stateRef.current.revision, selectedIds],
  );

  // The visibility set drives BOTH the React Flow nodes prop and the
  // burst overlay's render gate — single source of truth so the two
  // can never disagree (which previously left orphan bursts on screen
  // when an agent was filtered out via one path but not the other).
  const visibleAgentIds = useMemo<Set<string>>(
    () => {
      const ids = computeVisibleIds(stateRef.current, now);
      for (const id of removedAgentIds) ids.delete(id);
      return ids;
    },
    [stateRef.current, stateRef.current.revision, now, removedAgentIds],
  );

  /** The pointer half of the skip link's focus target (#434).
   *
   *  `tabIndex={-1}` is on <main> so the skip link has somewhere to land, and
   *  it buys a second thing nobody asked for: an element a MOUSE can focus. A
   *  click on empty canvas parked focus on the canvas with nothing on screen to
   *  say so, and the next keystroke — any keystroke, including the ones the
   *  deck has no shortcut for — made the browser change its mind about
   *  `:focus-visible` for the element that was already focused. Selectors 4
   *  allows exactly that, and Chrome does it: the ring the skip link needs lit
   *  up around the whole window on a press the user reads as re-layout or a
   *  theme swap, and stayed until focus moved.
   *
   *  So the fix is here and not in the stylesheet, which cannot reach this.
   *  `:focus-visible` is the browser's own judgement, re-made AFTER focus has
   *  landed, so no selector can tell the two arrivals apart — CSS could only
   *  overrule the ring with `outline: none`, and the sheet is allowed exactly
   *  one of those (#368 pins the count, because a rule that quietly removes a
   *  focus ring is how the search field lost its own). Dropping the ring
   *  altogether is not on offer either: #381 put it there because landing
   *  somewhere with no sign you landed is the failure the skip link exists to
   *  fix. What is left is to take away the arrival that was never wanted. The
   *  ring is untouched, and the one path that can still reach it is the
   *  programmatic focus it was written for.
   *
   *  Capture phase, which is a measurement and not a preference: React Flow's
   *  pan handler calls stopImmediatePropagation() on the pane's mousedown, so a
   *  bubbling handler on <main> never sees the click that causes this at all.
   *  Cancelling the default costs the canvas nothing — panning, node drags,
   *  onPaneClick and the context menu all run off events of their own, and none
   *  of them is a default action. */
  const releasePointerFocus = useCallback((e: React.MouseEvent<HTMLElement>) => {
    // What the browser is about to focus: the nearest focus candidate at or
    // above the press. <main> is one of them — that is what tabindex="-1"
    // means — so a press that finds anything else found a real control, and a
    // real control keeps the click-to-focus every other control on the page
    // has. Asked with closest() rather than from a list of our own, because
    // the browser's own answer is the one that has to be predicted here.
    const target = e.target as Element | null;
    if (!target?.closest || target.closest(FOCUS_CANDIDATES) !== e.currentTarget) return;
    e.preventDefault();
    // And the other half: clicking empty canvas has always been how the mouse
    // puts focus down — canvas-keys.ts calls it the only route back to <body>
    // that existed before Escape learned to release one. Cancelling the
    // default focus on its own would leave the search box or a card still
    // holding it, so the click would stop meaning what it has always meant.
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, []);
  // How big each session was last frame, so a session that fans out subagents
  // can be told apart from one that merely re-rendered. Owned here rather than
  // in layout.ts because it is memory, not geometry.
  const prevSessionSizeRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  // Sizes only mean something once the cards have all mounted and measured.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(true), 2500);
    return () => window.clearTimeout(t);
  }, []);
  const { bubbling, endBubble, onBubble } = useBubbleAnimation();
  // True for the length of any drag gesture. React Flow marks the node under
  // the cursor with .dragging, and the stylesheet drops its transition — but
  // dragging a SESSION moves its member cards through state rather than
  // through the gesture, so they keep the transition and trail the cursor by
  // its full duration. That is the "dragging isn't smooth" everyone notices
  // and nobody can point at. A flag on the pane covers every node a gesture
  // can move, whichever way it moves them.
  const [dragging, setDragging] = useState(false);
  const { trashDragging, trashLabel, trashState, trashZoneRef, trashPhase, beginTrashDrag, trackTrashDrag, endTrashDrag } = useDragTrash();
  const { lod, lodRef, applyZoom } = useZoomLod({ stateRef, measuredRef, measuredVersionRef, canvasRef });

  // The selected agent. Declared this high because the rail measurement below
  // has to know whether the detail panel is MOUNTED, and `detailOpen && selected`
  // is what mounts it — see the `<aside className="detail">` near the end of
  // this file. Nothing between here and there reassigns `stateRef.current`
  // during render (the two writes are inside a replay effect and the SSE
  // handler), so reading it here is the same read it was 150 lines further on.
  const selected = primarySelectedId ? stateRef.current.agents.get(primarySelectedId) : null;
  /** Whether `.detail` is in the DOM, which is what the sheet keys the rail's
   *  horizontal position off: `--rail-r` is 368px with it and 8px without
   *  (`.app:not(:has(.detail))`), and `.usage-panel` takes the same 360px step.
   *  Not `detailOpen` on its own — the panel is `detailOpen && selected`, so a
   *  deck with the panel enabled and nothing selected is 360px out. */
  const detailShown = detailOpen && selected != null;

  // What the floating panels cover of the canvas, and the frame the layout and
  // every fit pack the board for: see use-layout-frame.ts.
  const { railInsetRef, availableWidth, availableHeight } =
    useLayoutFrame({ canvasRef, canvasSize, machinePhase, usagePhase, usagePanelOpen, detailShown });

  // Put away and brought back through recap-note.ts, and the note nodes are
  // built from it: a × has to rebuild the canvas now, not on the next tick.
  const recapNotesVersion = useRecapNotesVersion();

  // Rebuilt on every render, drags included.
  //
  // Freezing it during a drag was tried and reverted: it looks like an obvious
  // win — the rebuild is the most expensive thing here — but the node under the
  // cursor then stopped moving until the mouse came up. React Flow is given
  // `nodes` with no onNodesChange, so this array and React Flow's own store
  // both believe they own positions, and holding this one still meant the
  // stale one won. Anything done here has to keep the two in agreement.
  const { nodes, edges } = useMemo(
    () => {
      const flow = snapshotToFlow(
      stateRef.current, now, availableWidth, availableHeight, pinnedRef.current,
      measuredRef.current, prevSessionSizeRef.current, onBubble, settled, dragging,
      positionsRef.current, provisionalRef.current, layoutSig, lastLayoutSigRef,
      selectedIds, spotlightSet, visibleAgentIds, openContext, historyReplayed,
      restoredLayout.restored,
      );
      return visibleBoard(flow.nodes, flow.edges, removedNodes);
    },
    [stateRef.current, stateRef.current.revision, now, availableWidth, availableHeight, settled, dragging, layoutSig, selectedIds, spotlightSet, visibleAgentIds, openContext, dragTick, recapNotesVersion, removedNodes, layoutEpoch, historyReplayed],
  );

  // Re-column when the frame changes enough to change the answer, keeping what
  // the reader was looking at — use-reframe.ts.
  const primarySelectedIdRef = useMirroredRef(primarySelectedId);
  useReframe({
    nodes, edges, settled, dragging, availableWidth, availableHeight, layout, camera, rf,
    measuredRef, stateRef, lastFocusRef, primarySelectedIdRef, focusAgentRef, autoFitDisabledRef,
  });

  // Invisible per-session drag-handle nodes, one behind each session's cards;
  // see session-group-nodes.ts.
  const groupNodes = useMemo(() => sessionGroupNodes(nodes), [nodes]);

  /**
   * The array React Flow renders, with the in-flight drag applied on top.
   *
   * React Flow is given `nodes` without `onNodesChange`. That makes it fully
   * controlled: it does not move nodes itself, it reports the position changes
   * it would make and expects them to be applied. Nothing applied them, so the
   * only thing that has ever moved a node here is this array being rebuilt —
   * and that happens on the clock tick, four times a second.
   *
   * Hence the shape of the bug: a slow drag looked fine because four updates a
   * second is enough to look continuous, and a fast one visibly stepped and
   * trailed, because the gap between updates is however far the cursor got in
   * 250ms.
   *
   * So the drag is applied here instead, on every pointer move: the base array
   * is left to rebuild at its own pace, and the positions of the nodes being
   * dragged are patched over it. A patch is one shallow copy per node, which
   * is nothing next to rebuilding the graph from the event log — and it is the
   * whole reason the previous two attempts failed. Both tried to make the
   * rebuild happen less often, when the rebuild was the only thing moving the
   * node; the node then did not move at all until the mouse came up.
   */
  const allNodes = useMemo(() => {
    const base = [...groupNodes, ...nodes];
    const patch = dragPatchRef.current;
    if (!patch || patch.size === 0) return base;
    return base.map(nd => {
      const p = patch.get(nd.id);
      return p ? { ...nd, position: p } : nd;
    });
  }, [groupNodes, nodes, dragMoveTick]);

  // `selected` is declared with the rail measurement further up this file,
  // which needs to know whether the detail panel is mounted.

  // The tool the modal is showing, found without building a list of the ones it
  // is not (#997). In the render body and not skippable — `modalOpenRef` below
  // reads `openedTool != null` — so while the modal is open this runs on every
  // render, four times a second on an idle deck. What it must not do on that
  // tick is why the walk lives in the reducer; see findToolOnBoard.
  const openedTool: ToolCall | null =
    openedToolKey ? findToolOnBoard(stateRef.current.agents, openedToolKey.agentId, openedToolKey.toolId) : null;

  const handleClear = useCallback(async () => {
    try { await fetch("/api/clear", { method: "POST" }); } catch {}
    stateRef.current = initialState();
    pinnedRef.current.clear();
    measuredRef.current.clear();
    positionsRef.current.clear();
    lastLayoutSigRef.current = "";
    clearStoredLayout();
    setRemovedNodes(new Set());
    setLastRemoval(null);
    try { window.localStorage.removeItem(REMOVED_NODES_KEY); } catch { /* disabled storage */ }
    clearSelection();
    rerender();
  }, [rerender, clearSelection]);

  const removeNode = useCallback((id: string) => {
    const agent = stateRef.current.agents.get(id);
    if (!agent) return;
    setRemovedNodes(previous => {
      const next = new Set(previous);
      next.add(id);
      saveRemovedNodes(window.localStorage, next);
      return next;
    });
    setLastRemoval({ id, label: agent.label });
    pinnedRef.current.delete(id);
    positionsRef.current.delete(id);
    clearSelection();
  }, [clearSelection]);

  const removeSelectedNode = useCallback(() => {
    if (primarySelectedId) removeNode(primarySelectedId);
  }, [primarySelectedId, removeNode]);

  // Said for as long as the card is still off the board: one that came back
  // through the session list or by starting to wait has nothing left to say.
  const removalNotice = lastRemoval && removedNodes.has(lastRemoval.id) ? lastRemoval : null;
  // The button that was pressed sat in the detail panel, which unmounts with
  // the selection, so focus would otherwise fall to <body> and a keyboard user
  // would start again from the top. <main> takes focus without taking the
  // single-key shortcuts (#367).
  useEffect(() => {
    if (lastRemoval) canvasRef.current?.focus();
  }, [lastRemoval]);

  const bringBack = useCallback((ids: Iterable<string>) => {
    const list = [...ids];
    setRemovedNodes(previous => {
      const next = withoutRemovals(previous, list);
      if (next !== previous) saveRemovedNodes(window.localStorage, next);
      return next;
    });
  }, []);

  // The keydown listener below is registered once and must stay that way, so
  // the gate reads what is on screen through refs rather than closing over it.
  // Assigned during render, the way nodesRef is, so a keystroke in the same
  // commit sees the dialogs that were just drawn.
  const clearConfirmOpenRef = useMirroredRef(clearConfirmOpen);
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
    || summaryFor != null || browserWatchOpen || keyHelpOpen || releaseNotes != null;

  /** The single door to Clear. Both the toolbar button and the "c" shortcut
   *  come through here, so the confirmation cannot hold for one and not the
   *  other, and only the dialog's own button reaches handleClear. */
  const requestClear = useCallback((source: ClearSource) => {
    const action = clearActionFor(source, {
      confirmOpen: clearConfirmOpenRef.current,
      modalOpen: modalOpenRef.current,
    });
    if (action === "confirm") setClearConfirmOpen(true);
    else if (action === "clear") { setClearConfirmOpen(false); handleClear(); }
  }, [handleClear]);

  // The three handlers of a drag on the canvas — a card, or a whole session
  // by its box — and what they leave behind: see use-node-drag.ts.
  const { onNodeDragStart, onNodeDrag, onNodeDragStop } = useNodeDrag({
    nodes, stateRef, pinnedRef, positionsRef, draggingRef, dragPatchRef,
    setDragging, setDragMoveTick, setDragTick, endBubble, markInteract, disableAutoFit,
    beginTrashDrag, trackTrashDrag, endTrashDrag, removeNode,
  });

  // Same anchoring as relayout — F and the fit button land where it does.
  const handleFit = useCallback(() => fitLeft(500), [fitLeft]);

  // `nodes` is rebuilt by the snapshotToFlow memo on every 250ms tick, so a
  // callback that closes over it is a new function four times a second — and
  // the keydown effect below, which lists that callback in its deps, would
  // unsubscribe and resubscribe the window listener at the same rate. Read
  // both the node array and the current selection through refs (the pattern
  // stateRef already uses) so stepAgent is created once and the listener is
  // registered once. Assigned during render so a keystroke in the same commit
  // sees the array that was just drawn.
  const nodesRef = useMirroredRef(nodes);

  // Bringing a card and its session into view, and stepping between cards —
  // use-agent-focus.ts.
  const { focusAgent, stepAgent, focusSession } = useAgentFocus({
    canvasRef, stateRef, measuredRef, nodesRef, railInsetRef, moveCamera, disableAutoFit,
    lastFocusRef, focusAgentRef, selectAgent, primarySelectedIdRef,
  });


  // What the peek reads, made once — use-peek-readers.ts.
  const { peekAgent, peekLabel, peekRecap, peekBounds } = usePeekReaders({ nodesRef, stateRef, canvasRef, railInsetRef });
  // Delete reaches the removal through a ref for the same reason: the handler
  // below is registered once, and the callback moves with the selection.
  const removeSelectedRef = useMirroredRef(removeSelectedNode);

  /** The blocked session W went to last (#825), so the next press moves on to
   *  the one after it. The waiting button writes it too: the two are one way in. */
  const waitingCursorRef = useRef<string | null>(null);

  // A session list row for a removed session brings it back as it focuses it:
  // selecting a card that is not drawn would open a panel for nothing.
  const openSession = useCallback((sessionId: string) => {
    if (removedAgentIds.has(sessionId)) bringBack([sessionId]);
    focusSession(sessionId);
  }, [removedAgentIds, bringBack, focusSession]);

  // Which element a POINTER put focus on, so a button the mouse pressed stops
  // swallowing the single-key shortcuts (#851): see use-pointer-focus.ts.
  const pointerFocusRef = usePointerFocus();

  // Every key the deck answers, and what each one reaches: see
  // use-deck-shortcuts.ts, whose parameter list is that list.
  useDeckShortcuts({
    // What the keys read.
    pointerFocusRef, nodesRef, stateRef, primarySelectedIdRef, providersRef, soundOnRef,
    keyHelpOpenRef, modalOpenRef, waitingCursorRef, removeSelectedRef, activateSoundRef,
    // What the keys do.
    clearSelection, selectAgent, focusAgent, stepAgent, focusSession, requestClear,
    handleRelayout, handleFit, togglePause, toggleSessionList, toggleAccountsPanel,
    setDetailOpen, setUsageHistoryOpen, setUsagePanelOpen, setMachinePanelOpen,
    setBrowserWatchOpen, setSoundMenuOpen, setKeyHelpOpen, setTheme,
  });

  /** Not a topbar readout any more — the "agents" counter went with the
   *  sessions and events ones. This is the emptiness test: zero agents is what
   *  puts the hero on the canvas and the "nothing selected" copy in the detail
   *  rail, and it is the number ClearConfirm counts to say what clearing
   *  destroys. */
  const agentCount = stateRef.current.agents.size;
  /** The two numbers the topbar chip and the tab strip are driven from —
   *  sessions blocked on a human, longest-blocked first, and sessions with an
   *  agent still moving. Both are recomputed from the agents map on every frame
   *  rather than kept as a tally, because the map is the thing that forgets;
   *  ambient-counts.ts holds that reasoning along with why only a `permission`
   *  block is an alarm.
   *
   *  In a module rather than inline here because a rule that is spelled out
   *  inside a React component is a rule a bare-node suite cannot call, and what
   *  cannot be called gets copied instead. It was, twice, and #348 reached the
   *  original and not the copies — so the suite spent thirty releases asserting
   *  the superseded counting as correct (#377). The tests now import these two
   *  functions, which is what makes a change to the rule a failing test rather
   *  than a passing one. */
  const waitingSessions = useMemo(
    () => blockedSessions(stateRef.current.agents.values()),
    [stateRef.current, stateRef.current.revision],
  );
  // Brought back rather than filtered out: see sessionsCalledBack. Filtering
  // would leave the alarm counting one fewer than the sessions actually stuck.
  // A removed card that goes back to work is brought back the same way, and
  // through the same bringBack, so the restore is saved and a reload does not
  // hide it again (#1315): see removalsLiftedByWork, and removalTimes for when
  // its work starts to count.
  const removedSinceRef = useRef<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    removedSinceRef.current = removalTimes(removedSinceRef.current, removedNodes, Date.now());
    const back = [
      ...sessionsCalledBack(waitingSessions, removedAgentIds),
      ...removalsLiftedByWork(stateRef.current.agents, removedAgentIds, removedNodes, removedSinceRef.current),
    ];
    if (back.length > 0) bringBack(back);
  }, [waitingSessions, removedAgentIds, removedNodes, bringBack]);
  const runningSessions = useMemo(
    () => runningSessionCount(stateRef.current.agents.values()),
    [stateRef.current, stateRef.current.revision],
  );
  // The tab strip — the only surface of this deck that is on screen while the
  // deck is not. The rule lives in ambient.ts, where it can be tested; this is
  // the DOM write the rule is not allowed to own.
  //
  // Comparing before writing is not defensive tidiness. This runs on the SSE
  // path and `running` churns under a title that is standing still: every
  // subagent that spawns or finishes moves it while the tab still says plain
  // ccdeck and still wears the blue mark. Assigning `document.title` rewrites
  // the <title> node and hands the browser a fresh tab label whether or not the
  // string changed, and a fresh icon href is a data URI to parse and rasterise
  // again. Both cost nothing on the frames where nothing moved, which is nearly
  // all of them.
  const ambientRef = useRef<AmbientSignal | null>(null);
  useEffect(() => {
    const next = ambientSignal({ waiting: waitingSessions.length, running: runningSessions, connected: live });
    const prev = ambientRef.current;
    ambientRef.current = next;
    if (prev?.title !== next.title) document.title = next.title;
    if (prev?.icon !== next.icon) {
      // Mutating href on the existing <link>, not swapping the node. Chrome,
      // Firefox and Safari all re-read the attribute; the replace-the-whole-
      // element dance is a workaround for browsers none of them still are, and
      // it costs a fresh parse of the data URI every time. If some browser in
      // the matrix is ever found ignoring this, THAT is the moment to adopt the
      // heavier version — not before.
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link) link.href = FAVICON_HREF[next.icon];
    }
  }, [waitingSessions.length, runningSessions, live]);
  // Said aloud for a screen reader: that a session is waiting on you, and that
  // Browser Watch has something unread — in use-live-announcements.ts.
  const { blockedSaid, watchSaid, setWatchSaid } = useLiveAnnouncements({ waitingSessions, watchUnseen });

  // OS notifications for a session that is waiting on you: the permission, the
  // switch, asking for it, and what has already been raised — in
  // use-os-notifications.ts. It is fed the same waiting set the sidebar draws.
  const { notifyPermission, notifySaid, notifyOn, notifyVetoed, toggleNotify,
          notifySupported, askForNotifications, loadNotifyPrefs }
    = useOsNotifications({ waitingSessions, liveSince, focusSession });
  // One read of the deck's server-side prefs answers two switches, and each
  // hook is handed its half: auto-update to loadAutoRestartPrefs, notifications
  // to loadNotifyPrefs. Split, it would be two requests for one answer.
  useEffect(() => {
    let alive = true;
    fetch("/api/prefs").then(r => (r.ok ? r.json() : null)).then(d => {
      if (!alive || !d?.ok) return;
      loadAutoRestartPrefs(d);
      loadNotifyPrefs(d);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <div className="app">
      {/* The deck's regions, and why each one is the element it is (#381).
          Before this the whole page was <div>s apart from the topbar, so a
          screen reader's landmark rotor listed one entry — Banner — for an
          application with five regions, and there was no way to move between
          them except Tab.
          Four landmarks, each of which is a region a reader would actually
          jump to: the topbar is the banner it already was, the canvas is
          <main> because it is this page's subject and everything else on
          screen is beside it, and the three panels are <aside>s because each
          one is commentary on the canvas that comes and goes without changing
          what the canvas shows. None of them is invented for the rotor's sake:
          the two that were already <aside> — the session list and the detail
          panel — are unchanged in shape here and only gained the name one of
          them was missing.
          Deliberately NOT added: a <nav>, because this deck has no navigation
          — the session list moves the camera, it does not move the user
          between documents — and a role="search" around the filter box, which
          would be a landmark wrapped around a single input that the rotor
          already lists under Form Controls by its own aria-label. A landmark
          list padded with regions nobody would navigate to is the same defect
          as no landmarks at all, one direction over.
          The panels are conditional (#402 made the accounts one conditional on
          Claude Code being installed at all), so the rotor's contents change
          with what is open. That is correct: an <aside> that is not rendered
          is not a region that is empty, and the toggles that mount them
          already carry aria-expanded. */}
      {/* First in the DOM so it is the first Tab of the page, and out of flow
          so it is not a grid item — .app auto-places its children, and a link
          that took a cell would push the topbar into row 2.
          It exists because there are ~166 focusable controls between the top
          of the document and the canvas once the panels are open, and until
          now a keyboard user had to walk every one of them to reach the thing
          the deck is for. WCAG 2.4.1. The target is <main> rather than the
          first card: cards come and go with the sessions, main is always
          there, and landing on it puts the deck's own single-key shortcuts
          back in play (ownsKeystroke() leaves a <main> alone). */}
      <a className="skip-link" href="#canvas">Skip to the canvas</a>
      <header className="topbar">
        {/* Three groups now, not two, and this is the observation one.
            The bar used to be a brand and one flat run of eight controls with
            the readout strip wedged in front of them, and the only thing
            marking the seam between "what is happening" and "what I can do to
            it" was `.status { margin-right: 6px }` — 14px against the 8px
            between two buttons. A 1.75x step under 16px does not read as a
            group boundary, while a real 1px rule was drawn between the two
            money readouts that used to close the strip. So the bar said the
            break between two numbers was larger than the break between the
            last number and the first control, which is exactly backwards. The
            dividers were never the defect; the large boundary having no mark at
            all was. Both dividers and both readouts have since gone, and the
            24px between the groups is what is left doing the work.
            LEFT, not centred. A centred group's x-position is a function of
            both neighbours' widths, so the `live` pill would slide sideways
            every time something after it gained a digit — and a status light
            that has to be noticed cannot be a moving target. Everything ahead
            of it here (the logo, the wordmark, the version chip) has bounded
            width, so on the left it is an anchor instead. */}
        <div className="readout">
          <div className="brand">
            <span className="logo" />
            {/* The page's <h1>, and the wordmark that was already here rather
                than a second copy of it hidden off screen (#381). The document
                had no h1 at all, so its heading outline began at h3 and every
                level below was a skip.
                A visually-hidden heading was the other option and is the wrong
                one HERE: the name it would carry is the word printed two pixels
                to the right of it, so a screen reader would hear "ccdeck,
                heading level 1" and then "ccdeck" again from the wordmark. A
                hidden heading earns its keep when a region has no visible title;
                this region has one, and marking up what is already on the page
                is what 1.3.1 asks for. It is also the same string as the
                document's <title>, from the same constant, so the tab, the
                wordmark and the outline cannot drift.
                The version chip stays a sibling and not a child: it is a button
                whose accessible name is a whole sentence about npm, and inside
                the heading that sentence would become part of the heading's
                name. */}
            <h1>{PRODUCT}</h1>
            {/* The version chip, and what clicking it does: see VersionChip. */}
            <VersionChip
              readyAppUpdate={readyAppUpdate} notice={notice} noticeOpen={noticeOpen}
              version={version} chipVersion={chipVersion} versionChecking={versionChecking} now={now}
              openReleaseNotes={openReleaseNotes} showNotice={showNotice} loadVersion={loadVersion}
            />
          </div>
          {/* NOT a live region, and #372 is the issue that took the
              `role="status"` off it. Nothing in this strip is a status
              *message*: it is a permanently visible readout the user can read
              whenever they want one, and every number in it still moves on its
              own — tokens climbs on every event carrying usage, and the cost
              label reprices its `$/h` rate on each frame while something is
              live. `role="status"` also carries an implicit
              `aria-atomic="true"`, so what a screen reader actually did with
              each of those increments was re-read the WHOLE strip rather than
              the one number that moved. That is a property of the role, not of
              how many numbers are in the row: it held when the row also carried
              the sessions, agents and events counters, and it holds now that
              they are gone. Continuous speech of numbers nobody asked for is how
              a page teaches its user to turn the screen reader off, and it was
              being spent on the least urgent thing in the topbar.
              WCAG 4.1.3 was satisfied here — for the wrong content. The alarm
              that is worth a live region has one of its own, below. */}
          <StatusStrip
            live={live} paused={paused} pauseGate={pauseGate}
            monthUsageRef={monthUsageRef} monthlyUsage={monthlyUsage} monthlyUsageUnavailable={monthlyUsageUnavailable}
          />
          {/* The deck's one alarm, said out loud — and the only live region in
              the topbar (#372).
              MOUNTED UNCONDITIONALLY, which is the half that looks redundant and
              is not. A screen reader registers a live region when the region
              enters the accessibility tree, and text that arrives in the same
              tick as the region itself is routinely never announced at all. The
              chip below is mounted only while something is blocked, so wrapping
              THAT in a role="status" would have put the region and its first
              words on screen together — the one announcement that matters, on
              the one delivery screen readers are least reliable about. It would
              also have taken the region away again with the chip, leaving
              nowhere to say the block had cleared. So the region is always here
              and only its text moves.
              POLITE, not assertive, and that was a decision rather than a
              default. `role="alert"` interrupts whatever is being spoken, which
              buys at most the length of one utterance — and a blocked session
              waits indefinitely, so nothing is lost by arriving a sentence
              later. What assertive would cost is concrete: a deck reloaded while
              a session is already blocked replays that block during mount, and
              an assertive region firing there talks over the screen reader's own
              announcement of the page the user just opened. The connection
              banner keeps role="alert" because its failure is the other kind —
              once the stream is dead every number on this page is stale and the
              deck is quietly lying, so a deferred announcement is a user acting
              on dead data.
              role="status" carries an implicit aria-atomic="true"; it is written
              out because this sentence only means anything whole, and because a
              partial reading of it is exactly the failure the strip above was
              guilty of. */}
          <div className="vis-hidden" role="status" aria-atomic="true">{blockedSaid}</div>
          <div className="vis-hidden" role="status" aria-atomic="true">{watchSaid}</div>
          {/* Outside the .status strip and inside .readout, which are two
              separate placements and only one of them still has the reason it
              was given.
              The half that expired: "a control has no business inside a live
              region". .status was one when this was written and #372 took the
              role off it, so that argument has had nothing to point at for a
              while. The half that still does the work is the one about the
              strip itself — .status is a run of readouts about what is
              happening, and a button dropped into it would report a group
              boundary where there is only a change of element. Its group is
              the readout, because what it reports is
              observation; its element is a button, because the number is the
              only one in the bar the user is meant to act on. Click goes to the
              session that has been stuck longest, which is both the one the
              deck was left open for and the one the region above names.
              It says nothing when nothing is blocked, and it never speaks for
              Codex: those sessions emit no notification, so counting them would
              turn "we have no signal" into "they are fine". It carries no live
              region of its own; the div above is where the speaking happens,
              for the mounting reason given there. */}
          {waitingSessions.length > 0 && (
            <WaitingStat waitingSessions={waitingSessions} waitingCursorRef={waitingCursorRef} focusSession={focusSession} now={now} />
          )}
          {/* The ask, and it lives HERE rather than in a settings panel.
              Every browser requires a user gesture to raise the permission
              prompt, so this button is not decoration — without it the feature
              cannot be switched on at all. Putting it beside the blocked count
              means it appears in the one moment its value is obvious (a session
              is stuck and you can see it), and `canAsk` takes it away for good
              once the question has been answered either way: "granted" needs no
              button, and "denied" cannot be re-asked — requestPermission()
              resolves denied again without showing anything, so a button that
              kept offering would silently do nothing. That is the failure
              browser-react.mjs refuses to ship for its own reactions, and it is
              not worth shipping here. After a refusal the switch is in the
              browser's site settings, which the title says in words. */}
          {/* THE ASK IS NOT IN THE TOPBAR ANY MORE. It was here because a browser
              raises its permission prompt only on a user gesture, so a button
              somewhere is not optional — but there are two others already, and
              both are better placed: turning the notify switch on in the sound
              menu raises the prompt itself, and that menu's `Browser
              notifications / Enable` is the way back from a prompt somebody
              dismissed. A third door, in the topbar, beside a count of blocked
              sessions, was a dashed outline asking for a permission next to a
              number about work. */}
          {/* What the browser answered, said once and then gone.
              Pressing a button and watching it disappear looks the same whether
              it worked or was refused, and only one of those is true — a user
              who was refused walks away believing they switched something on.
              So the grant gets a short acknowledgement and the refusal gets a
              longer one carrying the only thing that can be done about it,
              which is a switch in the browser's own site settings that no page
              is allowed to touch. `role="status"` rather than an alert: this is
              the outcome of something they just did, not an interruption. */}
          {notifySaid && <NotifySaid notifySaid={notifySaid} />}
        </div>
        {selected && (
          <SelectedRibbon selected={selected} now={now} selectedIds={selectedIds} focusAgent={focusAgent} clearSelection={clearSelection} />
        )}
        <div className="actions">
          {/* Three runs, 4px inside and 12px between, and the settings run a
              further 12px out, so it stands at the 24px that separates this
              whole group from the readout: control to control, run to run,
              role to role. Spacing only, no rules drawn between them.
              The first two runs open things: your sessions and what they
              spend (Session list, Usage and its History), then who spends it,
              on what, and what it watched (Accounts, Machine, Browser watch).
              The third changes how the deck behaves: Sound and the theme.
              Sound left the panels as a setting written to disk rather than a
              panel that opens, and it stays with the theme now that its click
              opens a menu, because the menu is still about that one setting.
              Re-layout, Clear and now Pause are gone from here entirely. All
              three are canvas verbs and they are on the canvas, in the React
              Flow control stack beside Recenter — the same place `F` already
              had no topbar button of its own. Pause was held back a release
              because it carried a count no glyph can print; the pill at the
              other end of this bar carries it instead, which is what let the
              last text button in the row go.
              Two runs now, so the 18px between them draws one seam rather than
              two. Nothing else in the bar moved: `.actions` is `flex: none` on
              a `space-between` header, so the icon runs were pinned to the
              right edge before and are pinned there still — what the removal
              gives back is width in the middle, where the selected-agent ribbon
              and the readouts share it. */}
          <SessionRun
            sessionListOpen={sessionListOpen} toggleSessionList={toggleSessionList}
            usagePanelOpen={usagePanelOpen} setUsagePanelOpen={setUsagePanelOpen}
            setUsageHistoryOpen={setUsageHistoryOpen}
          />
          <SourceRun
            providers={providers} accountsPanelOpen={accountsPanelOpen} toggleAccountsPanel={toggleAccountsPanel}
            machinePanelOpen={machinePanelOpen} setMachinePanelOpen={setMachinePanelOpen}
            watchOn={watchOn} watchUnseen={watchUnseen} setBrowserWatchOpen={setBrowserWatchOpen}
          />
          <div className="action-run action-run-utility">
            {/* The settings run. Sound was the one genuine aria-pressed in this
                bar: it installs or removes a Stop hook on disk, a setting that
                is on or off. Since #711 the click opens a menu instead, and the
                pressed state went with the switch into that menu; the button is
                a disclosure now and reports the setting in its name.

                Gone without Claude Code, by the same rule the accounts button
                in the run above states: this switch is one entry in Claude Code's
                settings.json, so on a machine that has no Claude Code it is a
                control whose only effect is to write a hook nothing will ever
                execute. Where Claude Code IS here it stays, and the tooltip says
                which turns it covers — see finishSoundTitle, which also records
                the two ways of making Codex audible that were considered and why
                neither is this fix (#394). */}
            {providers.claude && soundOn !== null && (
            <div className="sound-slot">
              <button
                ref={soundButtonRef}
                className="btn icon-btn"
                /* #711: this used to toggle, and the click is now a disclosure.
                   The gesture that was lost is put back rather than dropped —
                   M still toggles from anywhere, and the menu carries the
                   switch so a mouse has both routes. What made the change worth
                   it is that the menu is no longer one number: it is a switch,
                   two volumes, two sound choices and two previews, which is a
                   panel's worth of controls about one subject.
                   Shift used to restore the user's own parked hooks. #704
                   removed the mechanism that parked them, so the modifier means
                   nothing and is not read here.
                   The handler is a callback rather than spelled out inline for
                   TAG_BUDGET in tsx-scan.ts, which is measured against this
                   tag. */
                onClick={() => setSoundMenuOpen(o => !o)}
                /* #620: this was `disabled={soundBusy}`, and the flag was set
                   before the first await — so the switch went disabled under
                   the press that had just come from it and Chrome dropped
                   focus to `<body>`. #704 removed the request entirely and
                   #711 leaves nothing to be busy for either: opening a menu is
                   synchronous, and the argument is the constant that says so.
                   It matters more now, not less — a disclosure that disables
                   itself takes focus off the very control the menu's Escape is
                   supposed to hand focus back to. */
                {...selfPressProps(false)}
                title={finishSoundTitle(providers, { on: soundOn === true, locked: chimeState === "locked", prefs: tonePrefs })}
                /* The name a screen reader announces: what the press DOES (it
                   opens the settings), then whether sound is on, the same shape
                   Browser watch's name has. The menu's switch changes it, with
                   aria-pressed of its own; the name only reports it, so a
                   reader learns the chimes are off without opening anything,
                   as the icon's waves or cross already tell a sighted one.
                   `title` reaches assistive tech only as a description, which
                   is announced later than the name and by no means everywhere,
                   so nothing a user needs lives only there. */
                aria-label={`Sound settings, ${soundOn ? "on" : "off"}`}
                aria-haspopup="dialog"
                aria-expanded={soundMenuOpen}
                aria-controls={soundMenuOpen ? "sound-menu" : undefined}
              >
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3.2 5.2h2L7.8 3v8L5.2 8.8h-2z" />
                  {soundOn
                    ? <><path d="M9.8 5.4a2.4 2.4 0 0 1 0 3.2" /><path d="M11.3 3.9a4.6 4.6 0 0 1 0 6.2" /></>
                    : <><path d="M10 5.6l2.6 2.8" /><path d="M12.6 5.6L10 8.4" /></>}
                </svg>
                <span className="tb-word">Sound</span>
              </button>
              {soundMenuOpen && (
                <SoundMenu
                  onClose={() => setSoundMenuOpen(false)}
                  soundOn={soundOn === true}
                  onToggleSound={toggleSound}
                  prefs={tonePrefs}
                  onLevel={(chime, level) => changeTone(chime, { level })}
                  onFigure={(chime, figure) => changeTone(chime, { figure })}
                  onPreview={chime => previewTone(chime)}
                  customAssets={customAssets}
                  customSelections={customSelections}
                  onBuiltInSelected={clearCustomOnly}
                  onCustomSelected={selectCustomTone}
                  onImportCustom={importNotificationAudio}
                  onCreateVoice={createNotificationVoice}
                  onRenameCustom={renameCustomAsset}
                  onPreviewCustom={previewCustomAsset}
                  onDeleteCustom={deleteCustomAsset}
                  notifyOn={notifyOn}
                  onToggleNotify={toggleNotify}
                  notifyVetoed={notifyVetoed}
                  notifyPermission={notifySupported ? notifyPermission : "unsupported"}
                  onAskNotify={askForNotifications}
                  openerRef={soundButtonRef}
                />
              )}
            </div>
            )}
            <div className="appearance-slot">
              <button
                ref={appearanceButtonRef}
                className="btn icon-btn"
                onClick={() => {
                  setSoundMenuOpen(false);
                  setAppearanceMenuOpen(open => !open);
                }}
                title="Appearance settings"
                aria-label={`Appearance settings, ${theme} theme, character ${characterEnabled ? "shown" : "hidden"}`}
                aria-haspopup="dialog"
                aria-expanded={appearanceMenuOpen}
                aria-controls={appearanceMenuOpen ? "appearance-menu" : undefined}
              >
              {theme === "dark" ? (
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="7" cy="7" r="2.5" />
                  <path d="M7 1.5v1.2M7 11.3v1.2M1.5 7h1.2M11.3 7h1.2M3.1 3.1l.85.85M10.05 10.05l.85.85M3.1 10.9l.85-.85M10.05 3.95l.85-.85" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M11.8 8.4A5 5 0 1 1 5.6 2.2a4 4 0 0 0 6.2 6.2Z" />
                </svg>
              )}
              </button>
              {appearanceMenuOpen && (
                <AppearanceMenu
                  theme={theme}
                  onTheme={setTheme}
                  characterEnabled={characterEnabled}
                  onToggleCharacter={() => setCharacterEnabled(enabled => !enabled)}
                  fmVolume={fmVolume}
                  onFmVolume={setFmVolume}
                  fmMuted={fmMuted}
                  onFmMuted={() => setFmMuted(muted => !muted)}
                  fmSource={fmSource}
                  onFmSource={pickFmSource}
                  customFmStations={customFmStations}
                  unavailableFmStations={unavailableFmStations}
                  onAddFmStation={addFmStation}
                  onRenameFmStation={renameFmStation}
                  onRemoveFmStation={removeFmStation}
                  onClose={() => setAppearanceMenuOpen(false)}
                />
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Mounted whether or not anything was removed, for the reason the
          topbar's alarm region is (#372): words that arrive with their region
          are the ones screen readers drop. */}
      <div className="vis-hidden" role="status" aria-atomic="true">
        {removalNotice ? `${removalNotice.label} removed from the board.` : ""}
      </div>
      {restartedTo ? (
        // Outranks both: it is the shortest-lived of the three and it answers
        // the question the other two just raised.
        <div className="ver-banner done" role="status">
          <span className="ver-dot" />
          <strong>Restarted — now running v{restartedTo}.</strong>
          <span className="ver-sub">The canvas replayed from the event log.</span>
        </div>
      ) : everConnected && !live ? (
        <ConnectionBanner restarting={restarting} restartMode={restartMode} live={live} paused={paused} />
      ) : noticeOpen && notice ? (
        <VersionBanner
          notice={notice} version={version} dismissNotice={dismissNotice}
          upgradeState={upgradeState} startUpgrade={startUpgrade} copyCommand={copyCommand} cmdCopied={cmdCopied}
          autoRestart={autoRestart} toggleAutoRestart={toggleAutoRestart} askRestart={askRestart}
          restartCopy={restartCopy} restartFuseMs={restartFuseMs} restarting={restarting}
        />
      ) : oldNameOpen && oldName ? (
        // Last of the four, because it is the only one nobody has to act on
        // today: a dropped connection, a restart and a release all outrank a
        // name. It comes back the moment the row above it is dismissed.
        <OldNameBanner oldName={oldName} version={version} dismissOldName={dismissOldName} />
      ) : null}

      {/* Claude-only, and now conditional on Claude Code actually being here.
          Every account in it is a Claude account, the store behind it is
          claude-swap's, and both of its empty states end at `claude auth login`
          — which on a Codex-only machine dead-ends at "the claude CLI could not
          be run: not on PATH". The panel is also open by default, so that was
          the first thing such a user saw. */}
      {isMounted(accountsPhase) && providers.claude && (
        <AccountsPanel leaving={accountsPhase === "leaving"} onClose={closeAccountsPanel} />
      )}

      {sessionListOpen && (
        <SessionList
          state={stateRef.current}
          now={now}
          selectedIds={selectedIds}
          onSelect={openSession}
          onClose={closeSessionList}
          removedIds={removedAgentIds}
          onBringBackAll={() => { bringBack([...removedNodes]); setLastRemoval(null); }}
        />
      )}
      {/* <main>, because the canvas is what this page is: everything else on
          screen — the toolbar above it, the panels beside it — exists to
          describe or steer what is drawn here. One per document, and this is
          the one.
          tabIndex={-1} makes it a focus target for the skip link above without
          adding a tab stop of its own. Focus landing here is also harmless to
          the keyboard rules #367 settled: MAIN is not in shortcuts.ts's
          KEY_OWNING_TAGS and carries no interactive role, so ownsKeystroke()
          returns false and the deck's single-key shortcuts keep working from
          it, and Escape releases it back to the document like any other
          non-typing target.
          What tabIndex={-1} must NOT do is make the canvas a thing the mouse
          focuses, which it also is by default and which lit the skip link's
          ring for every click on empty canvas one keystroke later (#434).
          releasePointerFocus is where that half is taken back, and it has to be
          the capture phase: React Flow stops the pane's mousedown dead before
          it can bubble this far. */}
      <main
        id="canvas"
        tabIndex={-1}
        className={`canvas-wrap${bubbling ? " bubbling" : ""}${dragging ? " dragging-any" : ""}${trashDragging && trashState === "over" ? " trash-hover" : ""}`}
        data-lod={lod}
        ref={canvasRef}
        onMouseDownCapture={releasePointerFocus}
        /* The three that say a human is working this canvas right now. They
           are here, on the canvas as a whole, rather than on the two controls
           that need them, because a handler per control is a list that has to
           be kept complete and #578 is what an incomplete one costs: React
           Flow's own zoom buttons and minimap moved the viewport and nothing
           here noticed. Everything that moves the viewport on a user's
           behalf lives inside this element — the pane, the Controls
           stack, the minimap — so one listener at the top of it covers the
           controls the deck mounts today and the ones it mounts next.
           Capture, for the reason releasePointerFocus above is: React Flow
           calls stopImmediatePropagation() on the pane's press, so a bubbling
           handler here would never see the gesture that matters most.
           Press AND release, because a Controls button only calls zoomIn() on
           the click, which is the release — hold + for two seconds and a
           press-only stamp would have gone stale by the time the zoom lands.
           Not pointermove: see CANVAS_INPUT_WINDOW_MS. */
        onPointerDownCapture={markCanvasInput}
        onPointerUpCapture={markCanvasInput}
        onWheelCapture={markCanvasInput}
        /* The peek is not hover-only. A card the keyboard reaches at a distance
           opens the same card the pointer would — Tab, j/k and W all land focus
           on a card — and closes when focus moves on. Only a focus the browser
           would ring (`:focus-visible`): a click also focuses the card, and a
           peek that opened under every click would cover what was clicked. */
        onFocusCapture={e => {
          const el = e.target as Element;
          if (!isCanvasNodeElement(el) || lodRef.current == null || lodRef.current === "detail") return;
          const id = el.getAttribute("data-id");
          if (id && stateRef.current.agents.has(id) && el.matches(":focus-visible")) showPeek(id, el, "focus");
        }}
        onBlurCapture={e => {
          const id = (e.target as Element).getAttribute?.("data-id");
          if (id) hidePeek(id);
        }}
      >
        {agentCount === 0 && (!live && tabCapped
          ? <TabCapHero />
          : <EmptyHero live={live} everConnected={everConnected} providers={providers} workspace={workspace} onTour={openTour} />)}
        {/* `|| hiddenCats.size > 0` is the half that was missing (#783). The
            bar was gated on categories present on the canvas NOW, while the
            filter is independent state that nothing trims — so hide a category,
            let the canvas turn over (it evicts finished sessions on a timer),
            and the bubbles were suppressed with no chip anywhere to press. Not
            recoverable by Clear either: `hiddenCats` survives it. The only way
            back was a page reload, which a user has no reason to suspect.
            The filter is kept rather than trimmed on eviction, because it is a
            choice the user made and forgetting it silently is the other way to
            be wrong. What must never happen is keeping the choice and taking
            away the control. */}
        {(presentCats.length > 1 || hiddenCats.size > 0) && (
          <CategoryFilterBar
            catBarRef={catBarRef} catBarOccluded={catBarOccluded}
            presentCats={presentCats} hiddenCats={hiddenCats} toggleCat={toggleCat}
          />
        )}
        <ReactFlow
          nodes={allNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          /* EDGES ARE NOT KEYBOARD STOPS. React Flow's store defaults
             `edgesFocusable` to true, and its EdgeWrapper gates on that flag
             alone rather than on `disableKeyboardA11y` below — so every parent
             -> child connector took tabIndex 0, role="button", an aria-label of
             `Edge from ${source} to ${target}`, and a description reading
             "Press enter or space to select an edge. You can then press delete
             to remove it or escape to cancel."

             Subagent ids are `${sessionId}::${agentId}`, so that label was
             about 110 characters of UUID, read out at a stop between every
             parent and child. And every key it named was then swallowed:
             `disableKeyboardA11y` short-circuits EdgeWrapper's onKeyDown, so
             Enter, Space, Delete and Escape on a focused edge all did nothing.

             This is what #853 and #367 fixed for nodes, applied to nodes only.
             The edge keeps role="img" and its label, which is harmless — the
             target node already carries the name. */
          edgesFocusable={false}
          edgeTypes={edgeTypes}
          fitView={!restoredViewport}
          /* The opening frame is React Flow's own, and it goes through the same
             d3 transition every other viewport animation does — so a deck that
             opened its tab behind whatever the user was already looking at drew
             its graph and then left the pane at the identity transform, an
             empty-looking canvas until the tab was brought forward. The library
             re-reads this object into its store on every render and only fits
             once, when the first nodes are measured, so asking for no animation
             while the page is not being rendered takes the branch that applies
             the transform outright. A visible tab still gets the 400ms. */
          fitViewOptions={{
            padding: 0.25,
            duration: shouldAnimateViewport({ durationMs: OPENING_FIT_MS, documentHidden: document.hidden })
              ? OPENING_FIT_MS
              : 0,
          }}
          minZoom={CANVAS_MIN_ZOOM}
          maxZoom={CANVAS_MAX_ZOOM}
          panOnScroll
          nodesDraggable
          nodesConnectable={false}
          selectionOnDrag={false}
          // Without a threshold React Flow begins a drag on pointerdown, so a
          // plain click ran onNodeDragStart/onNodeDragStop at zero delta: it
          // pinned the card — every card of the session, for the group handle —
          // and switched auto-fit off for good. The distance is measured in
          // flow units, so it scales with the zoom; 5 is roughly the slop a
          // mouse, a trackpad or a finger has to beat before the gesture counts
          // as a drag instead of a click.
          nodeDragThreshold={5}
          // React Flow's own keyboard layer told a screen reader, on every card,
          // "use the arrow keys to move the node around. Press delete to remove
          // it" (#853). Neither is true here: the nodes are a controlled prop with
          // no onNodesChange, so its arrow moves and deletes never land, and the
          // deck answers Enter itself (canvas-keys.ts). So the description goes,
          // with the live region that would announce a move that never happens,
          // and Backspace stops being a key React Flow listens for at all.
          disableKeyboardA11y
          deleteKeyCode={null}
          onNodeClick={(e, n) => {
            if (n.type === "sessionGroup") { clearSelection(); return; }
            // A click on a card SELECTS it and GOES TO its session — the frame
            // focusAgent builds, the card and its session at a readable zoom —
            // and leaves the detail panel shut: that is the double-click's, one
            // press further in. Shift+click only widens the selection, as ever.
            // A recap note speaks for its session, so a click on it is a click
            // on the root.
            const id = n.type === "recapNote" ? (n.data as { parentId: string }).parentId : n.id;
            selectAgent(id, e.shiftKey, false);
            if (e.shiftKey) return;
            // AND SHUTS THE PANEL, whether or not it is showing. `detailOpen` is
            // persisted, so every deck that clicked a card under #814 has it
            // stored open — and after a reload nothing is selected, so nothing
            // is SHOWN, and a test of what is on screen let this very click
            // select the card and bring the stored panel up with it. The frame
            // waits a paint only when a panel was really there, for the canvas
            // it gives back, the way the double-click's does for the one it takes.
            if (detailOpen) setDetailOpen(false);
            if (detailShown) {
              window.setTimeout(() => { try { focusAgent(id); } catch {} }, 80);
            } else {
              focusAgent(id);
            }
          }}
          onPaneClick={() => { hidePeek(); clearSelection(); }}
          // The details, one press past the click that went to the session:
          // the panel opens on the card — the prompt, every tool call, tokens
          // and timing — and the frame is built again a paint later, for the
          // canvas the panel has just narrowed. React Flow's own double-click
          // zoom never reaches a card (its filter drops a dblclick inside a
          // draggable node), so nothing else answers here.
          onNodeDoubleClick={(_, n) => {
            if (n.type !== "agent" && n.type !== "recapNote") return;
            const id = n.type === "recapNote" ? (n.data as { parentId: string }).parentId : n.id;
            selectAgent(id, false);
            window.setTimeout(() => { try { focusAgent(id); } catch {} }, 80);
          }}
          // The peek (SessionPeek) is for the distances where the card cannot
          // say it itself. At the detail tier the card is readable and a copy
          // over it would be noise, so it never opens there.
          onNodeMouseEnter={(e, n) => {
            if ((n.type !== "agent" && n.type !== "recapNote") || draggingRef.current) return;
            if (lodRef.current == null || lodRef.current === "detail") return;
            showPeek(n.id, e.currentTarget as Element);
          }}
          onNodeMouseLeave={(_, n) => hidePeek(n.id)}
          onMoveStart={e => {
            // A pan or a zoom moves the tile out from under its peek.
            hidePeek();
            // And supersedes any fit still settling — see cameraEpochRef.
            if (isUserViewportGesture(viewportMove(e))) cameraEpochRef.current += 1;
            // The pane's own gesture, and only ever that: React Flow drops a
            // move with no source event before this callback is reached. Kept
            // alongside onMove because d3-zoom raises `start` on the press and
            // `zoom` only once the transform actually changes, so this is the
            // earlier of the two for a drag that begins on the canvas.
            if (isUserViewportGesture(viewportMove(e))) disableAutoFit();
          }}
          onMove={(e, vp) => {
            markInteract();
            // The signal that cannot lose a gesture. Unlike onMoveStart above,
            // this fires for a viewport moved through the store as well — the
            // minimap's pan and wheel, the Controls' + and −, and whatever the
            // library adds next — all of which arrive with no source event and
            // used to slip past the disable entirely (#578). Which of those is
            // the user and which is a fit the deck asked for is the one
            // question viewport-intent.ts answers.
            if (isUserViewportGesture(viewportMove(e))) disableAutoFit();
            // Debounce viewport persistence — pan/zoom fires many times
            // per gesture, but we only need the final state.
            // The zoom itself first, for the faces' screen-pixel layout and the
            // edges' stroke (styles.css, `data-lod`). Written on the element
            // rather than through state: it changes every frame of a gesture,
            // and the sheet is the only reader.
            canvasRef.current?.style.setProperty("--zoom", String(vp.zoom));
            if (applyZoom(vp.zoom) === "detail") hidePeek();
            if (vpSaveTimerRef.current) window.clearTimeout(vpSaveTimerRef.current);
            vpSaveTimerRef.current = window.setTimeout(() => saveViewport(vp), 250);
          }}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
        >
          <Background gap={28} size={1} color={palette["--grid-line"]} />
          {/* The stamp that keeps a click on a session's name from reading as
              the user grabbing the canvas — see the note on the component
              (#785). Same line App's own focusSession runs after its fitView. */}
          <SessionClusters onFocusSession={focusAgent} />
          <ToolBursts
            agents={stateRef.current.agents}
            visibleAgentIds={visibleAgentIds}
            positions={positionsRef.current}
            pinned={pinnedRef.current}
            measured={measuredRef.current}
            spotlight={spotlightSet}
            hiddenCategories={hiddenCats}
            now={now}
            onOpenTool={openTool}
          />
          {/* The state the recenter tint used to be the only sign of (#820).
              While the reader's own pan or zoom holds the view, new sessions
              can land off-screen; this says so on the canvas they would be
              looked for on, with the way back in the same place. */}
          {/* A status and an action, not one big button. The words say what
              the state is and are not a control; Resume is the one thing here
              that can be pressed, and it does what the whole chip used to. */}
          {autoFitDisabled && <AutoFitChip enableAutoFitAndRefit={enableAutoFitAndRefit} />}
          {/* No React Flow fit-view button (#840). Recenter below does the same
              fit and also turns autofit back on, so two near-identical buttons
              sat side by side and the reader had to guess the difference. F
              still fits from the keyboard. */}
          <CanvasControls
            autoFitDisabled={autoFitDisabled} enableAutoFitAndRefit={enableAutoFitAndRefit}
            paused={paused} pauseGate={pauseGate} togglePause={togglePause}
            handleRelayout={handleRelayout} requestClear={requestClear} setKeyHelpOpen={setKeyHelpOpen}
          />
          <MiniMap
            zoomable
            pannable
            nodeColor={minimapNodeFill}
            nodeStrokeWidth={2}
            maskColor={palette["--minimap-mask"]}
            // The frame the view is showing, outlined. The minimap's surface
            // sits close to the canvas now (.react-flow__minimap), so the mask
            // alone no longer separates it well; a --line keyline does, in
            // the same neutral the chrome's edges are drawn in.
            maskStrokeColor={palette["--line"]}
          />
          {/* Above the minimap, and absent unless there is something to play —
              ClaudeFm renders null until the server says the channel is on air,
              so on a deck with no network this is nothing at all. */}
          {characterEnabled && (
            <ClaudeFm
              volume={fmVolume}
              muted={fmMuted}
              source={fmSource}
              playRequest={fmPlayRequest}
              customStation={customFmStations.find(station => customFmSelection(station.id) === fmSource)}
              onAvailabilityChange={markFmStationAvailability}
            />
          )}
        </ReactFlow>
        {isMounted(trashPhase) && (
          <DragTrashZone trashZoneRef={trashZoneRef} trashState={trashState} trashPhase={trashPhase} trashLabel={trashLabel} />
        )}
        <SessionPeek
          agentFor={peekAgent}
          recapFor={peekRecap}
          labelFor={peekLabel}
          bounds={peekBounds}
        />
      </main>

      {/* THE RIGHT-HAND RAILS COME AFTER THE CANVAS (#880). Both are position:
          fixed, so where they sit in the DOM changes nothing on screen — only
          where Tab goes. Rendered ahead of the left column, as they used to be,
          they sent a keyboard reader's focus topbar, right, left, right, centre;
          here it reads the way the page does: the left column, the canvas,
          these two, then the detail panel at the far right. */}
      {isMounted(usagePhase) && (
        <UsagePanel
          state={stateRef.current}
          now={now}
          providers={providers}
          liveSince={liveSince}
          leaving={usagePhase === "leaving"}
          onClose={() => setUsagePanelOpen(false)}
        />
      )}

      {/* Mounted only while it is open, which is also what starts its poll: the
          topbar meter used to keep /api/system running for the life of the tab
          on behalf of a readout that is gone. `usageOpen` moves it one rail
          slot left when usage has the first one — see .sysdetail.shifted. */}
      {isMounted(machinePhase) && (
        <MachinePanel usageOpen={usagePanelOpen} leaving={machinePhase === "leaving"}
          onClose={() => setMachinePanelOpen(false)} />
      )}

      {/* NOTHING SELECTED, NO PANEL. It used to draw an `EmptyDetail` — a title,
          "Click an agent to see its tools", and a fifteen-row shortcut list —
          which is a 360px column of the canvas spent on a sentence and a copy
          of a reference that already has a complete version behind `?`. The
          panel is about an agent; with no agent there is nothing for it to be
          about, and the canvas gets the width back.
          `:not(:has(.detail))` in the sheet already drops the column, so this
          needed no layout change of its own. */}
      {detailOpen && selected ? (
        // Already the right element and still an unnamed one: the rotor listed
        // it as a bare "complementary" beside the session list's "Sessions",
        // which is the entry a reader cannot tell from the next. The name is
        // fixed rather than the selected agent's label — the panel keeps its
        // identity when nothing is selected, and a landmark whose name changes
        // under the reader is a landmark they cannot come back to. The agent's
        // name is the panel's <h2>, which is where a changing title belongs.
        <aside className="detail" aria-label="Detail">
          <button
            type="button"
            className="glyph-btn detail-close"
            title="Close panel"
            aria-label="Close detail panel"
            onClick={() => setDetailOpen(false)}
          >×</button>
          <Detail
                agent={selected}
                now={now}
                onOpenTool={openTool}
                onShowSummary={setSummaryFor}
                onExportSession={(sid) => exportSessionJson(stateRef.current, sid)}
                onRemove={removeSelectedNode}
              />
        </aside>
      ) : null}

      {openedTool && <ToolModal tool={openedTool} onClose={() => setOpenedToolKey(null)} />}
      {/* `providers` is what the modal's subtitle falls back to until a ccusage
          run has said whose logs are actually in the figures (#431). It is not
          a gate: ccusage reads the logs on this machine rather than this deck's
          flags, so a deck started with --no-codex can still be shown Codex
          spend, and the subtitle follows the data when there is any. */}
      {usageHistoryOpen && (
        <Suspense fallback={null}>
          <UsageHistoryModal providers={providers} onClose={() => setUsageHistoryOpen(false)} />
        </Suspense>
      )}
      {browserWatchOpen && (
        <Suspense fallback={null}>
        <BrowserWatchModal
          onClose={() => setBrowserWatchOpen(false)}
          onSeen={ms => {
            // The reader has just looked, so the count falling to nothing is
            // their own doing and not news: the region goes back to the silence
            // it starts in rather than telling them "no unread findings" about
            // the list they were reading. Only the reducer's all-clear is
            // skipped — the next finding still speaks, because "" is the state
            // a first announcement is made from.
            setWatchSaid("");
            markWatchSeen(ms);
          }}
          /* The switch lives in the dialog and the eye lives up here, reading a
             five-minute poll. Without this the eye stays lit for up to five
             minutes after the watch is turned off — the one control whose whole
             job is to be true at a glance, lying. */
          onWatching={setWatchOn}
          palette={palette}
        />
        </Suspense>
      )}
      {contextFor && (() => {
        const root = stateRef.current.agents.get(contextFor);
        if (!root) return null;
        return <ContextModal agent={root} onClose={() => setContextFor(null)} />;
      })()}
      {summaryFor && (
        <SessionSummary
          state={stateRef.current}
          sessionId={summaryFor}
          onClose={() => setSummaryFor(null)}
        />
      )}
      {/* Ahead of the shortcuts sheet and the clear prompt, which is where a
          dialog that arrives on its own belongs: it must not paint over the one
          waiting for an answer, and the stack in modal-dismiss.ts settles Esc
          the same way round. */}
      {releaseNotes && (
        <ReleaseNotesModal
          entries={releaseNotes.entries}
          since={releaseNotes.since}
          /* Both are null-on-a-browse, and they are not the same thing: a first
             run is the deck announcing one release to somebody who has never
             seen any of them, and its first line has to say so (#717). */
          firstRun={releaseNotes.firstRun}
          /* The same number the chip wears, and defaulted the same way, so the
             dialog's first line and the chip that opened it cannot disagree
             about which release the reader is on. */
          running={chipVersion}
          onClose={closeReleaseNotes}
          onTour={() => { closeReleaseNotes(); openTour(); }}
          updateVersion={readyAppUpdate?.version}
          updateBusy={desktopUpdateRestarting}
          /* Said until the next press. A failure for a version the app has
             since replaced is about nothing that is on offer any more, so it
             goes when a different one is ready. */
          updateFailure={desktopUpdateFailure
            && (!readyAppUpdate || readyAppUpdate.version === desktopUpdateFailure.version)
            ? updateRestartFailureText(desktopUpdateFailure.failure, desktopUpdateFailure.version)
            : undefined}
          onUpdateRestart={readyAppUpdate ? () => { void askDesktopUpdateRestart(readyAppUpdate.version); } : undefined}
          /* Only where the server would do it: an unsupervised deck answers
             501 and one without a writable log 409, and the button is not
             offered for either (#1163). */
          onRestart={!readyAppUpdate && version?.canRestart ? () => { closeReleaseNotes(); void askRestart(); } : undefined}
        />
      )}
      {/* After the release notes and before the clear prompt. Both of those
          also arrive without being asked for, and the order between them is
          the order of what they want: a question that is holding another
          machine up outranks an announcement about this one, and neither
          outranks the prompt somebody is standing in front of deciding
          whether to truncate a log. */}
      {(() => {
        const { request, waiting } = nextRequest(lanPending, lanDeferred.current);
        if (!request) return null;
        return (
          <LanPairRequestModal
            request={request}
            waiting={waiting}
            busy={lanBusy}
            now={Date.now()}
            onAccept={() => void answerLanPair("accept", request.fp)}
            onDecline={() => void answerLanPair("dismiss", request.fp)}
            onLater={() => deferLanPair(request.fp)}
          />
        );
      })()}
      {/* Before the clear prompt and after everything else, which is where a
          reference belongs: it may paint over a tool inspector somebody opened
          the sheet on top of, and it must not paint over the one dialog that is
          waiting for an answer. Escape agrees with the paint order — the prompt
          carries CONFIRM_LAYER and the stack in modal-dismiss.ts resolves layer
          before arrival. */}
      {keyHelpOpen && <KeyboardHelp onClose={() => setKeyHelpOpen(false)} onTour={() => { setKeyHelpOpen(false); openTour(); }} />}
      {tourOpen && (
        <GuideModal title="What the deck shows you" steps={WELCOME_STEPS} onClose={closeTour} />
      )}
      {/* Last, so it sits above a session summary that pops in from a Stop
          hook while the user is still deciding. The gate keeps it from opening
          over a modal, but a modal can still arrive over it. */}
      {clearConfirmOpen && (
        <ClearConfirm
          agentCount={agentCount}
          onConfirm={() => requestClear("confirmation")}
          onCancel={() => setClearConfirmOpen(false)}
        />
      )}
    </div>
  );
}
