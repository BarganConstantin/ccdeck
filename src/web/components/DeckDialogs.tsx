// The dialogs at the end of the deck's markup, in the order they paint over one
// another: the tool inspector, Usage history, Browser Watch, the context
// breakdown, the feedback dialog, the session recap and Settings; then the ones
// that arrive without being asked for, the release notes, a LAN pairing request and an account that needs
// signing in again; then the shortcuts sheet and the tour; and last the clear
// prompt, which is waiting for an answer.
//
// Moved out of App.tsx's markup unchanged, with the notes on the order. Which
// of the first six is open is use-dialogs.ts's; the notes and the tour, the
// pairing request and the clear prompt are their own hooks'. Each hook's return
// comes in whole and is taken apart here under the names the markup already
// used. Usage history and Browser Watch load when they open (#883), so their two
// lazy imports came with them.
import { Suspense, type MutableRefObject } from "react";
import { updateRestartFailureText } from "../desktop-update";
import type { Providers } from "../providers";
import type { GraphState } from "../reducer";
import type { useAppearance } from "../use-appearance";
import type { useAutoRestart } from "../use-auto-restart";
import type { useBrowserWatchBadge } from "../use-browser-watch-badge";
import type { useClaudeFm } from "../use-claude-fm";
import type { useClearFlow } from "../use-clear-flow";
import type { useCustomTones } from "../use-custom-tones";
import type { useDeckUpgrade } from "../use-deck-upgrade";
import type { useDesktopUpdate } from "../use-desktop-update";
import type { useDialogs } from "../use-dialogs";
import type { useLanPairRequests } from "../use-lan-pair-requests";
import type { AccountAttention as Attention } from "../use-account-attention";
import type { useLiveAnnouncements } from "../use-live-announcements";
import type { useOsNotifications } from "../use-os-notifications";
import type { useSettingsMenus } from "../use-settings-menus";
import type { useSoundSwitch } from "../use-sound-switch";
import type { useTonePrefs } from "../use-tone-prefs";
import type { useVersionCheck } from "../use-version-check";
import type { useWelcomeAndNotes } from "../use-welcome-and-notes";
import ClearConfirm from "./ClearConfirm";
import ContextModal from "./ContextModal";
import FeedbackDialog from "./FeedbackDialog";
import GuideModal from "./GuideModal";
import { WELCOME_STEPS } from "./guide-art";
import KeyboardHelp from "./KeyboardHelp";
import { lazyDialog } from "./LazyDialog";
import { usePairRequestDialog } from "./LanPairRequestModal";
import { AccountAttention } from "./AccountAttentionModal";
import ReleaseNotesModal from "./ReleaseNotesModal";
import SessionSummary from "./SessionSummary";
import SettingsModal from "./SettingsModal";
import ToolModal from "./ToolModal";
// Loaded when they open (#883). Both are opened rarely and each is a large
// file; imported here, they were in the one bundle every reload and every deck
// opened from another machine had to fetch before drawing anything. The topbar
// needs only Browser Watch's unseen count, which lives in browser-watch-seen.
// A chunk that does not arrive — a tab older than an upgrade asking for a name
// the new build no longer has — fails that dialog alone; see LazyDialog.tsx.
const UsageHistoryModal = lazyDialog(() => import("./UsageHistoryModal"), "Usage history");
const BrowserWatchModal = lazyDialog(() => import("./BrowserWatchModal"), "Browser Watch");
const TrafficRadar = lazyDialog(() => import("./TrafficRadar"), "Telemetry Radar");

export default function DeckDialogs({
  dialogs, welcome, desktopUpdate, versionCheck, restart, upgrade, lanPairs, attention, clearFlow, watchBadge, announcements,
  appearance, providers, stateRef, agentCount, menus, sound, tones, customTones, notify, fm,
}: {
  dialogs: ReturnType<typeof useDialogs>;
  welcome: ReturnType<typeof useWelcomeAndNotes>;
  desktopUpdate: ReturnType<typeof useDesktopUpdate>;
  versionCheck: ReturnType<typeof useVersionCheck>;
  restart: ReturnType<typeof useAutoRestart>;
  /** The banner's install and copy, which What's new offers too. */
  upgrade: ReturnType<typeof useDeckUpgrade>;
  lanPairs: ReturnType<typeof useLanPairRequests>;
  attention: Attention;
  clearFlow: ReturnType<typeof useClearFlow>;
  watchBadge: ReturnType<typeof useBrowserWatchBadge>;
  announcements: ReturnType<typeof useLiveAnnouncements>;
  appearance: ReturnType<typeof useAppearance>;
  providers: Providers;
  stateRef: MutableRefObject<GraphState>;
  /** How many agents a Clear would take off the board. */
  agentCount: number;
  /** Whether Settings is up and at which section, and the door into it. */
  menus: ReturnType<typeof useSettingsMenus>;
  /** Everything Settings sets, each hook's return whole. */
  sound: ReturnType<typeof useSoundSwitch>;
  tones: ReturnType<typeof useTonePrefs>;
  customTones: ReturnType<typeof useCustomTones>;
  notify: ReturnType<typeof useOsNotifications>;
  fm: ReturnType<typeof useClaudeFm>;
}) {
  const { openedTool, setOpenedToolKey, usageHistoryOpen, setUsageHistoryOpen, browserWatchOpen,
          setBrowserWatchOpen, contextAgent, setContextFor, summaryFor, setSummaryFor, keyHelpOpen,
          setKeyHelpOpen, feedbackOpen, setFeedbackOpen, feedbackPrefill, setFeedbackPrefill } = dialogs;
  const { trafficRadarOpen, setTrafficRadarOpen } = dialogs;
  const { tourOpen, openTour, closeTour, releaseNotes, closeReleaseNotes, chipVersion } = welcome;
  const { desktopUpdateRestarting, desktopUpdateFailure, readyAppUpdate, askDesktopUpdateRestart } = desktopUpdate;
  const { version } = versionCheck;
  const { askRestart } = restart;
  const { clearConfirmOpen, setClearConfirmOpen, requestClear } = clearFlow;
  const { setWatchOn, markWatchSeen } = watchBadge;
  const { setWatchSaid } = announcements;
  const { palette } = appearance;
  const { settingsOpen, settingsSection, showSection, closeSettings, openSettings } = menus;
  return (
    <>
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
      {contextAgent && <ContextModal agent={contextAgent} onClose={() => setContextFor(null)} />}
      {trafficRadarOpen && <Suspense fallback={null}>
        <TrafficRadar sessions={[...stateRef.current.agents.values()].filter(agent => agent.kind === "root" && agent.provider !== "codex").map(agent => ({ id: agent.sessionId, label: agent.cwdBasename ?? agent.label }))} onClose={() => setTrafficRadarOpen(false)} />
      </Suspense>}
      {feedbackOpen && (
        <FeedbackDialog
          initialKind={feedbackPrefill?.initialKind}
          initialBody={feedbackPrefill?.initialBody}
          onClose={() => { setFeedbackOpen(false); setFeedbackPrefill(null); }}
        />
      )}
      {summaryFor && (
        <SessionSummary
          state={stateRef.current}
          sessionId={summaryFor}
          onClose={() => setSummaryFor(null)}
        />
      )}
      {/* Settings, the last of the dialogs the reader opens: opened by the
          topbar's gear, by Cmd/Ctrl+, and by V at Sounds —
          use-settings-menus.ts. Here rather than beside the gear,
          so it is mounted from the top of the tree like every dialog App
          opens, and ahead of everything that arrives on its own, which may
          paint over it. */}
      {settingsOpen && (
        <SettingsModal
          section={settingsSection}
          onSection={showSection}
          onClose={closeSettings}
          providers={providers}
          sound={sound}
          tones={tones}
          customTones={customTones}
          notify={notify}
          appearance={appearance}
          fm={fm}
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
          updateCheck={{ versionCheck, upgrade, restart, desktopUpdate, running: chipVersion, onHandOff: closeReleaseNotes }}
        />
      )}
      {/* After the release notes and before the clear prompt. Both of those
          also arrive without being asked for, and the order between them is
          the order of what they want: a question that is holding another
          machine up outranks an announcement about this one, and neither
          outranks the prompt somebody is standing in front of deciding
          whether to truncate a log. Like the re-sign-in prompt, it waits for
          any dialog already open to close before it first appears, rather
          than taking the keyboard from under it.
          The re-sign-in prompt comes after the pairing request, which holds
          another machine up, and ahead of the sheet, the tour and the clear
          prompt (#1893). It also waits for any dialog already open to close
          before it first appears, so it never takes the keyboard from
          somebody mid-task — see promptShows — and the two come up one at a
          time: see UnaskedPrompts, below. */}
      <UnaskedPrompts lanPairs={lanPairs} attention={attention} />
      {/* Before the clear prompt and after everything else, which is where a
          reference belongs: it may paint over a tool inspector somebody opened
          the sheet on top of, and it must not paint over the one dialog that is
          waiting for an answer. Escape agrees with the paint order — the prompt
          carries CONFIRM_LAYER and the stack in modal-dismiss.ts resolves layer
          before arrival. */}
      {keyHelpOpen && (
        <KeyboardHelp
          onClose={() => setKeyHelpOpen(false)}
          onTour={() => { setKeyHelpOpen(false); openTour(); }}
          onSettings={() => { setKeyHelpOpen(false); openSettings("general"); }}
        />
      )}
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
    </>
  );
}

/** The two dialogs that arrive on their own and wait their turn: a LAN pairing
 *  request, then an account that needs signing in again — decided together,
 *  in one render, so they come one at a time and in that order.
 *
 *  Each used to decide by itself, from the number of dialogs on the stack, and
 *  a dialog joins the stack only after the render that draws it. So when a
 *  dialog both were waiting on closed, both counted none on the same render
 *  and came up together, the re-sign-in prompt — later in the document, and
 *  the one that can wait — painted over the request and holding the keyboard.
 *  Here the request is decided first, and one going up counts against the
 *  prompt behind it. Its own component, so DeckDialogs stays one that calls no
 *  hooks. */
export function UnaskedPrompts({ lanPairs, attention }: {
  lanPairs: ReturnType<typeof useLanPairRequests>;
  attention: Attention;
}) {
  const pairRequest = usePairRequestDialog(lanPairs);
  return (
    <>
      {pairRequest}
      <AccountAttention {...attention} pairing={pairRequest != null} />
    </>
  );
}
