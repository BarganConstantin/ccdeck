// The topbar's observation group, and the readouts in it: the status strip (the
// stream's pill), the three count pills (waiting, working, done) with the
// queue popover that names who is waiting, and what the browser answered when
// notifications were asked for.
//
// Moved out of App.tsx's markup unchanged: the readouts first, and then the
// group itself (ReadoutGroup, at the end) — the wordmark, the counts, the
// chips, the live regions that speak for these (which have to be mounted whether or not
// these are, #372) and the reasons each sits where it does. App.tsx hands the
// group each hook's return whole, and it is taken apart there under the names
// the markup already used. The bar's END group (version chip, Layout switch,
// Search, Feedback) is the group's children, so it stands after the start
// group in one element each, as V4's Figma draws the bar.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { BlockedSession } from "../ambient-counts";
import { MARK_SMALL_ON_LIGHT_SRC, MARK_SMALL_SRC, PRODUCT } from "../brand";
import { DONE_WORD, WORKING_WORD, type SessionCounts } from "../topbar-counts";
import { statusPill } from "../status-pill";
import type { useDesktopUpdate } from "../use-desktop-update";
import type { useLiveAnnouncements } from "../use-live-announcements";
import type { useOsNotifications } from "../use-os-notifications";
import type { PauseControls } from "../use-pause-gate";
import type { useVersionCheck } from "../use-version-check";
import type { useWelcomeAndNotes } from "../use-welcome-and-notes";
import type { Incident } from "../provider-status";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { queueEntryName, queueName, waitWhat } from "../waiting-queue";
import AnchoredPopover from "./AnchoredPopover";
import ChipPresence from "./ChipPresence";
import { IncidentChips } from "./ProviderIncidents";
import { AlertMark, StateMark } from "./StateMark";
import { elapsedShort } from "./SessionList";
import { useHint } from "./use-hint";
import VersionChip from "./VersionChip";
import { versionChipNeeded } from "../version-chip";
import { t as translate, useT, type TFunction } from "../i18n";

export function StatusStrip({ live, paused, pauseGate }: {
  /** Whether the event stream is connected right now. */
  live: boolean;
  paused: boolean;
  pauseGate: PauseControls["pauseGate"];
}) {
  const t = useT();
  const singleKeys = useSingleKeyShortcuts();
  const pill = statusPill({
    connected: live, paused,
    held: pauseGate.size, dropped: pauseGate.dropped, singleKeys,
  }, t);
  return (
    /* The strip is the chip's slot: it arrives and leaves with the pill
       (ChipPresence), and is no element at all once the pill has gone. */
    <ChipPresence show={!pill.resting} className="status">
      {/* Three states, not two. Read through the gate rather than a
          counter of its own: the queue is the thing being reported.
          The count is in the LABEL now, not only the title. It used to be
          printed on the Pause button at the far end of the bar, and that
          button has gone down to the canvas control stack where the other
          canvas verbs went in #527 — so one fact stopped being split
          across two ends of a row, and the pill, which already knew the
          number, says it.
          The ghost below is what keeps that free. The pill's width is
          upstream of everything after it in the readout — the blocked
          count and any incident chip: a count going 9 → 10 would walk
          them, which is #504 one bar over, and the count moves on its own
          where a label never did. A copy of the
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
      {/* Nothing at rest (#719). The ghost above explains why the box
          measures its own worst case; this is the case where the box
          itself is not earned. The slot is then gone and the readout
          closes up without anything shifting on its own — the tone only
          ever changes because Space was pressed or the stream died. */}
      {!pill.resting && (
        <span className={`pill ${pill.tone}`} title={pill.title}>
          <span className="pill-box">
            <span className="pill-widest" aria-hidden>{pill.widest}</span>
            <span className="pill-label">{pill.label}</span>
          </span>
        </span>
      )}
      {/* WHAT IS LEFT IS THE ONE THING THE STRIP IS FOR: whether the stream
          is alive. That is a fact about right now, which is the only tense a
          topbar can keep, and the two readouts that used to follow the pill
          went for not keeping it.
          The machine meter was the one that had been earning its width. A 50x24 box drew a 60-second CPU sparkline and a
          memory bar, and it was the only readout here that was not about
          agents. What it could not do is stop: it is a trace that moves
          whether or not anything on the canvas is happening, in the corner
          of a bar the eye returns to for the one thing this deck is for. The
          panel it disclosed says everything it said and eleven things it
          could not, and the Machine button opens that panel without drawing
          anything at all.
          The month-to-date phrase went the same way ("this month", its
          tokens and its dollars, #737). A month's total is a fact about the
          weeks behind you, not about this minute: it moved by a sliver an
          hour, and keeping it current cost a ccusage run every five minutes
          — a walk of every transcript on disk — for as long as the tab was
          in front and the window wide enough to draw it.
          The Usage panel (U) answers "today", "this month" and "all time"
          from the same logs, with the split by model and by kind of token
          the phrase never had room for.
          A glance costs a click or a key now; the bar costs no attention,
          and the machine no read nobody asked for. */}
    </ChipPresence>
  );
}

/** One queued session's words: its name, how long it has waited, and what on
 *  — the session list row's order, "waiting 6m · Bash", so the two read the
 *  same. The wait is the line's number and stands in the foreground; what it
 *  is on is the annotation (DESIGN.md, duration beats description). */
function QueueEntryWords({ w, now }: { w: BlockedSession; now: number }) {
  const t = useT();
  return (
    <>
      <span className="we-name">{queueName(w.label)}</span>
      <span className="we-wait">{elapsedShort(w.waiting.since, undefined, now)}</span>
      <span className="we-what">· {waitWhat(w.waiting, t)}</span>
    </>
  );
}

/** The waiting pill's id, which the queue popover hangs off and is named by. */
export const WAITING_PILL_ID = "waiting-pill";
export const QUEUE_POP_ID = "queue-pop";
/** --dur-exit (tokens.css), in ms: how long a closing popover stays mounted so
 *  its opacity and scale can run out. A test holds the two equal. */
export const QUEUE_EXIT_MS = 150;

/** The last input was a key (input-modality.ts): V4 opens and closes by key
 *  with no motion at all. */
function keyDriven(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.motion === "instant";
}

/** The queue popover's face (V4's top bar: the old `.wait-names` row is this
 *  menu). One row per waiting session in the order W and N walk — the
 *  longest wait first — each the old name's words, and a row goes to that
 *  session. AnchoredPopover owns the placement under the pill, Escape, a press
 *  outside, and the arrows along the rows (role="menu"). ITS MOTION is
 *  transitions on a class: it mounts closed (opacity 0, scale --enter-scale from
 *  the pill's corner), a frame later `queue-pop-open` takes it to 1, and
 *  leaving removes the class so it runs to .98 over --dur-exit before the
 *  caller unmounts it. By key there is no motion (data-motion="instant"), and
 *  under reduced motion only opacity moves; both are in topbar-controls.css. */
function QueuePopover({ sessions, now, leaving, onPick, onClose }: {
  sessions: BlockedSession[];
  now: number;
  leaving: boolean;
  onPick: (sessionId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    if (keyDriven()) { setShown(true); return; }
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setShown(true)); });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <AnchoredPopover
      anchorId={WAITING_PILL_ID} id={QUEUE_POP_ID} role="menu" labelledBy={WAITING_PILL_ID} align="start"
      className={leaving ? "queue-pop queue-pop-leaving" : shown ? "queue-pop queue-pop-open" : "queue-pop"}
      onClose={onClose}
    >
      {sessions.map(w => (
        <button
          key={w.id}
          type="button"
          role="menuitem"
          className="queue-row"
          onClick={() => onPick(w.id)}
          aria-label={queueEntryName(w.label, w.waiting, now - w.waiting.since, t)}
        >
          <QueueEntryWords w={w} now={now} />
        </button>
      ))}
    </AnchoredPopover>
  );
}

/** A count pill that is only a readout: Working and Done always, and Waiting
 *  while nothing waits (V4's Figma draws all three pills always). 24 tall, no
 *  stroke, the glyph, the figure in mono 600 and the word. */
const PILL_CLASS = {
  waiting: "count-pill count-waiting",
  working: "count-pill count-working",
  done: "count-pill count-done",
} as const;

export function CountPill({ kind, count, glyph, word }: {
  kind: "waiting" | "working" | "done";
  count: number;
  glyph: ReactNode;
  word: string;
}) {
  return (
    <span className={PILL_CLASS[kind]}>
      {glyph}
      <b>{count}</b>
      <span className="count-word">{word}</span>
    </span>
  );
}

/** The count of sessions blocked on you: the first of the bar's three pills,
 *  outlined in --warn, the bar's one alarm — and the door to the queue. A press
 *  (or Enter, Space, ArrowDown) opens the queue popover under it; a row goes to
 *  that session, and so does W, which then walks the rest (#825). With nothing
 *  waiting it is a quiet readout like its two neighbours and opens nothing.
 *
 *  What the press did before: it went straight to the longest wait (or, with
 *  the terminal on, started the run of asks). Both stay one key away — W does
 *  each (use-deck-shortcuts.ts) — and the longest wait is the popover's first
 *  row, focused when it opens. "+N more" (the session list) is L. */
export function WaitingStat({ waitingSessions, waitingCursorRef, focusSession, now }: {
  /** The sessions blocked on you, longest-stuck first. */
  waitingSessions: BlockedSession[];
  /** Where W starts from, so a row here and the next W press agree (#825). */
  waitingCursorRef: MutableRefObject<string | null>;
  focusSession: (sessionId: string) => void;
  now: number;
}) {
  const t = useT();
  const singleKeys = useSingleKeyShortcuts();
  const hint = useHint("below");
  const count = waitingSessions.length;
  const [pop, setPop] = useState<"closed" | "open" | "leaving">("closed");
  const popRef = useRef(pop);
  popRef.current = pop;
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = useCallback(() => {
    if (popRef.current !== "open") return;
    if (keyDriven()) { setPop("closed"); return; }
    setPop("leaving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPop("closed"), QUEUE_EXIT_MS);
  }, []);
  // Everyone answered while it was up: nothing left to list.
  useEffect(() => { if (count === 0 && pop !== "closed") setPop("closed"); }, [count, pop]);

  if (count === 0) {
    return <CountPill kind="waiting" count={0} glyph={<AlertMark size={14} />} word={t("board.queue.waiting")} />;
  }
  const waitingLabel = t("board.queue.waitingForYou", { count });
  return (
    <>
      <button
        type="button"
        id={WAITING_PILL_ID}
        className="count-pill count-waiting waiting-stat"
        onClick={() => {
          if (popRef.current === "closed") setPop("open");
          else close();
        }}
        onKeyDown={e => {
          if (e.key === "ArrowDown" && popRef.current === "closed") { e.preventDefault(); setPop("open"); }
        }}
        aria-label={waitingLabel}
        aria-haspopup="menu"
        aria-expanded={pop === "open"}
        aria-controls={pop !== "closed" ? QUEUE_POP_ID : undefined}
        aria-keyshortcuts={singleKeys ? "W" : undefined}
        {...hint.bind({ label: waitingLabel, keys: singleKeys ? "W" : undefined })}
      >
        <AlertMark size={14} />
        <b>{count}</b>
        <span className="count-word">{t("board.queue.waiting")}</span>
      </button>
      {hint.node}
      {pop !== "closed" && (
        <QueuePopover
          sessions={waitingSessions} now={now} leaving={pop === "leaving"} onClose={close}
          onPick={id => {
            waitingCursorRef.current = id;
            close();
            focusSession(id);
          }}
        />
      )}
    </>
  );
}

/** What each answer means, for the chip's title and the region's sentence. */
const NOTIFY_SAID_MEANS = {
  on: "board.notify.means.on",
  blocked: "board.notify.means.blocked",
} as const;

/** What the always-mounted region says about the browser's answer, or nothing
 *  (#1763). The whole of it rather than the chip's two words: what they mean
 *  is on the chip only as a hover title, which a screen reader cannot be
 *  relied on to reach — and for a refusal, the remedy is that half. */
export function notifySaidSentence(notifySaid: "on" | "blocked" | null, tr: TFunction = translate): string {
  if (notifySaid === "on") return tr("board.notify.said.on");
  if (notifySaid === "blocked") return tr("board.notify.said.blocked");
  return "";
}

export function NotifySaid({ notifySaid }: { notifySaid: "on" | "blocked" }) {
  const t = useT();
  return (
    <span
      // Written out rather than composed from the state, so the class
      // exists in the markup as a literal and unstyled-class.test.ts can
      // hold it to a rule in the sheet. A template here buys nothing and
      // costs the one check that catches a class with no styling behind
      // it — which is exactly how a warn colour goes missing silently.
      className={notifySaid === "on" ? "notify-said" : "notify-said notify-said-blocked"}
      // Seen, not heard: the region beside the other three says it (#1763).
      // A status role here arrived with its own text, which a screen reader
      // routinely never announces.
      aria-hidden
      title={t(NOTIFY_SAID_MEANS[notifySaid])}
    >{notifySaid === "on" ? t("board.notify.on") : t("board.notify.blocked")}</span>
  );
}

export function ReadoutGroup({
  versionCheck, welcome, desktopUpdate, pause, announcements, notify,
  waitingSessions, waitingCursorRef, focusSession, live, now, incidents, counts, asksSaid, children,
}: {
  versionCheck: ReturnType<typeof useVersionCheck>;
  welcome: ReturnType<typeof useWelcomeAndNotes>;
  desktopUpdate: ReturnType<typeof useDesktopUpdate>;
  pause: PauseControls;
  announcements: ReturnType<typeof useLiveAnnouncements>;
  notify: ReturnType<typeof useOsNotifications>;
  /** The sessions blocked on you, longest-stuck first. */
  waitingSessions: BlockedSession[];
  /** Where W starts from, so a click on the count and the next W press agree (#825). */
  waitingCursorRef: MutableRefObject<string | null>;
  focusSession: (sessionId: string) => void;
  /** Whether the event stream is connected right now. */
  live: boolean;
  now: number;
  /** What the providers' status pages report, incidents only (#1311). */
  incidents: Incident[];
  /** The working and done pills' figures (topbar-counts.ts); waiting is the
   *  queue's own length. */
  counts: Pick<SessionCounts, "working" | "done">;
  /** What the terminal's asks run says aloud (use-asks.ts), absent while the
   *  terminal flag is off. */
  asksSaid?: string;
  /** The bar's END group after the version chip: the Layout switch, Search and
   *  Feedback, which App owns. */
  children?: ReactNode;
}) {
  const { notice, noticeOpen, showNotice } = versionCheck;
  const { chipVersion, openReleaseNotes } = welcome;
  const { readyAppUpdate, desktopUpdateRestarting, desktopUpdateFailure, askDesktopUpdateRestart } = desktopUpdate;
  // A press of the topbar's Restart to update that came to nothing opens What's
  // new, where the reason and the way out are already written (rn-update-said)
  // — the button itself has nowhere to say a sentence. Only a press made HERE:
  // the dialog's own button fails into the dialog already on screen, and
  // reopening it would swap an upgrade's notes for the whole list. The ref is
  // let go when the press is over either way, so a later failure from the
  // dialog is not taken for this one's.
  const topbarPress = useRef(false);
  useEffect(() => {
    if (desktopUpdateRestarting || !topbarPress.current) return;
    topbarPress.current = false;
    if (desktopUpdateFailure) openReleaseNotes();
  }, [desktopUpdateRestarting, desktopUpdateFailure, openReleaseNotes]);
  const restartToUpdate = (updateVersion: string) => {
    topbarPress.current = true;
    void askDesktopUpdateRestart(updateVersion);
  };
  const { paused, pauseGate } = pause;
  const t = useT();
  const { blockedSaid, watchSaid, incidentSaid } = announcements;
  const { notifySaid } = notify;
  return (
    /* Three groups now, not two, and this is the observation one.
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
       both neighbours' widths, so the stream pill would slide sideways
       every time something after it gained a digit — and a status light
       that has to be noticed cannot be a moving target. Everything ahead
       of it here (the logo, the wordmark, the version chip) has bounded
       width, so on the left it is an anchor instead. */
    <>
    <div className="readout">
      <div className="brand">
        {/* The kit's small mark, decorative: the <h1> beside it is the name.
            Two files, one per theme, and the sheet shows the one the theme
            asks for (the theme is a stored choice, not a media query). */}
        <img className="logo logo-on-dark" src={MARK_SMALL_SRC} width={19} height={16} alt="" />
        <img className="logo logo-on-light" src={MARK_SMALL_ON_LIGHT_SRC} width={19} height={16} alt="" />
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
      </div>
      {/* The three counts (V4's Figma, Top bar), 8 apart, right after the
          wordmark: sessions waiting on you (outlined, and the door to the
          queue popover), working, done. Always drawn; the figures are the
          sessions' own words (cardState). On a phone only the waiting one
          stays, and only while something waits (topbar.css). */}
      <div className="counts">
        <WaitingStat waitingSessions={waitingSessions} waitingCursorRef={waitingCursorRef} focusSession={focusSession} now={now} />
        <CountPill kind="working" count={counts.working} glyph={<StateMark kind="live" size={14} />} word={WORKING_WORD} />
        <CountPill kind="done" count={counts.done} glyph={<StateMark kind="done" size={14} />} word={DONE_WORD} />
      </div>
      {/* NOT a live region, and #372 is the issue that took the
          `role="status"` off it. Nothing in this strip is a status
          *message*: it is a permanently visible readout the user can read
          whenever they want one, and every number it has carried moved on
          its own — tokens climbed on every event carrying usage, the cost
          label repriced its `$/h` rate on each frame while something was
          live, and a paused pill counts its queue as events arrive.
          `role="status"` also carries an implicit
          `aria-atomic="true"`, so what a screen reader actually did with
          each of those increments was re-read the WHOLE strip rather than
          the one number that moved. That is a property of the role, not of
          how many numbers are in the row: it held when the row also carried
          the sessions, agents and events counters and the month's usage, and
          it holds for the pill alone. Continuous speech of numbers nobody asked for is how
          a page teaches its user to turn the screen reader off, and it was
          being spent on the least urgent thing in the topbar.
          WCAG 4.1.3 was satisfied here — for the wrong content. The alarm
          that is worth a live region has one of its own, below. */}
      <StatusStrip live={live} paused={paused} pauseGate={pauseGate} />
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
      {/* A provider's incident, said when it begins and when it ends (#1311)
          — use-live-announcements.ts. Mounted always, for the reason above. */}
      <div className="vis-hidden" role="status" aria-atomic="true">{incidentSaid}</div>
      {/* What the browser answered the notification prompt (#1763). The chip
          at the end of the group says it on screen, and comes and goes; this
          is mounted always, for the reason above, and says the same. */}
      <div className="vis-hidden" role="status" aria-atomic="true">{notifySaidSentence(notifySaid, t)}</div>
      {/* The asks run's sentences — "paycore resumed.", "No more asks." —
          beside the alarm they follow up on. Mounted from the moment the
          terminal flag is known to be on, which is before any run can start,
          for the reason above; absent altogether while it is off. */}
      {asksSaid != null && <div className="vis-hidden" role="status" aria-atomic="true">{asksSaid}</div>}
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
      {/* A provider's own incident, when its status page reports one (#1311)
          — components/ProviderIncidents.tsx. Nothing at all while the
          providers are fine, or while their pages cannot be reached.
          BEFORE the blocked count, and that is the order of what gives. The
          readout packs to its END when it runs out of room, so its last child
          is the last thing clipped — which has to be the alarm, the reason the
          deck is open. After it, a pair of incident chips pushed the count
          off the bar at 700px. An outage upstream is context for a
          diagnosis; the count is the thing the user acts on. The names of
          who is waiting come after the count, outside this group, and fold
          before any of it (WaitingNames). */}
      <IncidentChips incidents={incidents} />
      {/* The count of sessions blocked on you is the first pill above, in
          .counts. */}
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
          is allowed to touch. A status rather than an alert: this is the
          outcome of something they just did, not an interruption — and it is
          spoken by the always-mounted region above, not by this chip. */}
      {notifySaid && <NotifySaid notifySaid={notifySaid} />}
    </div>
    {/* The END group (V4's Figma): the version chip only when there is
        something to say, then whatever App hands in — the Layout switch,
        Search, Feedback — 8 apart, never clipped. */}
    <div className="tb-end">
      <ChipPresence show={versionChipNeeded({ readyAppUpdate, notice })}>
        <span className="v-group">
          <VersionChip
            readyAppUpdate={readyAppUpdate} notice={notice} noticeOpen={noticeOpen}
            chipVersion={chipVersion}
            openReleaseNotes={openReleaseNotes} showNotice={showNotice}
            restartToUpdate={restartToUpdate} updateRestarting={desktopUpdateRestarting}
          />
        </span>
      </ChipPresence>
      {children}
    </div>
    </>
  );
}
