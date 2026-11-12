import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "reactflow";
// Keeps a side panel mounted long enough to animate out — see panel-exit.ts
// for why `{open && <Panel/>}` cannot do that on its own.
import { usePanelPresence, isMounted, isDrawn, isLeaving, type PanelPhase } from "./panel-exit";
import BoardFlow from "./components/BoardFlow";
import DesktopTitlebar from "./components/DesktopTitlebar";
import SessionList, { buildRows } from "./components/SessionList";
import QuickOpen from "./components/QuickOpen";
import { DialogPresence } from "./components/Dialog";
import { quickOpenItems, startFolder } from "./quick-open-items";
import type { QuickItem } from "./quick-open";
import { indexFor } from "./settings-search";
import { useSingleKeyShortcuts } from "./use-single-key-shortcuts";
import ToolAuditModal, { type ToolActivityView } from "./components/ToolAuditModal";
import UsagePanel from "./components/UsagePanel";
import MachinePanel from "./components/MachinePanel";
import AccountsPanel from "./components/AccountsPanel";
import AccountsSwitch, { type AccountSide } from "./components/AccountsSwitch";
import AccountCapacityDialog from "./components/AccountCapacityDialog";
import type { CapacityView } from "./components/AccountsUsageReport";
import CodexAccountsPanel from "./components/CodexAccountsPanel";
import LeftColumn from "./components/LeftColumn";
import { useDragTrash } from "./use-drag-trash";
import { useBubbleAnimation, useClosingGap } from "./use-bubble-animation";
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
import { useHideFinished } from "./use-hide-finished";
import { useTabAmbient } from "./use-tab-ambient";
import { useCanvasViewport } from "./use-canvas-viewport";
import { useRepackAnchor, type ZoomFocus } from "./use-repack-anchor";
import { useCanvasClicks } from "./use-canvas-clicks";
import { useCanvasSize } from "./use-canvas-size";
import { useNodeMeasurements, useSettled } from "./use-node-measurements";
import { useLayoutFrame } from "./use-layout-frame";
import { useCamera } from "./use-camera";
import { usePointerFocus } from "./use-pointer-focus";
import { pickSessionForInspector, stepWaiting, useDeckShortcuts } from "./use-deck-shortcuts";
import { usePanelReturn } from "./use-panel-return";
import { useNodeDrag } from "./use-node-drag";
import { EmptyHero, TabCapHero } from "./components/EmptyHero";
import DetailAside from "./components/DetailAside";
import { inspectorDoorOpen, inspectorDoorPress, inspectorIsSheet } from "./inspector-corner";
import { EdgeDock, EdgeRail, PHONE_QUERY, UtilityRun } from "./components/EdgeRails";
import { commandPanelMore, railItems } from "./rail-items";
import { unreadOf, useFeedbackAccount } from "./feedback-unread";
import { focusAfterFold } from "./fold-focus";
// The modal and its panels load on demand; this is the light wrapper that
// fetches them (IntegrationModalOnDemand.tsx).
import IntegrationModal, { preloadIntegrationModal } from "./components/IntegrationModalOnDemand";
import ExploreIntegrationsModal from "./components/ExploreIntegrationsModal";
import {
  connectionsOf, integrationsReach, kindOffered, kindOpenable, offeredKinds, requestIntegrationAdd, requestIntegrationFocus, useIntegrations,
} from "./integrations/client";
import { integrationDefs } from "./integrations/registry";
import type { IntegrationKind } from "./integrations/types";
import { useMediaQuery } from "./use-media-query";
import { ReadoutGroup } from "./components/TopbarReadouts";
import CategoryFilterBar from "./components/CategoryFilterBar";
import PhoneBoard from "./components/PhoneBoard";
import RadioExperience from "./components/RadioExperience";
import CanvasMain from "./components/CanvasMain";
import DeckBanner from "./components/DeckBanner";
import { OfflineCard } from "./components/ConnectionBanner";
import { usePhoneSheets } from "./use-phone-sheets";
import { accountsGivesPaneBack, pressSessionsDoor, sheetCloseMs, sheetFadeMs } from "./phone-sheet";
import DeckDialogs from "./components/DeckDialogs";
import StatusBar from "./components/StatusBar";
import ErrorBoundary from "./components/ErrorBoundary";
import { usePauseGate } from "./use-pause-gate";
import { panelId, useAccountSide } from "./use-account-side";
import type { LanAccount } from "./lan-types";
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
import { useMeterQuota } from "./use-quota";
import { leftColumnWidth, useColumnSettle, useLeftColumn, useRailWidth, useWorkspaceColumn } from "./use-left-column";
import { sessionsOf, useMarkSeen } from "./use-mark-seen";
import { useRightPanels } from "./use-right-panels";
import { useLiveAnnouncements } from "./use-live-announcements";
import { useOsNotifications } from "./use-os-notifications";
import { useStopContinueFeed } from "./use-stop-continue";
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
import { sessionListName } from "./session-display";
import { sessionCounts } from "./topbar-counts";
import { BoardEmptyContext, boardIsEmpty } from "./board-empty";
import { initialState } from "./reducer";
import { useSoundSwitch } from "./use-sound-switch";
import { useSettingsMenus } from "./use-settings-menus";
import { useAutoFitSwitch } from "./use-auto-fit-switch";
import { useRailPanel, useStage, useStageAsks } from "./use-stage";
import { stageClaimsKeys, targetSession } from "./stage-shell";
import { StageDockSlot, StageNavigatorSlot } from "./components/StageSlots";
import ViewSwitch from "./components/ViewSwitch";
import { EmptyInspector } from "./components/Inspector";
import { readView, useView, type View } from "./use-view";
import { useSideColumn, type SidePanel } from "./side-column";
import { useInspectorFold, withInspectorFold } from "./inspector-fold";
import SideColumn from "./components/SideColumn";
import { SKIP_TO_PANE_MSG, WORKSPACE_PANE_ID, skipToPane } from "./workspace-pane";
import { createChimePlayer } from "./chime-player";
import type { AccountSwitch } from "./components/SettingsModal";
import type { Appliers } from "./account-bridge";
import { useZoomPhase } from "./use-zoom-phase";
import { tokenMs } from "./rail-motion";
import { pinBoard, runSwitch, unpinBoard } from "./view-switch";
import { lastInputWasKey } from "./input-modality";
import { setSingleKeyShortcuts } from "./single-key-shortcuts";
import { setHideFinishedAfter } from "./hide-finished";
import type { Density, TextSize } from "./reading-preferences";
import type { Theme } from "./theme";

/** Under this width the Inspector is the detail sheet, not a Workspace column
 *  (workspace.css, "Narrower windows"). */
const INSPECTOR_SHEET_QUERY = "(max-width: 1319px)";
/** Under this width the Sessions list is a sheet in Workspace (workspace.css). */
const WORKSPACE_LIST_SHEET_QUERY = "(max-width: 1099px)";
/** Under this width Workspace's side column opens one part at a time (side-column.ts). */
const ONE_PART_QUERY = "(max-width: 1023px)";
/** Usage and Machine are held for their exit: --dur-fast, and --dur-xfade
 *  under reduced motion (machine-panel.css), read from the tokens. */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// The ccdeck account's settings sync in this tab — hidden, and its own chunk:
// mounted, and so fetched, only while /api/prefs says the account is on.
const AccountBridge = lazy(() => import("./components/AccountBridge"));
import { useT } from "./i18n";

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
  const t = useT();
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
  // The left column: the session list and the accounts panel share one slot,
  // and opening one evicts the other (#824). Both panels' state, persistence and
  // the eviction live in use-left-column.ts; only its toggles can open either.
  // Restored first, because the right-hand panels' room depends on its width.
  const leftColumn = useLeftColumn();
  const { sessionListOpen, accountsPanelOpen, panel: leftPanel, toggleSessionList, toggleAccountsPanel,
          openAccountsPanel, closeSessionList, closeSessionListToCanvas, closeAccountsPanel,
          leavePhone: leaveColumnPhone, holdAccounts } = leftColumn;
  // The rail's width at the density in force (--rail-w), which the column and
  // the right-hand panels' room both follow.
  const railWidth = useRailWidth();
  // The detail, Usage and Machine panels' open flags, each kept in the browser
  // across a refresh — use-right-panels.ts. Called ahead of the selection
  // below, because a plain selection opens the detail panel (#814). A load in
  // Workspace has the two in one side column, not side by side over the board.
  const { detailOpen, setDetailOpen, usagePanelOpen, setUsagePanelOpen, machinePanelOpen, setMachinePanelOpen, hold: holdRight }
    = useRightPanels(leftColumnWidth(leftPanel, railWidth), readView() === "workspace");

  const { selectedIds, primarySelectedId, selectAgent, clearSelection, pruneSelectionToBoard } =
    useSelection(stateRef, setDetailOpen);
  /** A card in the Inspector's tree was pressed. One function for the life of
   *  the selection hook's callback, so the tree's memoised rows see no new prop
   *  on every render. */
  const selectInspected = useCallback((id: string) => selectAgent(id, false, false), [selectAgent]);
  /** Both panels outlive their own `false` by the length of their exit: a
   *  close slides the panel out with the column's edge, and a switch fades the
   *  one leaving under the one arriving. Must match `--side-exit` in the sheet. */
  const accountsPhase = usePanelPresence(accountsPanelOpen, 200);
  const sessionListPhase = usePanelPresence(sessionListOpen, 200);
  /** Drawn, and leaving, from the render that flips the flag: the same render
   *  the column's width changes in (panel-exit.ts, isDrawn). */
  const sessionListDrawn = isDrawn(sessionListOpen, sessionListPhase);
  /** The rail's two panels leave the same way, by a fade alone: held for its
   *  length, --dur-fast, or --dur-xfade under reduced motion (the sheet,
   *  machine-panel.css). */
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  // A phone is the Board alone (and the dock instead of the stripes): asked
  // here because Workspace, which the stage hook decides, is never on one, and
  // because a sheet on a phone is held for its own, longer, exit.
  const phone = useMediaQuery(PHONE_QUERY);
  const railExitMs = useMemo(
    () => phone ? (reducedMotion ? sheetFadeMs() : sheetCloseMs()) : tokenMs(reducedMotion ? "--dur-xfade" : "--dur-fast"),
    [reducedMotion, phone]);
  const usagePhase = usePanelPresence(usagePanelOpen, railExitMs);
  const machinePhase = usePanelPresence(machinePanelOpen, railExitMs);

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
  const { live, tabCapped, everConnected, liveSince, lastNewsAt } =
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
  // One Accounts panel with a Claude/Codex switch, or the one CLI this deck has.
  const accountSide = useAccountSide(providers, accountsPanelOpen);
  const shownAccountProvider = accountSide.shown;
  /** The doors that name a side: opened on it, moved to it if already open. */
  const openAccountSide = (side: AccountSide) => {
    accountSide.remember(side);
    if (!accountsPanelOpen || shownAccountProvider === side) toggleAccountsPanel();
  };
  /** How wide the left column is drawn: the open panel's own width, or 0 —
   *  never anything the two panels make between them (LeftColumn.tsx). The
   *  accounts panel has no width when neither provider is installed. */
  const leftColumnTarget = leftColumnWidth(
    // On a phone the column holds the list alone: Accounts is a sheet over it.
    phone ? (sessionListOpen ? "session-list" : null)
      : leftPanel === "accounts" && !(providers.claude || providers.codex) ? null : leftPanel,
    railWidth);
  const columnSettleRef = useColumnSettle(leftColumnTarget);
  const accountsDrawn = isDrawn(accountsPanelOpen, accountsPhase) && (providers.claude || providers.codex);
  // Settings › General's door to Local network (#2176), which is the accounts
  // panel's own view: the panel opened (use-left-column.ts), and the view
  // asked for. The panel shows it once its roster has arrived — the moment
  // its own way in, the row at its foot, appears — so the ask waits for that,
  // and is dropped if the panel is shut first, rather than springing the view
  // open on some later visit nobody asked it of.
  const [lanWanted, setLanWanted] = useState(false);
  const rememberAccountSide = accountSide.remember;
  // Settings' door names Claude's accounts where Claude Code is, so it opens that side.
  const openAccounts = useCallback(() => { rememberAccountSide(providers.claude ? "claude" : "codex"); openAccountsPanel(); }, [openAccountsPanel, providers.claude, rememberAccountSide]);
  // Both sides of the panel draw Local network (#2472), so it opens on
  // whichever side is up — and on a deck with only Codex, it opens at all.
  const openLocalNetwork = useCallback(() => {
    openAccountsPanel();
    setLanWanted(true);
  }, [openAccountsPanel]);
  // What Local network offers from this deck, read by Claude's side and drawn
  // by Codex's too (#2472). Null until Claude's side has read its roster.
  const [claudeLan, setClaudeLan] = useState<LanAccount[] | null>(null);
  // And its Codex logins, read by Codex's side: both sides share them from the
  // same dialog, after Claude's.
  const [codexLan, setCodexLan] = useState<LanAccount[]>([]);
  const lanOffered = useMemo(() => [...(claudeLan ?? []), ...codexLan], [claudeLan, codexLan]);
  useEffect(() => { if (!accountsPanelOpen) setLanWanted(false); }, [accountsPanelOpen]);
  const lanShown = useCallback(() => setLanWanted(false), []);

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
  // The trackers this deck is connected to (#2178): one rail button per kind
  // with a connection, which opens that kind's large modal. The list is the
  // one Settings › Integrations edits, so a connection added there puts the
  // button up at once and the last one removed takes it away. A kind this deck
  // does not offer has no button, no key and no modal, connected or not: its
  // connections wait in Settings, where Disconnect removes them.
  const integrations = useIntegrations();
  const [integrationOpen, setIntegrationOpen] = useState<IntegrationKind | null>(null);
  const [exploreIntegrationsOpen, setExploreIntegrationsOpen] = useState(false);
  const closeExploreIntegrations = useCallback(() => setExploreIntegrationsOpen(false), []);
  const connectIntegration = (kind: IntegrationKind) => {
    requestIntegrationAdd(kind);
    openSettings("integrations");
  };
  const manageIntegration = (connectionId?: string) => {
    if (connectionId) requestIntegrationFocus(connectionId);
    openSettings("integrations");
  };
  const closeIntegration = useCallback(() => setIntegrationOpen(null), []);
  const connectedKinds = integrationDefs().filter(p => kindOpenable(integrations, p.kind));
  const openIntegrationRef = useMirroredRef((kind: string) => {
    const def = connectedKinds.find(p => p.kind === kind);
    if (def) setIntegrationOpen(def.kind);
  });
  const reconnectIntegration = useCallback((connId: string) => {
    requestIntegrationFocus(connId);
    openSettings("integrations");
  }, [openSettings]);
  // The modal's chunk, fetched the moment a rail control is up, so the first
  // press opens it at once; a deck with none to show never fetches it.
  const integrationShown = connectedKinds.length > 0;
  useEffect(() => { if (integrationShown) preloadIntegrationModal(); }, [integrationShown]);

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

  // Continue for turns that stopped on a login or a usage limit (#2193): asks
  // the server while a card is stopped, for the store the cards and the
  // detail panel read (use-stop-continue.ts).
  useStopContinueFeed({ stateRef, now, enabled: providers.claude });

  // What the providers' status pages report (#1311): use-provider-status.ts
  // asks, provider-status.ts decides which lines are an incident. Read against
  // the board's clock, so an answer the page is still holding expires on
  // screen even while the deck itself has stopped answering.
  const providerStatus = useProviderStatus(providers.claude || providers.codex);
  // Claude's 5-hour reading for the rail's usage meter: the usual /api/quota
  // read once a minute while the page is open and visible, never forced
  // (the owner's OK, 2026-11-01). The Usage panel keeps its own useQuota.
  const meterQuota = useMeterQuota(providers.claude);
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
  const layout = useBoardLayout(camera);
  const { pinnedRef, positionsRef, lastLayoutSigRef, handleRelayout, rearrangeUndo } = layout;

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
  // Held while the left column moves, so the board is re-packed once, after.
  const { canvasRef, canvasSize, paneSizeRef, remeasureCanvas } = useCanvasSize(columnSettleRef);
  // Fit all and the recenter button turn the auto-fit back on with a fit of
  // the whole board, below the auto-fit's floor where it takes that.
  const autoFit = useAutoFitSwitch(camera.fitAll);
  const { autoFitDisabledRef, disableAutoFit } = autoFit;

  // True for the length of a drag gesture. A ref as well as state: the
  // measurement effect below reads it without wanting to re-run when it
  // changes, and the layout memo needs the state to recompute.
  const draggingRef = useRef(false);

  // Every card's size, from React Flow's store and from the DOM, with the two
  // counters the layout keys off: see use-node-measurements.ts.
  const { measuredRef, measuredVersionRef, sizeVersion, domSizeVersion } = useNodeMeasurements(draggingRef, stateRef);

  // What Remove node has taken off the board, the way back, and the sentence
  // that says so — use-removals.ts.
  const { removedNodes, removedAgentIds, removeNode, removeSelectedNode, removalNotice,
          hideSessions, bringBack, bringBackAll, forgetRemovals }
    = useRemovals({ stateRef, pinnedRef, positionsRef, returningRef: layout.returningRef, canvasRef, clearSelection, primarySelectedId });
  // What the layout keys off: the visible, not-removed agents and their
  // parents, plus the two size versions — use-board-graph.ts.
  const layoutSig = useLayoutSig({ stateRef, now, removedAgentIds, sizeVersion, domSizeVersion });

  // Stored whenever the arrangement's signature moves — use-board-layout.ts.
  const { saveSoon } = useLayoutAutosave(layoutSig, layout);

  // The two things that bring the board back into view on their own — a
  // layout that changed shape, and a board that drifted off the pane — both
  // stand down while the user has the wheel: use-auto-fit.ts.
  const { fitSoon } = useAutoFit({
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
  // A pan or a zoom by hand: auto-fit stands down, and a Fit all stops holding.
  const { releaseFitAll } = camera;
  const tookWheel = useCallback(() => { disableAutoFit(); releaseFitAll(); }, [disableAutoFit, releaseFitAll]);
  // Where each zoom holds still, for the switch to and from the packed board.
  const zoomFocusRef = useRef<ZoomFocus | null>(null);
  const viewport = useCanvasViewport({
    applyViewport, takeOver: camera.takeOver, lastFitTimeRef, cameraEpochRef, disableAutoFit: tookWheel, markInteract, canvasRef, applyZoom,
    zoomFocusRef,
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
  const lastSelected = useRef(selected);
  if (selected) lastSelected.current = selected;
  // Where keyboard focus goes when a panel's own × or ‹ takes it away with the
  // panel: the topbar button that opens it, or the card the detail panel was
  // about — use-panel-return.ts.
  const panelReturn = usePanelReturn({
    sessionListShown: sessionListDrawn, usageShown: isMounted(usagePhase), machineShown: isMounted(machinePhase),
    // One rail button for both sides where Claude Code is; Codex's own only where it is all there is.
    accountsShown: accountsDrawn && providers.claude, codexShown: accountsDrawn && !providers.claude, detailShown, primarySelectedId, canvasRef,
  });

  // The Inspector open folds the open floating panels to their header, and
  // closing it gives them back (inspector-fold.ts). Workspace keeps its own.
  const inspectorFold = useInspectorFold(!phone && detailShown, { usage: usagePanelOpen, machine: machinePanelOpen });

  // What the floating panels cover of the canvas, and the frame the layout and
  // every fit pack the board for: see use-layout-frame.ts.
  const { railInsetRef, availableWidth, availableHeight } =
    useLayoutFrame({ canvasRef, canvasSize, machinePhase, usagePhase, usagePanelOpen, detailShown, folds: inspectorFold.folds });

  // A layout pass moved the cards with the signature unmoved (the first flow,
  // a push, a restored board's hold lifting): the camera frames the board
  // again and the stored board becomes the moved one.
  const boardMoved = useCallback(() => { fitSoon(); saveSoon(); }, [fitSoon, saveSoon]);
  // Which agents are drawn and which are spotlit, and the arrays React Flow is
  // handed, a drag in flight patched over them — use-board-graph.ts.
  const graph = useBoardGraph({
    stateRef, now, availableWidth, availableHeight, layout, measuredRef, onBubble, settled, dragging,
    layoutSig, selectedIds, openContext, historyReplayed, removedNodes, removedAgentIds,
    dragTick, dragPatchRef, dragMoveTick, onMoved: boardMoved,
    // Below the full card the faces draw the board packed (packed-board.ts).
    packed: zoom.lod !== "detail",
  });
  const { nodes, edges } = graph;
  // The fit reads the board's own places, not the packed ones (use-camera.ts).
  camera.boardRef.current = nodes;
  // Crossing to or from the packed board keeps the card the reader is zooming
  // at where it is — use-repack-anchor.ts.
  useRepackAnchor({
    packed: zoom.lod !== "detail", nodes, squeeze: graph.squeeze, focusRef: zoomFocusRef, canvasRef,
    getViewport: camera.currentViewport, panBy: camera.panBy,
  });
  // A card has just left: its neighbours close the gap after a hold (canvas-motion.css).
  const closing = useClosingGap(graph.visibleAgentIds);

  // Frame the board again when the canvas changes size, moving no card —
  // use-reframe.ts.
  const primarySelectedIdRef = useMirroredRef(primarySelectedId);
  useReframe({
    settled, dragging, availableWidth, availableHeight, layout, camera, lastFocusRef, focusAgentRef, autoFitDisabledRef,
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
    nodes, shown: graph.shown, squeeze: graph.squeeze, stateRef, pinnedRef, positionsRef, draggingRef, dragPatchRef,
    setDragging, setDragMoveTick, setDragTick, endBubble, markInteract, disableAutoFit,
    beginTrashDrag, trackTrashDrag, endTrashDrag, removeNode,
  });

  // Same anchoring as relayout — F and the fit button land where it does,
  // the whole board, as Fit all does.
  const handleFit = camera.fitAll;

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
  // Where the last jump to a session landed, for the rail: its row scrolls into
  // view and says "here" once. Every jump — N, W, a notification, ⌘K, a
  // cluster's name — comes through focusSession (use-agent-focus.ts) or, once
  // the stage follows the session instead, through openSession below. The
  // nonce makes the same session twice two jumps.
  const [landed, setLanded] = useState<{ id: string; nonce: number } | null>(null);
  const markLanded = useCallback((sessionId: string) => setLanded(prev => ({ id: sessionId, nonce: (prev?.nonce ?? 0) + 1 })), []);
  const { focusAgent, stepAgent, focusSession } = useAgentFocus({
    canvasRef, stateRef, measuredRef, nodesRef, railInsetRef, moveCamera, disableAutoFit,
    lastFocusRef, focusAgentRef, selectAgent, primarySelectedIdRef, onLand: markLanded,
  });

  // The terminal stage, behind its switch in Settings: a session's live terminal on
  // the right of the canvas, the board gathered into a navigator on its left,
  // and every way in and out of it — use-stage.ts. With the flag off it is
  // inert: every entry point below answers "not mine".
  // Board or Workspace, as the browser remembered it (use-view.ts). Whether the
  // layout follows it is the stage hook's: it holds the gate (use-stage.ts).
  const viewState = useView();
  const stage = useStage({
    stateRef, canvasRef, detailOpen, detailShown, setDetailOpen, primarySelectedIdRef, selectAgent,
    view: viewState.stored, phone, clearSelection,
  });
  const inWorkspace = stage.workspace;
  // Zoom's fold and unfold: the panels slide, the grid follows at the end
  // (use-zoom-phase.ts).
  const zoomPhase = useZoomPhase(inWorkspace && stage.expanded);
  // Workspace puts the Sessions list in the left column when it is entered at
  // 1100px and wider, and gives the column back on leaving (use-left-column.ts).
  const wideWindow = !useMediaQuery(WORKSPACE_LIST_SHEET_QUERY);
  useWorkspaceColumn({ active: inWorkspace && stage.enabled, wide: wideWindow, column: leftColumn });
  // The Inspector is a column in Workspace down to 1320px, and the detail sheet
  // (D, the ribbon) under it: workspace.css says why.
  const inspectorColumn = !useMediaQuery(INSPECTOR_SHEET_QUERY);
  // From 1100 to 1319 Workspace's Inspector is a sheet over the pane that starts
  // folded: its door on the right stripe (rail-items.tsx) is what the reader sees.
  const inspectorSheet = inspectorIsSheet({ workspace: inWorkspace && stage.enabled, wide: wideWindow, column: inspectorColumn });
  // On a phone the Inspector is a sheet, and leaves down the bottom edge as the
  // other three do: its element is held for the slide, the flag already
  // dropped. Workspace's sheet leaves the way it came, off the right edge, on
  // the panels' fold timing; by a key or under reduced motion it goes at once.
  // Never held otherwise, where it goes at once as it did.
  const sheetExitMs = inspectorSheet && !reducedMotion && !lastInputWasKey() ? tokenMs("--dur-stage-out") : 0;
  const detailPhase = usePanelPresence(detailShown, phone ? railExitMs : sheetExitMs);
  const detailLeaving = (phone || sheetExitMs > 0) && isLeaving(detailShown, detailPhase);
  const detailOnScreen = detailShown ? selected : detailLeaving ? lastSelected.current : null;
  // The Board's stored Inspector choice is not the sheet width's: entering
  // Workspace here, or narrowing into this range, folds it in memory alone
  // (use-right-panels.ts, the same hold the panels use).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (inspectorSheet) holdRight.detail(); }, [inspectorSheet]);
  // The Inspector's Fold folds the Inspector alone, at any width: the list and
  // the pane stay (folding both is Zoom's). D, or choosing a session to
  // inspect, opens it again; the grid drops its track while it is folded.
  const [inspectorFolded, setInspectorFolded] = useState(false);
  useEffect(() => { if (detailOpen) setInspectorFolded(false); }, [detailOpen]);
  const foldInspector = useCallback(() => {
    setInspectorFolded(true);
    setDetailOpen(false);
    // The keyboard goes to the pane, never the page; failing that, to the
    // Inspector's door (fold-focus.ts).
    requestAnimationFrame(() => { focusAfterFold(document); });
  }, [setDetailOpen]);
  // The sheet closed some way that is not Fold (D, a deselect) with the keys
  // still in it, or on nothing: the same hand-off.
  const sheetWasShown = useRef(false);
  useEffect(() => {
    const was = sheetWasShown.current;
    sheetWasShown.current = inspectorSheet && detailShown;
    if (!was || sheetWasShown.current || !inspectorSheet) return;
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (!at || at === document.body || at.closest(".detail")) focusAfterFold(document);
    });
  }, [inspectorSheet, detailShown]);
  // The Inspector's door on the right stripe (rail-items.tsx). It reads Open
  // while the Inspector shows: the column in Workspace from 1320 (until it is
  // folded), the sheet from 1100 to 1319, or the detail panel on the Board and
  // under 1100. Never under Zoom, which folds the panels away.
  const zoomed = inWorkspace && (zoomPhase !== undefined || stage.expanded);
  const inspectorOpen = inspectorDoorOpen({
    workspace: inWorkspace, column: inspectorColumn, folded: inspectorFolded, shown: detailShown, zoomed,
  });
  const showInspector = useCallback(() => {
    setInspectorFolded(false);
    if (primarySelectedIdRef.current) setDetailOpen(true);
    else pickSessionForInspector(stateRef.current, focusSession, stepAgent);
    // The door is not what the keys are for once the Inspector is drawn: they go into it.
    requestAnimationFrame(() => { document.querySelector<HTMLElement>(".detail .insp-tab[aria-selected=\"true\"]")?.focus(); });
  }, [setDetailOpen, primarySelectedIdRef, stateRef, focusSession, stepAgent]);
  // In Workspace the door folds and unfolds the column or the sheet; on the
  // Board and under 1100 it is exactly D (inspector-corner.ts says which).
  const toggleInspector = useCallback(() => {
    const press = inspectorDoorPress({ workspace: inWorkspace, column: inspectorColumn, sheet: inspectorSheet, open: inspectorOpen });
    if (press === "fold") foldInspector();
    else if (press === "show") showInspector();
    else if (primarySelectedIdRef.current) setDetailOpen(o => !o);
    else pickSessionForInspector(stateRef.current, focusSession, stepAgent);
  }, [inWorkspace, inspectorColumn, inspectorSheet, inspectorOpen, foldInspector, showInspector, setDetailOpen, primarySelectedIdRef, stateRef, focusSession, stepAgent]);
  const sheetFoldRef = useMirroredRef<(() => void) | null>(inspectorSheet && detailShown ? foldInspector : null);
  // Usage and Machine dock in a side column in Workspace, beside the pane, and
  // sit in the right column on the Board (side-column.ts). One open flag each for
  // both views, so a panel open on one side of the switch is open on the other.
  const onePart = useMediaQuery(ONE_PART_QUERY);
  const side = useSideColumn({
    workspace: inWorkspace && !phone,
    open: { usage: usagePanelOpen, machine: machinePanelOpen },
    mounted: { usage: isMounted(usagePhase), machine: isMounted(machinePhase) },
    narrow: onePart,
  });
  // On the Board each panel's dock carries the Inspector's fold: a folded panel
  // is one row at the top of the right column, above the Inspector
  // (inspector-fold.ts, panel-place.css); opened there, it folds back to that
  // row. Workspace's column and a phone's sheets are left as they are.
  const refold = (k: SidePanel) => (inspectorFold.on ? () => inspectorFold.fold(k) : undefined);
  const docks = {
    usage: withInspectorFold(side.dock.usage, inspectorFold.folds.usage, () => inspectorFold.unfold("usage"), refold("usage")),
    machine: withInspectorFold(side.dock.machine, inspectorFold.folds.machine, () => inspectorFold.unfold("machine"), refold("machine")),
  };
  // UNDER 1320 THE COLUMN TAKES THE INSPECTOR'S PLACE: an Inspector sheet up
  // when the column arrives is held, and given back when the column goes (both
  // parts closed or popped out). One opened while the column is up comes in
  // over it, as the sheet always does.
  const sideTookInspector = useRef(false);
  useLayoutEffect(() => {
    if (!inWorkspace || inspectorColumn) { sideTookInspector.current = false; return; }
    if (side.on && detailShown) {
      sideTookInspector.current = true;
      holdRight.detail();
    } else if (!side.on && sideTookInspector.current) {
      sideTookInspector.current = false;
      if (primarySelectedIdRef.current) setDetailOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side.on, inWorkspace, inspectorColumn]);
  // A click on the switch crossfades the two views on Fast; a key switches in
  // one frame (view-switch.ts). The Board's canvas is held at its box while
  // Workspace is up, so it neither narrows nor re-fits on the way in or out.
  const appRef = useRef<HTMLDivElement>(null);
  // Workspace ended some way other than the switch (a phone-sized window, the
  // Command Panel turned off): the canvas goes back to the grid.
  useEffect(() => { if (!inWorkspace) unpinBoard(appRef.current); }, [inWorkspace]);
  const { leaveWorkspace } = stage;
  const switchView = useCallback((next: View, how: "pointer" | "key") => {
    runSwitch(how, () => {
      if (next === "workspace") {
        if (!workspaceRef.current) pinBoard(appRef.current, canvasRef.current);
      } else {
        // Leaving takes the stage down in this same update, with no morph.
        unpinBoard(appRef.current);
        leaveWorkspace();
      }
      viewState.set(next);
    });
  }, [leaveWorkspace, viewState.set]);
  const switchViewRef = useMirroredRef(switchView);
  const workspaceRef = useMirroredRef(inWorkspace);
  // Ctrl + backtick: read through a ref by the one key listener (use-deck-shortcuts.ts).
  const toggleView = useCallback(
    () => switchViewRef.current(workspaceRef.current ? "board" : "workspace", "key"),
    [switchViewRef, workspaceRef],
  );
  const viewShortcutRef = useMirroredRef({ available: stage.workspaceOffered, toggle: toggleView });
  // What you have open is what you have seen: the rail's Done · unseen group
  // keeps only turns that ended while nobody was looking (session-seen.ts).
  useMarkSeen(stateRef, [...selectedIds, stage.enabled && stage.shell.phase !== "closed" ? targetSession(stage.shell.target) : null], stateRef.current.revision);
  // The same sessions, for the rail's row model: they are seen the moment a turn
  // ends under them, not on the effect after, so they never pass through Done · unseen.
  const watchingSessions = sessionsOf(stateRef.current, [...selectedIds, stage.enabled && stage.shell.phase !== "closed" ? targetSession(stage.shell.target) : null]);
  // Finished sessions taking themselves off the board after the delay picked
  // in Settings › General — use-hide-finished.ts. After the stage, whose
  // session is kept as the selected card's is.
  useHideFinished({
    stateRef, removedNodes, hideSessions, ready: historyReplayed,
    keepSessionId: primarySelectedId ? stateRef.current.agents.get(primarySelectedId)?.sessionId ?? primarySelectedId : null,
    stageSessionId: stage.enabled && stage.shell.phase !== "closed" ? targetSession(stage.shell.target) : null,
  });
  // Usage and Machine as their stripe buttons and their keys reach them: one
  // asked for takes the right of the deck back from the stage, as the detail
  // panel does, and one the stage hides reads as closed — use-stage.ts
  // useRailPanel. The panels themselves, their own ×, the machine panel's
  // slot and the board's frame keep the plain flags.
  const usageRail = useRailPanel(stage, usagePanelOpen, setUsagePanelOpen);
  const machineRail = useRailPanel(stage, machinePanelOpen, setMachinePanelOpen);
  // THE BOARD'S RIGHT COLUMN: on a desktop Board, Usage, This machine and the
  // Inspector share one grid column and the canvas ends at its edge, so none
  // of them floats over the board and every fit has the room that is left
  // (panel-place.css). A panel stays in it for its exit fade; one the stage
  // hides is out of it, as the Inspector the stage evicts is.
  const inRightCol = (shown: boolean, phase: PanelPhase) => (shown ? isMounted(phase) : phase === "leaving");
  const rightCol = !phone && !inWorkspace
    && (detailShown || inRightCol(usageRail.shown, usagePhase) || inRightCol(machineRail.shown, machinePhase));

  // What a click, a double-click and a hover on the canvas do — use-canvas-clicks.ts.
  const clicks = useCanvasClicks({
    clearSelection, selectAgent, detailOpen, setDetailOpen, detailShown, focusAgent, draggingRef, lodRef, stage,
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
  // With the terminal stage up, a row moves the stage to that session the way
  // picking a conversation does in the Claude app, rather than opening the
  // detail panel that would evict it.
  const { followSession, openInPane } = stage;
  // Every jump to a session — the list, ⌘K, a notification, the waiting names,
  // N and W — in Workspace puts it on the pane; the board's camera is behind it
  // and has nothing to move. Everywhere else it is the camera's, as it was.
  const focusSessionOnView = useCallback((sessionId: string) => {
    if (workspaceRef.current && stage.enabled) { openInPane(sessionId); markLanded(sessionId); return; }
    focusSession(sessionId);
  }, [workspaceRef, stage.enabled, openInPane, markLanded, focusSession]);
  const openSession = useCallback((sessionId: string) => {
    // In Workspace a row opens that session in the pane, whatever the stage is
    // doing: a pane still on its way, or the empty one. followSession answers
    // only a stage that is up (the Board's rule), which left a click on a row
    // doing nothing in a Workspace whose pane had not opened yet.
    if (workspaceRef.current && stage.enabled) {
      if (removedAgentIds.has(sessionId)) bringBack([sessionId]);
      openInPane(sessionId);
      markLanded(sessionId);
      return;
    }
    if (followSession(sessionId)) {
      markLanded(sessionId);
      if (removedAgentIds.has(sessionId)) bringBack([sessionId]);
      return;
    }
    if (removedAgentIds.has(sessionId)) bringBack([sessionId]);
    focusSession(sessionId);
  }, [removedAgentIds, bringBack, focusSession, followSession, markLanded, workspaceRef, stage.enabled, openInPane]);
  // Enter on a row, in Workspace: the session in the pane, the keys in it.
  const openSessionWithKeys = useCallback((sessionId: string) => {
    if (removedAgentIds.has(sessionId)) bringBack([sessionId]);
    openInPane(sessionId, { focusPane: true });
  }, [removedAgentIds, bringBack, openInPane]);

  // Which element a POINTER put focus on, so a button the mouse pressed stops
  // swallowing the single-key shortcuts (#851): see use-pointer-focus.ts.
  const pointerFocusRef = usePointerFocus();

  // Quick open (⌘K): one field for every door, session, setting, action and
  // theme — quick-open.ts, drawn by components/QuickOpen.tsx. A chosen row
  // shuts the field and runs in the same render, so what it opens is drawn
  // with nothing left over it.
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const openQuickOpen = useCallback(() => setQuickOpenOpen(true), []);
  const closeQuickOpen = useCallback(() => setQuickOpenOpen(false), []);
  const runQuick = useCallback((item: QuickItem) => { setQuickOpenOpen(false); item.run(); }, []);
  // N, as the menu's "Next waiting" row: the key's own move, cursor and all.
  const quickNextWaiting = useCallback(() => stepWaiting(stateRef.current, waitingCursorRef, focusSessionOnView),
    [stateRef, focusSessionOnView]);
  // The menu's Start rows: the launch the New session popover's Start makes,
  // where the Command Panel is on and the board has a folder to start in.
  // Read while the menu is drawn, which is only while it is open.
  const quickStart = () => {
    if (!stage.enabled) return undefined;
    const onStage = stage.shell.phase !== "closed" ? targetSession(stage.shell.target) : null;
    const selected = primarySelectedId ? stateRef.current.agents.get(primarySelectedId)?.sessionId ?? null : null;
    const folder = startFolder(stateRef.current.agents.values(), onStage ?? selected);
    return folder ? { folder, launch: stage.launch } : undefined;
  };
  const singleKeys = useSingleKeyShortcuts();

  // The L key is the Sessions door's press: with a sheet up over the list it
  // means "go to Sessions" (the sheet closes, the list stays), set once the
  // sheets are known (below); until then, and with no sheet, the plain toggle.
  const sessionsKeyRef = useRef<() => void>(toggleSessionList);
  const pressSessionsKey = useCallback(() => sessionsKeyRef.current(), []);
  // Every key the deck answers, and what each one reaches: see
  // use-deck-shortcuts.ts, whose parameter list is that list.
  useDeckShortcuts({
    // What the keys read.
    pointerFocusRef, nodesRef, stateRef, primarySelectedIdRef, providersRef, soundOnRef,
    keyHelpOpenRef, modalOpenRef, waitingCursorRef, removeSelectedRef, activateSoundRef,
    viewRef: viewShortcutRef,
    stageRef: stage.keysRef, lodRef, inspectorSheetFoldRef: sheetFoldRef,
    // What the keys do.
    clearSelection, selectAgent, focusAgent, stepAgent, focusSession: focusSessionOnView, requestClear,
    handleRelayout, undoRearrange: rearrangeUndo.undo, handleFit, togglePause, toggleSessionList: pressSessionsKey, toggleAccountsPanel,
    setDetailOpen, setUsageHistoryOpen, setUsagePanelOpen: usageRail.set, setMachinePanelOpen: machineRail.set,
    setBrowserWatchOpen, setKeyHelpOpen, setTheme, openSettings, openIntegrationRef, openQuickOpen,
  });

  /** Not a topbar readout any more — the "agents" counter went with the
   *  sessions and events ones. It is the number ClearConfirm counts to say
   *  what clearing destroys. */
  const agentCount = stateRef.current.agents.size;
  /** The emptiness test, in one place (board-empty.ts): no session puts the
   *  hero on the canvas alone, and the parts that act on sessions read it
   *  through the context below and stay out until the first one arrives. */
  const boardEmpty = boardIsEmpty(stateRef.current);
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
  // The top bar's working and done pills (topbar-counts.ts), by the same words
  // the cards wear; waiting is the queue above.
  const counts = useMemo(
    () => sessionCounts(stateRef.current.agents.values()),
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
  const notify = useOsNotifications({ waitingSessions, liveSince, focusSession: focusSessionOnView });
  const { loadNotifyPrefs } = notify;
  // The terminal's run through the waiting sessions, and the stage's half of
  // the keys, which need the waiting list built just above — use-stage.ts.
  const asks = useStageAsks(stage, waitingSessions, canvasRef);
  // One read of the deck's server-side prefs, each hook handed its half —
  // use-prefs-read.ts.
  // Whether this deck has the hidden ccdeck account (account-flag.mjs), on the
  // same read: off until the deck says otherwise, and with it off nothing of
  // the account is drawn, fetched or run.
  const [account, setAccount] = useState<AccountSwitch>({ on: false, vetoed: false });
  usePrefsRead({
    loadAutoRestartPrefs, loadNotifyPrefs, loadReportsPrefs: reports.loadReportsPrefs,
    loadTerminalPrefs: stage.loadTerminalPrefs,
    loadAccountPrefs: d => setAccount({ on: d.accountOn === true, vetoed: d.accountVetoed === true }),
  });
  // The setter behind each setting the account can carry, by its schema key
  // (account-ui-fields.ts): applying the account's value is the same act as
  // the reader changing it here.
  const accountAppliers: Appliers = {
    theme: v => setTheme(v as Theme),
    textSize: v => appearance.setTextSize(v as TextSize),
    density: v => appearance.setDensity(v as Density),
    "panels.sessionList": v => { if (v) { if (!sessionListOpen) toggleSessionList(); } else closeSessionList(); },
    "panels.accounts": v => { if (v) openAccountsPanel(); else closeAccountsPanel(); },
    "panels.detail": v => setDetailOpen(v === true),
    "panels.usage": v => setUsagePanelOpen(v === true),
    "panels.machine": v => setMachinePanelOpen(v === true),
    singleKeyShortcuts: v => setSingleKeyShortcuts(v === true),
    hideFinishedAfter: v => setHideFinishedAfter(Number(v)),
    character: v => appearance.setCharacterEnabled(v === true),
    sound: v => sound.setSound(v === true),
  };

  // The controls of the chrome, each defined once, and the edge and group each
  // lives in — rail-items.tsx; drawn by components/EdgeRails.tsx. Under 641px
  // the two stripes and the utilities are one dock along the bottom. (`phone`
  // is asked above, ahead of the stage.)
  const [radioOpen, setRadioOpen] = useState(false);
  // Tool activity, on the view its door names: tools or skills.
  const [toolAuditView, setToolAuditView] = useState<ToolActivityView | null>(null);
  const closeToolAudit = useCallback(() => setToolAuditView(null), []);
  // Skill activity names a session as its rail row does, and opens it on its
  // card, while the card is still drawn.
  const toolAuditSessionLabel = useCallback((sessionId: string) => {
    const card = stateRef.current.agents.get(sessionId);
    return card ? sessionListName(card) ?? "session" : null;
  }, []);
  const openToolAuditSession = useCallback((sessionId: string) => { setToolAuditView(null); openSession(sessionId); }, [openSession]);
  const closeRadio = useCallback(() => setRadioOpen(false), []);
  // Account capacity from the left stripe, on the view its door names —
  // components/AccountCapacityDialog.tsx.
  const [capacityView, setCapacityView] = useState<CapacityView | null>(null);
  const closeCapacity = useCallback(() => setCapacityView(null), []);
  // A ccdeck account's unread conversations, for Feedback's dot: none, and
  // nothing drawn, unless the account's own chunk has published an account.
  const feedbackUnread = unreadOf(useFeedbackAccount());
  const openFeedbackConversations = useCallback(() => dialogs.openFeedback({ initialTab: "conversations" }), [dialogs.openFeedback]);
  const rails = railItems({
    providers, sessionListOpen, toggleSessionList,
    accountsPanelOpen, toggleAccountsPanel, accountsPanelId: panelId(shownAccountProvider),
    codexPanelOpen: accountsPanelOpen && shownAccountProvider === "codex",
    toggleCodexPanel: () => openAccountSide("codex"),
    usagePanelOpen: usageRail.shown, setUsagePanelOpen: usageRail.set,
    machinePanelOpen: machineRail.shown, setMachinePanelOpen: machineRail.set, setUsageHistoryOpen,
    watchOn, watchUnseen, setBrowserWatchOpen, setTrafficRadarOpen: dialogs.setTrafficRadarOpen, openSettings, onFeedback: dialogs.openFeedback,
    setRadioOpen,
    openToolActivity: setToolAuditView,
    openCapacity: setCapacityView,
    toggles: panelReturn.toggles,
    integrations: connectedKinds.map(provider => ({ provider, onPress: () => setIntegrationOpen(provider.kind) })),
    openExploreIntegrations: () => setExploreIntegrationsOpen(true),
    openQuickOpen,
    feedbackUnread, openFeedbackConversations,
    inspectorOpen, toggleInspector,
  });
  /** A phone opens on Sessions, and a row there opens that session's pane when
   *  the deck has a terminal for it (the Command Panel is on), else the
   *  Inspector, a sheet over the list. The pane covers the list, so the list
   *  closes to show it and comes back when the pane is left. */
  const paneFromListRef = useRef(false);
  const pickSession = useCallback((sessionId: string) => {
    if (phone && stage.enabled) {
      if (removedAgentIds.has(sessionId)) bringBack([sessionId]);
      openInPane(sessionId);
      markLanded(sessionId);
      paneFromListRef.current = true;
      closeSessionListToCanvas();
      return;
    }
    // No terminal: the Inspector opens as a sheet and the list stays under it.
    openSession(sessionId);
  }, [openSession, phone, closeSessionListToCanvas, stage.enabled, openInPane, markLanded, removedAgentIds, bringBack]);
  /** A card on the phone's Board opens its session with the Sessions row's own
   *  press, and leaving the pane comes back to the Board, where the tap was. */
  const pickFromBoard = useCallback((sessionId: string) => {
    pickSession(sessionId);
    paneFromListRef.current = false;
  }, [pickSession]);
  // Back from the pane, the phone is on Sessions again.
  const paneOpen = stage.enabled && stage.shell.phase !== "closed";
  const paneWasOpen = useRef(false);
  useEffect(() => {
    if (paneWasOpen.current && !paneOpen) {
      const back = phone && paneFromListRef.current;
      paneFromListRef.current = false;
      if (back && !sessionListOpen) toggleSessionList();
    }
    paneWasOpen.current = paneOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, paneOpen]);
  // ACCOUNTS OVER A PANE. A pane on a phone is the whole screen under the top
  // bar, and a sheet drawn over its header would cover the buttons there (and
  // the Inspector and the other two already give the pane back). So Accounts,
  // asked for from any door or key while a pane is up, takes the right of the
  // deck back from it: the pane goes at once, the list comes back as it does on
  // leaving a pane, and the sheet comes up over the list.
  const accountsWasOpen = useRef(accountsPanelOpen);
  const { giveRightBack } = stage;
  useLayoutEffect(() => {
    const give = accountsGivesPaneBack({ phone, accountsOpen: accountsPanelOpen, accountsWasOpen: accountsWasOpen.current, paneOpen });
    accountsWasOpen.current = accountsPanelOpen;
    if (give) giveRightBack();
  }, [phone, accountsPanelOpen, paneOpen, giveRightBack]);
  const closeAccounts = () => { (providers.claude ? panelReturn.accounts : panelReturn.codex)(); closeAccountsPanel(); };
  // The empty board's notice (nothing seen yet, the stream unreachable, too many
  // tabs). On a phone the Sessions list covers the canvas it would sit on, so
  // the notice is the list's own empty state, the panel's width less 8 a side;
  // the card for a dropped connection already says that one.
  const emptyHero = (reservedRight: number) => boardEmpty ? (!live && tabCapped
    ? <TabCapHero reservedRight={reservedRight} />
    : <EmptyHero live={live} everConnected={everConnected} providers={providers} workspace={workspace} onTour={openTour} reservedRight={reservedRight} />) : null;
  const heroInList = phone && sessionListDrawn && !(everConnected && !live);
  // The four panels that are sheets on a phone: one at a time, Esc and a flick
  // close the one up (use-phone-sheets.ts); nothing here opens or sends.
  const sheets = usePhoneSheets({
    phone,
    open: { accounts: accountsDrawn && accountsPanelOpen, usage: usageRail.shown, machine: machineRail.shown, inspector: detailShown },
    close: {
      accounts: closeAccounts,
      usage: () => { panelReturn.usage(); usageRail.set(false); },
      machine: () => { panelReturn.machine(); machineRail.set(false); },
      inspector: () => { panelReturn.detail(); setDetailOpen(false); },
    },
    // What focus goes back to when a sheet closes: the dock's door, or the
    // session's row in the list.
    openers: {
      accounts: () => (providers.claude ? panelReturn.toggles.accounts : panelReturn.toggles.codex)?.current ?? null,
      usage: () => panelReturn.toggles.usage.current,
      machine: () => panelReturn.toggles.machine.current,
      inspector: () => (primarySelectedId
        ? document.querySelector<HTMLElement>(`.session-list .sl-row[data-session="${CSS.escape(primarySelectedId)}"], .phone-board .pb-card[data-session="${CSS.escape(primarySelectedId)}"]`)
        : null),
    },
    modalOpenRef,
    // The window grew past a phone's width: Accounts and the list in one
    // column become the list, Accounts waiting behind it (an eviction, which
    // is not stored).
    onLeavePhone: leaveColumnPhone,
    // A window narrowed to a phone's width with several panels open draws the
    // one on top; the rest wait shut, in memory, not stored.
    hold: { accounts: holdAccounts, usage: holdRight.usage, machine: holdRight.machine },
    // Where focus goes when what opened a sheet is gone.
    home: () => panelReturn.toggles.sessionList.current,
  });
  /** The Sessions door with a sheet up over the list: it reads not pressed, and
   *  its press is "go to Sessions" (phone-sheet.ts pressSessionsDoor). */
  const sessionsDoorUnderSheet = <T extends { id: string; open?: boolean; onPress: () => void }>(item: T): T =>
    item.id === "session-list" && sheets.sheet != null
      ? { ...item, open: false, onPress: () => pressSessionsDoor({
        sheet: sheets.sheet, listOpen: sessionListOpen, closeSheet: sheets.closeSheet, toggleList: item.onPress,
      }) }
      : item;
  // The L key goes the same way, and so does Quick Open's Sessions row (built
  // from these mapped doors): one path, whoever asks.
  sessionsKeyRef.current = () => pressSessionsDoor({
    sheet: sheets.sheet, listOpen: sessionListOpen, closeSheet: sheets.closeSheet, toggleList: toggleSessionList,
  });
  const quickRails = {
    ...rails,
    left: rails.left.map(sessionsDoorUnderSheet),
    right: rails.right.map(group => group.map(sessionsDoorUnderSheet)),
  };
  /** A sheet's × on a phone is the sheet's one close, whichever sheet it is. */
  const sheetClose = (name: "accounts" | "usage" | "machine" | "inspector", plain: () => void) => (phone ? () => sheets.closeSheet(name) : plain);
  const accountsSwitch = accountSide.both
    ? <AccountsSwitch shown={shownAccountProvider} notices={accountSide.notices} onPick={accountSide.pick} />
    : undefined;
  const sideState = (side: AccountSide) => accountSide.bothMounted ? (side === shownAccountProvider ? "shown" : "hidden") : undefined;
  // One Accounts panel: with both CLIs a switch in its header shows one side
  // and keeps the other mounted (use-account-side.ts).
  const accountsNodes = (
    <>
      {accountsDrawn && (shownAccountProvider === "claude" || accountSide.bothMounted) && (
        <AccountsPanel leaving={isLeaving(accountsPanelOpen, accountsPhase)} onReport={dialogs.openFeedback}
          onRoster={attention.observe} onClose={sheetClose("accounts", closeAccounts)}
          lanWanted={lanWanted} onLanShown={lanShown} onLanAccounts={setClaudeLan} codexLanAccounts={codexLan} switcher={accountsSwitch}
          side={sideState("claude")} onNotice={accountSide.noteClaude}
          planLabel={meterQuota.reading?.planLabel ?? null} />
      )}
      {accountsDrawn && (shownAccountProvider === "codex" || accountSide.bothMounted) && (
        <CodexAccountsPanel leaving={isLeaving(accountsPanelOpen, accountsPhase)}
          onClose={sheetClose("accounts", closeAccounts)} switcher={accountsSwitch}
          side={sideState("codex")} onNotice={accountSide.noteCodex}
          lanAccounts={lanOffered} lanReady={!providers.claude || claudeLan != null}
          lanWanted={lanWanted} onLanShown={lanShown} onLanAccounts={setCodexLan} />
      )}
    </>
  );

  return (
    // data-view exists only in Workspace, so with the Command Panel off the
    // root is the root it was; data-zoom folds the list and the Inspector
    // (workspace.css); the switch between the views is view-switch.ts.
    <div ref={appRef} className="app" data-view={inWorkspace ? "workspace" : undefined} data-zoom={zoomPhase} data-side={side.on ? "" : undefined} data-right-col={rightCol ? "" : undefined}>
      {/* Whether the deck has a session yet, for every part drawn below that
          stays out until it does (board-empty.ts). No element: the grid's
          children are the ones they were. */}
      <BoardEmptyContext.Provider value={boardEmpty}>
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
      {inWorkspace
        ? <a className="skip-link" href={`#${WORKSPACE_PANE_ID}`} onClick={e => { if (skipToPane()) e.preventDefault(); }}>{t(SKIP_TO_PANE_MSG)}</a>
        : <a className="skip-link" href="#canvas">{t("shell.skipToCanvas")}</a>}
      <header className="topbar">
        <DesktopTitlebar />
        {/* The observation group, and the notes on each readout in it — components/TopbarReadouts.tsx. */}
        <ReadoutGroup
          versionCheck={versionCheck} welcome={welcome} desktopUpdate={desktopUpdate} pause={pause}
          announcements={announcements} notify={notify} waitingSessions={waitingSessions}
          waitingCursorRef={waitingCursorRef} focusSession={focusSessionOnView} live={live} now={now}
          incidents={incidents} counts={counts} asksSaid={stage.enabled ? asks.said : undefined}
        >
          {/* Board | Workspace, left of the search field in the right-hand
              group: only where the Command Panel is on (use-view.ts), and never
              on a phone, where the Board is the whole of the deck. */}
          {!phone && stage.workspaceOffered && <ViewSwitch view={inWorkspace ? "workspace" : "board"} onChange={switchView} />}
          {/* Search, at the end of the bar (Settings is at the Panel bar's
              foot, Feedback in the corner after it). Who is waiting, by name,
              is the waiting pill's popover, and the selected session is named
              by the Inspector: the ribbon that used to sit between them is gone
              (V4's Figma) — Esc clears the selection, Z frames it. */}
          {!phone && <div className="actions"><UtilityRun items={[rails.search]} /></div>}
        </ReadoutGroup>
        {/* Feedback's own cell, the bar's top-right corner, on every size: over
            the right stripe with the stripe's line beside it, just before the
            OS's window buttons in the desktop app, at the end of the phone's
            bar. Next after Search in the Tab order. */}
        <div className="tb-corner"><UtilityRun items={[rails.corner]} /></div>
      </header>

      {/* The left stripe, ahead of the column it opens so Tab reaches the
          control before the region it discloses — or, on a phone, the dock
          that stands in for both stripes and the utilities. */}
      {phone
        // Five doors, as the phone frame draws them: Accounts, Sessions, Usage,
        // Machine and More. Settings and the rest are in More; Feedback is in
        // the bar's corner, so More has no row for it. One door is
        // active at a time: Sessions gives way while a sheet is up over it, and
        // then its press means "go to Sessions" (the sheet closes, the list
        // stays), so the door never says closed and does the other thing.
        // The Command Panel is a row of More, after Search, while the deck has a
        // terminal: the phone's Board draws no canvas bar to hold its button.
        ? <EdgeDock
            items={[...rails.left, ...rails.right[0]].map(sessionsDoorUnderSheet)}
            more={[rails.search, ...commandPanelMore(stage.enabled ? stage.openFromButton : undefined), ...rails.capacity, ...rails.right.slice(1).flat(), ...rails.integrations, ...rails.explore, ...rails.utilities.filter(item => item !== rails.corner)]}
            offline={everConnected && !live} />
        : <EdgeRail side="left" label={t("board.rail.tools")} groups={rails.leftStripe} foot={rails.leftFoot} />}

      {/* Mounted whether or not anything was removed, for the reason the
          topbar's alarm region is (#372): words that arrive with their region
          are the ones screen readers drop. */}
      <div className="vis-hidden" role="status" aria-atomic="true">
        {removalNotice ? t("shell.board.removed", { label: removalNotice.label }) : ""}
      </div>
      {/* What the terminal stage says — a session on the stage, ended, closed
          and still running — once per change and never its output (#372).
          Mounted as soon as the flag is known to be on, for the same reason as
          the region above; never while it is off. */}
      {stage.enabled && <div className="vis-hidden" role="status" aria-atomic="true">{stage.said}</div>}
      {/* At most one banner under the topbar, and which — components/DeckBanner.tsx. */}
      <DeckBanner
        restart={restart} versionCheck={versionCheck} upgrade={upgrade} oldNameNotice={oldNameNotice}
        rating={rating} onFeedback={dialogs.openFeedback}
        everConnected={everConnected} live={live} paused={paused} phone={phone}
        lastNewsAt={lastNewsAt} cardInList={sessionListDrawn}
      />

      {/* The left column, one element both panels are drawn in: its width is
          the open panel's, eased from the last one, and a switch cross-fades
          the two inside it — components/LeftColumn.tsx. */}
      {/* On a phone Accounts is a sheet over Sessions, so it is drawn outside the
          column (a sheet inside the column's stacking layer would sit under the
          scrim) and the column holds the list alone. */}
      {phone && accountsNodes}
      {(sessionListDrawn || accountsDrawn) && (
        <LeftColumn width={leftColumnTarget}>
          {!phone && accountsNodes}
          {sessionListDrawn && (
            <SessionList
              leaving={isLeaving(sessionListOpen, sessionListPhase)}
              state={stateRef.current}
              now={now}
              selectedIds={selectedIds}
              onSelect={pickSession}
              onClose={() => { panelReturn.sessionList(); closeSessionList(); }}
              removedIds={removedAgentIds}
              onBringBackAll={bringBackAll}
              landed={landed}
              watching={watchingSessions}
              quota={meterQuota}
              activeAlias={attention.accounts?.find(a => a.active)?.alias ?? null}
              onOpenUsage={() => usageRail.set(o => !o)}
              onOpenKeys={inWorkspace ? openSessionWithKeys : undefined}
              onNewSession={inWorkspace && stage.enabled ? stage.newSessionFrom : undefined}
              offline={phone && everConnected && !live && !restart.restarting ? <OfflineCard lastNewsAt={lastNewsAt} /> : undefined}
              emptyNotice={heroInList ? emptyHero(0) : undefined}
            />
          )}
        </LeftColumn>
      )}
      {/* WORKSPACE: the cell the canvas would have, measured for the pane while
          the canvas itself is held at the Board's box (view-switch.ts). */}
      {inWorkspace && <div className="ws-cell" aria-hidden="true" />}
      {/* <main>, the canvas: the listeners that have to sit on all of it, and
          the drag-to-remove zone and the peek drawn over it —
          components/CanvasMain.tsx. What is drawn on it is App's, below. */}
      <CanvasMain
        canvasRef={canvasRef} bubbling={bubbling} dragging={dragging} trash={trash} zoom={zoom}
        viewport={viewport} stateRef={stateRef} peek={peek}
        stagePhase={stage.enabled && stage.shell.phase !== "closed" ? stage.shell.phase : undefined}
        joins={historyReplayed && settled} closing={closing}
      >
        {!heroInList && emptyHero(phone ? 0 : railInsetRef.current)}
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
        {!phone && (presentCats.length > 1 || hiddenCats.size > 0) && (
          <CategoryFilterBar
            catBarRef={catBarRef} catBarOccluded={catBarOccluded}
            presentCats={presentCats} hiddenCats={hiddenCats} toggleCat={toggleCat}
          />
        )}
        {/* A phone's Board is a stack of readable cards, with no free canvas
            and none of its controls — components/PhoneBoard.tsx. The radio
            plays on there without its companion, which would stand on the
            cards. Wider, React Flow and everything drawn in its pane —
            components/BoardFlow.tsx. */}
        {phone ? (
          <>
            <PhoneBoard state={stateRef.current} now={now} watching={watchingSessions} removedIds={removedAgentIds}
              selectedIds={selectedIds} onOpen={pickFromBoard} />
            <RadioExperience fm={fm} character={appearance.character} characterEnabled={false} open={radioOpen} onClose={closeRadio} />
          </>
        ) : (
        <BoardFlow
          graph={graph} layout={layout} viewport={viewport} clicks={clicks} drag={drag}
          appearance={appearance} fm={fm} radioOpen={radioOpen} onRadioClose={closeRadio} autoFit={autoFit} pause={pause}
          stateRef={stateRef} measuredRef={measuredRef} hiddenCats={hiddenCats} now={now}
          openTool={openTool} focusAgent={focusAgent} requestClear={requestClear} setKeyHelpOpen={setKeyHelpOpen}
          zoomBy={camera.zoomBy} zoomReset={camera.zoomReset}
          onTerminal={stage.enabled ? stage.openFromButton : undefined}
          notesDrawn={zoom.lod === "detail"}
        />
        )}
        {/* The board's compact form while the stage is open, in the canvas's
            place and inside <main> with the board it stands for — components/
            StageSlots.tsx. Nothing at all with the terminal flag off. */}
        <StageNavigatorSlot stage={stage} />
      </CanvasMain>

      {/* The terminal stage itself: laid over the canvas cell's right-hand
          side, but after <main> in the document, so the canvas's capture
          listeners never see a press or a key meant for the terminal and Tab
          reaches it after the board — components/StageSlots.tsx. */}
      <StageDockSlot
        stage={stage} stateRef={stateRef} canvasRef={canvasRef} now={now} palette={palette}
        asks={asks} waitingSessions={waitingSessions}
        onBoard={() => switchView("board", lastInputWasKey() ? "key" : "pointer")}
      />

      <DialogPresence when={toolAuditView}>{view => <ToolAuditModal view={view} onClose={closeToolAudit} sessionLabel={toolAuditSessionLabel} onOpenSession={openToolAuditSession} />}</DialogPresence>
      <DialogPresence when={capacityView}>{view => <AccountCapacityDialog view={view} onClose={closeCapacity} />}</DialogPresence>
      <DialogPresence when={integrationOpen}>{kind => (
        <IntegrationModal kind={kind} connections={kindOffered(integrations, kind) ? connectionsOf(integrations, kind) : []}
          onClose={closeIntegration} onReconnect={reconnectIntegration} />
      )}</DialogPresence>
      <DialogPresence when={exploreIntegrationsOpen}>{() => <ExploreIntegrationsModal integrations={integrations} onClose={closeExploreIntegrations}
        onOpen={setIntegrationOpen} onConnect={connectIntegration} onManage={manageIntegration} />}</DialogPresence>
      {/* Built while it is open only, from the same doors, rows and presses
          the chrome draws, so it can never offer something the deck does not. */}
      {quickOpenOpen && (
        <QuickOpen onClose={closeQuickOpen} onRun={runQuick} items={quickOpenItems({
          rails: quickRails, sessions: buildRows(stateRef.current, now), openSession: pickSession,
          settings: indexFor(providers.claude, integrationsReach(integrations), offeredKinds(integrations)), openSettings,
          singleKeys, fit: handleFit, rearrange: handleRelayout, phone, paused, togglePause,
          clear: boardEmpty ? undefined : () => requestClear("button"),
          nextWaiting: blockedSessions(stateRef.current.agents.values()).length > 0 ? quickNextWaiting : undefined,
          start: quickStart(),
          keyHelp: () => setKeyHelpOpen(true), tour: openTour, theme: appearance.theme, setTheme,
        })} />
      )}

      {/* THE RIGHT-HAND RAILS COME AFTER THE CANVAS (#880). Both are position:
          fixed, so where they sit in the DOM changes nothing on screen — only
          where Tab goes. Rendered ahead of the left column, as they used to be,
          they sent a keyboard reader's focus topbar, right, left, right, centre;
          here it reads the way the page does: the left column, the canvas,
          these two, then the detail panel at the far right. */}
      {/* THE RIGHT STRIPE, ahead of the panels it opens so Tab reaches the
          control before the region it discloses: the left stripe, the left
          column, the canvas, this stripe, then its panels and the Inspector.
          Fixed to the window's right edge, so where it sits in the document
          changes nothing on screen. */}
      {!phone && <EdgeRail side="right" label={t("shell.rail.right")} groups={rails.rightStripe} />}

      {/* The Board's right column: Usage, This machine, then the Inspector, top
          to bottom (panel-place.css). Always drawn, so nothing in it remounts
          when it comes and goes; no box at all in Workspace, on a phone, or
          with nothing in it, where each part is laid out as it always was. */}
      <div className="right-col">
      {/* Both inside Workspace's side column, which is a track of the grid
          there with a part docked and nothing on the Board (SideColumn.tsx), so
          a panel never remounts when it docks, floats or the view switches. */}
      <SideColumn on={side.on} split={side.split} width={side.width} share={side.share} onWidth={side.setWidth} onShare={side.setShare}>
      {isMounted(usagePhase) && (
        <UsagePanel
          state={stateRef.current}
          now={now}
          providers={providers}
          incidents={incidents}
          liveSince={liveSince}
          leaving={usagePhase === "leaving"}
          dock={docks.usage}
          onClose={sheetClose("usage", () => { panelReturn.usage(); setUsagePanelOpen(false); })}
        />
      )}

      {/* Mounted only while it is open, which is also what starts its poll: the
          topbar meter used to keep /api/system running for the life of the tab
          on behalf of a readout that is gone. `usageOpen` moves it one rail
          slot left when usage has the first one — see .sysdetail.shifted. */}
      {isMounted(machinePhase) && (
        <MachinePanel usageOpen={usagePanelOpen} leaving={machinePhase === "leaving"} dock={docks.machine}
          onClose={sheetClose("machine", () => { panelReturn.machine(); setMachinePanelOpen(false); })} />
      )}
      </SideColumn>

      {/* NOTHING SELECTED, NO PANEL. It used to draw an `EmptyDetail` — a title,
          "Click an agent to see its tools", and a fifteen-row shortcut list —
          which is a 360px column of the canvas spent on a sentence and a copy
          of a reference that already has a complete version behind `?`. The
          panel is about an agent; with no agent there is nothing for it to be
          about, and the canvas gets the width back.
          `:not(:has(.detail))` in the sheet already drops the column, so this
          needed no layout change of its own. */}
      {/* WORKSPACE draws the Inspector as a column whether or not a session is in
          focus (an empty pane means none, and the column says so), down to 1320px;
          under that it is the detail sheet, opened as on the Board. */}
      {inWorkspace && inspectorColumn && !inspectorFolded && !(detailOpen && selected) ? (
        selected ? (
          <DetailAside
            selected={selected} now={now} openTool={openTool} setSummaryFor={setSummaryFor}
            stateRef={stateRef} removeSelectedNode={removeSelectedNode}
            onSelectAgent={selectInspected}
            workspace
            onClose={foldInspector}
          />
        ) : <EmptyInspector />
      ) : null}
      {detailOnScreen ? (
        <DetailAside
          workspace={inWorkspace} leaving={detailLeaving} sheet={inspectorSheet}
          selected={detailOnScreen} now={now} openTool={openTool} setSummaryFor={setSummaryFor}
          stateRef={stateRef} removeSelectedNode={removeSelectedNode}
          onSelectAgent={selectInspected}
          onClose={inWorkspace && (inspectorColumn || inspectorSheet) ? foldInspector : sheetClose("inspector", () => { panelReturn.detail(); setDetailOpen(false); })}
        />
      ) : null}
      </div>

      {/* A phone's sheets lie over a scrim; a press on it closes the one up. */}
      {phone && <div className="phone-scrim" data-open={sheets.sheet ? "" : undefined} aria-hidden="true" onClick={() => sheets.closeSheet()} />}

      {account.on && <Suspense fallback={null}><AccountBridge appliers={accountAppliers} /></Suspense>}

      {/* The foot of the shell: the grid's fourth row, under the canvas, the
          columns and the stripes (not drawn on a phone, where the dock is) —
          components/StatusBar.tsx. */}
      {!phone && <StatusBar stageOpen={stage.enabled && stageClaimsKeys(stage.shell.phase)} zoomedOut={zoom.lod !== "detail"} viewChord={stage.workspaceOffered ? (inWorkspace ? "board" : "workspace") : null} waiting={waitingSessions.length > 0} version={version?.running ?? null} onVersion={welcome.openReleaseNotes} />}
      </BoardEmptyContext.Provider>

      {/* The dialogs, in the order they paint over one another — components/DeckDialogs.tsx. */}
      <DeckDialogs
        dialogs={dialogs} welcome={welcome} desktopUpdate={desktopUpdate} versionCheck={versionCheck} restart={restart}
        upgrade={upgrade} lanPairs={lanPairs} attention={attention} clearFlow={clearFlow} watchBadge={watchBadge} announcements={announcements}
        appearance={appearance} providers={providers} stateRef={stateRef} agentCount={agentCount}
        menus={menus} sound={sound} tones={tones} customTones={customTones} notify={notify}
        terminal={{ on: stage.enabled, supported: stage.supported, windows: stage.windows, phone, failed: stage.chunkFailed, toggle: stage.toggleTerminal }}
        panelDoors={{ accounts: openAccounts, localNetwork: openLocalNetwork }}
        account={account}
      />
    </div>
  );
}
