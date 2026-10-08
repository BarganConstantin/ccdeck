import { useCallback, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "reactflow";
// Keeps a side panel mounted long enough to animate out — see panel-exit.ts
// for why `{open && <Panel/>}` cannot do that on its own.
import { usePanelPresence, isMounted } from "./panel-exit";
import BoardFlow from "./components/BoardFlow";
import SessionList from "./components/SessionList";
import UsagePanel from "./components/UsagePanel";
import MachinePanel from "./components/MachinePanel";
import AccountsPanel from "./components/AccountsPanel";
import { useDragTrash } from "./use-drag-trash";
import { useBubbleAnimation } from "./use-bubble-animation";
import { useZoomLod } from "./use-zoom-lod";
import { useEventStream } from "./use-event-stream";
import { useSelection } from "./use-selection";
import { useBoardTick } from "./use-board-tick";
import { useAgentFocus } from "./use-agent-focus";
import { usePeekReaders } from "./use-peek-readers";
import { useBoardLayout, useLayoutAutosave } from "./use-board-layout";
import { useReframe } from "./use-reframe";
import { useBoardGraph, useLayoutSig } from "./use-board-graph";
import { useAutoFit } from "./use-auto-fit";
import { useRemovalCallBacks, useRemovals } from "./use-removals";
import { useTabAmbient } from "./use-tab-ambient";
import { useCanvasViewport } from "./use-canvas-viewport";
import { useCanvasClicks } from "./use-canvas-clicks";
import { useCanvasSize } from "./use-canvas-size";
import { useNodeMeasurements, useSettled } from "./use-node-measurements";
import { useLayoutFrame } from "./use-layout-frame";
import { useCamera } from "./use-camera";
import { usePointerFocus } from "./use-pointer-focus";
import { useDeckShortcuts } from "./use-deck-shortcuts";
import { usePanelReturn } from "./use-panel-return";
import { useNodeDrag } from "./use-node-drag";
import { EmptyHero, TabCapHero } from "./components/EmptyHero";
import DetailAside from "./components/DetailAside";
import { EdgeDock, EdgeRail, PHONE_QUERY, UtilityRun } from "./components/EdgeRails";
import { railItems } from "./rail-items";
import { useMediaQuery } from "./use-media-query";
import { ReadoutGroup } from "./components/TopbarReadouts";
import SelectedRibbon from "./components/SelectedRibbon";
import CategoryFilterBar from "./components/CategoryFilterBar";
import CanvasMain from "./components/CanvasMain";
import DeckBanner from "./components/DeckBanner";
import DeckDialogs from "./components/DeckDialogs";
import ErrorBoundary from "./components/ErrorBoundary";
import { usePauseGate } from "./use-pause-gate";
import { useDeckScope } from "./use-deck-scope";
import { useProviderStatus } from "./use-provider-status";
import { incidentsOf } from "./provider-status";
import { useDeckUpgrade } from "./use-deck-upgrade";
import { useBrowserWatchBadge } from "./use-browser-watch-badge";
import { useAppearance } from "./use-appearance";
import { useCategoryFilterBar } from "./use-category-filter-bar";
import { useChimePlayer } from "./use-chime-player";
import { useClaudeFm } from "./use-claude-fm";
import { useDesktopUpdate } from "./use-desktop-update";
import { useAutoRestart } from "./use-auto-restart";
import { useLanPairRequests } from "./use-lan-pair-requests";
import { useAccountAttention } from "./use-account-attention";
import { useLeftColumn } from "./use-left-column";
import { useRightPanels } from "./use-right-panels";
import { useLiveAnnouncements } from "./use-live-announcements";
import { useOsNotifications } from "./use-os-notifications";
import { useMirroredRef } from "./use-mirrored-ref";
import { useDialogs } from "./use-dialogs";
import { useClearFlow } from "./use-clear-flow";
import { useOldNameNotice } from "./use-old-name-notice";
import { useRatingAsk } from "./use-rating-ask";
import { useCustomTones } from "./use-custom-tones";
import { useTonePrefs } from "./use-tone-prefs";
import { usePresenceBeacon } from "./use-presence-beacon";
import { usePrefsRead } from "./use-prefs-read";
import { useVersionCheck } from "./use-version-check";
import { useWelcomeAndNotes } from "./use-welcome-and-notes";
import { useReports } from "./use-reports";
import { blockedSessions } from "./ambient-counts";
import { initialState } from "./reducer";
import { useSoundSwitch } from "./use-sound-switch";
import { useSettingsMenus } from "./use-settings-menus";
import { useAutoFitSwitch } from "./use-auto-fit-switch";
import { createChimePlayer } from "./chime-player";

export default function App() {
  return (
    <ReactFlowProvider>
      {/* The whole deck under one error boundary (#1853): a render error used to
          blank the page to nothing, and now it shows a calm pane with a reload
          and a Send report — see components/ErrorBoundary.tsx. It wraps Inner
          rather than a region of it because the crash we cannot predict is the
          one anywhere below. */}
      <ErrorBoundary>
        <Inner />
      </ErrorBoundary>
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
  const [, force] = useState(0);
  const rerender = useCallback(() => force(x => x + 1), []);
  // The detail, Usage and Machine panels' open flags, each kept in the browser
  // across a refresh — use-right-panels.ts. Called ahead of the selection
  // below, because a plain selection opens the detail panel (#814).
  const { detailOpen, setDetailOpen, usagePanelOpen, setUsagePanelOpen, machinePanelOpen, setMachinePanelOpen }
    = useRightPanels();

  const { selectedIds, primarySelectedId, selectAgent, clearSelection, pruneSelectionToBoard } =
    useSelection(stateRef, setDetailOpen);
  // The left column: the session list and the accounts panel share one slot,
  // and opening one evicts the other (#824). Both panels' state, persistence and
  // the eviction live in use-left-column.ts; only its toggles can open either.
  const { sessionListOpen, accountsPanelOpen, toggleSessionList, toggleAccountsPanel,
          closeSessionList, closeAccountsPanel } = useLeftColumn();
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

  const sound = useSoundSwitch(chimesRef);
  const { activateSoundRef, soundOnRef } = sound;

  // What each tone is set to, how a change is written and auditioned, and the
  // preview timer behind it, live in use-tone-prefs.ts. The chime player reads
  // the settings through `tonePrefsRef` at play time; the custom-sound layer
  // below writes `setTonePrefs` when a clip it points at goes away.
  const tones = useTonePrefs(chimesRef);
  const { setTonePrefs, tonePrefsRef, previewTone } = tones;

  // Custom sounds — the clips somebody imported or recorded, which tone points
  // at which, and every way one is added, renamed, chosen or removed — live in
  // use-custom-tones.ts. It sits on the tone settings above: removing a clip a
  // tone points at resets that tone's figure, which is the one write it makes
  // outside its own state.
  const customTones = useCustomTones({ chimesRef, setTonePrefs, tonePrefsRef, previewTone });
  const { customSelectionsRef, fallbackCustomRef } = customTones;

  // The Settings dialog, and the door into it every way in shares —
  // use-settings-menus.ts.
  const menus = useSettingsMenus();
  const { openSettings } = menus;

  // The player behind the deck's own two tones, built once on mount and woken by
  // the first gesture anywhere — use-chime-player.ts. It reads every setting
  // through a ref at play time, so it never has to be rebuilt.
  useChimePlayer({ chimesRef, soundOnRef, tonePrefsRef, customSelectionsRef, fallbackCustomRef });

  // ── version drift ─────────────────────────────────────────────────────────
  // The stream of hook events from the server, and what it says about the
  // connection, in use-event-stream.ts. Called here, above everything that
  // keys off `live`: the version check, the desktop updater and the scope all
  // re-ask when a restart ends with the stream reconnecting. The pause gate
  // comes first because every envelope passes through it. Pause freezes the
  // canvas; it does not drop the connection. The gate, the mirrored flag and
  // the toggle's eviction accounting live in use-pause-gate.ts, which carries
  // the reasoning.
  const pause = usePauseGate(stateRef);
  const { pauseGate, paused, togglePause } = pause;
  // The desktop app's update frames arrive on the same stream, and the handler
  // for them comes out of useDesktopUpdate below, which itself keys off `live`.
  // Bound once that hook has run; it is a stable callback.
  const desktopUpdateRef = useRef<(data: string) => void>(() => {});
  const { live, tabCapped, everConnected, liveSince } =
    useEventStream({ stateRef, rerender, pauseGate, chimesRef, desktopUpdateRef });
  // The deck's own version check — the banner, the chip and the poll behind
  // them — lives in use-version-check.ts. `live` drives the reconnect refresh.
  const versionCheck = useVersionCheck(live);
  const { version, notice, noticeOpen, loadVersion } = versionCheck;
  // Everything about the desktop app's own updater — its state, the press rule
  // behind Restart to update, and the stream event that releases a press — is in
  // use-desktop-update.ts. `live` drives the read on every (re)connect.
  const desktopUpdate = useDesktopUpdate(live);
  const { readyAppUpdate, onDesktopUpdateEvent } = desktopUpdate;
  desktopUpdateRef.current = onDesktopUpdateEvent;

  // Telling the server somebody is looking at this deck lives in
  // use-presence-beacon.ts. It takes nothing and returns nothing.
  usePresenceBeacon();

  // What changed since you last looked (#712), and the four-picture tour that
  // comes before it the first time: when each one opens, the notes an upgrade
  // holds back until the tour is closed, and the version chip's way back to
  // them. All of it, closing included, is in use-welcome-and-notes.ts.
  const welcome = useWelcomeAndNotes({ version, readyAppUpdate });
  const { tourOpen, openTour, releaseNotes } = welcome;

  // What this deck may see — its workspace scope and which CLIs it watches —
  // comes from /api/health, re-asked on every reconnect, in use-deck-scope.ts.
  const { workspace, providers, providersRef } = useDeckScope(live);

  // The "started under an old npm name" notice lives in use-old-name-notice.ts.
  const oldNameNotice = useOldNameNotice(version);
  // Upgrading the deck from its banner — the press, the faster poll while npm
  // runs, and copying the command for anyone who would rather type it — lives
  // in use-deck-upgrade.ts.
  const upgrade = useDeckUpgrade({ version, loadVersion });
  const { upgradeFailure } = upgrade;

  // The six dialogs the reader opens — the tool, context and recap modals, the
  // shortcuts sheet, Usage history and Browser Watch — what each is open on, and
  // the gate the keys ask before reaching past one: use-dialogs.ts.
  const dialogs = useDialogs({ stateRef, tourOpen, releaseNotes });
  // The one question the deck asks about itself, once, after a week of use.
  const rating = useRatingAsk({ modalOpenRef: dialogs.modalOpenRef });
  const { openTool, setSummaryFor, setContextFor, openContext, setKeyHelpOpen, setUsageHistoryOpen,
          setBrowserWatchOpen, keyHelpOpenRef, modalOpenRef } = dialogs;
  // Usage reports (#1853): whether they are on, and the page's own errors,
  // forwarded while they are: use-reports.ts.
  const reports = useReports();
  // The Browser Watch badge — what it counts, the slow poll behind it, and when
  // the reader last looked — lives in use-browser-watch-badge.ts.
  const watchBadge = useBrowserWatchBadge();
  const { watchOn, watchUnseen } = watchBadge;

  // A LAN pairing request waiting on this deck — the poll that finds one, and
  // the one answer at a time the dialog over the canvas gives — lives in
  // use-lan-pair-requests.ts.
  const lanPairs = useLanPairRequests();

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

  // What the providers' status pages report (#1311): use-provider-status.ts
  // asks, provider-status.ts decides which lines are an incident. Read against
  // the board's clock, so an answer the page is still holding expires on
  // screen even while the deck itself has stopped answering.
  const providerStatus = useProviderStatus(providers.claude || providers.codex);
  const incidents = incidentsOf(providerStatus, now);

  // An account the deck signed in whose login has stopped working, asked about
  // over the canvas (#1893) — from the rosters the accounts panel reads, one
  // read when the deck opens, and what the pairing poll above knows about Local
  // network: use-account-attention.ts. Claude-only, like the panel itself.
  const attention = useAccountAttention({ enabled: providers.claude, lanStatus: lanPairs.lanStatus, now });

  // Restarting the deck: the auto-update switch, the press behind the banner's
  // Restart, the idle stretch an automatic one waits for, and what the banner
  // says about it — in use-auto-restart.ts.
  const restart = useAutoRestart({ now, stateRef, version, notice, noticeOpen, upgradeFailure, paused: pause.paused });
  const { askRestart, loadAutoRestartPrefs } = restart;

  // The deck's look — the theme, the pixel character, and the canvas palette
  // read from the theme's tokens — with the effects that keep the DOM, storage
  // and the window's title bar in step, in use-appearance.ts.
  const appearance = useAppearance();
  const { setTheme, palette } = appearance;
  // Claude FM's configuration — volume, mute, which station, the stations
  // somebody added, and which of them are not answering — with its storage, in
  // use-claude-fm.ts. Stations and the selection change only through its named
  // operations, which keep the two consistent.
  const fm = useClaudeFm();

  // The camera's primitives — the one door every viewport the deck sets goes
  // through, the fit every structural change runs, and the bookkeeping that
  // lets a move tell it has been superseded: see use-camera.ts.
  const camera = useCamera();
  const { applyViewport, moveCamera, fitLeft, cameraEpochRef, lastFitTimeRef } = camera;

  // The board's arrangement — the stored positions and pins it was restored
  // from, the placeholders, the layout signature, the epoch R and the reframe
  // move, and the frame it was packed for — and R itself, in use-board-layout.ts.
  const layout = useBoardLayout(fitLeft);
  const { pinnedRef, positionsRef, lastLayoutSigRef, handleRelayout } = layout;

  /** The card the last focus framed, and when — so a re-pack that lands just
   *  after it (the reframe effect below) can frame it again where it went. */
  const lastFocusRef = useRef<{ id: string; at: number } | null>(null);
  /** focusAgent, for an effect declared above it. */
  const focusAgentRef = useRef<(id: string) => void>(() => {});


  /** The same boundary as a flag, for the layout: positions restored from
   *  storage are only pruned against the agents once all of them are back. */
  const historyReplayed = liveSince !== null;


  const lastInteractRef = useRef(0);
  const markInteract = useCallback(() => { lastInteractRef.current = Date.now(); }, []);
  // How big the canvas is, measured once by one observer and kept two ways:
  // quantised for the layout, whole for the drift watchdog below. See
  // use-canvas-size.ts.
  const { canvasRef, canvasSize, paneSizeRef } = useCanvasSize();
  const autoFit = useAutoFitSwitch(fitLeft);
  const { autoFitDisabledRef, disableAutoFit } = autoFit;

  // True for the length of a drag gesture. A ref as well as state: the
  // measurement effect below reads it without wanting to re-run when it
  // changes, and the layout memo needs the state to recompute.
  const draggingRef = useRef(false);

  // Every card's size, from React Flow's store and from the DOM, with the two
  // counters the layout keys off: see use-node-measurements.ts.
  const { measuredRef, measuredVersionRef, sizeVersion, domSizeVersion } = useNodeMeasurements(draggingRef);

  // What Remove node has taken off the board, the way back, and the sentence
  // that says so — use-removals.ts.
  const { removedNodes, removedAgentIds, removeNode, removeSelectedNode, removalNotice,
          bringBack, bringBackAll, forgetRemovals }
    = useRemovals({ stateRef, pinnedRef, positionsRef, canvasRef, clearSelection, primarySelectedId });
  // What the layout keys off: the visible, not-removed agents and their
  // parents, plus the two size versions — use-board-graph.ts.
  const layoutSig = useLayoutSig({ stateRef, now, removedAgentIds, sizeVersion, domSizeVersion });

  // Stored whenever the arrangement's signature moves — use-board-layout.ts.
  useLayoutAutosave(layoutSig, layout);

  // The two things that bring the board back into view on their own — a
  // layout that changed shape, and a board that drifted off the pane — both
  // stand down while the user has the wheel: use-auto-fit.ts.
  useAutoFit({
    layoutSig, rf, stateRef, measuredRef, pinnedRef, positionsRef, paneSizeRef, lastInteractRef,
    autoFitDisabledRef, lastFitTimeRef, fitLeft,
  });

  // Sizes only mean something once the cards have all mounted and measured —
  // use-node-measurements.ts.
  const settled = useSettled();
  const { bubbling, endBubble, onBubble } = useBubbleAnimation();
  // True for the length of any drag gesture. React Flow marks the node under
  // the cursor with .dragging, and the stylesheet drops its transition — but
  // dragging a SESSION moves its member cards through state rather than
  // through the gesture, so they keep the transition and trail the cursor by
  // its full duration. That is the "dragging isn't smooth" everyone notices
  // and nobody can point at. A flag on the pane covers every node a gesture
  // can move, whichever way it moves them.
  const [dragging, setDragging] = useState(false);
  const trash = useDragTrash();
  const { beginTrashDrag, trackTrashDrag, endTrashDrag } = trash;
  const zoom = useZoomLod({ stateRef, measuredRef, measuredVersionRef, canvasRef });
  const { lodRef, applyZoom } = zoom;
  // The viewport: the one restored from storage, the one stored on every move,
  // and whether a move was the user's or the deck's — use-canvas-viewport.ts.
  const viewport = useCanvasViewport({
    applyViewport, lastFitTimeRef, cameraEpochRef, disableAutoFit, markInteract, canvasRef, applyZoom,
  });

  // The selected agent. Declared this high because the rail measurement below
  // has to know whether the detail panel is MOUNTED, and `detailOpen && selected`
  // is what mounts it — see the `<DetailAside>` near the end of this file
  // (components/DetailAside.tsx). Nothing between here and there reassigns `stateRef.current`
  // during render (the two writes are inside a replay effect and the SSE
  // handler), so reading it here is the same read it was 150 lines further on.
  const selected = primarySelectedId ? stateRef.current.agents.get(primarySelectedId) : null;
  /** Whether `.detail` is in the DOM, which is what the sheet keys the rail's
   *  horizontal position off: `--rail-r` is 368px with it and 8px without
   *  (`.app:not(:has(.detail))`), and `.usage-panel` takes the same 360px step.
   *  Not `detailOpen` on its own — the panel is `detailOpen && selected`, so a
   *  deck with the panel enabled and nothing selected is 360px out. */
  const detailShown = detailOpen && selected != null;
  // Where keyboard focus goes when a panel's own × or ‹ takes it away with the
  // panel: the topbar button that opens it, or the card the detail panel was
  // about — use-panel-return.ts.
  const panelReturn = usePanelReturn({
    sessionListShown: sessionListOpen, usageShown: isMounted(usagePhase), machineShown: isMounted(machinePhase),
    accountsShown: isMounted(accountsPhase) && providers.claude, detailShown, primarySelectedId, canvasRef,
  });

  // What the floating panels cover of the canvas, and the frame the layout and
  // every fit pack the board for: see use-layout-frame.ts.
  const { railInsetRef, availableWidth, availableHeight } =
    useLayoutFrame({ canvasRef, canvasSize, machinePhase, usagePhase, usagePanelOpen, detailShown });

  // Which agents are drawn and which are spotlit, and the arrays React Flow is
  // handed, a drag in flight patched over them — use-board-graph.ts.
  const graph = useBoardGraph({
    stateRef, now, availableWidth, availableHeight, layout, measuredRef, onBubble, settled, dragging,
    layoutSig, selectedIds, openContext, historyReplayed, removedNodes, removedAgentIds,
    dragTick, dragPatchRef, dragMoveTick,
  });
  const { nodes, edges } = graph;

  // Re-column when the frame changes enough to change the answer, keeping what
  // the reader was looking at — use-reframe.ts.
  const primarySelectedIdRef = useMirroredRef(primarySelectedId);
  useReframe({
    nodes, edges, settled, dragging, availableWidth, availableHeight, layout, camera, rf,
    measuredRef, stateRef, lastFocusRef, primarySelectedIdRef, focusAgentRef, autoFitDisabledRef,
  });

  // `selected` is declared with the rail measurement further up this file,
  // which needs to know whether the detail panel is mounted.

  // Clear, the confirmation it waits on, and the one door to it — use-clear-flow.ts.
  const clearFlow = useClearFlow({
    stateRef, pinnedRef, measuredRef, positionsRef, lastLayoutSigRef, forgetRemovals, clearSelection, rerender, modalOpenRef,
  });
  const { requestClear } = clearFlow;

  // The three handlers of a drag on the canvas — a card, or a whole session
  // by its box — and what they leave behind: see use-node-drag.ts.
  const drag = useNodeDrag({
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

  // What a click, a double-click and a hover on the canvas do — use-canvas-clicks.ts.
  const clicks = useCanvasClicks({
    clearSelection, selectAgent, detailOpen, setDetailOpen, detailShown, focusAgent, draggingRef, lodRef,
  });

  // What the peek reads, made once — use-peek-readers.ts.
  const peek = usePeekReaders({ nodesRef, stateRef, canvasRef, railInsetRef });
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
    setBrowserWatchOpen, setKeyHelpOpen, setTheme, openSettings,
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
  // A removed session that starts waiting or working again comes back —
  // use-removals.ts.
  useRemovalCallBacks({ stateRef, waitingSessions, removedAgentIds, removedNodes, bringBack });
  // The tab strip's title and icon, which say what the deck says while it is
  // not on screen — use-tab-ambient.ts.
  useTabAmbient({ stateRef, waitingSessions, live });
  // Said aloud for a screen reader: that a session is waiting on you, and that
  // Browser Watch has something unread — in use-live-announcements.ts.
  const announcements = useLiveAnnouncements({ waitingSessions, watchUnseen, incidents });

  // OS notifications for a session that is waiting on you: the permission, the
  // switch, asking for it, and what has already been raised — in
  // use-os-notifications.ts. It is fed the same waiting set the sidebar draws.
  const notify = useOsNotifications({ waitingSessions, liveSince, focusSession });
  const { loadNotifyPrefs } = notify;
  // One read of the deck's server-side prefs, each hook handed its half —
  // use-prefs-read.ts.
  usePrefsRead({ loadAutoRestartPrefs, loadNotifyPrefs, loadReportsPrefs: reports.loadReportsPrefs });

  // The eight controls of the chrome, each defined once, and the edge each
  // lives on — rail-items.tsx; drawn by components/EdgeRails.tsx. Under 641px
  // the two stripes and the utilities are one dock along the bottom.
  const phone = useMediaQuery(PHONE_QUERY);
  const rails = railItems({
    providers, sessionListOpen, toggleSessionList, accountsPanelOpen, toggleAccountsPanel,
    usagePanelOpen, setUsagePanelOpen, machinePanelOpen, setMachinePanelOpen, setUsageHistoryOpen,
    watchOn, watchUnseen, setBrowserWatchOpen, openSettings, onFeedback: dialogs.openFeedback,
    toggles: panelReturn.toggles,
  });
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
        {/* The observation group, and the notes on each readout in it — components/TopbarReadouts.tsx. */}
        <ReadoutGroup
          versionCheck={versionCheck} welcome={welcome} desktopUpdate={desktopUpdate} pause={pause}
          announcements={announcements} notify={notify} waitingSessions={waitingSessions}
          waitingCursorRef={waitingCursorRef} focusSession={focusSession} live={live} now={now}
          incidents={incidents}
        />
        {selected && (
          <SelectedRibbon selected={selected} now={now} selectedIds={selectedIds} focusAgent={focusAgent} clearSelection={clearSelection} />
        )}
        {/* Settings and Feedback, in the corner every product keeps them in.
            The panel toggles are on the edges their panels open from. */}
        {!phone && <div className="actions"><UtilityRun items={rails.utilities} /></div>}
      </header>

      {/* The left stripe, ahead of the column it opens so Tab reaches the
          control before the region it discloses — or, on a phone, the dock
          that stands in for both stripes and the utilities. */}
      {phone
        ? <EdgeDock items={[...rails.left, ...rails.right[0], rails.utilities[0]]} more={[...rails.right[1], rails.utilities[1]]} />
        : <EdgeRail side="left" label="Left column" groups={[rails.left]} />}

      {/* Mounted whether or not anything was removed, for the reason the
          topbar's alarm region is (#372): words that arrive with their region
          are the ones screen readers drop. */}
      <div className="vis-hidden" role="status" aria-atomic="true">
        {removalNotice ? `${removalNotice.label} removed from the board.` : ""}
      </div>
      {/* At most one banner under the topbar, and which — components/DeckBanner.tsx. */}
      <DeckBanner
        restart={restart} versionCheck={versionCheck} upgrade={upgrade} oldNameNotice={oldNameNotice}
        rating={rating} onFeedback={dialogs.openFeedback}
        everConnected={everConnected} live={live} paused={paused}
      />

      {/* Claude-only, and now conditional on Claude Code actually being here.
          Every account in it is a Claude account, the store behind it is
          claude-swap's, and both of its empty states end at `claude auth login`
          — which on a Codex-only machine dead-ends at "the claude CLI could not
          be run: not on PATH". The panel is also open by default, so that was
          the first thing such a user saw. */}
      {isMounted(accountsPhase) && providers.claude && (
        <AccountsPanel leaving={accountsPhase === "leaving"} onReport={dialogs.openFeedback}
          onRoster={attention.observe} onClose={() => { panelReturn.accounts(); closeAccountsPanel(); }} />
      )}

      {sessionListOpen && (
        <SessionList
          state={stateRef.current}
          now={now}
          selectedIds={selectedIds}
          onSelect={openSession}
          onClose={() => { panelReturn.sessionList(); closeSessionList(); }}
          removedIds={removedAgentIds}
          onBringBackAll={bringBackAll}
        />
      )}
      {/* <main>, the canvas: the listeners that have to sit on all of it, and
          the drag-to-remove zone and the peek drawn over it —
          components/CanvasMain.tsx. What is drawn on it is App's, below. */}
      <CanvasMain
        canvasRef={canvasRef} bubbling={bubbling} dragging={dragging} trash={trash} zoom={zoom}
        viewport={viewport} stateRef={stateRef} peek={peek}
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
        {/* React Flow, and everything drawn in its pane — components/BoardFlow.tsx. */}
        <BoardFlow
          graph={graph} layout={layout} viewport={viewport} clicks={clicks} drag={drag}
          appearance={appearance} fm={fm} autoFit={autoFit} pause={pause}
          stateRef={stateRef} measuredRef={measuredRef} hiddenCats={hiddenCats} now={now}
          openTool={openTool} focusAgent={focusAgent} requestClear={requestClear} setKeyHelpOpen={setKeyHelpOpen}
        />
      </CanvasMain>

      {/* The right stripe, ahead of the two panels it opens so Tab reaches the
          control before the region it discloses. */}
      {!phone && <EdgeRail side="right" label="Right panels" groups={rails.right} />}

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
          incidents={incidents}
          liveSince={liveSince}
          leaving={usagePhase === "leaving"}
          onClose={() => { panelReturn.usage(); setUsagePanelOpen(false); }}
        />
      )}

      {/* Mounted only while it is open, which is also what starts its poll: the
          topbar meter used to keep /api/system running for the life of the tab
          on behalf of a readout that is gone. `usageOpen` moves it one rail
          slot left when usage has the first one — see .sysdetail.shifted. */}
      {isMounted(machinePhase) && (
        <MachinePanel usageOpen={usagePanelOpen} leaving={machinePhase === "leaving"}
          onClose={() => { panelReturn.machine(); setMachinePanelOpen(false); }} />
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
        <DetailAside
          selected={selected} now={now} openTool={openTool} setSummaryFor={setSummaryFor}
          stateRef={stateRef} removeSelectedNode={removeSelectedNode}
          onClose={() => { panelReturn.detail(); setDetailOpen(false); }}
        />
      ) : null}

      {/* The dialogs, in the order they paint over one another — components/DeckDialogs.tsx. */}
      <DeckDialogs
        dialogs={dialogs} welcome={welcome} desktopUpdate={desktopUpdate} versionCheck={versionCheck} restart={restart}
        lanPairs={lanPairs} attention={attention} clearFlow={clearFlow} watchBadge={watchBadge} announcements={announcements}
        appearance={appearance} providers={providers} stateRef={stateRef} agentCount={agentCount}
        menus={menus} sound={sound} tones={tones} customTones={customTones} notify={notify} fm={fm}
      />
    </div>
  );
}
