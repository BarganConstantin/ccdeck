import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  ControlButton,
  MiniMap,
  type Edge,
  type Node,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useStoreApi,
  type ReactFlowState,
} from "reactflow";
import AgentNode, { waitingSentence } from "./components/AgentNode";
import { shortModel, modelFamily } from "./model-label";
// Keeps a side panel mounted long enough to animate out — see panel-exit.ts
// for why `{open && <Panel/>}` cannot do that on its own.
import { usePanelPresence, isMounted } from "./panel-exit";
import ToolModal from "./components/ToolModal";
import SessionClusters from "./components/SessionClusters";
import SessionGroupNode from "./components/SessionGroupNode";
import RecapNoteNode, { type RecapNoteData } from "./components/RecapNoteNode";
import RecapTieEdge from "./components/RecapTieEdge";
import ToolBursts, { mcpChipIdentity } from "./components/ToolBursts";
import SessionSummary from "./components/SessionSummary";
import ContextModal from "./components/ContextModal";
import SessionList from "./components/SessionList";
import UsagePanel from "./components/UsagePanel";
import MachinePanel from "./components/MachinePanel";
import AccountsPanel from "./components/AccountsPanel";
import {
  activeCount, autoRestartLabel, autoRestartRemainingMs, autoRestartStep, restartEndedInFailure,
  restartLandingStep, restartSafety, upgradeFailureId,
} from "./restart";
import { copyText } from "./copy-text";
import { laneMap, snapshotToFlow, type FlowNodeData } from "./canvas-flow";
import { exportFileName, sessionExport } from "./session-export";
import { canvasModalOpen, isBrowserChord, isTypingTarget, ownsKeystroke, type FocusTarget, shortcutBlocked } from "./shortcuts";
import ClearConfirm from "./components/ClearConfirm";
import KeyboardHelp from "./components/KeyboardHelp";
import GuideModal from "./components/GuideModal";
import { WELCOME_STEPS } from "./components/guide-art";
import SoundMenu from "./components/SoundMenu";
import AppearanceMenu from "./components/AppearanceMenu";
import ClaudeFm from "./components/ClaudeFm";
import { CHARACTER_ENABLED_KEY, FM_SOURCE_KEY, FM_VOLUME_KEY, storedCharacterEnabled, storedFmSource, storedFmVolume } from "./appearance";
import type { FmSource } from "./appearance";
import { newTabId, PRESENCE_BEAT_MS, presenceShouldSend, tabLooking } from "./presence";
import ReleaseNotesModal from "./components/ReleaseNotesModal";
import { clearActionFor, type ClearSource } from "./clear-confirm";
import { escapeOutcome, modalStack } from "./modal-dismiss";
import { canvasKeyIntent, shouldReleaseFocusOnEscape, stepTarget } from "./canvas-keys";
import { pruneSelection, sweepTick } from "./prune";
import { REMOVED_NODES_KEY, readRemovedNodes, saveRemovedNodes, visibleBoard } from "./remove-node";
import { spotlightUnion } from "./spotlight";
import { type Provisional } from "./placement";
import { createRenderCoalescer } from "./coalesce";
import { createPauseGate } from "./pause";
import { readStored } from "./storage";
import { THEME_KEY, storedTheme, type Theme } from "./theme";
import { CENSUS_CHANNEL, joinCensus, tooManyTabs } from "./tab-census";
import { PRODUCT } from "./brand";
import { ambientSignal, FAVICON_HREF, type AmbientSignal } from "./ambient";
import { blockedSessions, nextWaiting, runningSessionCount } from "./ambient-counts";
import { blockedAnnouncement, nextAnnouncement } from "./block-announce";
import { blockKey, canAsk, mayRaise, nextRaised, noticesFor, seedRaised, shouldReseed, shouldSeedFromWorld } from "./notify";
import type { NotifyPermission } from "./notify";
import { categoryFor, type ToolCategory } from "./tool-taxonomy";
import type { WatchEpisode } from "./components/BrowserWatchModal";
import { SEEN_KEY, unseenEpisodes } from "./browser-watch-seen";
// Loaded when they open (#883). Both are opened rarely and each is a large
// file; imported here, they were in the one bundle every reload and every deck
// opened from another machine had to fetch before drawing anything. The topbar
// needs only Browser Watch's unseen count, which lives in browser-watch-seen.
const UsageHistoryModal = lazy(() => import("./components/UsageHistoryModal"));
const BrowserWatchModal = lazy(() => import("./components/BrowserWatchModal"));
import LanPairRequestModal, { nextRequest } from "./components/LanPairRequestModal";
import { LAN_POLL_OFF_MS, LAN_POLL_ON_MS, withAliases } from "./components/LanSyncSection";
import type { LanStranger } from "./components/LanSyncSection";
import { columnsWouldChange, type Frame } from "./layout";
import { applyEvent, findToolOnBoard, initialState, noteDroppedEvents, settlesInFlightCall, type GraphState } from "./reducer";
import { isAgentVisible, computeVisibleIds, anyTouches } from "./visibility";
import { SESSION_GROUP_TYPE, minimapNodeColor, type MinimapNode } from "./minimap";
import { paletteReader, readPalette, samePalette, type Palette } from "./palette";
import { parseLayoutFrame, parseStoredLayout, restoreLayout, serializeLayout, type StoredLayout } from "./stored-layout";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, parseStoredViewport, type StoredViewport } from "./stored-viewport";
import { selfPressAccepted, selfPressProps } from "./panel-press";
import { isUserViewportGesture } from "./viewport-intent";
import { shouldAnimateViewport } from "./viewport-motion";
import { shouldRefit, type NodeBox, type PaneSize } from "./drift";
import { fitZoomForDrawnLanes, nextLod, referenceCard, type CardSize, type LodMode } from "./semantic-zoom";
import { focusViewport, unionBox, type FlowBox } from "./focus-camera";
import SessionPeek, { hidePeek, showPeek } from "./components/SessionPeek";
import { fmtCost, fmtCostRate } from "./pricing";
// The topbar strip, the burn ticker, the selected-session ribbon and the detail
// panel all multiply usage by a price, and all four used to multiply a whole
// session's cumulative tokens by the one model it was last seen on. See
// usage-models.ts (#686).
import { agentCost, otherModelIds } from "./usage-models";
import { fmtTokens } from "./token-format";
import { inDesktopApp } from "./in-app";
import { readDesktopUpdate, readyDesktopUpdate, type DesktopUpdateState } from "./desktop-update";
import { injectedPrompt, typedPrompts } from "./injected-prompt";
import { recapShown } from "./session-recap";
import { useRecapNotesVersion } from "./recap-note";
import { noticeIsOpen, noticeKeyFor, versionChipLabel, versionChipTitle, versionNoticeLabel } from "./version-chip";
// #712. What to show, and what to record as seen, is decided there rather
// than here: it is the one part of this feature that can be wrong, and a
// pure function over what the store said, what is running and what shipped
// is the only shape a DOM-less suite can ask "what would a user upgrading
// 1.42 to 1.48 have been shown?" — or, since #717, "what does somebody who
// has never run this see on the release they just installed?".
import {
  decideReleaseNotes,
  decideWelcome,
  readTourSeen,
  writeTourSeen,
  notesBetween,
  readSeen,
  RELEASE_NOTES,
  remembersSeen,
  seenStore,
  writeSeen,
  type VersionNotes,
} from "./release-notes";
import { emptyScope } from "./scope";
import { ASSUMED, readProviders, type Providers } from "./providers";
import { captureHints, finishSoundTitle } from "./provider-copy";
import {
  chimeFor, clampLevel, createChimePlayer, figureIdFrom, FIGURE_KEYS, LEVEL_KEYS,
  PREVIEW_DELAY_MS, readPrefs,
  type Chime, type ChimeState, type TonePrefs, type ToneSettings,
} from "./sound";
import { outageSentence, PAUSE_LABEL, pauseTitle, statusPill } from "./status-pill";
import { promptTime, shortAgo } from "./relative-time";
// The detail panel used to spell both of these out inline — an elapsed clock a
// tier shorter than the agent card's, and a tool duration a decimal place
// coarser than the dialog the same row opens (#374). See duration.ts.
import { elapsed, toolDuration } from "./duration";
import CostBar from "./components/CostBar";
import type { AgentNodeData, HookEnvelope, ToolCall } from "./types";

/**
 * One custom property, resolved off the document.
 *
 * This is a real style resolution every time it is called, which is why it has
 * exactly two callers now and both of them are `readPalette` (#613). It used to
 * be reached from the JSX — including once per node, per frame, through the
 * minimap's `nodeColor` — and everything it reads only changes when the theme
 * flips. Nothing on the render path may call it; see palette.ts.
 */
function cssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "";
}

const nodeTypes = { agent: AgentNode, sessionGroup: SessionGroupNode, recapNote: RecapNoteNode };
/** The recap note's tie to its card — see RecapTieEdge. At module scope like
 *  nodeTypes, since a new object each render makes React Flow warn and remount. */
const edgeTypes = { recapTie: RecapTieEdge };

/** The class React Flow puts on the wrapper it renders around every node — the
 *  element it makes tabbable, not the .agent-node card AgentNode draws inside
 *  it. That distinction is the whole reason the keyboard handling lives in
 *  App.tsx: a keydown fires on the focused wrapper and bubbles UP, so an
 *  onKeyDown on AgentNode's own root would never see it. */
const RF_NODE_CLASS = "react-flow__node";

/** True when this element IS a node wrapper. Deliberately not a `closest()`
 *  walk: the context donut inside a card is a real <button> with its own
 *  Enter, and matching an ancestor would have answered the donut's keys too. */
function isCanvasNodeElement(el: Element | null | undefined): boolean {
  return !!el && el.classList?.contains?.(RF_NODE_CLASS) === true;
}

/** The margin and fill fitLeft frames the board with. The layout packs the
 *  board for the same frame, so the two cannot disagree about what fits. */
const FIT_MARGIN = 80;
const FIT_FILL = 0.86;

/** How much of the canvas's right edge the rail covers.
 *
 *  The machine and usage panels are `position: fixed` over the canvas rather
 *  than a grid column beside it, so the canvas's own width counts the strip
 *  under them as room. A board packed and fitted into that strip puts its
 *  right-hand column under the panels — the one thing spreading the board
 *  sideways must never do. Measured rather than derived from the panel flags,
 *  like the canvas itself, so it stays right whether one panel is open or both
 *  are, and wherever the detail panel has pushed the rail. A panel on its way
 *  out is already gone as far as the board is concerned. */
function railCover(canvas: Element | null): number {
  if (!canvas) return 0;
  const box = canvas.getBoundingClientRect();
  let left = box.right;
  for (const el of document.querySelectorAll(".sysdetail:not(.leaving), .usage-panel:not(.leaving)")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.left > box.left) left = Math.min(left, r.left);
  }
  return Math.max(0, box.right - left);
}

/** Move the keyboard onto an agent card. Used when j/k traverses while the
 *  keyboard is already on the canvas, so the card the selection moved to is
 *  also the card Enter and Tab now speak about.
 *
 *  preventScroll because the canvas is a transformed plane inside a fixed-size
 *  box: the browser's own "scroll it into view" would shove the whole layer
 *  sideways behind the panels, and fitView is already bringing the node on
 *  screen properly. CSS.escape because an agent id is a session id and has
 *  never been promised to be a bare identifier. */
function focusCanvasNode(id: string): void {
  try {
    const el = document.querySelector(`.${RF_NODE_CLASS}[data-id="${CSS.escape(id)}"]`);
    (el as HTMLElement | null)?.focus({ preventScroll: true });
  } catch {}
}

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

/**
 * How long a session takes to slide out of the way of one that grew.
 *
 * Long enough to be followed — the point of animating it at all is that the
 * user sees WHY a card moved — and short enough that the canvas is settled
 * again before they act on it. Mirrored in the .bubbling rule in styles.css.
 */
const BUBBLE_MS = 420;

// Padding of the invisible session drag-handle node. Matches SessionClusters'
// PAD so the handle lines up with the card's body (the card's header strip is
// left uncovered so its label stays clickable).
const GROUP_PAD = 18;

/** How long React Flow's own opening fit takes, when there is anyone watching
 *  it. Named because the answer to "should this animate" is asked of it too. */
const OPENING_FIT_MS = 400;
/** How long a focus takes to arrive (focusAgent): the fit's own pace, a little
 *  quicker, because the reader asked for this one and is waiting on it. */
const FOCUS_MS = 450;
const LAYOUT_STORAGE_KEY = "agent-dag.layout";
/** The frame the stored layout was packed into columns for — see #995. */
const LAYOUT_FRAME_KEY = "agent-dag.layoutFrame";
const VIEWPORT_STORAGE_KEY = "agent-dag.viewport";
const SESSION_LIST_OPEN_KEY = "agent-dag.sessionListOpen";
const DETAIL_OPEN_KEY = "agent-dag.detailOpen";
const USAGE_PANEL_OPEN_KEY = "agent-dag.usagePanelOpen";
/** Named for the panel it opens rather than for the button, which is how it
 *  survived the button changing: this key was written by a topbar meter that
 *  no longer exists, and a tab that had the panel open still finds it open. */
const MACHINE_PANEL_OPEN_KEY = "agent-dag.systemPanelOpen";
const ACCOUNTS_PANEL_OPEN_KEY = "agent-dag.accountsPanelOpen";
const VERSION_DISMISSED_KEY = "agent-dag.versionNoticeDismissed";
// Which old command the name notice has already been dismissed for — the name
// itself, not a boolean. Somebody who dismisses it under `agent-dag` and later
// starts the deck as `agents-deck` is a second install that has not heard this
// yet, and a flag would silence it. In the agent-dag.* namespace like every
// other key here; brand.ts explains why the rename stops at the storage layer.
const OLD_NAME_DISMISSED_KEY = "agent-dag.oldNameNoticeDismissed";
// How stale the last registry lookup may get before a poll asks npm again
// instead of accepting the server's cached answer. Three times the poll
// interval: often enough that a release shows up while you are looking at the
// deck, rare enough that the cost stays the one request the README advertises.
const VERSION_FORCE_MS = 15 * 60_000;

// What GET /api/version answers. `running` is the version this server process
// booted with; `installed` is what is on disk right now. They diverge the
// moment npm upgrades a deck that is already running, and Node's module cache
// means the process keeps executing the old code until it restarts.
type VersionNotice = { kind: "restart" | "upgrade"; from: string; to: string };
type VersionInfo = {
  /** The package the server asked npm about, which is the one its `command`
   *  would install — `ccdeck` for a deck started with `npx ccdeck`. */
  name: string;
  running: string | null;
  installed: string | null;
  /** npm's newest version that is confirmed installable under `name`. */
  latest: string | null;
  /** A version npm's dist-tag names that the registry cannot serve yet. Never
   *  offered: the tag moves before the version does, and a restart taken inside
   *  that window fails with ETARGET. */
  latestPending?: string | null;
  notice: VersionNotice | null;
  command: string;
  // False when nothing is supervising the process, or when --no-persist means a
  // restart would take the canvas with it.
  canRestart?: boolean;
  /** When npm was last asked, so the chip can say it. Null when the check is off. */
  checkedAt?: number | null;
  /** When the last attempt FAILED, null once one succeeds.
   *
   *  Computed, serialised, delivered — and until #1046 declared nowhere on this
   *  side, so it was dropped at the door. The server's own comment says what it
   *  is for: "the single most common reason for a missing update button — a
   *  proxy, a flaky line, an offline machine — is indistinguishable from being
   *  up to date" without it. And `checkedAt` deliberately does NOT move on a
   *  failure ("checked 2 minutes ago" over an hour-old answer is the one thing
   *  that field must never say), so on a machine behind a proxy the chip said
   *  `checked 3h ago` beside a cached `npm has vX` and offered nothing, with
   *  the one fact that explained it sitting unread in the response. */
  checkFailedAt?: number | null;
  checkDisabled?: boolean;
  /** Why an in-app `npm i -g` is refused here, or null when it is allowed. */
  upgradeBlocked?: string | null;
  /** How this copy can update itself: install in place, come back through npx,
   *  or not at all — in which case the command is the whole answer. */
  upgradeMode?: "install" | "npx" | null;
  /** `at` is when the failure was recorded — the only thing that tells one
   *  failed npx relaunch from the one before it, since a retry that breaks the
   *  same way reports the same command and the same error. */
  upgrade?: { state: "idle" | "running" | "done" | "failed"; command: string | null; error: string | null; at?: number | null };
  /** Which of the three published commands the user typed, when the server can
   *  prove it — and null everywhere it cannot: a global install on Windows,
   *  where npm's shim swallows the name before the process starts, and a git
   *  checkout, where nothing was typed. Never guessed, so a null here means the
   *  notice below stays away rather than that it picks the likeliest name.
   *  Deliberately separate from `name` above, which is the upgrade target: for
   *  a global install that is the published package whichever bin was run. */
  invokedAs?: string | null;
  /** The second line of that notice, already written: the command to type next
   *  time under npx, and the reassurance that it is on the PATH already for an
   *  install — the same one ships all three. Null when there is nothing to say,
   *  which is every shape where `invokedAs` above is null too.
   *
   *  A string rather than a flag, and computed on the server rather than here,
   *  because the browser has no honest way to tell those two apart on its own —
   *  the field it used to guess from (`upgradeMode`) answers whether this copy
   *  may install over itself, which `AGENTS_DECK_NO_INSTALL=1` turns off for
   *  npx and global installs alike. The terminal row renders this same string
   *  from this same function, which is what keeps the two surfaces one answer. */
  renameFix?: string | null;
};

// Said in the UI's voice, not npm's. Each of these is a decision we made on
// purpose, so each gets a reason rather than a disabled button.
const UPGRADE_BLOCK_TEXT: Record<string, string> = {
  git_checkout: "this deck runs from a git checkout — pull instead:",
  npx: "npx runs from a cache that cannot be upgraded in place — run:",
  not_writable: "the install directory is not writable by this user — run:",
  opted_out: "installs are off (AGENTS_DECK_NO_INSTALL=1) — run:",
  // The deck was installed under a name npm no longer serves a deck for, so
  // reinstalling it would fetch a pointer package and take this install with
  // it. The command beneath this moves the machine onto the published name,
  // which is the only update it can have.
  retired_name: "this install came from a name that is no longer published — run:",
};

const AUTO_RESTART_KEY = "agent-dag.autoRestart";
// Per-tab, not per-browser: it guards one reload, not a preference.
const BUNDLE_RELOAD_KEY = "agent-dag.bundleReloadedFor";

// First-run layout: Usage and Accounts open, everything else closed. Those two
// answer "how much have I got left, and on which account" — the questions you
// have before you have a graph worth looking at. The session list and detail
// panel are for navigating work that already exists, so they stay shut until
// asked for, and the canvas gets the width.
function loadSessionListOpen(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(SESSION_LIST_OPEN_KEY) === "1"; } catch { return false; }
}
function saveSessionListOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(SESSION_LIST_OPEN_KEY, open ? "1" : "0"); } catch {}
}
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

/** The stored arrangement. The format, its v1 migration and what a garbled
 *  value reads as are parseStoredLayout's (#1174); the try is for the storage
 *  read itself, which can throw on its own. */
function loadLayout(): StoredLayout {
  if (typeof window === "undefined") return { positions: [], pins: [] };
  try {
    return parseStoredLayout(window.localStorage.getItem(LAYOUT_STORAGE_KEY));
  } catch { return { positions: [], pins: [] }; }
}

function saveLayout(
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, serializeLayout(positions, pinned));
  } catch { /* quota / private mode — ignore */ }
}

/**
 * The frame the stored layout's column count was chosen for.
 *
 * Kept beside the layout rather than inside it because it answers a different
 * question: `loadLayout` restores WHERE the nodes were, this restores WHAT THE
 * BOARD WAS SHAPED FOR. A deck reopened on a different monitor restores a
 * perfectly valid set of coordinates that were packed for a frame this window
 * does not have, and without this there is nothing to compare the new frame
 * against — the board comes back as however many columns the old window wanted
 * and stays that way until R (#995).
 *
 * Null when absent, which is what every layout stored before this existed reads
 * as. That is "no evidence", not "a frame of zero": the reframe effect records
 * the first measurement and compares nothing.
 */
function loadLayoutFrame(): Frame | null {
  if (typeof window === "undefined") return null;
  try {
    return parseLayoutFrame(window.localStorage.getItem(LAYOUT_FRAME_KEY));
  } catch { return null; }
}

function saveLayoutFrame(frame: Frame): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(LAYOUT_FRAME_KEY, JSON.stringify(frame)); } catch {}
}

/** The viewport the canvas was last left at, or null. What it has to be to
 *  count — and why a zero zoom does not — is parseStoredViewport's (#1006);
 *  the try is for the storage read itself, which can throw on its own. */
function loadViewport(): StoredViewport | null {
  if (typeof window === "undefined") return null;
  try {
    return parseStoredViewport(window.localStorage.getItem(VIEWPORT_STORAGE_KEY));
  } catch { return null; }
}

function saveViewport(vp: { x: number; y: number; zoom: number }): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(vp)); } catch {}
}

function clearStoredLayout(): void {
  if (typeof window === "undefined") return;
  // Per-key try/catch so a failure removing one (quota / locked store)
  // doesn't strand the other.
  try { window.localStorage.removeItem(LAYOUT_STORAGE_KEY); } catch {}
  try { window.localStorage.removeItem(VIEWPORT_STORAGE_KEY); } catch {}
  // The frame goes with the layout it describes. Left behind, it claims the
  // board that R is about to rebuild was packed for a window that may not be
  // the one on screen, and the first frame change would relayout again.
  try { window.localStorage.removeItem(LAYOUT_FRAME_KEY); } catch {}
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

// Tool categories used both by the detail-panel strip and the canvas filter
// chips. These are the buckets ToolBursts tints its bubbles by, and they used
// to be a second copy of that table living here, "kept in sync manually —
// small enough that a shared module isn't worth it". It was not: when Codex
// renamed its shell tool to `exec` the copy here went on filing it under
// "other" while the canvas coloured it grey, and the two were only ever going
// to drift again (#417). Both now read the one table in tool-taxonomy.ts.
type DetailCategory = ToolCategory;
const DETAIL_CAT_EMOJI: Record<DetailCategory, string> = {
  file: "📁", shell: "⚡", web: "🌐", agent: "🤖",
  task: "📋", plan: "🧭", mcp: "🔌", other: "✨",
};
/** The canvas filter bar's glyph for a category: drawn, monochrome, on the
 *  topbar's icon spec (13px on a 14 viewBox, a 1.4 stroke, round caps). The
 *  emoji above stay for the detail rail's activity chips; on the bar they were
 *  eight colours of decoration beside a word that already names the category,
 *  on the one piece of chrome that sits over the canvas. The bubbles and the
 *  nodes carry each category's colour; the bar only has to say which is which. */
const CAT_GLYPH_PATHS: Record<DetailCategory, string> = {
  file: "M3.4 1.8h4.5l2.7 2.7v7.7H3.4z M7.9 1.8v2.7h2.7",
  shell: "M2.4 3.8 5.6 7l-3.2 3.2 M7.4 10.6h4.2",
  web: "M7 1.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 1 0 7 1.8z M1.8 7h10.4 M7 1.8c-1.5 1.4-2.3 3.1-2.3 5.2s.8 3.8 2.3 5.2c1.5-1.4 2.3-3.1 2.3-5.2S8.5 3.2 7 1.8z",
  agent: "M3.3 4.8h7.4a1.2 1.2 0 0 1 1.2 1.2v4.8a1.2 1.2 0 0 1-1.2 1.2H3.3a1.2 1.2 0 0 1-1.2-1.2V6a1.2 1.2 0 0 1 1.2-1.2z M7 4.8V2.4 M5.3 8.2h.01 M8.7 8.2h.01",
  task: "M2.2 4l1.2 1.2 2-2.2 M7.4 4.2h4.4 M2.2 9.4l1.2 1.2 2-2.2 M7.4 9.6h4.4",
  plan: "M7 1.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 1 0 7 1.8z M9 5 8 8 5 9l1-3z",
  mcp: "M5 1.8v2.6 M9 1.8v2.6 M3.6 4.4h6.8v2.2a3.4 3.4 0 0 1-6.8 0z M7 10v2.2",
  other: "M3.5 7h.01 M7 7h.01 M10.5 7h.01",
};
function CatGlyph({ cat }: { cat: DetailCategory }) {
  return (
    <svg className="cat-glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={CAT_GLYPH_PATHS[cat]} />
    </svg>
  );
}
/* An identity map on purpose — kept, not overlooked (#383).
 *
 * Every value below spells its own key, which is exactly what the eight
 * TOOL_CATEGORY rows deleted in the same sweep looked like. They are not the
 * same thing. Those rows sat behind a lookup whose default already returned
 * what they returned, so their presence could not change a rendered pixel;
 * this table is the only place a category's visible TEXT is decided — the
 * chip's `cat-name` span, plus the tooltips on the filter button and on the
 * activity strip. And being a `Record<DetailCategory, string>` it is how the
 * compiler asks for a label the day a ninth ToolCategory member arrives.
 *
 * Inlining `{c}` at those three call sites is what deleting it would mean, and
 * that promotes the union's member identifiers to user-facing prose: renaming
 * one would silently rewrite the UI, and the day `mcp` should read "MCP
 * servers" the map has to come back. One line changes here instead.
 *
 * Read with plain bracket access on purpose: unlike the tables #474 fixed, the
 * key is never an outside string — it is a DetailCategory that
 * `detailCategoryFor` produced, and none of the eight names an
 * Object.prototype member. */
const DETAIL_CAT_LABEL: Record<DetailCategory, string> = {
  file: "file", shell: "shell", web: "web", agent: "agent",
  task: "task", plan: "plan", mcp: "mcp", other: "other",
};
/** The detail panel's name for the shared bucket lookup. Kept as a local alias
 *  purely so the call sites below read the way they always have. */
const detailCategoryFor = categoryFor;

export default function App() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}

/** d3-zoom's own transform for the pane — the scale `k`, the translation
 *  `x`/`y`, and the relative builders that compose another one from it.
 *
 *  Read off React Flow's own d3-zoom handle rather than imported from d3-zoom,
 *  because d3-zoom reaches this app only as React Flow's dependency and a
 *  direct import would be a package.json entry for one type. applyViewport is
 *  the only user. */
type PaneTransform = Extract<
  Parameters<NonNullable<ReactFlowState["d3Zoom"]>["transform"]>[1],
  { k: number }
>;

/** The zoom range's two ends, as React Flow's own zoom buttons read them.
 *  Module-level so `useStore` gets the same selector every render. */
const zoomAtMax = (s: ReactFlowState) => s.transform[2] >= s.maxZoom;
const zoomAtMin = (s: ReactFlowState) => s.transform[2] <= s.minZoom;

function Inner() {
  const rf = useReactFlow();
  // Whether the canvas's own zoom buttons can go any further, which is the
  // one fact they need from the store. Booleans, so this re-renders when a
  // limit is reached or left, not on every zoom frame.
  const zoomMaxed = useStore(zoomAtMax);
  const zoomMinned = useStore(zoomAtMin);
  // The same store React Flow's own viewport helpers read, and the only way to
  // reach the pane's d3-zoom behaviour from here. `useStoreApi` rather than
  // `useStore`: this is never rendered from, only called into, so a subscription
  // would be a re-render per pan frame for nothing. See applyViewport.
  const storeApi = useStoreApi();
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
  const [, force] = useState(0);
  const rerender = useCallback(() => force(x => x + 1), []);
  /** Right detail panel visibility — persisted across refresh. Declared ahead
   *  of the selection below, because a plain selection opens it (#814). */
  const [detailOpen, setDetailOpen] = useState<boolean>(loadDetailOpen);
  useEffect(() => { saveDetailOpen(detailOpen); }, [detailOpen]);

  // Selection model: a set of agent ids contributes to spotlight lineage.
  // The primary selection (last clicked) drives the right-hand detail
  // panel and the topbar ribbon — multi-select extends the spotlight but
  // doesn't try to show N agents in the side panel at once.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [primarySelectedId, setPrimarySelectedId] = useState<string | null>(null);
  const [openedToolId, setOpenedToolId] = useState<string | null>(null);

  const selectAgent = useCallback((id: string, additive: boolean, inspect: boolean = !additive) => {
    setSelectedIds(prev => {
      if (!additive) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setPrimarySelectedId(prev => {
      if (!additive) return id;
      // Shift+click: if we just added, this becomes primary; if we just
      // removed primary, fall back to "any other selected" or null.
      if (prev === id) return prev;
      return id;
    });
    // Selecting an agent IS inspecting it (#814). A card clicked, stepped to
    // with j/k, picked from the session list or answered with Enter opens the
    // detail panel; its × still closes it for now, and the next selection
    // brings it back. Shift+click only widens the spotlight, so it leaves the
    // panel as it was.
    //
    // Except from a pointer on the canvas, which passes `inspect: false`: a
    // click on a card goes to its session instead (onNodeClick), and the panel
    // is the double-click's — the owner's call on 2026-09-19, over #814's for
    // the click. j/k, the list, W, Enter and D still open it.
    if (!additive && inspect) setDetailOpen(true);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setPrimarySelectedId(null);
  }, []);
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
  /** The four pictures a deck shows the first time it runs in a browser, and
   *  again from the empty canvas's `Take the tour`. */
  const [tourOpen, setTourOpen] = useState(false);
  /** Notes held back while the tour is up, shown when it closes: an upgrade
   *  into the version that introduced the tour gets the pictures first and the
   *  changelog after, once. Null every other time, including a tour opened by
   *  hand from the empty canvas. */
  const notesAfterTour = useRef<{ entries: VersionNotes[]; since: string | null; firstRun: boolean } | null>(null);
  /** Left sidebar (session list) visibility — persisted across refresh. */
  const [sessionListOpen, setSessionListOpen] = useState<boolean>(loadSessionListOpen);
  useEffect(() => { saveSessionListOpen(sessionListOpen); }, [sessionListOpen]);
  /** Usage panel visibility — persisted across refresh. */
  const [usagePanelOpen, setUsagePanelOpen] = useState<boolean>(loadUsagePanelOpen);
  useEffect(() => { saveUsagePanelOpen(usagePanelOpen); }, [usagePanelOpen]);
  const [machinePanelOpen, setMachinePanelOpen] = useState<boolean>(loadMachinePanelOpen);
  useEffect(() => { saveMachinePanelOpen(machinePanelOpen); }, [machinePanelOpen]);
  /** True while the session list holds the left column the accounts panel was
   *  open in (#824). Opening the list used to close the panel for good: the
   *  close was persisted as "0", so the panel stayed gone across reloads, and a
   *  reader lost a panel they never closed. An eviction is not that choice — it
   *  is remembered here, never written as one, and undone when the list goes. */
  const accountsEvictedRef = useRef(false);
  const [accountsPanelOpen, setAccountsPanelOpen] = useState<boolean>(() => {
    const wanted = (() => {
      try {
        const stored = window.localStorage.getItem(ACCOUNTS_PANEL_OPEN_KEY);
        return stored === null ? true : stored === "1";
      } catch { return true; }
    })();
    // The list holds the column on this load, so the panel waits behind it.
    if (wanted && sessionListOpen) { accountsEvictedRef.current = true; return false; }
    return wanted;
  });
  useEffect(() => {
    // An eviction is not the reader closing the panel, so it is not stored as one.
    if (!accountsPanelOpen && accountsEvictedRef.current) return;
    try { window.localStorage.setItem(ACCOUNTS_PANEL_OPEN_KEY, accountsPanelOpen ? "1" : "0"); } catch {}
  }, [accountsPanelOpen]);
  // The list gave the column back, by any of its ways out: so does the panel it
  // took the column from (#824).
  useEffect(() => {
    if (!sessionListOpen && accountsEvictedRef.current) {
      accountsEvictedRef.current = false;
      setAccountsPanelOpen(true);
    }
  }, [sessionListOpen]);
  /** The panel outlives its own `false` by the length of its exit, so closing
   *  it animates instead of cutting 288px out of the layout in one frame.
   *  Must match `--side-exit` in the sheet. */
  const accountsPhase = usePanelPresence(accountsPanelOpen, 200);
  /** The rail's two panels leave the same way — see --rail-exit in the sheet.
   *  Faster than the accounts panel because they travel less: 8px and a fade,
   *  against 288px of layout. */
  const usagePhase = usePanelPresence(usagePanelOpen, 130);
  const machinePhase = usePanelPresence(machinePanelOpen, 130);

  // The finish sound. Local to this tab since #704: the deck plays it itself,
  // so there is no server state to fetch and no settings.json to write. `null`
  // is kept as the first value for one render only — the switch is not drawn
  // until the stored preference has been read, which keeps it from flashing
  // through "off" on a deck where it is on.
  const [soundOn, setSoundOn] = useState<boolean | null>(null);
  useEffect(() => {
    let stored: string | null = null;
    // Wrapped: a private window, or a browser set to block site data, throws
    // out of the accessor rather than answering null.
    try { stored = localStorage.getItem("agent-dag.sound"); } catch { /* no storage */ }
    setSoundOn(stored === null ? true : stored === "on");
  }, []);

  const toggleSound = useCallback(() => {
    setSoundOn(prev => {
      const next = prev !== true;
      try { localStorage.setItem("agent-dag.sound", next ? "on" : "off"); } catch { /* no storage */ }
      // Turning it ON is itself the gesture the autoplay rules want, so take
      // it: otherwise the switch says "on" and the next event is still silent
      // because nothing has been pressed since the reload.
      if (next) chimesRef.current?.unlock();
      return next;
    });
  }, []);

  /** The single door to the sound switch, in the shape requestClear already
   *  established for the one other control that answers to two devices.
   *
   *  Which devices those are changed in #711 and the door did not. The topbar
   *  button no longer toggles — it opens the menu — so the two ways to the
   *  switch are now M and the menu's own control, and both arrive here. Shift
   *  used to mean "put my own parked hooks back"; #704 removed the mechanism
   *  that parked them, so there is nothing left for it to mean and a press is
   *  a press whatever is held down. */
  const activateSound = useCallback((_withShift: boolean) => { toggleSound(); }, [toggleSound]);
  // `toggleSound` is rebuilt whenever the switch changes state, so the window
  // keydown listener — registered exactly once, on purpose — reads the current
  // one through a ref rather than listing it as a dependency and re-subscribing.
  const activateSoundRef = useRef(activateSound);
  activateSoundRef.current = activateSound;
  /** null until the stored flag has been read back. The button is not drawn in
   *  that window and the key must not fire in it either: there is no state to
   *  invert yet, and "not false" would arm the tones on a guess. */
  const soundOnRef = useRef(soundOn);
  soundOnRef.current = soundOn;

  // ── what each tone is set to (#711) ───────────────────────────────────────
  //
  // Read in the initialiser rather than in an effect, unlike the on/off flag
  // above. That one waits a render because the SWITCH would otherwise flash
  // through "off" on a deck where it is on; these have nothing to flash — they
  // are read by a menu nobody has opened yet, and by the player at play time.
  // `readPrefs` takes the reader as an argument so the whole round trip is a
  // pure function the suite can drive, and the one it is handed is `readStored`
  // — the wrapped read. A private window and a browser with site data blocked
  // throw out of the `localStorage` GETTER, and this is a useState initialiser,
  // which is exactly where storage-blocked.test.ts says a throw takes the whole
  // deck down with it.
  const [tonePrefs, setTonePrefs] = useState<TonePrefs>(() => readPrefs(readStored));
  // The player is built once, on mount, and reads these through the ref at play
  // time — the same shape `enabled` already uses for the flag.
  const tonePrefsRef = useRef(tonePrefs);
  tonePrefsRef.current = tonePrefs;

  /** The trailing timer for the tone a changed setting plays back. */
  const previewRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Play one tone as it is currently set.
   *
   * `unlock` first because pressing this may well be the first gesture of a
   * reloaded tab, and the autoplay rules hold the context suspended until
   * something is pressed — the wake listeners cover it, but these are the only
   * controls in the app whose entire purpose is to make a sound, so they ask
   * rather than assume.
   *
   * `true` is the audition flag: the switch governs the deck's own reports, not
   * a press whose whole meaning is "let me hear it". See sound.ts.
   *
   * `soon` is what separates a drag from a press. A slider crossing a dozen
   * steps must collapse to one figure, so a changed setting waits out
   * PREVIEW_DELAY_MS and is superseded by the next change; the Hear-it button
   * is not a stream and fires at once, cancelling anything pending so the two
   * cannot overlap.
   */
  const previewTone = useCallback((chime: Chime, soon = false) => {
    chimesRef.current?.unlock();
    if (previewRef.current !== null) clearTimeout(previewRef.current);
    previewRef.current = null;
    if (!soon) { chimesRef.current?.play(chime, true); return; }
    previewRef.current = setTimeout(() => {
      previewRef.current = null;
      chimesRef.current?.play(chime, true);
    }, PREVIEW_DELAY_MS);
  }, []);

  /**
   * One tone's settings, written and then played back.
   *
   * The level is clamped and the figure id is resolved here as well as inside
   * the player, because this is what gets WRITTEN: a value that survived the
   * round trip unchecked would come back on the next boot and be corrected
   * silently forever after, which is a stored preference that does not match
   * the control showing it.
   */
  const changeTone = useCallback((chime: Chime, patch: Partial<ToneSettings>) => {
    setTonePrefs(prev => {
      const next: ToneSettings = {
        level: clampLevel(patch.level ?? prev[chime].level),
        figure: figureIdFrom(chime, patch.figure ?? prev[chime].figure),
      };
      try {
        localStorage.setItem(LEVEL_KEYS[chime], String(next.level));
        localStorage.setItem(FIGURE_KEYS[chime], next.figure);
      } catch { /* no storage */ }
      return { ...prev, [chime]: next };
    });
    previewTone(chime, true);
  }, [previewTone]);

  // A timer outliving the tab it belongs to is a tone fired into an unmounted
  // tree. Cheap to clear, and the only thing this component leaves running.
  useEffect(() => () => { if (previewRef.current !== null) clearTimeout(previewRef.current); }, []);

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

  // ── the deck's own two tones (#704) ───────────────────────────────────────
  // Built lazily on the first gesture rather than here: an AudioContext
  // constructed before the page has been interacted with is created suspended,
  // and a suspended one is what you are then stuck with. The ref holds null
  // until `unlock` runs — and holds a FUNCTION rather than the result, because
  // a `useRef` seed that does work runs on every render and throws the result
  // away (#612).
  const chimesRef = useRef<ReturnType<typeof createChimePlayer> | null>(null);
  const [chimeState, setChimeState] = useState<ChimeState>("locked");
  useEffect(() => {
    const player = createChimePlayer({
      enabled: () => soundOnRef.current === true,
      prefs: () => tonePrefsRef.current,
      onState: setChimeState,
    });
    chimesRef.current = player;
    setChimeState(player.state());
    // Any gesture anywhere unlocks it, once. `pointerdown` rather than `click`
    // so a press on the canvas counts, and `keydown` so a keyboard-only user
    // is not left permanently silent.
    const wake = () => player.unlock();
    window.addEventListener("pointerdown", wake, { once: true, capture: true });
    window.addEventListener("keydown", wake, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", wake, { capture: true } as EventListenerOptions);
      window.removeEventListener("keydown", wake, { capture: true } as EventListenerOptions);
    };
  }, []);

  // ── version drift ─────────────────────────────────────────────────────────
  // A deck upgraded while it was running keeps executing the old code, silently
  // and indefinitely. Nothing else in the product can tell you that, so this
  // asks the server which version it actually booted with.
  // Declared here because the version check keys off it: a restart ends with
  // the SSE stream reconnecting.
  const [live, setLive] = useState(false);
  /** This tab's stream is queued behind other deck tabs' streams (#830), which
   *  is a full browser and not a dead server: see the SSE effect and
   *  tab-census.ts. */
  const [tabCapped, setTabCapped] = useState(false);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateState | null>(null);
  const [desktopUpdateRestarting, setDesktopUpdateRestarting] = useState(false);
  const [versionDismissed, setVersionDismissed] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try { return window.localStorage.getItem(VERSION_DISMISSED_KEY) ?? ""; } catch { return ""; }
  });
  const [cmdCopied, setCmdCopied] = useState(false);
  // `force` asks npm now instead of reusing the answer cached on disk. Used by
  // the chip, because "no banner" and "no check ran" look identical from here.
  const lastForcedRef = useRef(0);
  // A forced check is a round-trip to the registry, and on a slow line that is
  // seconds during which the chip would otherwise not move at all — clicking it
  // felt like clicking nothing. Only forced checks are shown: the unforced
  // polls are answered from a marker on disk and would just make the chip
  // flicker for no reason the user could act on.
  const [versionChecking, setVersionChecking] = useState(false);
  // Returns the round trip so a caller that has to know when the answer landed
  // can wait for it — startUpgrade is the one, and holds its press lock until
  // /api/version has reported the run it just started (#620).
  const loadVersion = useCallback((force = false) => {
    if (force) { lastForcedRef.current = Date.now(); setVersionChecking(true); }
    return fetch(force ? "/api/version?refresh=1" : "/api/version")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setVersion(d as VersionInfo); })
      .catch(() => {})
      .finally(() => { if (force) setVersionChecking(false); });
  }, []);
  // Every unforced poll is answered from the server's on-disk marker, so once a
  // deck had checked, nothing it could do would ever learn about a release
  // published afterwards until that marker's hour was up — reported as seven
  // releases shipping with no banner on any of four running decks. The client is
  // the right place to decide how fresh the answer has to be, so the periodic
  // poll forces on a slower cadence of its own rather than never.
  //
  // Gated on the ref rather than forced every time, because forcing skips the
  // server's window entirely: the ~20-byte registry GET still happens at most
  // once per interval per deck, whether the trigger was the poll, a tab
  // regaining focus, or the chip — all of them stamp the same ref.
  const forceVersionIfStale = useCallback(() => {
    loadVersion(Date.now() - lastForcedRef.current >= VERSION_FORCE_MS);
  }, [loadVersion]);
  useEffect(() => {
    // Unforced: the server asks npm on the first call of its own process, so a
    // deck the user has just started is already answering with a fresh number.
    loadVersion();
    const iv = window.setInterval(forceVersionIfStale, 5 * 60_000);
    // Coming back to this tab is exactly the moment after someone ran the
    // upgrade in another window, and exactly the moment to be right — cheaper
    // and far more timely than waiting out the interval.
    const onVis = () => { if (document.visibilityState === "visible") forceVersionIfStale(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadVersion, forceVersionIfStale]);
  // The stream coming back is the end of a restart, and the only moment the
  // answer is known to have changed. Without this the banner sat on
  // "restarting…" until the five-minute poll came round — and in a background
  // tab, where visibilitychange never fires, that was the only thing left.
  useEffect(() => { if (live) loadVersion(); }, [live, loadVersion]);
  useEffect(() => {
    if (!inDesktopApp()) return;
    let cancelled = false;
    fetch("/api/desktop-update")
      .then(r => r.ok ? r.json() : null)
      .then(value => {
        if (cancelled) return;
        const next = readDesktopUpdate(value);
        if (next) setDesktopUpdate(next);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const readyAppUpdate = readyDesktopUpdate(desktopUpdate);
  const askDesktopUpdateRestart = useCallback(async (updateVersion: string) => {
    if (desktopUpdateRestarting) return;
    setDesktopUpdateRestarting(true);
    try {
      const response = await fetch("/api/desktop-update/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: updateVersion }),
      });
      if (!response.ok) setDesktopUpdateRestarting(false);
    } catch {
      setDesktopUpdateRestarting(false);
    }
  }, [desktopUpdateRestarting]);

  // ── who is looking ────────────────────────────────────────────────────────
  // The server updates the deck on its own while nobody is looking at it
  // (auto-update.mjs), and only a page can say whether somebody is. So each tab
  // says so on every focus change, and again every PRESENCE_BEAT_MS while it
  // holds focus, because the claim expires on the server rather than being
  // trusted forever. A tab that closes takes its claim back on the way out;
  // one that cannot is forgotten when its last beat runs out.
  useEffect(() => {
    const tab = newTabId();
    let last: boolean | null = null;
    const say = (looking: boolean) => {
      fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tab, looking }),
        // keepalive, so the goodbye sent from `pagehide` still leaves.
        keepalive: true,
      }).catch(() => {});
    };
    const tick = () => {
      const looking = tabLooking(document);
      if (presenceShouldSend(last, looking)) say(looking);
      last = looking;
    };
    const bye = () => {
      if (last) say(false);
      last = false;
    };
    tick();
    const iv = window.setInterval(tick, PRESENCE_BEAT_MS);
    window.addEventListener("focus", tick);
    window.addEventListener("blur", tick);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("pagehide", bye);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("focus", tick);
      window.removeEventListener("blur", tick);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("pagehide", bye);
      bye();
    };
  }, []);
  const notice = version?.notice ?? null;

  // ── what changed since you last looked (#712) ─────────────────────────────
  // Most releases put nothing here and this stays shut for months at a time.
  // That silence is the feature: v1.44.0 and v1.44.1 shipped on the same day,
  // and a dialog that opens twice a day is one people learn to dismiss unread —
  // and then it is worthless on the release that moved a hook in their own
  // settings.json.
  //
  // One piece of state carries both halves, because "which notes" and "is it
  // open" are never independently true: null is closed.
  const [releaseNotes, setReleaseNotes] = useState<
    { entries: VersionNotes[]; since: string | null; firstRun: boolean } | null
  >(null);
  // Decided once per load and then never again, and the ref is not belt and
  // braces. The decision writes the running version to the store, so a second
  // run would normally answer "seen" on its own — but a store that REFUSES the
  // write keeps answering "nothing stored", and without this the same dialog
  // would come back on every /api/version poll for as long as the tab is open.
  // A deck that cannot remember must show the notes at most once, not forever.
  const releaseNotesDecidedRef = useRef(false);
  useEffect(() => {
    if (releaseNotesDecidedRef.current) return;
    const store = seenStore();
    const stored = readSeen(store);
    // The server's running version, never the bundle's __APP_VERSION__: an
    // upgrade replaces dist/web on disk before the process restarts, so this
    // page can be newer than the code answering it, and notes about behaviour
    // that is not live yet are notes about nothing.
    // `remembers` is the half of #717 that is easy to leave out. A first run
    // now announces the release it just installed, and a profile that refuses
    // storage looks like a first run on EVERY load — so without this the same
    // dialog would come back for the rest of the release on exactly the
    // profiles that can least do anything about it.
    const decision = decideReleaseNotes({ stored, running: version?.running ?? null, notes: RELEASE_NOTES, remembers: remembersSeen(store) });
    // Not an answer yet — /api/version has not come back, or came back without
    // a version. Leave the ref down so the next poll gets to decide.
    if (decision.reason === "no-version") return;
    releaseNotesDecidedRef.current = true;
    if (decision.record) writeSeen(store, decision.record);
    // `firstRun` is what keeps the dialog's first line from telling a new
    // install it "was last caught up at" a version it has never run: on this
    // route `stored` is null for a first run and for nothing else, and the
    // sentence for that has to be its own rather than the browse route's.
    // THE TOUR, TO EVERYONE ONCE, AND THE NOTES AFTER IT. A first run gets the
    // pictures and no changelog — #717's reasoning: what changed since a
    // version they never ran is nothing to them, and the notes stay one click
    // away on the version chip. An upgrade that has never seen the tour gets
    // the tour first and the notes when it closes; every later upgrade gets
    // the notes alone. The order and the once are decideWelcome's, and it is
    // pure, so the cases are pinned without a browser.
    //
    // `firstRun: false` is the only value the dialog can carry from here: the
    // welcome left for the tour, so a changelog opened here is always about an
    // upgrade. The welcome sentence in releaseNotesIntro stays for the day a
    // caller wants it back.
    let alive = true;
    const showWelcome = async () => {
      let tourSeen = readTourSeen(store);
      if (inDesktopApp()) {
        // The desktop window's localhost port changes across restarts. The
        // deck prefs file survives that change; localStorage belongs to the
        // current port only. Carry an existing marker into prefs once.
        try {
          const response = await fetch("/api/prefs");
          if (!response.ok) throw new Error("desktop tour preferences unavailable");
          const data = await response.json();
          if (!data?.ok) throw new Error("desktop tour preferences unavailable");
          const persisted = data.prefs?.tourSeen === true;
          if (tourSeen && !persisted) {
            void fetch("/api/prefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tourSeen: true }),
              keepalive: true,
            }).catch(() => {});
          }
          tourSeen = tourSeen || persisted;
        } catch {
          // If the durable marker cannot be read, do not show a tour that
          // could repeat after every restart. Release notes still work.
          tourSeen = true;
        }
      }
      if (!alive) return;
      const plan = decideWelcome({ tourSeen, decision });
      const notes = decision.show.length ? { entries: decision.show, since: stored, firstRun: false } : null;
      // Opened here, and marked seen only when a person CLOSES it — see the
      // tour's onClose. Marking it on open was the defect: the deck reloads its
      // own tab when the bundle changes, and updates itself while nobody is
      // looking, so the tour opened in tabs nobody was watching, was recorded
      // as seen, and the people it was for never saw it.
      if (plan.tour) setTourOpen(true);
      if (plan.notes === "now") setReleaseNotes(notes);
      else if (plan.notes === "after") notesAfterTour.current = notes;
    };
    void showWelcome();
    return () => { alive = false; };
  }, [version?.running]);
  // Everything this build has to say, for the version chip — which is the way
  // back after the dialog is dismissed, and the only recovery for a profile
  // whose site data was cleared along with the marker above. The bundle's
  // version is the fallback here and only here: the chip's route is a browse,
  // not an announcement, so a deck whose /api/version never answered should
  // still be able to open it rather than lose the feature entirely.
  const chipVersion = version?.running ?? __APP_VERSION__;
  const everyReleaseNote = useMemo(
    () => notesBetween(RELEASE_NOTES, null, chipVersion),
    [chipVersion],
  );
  // The browse route (#715). `since: null` is what makes it a browse: it is not
  // an announcement, so it neither reads nor writes the seen marker, and it is
  // NOT gated on the run being non-empty — a click that opens a dialog saying
  // "nothing to report yet" is a click that answered; a click that does nothing
  // at all is a broken button. The empty run is nearly unreachable in practice,
  // because a release with nothing of its own still has every release before it
  // to show, but the dialog is written for it and the chip therefore does not
  // have to be.
  const openReleaseNotes = useCallback(() => {
    setReleaseNotes({ entries: everyReleaseNote, since: null, firstRun: false });
  }, [everyReleaseNote]);

  // Which sessions this deck is even allowed to see — "" for machine-wide, a
  // path when it was started with --workspace/--scope. Null until health
  // answers, and null forever against a server too old to report it; the empty
  // state says nothing about scope in that case rather than guessing, which is
  // how it came to claim a dead `--all` flag in the first place. Re-asked when
  // the stream reconnects, because that is the far end of a restart and the
  // only point the answer can have changed.
  const [workspace, setWorkspace] = useState<string | null>(null);
  // Which CLIs this deck watches, from the same request. Claude-only surfaces
  // are drawn only when Claude Code is here and Codex-only surfaces only when
  // Codex is — see providers.ts, which also owns what to believe when the
  // server does not say. Re-asked on reconnect with the scope, because a
  // restart is exactly when --no-claude or a newly installed CLI takes effect.
  const [providers, setProviders] = useState<Providers>(ASSUMED);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return;
        // Read before the workspace guard below, not after: `workspace` is a
        // separate field with its own reason to be missing, and letting it
        // decide whether providers are read would hide the panels of anyone
        // whose deck reports one and not the other.
        setProviders(readProviders(d));
        if (!d || typeof d.workspace !== "string") return;
        setWorkspace(d.workspace);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [live]);
  // The keydown handler below is bound once and reads its world through refs;
  // `A` has to see today's answer rather than the one that shipped with the
  // first render, when nothing had come back from /api/health yet.
  const providersRef = useRef(providers);
  providersRef.current = providers;
  // Keyed to the version it is about, so dismissing today's notice does not
  // silence next month's release — and, through `noticeOpen`, does not turn
  // off restart-to-update for good either (#804). The rule is version-chip.ts's
  // so it can be driven (#1175).
  const noticeKey = noticeKeyFor(notice);
  const noticeOpen = noticeIsOpen(notice, versionDismissed);
  // Two idempotent halves rather than one toggle (#715). The chip used to flip
  // this, which was fine while flipping it was all the chip did; it now opens
  // the release notes as well, and a click that opens a modal AND silently
  // reverses the state of the strip behind it is a click nobody can predict the
  // second time. So the chip only ever reveals — press it twice and the banner
  // is shown twice — and putting the banner away moved entirely to the × that
  // always spelled it.
  const showNotice = useCallback(() => {
    setVersionDismissed("");
    try { window.localStorage.setItem(VERSION_DISMISSED_KEY, ""); } catch { /* private mode */ }
  }, []);
  const dismissNotice = useCallback(() => {
    if (!notice) return;
    setVersionDismissed(noticeKey);
    try { window.localStorage.setItem(VERSION_DISMISSED_KEY, noticeKey); } catch { /* private mode */ }
  }, [notice, noticeKey]);

  // ── the name this deck was started under ──────────────────────────────────
  // Three npm names reach this same deck, every surface it draws says ccdeck,
  // and the name most people type is one of the other two. So it is said here
  // once per old name — in the shape of the banner above, never as an error.
  // Nothing is broken and nothing is being taken away, and a red alarm over a
  // name preference would be a lie about severity.
  //
  // The server reports `invokedAs` only where it can prove what was typed, so
  // this stays silent for a global install on Windows and for a git checkout
  // instead of guessing at either. Seeing this over a deck you started as
  // `ccdeck` is the one failure that would make it worth ignoring.
  const [oldNameDismissed, setOldNameDismissed] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try { return window.localStorage.getItem(OLD_NAME_DISMISSED_KEY) ?? ""; } catch { return ""; }
  });
  // PRODUCT is both halves of the comparison on purpose: the name the deck
  // calls itself and the command we ask people to type are the same string
  // since the rename (#324), and display-name.test.ts is what holds them there.
  const oldName = version?.invokedAs && version.invokedAs !== PRODUCT ? version.invokedAs : null;
  const oldNameOpen = oldName != null && oldNameDismissed !== oldName;
  const dismissOldName = useCallback(() => {
    if (!oldName) return;
    setOldNameDismissed(oldName);
    try { window.localStorage.setItem(OLD_NAME_DISMISSED_KEY, oldName); } catch { /* private mode */ }
  }, [oldName]);
  // Installing runs on the server and reports back through /api/version, so the
  // only thing the click owns is starting it and polling a little faster while
  // it runs — an npm install is a minute, not five.
  const upgradeState = version?.upgrade?.state ?? "idle";
  // A string, not the object, so an effect can key off it: /api/version answers
  // with a fresh object every poll, and only its identity would ever change.
  const upgradeFailure = upgradeFailureId(version?.upgrade);
  // The press's own in-flight flag, and the only one this button has: `running`
  // is the SERVER's answer and does not arrive until the next /api/version, so
  // between the click and that poll there is nothing else saying a run started.
  // Released once the poll has been asked for — from then on `upgradeState`
  // carries the fact, and a POST that changed nothing leaves the button usable
  // rather than locked out for the life of the page.
  const upgradeAskedRef = useRef(false);
  const startUpgrade = useCallback(async () => {
    if (!selfPressAccepted(upgradeAskedRef.current || upgradeState === "running")) return;
    upgradeAskedRef.current = true;
    try { await fetch("/api/upgrade", { method: "POST" }); } catch { /* reported via /api/version */ }
    await loadVersion();
    upgradeAskedRef.current = false;
  }, [upgradeState, loadVersion]);
  useEffect(() => {
    if (upgradeState !== "running") return;
    const iv = window.setInterval(loadVersion, 3000);
    return () => window.clearInterval(iv);
  }, [upgradeState, loadVersion]);

  const copyCommand = useCallback(async () => {
    const cmd = version?.command;
    if (!cmd) return;
    // The ladder — secure-context clipboard raced against a timer, then the
    // selection trick — moved to copy-text.ts when the Browser Watch killswitch
    // became the second caller showing the user a command to paste.
    const ok = await copyText(cmd);
    if (!ok) return; // the command stays on screen and selectable
    setCmdCopied(true);
    window.setTimeout(() => setCmdCopied(false), 1600);
  }, [version?.command]);

  // One left column, two things that want it. Opening either evicts the other
  // rather than fighting over the same grid slot.
  //
  // Still two, and still both callers' problem, even though only one of them
  // has a button left: the session list is reached from L alone now, and the
  // eviction is what stops that key from stacking it under an open accounts
  // panel in the same slot.
  const toggleSessionList = useCallback(() => {
    setSessionListOpen(open => {
      // Opening the list takes the column. If the panel was in it, that is an
      // eviction to undo when the list closes (#824), not the panel closing.
      if (!open) setAccountsPanelOpen(was => { if (was) accountsEvictedRef.current = true; return false; });
      return !open;
    });
  }, []);
  const toggleAccountsPanel = useCallback(() => {
    // The reader's own call on the panel ends any eviction.
    accountsEvictedRef.current = false;
    setAccountsPanelOpen(open => {
      if (!open) setSessionListOpen(false);
      return !open;
    });
  }, []);
  // ccusage history modal — transient (not persisted), opened from the toolbar.
  const [usageHistoryOpen, setUsageHistoryOpen] = useState(false);
  const [browserWatchOpen, setBrowserWatchOpen] = useState(false);
  /** Episodes the reader has not looked at yet, and the moment they last did.
   *  The badge is the whole reason the topbar can afford another control: at
   *  rest this button is an outline like the five beside it, and it only
   *  acquires a number when something happened that nobody has read. #720 took
   *  a resting pill OUT of this bar for saying nothing; a second one that said
   *  "no findings" all day would be the same mistake with a different icon. */
  const [watchSeenMs, setWatchSeenMs] = useState(() => {
    try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; }
  });
  const [watchEpisodes, setWatchEpisodes] = useState<WatchEpisode[]>([]);
  const [watchOn, setWatchOn] = useState(false);

  // What the badge counts, fetched on its own slow timer rather than by opening
  // the dialog — a badge that only appears once you have already looked is not
  // a badge. Five minutes, and cheap at that rate: the server answers from a
  // cache keyed on each History file's mtime, so a machine nobody is browsing
  // on costs one stat per profile per poll and re-reads nothing.
  useEffect(() => {
    let alive = true;
    const pull = () => {
      // `live=0`: this poll wants the badge's number, not a look at the
      // browsers. With the watch off the server honours it and reads nothing at
      // all — the switch used to gate only what was kept, so a deck nobody had
      // switched on still copied every History database every five minutes.
      // With the watch ON the server ignores it and records as usual, because
      // recording in the background is the whole feature.
      fetch("/api/browser-watch?live=0")
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          if (!alive || !j?.ok) return;
          setWatchEpisodes(j.episodes ?? []);
          setWatchOn(j.settings?.enabled === true);
        })
        .catch(() => { /* the panel says so when it is opened; the badge stays quiet */ });
    };
    pull();
    const t = setInterval(pull, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  /** Decks that have dialled this one and are waiting for an answer.
   *
   *  Polled up here rather than read where the answer used to live, because the
   *  accounts panel is a place somebody GOES and this is a question somebody is
   *  ASKED. Until it is answered the far deck is stalled and its owner is
   *  watching an empty roster, so the question cannot depend on this deck's
   *  owner happening to open a panel three sections down.
   *
   *  Five seconds, the cadence the panel's own section polls at, and cheap at
   *  that rate: /api/lan answers out of the engine's memory, and the one probe
   *  behind it that costs anything is throttled in the server. */
  const [lanPending, setLanPending] = useState<LanStranger[]>([]);
  /** Answered with Escape rather than with a press: still pending on the
   *  server, deliberately not asked again until this page is reloaded. The
   *  panel's section still lists it, which is where "later" points. */
  const lanDeferred = useRef<Set<string>>(new Set());
  const [lanBusy, setLanBusy] = useState<"accept" | "dismiss" | null>(null);

  useEffect(() => {
    let alive = true;
    let t = 0;
    // A TIMEOUT CHAIN, NOT AN INTERVAL, so the cadence can follow the switch —
    // five seconds while the network is on, a minute while it is off. With it
    // off nothing can arrive: no beacon is running, nobody can dial in, and
    // `pending` cannot become anything. This poll and the section's own were
    // both asking anyway, so an off deck was making three requests every five
    // seconds for as long as its tab was open.
    //
    // A minute is not too slow for the moment it comes back on, either: a peer
    // has to hear the beacon before it can dial, which is up to thirty seconds,
    // so there is nothing to be late for.
    const pull = () => {
      fetch("/api/lan")
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          if (!alive) return null;
          // With the names somebody here gave those decks, so the dialog over
          // the canvas says the same word the panel's row does.
          if (j?.ok) setLanPending(withAliases(Array.isArray(j.pending) ? j.pending : [], j.aliases));
          return j;
        })
        .catch(() => null) // the deck is down; the connection banner already says so
        .then(j => {
          if (alive) t = window.setTimeout(pull, j?.enabled === true ? LAN_POLL_ON_MS : LAN_POLL_OFF_MS);
        });
    };
    pull();
    return () => { alive = false; window.clearTimeout(t); };
  }, []);

  const answerLanPair = useCallback(async (action: "accept" | "dismiss", fp: string) => {
    // One answer at a time, and the dialog disables both while it is in flight:
    // a second press on a request the server has already consumed comes back
    // `not_seen`, which is an error message about nothing.
    if (lanBusy) return;
    setLanBusy(action);
    try {
      const res = await fetch("/api/lan/peer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, fp }),
      });
      const out = await res.json().catch(() => null);
      // The route answers with the whole status, so the next request — if there
      // is one — is already in hand and the dialog does not blink out and back
      // in on the next poll.
      if (out && Array.isArray(out.pending)) setLanPending(withAliases(out.pending, out.aliases));
      else setLanPending(prev => prev.filter(p => p.fp !== fp));
    } catch {
      // Nothing was decided, so nothing is drawn as decided: the request stays
      // in front and the next poll says whether it is still there.
    } finally {
      setLanBusy(null);
    }
  }, [lanBusy]);

  const watchUnseen = useMemo(
    () => unseenEpisodes(watchEpisodes, watchSeenMs).length,
    [watchEpisodes, watchSeenMs],
  );

  /** Bumped on each group-drag move so snapshotToFlow recomputes immediately
   *  (reads the freshly-pinned positions) rather than waiting for the 250ms
   *  tick. A plain counter — value is irrelevant, only the change matters. */
  const [dragTick, setDragTick] = useState(0);

  // ── the filter bar stepping out of the way ─────────────────────────────────
  // The bar floats over the top-left of the canvas, which is fine until you pan:
  // then cards and tool bubbles slide underneath it and stay there, because
  // nothing re-frames a viewport the user chose. Reported with a screenshot of a
  // Bash bubble half-eaten by the bar, and a workaround — pressing Clear after
  // every update — that throws away the canvas to move one toolbar.
  //
  // So the bar yields instead. When anything is beneath it the bar drops to a
  // fifth of its opacity, and hovering or focusing it brings it straight back.
  // Measured rather than derived: bubbles are positioned by the burst layer in
  // screen space, so the DOM is the only place both live in the same
  // coordinates. A 300ms poll of a bounded set of rects is cheaper than it
  // sounds and stops entirely when the tab is hidden or the bar is absent.
  const catBarRef = useRef<HTMLDivElement | null>(null);
  const [catBarOccluded, setCatBarOccluded] = useState(false);

  /**
   * Live positions of whatever is being dragged, applied over the rendered
   * array. Held in a ref and paired with a counter: the values change on every
   * pointer move, and putting them in state would deep-compare a Map on each
   * one for no benefit.
   */
  const dragPatchRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const [dragMoveTick, setDragMoveTick] = useState(0);
  // Pause freezes the canvas; it does not drop the connection. The gate owns
  // both the flag and the held events so the SSE handler can read the current
  // pause state out of a ref — see pause.ts for why closing over the state
  // variable instead made every toggle replay the server's whole ring buffer.
  // `paused` mirrors the gate for rendering; the gate stays the source of truth.
  // Lazily, for the reason spelled out at `initialGraph`: a `useRef`
  // argument is re-evaluated on every render (#612). The gate is mutated in
  // place and never replaced, so the value itself is the handle.
  //
  // `protect` is the payload half of the ceiling's eviction rule (#676): the
  // gate drops the oldest event it holds, and the oldest events of a pause are
  // the outcomes of the calls that were already running when it began. Nothing
  // re-delivers those, so a dropped one leaves its call in-flight forever. The
  // gate cannot recognise them — it reads `seq` and `epoch` — so the graph is
  // asked, through the ref, which during a pause is frozen at exactly the set
  // of calls that were open at the freeze.
  const pauseGate = useState(() => createPauseGate<HookEnvelope>({
    protect: env => settlesInFlightCall(stateRef.current, env),
  }))[0];
  const [paused, setPaused] = useState(false);
  const togglePause = useCallback(() => {
    // Read before the toggle: a resume clears the gate's count along with its
    // queue, so afterwards there is nothing left to ask about this hold.
    const holed = pauseGate.paused && pauseGate.dropped > 0;
    const held = pauseGate.setPaused(!pauseGate.paused);
    // Before the drain, not after. Every call still in flight is about to be
    // handed a run with a hole in it, and the drain is what settles the ones
    // whose outcomes did survive — which clears the flag again for each of
    // them, leaving it only where the deck genuinely does not know (#676).
    if (holed) noteDroppedEvents(stateRef.current);
    for (const env of held) stateRef.current = applyEvent(stateRef.current, env);
    setPaused(pauseGate.paused);
  }, [pauseGate]);
  const [now, setNow] = useState(Date.now());

  // ── restart ───────────────────────────────────────────────────────────────
  // The server cannot restart itself without racing its own listener onto a
  // random fallback port, so the supervisor owns it and this only asks.
  const [autoRestart, setAutoRestart] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try { return window.localStorage.getItem(AUTO_RESTART_KEY) !== "0"; } catch { return true; }
  });
  /** Whether this page has pressed the switch. A press is newer than anything
   *  the prefs load can bring back, so that load leaves the switch alone. */
  const autoTouchedRef = useRef(false);
  // ON THE SERVER NOW, as `autoUpdate` in prefs.json: the deck also updates
  // itself while nobody is looking at it — with no page open at all — and that
  // needs the same answer (auto-update.mjs). The initialiser above still reads
  // the old key so a switch turned off before the move renders off at once; the
  // prefs load further down carries it over and removes it. Optimistic like the
  // notifications switch, and corrected by the server's answer.
  const toggleAutoRestart = useCallback(() => {
    const next = !autoRestart;
    autoTouchedRef.current = true;
    try { window.localStorage.removeItem(AUTO_RESTART_KEY); } catch { /* private mode */ }
    setAutoRestart(next);
    fetch("/api/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoUpdate: next }),
    }).then(r => (r.ok ? r.json() : null)).then(d => {
      if (d?.ok) setAutoRestart(d.prefs?.autoUpdate !== false);
    }).catch(() => {});
  }, [autoRestart]);
  const [restarting, setRestarting] = useState(false);
  // "npx" gets its own word everywhere, because it is a download and not a
  // process restart: it takes tens of seconds, and a banner that says
  // "restarting…" for a minute reads as a hang.
  const [restartMode, setRestartMode] = useState<"restart" | "npx">("restart");
  const [restartedTo, setRestartedTo] = useState<string | null>(null);
  const restartAskedRef = useRef(false);
  // The failure the server was already reporting when this attempt started, so
  // the one it reports afterwards can be told apart from it. Without that, the
  // note left by the previous failed npx relaunch — still on disk until the
  // supervisor clears it at the top of the next one — would read as this
  // attempt's own outcome the moment the retry was clicked.
  const askedFailureRef = useRef<string | null>(null);
  // Counts asks, so a timeout only ever hands back the state of the attempt
  // that armed it. Now that a failure ends an attempt early, a retry can be
  // running while its predecessor's three minutes are still on the clock.
  const restartAttemptRef = useRef(0);
  const askRestart = useCallback(async (opts?: { upgrade?: boolean }) => {
    // The guard the `disabled` used to be, now that the two buttons that call
    // this stay enabled while their own request is out (#620). It was already
    // here as `if (restartAskedRef.current) return` — the ref is what a second
    // Enter meets, and the rule is what it is spelled as.
    if (!selfPressAccepted(restartAskedRef.current)) return;
    const upgrade = opts?.upgrade === true;
    restartAskedRef.current = true;
    askedFailureRef.current = upgradeFailure;
    const attempt = ++restartAttemptRef.current;
    setRestartMode(upgrade ? "npx" : "restart");
    setRestarting(true);
    // Remembered across the reconnect so the deck can confirm what it landed
    // on rather than claiming success the moment the request was accepted.
    try { window.sessionStorage.setItem("agent-dag.restartPending", notice?.to ?? ""); } catch {}
    // The socket dying IS the restart, so a rejection here is a success signal
    // as often as a failure one — neither is worth acting on.
    try {
      await fetch("/api/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upgrade }),
      });
    } catch { /* expected */ }
    // Nothing came back. Rather than leave a disabled button and a banner
    // frozen mid-sentence, hand the control back so it can be tried again —
    // after long enough that an npx fetch on a slow line is not cut short.
    window.setTimeout(() => {
      if (restartAttemptRef.current !== attempt) return; // a later ask owns the state now
      if (!restartAskedRef.current) return;
      restartAskedRef.current = false;
      setRestarting(false);
      try { window.sessionStorage.removeItem("agent-dag.restartPending"); } catch {}
    }, upgrade ? 180_000 : 30_000);
  }, [notice?.to, upgradeFailure]);

  // Nothing running for a sustained stretch is the only safe moment: a restart
  // mid-turn silently drops the hook events fired during the gap, leaving tools
  // stuck in flight on the canvas until the stale sweeper reaps them. The rule
  // itself lives in restart.ts, where it can be tested.
  const idleSinceRef = useRef<number | null>(null);
  useEffect(() => {
    const busy = activeCount(stateRef.current.agents.values()) > 0;
    const step = autoRestartStep({
      enabled: autoRestart,
      kind: notice?.kind,
      canRestart: version?.canRestart === true,
      // #804: the same condition the switch renders under, so the deck never
      // restarts itself at a moment when nothing on screen offers to stop it.
      noticeOpen,
      // Not in a tab nobody is looking at. A background tab's timers are
      // throttled rather than stopped, so a forgotten one could restart the
      // server under the tab in use — see RestartGate.visible.
      visible: document.visibilityState === "visible",
      busy,
      idleSince: idleSinceRef.current,
      now,
    });
    idleSinceRef.current = step.idleSince;
    if (step.restart) askRestart();
  }, [autoRestart, notice?.kind, version?.canRestart, noticeOpen, now, askRestart]);

  // WHAT THE BANNER SAYS ABOUT THIS PRESS, from the two things the effect above
  // already decides with. Both were computed and thrown away: the deck knew
  // whether a restart was safe and whether one was counting down, and told the
  // reader neither.
  //
  // Read at render, from the same `now` the effect ticks on. `idleSinceRef` is
  // a ref rather than state because the clock must not itself cause renders —
  // this component already re-renders on every tick — and reading it here is
  // safe for the one reason that matters: it holds an ABSOLUTE timestamp, so a
  // value one tick old still yields an exact remainder against the current
  // `now`. A duration would have gone stale; an instant cannot.
  const activeNow = activeCount(stateRef.current.agents.values());
  const restartCopy = restartSafety(activeNow);
  const restartFuseMs = autoRestartRemainingMs({
    enabled: autoRestart,
    kind: notice?.kind,
    canRestart: version?.canRestart === true,
    noticeOpen,
    visible: document.visibilityState === "visible",
    busy: activeNow > 0,
    idleSince: idleSinceRef.current,
    now,
  });

  // Landed — here, or in the bundle that is about to replace this one. The page
  // is code too and nothing else reloads it, so both outcomes hang off the same
  // move of `running` and have to be decided together: as two effects they were
  // flushed in one synchronous pass, and since location.reload() only schedules
  // the navigation the second one still deleted the pending marker that was
  // supposed to carry the confirmation across it. The rule lives in restart.ts.
  useEffect(() => {
    const running = version?.running;
    let pending: string | null = null;
    let lastTried: string | null = null;
    try {
      pending = window.sessionStorage.getItem("agent-dag.restartPending");
      lastTried = window.sessionStorage.getItem(BUNDLE_RELOAD_KEY);
    } catch { return; }
    const step = restartLandingStep({ bundle: __APP_VERSION__, running, pending, lastTried });
    if (step === "reload") {
      try { window.sessionStorage.setItem(BUNDLE_RELOAD_KEY, running ?? ""); } catch { return; }
      window.location.reload();
      return; // the marker stays put; the new bundle is the one that can show it
    }
    if (step !== "confirm") return;
    try { window.sessionStorage.removeItem("agent-dag.restartPending"); } catch {}
    restartAskedRef.current = false;
    setRestarting(false);
    setRestartedTo(running ?? null);
    const t = window.setTimeout(() => setRestartedTo(null), 6000);
    return () => window.clearTimeout(t);
  }, [version?.running]);

  // Didn't land. A failed `npx -y <spec>@latest` comes back on the OLD version
  // and the same port, so `running` never moves and the check above waits for a
  // version that is not coming — leaving the retry button disabled and reading
  // "fetching…" for the full three minutes, beside a banner already spelling
  // out why the update failed. The supervisor's note is the end of the attempt,
  // and this is the tab hearing it. The rule lives in restart.ts.
  useEffect(() => {
    if (!restarting) return;
    if (!restartEndedInFailure({ asked: askedFailureRef.current, reported: upgradeFailure })) return;
    try { window.sessionStorage.removeItem("agent-dag.restartPending"); } catch {}
    restartAskedRef.current = false;
    setRestarting(false);
  }, [restarting, upgradeFailure]);

  // Restore pinned positions synchronously on first render so they're
  // applied before snapshotToFlow runs autoLayout. Sessions outlast a
  // browser refresh (their session_id is stable), so dragged positions
  // come back where you left them.
  //
  // Once, in a `useState` initialiser — the form `restoredViewport` below has
  // always used, and for the same reason. As a `useRef` argument the whole of
  // this ran on EVERY render and every result but the first was discarded
  // (#612): a getItem, a JSON.parse, and two Maps, four times a second on an
  // idle deck and once per pointer move through a drag — the same drag that is
  // in the middle of rewriting the value being re-read.
  //
  // The pinned half also stopped being quadratic in the process — see
  // restoreLayout in stored-layout.ts, which is where that lives so it can be
  // tested without a DOM.
  const restoredLayout = useState(() => restoreLayout(loadLayout()))[0];
  const pinnedRef = useRef(restoredLayout.pinned);
  /** Active session group-drag: the handle node's start position + each
   *  member's start position, captured at drag start. */
  const groupDragRef = useRef<{ start: { x: number; y: number }; members: Map<string, { x: number; y: number }> } | null>(null);
  const restoredViewport = useState(() => loadViewport())[0];
  /** Categories the user has muted via the filter chips. Bursts whose
   *  category is in this set don't render. Reset only by toggling them
   *  back on (R / clear don't touch it — filters are user intent). */
  const [hiddenCats, setHiddenCats] = useState<Set<DetailCategory>>(() => new Set());
  // The same call index.html's bootstrap already made before the first paint,
  // so React starts out agreeing with what is on screen. Guarded the way the
  // panel loaders are: an initialiser is the one place a store the browser
  // won't hand over blanks the deck instead of costing a preference.
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [characterEnabled, setCharacterEnabled] = useState(storedCharacterEnabled);
  const [fmVolume, setFmVolume] = useState(storedFmVolume);
  const [fmSource, setFmSource] = useState<FmSource>(storedFmSource);
  /** The canvas's JS-read colours, snapshotted per theme rather than per node
   *  per frame (#613). The initialiser is safe to run during the first render:
   *  index.html's inline bootstrap stamps `data-theme` from the same stored
   *  value before the first paint — see theme.ts — so the sheet is already on
   *  the right palette by the time this asks. The effect below re-reads it
   *  whenever the theme moves. */
  const [palette, setPalette] = useState<Palette>(() => readPalette(cssVar));
  /** `nodeColor` reaches minimapNodeColor once per node per minimap render, so
   *  what it is handed has to be a lookup and not a `getComputedStyle`. Stable
   *  for as long as the palette is, which is what lets `memo(MiniMap)` bail
   *  out on the frames where nothing about the minimap changed. */
  const paletteToken = useMemo(() => paletteReader(palette), [palette]);
  const minimapNodeFill = useCallback(
    (node: MinimapNode) => minimapNodeColor(node, paletteToken),
    [paletteToken],
  );
  const [everConnected, setEverConnected] = useState(false);
  // On the FIRST run this is redundant and known to be: the bootstrap wrote the
  // same attribute from the same stored value before anything painted, and the
  // write-back stores the value it just read. With nothing stored yet, what it
  // stores is what the OS asked for (#885), so the deck someone first sees is
  // the one they keep until T changes it. It is left unguarded anyway,
  // because the only way to skip it is a "have we mounted yet" ref — a second
  // answer to a question the DOM already holds, and one that goes wrong the day
  // someone reorders the effects. Re-asserting an identical attribute is free.
  // Every later run is the T toggle, which is the reason the effect exists.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
    // Re-read the canvas tokens HERE, in the same effect and on the line after
    // the attribute, rather than in a `useMemo` keyed on `theme` (#613). A memo
    // runs during render, and `data-theme` is not written until this effect —
    // so on the render that flips the theme a memo would read the palette it is
    // replacing, and then never run again, and the minimap and the grid would
    // keep the old theme's colours until something else invalidated them. The
    // ordering is a statement in one function instead of a convention between
    // two of them.
    setPalette(prev => {
      const next = readPalette(cssVar);
      return samePalette(prev, next) ? prev : next;
    });
  }, [theme]);

  useEffect(() => {
    try { window.localStorage.setItem(CHARACTER_ENABLED_KEY, characterEnabled ? "1" : "0"); } catch { /* private mode */ }
  }, [characterEnabled]);

  useEffect(() => {
    try { window.localStorage.setItem(FM_VOLUME_KEY, String(fmVolume)); } catch { /* private mode */ }
  }, [fmVolume]);

  useEffect(() => {
    try { window.localStorage.setItem(FM_SOURCE_KEY, fmSource); } catch { /* private mode */ }
  }, [fmSource]);

  /**
   * The window's own title bar, which only an INSTALLED deck has.
   *
   * A standalone window tints its chrome from `<meta name="theme-color">`, so a
   * deck left on the manifest's single value shows a near-black bar above a
   * white page for every light-theme user who installed it.
   *
   * WRITTEN HERE RATHER THAN AS A MEDIA-QUERIED PAIR IN THE HEAD, which is the
   * whole reason it is worth an effect: `prefers-color-scheme` is the OS, and
   * this deck's theme is a STORED CHOICE allowed to disagree with it — see the
   * bootstrap in index.html. A pair in the head would be right for everyone who
   * never pressed T and wrong for exactly the people who did.
   *
   * FROM THE PALETTE, NOT FROM cssVar. The palette is already this deck's one
   * snapshot of the theme's colours and it already holds `--panel`; calling
   * cssVar again would be a second `getComputedStyle` for a value that has just
   * been read, and render-path-cost-612-613.test.ts pins the mention count for
   * that reason. Keyed on the palette rather than on the theme so it runs after
   * the effect above has replaced it, never on the frame still holding the old
   * one. `--panel` because the top of this page is the topbar, and the topbar's
   * gradient starts there.
   */
  useEffect(() => {
    const bar = document.querySelector('meta[name="theme-color"]');
    const panel = palette["--panel"];
    if (bar && panel) bar.setAttribute("content", panel);
  }, [palette]);

  /**
   * Put the pane where the deck wants it — and make sure it gets there.
   *
   * One door for every viewport the deck asks for, because there are two ways
   * through and the choice is not the caller's to make each time. The animated
   * way is `setViewport`, which is a d3 transition and therefore a chain of
   * requestAnimationFrame callbacks; the immediate way is the pane's d3-zoom
   * behaviour handed a SELECTION instead of a transition, which applies the
   * transform synchronously and needs no frame at all.
   *
   * Which one is not a matter of taste. A browser runs no rAF in a page it is
   * not rendering, so in a background tab the animated way does not arrive late
   * — it does not arrive, and neither does the position it was carrying. That
   * is the whole of #671: a deck left open behind an editor could not recentre,
   * and the drift watchdog's recovery — whose entire purpose is a canvas that
   * wandered off while nobody was looking — could not execute in exactly the
   * condition it exists for. Measured in a hidden deck tab: zero rAF callbacks
   * over three seconds, while `setTimeout` kept firing at Chrome's ~1Hz
   * background clamp. The timers were slow; the frames were absent.
   *
   * `{ duration: 0 }` is NOT the immediate way, which is the trap this function
   * exists to close. React Flow's setViewport has no zero-duration branch —
   * `getD3Transition` wraps the selection in `.transition().duration(d)` for
   * every d — so a "non-animated" setViewport is a transition of length zero,
   * waiting on the same frame that is not coming. The deck's own trailing
   * correction used to be spelled that way and could never once have worked.
   * `d3Zoom.transform(d3Selection, t)` is the door React Flow's own `fitView`
   * takes when given no duration, and the one @reactflow/minimap pans through.
   *
   * The transform is composed from the live one rather than built from
   * `zoomIdentity`, so that no d3 module has to be imported beside React Flow's
   * own copy: `scale` and `translate` on a ZoomTransform are relative, and
   * scaling to `zoom / k` and then translating by the remaining gap lands on
   * exactly (x, y, zoom).
   */
  const applyViewport = useCallback((next: { x: number; y: number; zoom: number }, duration: number) => {
    if (shouldAnimateViewport({ durationMs: duration, documentHidden: document.hidden })) {
      rf.setViewport(next, { duration });
      return;
    }
    const { d3Zoom, d3Selection } = storeApi.getState();
    const current = d3Selection?.property("__zoom") as PaneTransform | undefined;
    if (d3Zoom && d3Selection && current && current.k > 0 && next.zoom > 0) {
      d3Zoom.transform(d3Selection, current
        .scale(next.zoom / current.k)
        .translate((next.x - current.x) / next.zoom, (next.y - current.y) / next.zoom));
      return;
    }
    // Nothing mounted to drive yet. Ask React Flow anyway: in a visible tab it
    // still lands, and in a hidden one there was no pane to move regardless.
    rf.setViewport(next, { duration: 0 });
  }, [rf, storeApi]);

  /** The frame an animation is on its way to, and the moment it should have
   *  arrived by. Null whenever no animated fit is in flight.
   *
   *  Kept because `document.hidden` can flip DURING an animation, and a
   *  transition that loses its frames stops where it stands: a canvas frozen
   *  part-way to a fit, with `getViewport` reporting a transform the deck never
   *  asked for and the drift watchdog measuring against it. */
  const pendingFitRef = useRef<{ target: { x: number; y: number; zoom: number }; until: number } | null>(null);
  /** WHICH CAMERA MOVE IS THE LATEST ONE ANYBODY ASKED FOR. Bumped by every
   *  frame the deck sets on purpose — a fit, a focus — and by the reader's own
   *  pan or zoom, so that a move can tell it has been superseded.
   *
   *  fitLeft's trailing correction is what needs it. That check exists to land a
   *  fit whose animation was cut short, and it could not tell "cut short" from
   *  "replaced": a fit started by the frame change a selection causes (the
   *  detail panel opens and the canvas narrows), then a double-click focusing a
   *  session 100ms later — and 560ms after the fit began, its correction found
   *  the camera somewhere it had not put it and snapped the whole board back,
   *  over the focus. A pan made during a fit's animation was undone the same
   *  way. The correction now lands only while its fit is still the latest. */
  const cameraEpochRef = useRef(0);
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

  // SSE subscription.
  //
  // Replay handling: on connect the server drains its ring buffer over the
  // same SSE channel before live events. Each replayed envelope is tagged
  // `replay: true`; a `replay-end` sentinel marks the boundary. We do two
  // things differently for replay traffic:
  //   1) the SSE handler coalesces renders during replay — one render at
  //      replay-end;
  //   2) `chimeFor` stays quiet for it, so a reconnect does not play every
  //      Stop in the ring.
  //
  // The reducer never reads the flag: its turn cleanup keys on event time,
  // which comes out right for replayed and live events alike. See
  // HookEnvelope.replay in types.ts.
  //
  // Live traffic is coalesced too, but leading-edge (see coalesce.ts): the
  // first event of a quiet stream still renders in its own task, while a tool
  // storm — eight subagents each firing PreToolUse/PostToolUse arrives as
  // dozens of separate macrotasks that React cannot batch — collapses into one
  // render per window instead of one full canvas rebuild per event. Every
  // envelope is still applied to the reducer the instant it lands, in order,
  // so coalescing costs redraws and never state.
  //
  // Fallback heuristic (`Date.now() - receivedAt > 30s`) covers older
  // servers without the replay flag.
  const replayActiveRef = useRef<boolean>(true);
  /** When the latest replay landed, by the wall clock: the moment this page's
   *  board stops being history arriving and starts being spend happening. Null
   *  before the first replay-end and after the stream drops, because a
   *  reconnect replays the ring again. The usage header's $/min counts from
   *  here (#821) — counted from mount, the board total climbing from $0 to
   *  itself during the replay read as hundreds of dollars a minute. */
  const [liveSince, setLiveSince] = useState<number | null>(null);
  useEffect(() => {
    const es = new EventSource("/events");
    const coalescer = createRenderCoalescer(rerender, {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
    });
    // TOO MANY TABS IS NOT A DEAD SERVER (#830). A browser keeps at most six
    // live HTTP/1.1 connections to one address and every deck tab holds one
    // here, so a seventh tab's stream waits in the browser's own queue: no
    // `open`, no `error`, and every fetch from this tab queued behind it, so it
    // cannot ask the server either. The tabs can still hear one another, so a
    // tab whose stream has not opened asks which of the others are streaming,
    // and the hero says so when enough are to explain the wait.
    let streaming = false;
    const census = typeof BroadcastChannel === "function"
      ? joinCensus(new BroadcastChannel(CENSUS_CHANNEL), Math.random().toString(36).slice(2), () => streaming)
      : null;
    const probe = window.setInterval(() => {
      if (streaming || !census) return;
      void census.ask(600).then(peers => { if (!streaming) setTabCapped(tooManyTabs(peers)); });
    }, 3_000);
    es.addEventListener("open", () => { setLive(true); setEverConnected(true); });
    es.addEventListener("error", () => { setLive(false); setLiveSince(null); });
    // What this tab answers a census with, kept beside the stream it describes.
    es.addEventListener("open", () => { streaming = true; setTabCapped(false); });
    es.addEventListener("error", () => { streaming = false; });
    es.addEventListener("replay-end", () => {
      replayActiveRef.current = false;
      coalescer.flush();
      setLiveSince(Date.now());
    });
    es.addEventListener("desktop-update", (e) => {
      if (!inDesktopApp()) return;
      try {
        const next = readDesktopUpdate(JSON.parse((e as MessageEvent).data));
        if (next) {
          setDesktopUpdate(next);
          if (next.status !== "ready") setDesktopUpdateRestarting(false);
        }
      } catch { /* ignore */ }
    });
    es.addEventListener("hook", (e) => {
      try {
        const env: HookEnvelope = JSON.parse((e as MessageEvent).data);
        if (!pauseGate.accept(env)) return; // paused: held for the resume
        stateRef.current = applyEvent(stateRef.current, env);
        const isReplay = env.replay === true
          || replayActiveRef.current
          || Date.now() - env.receivedAt > 30_000;
        if (isReplay) coalescer.replay();
        else coalescer.live();
        // After the coalescer, and reusing its `isReplay`: a reconnect is sent
        // the whole ring, and every Stop in a day's work is in it.
        // Over Claude FM, never under it: the chime is short and the music
        // keeps its level. Turning the track down for each one was heard as
        // the stream cutting out.
        const chime = chimeFor(env, isReplay);
        if (chime) chimesRef.current?.play(chime);
      } catch { /* ignore */ }
    });
    return () => {
      es.close();
      coalescer.cancel();
      window.clearInterval(probe);
      census?.leave();
    };
    // Deliberately not keyed on `paused`: a pause must not tear this stream
    // down, because the reconnect carries no Last-Event-ID and the server
    // answers with a full replay of its ring buffer. The gate handles pausing.
  }, [rerender]);

  // Tick clock so elapsed-time fields refresh smoothly + exit animations
  // clean up. Same tick also reaps in-flight tools whose PostToolUse never
  // arrived (e.g. the session was killed mid-call) so they don't pulse
  // forever in the burst layer.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      // Every sweep this tick runs, on the shipped constants, with the whole
      // sessions they evicted collected — see sweepTick in prune.ts, which is
      // where the order, the constants and the #1024 collection can be run by
      // a test (#1175).
      const { changed, forgotten } = sweepTick(stateRef.current, t);
      if (forgotten.length > 0) {
        // The server drops its change-gated name and model caches for these,
        // or a session evicted while idle and then resumed shows as unnamed for
        // the rest of the day (#1024). Failure is not worth reporting and not
        // worth retrying: the worst it costs is the state this fixes, which is
        // what every deck had before.
        fetch("/api/forget", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: forgotten }),
        }).catch(() => {});
      }
      // And the selection along with them, so it never names an agent that has
      // been evicted (#576). Run unconditionally rather than under `changed`:
      // a `__clear` over SSE empties the map through applyEvent, which this
      // tick never hears about. Both updaters return their previous value when
      // there is nothing to drop, so React bails out and no render happens.
      setSelectedIds(prev => pruneSelection(prev, stateRef.current.agents));
      setPrimarySelectedId(prev => (prev != null && !stateRef.current.agents.has(prev) ? null : prev));
      // AND THE TWO MODALS THAT NAME AN AGENT, for a reason worse than the
      // selection's (#781). Both render nothing once their subject is gone —
      // the context modal returns null on `if (!root)`, and buildSummary
      // returns null on the same `agents.get(sessionId)` — but `modalOpenRef`
      // is computed from the ID rather than from what rendered, so it stayed
      // true with no dialog on screen. From there `shortcutBlocked` refused
      // every key but `?` and `clearActionFor` answered "ignore" for both the
      // trash button and C: every shortcut in the deck dead for the life of the
      // tab, recoverable only by reloading. A session finishing and being
      // evicted two minutes later is all it took.
      //
      // Cleared here rather than fixing the flag to match the render, because a
      // modal whose subject has been evicted should CLOSE rather than sit there
      // invisible-but-counted. `summaryFor` is a session id and `contextFor` an
      // agent id, and both resolve through `agents.get`, so one test serves.
      setContextFor(prev => (prev != null && !stateRef.current.agents.has(prev) ? null : prev));
      setSummaryFor(prev => (prev != null && !stateRef.current.agents.has(prev) ? null : prev));
      if (changed) rerender();
    }, 250);
    return () => clearInterval(id);
  }, [rerender]);

  // Auto-fit-related refs (see effect after layoutSig is computed below).
  const fitTimerRef = useRef<number | null>(null);
  const lastFitTimeRef = useRef(0);
  // Matches TOOL_LANE_W in layout.ts — the burst lane drawn beside each card.
  const TOOL_LANE_ALLOWANCE = 420;

  /**
   * Frame the graph against the left edge of the canvas.
   *
   * React Flow's fitView centres, and there is no asymmetric-padding option,
   * so this measures what is actually drawn and sets the viewport outright.
   * Left-anchored because a graph parked mid-canvas leaves dead space on the
   * side the eye starts from.
   */
  const fitLeft = useCallback((duration = 500) => {
    // MAX_ZOOM 1: cards are drawn at their natural size, so magnifying past
    // 1:1 only makes a small graph look coarse. FILL leaves the frame a little
    // loose — a fit that touches the margins reads as "already too big" and
    // gives the eye nowhere to land when the next session appears.
    const MARGIN = FIT_MARGIN, MAX_ZOOM = 1, MIN_ZOOM = 0.2, FILL = FIT_FILL;
    try {
      const pane = document.querySelector(".canvas-wrap");
      const drawn = Array.from(document.querySelectorAll(".react-flow__node"))
        .filter(el => (el as HTMLElement).offsetWidth > 0);
      if (!pane || drawn.length === 0) return;

      const paneRect = pane.getBoundingClientRect();
      const vp = rf.getViewport();
      if (!Number.isFinite(vp.zoom) || vp.zoom <= 0) return;

      // Screen rects back through the current viewport into flow space, so
      // this works from any starting zoom and never consults the node store —
      // which also holds the invisible per-session drag handles.
      const fx = (sx: number) => (sx - paneRect.left - vp.x) / vp.zoom;
      const fy = (sy: number) => (sy - paneRect.top - vp.y) / vp.zoom;
      const rects = drawn.map(el => el.getBoundingClientRect());
      const minX = Math.min(...rects.map(r => fx(r.left)));
      const maxX = Math.max(...rects.map(r => fx(r.right)));
      const minY = Math.min(...rects.map(r => fy(r.top)));
      const maxY = Math.max(...rects.map(r => fy(r.bottom)));
      const w = maxX - minX, h = maxY - minY;
      if (!(w > 0 && h > 0)) return;

      // Tool bursts are an overlay rather than nodes, so they are absent from
      // these rects — leave room or the last column's chips get clipped. The
      // rail's strip is not room either: a board framed into it would put its
      // last column under the machine and usage panels.
      //
      // Only where they are drawn, though (fitZoomForDrawnLanes): below the
      // full card the bubbles are hidden, and room kept for them there is the
      // band of empty canvas a board used to sit in the middle of.
      const railWidth = railCover(pane);
      const fitWith = (lane: number) => Math.max(MIN_ZOOM, Math.min(
        MAX_ZOOM,
        ((paneRect.width - railWidth - MARGIN * 2) / (w + lane)) * FILL,
        ((paneRect.height - MARGIN * 2) / h) * FILL,
      ));
      const zoom = fitZoomForDrawnLanes(fitWith(TOOL_LANE_ALLOWANCE), fitWith(0));

      // One frame, computed once. It used to be spelled out twice — here and
      // again inside the correction below — which is two chances to disagree
      // about where the graph was supposed to go.
      const want = {
        x: MARGIN - minX * zoom,
        y: Math.max(MARGIN, (paneRect.height - h * zoom) / 2) - minY * zoom,
        zoom,
      };
      const epoch = ++cameraEpochRef.current;
      applyViewport(want, duration);
      lastFitTimeRef.current = Date.now();
      // Remembered only while an animation is actually running: a fit that went
      // straight to the pane is already there, and nothing about it is pending.
      pendingFitRef.current = shouldAnimateViewport({ durationMs: duration, documentHidden: document.hidden })
        ? { target: want, until: Date.now() + duration + 60 }
        : null;
      // A transition can also be cut short — the pane loses its frames when the
      // tab is hidden mid-animation, and the user can grab it. Check afterwards
      // and, if the frame never arrived, put it there outright. Not fitView:
      // that centres, which is the one thing this function exists to avoid.
      window.setTimeout(() => {
        try {
          // Only if it is still THIS fit's target: a second fit started in the
          // meantime owns the ref now, and clearing it would leave that
          // animation with nothing to land if the tab went away mid-flight.
          if (pendingFitRef.current?.target === want) pendingFitRef.current = null;
          if (cameraEpochRef.current !== epoch) return;
          const vpNow = rf.getViewport();
          if (Math.abs(vpNow.zoom - zoom) > 0.01 || Math.abs(vpNow.x - want.x) > 2) {
            applyViewport(want, 0);
          }
        } catch { /* ignore */ }
      }, duration + 60);
    } catch { /* viewport not ready */ }
  }, [rf, applyViewport]);

  // A fit that is animating when the tab goes away loses its frames where it
  // stands — a canvas stopped part-way to a frame nobody chose, which is worse
  // than either end of the animation and is what `getViewport` would report to
  // the drift watchdog from then on. So the moment the page stops being
  // rendered, whatever is in flight is put where it was going.
  //
  // The trailing correction above cannot cover this one: it is a `setTimeout`,
  // and a hidden tab's timers are clamped to about 1Hz, so a 400ms fit would
  // sit frozen for the best part of a second first. The visibility change
  // itself is delivered immediately.
  useEffect(() => {
    const land = () => {
      if (!document.hidden) return;
      const pending = pendingFitRef.current;
      pendingFitRef.current = null;
      if (!pending || Date.now() > pending.until) return;
      try { applyViewport(pending.target, 0); } catch { /* pane gone */ }
      // Restamped, because this move arrives as an eventless onMove of its own
      // and the stamp from the fit that started it may already be outside the
      // window viewport-intent.ts measures.
      lastFitTimeRef.current = Date.now();
    };
    document.addEventListener("visibilitychange", land);
    return () => document.removeEventListener("visibilitychange", land);
  }, [applyViewport]);
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
  /** The pane the watchdog measures nodes against, in CSS pixels.
   *
   *  Written by the ResizeObserver on `.canvas-wrap` further down, which is the
   *  one thing in this component that knows how big the canvas is. A ref rather
   *  than the `canvasSize` state beside it for two reasons: the interval below
   *  is registered once and polls, so it wants a value it can read without
   *  being torn down and rebuilt on every resize; and `canvasSize` is
   *  deliberately quantised to 40px so a one-pixel resize cannot reflow the
   *  layout, which is exactly the rounding an intersection test must not
   *  inherit. Same observer, same element, same callback — this one keeps the
   *  reading whole.
   *
   *  Null until that observer first fires, and null for good on a browser
   *  without ResizeObserver. Both mean "the pane has not been measured", which
   *  shouldRefit treats as a reason not to decide. */
  const paneSizeRef = useRef<PaneSize | null>(null);
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
  // Sticky "user took the wheel" flag. Once the user manually pans, zooms,
  // or drags a node, autofitting is suspended until they hit the recenter
  // button, or the chip the canvas shows while it is off.
  //
  // NOT PERSISTED (#820). It was, "so a refresh respects the user's
  // preference", and what that bought was a pan from some earlier day still in
  // force across every reload after it: new sessions landing off to one side
  // of a mostly empty canvas that said nothing about why, the only sign a tint
  // on a 14px crosshair. A pan is a decision about this look at the board, not
  // a setting, so every load starts with the canvas fitting again. The key
  // older builds wrote is cleared once, below, so it stops meaning anything.
  const AUTOFIT_KEY = "agent-dag.autoFitDisabled";
  const autoFitDisabledRef = useRef(false);
  const [autoFitDisabled, setAutoFitDisabled] = useState(false);
  useEffect(() => { try { window.localStorage.removeItem(AUTOFIT_KEY); } catch {} }, []);
  const disableAutoFit = useCallback(() => {
    if (autoFitDisabledRef.current) return;
    autoFitDisabledRef.current = true;
    setAutoFitDisabled(true);
  }, []);
  const enableAutoFitAndRefit = useCallback(() => {
    autoFitDisabledRef.current = false;
    setAutoFitDisabled(false);
    fitLeft(400);
  }, [rf, fitLeft]);
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

  // Real per-node sizes — read from RF's internal store via a selector that
  // returns a monotonic counter. Counter only ticks when a measurement
  // actually changed (delta > 4px) or a new node was measured. No
  // recursion: stable input → stable output → no extra render.
  const measuredRef = useRef<Map<string, { width: number; height: number }>>(new Map());
  const measuredVersionRef = useRef(0);
  const measuredSelector = useCallback((s: ReactFlowState) => {
    const map = measuredRef.current;
    let changed = false;
    for (const n of s.nodeInternals.values()) {
      const w = n.width, h = n.height;
      if (w == null || h == null) continue;
      const prev = map.get(n.id);
      if (!prev) {
        map.set(n.id, { width: w, height: h });
        changed = true;
      } else if (Math.abs(prev.height - h) > 4 || Math.abs(prev.width - w) > 4) {
        map.set(n.id, { width: w, height: h });
        changed = true;
      }
    }
    if (changed) measuredVersionRef.current += 1;
    return measuredVersionRef.current;
  }, []);
  const sizeVersion = useStore(measuredSelector);
  const [domSizeVersion, setDomSizeVersion] = useState(0);

  // Measure the rendered cards directly, as a source that does not depend on
  // React Flow's store holding on to them.
  //
  // It does not: createNodeInternals rebuilds every entry as `{...node}` from
  // the incoming `nodes` prop, carrying over handleBounds but NOT width and
  // height. This canvas replaces that prop on every tick, so a measurement
  // taken by the ResizeObserver survives until the next render and is then
  // dropped. That closed a loop — the store lost the sizes, so the selector
  // above read null and skipped, so the map stayed empty, so the nodes we
  // passed carried no sizes for the store to keep. fitView needs dimensions
  // to compute bounds and silently returns false without them, which is why
  // nothing was ever framed.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const map = measuredRef.current;
      let changed = false;
      for (const el of document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")) {
        const id = el.getAttribute("data-id");
        if (!id) continue;
        const w = el.offsetWidth, h = el.offsetHeight;
        if (!w || !h) continue;
        const prev = map.get(id);
        // Same 4px deadband as the store selector: sub-pixel jitter must not
        // trigger a relayout.
        if (!prev || Math.abs(prev.width - w) > 4 || Math.abs(prev.height - h) > 4) {
          map.set(id, { width: w, height: h });
          changed = true;
        }
      }
      if (changed) setDomSizeVersion(v => v + 1);
    };
    // After paint, so the cards have their final size — except in a background
    // tab, where requestAnimationFrame never fires at all. The deck is a thing
    // people leave open on a second monitor or behind their editor, so an
    // rAF-only schedule means sizes stop updating exactly when nobody is
    // looking, and the layout they come back to was computed from stale ones.
    // offsetWidth/offsetHeight on every card forces a synchronous layout, and
    // a drag re-renders on every pointer move. Cards do not change size while
    // one is being dragged, so the whole pass is skipped for the gesture.
    if (draggingRef.current) return;
    let timer = 0;
    if (document.visibilityState === "hidden") {
      timer = window.setTimeout(measure, 32);
    } else {
      raf = requestAnimationFrame(measure);
    }
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
  });

  // Position cache + structural signature. Layout reruns only when the set
  // of visible agents OR sizes OR pin-set changes — NOT on every event.
  // Seeded from storage so a reload resumes the arrangement that was on screen
  // rather than re-deriving one. Anything without a stored position — a new
  // agent, or one whose position was evicted — still gets laid out.
  // Built once, beside the pinned half, in the initialiser up at
  // `restoredLayout` — the argument here is a read and not a `new Map` (#612).
  const positionsRef = useRef(restoredLayout.positions);
  // Which of those positions are placeholders. Deliberately not persisted: the
  // retry runs on the next render, at most a 250ms tick away, and the save
  // below is debounced 1500ms — so a placeholder is overwritten by a real
  // coordinate long before anything writes it to storage, and a mark restored
  // from a previous run would only relayout a node that has been settled since.
  const provisionalRef = useRef<Provisional>(new Set());
  const lastLayoutSigRef = useRef<string>("");
  const layoutSig = useMemo(() => {
    const ids: string[] = [];
    for (const a of stateRef.current.agents.values()) {
      // Mirror isAgentVisible exactly — layoutSig and visibleAgentIds must
      // agree, otherwise dagre re-runs for agents that never render and
      // the cached positions drift relative to what's actually on canvas.
      if (!isAgentVisible(a, now)) continue;
      ids.push(a.id + (a.parentId ? `>${a.parentId}` : ""));
    }
    ids.sort();
    return `${ids.join("|")}#sv${sizeVersion}.${domSizeVersion}`;
  }, [stateRef.current, stateRef.current.revision, now, sizeVersion, domSizeVersion]);

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
    () => computeVisibleIds(stateRef.current, now),
    [stateRef.current, stateRef.current.revision, now],
  );

  // Width of the canvas column, not the window: the side panels come and go,
  // and a layout packed for the whole window would run under them. Measured
  // rather than derived from the panel flags so it stays right however the
  // grid is configured.
  // HTMLElement rather than HTMLDivElement: the canvas is a <main> now (#381),
  // and nothing here reads a property a <div> has and a <main> does not.
  const canvasRef = useRef<HTMLElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      // Unrounded, and updated on every callback: the drift watchdog compares
      // node boxes against this rectangle, and a 40px tolerance in an
      // intersection test is a 40px strip of the canvas that reads as
      // off-screen. It is also the reading that has to be current the instant a
      // side panel opens or closes, which is precisely when the pane changes
      // width by 240-360px and the watchdog is most likely to be wrong (#615).
      paneSizeRef.current = { width: r.width, height: r.height };
      // Quantised so a one-pixel resize doesn't reflow the canvas.
      setCanvasSize(prev =>
        (Math.abs(prev.w - r.width) > 40 || Math.abs(prev.h - r.height) > 40)
          ? { w: r.width, h: r.height } : prev);
    });
    ro.observe(el);
    paneSizeRef.current = { width: el.clientWidth, height: el.clientHeight };
    setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
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
  // While true, node movement is animated instead of instant. Held only for
  // the length of the transition: a permanent transition would make dragging
  // lag behind the cursor.
  const [bubbling, setBubbling] = useState(false);
  const bubbleTimerRef = useRef<number | null>(null);
  // True for the length of any drag gesture. React Flow marks the node under
  // the cursor with .dragging, and the stylesheet drops its transition — but
  // dragging a SESSION moves its member cards through state rather than
  // through the gesture, so they keep the transition and trail the cursor by
  // its full duration. That is the "dragging isn't smooth" everyone notices
  // and nobody can point at. A flag on the pane covers every node a gesture
  // can move, whichever way it moves them.
  const [dragging, setDragging] = useState(false);
  /** WHICH CARD IS DRAWN AT THIS DISTANCE — detail, compact or overview.
   *
   *  The canvas zooms to 0.2, and below the full card every word on it is drawn
   *  at the canvas's scale: at 0.3 the 12px name is under 4px. The two smaller
   *  modes are faces laid out in screen pixels instead (AgentNode's NodeFace);
   *  which one is drawn is decided in semantic-zoom.ts from what the smallest
   *  card measures on screen, with a band either side of each threshold so a
   *  zoom resting near one cannot flip the canvas back and forth.
   *
   *  It lives on the canvas element rather than in each node ON PURPOSE. A node
   *  that subscribed to the viewport would re-render every card on every frame
   *  of a pinch, on a surface that already runs a 200-iteration relaxation and
   *  four resting animations; this is one attribute on one element, written
   *  only when the mode actually changes, which is a handful of times per
   *  gesture at most.
   *
   *  Nothing here changes a card's BOX. The faces are drawn over the card's own
   *  rows, which keep their space, because the measured height of a node is a
   *  layout input — shrinking a card at a distance would reflow the graph under
   *  the reader's hands, and the auto-fit would chase it. */
  const [lod, setLod] = useState<LodMode>("detail");
  const lodRef = useRef<LodMode | null>(null);
  /** The card the mode has to work for: the smallest agent card on the board,
   *  re-measured only when a measurement moved (measuredVersionRef). */
  const lodCardRef = useRef<{ version: number; card: CardSize } | null>(null);
  const lodCard = useCallback((): CardSize => {
    const version = measuredVersionRef.current;
    if (lodCardRef.current?.version === version) return lodCardRef.current.card;
    const sizes: CardSize[] = [];
    for (const id of stateRef.current.agents.keys()) {
      const m = measuredRef.current.get(id);
      if (m) sizes.push(m);
    }
    const card = referenceCard(sizes);
    lodCardRef.current = { version, card };
    return card;
  }, []);
  const endBubble = useCallback(() => {
    if (bubbleTimerRef.current) { window.clearTimeout(bubbleTimerRef.current); bubbleTimerRef.current = null; }
    setBubbling(false);
  }, []);
  const onBubble = useCallback((movedSessions: string[]) => {
    if (movedSessions.length === 0) return;
    // Raised from inside a useMemo, so the state change has to leave the
    // render pass before React sees it.
    queueMicrotask(() => {
      setBubbling(true);
      if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = window.setTimeout(() => setBubbling(false), BUBBLE_MS + 80);
    });
  }, []);
  useEffect(() => () => { if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current); }, []);

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

  // What the rail covers of the canvas — see railCover. Kept only when it moves
  // by more than the canvas's own 40px quantum.
  //
  // NAMED INPUTS RATHER THAN NO DEPENDENCY ARRAY (#997). This ran after EVERY
  // render, and `setNow` re-renders the deck four times a second on a completely
  // idle board, so an idle deck was spending a document-wide `querySelectorAll`
  // plus up to three `getBoundingClientRect` reads 240 times a minute to
  // re-derive a number that had not moved. The dep-less form was deliberate —
  // a panel opening changes the cover without resizing the canvas, which is why
  // `canvasSize` alone was not enough — so the fix is to name every input rather
  // than to drop the reading.
  //
  // The list is the complete set of things that can move `.sysdetail` or
  // `.usage-panel` relative to the canvas, and each one is in the sheet:
  //   · machinePhase / usagePhase — mount, and the `.leaving` class railCover
  //     filters on. The PHASES and not the open flags: `usePanelPresence` flips
  //     the flag one render before the panel is in the DOM, so a dep on the flag
  //     would measure the frame before the panel existed and never look again.
  //   · usagePanelOpen — `.sysdetail.shifted`, which moves the machine panel
  //     300px and is driven by the raw flag, a render ahead of usagePhase.
  //   · detailShown — `--rail-r`, 368px against 8px, for both panels.
  //   · canvasSize.w — the canvas box itself, which is what the cover is
  //     measured against. Already quantised to 40px, the same quantum as the
  //     deadband below, and it is the only way the accounts panel and a window
  //     resize reach this: both change the canvas column's width.
  const [railInset, setRailInset] = useState(0);
  useEffect(() => {
    const cover = railCover(canvasRef.current);
    setRailInset(prev => (Math.abs(prev - cover) > 40 ? cover : prev));
  }, [machinePhase, usagePhase, usagePanelOpen, detailShown, canvasSize.w]);
  // The same reading for the handlers that frame a card or place its peek:
  // they run on a press or a hover, and asking the document again there would
  // be a third query of what this effect has just measured.
  const railInsetRef = useRef(railInset);
  railInsetRef.current = railInset;

  // The frame fitLeft will show the board in, in flow units at full size: the
  // canvas less the rail's strip, less the fit's margins and fill. The layout
  // scores every arrangement by the zoom it gets in this frame, so the board
  // spreads sideways as far as the visible canvas is wide, and no further.
  const availableWidth = canvasSize.w > 0
    ? Math.max(0, (canvasSize.w - railInset - FIT_MARGIN * 2) * FIT_FILL) : 0;
  const availableHeight = canvasSize.h > 0
    ? Math.max(0, (canvasSize.h - FIT_MARGIN * 2) * FIT_FILL) : 0;

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
      selectedIds, spotlightSet, visibleAgentIds, openContext,
      );
      return visibleBoard(flow.nodes, flow.edges, removedNodes);
    },
    [stateRef.current, stateRef.current.revision, now, availableWidth, availableHeight, settled, dragging, layoutSig, selectedIds, spotlightSet, visibleAgentIds, openContext, dragTick, recapNotesVersion, removedNodes],
  );

  // THE FRAME THE BOARD ON SCREEN WAS PACKED FOR (#995).
  //
  // Seeded from storage, because the frame a restored layout was built in is
  // not this window's: a deck reopened after a monitor change comes back with
  // coordinates that are internally consistent and shaped for a canvas that is
  // no longer there.
  //
  // Read through a lazy initialiser and held in a ref, the shape `restoredLayout`
  // uses: `useRef(loadLayoutFrame())` would put a localStorage read on the
  // render path for an answer only the first render asks for (#612).
  const restoredLayoutFrame = useState(loadLayoutFrame)[0];
  const lastLayoutFrameRef = useRef<Frame | null>(restoredLayoutFrame);
  // Re-column when the frame changes ENOUGH TO CHANGE THE ANSWER.
  //
  // autoLayout picks the column count by scoring each arrangement against the
  // frame a fit will show it in, but the key that decides whether it runs again
  // — visible agent ids plus the two size versions — says nothing about the
  // frame. Closing the accounts and usage panels on a 1280px window takes the
  // frame from 457.5 to 963.2 flow units (measured in Firefox against this
  // sheet), which is the difference between one column and two for a board of
  // four to six sessions. Nothing reconsidered it, so the board stayed a tall
  // strip beside empty canvas until the user pressed R.
  //
  // Adding the frame to `layoutSig` would not have done this: the branch that
  // re-columns is inside `if (missing.length > 0)`, and with every node already
  // placed a signature change reaches only separateOverlaps. Re-columning means
  // dropping the cached positions, which is what R does — minus the pins, which
  // are the user's own placements and survive here as they do in joinSessions.
  //
  // Gated on the ANSWER changing rather than on the frame moving. The frame
  // steps on every 40px of a window drag; the column count changes at a handful
  // of widths, and re-laying out on anything less would throw away the
  // arrangement fillGapsWithNewSessions built for a change that moves nothing.
  useEffect(() => {
    if (!settled || dragging) return;
    const frame: Frame = { width: availableWidth, height: availableHeight };
    if (!(frame.width > 0 && frame.height > 0)) return;
    const prev = lastLayoutFrameRef.current;
    lastLayoutFrameRef.current = frame;
    saveLayoutFrame(frame);
    if (!prev || (prev.width === frame.width && prev.height === frame.height)) return;
    const opts = {
      direction: "LR" as const,
      pinned: pinnedRef.current,
      measured: measuredRef.current,
      lanes: laneMap(stateRef.current),
    };
    if (!columnsWouldChange(nodes, edges, opts, prev, frame)) return;
    // WHAT THE READER IS LOOKING AT, BEFORE THE BOARD MOVES UNDER IT. With the
    // auto-fit on, the fit below frames the new arrangement and nothing needs
    // keeping. With it off — a pan, or a focus — the camera used to stay where
    // it was while every session moved to a new column, so selecting a card
    // (which opens the detail panel, which narrows the canvas, which is this
    // frame change) sent the card the reader had just clicked somewhere off
    // the screen they were reading. A double-click to focus lost its session
    // the same way: the focus framed where the card was a paint before the
    // re-pack moved it.
    const focused = lastFocusRef.current && Date.now() - lastFocusRef.current.at < 1500 ? lastFocusRef.current.id : null;
    const keepId = focused ?? primarySelectedIdRef.current;
    const keptAt = keepId ? (pinnedRef.current.get(keepId) ?? positionsRef.current.get(keepId)) : undefined;
    for (const id of Array.from(positionsRef.current.keys())) {
      if (!pinnedRef.current.has(id)) positionsRef.current.delete(id);
    }
    provisionalRef.current.clear();
    lastLayoutSigRef.current = "";
    rerender();
    // Same 80ms handleRelayout waits: React and React Flow get one paint to
    // settle the new positions before the camera is asked to frame them.
    window.setTimeout(() => {
      // The board is only rebuilt during the render `rerender` scheduled —
      // positionsRef holds nothing but the pins until then — so this is the
      // first moment there is a new arrangement to store. It has to be stored
      // here because the debounced save is keyed on layoutSig, which a frame
      // change does not move: without this the next reload would restore the
      // arrangement this pass just replaced, beside a frame record saying it
      // was packed for the new window.
      saveLayout(positionsRef.current, pinnedRef.current);
      if (autoFitDisabledRef.current) {
        // A focus this recent is framed again, from the new arrangement.
        if (focused) { focusAgentRef.current(focused); return; }
        // Otherwise the selected card stays where it was on screen: the view
        // moves by exactly as far as the re-pack moved the card.
        const movedTo = keepId ? (pinnedRef.current.get(keepId) ?? positionsRef.current.get(keepId)) : undefined;
        if (keptAt && movedTo && (movedTo.x !== keptAt.x || movedTo.y !== keptAt.y)) {
          const vp = rf.getViewport();
          cameraEpochRef.current += 1;
          applyViewport({ x: vp.x - (movedTo.x - keptAt.x) * vp.zoom, y: vp.y - (movedTo.y - keptAt.y) * vp.zoom, zoom: vp.zoom }, 0);
          lastFitTimeRef.current = Date.now();
        }
        return;
      }
      fitLeft(500);
    }, 80);
    // `nodes` and `edges` are read, not watched: they are rebuilt four times a
    // second and this has to run when the FRAME moves, on whatever board was on
    // screen at that moment.
  }, [availableWidth, availableHeight, settled, dragging, rerender, fitLeft, rf, applyViewport]);

  // Invisible per-session drag-handle nodes. One per session, sized to the
  // bounding box of that session's agent nodes and rendered behind them
  // (negative zIndex). Grabbing the empty canvas behind a session drags the
  // whole session; the agent nodes stay on top and individually draggable.
  const groupNodes = useMemo(() => {
    const bySession = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const n of nodes) {
      const d = n.data as AgentNodeData | undefined;
      if (!d?.sessionId || d.exitAt != null) continue;
      const w = n.width, h = n.height;
      if (w == null || h == null) continue; // unmeasured — skip this frame
      const x1 = n.position.x, y1 = n.position.y, x2 = x1 + w, y2 = y1 + h;
      const b = bySession.get(d.sessionId);
      if (!b) bySession.set(d.sessionId, { minX: x1, minY: y1, maxX: x2, maxY: y2 });
      else {
        b.minX = Math.min(b.minX, x1); b.minY = Math.min(b.minY, y1);
        b.maxX = Math.max(b.maxX, x2); b.maxY = Math.max(b.maxY, y2);
      }
    }
    const out: typeof nodes = [];
    for (const [sid, b] of bySession) {
      // Cover the nodes + padding, but NOT the header strip above them — that
      // area holds SessionClusters' clickable label (fit-view), which must stay
      // hittable above this handle.
      const w = b.maxX - b.minX + GROUP_PAD * 2;
      const h = b.maxY - b.minY + GROUP_PAD * 2;
      out.push({
        id: `group:${sid}`,
        type: SESSION_GROUP_TYPE,
        position: { x: b.minX - GROUP_PAD, y: b.minY - GROUP_PAD },
        // w/h handed to the node component so it can size itself in explicit
        // pixels (a 100% child would collapse under RF's content sizing).
        data: { sessionId: sid, w, h } as unknown as AgentNodeData,
        width: w,
        height: h,
        style: { width: w, height: h },
        zIndex: -1,
        draggable: true,
        selectable: false,
        focusable: false,
        deletable: false,
        connectable: false,
      });
    }
    return out;
  }, [nodes]);

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


  // Which categories currently have at least one tool on the canvas — the
  // filter row only shows chips for active categories so users aren't
  // staring at empty toggle buttons.
  const presentCats = useMemo<DetailCategory[]>(() => {
    const set = new Set<DetailCategory>();
    for (const a of stateRef.current.agents.values()) {
      for (const t of a.tools) set.add(detailCategoryFor(t.name));
    }
    // Stable order: same as DETAIL_CAT_EMOJI declaration order.
    return (Object.keys(DETAIL_CAT_EMOJI) as DetailCategory[]).filter(c => set.has(c));
  }, [stateRef.current, stateRef.current.revision]);
  useEffect(() => {
    if (presentCats.length <= 1) { setCatBarOccluded(false); return; }
    let timer = 0;
    const tick = () => {
      const bar = catBarRef.current;
      if (bar && !document.hidden) {
        const b = bar.getBoundingClientRect();
        // Cards and bubbles both — a bubble is what the report showed, and it
        // lives in a different layer from the nodes.
        const boxes = Array.from(document.querySelectorAll(".react-flow__node, .tool-burst"))
          .map(el => el.getBoundingClientRect());
        const hit = anyTouches(b, boxes, 8);
        setCatBarOccluded(prev => (prev === hit ? prev : hit));
      }
      timer = window.setTimeout(tick, 300);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [presentCats.length]);

  const toggleCat = useCallback((c: DetailCategory) => {
    setHiddenCats(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  }, []);

  // `selected` is declared with the rail measurement further up this file,
  // which needs to know whether the detail panel is mounted.

  // The tool the modal is showing, found without building a list of the ones it
  // is not (#997). In the render body and not skippable — `modalOpenRef` below
  // reads `openedTool != null` — so while the modal is open this runs on every
  // render, four times a second on an idle deck. What it must not do on that
  // tick is why the walk lives in the reducer; see findToolOnBoard.
  const openedTool: ToolCall | null =
    openedToolId ? findToolOnBoard(stateRef.current.agents, openedToolId) : null;

  const handleClear = useCallback(async () => {
    try { await fetch("/api/clear", { method: "POST" }); } catch {}
    stateRef.current = initialState();
    pinnedRef.current.clear();
    measuredRef.current.clear();
    positionsRef.current.clear();
    lastLayoutSigRef.current = "";
    clearStoredLayout();
    setRemovedNodes(new Set());
    try { window.localStorage.removeItem(REMOVED_NODES_KEY); } catch { /* disabled storage */ }
    clearSelection();
    rerender();
  }, [rerender, clearSelection]);

  const removeSelectedNode = useCallback(() => {
    if (!primarySelectedId || !stateRef.current.agents.has(primarySelectedId)) return;
    setRemovedNodes(previous => {
      const next = new Set(previous);
      next.add(primarySelectedId);
      saveRemovedNodes(window.localStorage, next);
      return next;
    });
    pinnedRef.current.delete(primarySelectedId);
    positionsRef.current.delete(primarySelectedId);
    clearSelection();
  }, [primarySelectedId, clearSelection]);

  // The keydown listener below is registered once and must stay that way, so
  // the gate reads what is on screen through refs rather than closing over it.
  // Assigned during render, the way nodesRef is, so a keystroke in the same
  // commit sees the dialogs that were just drawn.
  const clearConfirmOpenRef = useRef(clearConfirmOpen);
  clearConfirmOpenRef.current = clearConfirmOpen;
  // The same treatment for the shortcuts sheet, because `?` is a toggle and the
  // gate below has to be able to tell "the sheet is the modal" from "a modal is
  // open" — the first still answers `?`, the second must not stack a second one.
  const keyHelpOpenRef = useRef(keyHelpOpen);
  keyHelpOpenRef.current = keyHelpOpen;
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

  const handleRelayout = useCallback(() => {
    pinnedRef.current.clear();
    positionsRef.current.clear();
    lastLayoutSigRef.current = "";
    clearStoredLayout();
    rerender();
    // After dagre runs on the next render, fit-view so the user sees the
    // result. 80ms gives React + RF one paint to settle the new positions.
    window.setTimeout(() => fitLeft(500), 80);
  }, [rerender, rf, fitLeft]);

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
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  /** BRING ONE CARD, AND THE SESSION IT BELONGS TO, INTO A READABLE VIEW.
   *
   *  Every "take me to this card" in the deck comes through here — the ribbon,
   *  a cluster's name, a double-click, Z, j/k, W and the session list. They each
   *  called React Flow's `fitView` over the one node, which centres on the whole
   *  pane — under the machine and usage panels whenever those are open — and
   *  zooms to the canvas's 1.6 ceiling, with the rest of the session cut out of
   *  the frame. focus-camera.ts holds the replacement: the session in the part
   *  of the pane nobody covers, at a zoom the full card is drawn at.
   *
   *  AND IT TAKES THE WHEEL, the way a pan does. Asking to look at one session
   *  is the reader choosing the view, and the auto-fit used to take it straight
   *  back: the next tool lane or card anywhere moved layoutSig, fitLeft framed
   *  the whole board again, and the session the reader had just gone to was a
   *  tile once more. The chip that says auto-fit is off, and its Resume, are
   *  the way back — the same as after a pan. */
  const focusAgent = useCallback((id: string) => {
    const pane = canvasRef.current;
    const agent = stateRef.current.agents.get(id);
    if (!pane || !agent) return;
    const lanes = laneMap(stateRef.current);
    const boxOf = (n: Node<FlowNodeData>, withLane: boolean): FlowBox | null => {
      const m = measuredRef.current.get(n.id);
      if (!m) return null;
      // The bubbles an agent has called are drawn to its right and are part
      // of what the reader came to see: the same allowance fitLeft makes.
      const lane = withLane && lanes.has(n.id) ? TOOL_LANE_ALLOWANCE : 0;
      return { x: n.position.x, y: n.position.y, width: m.width + lane, height: m.height };
    };
    const own = nodesRef.current.find(n => n.id === id);
    const anchor = own ? boxOf(own, false) : null;
    if (!anchor) return;
    const members: FlowBox[] = [];
    for (const n of nodesRef.current) {
      if (n.type !== "agent" && n.type !== "recapNote") continue;
      if ((n.data as { sessionId?: string } | undefined)?.sessionId !== agent.sessionId) continue;
      const b = boxOf(n, n.type === "agent");
      if (b) members.push(b);
    }
    const rect = pane.getBoundingClientRect();
    const want = focusViewport({
      pane: { width: rect.width, height: rect.height },
      // Left: the control stack. Top: the tool filter bar. Right: whatever of
      // the rail of floating panels is open, as the rail effect measured it.
      insets: { top: 56, left: 72, bottom: 32, right: railInsetRef.current + 32 },
      context: unionBox(members) ?? anchor,
      anchor,
    });
    hidePeek();
    disableAutoFit();
    lastFocusRef.current = { id, at: Date.now() };
    cameraEpochRef.current += 1;
    applyViewport(want, FOCUS_MS);
    lastFitTimeRef.current = Date.now();
    // The same insurance fitLeft takes against a tab hidden mid-flight: the
    // visibility handler lands whatever is pending where it was going.
    pendingFitRef.current = shouldAnimateViewport({ durationMs: FOCUS_MS, documentHidden: document.hidden })
      ? { target: want, until: Date.now() + FOCUS_MS + 60 }
      : null;
  }, [applyViewport, disableAutoFit]);

  focusAgentRef.current = focusAgent;

  // What the peek reads, through refs so the three are made once: the node's
  // own data (branch summary included), a parent's label, and the room it may
  // open into — the canvas less the rail of panels over its right edge.
  const peekAgent = useCallback((id: string) => {
    const n = nodesRef.current.find(x => x.id === id && x.type === "agent");
    return n ? (n.data as FlowNodeData) : undefined;
  }, []);
  const peekLabel = useCallback((id: string) => stateRef.current.agents.get(id)?.label, []);
  const peekRecap = useCallback((id: string) => {
    const n = nodesRef.current.find(x => x.id === id && x.type === "recapNote");
    if (!n) return undefined;
    const d = n.data as unknown as RecapNoteData;
    return { recap: d.recap, hue: d.hue, sessionLabel: stateRef.current.agents.get(d.parentId)?.label };
  }, []);
  const peekBounds = useCallback(() => {
    // The canvas's own box, not the window's: the peek belongs over the canvas,
    // and the canvas already runs to the foot of the page.
    const box = canvasRef.current?.getBoundingClientRect();
    const doc = document.documentElement;
    return box
      ? { width: box.right - railInsetRef.current, height: box.bottom }
      : { width: doc.clientWidth, height: doc.clientHeight };
  }, []);
  const primarySelectedIdRef = useRef(primarySelectedId);
  primarySelectedIdRef.current = primarySelectedId;

  /** Step through visible agents in render order. `direction` is +1 for
   *  next (j) or -1 for previous (k). Selecting moves the canvas to keep
   *  the chosen agent in view.
   *
   *  The order and the wrap-around live in canvas-keys.ts, where they can be
   *  tested without a canvas; what stays here is the two things that need one,
   *  the fit and the focus. */
  const stepAgent = useCallback((direction: 1 | -1) => {
    // Cards only: a recap note is a node on the canvas, not a stop for j and k.
    const current = nodesRef.current.filter(n => n.type === "agent");
    const targetId = stepTarget(
      current.map(n => ({ id: n.id, x: n.position.x, y: n.position.y })),
      primarySelectedIdRef.current,
      direction,
    );
    const target = targetId ? current.find(n => n.id === targetId) : undefined;
    if (!target) return;
    // Traversal takes the keyboard with it, but only when the keyboard was
    // already on a card. j from <body> is the shortcut it has always been —
    // it selects, and every other single-key shortcut stays live because
    // nothing is focused. j from a card is navigation, and leaving focus
    // behind on the card the user just stepped off would make the next Enter
    // re-select the one they left rather than the one they moved to.
    const follow = isCanvasNodeElement(document.activeElement);
    selectAgent(target.id, false);
    // Fit-view to the chosen node so it lands on screen even if the user
    // had panned away.
    window.setTimeout(() => {
      try { focusAgent(target.id); } catch {}
      if (follow) focusCanvasNode(target.id);
    }, 30);
  }, [selectAgent, focusAgent]);

  /** Select a session's root and bring it on screen. Reads `nodesRef` rather
   *  than the render-scope array so callers can be memoised: the array is
   *  rebuilt every render and would otherwise re-create every handler that
   *  closes over it. The frame of delay is for the same reason the session list
   *  has always needed one — the node has to be laid out before fitView can
   *  have anything to fit to. */
  /** The blocked session W went to last (#825), so the next press moves on to
   *  the one after it. The waiting button writes it too: the two are one way in. */
  const waitingCursorRef = useRef<string | null>(null);

  const focusSession = useCallback((sessionId: string) => {
    selectAgent(sessionId, false);
    window.setTimeout(() => {
      try { focusAgent(sessionId); } catch {}
    }, 60);
  }, [selectAgent, focusAgent]);

  // Which element a POINTER put focus on, so a button the mouse pressed stops
  // swallowing the single-key shortcuts (#851; the rule is ownsKeystroke's).
  // Tracked here because the browser cannot be asked at keydown time —
  // `:focus-visible` is re-decided by the keystroke itself. A focus that lands
  // within a moment of a press came from the press; any other focus (Tab, a
  // dialog handing focus back) clears the mark.
  const pointerFocusRef = useRef<EventTarget | null>(null);
  useEffect(() => {
    let pressedAt = -Infinity;
    const onPress = () => { pressedAt = performance.now(); };
    const onFocus = (e: FocusEvent) => {
      pointerFocusRef.current = performance.now() - pressedAt < 250 ? e.target : null;
    };
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("focusin", onFocus, true);
    return () => {
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("focusin", onFocus, true);
    };
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The listener is on window in the bubble phase, so it sees every
      // keystroke aimed at every focused control on the page. Read the four
      // things the rules need off the target — getAttribute rather than the
      // reflected .role property, which older browsers do not expose.
      const el = e.target as (HTMLElement & { type?: string }) | null;
      const target: FocusTarget = {
        tagName: el?.tagName,
        isContentEditable: el?.isContentEditable,
        role: el?.getAttribute?.("role"),
        type: el?.type,
        pointerFocused: el != null && el === pointerFocusRef.current,
      };
      if (e.key === "Escape") {
        // One press, one owner. This branch used to clear the canvas selection
        // while whichever modal was on screen closed itself on the same event
        // — every modal listened on window too, so the tool modal shut and the
        // selection behind it vanished with it. The modals queue in
        // modal-dismiss.ts now and only the topmost answers.
        const outcome = escapeOutcome({ overlayOpen: modalStack.depth() > 0, typing: isTypingTarget(target) });
        if (outcome === "dismiss") modalStack.dismissTop();
        else if (outcome === "blur") el?.blur();
        else {
          // And the branch that gave the keyboard its way back. Every control
          // on this deck is a <button> or a role="button", so the gate below
          // — which is right to leave a focused control its own keys — killed
          // all thirteen single-key shortcuts the moment the first Tab landed,
          // for the rest of the session: tabbing off the end of the document
          // wraps to the first control rather than to <body>, and Escape only
          // released focus when the user was typing, which a button never is.
          // Releasing it here is what makes the next j, /, space or l work.
          // The selection still clears on the same press, so nothing about the
          // mouse's Escape changes.
          if (shouldReleaseFocusOnEscape(target)) el?.blur();
          clearSelection();
        }
        return;
      }
      // Ctrl/Cmd/Alt chords are the browser's, not ours — Ctrl+C is copy and
      // Ctrl+R is reload, and both arrive here as the bare letter. Asked before
      // the canvas branch below rather than after the gate it used to sit
      // behind, so that Cmd+Enter on a focused card stays the browser's too.
      if (isBrowserChord(e)) return;
      // An agent card is the one focusable thing here that is not really a
      // control: React Flow makes every node a tabbable role="button" and then
      // answers Enter itself through a store write that a controlled `nodes`
      // prop skips, so the card announced itself as a button and did nothing at
      // all. This is where the keyboard gets the click's behaviour — including
      // Shift for additive, the way Shift+click already works in onNodeClick.
      // Checked against the array React Flow is rendering rather than trusted
      // from the DOM: the invisible per-session drag handles are wrappers with
      // a data-id too, and they are not agents. They are focusable={false} so
      // no keystroke should ever arrive from one, but selecting an id that is
      // not on the canvas would leave a selection nothing can show or clear.
      const focusedId = isCanvasNodeElement(el) ? el?.getAttribute?.("data-id") : null;
      const focusedNodeId = focusedId && nodesRef.current.some(n => n.id === focusedId) ? focusedId : null;
      const intent = canvasKeyIntent(e, focusedNodeId);
      if (intent.kind === "activate") {
        e.preventDefault();
        selectAgent(intent.nodeId, intent.additive);
        return;
      }
      // Arrows and Delete belong to the card, whatever React Flow does or does
      // not do with them.
      if (intent.kind === "node") return;
      // A focused control owns its own keys: Space presses a button, letters
      // run a <select>'s type-ahead. Answering them stole the button's
      // activation key and let a bare "c" from a dropdown wipe the event log.
      //
      // A card is exempt. It wears role="button" because React Flow put it
      // there, not because it is a control the user typed into, and the two
      // keys it genuinely owns were answered above — so j still traverses and
      // / still reaches the search box while a card holds focus, which is the
      // whole point of being able to tab onto one.
      if (intent.nodeId == null && ownsKeystroke(target, e.key)) return;
      // A modal is on screen, and focus is not necessarily inside it.
      //
      // The gate above asks the FOCUSED ELEMENT whether it owns the keystroke,
      // which is the right question for a text field and the wrong one here:
      // use-modal-dismiss.ts states outright that "clicking a paragraph of modal
      // text drops focus on <body>", and BODY is in neither KEY_OWNING_TAGS nor
      // KEY_OWNING_ROLES. So reading a tool call's JSON payload, then pressing a
      // letter, ran that letter against the canvas behind the scrim.
      //
      // R is the one that hurt: handleRelayout clears every pin, every stored
      // position and both localStorage keys, so an arrangement the user built by
      // hand was gone with no undo — and they did not see it happen until they
      // closed the modal. H stacked a second modal over the first, Space paused
      // the stream, A/U/L opened panels underneath.
      //
      // This is not a new rule, it is the rule `c` already had: the comment on
      // modalOpenRef above describes this exact focus path, and the fix was
      // applied to the clear path alone. modalOpenRef was already computed and
      // already correct; it just had one caller.
      //
      // `?` is the exception, and only for the sheet itself. It is advertised as
      // a toggle, so it has to be able to close what it opened; over any OTHER
      // modal it would stack a second one, which is what this gate is for.
      // Escape is unaffected — it is answered further up, through modalStack.
      //
      // And the gate asks the stack as well as modalOpenRef (#1175): the nine
      // dialogs a panel opens — processes, history, add, share, the LAN four,
      // a pairing request, the clear prompt — have no flag in this component,
      // so the ref alone let R wipe the layout behind every one of them.
      if (shortcutBlocked({
        key: e.key,
        modalOpen: canvasModalOpen({ appModal: modalOpenRef.current, dialogDepth: modalStack.dialogDepth() }),
        sheetOpen: keyHelpOpenRef.current,
      })) return;
      if (e.key === " ") { e.preventDefault(); togglePause(); }
      if (e.key === "c" || e.key === "C") requestClear("shortcut");
      if (e.key === "r" || e.key === "R") handleRelayout();
      if (e.key === "f" || e.key === "F") handleFit();
      // F is the whole board; Z is the one card the selection is on, framed
      // with its session at a readable size — the ribbon's click, on a key.
      if (e.key === "z" || e.key === "Z") {
        if (primarySelectedIdRef.current) focusAgent(primarySelectedIdRef.current);
      }
      // The only way in, now that the topbar's ☰ is gone — and a genuine
      // toggle, so the same key that opened the sidebar closes it again. The
      // panel's own ‹ is the second way out and calls the same setter; Escape
      // is not and never was one, because the session list is an <aside> beside
      // the canvas rather than a modal, so it registers no dismisser with
      // modalStack (see modal-dismiss.ts). The shortcuts sheet below still
      // lists L, which is where the feature is discoverable from now.
      //
      // What removing the button cost the accessibility tree: aria-expanded on
      // that ☰ was the only place the panel's open/closed state was reported,
      // and nothing replaces it. It was never read on THIS path — a key pressed
      // while focus is elsewhere changes a button's state silently — so what is
      // actually lost is the ability to tab to a control and ask. The panel
      // itself is still announced when it is open: it is a named complementary
      // landmark ("Sessions") that the rotor lists, and its close button is the
      // first control in it.
      if (e.key === "l" || e.key === "L") toggleSessionList();
      // The detail panel's keyboard toggle, and no longer its only route. The
      // reopen tab that sat on the canvas edge stays gone, by the owner's
      // decision; what changed (#814, the owner's call on 2026-09-14) is that a
      // plain selection opens the panel — see selectAgent — so a panel closed
      // with its × comes back on the next card clicked instead of waiting for
      // somebody to find this key.
      //
      // With nothing selected (#845) the toggle used to flip a flag that showed
      // nothing — the panel only renders beside a selection — and the next
      // click then opened it by surprise. So D first picks something for the
      // panel to be about: the session that has waited longest, which is what
      // somebody reaching for it with nothing selected most likely wants, or
      // else the card j would land on. Selecting opens the panel by itself.
      if (e.key === "d" || e.key === "D") {
        if (primarySelectedIdRef.current) setDetailOpen(o => !o);
        else {
          const waiting = blockedSessions(stateRef.current.agents.values());
          if (waiting.length > 0) focusSession(waiting[0].id); else stepAgent(1);
        }
      }
      if (e.key === "h" || e.key === "H") setUsageHistoryOpen(o => !o);
      if (e.key === "u" || e.key === "U") setUsagePanelOpen(o => !o);
      // Nothing to disclose on a deck with no Claude Code: the button is not
      // rendered and the panel is not mounted, so an unguarded `A` would only
      // toggle a persisted flag nobody can see the effect of.
      if (e.key === "a" || e.key === "A") { if (providersRef.current.claude) toggleAccountsPanel(); }
      if (e.key === "j" || e.key === "J") stepAgent(1);
      if (e.key === "k" || e.key === "K") stepAgent(-1);
      // #825: the most urgent move in the deck, on a key. J and K walk every
      // agent in position order; W goes to the session blocked on the reader —
      // the one the "N waiting" button goes to, oldest first — and each press
      // after it to the next, wrapping. Nothing waiting, nothing happens.
      if (e.key === "w" || e.key === "W") {
        const next = nextWaiting(blockedSessions(stateRef.current.agents.values()), waitingCursorRef.current);
        if (next) {
          waitingCursorRef.current = next.id;
          focusSession(next.id);
        }
      }
      if (e.key === "t" || e.key === "T") setTheme(t => (t === "dark" ? "light" : "dark"));
      // The last topbar control to get a key, and the only one that reads
      // Shift. Every other letter here treats "C" and "c" alike — a Caps-locked
      // keyboard sends the upper case for the same press — and this one does
      // too for the toggle; what Shift adds is the keyboard's version of the
      // shift-click that puts the user's own parked hooks back, which was a
      // recovery with no key, no control and no home outside a tooltip. Same
      // control, same modifier, same outcome: activateSound is the one door
      // both devices come through, so the two can never drift apart.
      // Guarded exactly the way A is, plus the state the button waits for:
      // without Claude Code the button is not drawn, and before the stored flag
      // has been read back there is nothing to invert.
      if (e.key === "m" || e.key === "M") {
        if (providersRef.current.claude && soundOnRef.current !== null) activateSoundRef.current(e.shiftKey);
      }
      // #826: the three topbar panels that were pointer-only. S for this
      // machine (the system's readings), B for Browser Watch, V for the sound
      // menu — volume and tones, where M is the switch itself. V is guarded the
      // way the speaker is drawn, exactly as M is.
      if (e.key === "s" || e.key === "S") setMachinePanelOpen(o => !o);
      if (e.key === "b" || e.key === "B") setBrowserWatchOpen(o => !o);
      if (e.key === "v" || e.key === "V") {
        if (providersRef.current.claude && soundOnRef.current !== null) setSoundMenuOpen(o => !o);
      }
      // The way in that does not depend on already knowing the way in. `?` is
      // the convention, it was unbound, and it is the one key on this list that
      // a user who knows nothing about the deck might still try. Everything it
      // opens is written down in key-help.ts, held against this handler by a
      // test, so the sheet cannot fall behind the keys again.
      if (e.key === "?") setKeyHelpOpen(o => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClear, handleRelayout, handleFit, clearSelection, selectAgent, stepAgent, focusSession, focusAgent, togglePause]);

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
  // The same fact as the two lines above, on the one channel that had it from
  // neither: spoken.
  //
  // A blocked session reached the tab title, the favicon, the amber topbar chip
  // and the card's own row, and every one of those four is a thing you have to
  // look at. #372: the deck's one alarm-worthy event was announced nowhere,
  // while the stat strip beside it was a live region wrapped around a counter
  // that moves on every hook event. Both halves are the same mistake — a live
  // region spent on what changes rather than on what matters — and the second
  // half is the more expensive one, because a region that talks through a tool
  // storm is a region the user switches off before the first real alarm.
  //
  // `blockedAnnouncement` is pure and runs on the render path; `nextAnnouncement`
  // is the reducer that decides whether that sentence is news. Both live in
  // block-announce.ts, where a suite with no DOM can call them — see the file
  // for why the all-clear string is load-bearing and why this is a reducer over
  // committed state rather than a latch advanced during render.
  //
  // The effect depends on the SENTENCE, not on the session list. `waitingSessions`
  // is rebuilt whenever `revision` moves — which is every event AND every sweep,
  // since #536 — so a list-shaped dependency would re-run this through every
  // event of every tool storm, and through the 250ms tick besides, to discover
  // each time that nothing had changed. A string dependency runs it only when
  // the words move, and React's own bail-out on an identical state value means
  // even that costs no render.
  //
  // This said `lastSeq` until #575. The argument was right and the mechanism
  // named was not: `lastSeq` advances on the envelope path alone, so by the time
  // anyone read this sentence it was describing a dependency the memo above no
  // longer had. A comment that explains a dependency has to be corrected with
  // it, or it becomes the reason the next person restores the wrong one.
  const [blockedSaid, setBlockedSaid] = useState("");
  const blockedNow = blockedAnnouncement(waitingSessions);
  useEffect(() => {
    setBlockedSaid(said => nextAnnouncement(said, blockedNow));
  }, [blockedNow]);

  const [watchSaid, setWatchSaid] = useState("");
  const watchNow = watchUnseen > 0
    ? `Browser watch has ${watchUnseen} unread ${watchUnseen === 1 ? "finding" : "findings"}.`
    : "";
  useEffect(() => {
    setWatchSaid(said => nextAnnouncement(said, watchNow, "Browser watch has no unread findings."));
  }, [watchNow]);

  // The fifth surface, and the only one that leaves the page.
  //
  // The four above — chip, title, favicon, live region — all answer "which
  // agent is waiting on me" to somebody who is already looking at the deck.
  // The block this feature exists for is the one nobody is looking at, and for
  // that one the deck's reply has been "come and look". A system notification
  // is the only thing it can say into an empty room.
  //
  // Every rule about WHETHER to speak is in notify.ts, where the bare-node
  // suite can call it; what is here is the DOM the rule is not allowed to own —
  // the permission read, the `new Notification`, the click that brings the tab
  // back. Same division as ambient.ts and block-announce.ts, for the same
  // reason: a rule spelled out inside a component is a rule the tests cannot
  // call, and what cannot be called gets copied and then drifts.
  //
  // THE MEMO IS A REF, NOT STATE. Nothing on screen reads it, and making it
  // state would re-render the whole canvas every time a notification was
  // raised — to show exactly what was already showing.
  //
  // The dependency is the KEY STRING and not the session list, the same trick
  // the announcement above uses and for the same measured reason: the list is
  // rebuilt whenever `revision` moves, which is every event and every sweep, so
  // a list-shaped dependency would re-run this through every event of every
  // tool storm. Joined keys move only when the set of blocks does.
  // Read once into state rather than off `Notification.permission` on the
  // render path, so that granting it re-renders the bar and takes the button
  // away. The initialiser has to tolerate the API being absent — this bundle
  // also runs in the bare-node suite, and `Notification` is not defined there.
  const [notifyPermission, setNotifyPermission] = useState<NotifyPermission>(
    () => (typeof Notification === "undefined" ? "denied" : Notification.permission as NotifyPermission),
  );
  /** What to say after the browser has been answered, or null when there is
   *  nothing to say. Pressing a button and watching it vanish is the same
   *  picture whether it worked or was refused, and the refusal is the one that
   *  matters: the user believes they switched something on that is off. */
  const [notifySaid, setNotifySaid] = useState<"on" | "blocked" | null>(null);
  /** Latched the first time the offer is shown. Without it the button is a
   *  moving target — it is mounted on `waitingSessions.length > 0`, so a block
   *  answered in the five seconds it takes to reach for it takes the button out
   *  from under the cursor. Once offered, it stays until it is answered. */
  /** The deck's own switch, which is a different question from the browser's
   *  permission. Brave may have said yes and the user may still want quiet —
   *  and a permission, once granted, is not something any page can hand back,
   *  so without this the only mute was in the browser's site settings. Held
   *  server-side (deck-prefs.mjs) rather than in localStorage, because the same
   *  switch governs the notifier that runs when no page exists at all. */
  /** Off until the first prefs read answers, which is also the stored default
   *  since 3.22.7. A switch drawn `on` over a deck that is not notifying is the
   *  one wrong guess this can make. */
  const [notifyOn, setNotifyOn] = useState(false);
  /** Whether the MACHINE has vetoed this — AGENTS_DECK_NO_NOTIFY=1 at launch.
   *  Not the same question as "is the switch off", and the menu says a
   *  different sentence for each: one is the user's own press, the other is
   *  somebody else's decision the press cannot undo until the next launch. */
  const [notifyVetoed, setNotifyVetoed] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/prefs").then(r => (r.ok ? r.json() : null)).then(d => {
      if (!alive || !d?.ok) return;
      // The auto-update switch, which lives here now (see toggleAutoRestart).
      // One that was turned off while it was a localStorage key is carried
      // over once, and then the key is gone. Not over a press made while this
      // answer was on its way — see autoTouchedRef.
      if (!autoTouchedRef.current) {
        let legacyOff = false;
        try {
          legacyOff = window.localStorage.getItem(AUTO_RESTART_KEY) === "0";
          window.localStorage.removeItem(AUTO_RESTART_KEY);
        } catch { /* private mode */ }
        if (legacyOff && d.prefs?.autoUpdate !== false) {
          setAutoRestart(false);
          fetch("/api/prefs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ autoUpdate: false }),
          }).catch(() => {});
        } else {
          setAutoRestart(d.prefs?.autoUpdate !== false);
        }
      }
      setNotifyOn(d.prefs?.notifications === true);
      setNotifyVetoed(d.notificationsVetoed === true);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const askNotifyRef = useRef<() => void>(() => {});
  const toggleNotify = useCallback(() => {
    // Optimistic, and corrected by the answer. The switch is the one control
    // whose whole point is that it responds now; waiting for a round trip to a
    // loopback server would still be a flicker, and a failed write leaves the
    // UI saying what the file says rather than what the press wanted.
    const want = !notifyOn;
    setNotifyOn(want);
    // AND THE PRESS FINISHES THE JOB. Switching this on used to leave a switch
    // reading "on" above a line saying the browser had never been asked, which
    // is a control contradicting itself — the user's reasonable reply being
    // "if it is on, why must I do something else?". `requestPermission()` needs
    // a user gesture and this IS one, so the prompt goes up on the same press.
    // Only from off to on, only while the browser can still be asked, and the
    // switch stays on whatever the answer is: a refusal costs the page's
    // notifier, not the deck's, and block-notify.mjs needs no permission.
    // Through a ref because the asker is declared below this and a plain call
    // would be a use-before-define; a dependency on it would rebuild this
    // callback for no reason.
    if (want && typeof Notification !== "undefined" && Notification.permission === "default") {
      askNotifyRef.current();
    }
    fetch("/api/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notifications: want }),
    }).then(r => (r.ok ? r.json() : null)).then(d => {
      if (!d?.ok) return;
      setNotifyOn(d.prefs?.notifications === true);
      setNotifyVetoed(d.notificationsVetoed === true);
    }).catch(() => {});
  }, [notifyOn]);
  const notifySupported = typeof Notification !== "undefined";
  // `canAsk` is still what decides whether a prompt can be raised at all; the
  // latch that used to remember "a session blocked once, so offer it" went with
  // the topbar button it existed for. The sound menu asks the question from a
  // place that is always there.
  const notifyAskable = canAsk(notifyPermission, notifySupported);
  // The confirmation is a status, not a state: it says what just happened and
  // then gets out of the bar. Eight seconds for a refusal against four for a
  // grant, because "blocked" is the one carrying instructions the user has to
  // read before it goes.
  useEffect(() => {
    if (!notifySaid) return;
    const ms = notifySaid === "blocked" ? 8000 : 4000;
    const t = setTimeout(() => setNotifySaid(null), ms);
    return () => clearTimeout(t);
  }, [notifySaid]);
  const askForNotifications = useCallback(() => {
    if (typeof Notification === "undefined") return;
    // Fire-and-forget on purpose. The promise resolves when the user answers,
    // which may be never — a Chrome prompt left sitting behind another window
    // is the normal case — and nothing here should wait on it.
    void Notification.requestPermission().then(p => {
      const answer = p as NotifyPermission;
      setNotifyPermission(answer);
      // "default" means the prompt was dismissed rather than answered — the
      // browser will ask again next time, so there is nothing to report and
      // nothing has changed.
      if (answer === "granted") setNotifySaid("on");
      else if (answer === "denied") setNotifySaid("blocked");
    });
  }, []);
  askNotifyRef.current = askForNotifications;
  const notifyRaisedRef = useRef<ReadonlySet<string>>(new Set());
  /** The permission the memo below was seeded against, so that a change of
   *  answer re-seeds exactly once. `null` until the first seed. */
  const notifySeededAtRef = useRef<NotifyPermission | null>(null);
  const blockedKeys = waitingSessions.map(b => blockKey(b.id, b.waiting)).join("|");

  // WHEN THE NOTIFIER STARTS WATCHING, it adopts the world as it finds it: a
  // deck opening onto a machine with four prompts already standing must not
  // fire four notifications about lunchtime, and a tab a session-restoring
  // browser brought back into the background is hidden, so the visibility gate
  // does not cover that on its own.
  //
  // "Starts watching" is TWO moments, and conflating them cost the feature its
  // first impression. Seeding used to live inside the raise effect behind the
  // `permission === "granted"` guard, so on the ordinary path — open the deck,
  // see a session blocked, press the button, allow — the seed had not happened
  // yet when permission arrived. The next block to come in was therefore
  // swallowed as history rather than announced, and the FIRST notification
  // after a user asked to be notified was silence. They press the button, get
  // nothing, and conclude the feature is broken; the one after that works, by
  // which time they are not looking.
  //
  // So this seeds on mount whatever the answer is, and again at the moment the
  // answer changes. Granting is the user saying "tell me from here", and what
  // is standing at that moment is on their screen — they were looking at it
  // when they pressed the button, so it is history too. What arrives next is
  // news, and it is the notification that has to land.
  useEffect(() => {
    if (!shouldReseed(notifySeededAtRef.current, notifyPermission)) return;
    notifySeededAtRef.current = notifyPermission;
    notifyRaisedRef.current = seedRaised(waitingSessions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifyPermission]);

  /** Whether the world has been adopted as history yet — the seed below runs
   *  once, on the FIRST replay, and a reconnect's replay must not re-run it. */
  const notifySeededReplayRef = useRef(false);

  // …AND THE MOMENT THAT ACTUALLY CARRIES THE BLOCKS (#968). The seed above runs
  // at mount, and at mount this deck knows nothing: `stateRef.current` is still
  // `initialState()`, because the EventSource that fills it is opened by an
  // effect and its first message cannot arrive before the mount commit. So
  // `waitingSessions` is `[]` there and `seedRaised([])` adopted an empty world
  // — then recorded itself as seeded, so it never ran again.
  //
  // The cost was the exact burst the seed exists to prevent. A tab a browser
  // restored INTO THE BACKGROUND after a reboot is hidden, so the visibility
  // gate does not cover it; the ring buffer replays three standing prompts with
  // their original `since`; the coalescer flushes one render at `replay-end`;
  // and `blockedKeys` moves from "" to three keys against an empty `raised` —
  // three notifications about prompts from before lunch, at once.
  //
  // `liveSince` is the moment the deck has finished adopting the world, so the
  // seed happens here instead. Declared BEFORE the raiser so that on the commit
  // where both fire — replay-end changes `liveSince` and `blockedKeys` together
  // — this one has already adopted them.
  useEffect(() => {
    if (!shouldSeedFromWorld(notifySeededReplayRef.current, liveSince)) return;
    notifySeededReplayRef.current = true;
    notifyRaisedRef.current = seedRaised(waitingSessions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSince]);

  useEffect(() => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // Never before EITHER seed above. Effects run in declaration order, so on
    // the commit that ends the first replay both have already adopted the
    // standing blocks — but a render that reordered them would turn every
    // restored deck into a burst, and the guard is one call.
    //
    // The `liveSince` half also holds the raiser through the replay itself:
    // blocks arriving there are history by definition, and returning here
    // leaves `raised` untouched, so the seed at replay-end still adopts them
    // rather than them being dropped.
    if (!mayRaise(notifySeededAtRef.current, liveSince)) return;
    const pageVisible = typeof document === "undefined" || !document.hidden;
    const notices = noticesFor(waitingSessions, notifyRaisedRef.current, pageVisible, notifyOn);
    for (const n of notices) {
      try {
        // `tag` is the block key, so a second deck on the same machine REPLACES
        // this notification in the tray rather than stacking a duplicate beside
        // it — the same fan-out that makes `since` load-bearing in the key.
        const note = new Notification(n.title, { body: n.body, tag: n.key });
        note.onclick = () => {
          // Bring the deck back and land on the session that asked, rather than
          // on whatever the canvas happened to be showing. A notification that
          // returns you to a page you then have to search is half a feature.
          window.focus();
          // The same handler the topbar's blocked chip clicks through, so the
          // notification lands the user exactly where the chip would have.
          focusSession(n.sessionId);
          note.close();
        };
      } catch {
        // A notification can throw where the API exists but the platform will
        // not raise one — a Linux desktop with no notification daemon is the
        // common case. It is not worth a message on screen: the four in-page
        // surfaces are all still saying it, which is the state the deck was in
        // before this existed.
      }
    }
    // Looking at the page counts as having been told, so a block that arrives
    // while the deck is on screen is remembered as seen and does not fire late
    // when the tab is next hidden. Both branches prune keys whose block is gone,
    // which is what stops the memo growing for the life of a tab left open for
    // days — safe only because the key carries `since`, so a block that cleared
    // and came back is a different key.
    notifyRaisedRef.current = pageVisible
      ? seedRaised(waitingSessions)
      : nextRaised(waitingSessions, notices, notifyRaisedRef.current);
    // `liveSince` as well as the keys, and it is not decoration. A block raised
    // while the stream was DOWN arrives during the reconnect's replay, when
    // this effect is gated off — so `blockedKeys` has already taken its new
    // value by the time the gate opens, and keyed on the keys alone this would
    // never run again for it. The reconnect's `replay-end` does not re-seed
    // (that is `shouldSeedFromWorld`'s first-replay-only guard), so on that
    // commit `raised` still lacks the block and it is announced — which is the
    // notification a user who walked away most wants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockedKeys, liveSince]);

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
            {/* The server's own version, not the bundle's — an upgrade replaces
                dist/ too, so a reloaded page can show a number the running
                process never had. Stale → the chip stays lit even after the
                banner is dismissed, and clicking it brings the banner back.

                One rule across both branches since #715: clicking the version
                opens what changed in it. The rest of what a click does depends
                on which branch is drawn — the healthy one asks npm, this one
                puts the drift banner back — and neither of those can fail in a
                way that costs the notes, which is the half that has to work
                everywhere. It has to work here in particular: a deck that is
                behind stays behind until somebody upgrades it, and while this
                branch is the one on screen it is the ONLY way back into a
                dismissed dialog. */}
            {readyAppUpdate ? (
              <button
                type="button"
                className="v stale"
                onClick={openReleaseNotes}
                aria-haspopup="dialog"
                aria-label={`ccdeck v${readyAppUpdate.version} is ready to update and restart`}
                title={`ccdeck v${readyAppUpdate.version} is downloaded and verified · click to update and restart`}
              >
                v{chipVersion} → v{readyAppUpdate.version}
                <span className="v-dot" aria-hidden />
              </button>
            ) : notice ? (
              <button
                type="button"
                className="v stale"
                onClick={() => { openReleaseNotes(); showNotice(); }}
                aria-haspopup="dialog"
                /* The healthy branch below has carried an accessible name since it
                   was written; this one did not, so its name was its text — the
                   same bare version string, which made the chip that HAS news
                   indistinguishable from the chip that has none. See
                   versionNoticeLabel for the rest of the reasoning (#381). */
                aria-label={versionNoticeLabel({ ...notice, open: noticeOpen })}
                title={notice.kind === "restart"
                  ? `Running v${notice.from}; v${notice.to} is installed on disk. Restart to pick it up · click for what's new`
                  : `Running v${notice.from}; v${notice.to} is on npm · click for what's new`}
              >
                v{notice.from}
                <span className="v-dot" aria-hidden />
              </button>
            ) : (
              // Not decoration: "no banner" and "the check never ran" look the
              // same from a chair, and on a machine that only ever runs
              // `npx ccdeck` the difference is the whole feature. Clicking asks
              // npm now, ahead of the poll — so it has to look like a control and
              // say so out loud, which a dim version number does neither of.
              //
              // And since #715 it opens the release notes too, which is the
              // half that is answered instantly. The ORDER below is the
              // interesting part and it is not incidental: the notes are in
              // this bundle and npm is across a network that may not be there,
              // so the dialog is on screen before the request leaves. Written
              // the other way round — awaiting the check and opening after —
              // the button would sit still for the length of a registry
              // round-trip, and on a deck with no route to npm it would open
              // nothing at all until the fetch gave up. Nothing the dialog
              // draws depends on the answer, so there is nothing to wait for.
              (() => {
                const copy = {
                  running: chipVersion,
                  latest: version?.latest,
                  latestPending: version?.latestPending,
                  checkedAgo: version?.checkedAt ? shortAgo(now - version.checkedAt) : null,
                  // Only when it is the NEWER of the two. A failure older than
                  // the last success is history, and saying so would describe a
                  // problem that has already gone away.
                  checkFailedAgo: version?.checkFailedAt
                    && version.checkFailedAt > (version.checkedAt ?? 0)
                    ? shortAgo(now - version.checkFailedAt) : null,
                  checkDisabled: version?.checkDisabled,
                  checking: versionChecking,
                };
                return (
                  <button
                    type="button"
                    className={versionChecking ? "v checking" : "v"}
                    onClick={() => { openReleaseNotes(); loadVersion(true); }}
                    aria-busy={versionChecking || undefined}
                    /* No aria-pressed and no aria-expanded, for the reason the
                       usage-history button gives: what this opens is a modal
                       behind a scrim, so while it is open this button is out of
                       the tree entirely and a `true` no reader can reach is
                       worse than no state at all. aria-haspopup is the part
                       that says what kind of thing opens. */
                    aria-haspopup="dialog"
                    aria-label={versionChipLabel(copy)}
                    title={versionChipTitle(copy)}
                  >
                    v{copy.running}
                  </button>
                );
              })()
            )}
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
          <span className="status">
            {/* Three states, not two. Read through the gate rather than a
                counter of its own: the queue is the thing being reported.
                The count is in the LABEL now, not only the title. It used to be
                printed on the Pause button at the far end of the bar, and that
                button has gone down to the canvas control stack where the other
                canvas verbs went in #527 — so one fact stopped being split
                across two ends of a row, and the pill, which already knew the
                number, says it.
                The ghost below is what keeps that free. The pill LEADS this
                strip, so its width is upstream of everything after it — the
                machine meter, the token total, the dollar figure: a count going
                9 → 10 would walk all three, which is #504 one bar over, and the
                count moves on its own where a label never did. A copy of the
                widest label this tone can reach sits in the same grid cell as
                the live one, so the box measures its own worst case in whatever
                font the platform hands it. The alternative was a min-width in
                pixels, which is the wrong tool for a string — the number would
                be measured in the face this machine renders and shipped to
                Segoe UI and to whatever fontconfig picks, where a wider face
                overruns it and the reflow is back.
                aria-hidden AND visibility: hidden on the ghost, so it is out of
                the accessible tree twice over. The pill has no name of its own
                to protect — it is an unfocusable span, see the tab-stop note in
                topbar-interaction.test.ts — but it does have a title, and a
                reader that walks the markup should not find the word twice. */}
            {(() => {
              const pill = statusPill({
                connected: live, paused,
                held: pauseGate.size, dropped: pauseGate.dropped,
              });
              // Nothing at rest (#719). The ghost above explains why the box
              // measures its own worst case; this is the case where the box
              // itself is not earned. `.status` is a flex row, so the 14px gap
              // leaves with it and the strip closes up without anything
              // shifting on its own — the tone only ever changes because Space
              // was pressed or the stream died.
              if (pill.resting) return null;
              return (
                <span className={`pill ${pill.tone}`} title={pill.title}>
                  <span className="pill-box">
                    <span className="pill-widest" aria-hidden>{pill.widest}</span>
                    <span className="pill-label">{pill.label}</span>
                  </span>
                </span>
              );
            })()}
            {/* The strip is the pill, and that is the whole strip.
                It used to carry two board readouts — a token count and a dollar
                figure, both sums over the agents on the canvas right now.
                Neither survived the question they kept provoking: the canvas
                evicts finished work on a timer, so both numbers fall on their
                own with nothing on screen to account for the fall, and #687 had
                already spent a tooltip and two qualifiers ("board tokens",
                "board cost") trying to say so in a row that has 12px to say
                anything in.
                The usage panel answers the same question properly and without
                the qualifier: it is backed by ccusage, it reads the logs on
                disk, it covers sessions this deck never watched, and it does
                not forget. A qualified approximation beside an authoritative
                figure one keystroke away is a readout earning its width by
                being second-best.
                THE MACHINE METER WENT THE SAME WAY, and it is the one that had
                been earning its width. A 50x24 box drew a 60-second CPU
                sparkline and a memory bar, and it was the only readout here
                that was not about agents. What it could not do is stop: it is a
                trace that moves whether or not anything on the canvas is
                happening, in the corner of a bar the eye returns to for the one
                thing this deck is for. The panel it disclosed says everything
                it said and eleven things it could not, and the button in the
                run below opens that panel without drawing anything at all. A
                glance costs a click now; the bar costs no attention.
                What is left is the one thing the bar is FOR: whether the stream
                is alive. That is a fact about right now, which is the only
                tense a topbar can keep. */}
          </span>
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
            <button
              type="button"
              className="waiting-stat"
              onClick={() => {
                // The same place W starts, so the next press moves on (#825).
                waitingCursorRef.current = waitingSessions[0].id;
                focusSession(waitingSessions[0].id);
              }}
              title={`Blocked waiting for you — click, or press W, to go to the one that has been stuck longest:\n${
                waitingSessions.map(w => `  ${w.label}: ${waitingSentence(w.waiting)} (${shortAgo(now - w.waiting.since)})`).join("\n")
              }`}
              aria-label={`${waitingSessions.length} session${waitingSessions.length === 1 ? "" : "s"} waiting for you`}
            >
              <span className="ap-pulse" aria-hidden />
              <b>{waitingSessions.length}</b> <span className="ws-word">waiting</span>
            </button>
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
          {notifySaid && (
            <span
              // Written out rather than composed from the state, so the class
              // exists in the markup as a literal and unstyled-class.test.ts can
              // hold it to a rule in the sheet. A template here buys nothing and
              // costs the one check that catches a class with no styling behind
              // it — which is exactly how a warn colour goes missing silently.
              className={notifySaid === "on" ? "notify-said" : "notify-said notify-said-blocked"}
              role="status"
              title={notifySaid === "on"
                ? "The deck will raise a system notification when a session blocks on you and this tab is in the background"
                : "Notifications are blocked for this page. Only your browser can undo that — its site settings for this address"}
            >{notifySaid === "on" ? "notifications on" : "notifications blocked"}</span>
          )}
        </div>
        {selected && (() => {
          const c = agentCost(selected);
          const elapsedSec = Math.max(0, ((selected.endedAt ?? now) - selected.startedAt) / 1000);
          const rate = selected.state === "active" ? fmtCostRate(c.total, elapsedSec) : null;
          const extra = selectedIds.size - 1;
          return (
            <button
              type="button"
              className="selected-ribbon"
              title={`Zoom to ${selected.label} and its session (Z)`}
              onClick={() => { try { focusAgent(selected.id); } catch {} }}
            >
              <span className={`state-pill state-${selected.state}`}>
                {selected.state === "active" ? "live" : selected.state}
              </span>
              <span className="selected-label">{selected.label}</span>
              {c.total > 0 && <span className="selected-cost">{fmtCost(c.total)}{rate ? <span className="selected-rate"> · {rate}</span> : null}</span>}
              {extra > 0 && <span className="selected-extra">+{extra}</span>}
              {/* A mouse shortcut, not a control. It sits inside the ribbon's
                  own <button>, so it can never be a button itself — nesting one
                  is invalid, and it carried no tabIndex, which left a
                  role="button" labelled "Deselect" that no keyboard could ever
                  reach or operate. The keyboard has the same verb on Escape
                  from anywhere on the page, so the honest markup is decoration
                  with a click on it. */}
              <span
                aria-hidden
                className="selected-close"
                onClick={(e) => { e.stopPropagation(); clearSelection(); }}
              >×</span>
            </button>
          );
        })()}
        {selected && (
          <button type="button" className="btn danger" onClick={removeSelectedNode}
            title={`Remove ${selected.label} from this board`} aria-label={`Remove ${selected.label} from the board`}>
            Remove node
          </button>
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
          <div className="action-run">
            {/* aria-expanded, not aria-pressed. This shows and hides a region
                that follows it in the DOM and it leaves focus exactly where it
                was — the disclosure pattern, which is what the accounts panel's
                ⋯ menu already models below. "Pressed" would claim the button is
                a setting that stays on; what it actually reports is whether the
                thing it points at is on screen.
                aria-controls only while the panel is mounted, for the reason
                AccountsPanel spells out: an IDREF that resolves to nothing is a
                dangling pointer rather than a relationship, and closed is exactly
                when there is nothing to point at.
                The `primary` class is gone from all four of these. The state is
                the ARIA attribute now and the stylesheet reads it there, so the
                pixels and the accessibility tree cannot drift apart. #370 counted
                five; the session list's button has since been removed from the
                row and the rule is unchanged for the four that are left. */}
            {/* AND IT IS BACK (#800). Removing it left `L` as the ONLY way to
                open the sidebar — and the README leads with what that sidebar
                shows: "every session stopped on a human is at the top of the
                sidebar with the wait beside it". On a fresh install the detail
                rail is closed too, and that rail is where the `L session list`
                row lives, so the only route was: notice the small ? in the
                canvas control stack, open the sheet, read `L`. A mouse-only
                user had none at all.
                The count above is now five again, and the argument that
                removed this one — width in the middle of the bar — was about
                the three TEXT buttons that went with it, not about a 24px
                glyph. */}
            <button
              className="btn icon-btn"
              onClick={toggleSessionList}
              title={`${sessionListOpen ? "Hide" : "Show"} session list (L)`}
              aria-label="Toggle session list"
              aria-expanded={sessionListOpen}
              aria-controls={sessionListOpen ? "session-list" : undefined}
            >
              {/* AUTHORED, NOT TYPED (#837). ☰, $ and ☀/☾ came from whichever
                  font each platform had — three sizes and three baselines
                  beside five drawn icons. All eight are drawn now, on one spec:
                  13px on a 14 viewBox, a 1.4 stroke, round caps and joins. */}
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5.4 3.6h6.6M5.4 7h6.6M5.4 10.4h6.6" />
                <path d="M2.2 3.6h.2M2.2 7h.2M2.2 10.4h.2" />
              </svg>
              {/* THE WORD (#836), drawn where the bar has room — see .tb-word.
                  Each one is a word its button's accessible name already
                  contains, so the eye and voice control agree. */}
              <span className="tb-word">Session list</span>
            </button>
            <button
              className="btn icon-btn"
              onClick={() => setUsagePanelOpen(o => !o)}
              title={`${usagePanelOpen ? "Hide" : "Show"} usage panel (U)`}
              aria-label="Toggle usage panel"
              aria-expanded={usagePanelOpen}
              aria-controls={usagePanelOpen ? "usage-panel" : undefined}
            >
              {/* tb-glyph-narrow: the one glyph in the set whose ink is far
                  narrower than its box — see the rule in styles.css. */}
              <svg className="tb-glyph-narrow" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9.4 4.5C9 3.6 8.1 3.1 7 3.1c-1.4 0-2.4.8-2.4 1.9 0 1.2 1.2 1.6 2.4 2s2.4.8 2.4 2c0 1.1-1 1.9-2.4 1.9-1.1 0-2-.5-2.4-1.4" />
                <path d="M7 1.6v1.5M7 10.9v1.5" />
              </svg>
              <span className="tb-word">Usage</span>
            </button>
            {/* Beside Usage, because it is the same subject over a longer span:
                Usage is what is being spent now, History is ccusage's record
                of the days before. Read next to the dollar sign, "History" says
                whose history it is; filed at the end of the run it read as the
                browser history the eye after it watches.
                Neither aria-pressed nor aria-expanded. What this opens is a
                modal — role="dialog" aria-modal="true" behind a full-screen
                scrim, with the focus trap #371 added — so while it is open this
                button cannot be clicked, cannot be tabbed to, and aria-modal has
                removed the whole topbar from the accessibility tree. A state
                whose `true` no reader can ever reach is worse than no state: it
                would be a value announced only in the one case it is not
                needed. The label says "Open" rather than "Toggle", and
                aria-haspopup says what kind of thing opens. */}
            <button
              className="btn icon-btn"
              onClick={() => setUsageHistoryOpen(o => !o)}
              title="Usage history — ccusage (H)"
              aria-label="Open usage history"
              aria-haspopup="dialog"
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="3" y1="11.5" x2="3" y2="7" />
                <line x1="7" y1="11.5" x2="7" y2="3" />
                <line x1="11" y1="11.5" x2="11" y2="8.5" />
              </svg>
              {/* No ellipsis. On a row of chips "History…" read as a word cut
                  off, the convention it borrowed means "asks for more before it
                  acts" (which a viewer does not), and Sound opens a dialog too
                  without one. Every button here opens something. */}
              <span className="tb-word">History</span>
            </button>
          </div>
          <div className="action-run">
            {/* Same disclosure as the usage panel — a sidebar that opens beside
                the canvas and takes no focus with it.
                Gone entirely without Claude Code, rather than present and inert.
                A disabled control is a promise that something could be enabled;
                there is no account to switch to on a machine whose only CLI is
                Codex, which has exactly one logged-in account and no store. */}
            {providers.claude && (
            <button
              className="btn icon-btn"
              onClick={toggleAccountsPanel}
              title={`${accountsPanelOpen ? "Hide" : "Show"} accounts (A)`}
              aria-label="Toggle accounts panel"
              aria-expanded={accountsPanelOpen}
              aria-controls={accountsPanelOpen ? "accounts-panel" : undefined}
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="7" cy="4.6" r="2.4" />
                <path d="M2.4 12c0-2.3 2.1-3.7 4.6-3.7s4.6 1.4 4.6 3.7" />
              </svg>
              <span className="tb-word">Accounts</span>
            </button>
            )}
            {/* The session list's ☰ used to sit here, sharing the left slot with
                accounts. The panel is untouched — it is still mounted by
                `sessionListOpen`, still toggled by L, still closed by its own ‹ —
                and only the topbar control is gone. What that costs is written
                down at the L handler, which is now the only way in. */}
            {/* THE METER'S REPLACEMENT, and the reason the strip above is one
                readout shorter. The panel is the same panel; what changed is
                that opening it costs a click on a glyph rather than a live
                trace in the corner of the bar.
                The run is ordered by subject: the session list, then what is
                being spent (Usage, and History beside it), then who spends it
                and what it runs on (Accounts, Machine), then Browser watch. It
                was ordered by kind, panels first and dialogs after with an
                ellipsis to tell them apart, and that split Usage from its own
                history.
                The glyph is a processor — a die with its pins — which is the
                one shape in this row that says "the box you are sitting at"
                rather than "your work". No aria-pressed: this discloses a
                region, which is what aria-expanded means, and the region names
                itself back through aria-controls. */}
            <button
              className="btn icon-btn"
              onClick={() => setMachinePanelOpen(o => !o)}
              title={`${machinePanelOpen ? "Hide" : "Show"} this machine — cores, memory, temperature (S)`}
              aria-label="Toggle machine detail"
              aria-expanded={machinePanelOpen}
              aria-controls={machinePanelOpen ? "system-panel" : undefined}
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3.6" y="3.6" width="6.8" height="6.8" rx="1.2" />
                <path d="M5.8 1.4v2.2M8.2 1.4v2.2M5.8 10.4v2.2M8.2 10.4v2.2M1.4 5.8h2.2M1.4 8.2h2.2M10.4 5.8h2.2M10.4 8.2h2.2" />
              </svg>
              <span className="tb-word">Machine</span>
            </button>
            {/* THE SILHOUETTE CARRIES THE STATE, AND NOTHING ELSE DOES. At 13px
                a hue change is not readable — ambient.ts makes the same
                argument about the favicon, where amber and grey come to 1.01:1
                under protanopia — so watching and not watching are a pupil and
                a slash, which differ in shape at any size.

                The slash is not a warning. Off is the default and it is a fine
                place to be, since the panel still answers retroactively.

                The button used to agree in colour as well, accent while
                watching and amber with a finding unread, and both are gone.
                Accent in this bar is hover, focus and an open panel's line;
                amber is the blocked-session chip, the one alarm the deck exists
                to raise. An eye that went amber for unread browser history
                taught the reader to look past amber. The badge says something
                is unread, in the bar's resting grey, and the pupil says the
                watch is on. */}
            <button
              className="btn icon-btn bw-btn"
              onClick={() => setBrowserWatchOpen(o => !o)}
              title={watchOn
                ? "Browser watch — watching; the deck is keeping its own copy (B)"
                : "Browser watch — not watching; reading the browser's history live (B)"}
              aria-label={`Browser watch, ${watchOn ? "watching" : "not watching"}`
                + (watchUnseen > 0 ? `, ${watchUnseen} unread` : "")}
              aria-haspopup="dialog"
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M0.9 7s2.2-4 6.1-4 6.1 4 6.1 4-2.2 4-6.1 4S0.9 7 0.9 7Z" />
                {watchOn || watchUnseen > 0
                  ? <circle cx="7" cy="7" r="1.8" fill="currentColor" stroke="none" />
                  : <line x1="2.4" y1="11.6" x2="11.6" y2="2.4" />}
              </svg>
              {/* The dialog's own title, so the word on the button and the
                  heading it opens are the same two words. "Watch" alone did
                  not say what is watched. */}
              <span className="tb-word">Browser watch</span>
              {watchUnseen > 0 && <span className="bw-badge" aria-hidden>{watchUnseen}</span>}
            </button>
          </div>
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
                  fmSource={fmSource}
                  onFmSource={setFmSource}
                  onClose={() => setAppearanceMenuOpen(false)}
                />
              )}
            </div>
          </div>
        </div>
      </header>

      {restartedTo ? (
        // Outranks both: it is the shortest-lived of the three and it answers
        // the question the other two just raised.
        <div className="ver-banner done" role="status">
          <span className="ver-dot" />
          <strong>Restarted — now running v{restartedTo}.</strong>
          <span className="ver-sub">The canvas replayed from the event log.</span>
        </div>
      ) : everConnected && !live ? (
        <div className="conn-banner" role="alert">
          <span className="conn-dot" />
          {restarting
            ? restartMode === "npx"
              ? "Fetching the new version with npx — this can take a minute…"
              : `Restarting ${PRODUCT}…`
            : (() => {
                // The one sentence on this page that was reachable by mouse and
                // by nothing else (#510). It lived in the title of the status
                // pill, on a non-focusable span that Chrome reports as
                // role=generic name="" description="SSE disconnected" — a
                // description with no name to hang off, which screen readers do
                // not reliably announce and no keyboard can go and ask for.
                // It arrives here rather than on a focusable pill because this
                // banner already owns the announcement path for exactly this
                // condition: it is a role="alert", it fires the moment the
                // stream dies, and unlike the version banner beside it it has
                // no dismiss control, so it is on screen for precisely as long
                // as the thing it describes. That is the property the pill was
                // being kept for, and the banner already had it.
                // Nothing is added while the canvas is running: the sentence
                // above already says the connection is gone. What was missing
                // is what the two states mean together.
                const outage = outageSentence({ connected: live, paused });
                return (
                  <>
                    {`Lost connection to the ${PRODUCT} server. Reconnecting…`}
                    {outage && <span className="conn-sub">{outage}</span>}
                  </>
                );
              })()}
        </div>
      ) : noticeOpen && notice ? (
        // Both banners want grid row 2, and a dead connection is the more
        // urgent of the two — the version notice waits its turn.
        <div className={`ver-banner ${notice.kind}`} role="status">
          {/* Still, until something is actually about to happen. It pulsed for
              days over a fact that does not change, in the one visual grammar
              this deck reserves for "running right now" — and it pulsed
              identically whether or not a restart was counting down, so the one
              moment motion would have carried information was the moment it
              carried none. */}
          <span className={`ver-dot${restartFuseMs == null ? "" : " armed"}`} />
          {notice.kind === "restart" ? (
            <>
              <strong>v{notice.to} is installed — this deck still runs v{notice.from}.</strong>
              {version?.canRestart ? (
                <>
                  {/* #620: `disabled={restarting}` disabled the control the
                      press came from — askRestart sets `restarting` before its
                      first await — and the banner has no focus trap to hand
                      the keyboard back. The word already says which state it is
                      in; `aria-busy` says it to a reader, and askRestart's own
                      ref refuses the second press. */}
                  {/* The word changes with the machine's own answer. `Restart
                      anyway` is the honest name for a press that drops the hook
                      events fired while the server is down — restart.ts:1 says
                      that is what happens — and it is a label rather than a
                      confirmation dialog because a modal over a live canvas is
                      worse than a true word. */}
                  {/* WHY A RESTART IS NEEDED AT ALL, on the branch where the
                      reader can actually do something about it. The sentence
                      existed and rendered only under `canRestart: false` — the
                      one audience that cannot act on it. */}
                  <button type="button" className="ver-act" onClick={() => askRestart()} {...selfPressProps(restarting)}
                    title={"Stop this process and bring it back on the same port. The canvas replays from the event log.\n\n"
                      + "Node loads every module once, at startup. An upgrade replaces the files on disk but not the code already in memory, so this process keeps running the old version until it is restarted."}>
                    {restarting ? "restarting…" : restartCopy.label}
                  </button>
                  {/* And the consequence, in the open. It was in a `title`,
                      which is reachable by mouse and by nothing else — the
                      defect this file spends a paragraph on thirty lines up. */}
                  {!restarting && <span className="ver-sub">{restartCopy.clause}</span>}
                  {/* The countdown is the cancel: a reader who can see fourteen
                      seconds has time to reach this switch, and one who sees
                      `auto when idle` has only the outcome.
                      aria-hidden on the changing half, with a stable name on the
                      button, because this banner is a role="status" — a label
                      that renamed itself every second would read the whole
                      banner out loud every second with it. */}
                  {/* The shared switch (#886) with the state's word beside it, in
                      a label so pressing the word throws it too. The word stays
                      aria-hidden and the name stable, for the reason above. */}
                  <label className="ver-auto">
                  <button type="button" className="switch"
                    role="switch" aria-checked={autoRestart} onClick={toggleAutoRestart}
                    aria-label="Auto-restart when idle"
                    title={autoRestart
                      ? "Updates on its own. While you are here it restarts once nothing has been running for 30 seconds; while you are away it also installs the new version first. Click to require a click instead."
                      : "Only updates when you click. Click to let it update itself when idle or while you are away."}>
                    <span className="switch-knob" />
                  </button>
                  <span aria-hidden>{autoRestartLabel(autoRestart, restartFuseMs)}</span>
                  </label>
                </>
              ) : (
                <span
                  className="ver-sub"
                  title="Node loads every module once, at startup. An upgrade replaces the files on disk but not the code already in memory, so this process keeps running the old version until it is restarted."
                >Restart it to pick up the new code.</span>
              )}
            </>
          ) : (
            <>
              {/* The product's name, not the `name` /api/version reports: that
                  one is the npm package the registry was asked about, and it is
                  `ccdeck`, `agents-deck` or `agent-dag` depending on how this
                  deck was started. A release announcement whose subject changes
                  with the install method names three products where there is
                  one, and contradicts the wordmark directly above it. The
                  package belongs where it is actionable — the button's title
                  below, which is the command that actually installs. */}
              <strong>{PRODUCT} v{notice.to} is out — you are on v{notice.from}.</strong>
              {/* One button when we can actually install; the command, always,
                  because the button can fail and the command never does.

                  The tooltip's fallback matters more than it looks:
                  `upgrade.command` is the vector npm was actually spawned with
                  and exists only once an install has started, so before the
                  first click the fallback is the whole of what it says — and a
                  hardcoded `agents-deck` was wrong for every `npm i -g ccdeck`,
                  which back then installed a launcher package of its own. #340
                  removed that launcher, and the argument survives it: the name
                  to reinstall is still whichever of the three the user typed,
                  and this component has no way to know which. `version.command`
                  is the server's own answer to the same question, correct in
                  every install shape, and the same string the copy button
                  carries. */}
              {version?.upgradeMode === "install" && upgradeState !== "failed" && (
                /* #620, and the one of the nine whose flag is not set in its
                   own handler: `running` arrives from the /api/version poll a
                   moment after the click, and the button is still the focused
                   element when it does — the same drop, one round trip later.
                   So `running` is this press's in-flight state and goes to
                   `aria-busy`; `done` is not — the install has finished and
                   there is nothing left to press, which is an unavailability
                   `disabled` is exactly right for. */
                <button type="button" className="ver-act" onClick={startUpgrade}
                  {...selfPressProps(upgradeState === "running", upgradeState === "done")}
                  title={`Runs ${version?.upgrade?.command ?? version?.command ?? "npm i -g"} here, then restarts once nothing is running.`}>
                  {upgradeState === "running" ? "installing…"
                    : upgradeState === "done" ? "installed"
                    : "Update now"}
                </button>
              )}
              {/* npx never installs anything — there is nothing here to install
                  over. The update IS the restart: the supervisor re-runs the
                  spec, npx unpacks a fresh copy, and it takes this port. */}
              {version?.upgradeMode === "npx" && version?.canRestart && (
                /* #620, the same as Restart now beside it: askRestart sets
                   `restarting` before its first await, and this is the button
                   the press came from. An npx fetch is measured in tens of
                   seconds, so this is the longest of the four in App.tsx to
                   spend with focus on `<body>`. */
                <button type="button" className="ver-act" onClick={() => askRestart({ upgrade: true })}
                  {...selfPressProps(restarting)}
                  title={`Runs ${version?.command} and hands it this port. Nothing is installed globally — npx unpacks its own copy.`}>
                  {restarting ? "fetching…"
                    /* A retry after a failure must not look like the first
                       click: the last one already came back on the same
                       version, and the label is where that shows. */
                    : upgradeState === "failed" ? "Retry update"
                    : "Update & restart"}
                </button>
              )}
              {upgradeState === "failed" ? (
                <span className="ver-sub fail" title={version?.upgrade?.error ?? ""}>
                  {/* npx installs nothing — its failure is a fetch that came
                      back on the old version, not a broken install. */}
                  {version?.upgradeMode === "npx" ? "update failed" : "install failed"}
                  : {version?.upgrade?.error ?? "unknown error"} — run it yourself:
                </span>
              ) : version?.upgradeMode === "npx" ? (
                <span className="ver-sub">
                  {version?.canRestart
                    ? "npx cannot upgrade in place, so the deck re-runs:"
                    : UPGRADE_BLOCK_TEXT.npx}
                </span>
              ) : version?.upgradeBlocked ? (
                <span className="ver-sub">
                  {/* hasOwn, not `??` — see categoryFor (#474). The reason is a
                      string off /api/version, so a build that sends one naming
                      an Object.prototype member would put a function here. */}
                  {Object.hasOwn(UPGRADE_BLOCK_TEXT, version.upgradeBlocked)
                    ? UPGRADE_BLOCK_TEXT[version.upgradeBlocked]
                    : "cannot install from here"}
                </span>
              ) : null}
              <button type="button" className="ver-cmd" onClick={copyCommand} title="Copy to clipboard">
                <code>{version?.command}</code>
                <span className="ver-cmd-hint">{cmdCopied ? "copied" : "copy"}</span>
              </button>
            </>
          )}
          {/* A real button, like the five controls beside it. As a
              role="button" span this re-implemented Enter and Space by hand —
              and its Space branch existed only to undo the global preventDefault
              this handler now never reaches, since ownsKeystroke() leaves a
              focused <button> alone. */}
          <button type="button" aria-label="Dismiss" className="ver-close" onClick={dismissNotice}>×</button>
        </div>
      ) : oldNameOpen && oldName ? (
        // Last of the four, because it is the only one nobody has to act on
        // today: a dropped connection, a restart and a release all outrank a
        // name. It comes back the moment the row above it is dismissed.
        <div className="ver-banner" role="status">
          <span className="ver-dot" />
          <strong>{oldName} still works — the deck is called {PRODUCT} now.</strong>
          {/* The half people do not expect, and the half this must not get
              wrong: a global install already put a ccdeck on the PATH — the
              same install ships all three commands — so there is nothing to
              fetch and nothing to uninstall, only a different word to type,
              while under npx there is no such install and `npx ccdeck` is the
              whole answer. Telling the second group the first line sends them
              to a `command not found`.

              So it is not decided here. This branch used to read
              `upgradeMode === "npx"`, which sounds like the same question and
              is a different one — it says whether an in-app `npm i -g` is
              allowed, and `AGENTS_DECK_NO_INSTALL=1` makes it null for npx runs
              too, at which point every npx user who opted out of installs got
              the global-install line (#363). The server sends the sentence the
              terminal prints, from the same function, and no string here can
              drift from it. Rendered only when it is there: a missing field is
              a server that could not say, and silence beats a guess. */}
          {version?.renameFix ? <span className="ver-sub">{version.renameFix}</span> : null}
          <button type="button" aria-label="Dismiss" className="ver-close" onClick={dismissOldName}>×</button>
        </div>
      ) : null}

      {/* Claude-only, and now conditional on Claude Code actually being here.
          Every account in it is a Claude account, the store behind it is
          claude-swap's, and both of its empty states end at `claude auth login`
          — which on a Codex-only machine dead-ends at "the claude CLI could not
          be run: not on PATH". The panel is also open by default, so that was
          the first thing such a user saw. */}
      {isMounted(accountsPhase) && providers.claude && (
        <AccountsPanel leaving={accountsPhase === "leaving"} onClose={() => setAccountsPanelOpen(false)} />
      )}

      {sessionListOpen && (
        <SessionList
          state={stateRef.current}
          now={now}
          selectedIds={selectedIds}
          onSelect={focusSession}
          onClose={() => setSessionListOpen(false)}
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
        className={`canvas-wrap${bubbling ? " bubbling" : ""}${dragging ? " dragging-any" : ""}`}
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
          : <EmptyHero live={live} everConnected={everConnected} providers={providers} workspace={workspace} onTour={() => setTourOpen(true)} />)}
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
          /* role="group", not role="toolbar". A toolbar is a promise about
             keyboard behaviour — one tab stop for the whole set, arrow keys
             between the members — and this bar implements none of it: every
             chip is its own tab stop, which is the right shape for a handful
             of independent filters and the wrong shape to call a toolbar.
             Claiming the role told a screen reader to expect arrow keys that
             do nothing, which is a worse answer than not claiming it. group
             keeps the thing the role was actually being used for: the set is
             named, so the chips are heard as one control and not seven. */
          <div
            ref={catBarRef}
            className={`cat-filter-bar${catBarOccluded ? " occluded" : ""}`}
            role="group"
            aria-label="Filter tools by category"
          >
            {presentCats.map(c => {
              const off = hiddenCats.has(c);
              return (
                /* aria-pressed, because a chip really is a toggle: it does not
                   reveal anything, it turns a filter on and off. Pressed means
                   the category is showing, which is the state the chip's own
                   name and emoji describe — the label is "edit", not "hide
                   edit", so pressed has to mean "edit is on". */
                <button
                  key={c}
                  type="button"
                  className={`cat-filter${off ? " off" : ""}`}
                  onClick={() => toggleCat(c)}
                  aria-pressed={!off}
                  title={`${off ? "Show" : "Hide"} ${DETAIL_CAT_LABEL[c]} tools`}
                >
                  <CatGlyph cat={c} />
                  <span className="cat-name">{DETAIL_CAT_LABEL[c]}</span>
                </button>
              );
            })}
          </div>
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
            const mode = nextLod(lodRef.current, vp.zoom, lodCard());
            if (mode !== lodRef.current) {
              lodRef.current = mode;
              // The attribute now, the state for React with it: the face must
              // not wait a render to appear on the frame the mode changed on.
              canvasRef.current?.setAttribute("data-lod", mode);
              setLod(mode);
              if (mode === "detail") hidePeek();
            }
            if (vpSaveTimerRef.current) window.clearTimeout(vpSaveTimerRef.current);
            vpSaveTimerRef.current = window.setTimeout(() => saveViewport(vp), 250);
          }}
          onNodeDragStart={(_, n) => {
            hidePeek();
            // A drag must never inherit the push animation. The node under the
            // cursor is excluded by CSS, but a session drag moves its members
            // through state instead of the drag itself, and those would follow
            // the cursor 420ms late. Ending the animation outright is simpler
            // than enumerating which nodes a gesture will end up moving.
            endBubble();
            draggingRef.current = true;
            dragPatchRef.current = new Map();
            setDragging(true);
            markInteract();
            disableAutoFit();
            if (n.type === "sessionGroup") {
              // Snapshot every member's start position so each move applies the
              // gesture delta to a fixed origin (the group node's own start).
              const sid = (n.data as { sessionId?: string })?.sessionId;
              const members = new Map<string, { x: number; y: number }>();
              if (sid) {
                for (const m of nodes) {
                  const d = m.data as AgentNodeData | undefined;
                  if (d?.sessionId === sid) members.set(m.id, { x: m.position.x, y: m.position.y });
                }
              }
              groupDragRef.current = { start: { x: n.position.x, y: n.position.y }, members };
              return;
            }
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
          }}
          onNodeDrag={(_, n) => {
            markInteract();
            if (n.type === "sessionGroup") {
              const g = groupDragRef.current;
              if (!g) return;
              const dx = n.position.x - g.start.x;
              const dy = n.position.y - g.start.y;
              // Move every member by the delta. Writing pinned/positions is the
              // source of truth snapshotToFlow reads; the nonce forces an
              // immediate recompute so the nodes follow this frame.
              for (const [id, p0] of g.members) {
                const p = { x: p0.x + dx, y: p0.y + dy };
                pinnedRef.current.set(id, p);
                positionsRef.current.set(id, p);
              }
              // Patch the members and the box itself, rather than rebuilding
              // the whole graph on every pointer move as this used to.
              const patch = dragPatchRef.current;
              if (patch) {
                for (const [id, p0] of g.members) patch.set(id, { x: p0.x + dx, y: p0.y + dy });
                patch.set(n.id, { x: n.position.x, y: n.position.y });
              }
              setDragMoveTick(t => t + 1);
              return;
            }
            // Live-pin during drag so an incoming event re-render doesn't
            // snap the node back to its dagre slot mid-motion.
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            positionsRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            // And render it now, rather than whenever the next rebuild happens.
            dragPatchRef.current?.set(n.id, { x: n.position.x, y: n.position.y });
            setDragMoveTick(t => t + 1);
          }}
          onNodeDragStop={(_, n) => {
            markInteract();
            draggingRef.current = false;
            dragPatchRef.current = null;
            setDragging(false);
            setDragTick(t => t + 1);   // one rebuild, from the refs, at the end
            if (n.type === "sessionGroup") {
              const g = groupDragRef.current;
              if (g) {
                const dx = n.position.x - g.start.x;
                const dy = n.position.y - g.start.y;
                for (const [id, p0] of g.members) {
                  const p = { x: p0.x + dx, y: p0.y + dy };
                  pinnedRef.current.set(id, p);
                  positionsRef.current.set(id, p);
                }
              }
              groupDragRef.current = null;
              saveLayout(positionsRef.current, pinnedRef.current);
              setDragTick(t => t + 1);
              return;
            }
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            positionsRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            saveLayout(positionsRef.current, pinnedRef.current);
          }}
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
            onOpenTool={setOpenedToolId}
          />
          {/* The state the recenter tint used to be the only sign of (#820).
              While the reader's own pan or zoom holds the view, new sessions
              can land off-screen; this says so on the canvas they would be
              looked for on, with the way back in the same place. */}
          {/* A status and an action, not one big button. The words say what
              the state is and are not a control; Resume is the one thing here
              that can be pressed, and it does what the whole chip used to. */}
          {autoFitDisabled && (
            <div className="autofit-chip">
              <span className="autofit-state" title="New sessions are not brought into view while you are moving it yourself">
                Auto-fit off
              </span>
              <button
                type="button"
                className="autofit-resume"
                onClick={enableAutoFitAndRefit}
                title="Bring new sessions into view again"
                aria-label="Resume auto-fit"
              >
                Resume
              </button>
            </div>
          )}
          {/* No React Flow fit-view button (#840). Recenter below does the same
              fit and also turns autofit back on, so two near-identical buttons
              sat side by side and the reader had to guess the difference. F
              still fits from the keyboard. */}
          <Controls showInteractive={false} showFitView={false} showZoom={false}>
            {/* Zoom in and out, drawn here rather than left to React Flow, so
                the pair wears the same 14px stroke glyphs as the five below
                them (React Flow's are filled shapes a weight heavier and 2px
                smaller) and names itself in words. The same calls React Flow's
                own buttons make, with the same limits: each goes disabled at
                its end of the zoom range. */}
            <ControlButton onClick={() => rf.zoomIn()} title="Zoom in" aria-label="Zoom in" disabled={zoomMaxed}>
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </ControlButton>
            <ControlButton onClick={() => rf.zoomOut()} title="Zoom out" aria-label="Zoom out" disabled={zoomMinned}>
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </ControlButton>
            {/* data-nudge while auto-fit is off: the glyph steps up to the
                foreground, because pressing it now would do something. It was
                the accent; the canvas's Auto-fit chip is what says why. */}
            <ControlButton
              onClick={enableAutoFitAndRefit}
              title={autoFitDisabled
                ? "Recenter view + re-enable autofit"
                : "Recenter view (autofit already on)"}
              aria-label="Recenter view"
              data-nudge={autoFitDisabled ? "" : undefined}
            >
              {/* crosshair / target — recenter affordance */}
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </ControlButton>
            {/* The last control out of the topbar, and the only toggle in this
                stack. Second rather than first: Recenter above it belongs beside
                the zoom buttons, the view's other commands, and these two are
                the reversible, often-pressed pair — putting Pause here keeps the
                one control that destroys something at the far end of the column
                from the one a hand comes back to.
                It reports its state, which none of its neighbours has to.
                They are one-shot commands and a glyph is a complete account of
                what a command does; this one is a setting that stays on, so
                there is a fact about it that is true between presses and a user
                has to be able to read it. aria-pressed is how this deck says
                that — the sound switch in the bar above is the same shape of
                control and has carried it since #370 — and it is not
                aria-expanded, because nothing is disclosed: no region appears,
                the canvas simply stops repainting.
                Which is also why the glyph does NOT flip to a play triangle.
                The media-player convention prints the ACTION on the button, and
                that convention contradicts aria-pressed rather than completing
                it: an eye reading a triangle is told the canvas is frozen and
                the button will play, while a reader hearing Pause plus pressed
                is told the same fact the other way round. One mark, then, with
                the state carried in the one channel both audiences read —
                the same choice the two panel toggles make with their own
                unchanging glyphs.
                That channel is a polarity inversion and not a hue: --text on
                --panel at rest becomes --bg on --warn when pressed, a luminance
                step a greyscale screen, a photocopy and every colour vision
                deficiency all still read. Amber because amber is what a frozen
                canvas is drawn in everywhere else on this deck — the pill at the
                other end of the bar and the dot inside it — and the pill and
                this control were a matched pair before it moved. */}
            {/* data-group-start: the first of a group, which the stack marks
                with a gap and a hairline. The groups are the view (zoom,
                recenter), the canvas's state (pause, re-arrange), the one
                that empties it (clear), and help. */}
            <ControlButton
              data-group-start=""
              onClick={togglePause}
              title={pauseTitle({ paused, held: pauseGate.size, dropped: pauseGate.dropped })}
              aria-label={PAUSE_LABEL}
              aria-pressed={paused}
            >
              {/* two upright bars — the pause mark, drawn as strokes so it sits
                  at the weight of the four glyphs around it */}
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                <path d="M9 5.5v13M15 5.5v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </ControlButton>
            {/* Down from the topbar. Both of these are canvas verbs —
                they rearrange or empty the thing this stack is attached to —
                and the crosshair above was already the proof that a command
                belongs here and not only a zoom control. `F` fits the view and
                has never had a topbar button either; `R` and `C` are the same
                shape of shortcut and now have the same kind of home.
                The titles are the strings the two buttons carried in the bar,
                unchanged, so the shortcut letters and the sentence a user
                already knows survive the move. What they gain is aria-label:
                up there each was its own name, printed on it; here the glyph
                is the whole button, and a glyph has no accessible name. */}
            <ControlButton
              onClick={handleRelayout}
              title="Auto-arrange — clear pins (R)"
              aria-label="Re-arrange the canvas"
            >
              {/* three-node hierarchy — one parent over two children */}
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                <rect x="8.5" y="2" width="7" height="5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <rect x="1.5" y="17" width="7" height="5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <rect x="15.5" y="17" width="7" height="5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M12 7v6.5M5 17v-3.5h14V17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </ControlButton>
            {/* No danger colour at rest, and no word either. `button.btn.danger`
                is the confirm half of the Clear dialog and stays there: this
                button destroys nothing, it opens a question, and colouring the
                question the same as the answer would leave the deck with two
                red controls of which only one is irreversible.
                A trash can rather than a broom. At 14px a broom is a diagonal
                line with fringe on the end and reads as almost anything; the
                can is the one glyph nobody has to be taught. The word "Clear"
                is not lost — it is the dialog's own heading, one click away,
                which is where the user reads it when it matters. */}
            <ControlButton
              data-group-start=""
              data-danger=""
              onClick={() => requestClear("button")}
              title="Clear the canvas and the server's event log — asks first (C)"
              aria-label="Clear the canvas"
            >
              {/* trash can — lid, handle, tapered body, two inner strokes */}
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                <path d="M4 6.2h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                <path d="M9 6.2V4.4a1.6 1.6 0 0 1 1.6-1.6h2.8a1.6 1.6 0 0 1 1.6 1.6v1.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <path d="M17.4 6.4 16.7 20a2 2 0 0 1-2 1.9H9.3a2 2 0 0 1-2-1.9L6.6 6.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <path d="M10.3 10.6v6.8M13.7 10.6v6.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </ControlButton>
            {/* The one thing on screen that says the keyboard exists.
                It is here and not in the topbar, deliberately. The bar was cut
                back to identity, status and settings this week and the canvas
                verbs moved down into this stack; a control that opens a
                reference about the canvas is the same kind of thing. What it
                buys over the list in the detail rail is that it is always
                there: the rail draws its shortcuts only while nothing is
                selected, and it can be closed outright, so on the deck a user
                actually works in there is no other affordance at all.
                A glyph rather than a word, like the four above it, and the key
                is in the tooltip the way every other control on this deck
                names its own. */}
            <ControlButton
              data-group-start=""
              onClick={() => setKeyHelpOpen(o => !o)}
              title="Keyboard shortcuts (?)"
              aria-label="Open the keyboard shortcuts"
              aria-haspopup="dialog"
            >
              {/* A question mark drawn rather than typed: the stack's other
                  four are strokes at 14px and a glyph from the body face would
                  sit a weight and a baseline away from them. */}
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                <path d="M8.6 8.4a3.5 3.5 0 1 1 4.6 3.35c-.85.3-1.2 1-1.2 1.85v1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <path d="M12 18.4v.2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
              </svg>
            </ControlButton>
          </Controls>
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
          {characterEnabled && <ClaudeFm volume={fmVolume} source={fmSource} />}
        </ReactFlow>
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
                onOpenTool={setOpenedToolId}
                onShowSummary={setSummaryFor}
                onExportSession={(sid) => exportSessionJson(stateRef.current, sid)}
              />
        </aside>
      ) : null}

      {openedTool && <ToolModal tool={openedTool} onClose={() => setOpenedToolId(null)} />}
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
            setWatchSeenMs(ms);
            try { localStorage.setItem(SEEN_KEY, String(ms)); } catch { /* private window */ }
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
      {/* Before the clear prompt and after everything else, which is where a
          reference belongs: it may paint over a tool inspector somebody opened
          the sheet on top of, and it must not paint over the one dialog that is
          waiting for an answer. Escape agrees with the paint order — the prompt
          carries CONFIRM_LAYER and the stack in modal-dismiss.ts resolves layer
          before arrival. */}
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
          onClose={() => setReleaseNotes(null)}
          onTour={() => { setReleaseNotes(null); setTourOpen(true); }}
          updateVersion={readyAppUpdate?.version}
          updateBusy={desktopUpdateRestarting}
          onUpdateRestart={readyAppUpdate ? () => { void askDesktopUpdateRestart(readyAppUpdate.version); } : undefined}
          /* Only where the server would do it: an unsupervised deck answers
             501 and one without a writable log 409, and the button is not
             offered for either (#1163). */
          onRestart={!readyAppUpdate && version?.canRestart ? () => { setReleaseNotes(null); void askRestart(); } : undefined}
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
            onLater={() => {
              if (lanBusy) return;
              lanDeferred.current.add(request.fp);
              // The set is a ref, so nothing above re-renders on its own: bump
              // the list it is filtered against to redraw once.
              setLanPending(prev => [...prev]);
            }}
          />
        );
      })()}
      {keyHelpOpen && <KeyboardHelp onClose={() => setKeyHelpOpen(false)} onTour={() => { setKeyHelpOpen(false); setTourOpen(true); }} />}
      {tourOpen && (
        <GuideModal title="What the deck shows you" steps={WELCOME_STEPS} onClose={() => {
          setTourOpen(false);
          // Seen means a person closed it — Done, ×, Escape or the scrim. A tab
          // that reloaded with it open never got here, so it opens again.
          writeTourSeen(seenStore());
          if (inDesktopApp()) {
            void fetch("/api/prefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tourSeen: true }),
              keepalive: true,
            }).catch(() => {});
          }
          // The changelog an upgrade was holding back, now that the pictures
          // have been seen. Taken out of the ref first, so a tour opened by
          // hand later never replays it.
          const held = notesAfterTour.current;
          notesAfterTour.current = null;
          if (held) setReleaseNotes(held);
        }} />
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

/** The hero for a tab whose stream is queued behind other deck tabs' streams
 *  (#830). Not the server: the server is fine, and the other deck tabs in this
 *  browser are live. Said as what to do, because the browser connects this tab
 *  the moment one of the others closes. */
function TabCapHero() {
  return (
    <div className="empty-hero">
      <div className="orbit-stack" aria-hidden>
        <div className="core" />
        <div className="orbit r1"><span className="dot" /><span className="dot b" /></div>
        <div className="orbit r2"><span className="dot" /><span className="dot b" /></div>
        <div className="orbit r3"><span className="dot" /><span className="dot b" /></div>
      </div>
      <h2>Too many {PRODUCT} tabs are open</h2>
      <p>
        This browser keeps at most six live connections to one address, and
        other <code>{PRODUCT}</code> tabs are holding them. Close one and this
        tab connects on its own.
      </p>
    </div>
  );
}

function EmptyHero({ live, everConnected, providers, workspace, onTour }: {
  live: boolean; everConnected: boolean; providers: Providers; workspace: string | null;
  onTour: () => void;
}) {
  const offline = !live;
  return (
    <div className="empty-hero">
      <div className="orbit-stack" aria-hidden>
        <div className="core" />
        <div className="orbit r1"><span className="dot" /><span className="dot b" /></div>
        <div className="orbit r2"><span className="dot" /><span className="dot b" /></div>
        <div className="orbit r3"><span className="dot" /><span className="dot b" /></div>
      </div>
      {offline ? (
        <>
          <h2>{everConnected ? "Disconnected from server" : "Server unreachable"}</h2>
          {/* In the reader's words, not the route's (#832): `/events` is the
              stream's endpoint and means nothing to somebody who typed
              `npx ccdeck`. What they need is which of the two happened and
              where to look. */}
          <p>
            {everConnected ? "This page lost its connection to " : "This page cannot reach "}
            <code>{PRODUCT}</code>. Check that it is still running in your terminal —
            the page picks up again on its own.
          </p>
        </>
      ) : agentNoneCopy(providers, workspace)}
      {/* THE WAY BACK TO THE TOUR, on the one screen a person who has not yet
          seen anything is looking at. It is a control on a hero that is
          pointer-transparent by design (a drag starting here still pans), so
          the sheet gives this one element its pointer back. Offline, the hero
          is about the server, and the tour would be a promise about a canvas
          that cannot fill. */}
      {!offline && (
        <button type="button" className="btn empty-tour" onClick={onTour}>Take the tour</button>
      )}
    </div>
  );
}

function agentNoneCopy(providers: Providers, workspace: string | null) {
  // THE SCOPE SENTENCE BELONGS HERE, not only in the detail rail (#802). This
  // hero said "run it in any folder" whatever the deck was watching, and the
  // one user for whom the canvas stays empty is exactly the one who started it
  // with --scope or --workspace and then ran an agent outside that tree. They
  // were told to do the thing that will not work, and then sent to inspect
  // ~/.claude/settings.json and $CODEX_HOME for a filter they had set
  // themselves. scope.ts's own header says it exists because "the one piece of
  // text that appears when nothing shows up told that user scope could not be
  // the cause" — and it still did, for anyone who had not opened the rail,
  // which is closed on a fresh install.
  const scope = emptyScope(workspace);
  return (
    <>
      <h2>Waiting for Claude Code or Codex</h2>
      {scope.kind === "scoped" ? (
        <p>
          {scope.lead} <code>{scope.workspace}</code>{scope.tail}
        </p>
      ) : (
        <p>
          Run <code>claude</code> or <code>codex</code> in any folder. As soon as
          a session sends an event, a node appears here and grows as subagents
          fork and tools are called.
        </p>
      )}
      {/* This used to be one sentence for both CLIs, and it sent Codex users to
          install `~/.codex/hooks.json` and grant it `/hooks` trust — work the
          deck stopped doing before it ever shipped, on a file it opens only to
          uninstall (#404). One line per capture path now, each naming what that
          path really depends on, and each able to say the deck is not watching
          that CLI at all. The words live in provider-copy.ts so the branches can
          be tested without a DOM. */}
      {/* No "make sure ccdeck is running" line (#831). This copy renders only
          while the stream is live — the offline branch has its own words — so
          it told a connected reader to check the one thing the page already
          knew. What can really keep the canvas empty is a capture path, and
          each of those says so below. */}
      {captureHints(providers).map(hint => (
        <p className="hint-row" key={hint.provider}>
          {hint.spans.map((span, i) =>
            span.code
              ? <code key={i}>{span.text}</code>
              : <span key={i}>{span.text}</span>,
          )}
        </p>
      ))}
    </>
  );
}


function Detail({
  agent,
  now,
  onOpenTool,
  onShowSummary,
  onExportSession,
}: {
  agent: AgentNodeData;
  now: number;
  onOpenTool: (toolId: string) => void;
  onShowSummary?: (sessionId: string) => void;
  onExportSession?: (sessionId: string) => void;
}) {
  // The panel and the card it was opened from are on screen together, so this
  // is the card's clock rather than a second one written out here (#374). The
  // only value that moves is a span under a second, which used to read "0s"
  // beside a card reading "437ms" for the same agent.
  // A floor when the deck did not see the session start, as on the card (#822).
  const elapsedLabel = `${agent.synthetic ? "≥ " : ""}${elapsed(agent.startedAt, agent.endedAt, now)}`;

  const cost = agentCost(agent);
  const hasCost = cost.total > 0;
  const totalTokens = agent.usage.inputTokens + agent.usage.outputTokens;

  // Bucket tools by category for the activity strip
  const catCounts = new Map<DetailCategory, number>();
  for (const t of agent.tools) {
    const c = detailCategoryFor(t.name);
    catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
  }
  const errCount = agent.tools.filter(t => t.ok === false).length;
  const inflight = agent.tools.filter(t => !t.endedAt).length;
  const catEntries = Array.from(catCounts.entries())
    .sort((a, b) => b[1] - a[1]);
  // The one server this agent's MCP chip is counting, when there is one (#489)
  // — ToolBursts' own answer for those calls, so the chip is named and tinted
  // by the function that named and tinted the bubbles rather than by a second
  // rule that agrees with it today. null when the calls span two servers, or
  // when there are none, and the chip stays the generic category chip.
  const mcpChip = catCounts.has("mcp") ? mcpChipIdentity(agent.tools.map(t => t.name)) : null;

  return (
    <>
      <header className="detail-hero">
        <div className="hero-line">
          <span className={`state-pill state-${agent.state}`}>
            {agent.state === "active" ? "live" : agent.state}
          </span>
          <h2 className="hero-title" title={agent.cwd ?? agent.label}>{agent.label}</h2>
        </div>
        <div className="hero-meta">
          {/* The card's word for it, not the reducer's (#833): "root" is
              internal vocabulary, and one thing had two names. */}
          <span className="hero-meta-item">{agent.kind === "root" ? "session" : "subagent"}</span>
          <span className="hero-sep">·</span>
          <span className="hero-meta-item" title={`started ${new Date(agent.startedAt).toLocaleString()}`}>
            {elapsedLabel}
          </span>
          {agent.model && (() => {
            // Same chip, same rule, as the card this panel was opened from —
            // the current model by name, and a count of the others the figure
            // above it also covers (#686). Two surfaces showing one fact have
            // to show it the same way, or the panel reads as a correction of
            // the card rather than a larger view of it.
            const others = otherModelIds(agent);
            return (
              <>
                <span className="hero-sep">·</span>
                <span
                  className="model-chip"
                  // From the model, never from the title beside it: since #686
                  // that title lists every model this panel's spend covers, and
                  // the sheet matched it by substring.
                  data-family={modelFamily(agent.model)}
                  title={others.length > 0
                    ? `${agent.model}\nspend on this panel also covers:\n${others.join("\n")}`
                    : agent.model}
                >{shortModel(agent.model)}{others.length > 0 ? ` +${others.length}` : ""}</span>
              </>
            );
          })()}
        </div>
        {hasCost && (
          <div className="hero-cost">
            <div className="hero-cost-headline">
              <span className="hero-cost-value">{fmtCost(cost.total)}</span>
              <span className="hero-cost-label">spend</span>
            </div>
            <CostBar cost={cost} />
          </div>
        )}
        <div className="hero-actions">
          {agent.kind === "root" && agent.state === "done" && onShowSummary && (
            <button
              type="button"
              className="btn hero-action-btn"
              onClick={() => onShowSummary(agent.sessionId)}
              title="Reopen the end-of-session recap modal"
            >Show recap</button>
          )}
          {onExportSession && (
            <button
              type="button"
              className="btn hero-action-btn"
              onClick={() => onExportSession(agent.sessionId)}
              title="Download this session as JSON"
            >Export JSON</button>
          )}
        </div>
      </header>

      {/* Claude Code's recap, whole — the one surface with the room for all of
          it. The card clamps it to two lines and the session list to three;
          this is where it is read. Same rule as both, from session-recap.ts. */}
      {(() => {
        const recap = recapShown(agent);
        if (!recap) return null;
        const written = promptTime(recap.at, now);
        return (
          <section className="detail-section">
            <h3>Recap <span className="section-count" title={written.title}>{written.label}</span></h3>
            <p className="detail-recap">{recap.text}</p>
          </section>
        );
      })()}

      {agent.tools.length > 0 && (
        <section className="detail-section">
          <h3>Activity</h3>
          <div className="activity-row">
            <div className="activity-counters">
              <span className="ac-item"><b>{agent.toolCount}</b> calls</span>
              {inflight > 0 && <span className="ac-item ac-live"><b>{inflight}</b> live</span>}
              {errCount > 0 && <span className="ac-item ac-err"><b>{errCount}</b> err</span>}
            </div>
            <div className="cat-strip">
              {catEntries.map(([c, n]) => {
                // Only the mcp chip has a server behind it, and only when every
                // one of its calls went to the same one. The hue rides in as a
                // custom property and styles.css composes the colour — the
                // lightness belongs to the theme, not to JS (#330).
                const one = c === "mcp" ? mcpChip : null;
                const hue = one?.hue;
                const calls = `${n} ${DETAIL_CAT_LABEL[c]} call${n === 1 ? "" : "s"}`;
                return (
                  <span
                    className={`cat-chip cat-${c}${hue != null ? " mcp-hue" : ""}`}
                    key={c}
                    style={hue != null ? { "--mcp-hue": hue } as React.CSSProperties : undefined}
                    title={one ? `${calls}, all to ${one.label}` : calls}
                  >
                    {/* The category as a word at rest (#841): an emoji and a
                        count said nothing without a hover, and a title never
                        reaches a keyboard or touch reader. The word is the
                        key, the count its value; the emoji is decoration now. */}
                    <span className="cat-emoji" aria-hidden>{DETAIL_CAT_EMOJI[c]}</span>
                    <span className="cat-name">{DETAIL_CAT_LABEL[c]}</span>
                    <span className="cat-count">{n}</span>
                    {/* The words the tint cannot be trusted to carry alone. */}
                    {one && <span className="cat-server">{one.label}</span>}
                  </span>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {totalTokens > 0 && (
        <section className="detail-section">
          <h3>Tokens</h3>
          <div className="tokens-grid">
            {/* The usage panel's format, not a grouped integer (#835): side by
                side, 111,053,708 and 177.08M read as two kinds of measure. The
                exact count stays one hover away. */}
            <div><span className="k">in</span><b title={agent.usage.inputTokens.toLocaleString()}>{fmtTokens(agent.usage.inputTokens)}</b></div>
            <div><span className="k">out</span><b title={agent.usage.outputTokens.toLocaleString()}>{fmtTokens(agent.usage.outputTokens)}</b></div>
            <div><span className="k">cache r</span><b title={agent.usage.cacheReadTokens.toLocaleString()}>{fmtTokens(agent.usage.cacheReadTokens)}</b></div>
            <div><span className="k">cache c</span><b title={agent.usage.cacheCreateTokens.toLocaleString()}>{fmtTokens(agent.usage.cacheCreateTokens)}</b></div>
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3>Identity</h3>
        <div>
          {agent.cwd && <div className="row"><span className="k">cwd</span><span className="v" title={agent.cwd}>{agent.cwd}</span></div>}
          <div className="row"><span className="k">session</span><span className="v">{agent.sessionId.slice(0, 12)}…</span></div>
          {agent.parentId && <div className="row"><span className="k">parent</span><span className="v">{agent.parentId.slice(0, 12)}…</span></div>}
        </div>
      </section>

      {agent.prompts.length > 0 && (
        <section className="detail-section">
          {/* The count is what was typed (#834). A background task's notice
              is listed as the event it is, collapsed, in its place in time. */}
          <h3>Prompts <span className="section-count">{typedPrompts(agent.prompts).length}</span></h3>
          <div className="prompts">
            {agent.prompts.slice().reverse().map((pr, i) => {
              const t = promptTime(pr.at, now);
              const injected = injectedPrompt(pr.text);
              if (injected) {
                return (
                  <details className="prompt-entry prompt-injected" key={i}>
                    <summary>
                      <span className="prompt-time" title={t.title}>{t.label}</span>
                      <span className="prompt-injected-label">{injected.label}</span>
                    </summary>
                    {injected.detail && <div className="prompt-injected-detail">{injected.detail}</div>}
                  </details>
                );
              }
              return (
                <div className="prompt-entry" key={i}>
                  <div className="prompt-time" title={t.title}>{t.label}</div>
                  <div className="prompt-text">{pr.text}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3>Tool calls <span className="section-count">{agent.tools.length}</span></h3>
        {agent.tools.length === 0 && <div className="empty">No tool calls yet.</div>}
        <div>
          {agent.tools.slice().reverse().map(t => (
            <ToolRow key={t.id} t={t} onClick={() => onOpenTool(t.id)} />
          ))}
        </div>
      </section>
    </>
  );
}

/** What a tool call's outcome is called, in the words this app already prints
 *  for one: ToolModal writes `in-flight…` where the duration goes while a call
 *  is open and tags its Response section `error` when it failed. A tool call is
 *  not a session, so this is deliberately not stateLabel's vocabulary — `err`
 *  is the word on a session card and `error` is the word on a tool, and those
 *  two surfaces already said it that way before #373 touched either. */
const TOOL_STATUS_LABEL = { inflight: "in-flight", done: "done", err: "error" } as const;

// No `now` prop any more. It only ever fed the duration, and the duration only
// ever used it on the branch it then threw away — an open call prints a
// sentinel, and a finished one carries both of its own timestamps. The row is
// not memoised, so the tick that re-renders the panel still re-renders it.
function ToolRow({ t, onClick }: { t: ToolCall; onClick: () => void }) {
  const status = t.endedAt == null ? "inflight" : t.ok === false ? "err" : "done";
  // This row is the button that opens ToolModal for this exact call, and the
  // two used to round the same milliseconds differently — "1.2s" here and
  // "1.24s" one click later (#374). The sentinel is the only thing that still
  // differs, because a list cell has no room for the word the dialog writes.
  const durLabel = toolDuration(t, "…");
  return (
    <button className="tool clickable" title={t.inputPreview || t.name} onClick={onClick}>
      <span className="name">
        {/* The dot said nothing here — an empty <span> that was not even marked
            decorative — so a failed call and a finished one both announced
            "Bash 1.24s" and differed by red against green, the one pair a
            red-green CVD cannot separate at all (#373). The dot is explicitly
            decoration now, because the stylesheet draws its ✓ and × with
            `content:` and generated content IS spoken by some readers: without
            aria-hidden the row would say the mark and then the word.
            The word leads, where the dot is, for the reason the session list
            gives — the accessible name is the contents in DOM order, so
            "error Bash 1.24s" is read in the order it is seen. */}
        <span className={`status-dot ${status}`} aria-hidden />
        <span className="vis-hidden">{TOOL_STATUS_LABEL[status]}</span>
        {t.name}
      </span>
      <span style={{ color: "var(--muted)" }}>{durLabel}</span>
    </button>
  );
}
