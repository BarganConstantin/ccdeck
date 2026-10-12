// The topbar's observation group, and the readouts in it: the status strip (the
// stream's pill), the count of sessions blocked on you and the queue that names
// them, and what the browser answered when notifications were asked for.
//
// Moved out of App.tsx's markup unchanged: the readouts first, and then the
// group itself (ReadoutGroup, at the end) — the wordmark, the version chip, the
// live regions that speak for these (which have to be mounted whether or not
// these are, #372) and the reasons each sits where it does. App.tsx hands the
// group each hook's return whole, and it is taken apart there under the names
// the markup already used.
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import type { BlockedSession } from "../ambient-counts";
import { MARK_SMALL_ON_LIGHT_SRC, MARK_SMALL_SRC, PRODUCT } from "../brand";
import { statusPill } from "../status-pill";
import type { useDesktopUpdate } from "../use-desktop-update";
import type { useLiveAnnouncements } from "../use-live-announcements";
import type { useOsNotifications } from "../use-os-notifications";
import type { PauseControls } from "../use-pause-gate";
import type { useVersionCheck } from "../use-version-check";
import type { useWelcomeAndNotes } from "../use-welcome-and-notes";
import type { Incident } from "../provider-status";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { namesThatFit, queueEntryDetail, queueEntryName, queueName, waitWhat } from "../waiting-queue";
import { IncidentChips } from "./ProviderIncidents";
import { elapsedShort } from "./SessionList";
import { useHint } from "./use-hint";
import VersionChip from "./VersionChip";

export function StatusStrip({ live, paused, pauseGate }: {
  /** Whether the event stream is connected right now. */
  live: boolean;
  paused: boolean;
  pauseGate: PauseControls["pauseGate"];
}) {
  const singleKeys = useSingleKeyShortcuts();
  return (
    <span className="status">
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
      {(() => {
        const pill = statusPill({
          connected: live, paused,
          held: pauseGate.size, dropped: pauseGate.dropped, singleKeys,
        });
        // Nothing at rest (#719). The ghost above explains why the box
        // measures its own worst case; this is the case where the box
        // itself is not earned. The strip is then empty, and `:empty` takes
        // it out of the row with the 24px gap before it, so the readout
        // closes up without anything shifting on its own — the tone only
        // ever changes because Space was pressed or the stream died.
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
    </span>
  );
}

/** One queued session in a line, for a hint that lists the ones the bar has
 *  no room to name: "web-api — Bash · 6m". */
function queueLine(w: BlockedSession, now: number): string {
  return `${w.label} — ${waitWhat(w.waiting)} · ${elapsedShort(w.waiting.since, undefined, now)}`;
}

/** Up to six of them, and how many more past those. */
function queueLines(sessions: BlockedSession[], now: number): string {
  const lines = sessions.slice(0, 6).map(w => queueLine(w, now));
  if (sessions.length > 6) lines.push(`and ${sessions.length - 6} more`);
  return lines.join("\n");
}

/** The count of sessions blocked on you, in amber: the bar's one alarm, and
 *  the last thing on it ever lost to a narrow window (see .readout). A click
 *  goes to the one that has waited longest, and so does W, which then walks
 *  the rest (#825). Its hint names the key, and lists the sessions the queue
 *  beside it has no room to name — all of them, where the queue has folded. */
export function WaitingStat({ waitingSessions, waitingCursorRef, focusSession, now, named }: {
  /** The sessions blocked on you, longest-stuck first; the caller shows this only when there is one. */
  waitingSessions: BlockedSession[];
  /** Where W starts from, so a click here and the next W press agree (#825). */
  waitingCursorRef: MutableRefObject<string | null>;
  focusSession: (sessionId: string) => void;
  now: number;
  /** How many of them the queue beside the count names. */
  named: number;
}) {
  const singleKeys = useSingleKeyShortcuts();
  const hint = useHint("below");
  const unnamed = waitingSessions.slice(named);
  const count = waitingSessions.length;
  return (
    <>
      <button
        type="button"
        className="waiting-stat"
        onClick={() => {
          // The same place W starts, so the next press moves on (#825).
          waitingCursorRef.current = waitingSessions[0].id;
          focusSession(waitingSessions[0].id);
        }}
        aria-label={`${count} session${count === 1 ? "" : "s"} waiting for you`}
        aria-keyshortcuts={singleKeys ? "W" : undefined}
        {...hint.bind({
          label: "Go to the longest wait",
          keys: singleKeys ? "W" : undefined,
          detail: unnamed.length > 0 ? queueLines(unnamed, now) : undefined,
        })}
      >
        <span className="ap-pulse" aria-hidden />
        <b>{count}</b> waiting
      </button>
      {hint.node}
    </>
  );
}

/** One queued session's words: its name, how long it has waited, and what on
 *  — the session list row's order, "waiting 6m · Bash", so the two read the
 *  same. The wait is the line's number and stands in the foreground; what it
 *  is on is the annotation (DESIGN.md, duration beats description). */
function QueueEntryWords({ w, now }: { w: BlockedSession; now: number }) {
  return (
    <>
      <span className="we-name">{queueName(w.label)}</span>
      <span className="we-wait">{elapsedShort(w.waiting.since, undefined, now)}</span>
      <span className="we-what">· {waitWhat(w.waiting)}</span>
    </>
  );
}

/** How far the queue's first name stands from the count: the readout's own
 *  12px, where the bar's 24 would set the names apart as another group. The
 *  queue box takes the bar's 24px gap back with a margin, so with nothing in
 *  it the bar is the width it was without it. */
export const QUEUE_LEAD_PX = 12;
/** How recently a session must have started waiting for its name to arrive
 *  with an entrance rather than simply be there. */
const FRESH_MS = 2_000;
/** The space between two names, `.wait-list`'s gap. A number here rather than
 *  a read of the style, which the render path does not make (#612). */
export const QUEUE_GAP_PX = 4;

/**
 * WHO IS WAITING, BY NAME (the bar's one job, spelled out). With the panel
 * toggles gone to the window's edges (EdgeRails.tsx), the room the controls
 * and the month's phrase held goes to the sessions the count counts: each by
 * name, what it is stopped on and how long, longest wait first — a press, or
 * Enter, from its card.
 *
 * AS MANY AS FIT, THEN "+N MORE". The box takes whatever width the bar has
 * left (`flex: 1 1 0`) and nothing it does not, and every name is measured in
 * a hidden ruler at the width it would draw, so the queue never clips a name
 * in half: it names the ones that fit whole and says how many more there are.
 * "+N more" opens the session list, whose top rows are the same sessions in the
 * same order, and moves focus there.
 *
 * NAMES FOLD BEFORE THE COUNT. A box that only takes what is left is the first
 * thing a narrowing bar takes back, so the names go to nothing while the
 * readout beside them is still whole; under that, the readout gives from the
 * left as it always has and the count is the last thing on the bar. On a
 * phone the bar holds the count alone and this is not drawn.
 *
 * NOTHING WAITING IS NOTHING HERE. No "Nothing waiting on you": the deck cannot
 * see a Codex session's block (README, Blocked on you), so on a machine running
 * Codex that sentence would be a claim it cannot back, and on one running
 * Claude Code alone the absent amber count already says it.
 *
 * QUIET FOR A SCREEN READER. The count's region speaks when a session starts
 * waiting (block-announce.ts); the names are buttons with whole names and no
 * region of their own, so nothing is said twice.
 *
 * Neutral text: the amber is the count's alone, and a row of amber names would
 * be a row of alarms.
 */
export function WaitingNames({ waitingSessions, waitingCursorRef, focusSession, now, onFit, onMore }: {
  /** The sessions blocked on you, longest-stuck first. */
  waitingSessions: BlockedSession[];
  /** Where W starts from, so a click on a name and the next W press agree (#825). */
  waitingCursorRef: MutableRefObject<string | null>;
  focusSession: (sessionId: string) => void;
  now: number;
  /** Told how many names fit, for the count's hint. */
  onFit: (named: number) => void;
  /** Opens the session list, where every one of them is, and focuses it. */
  onMore: () => void;
}) {
  const singleKeys = useSingleKeyShortcuts();
  const hint = useHint("below");
  const boxRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState(0);
  const ids = waitingSessions.map(w => w.id).join("\n");

  useLayoutEffect(() => {
    const box = boxRef.current;
    const ruler = rulerRef.current;
    if (!box || !ruler) return;
    const measure = () => {
      const marks = Array.from(ruler.children) as HTMLElement[];
      const moreMark = marks.pop();
      setFit(namesThatFit({
        widths: marks.map(m => m.getBoundingClientRect().width),
        room: box.clientWidth - QUEUE_LEAD_PX,
        gap: QUEUE_GAP_PX,
        more: moreMark?.getBoundingClientRect().width ?? 0,
      }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(measure);
    seen.observe(box);
    seen.observe(ruler);
    return () => seen.disconnect();
  }, [ids]);

  const named = waitingSessions.slice(0, fit);
  const rest = waitingSessions.slice(fit);
  useEffect(() => { onFit(named.length); }, [named.length, onFit]);

  const go = (id: string) => {
    waitingCursorRef.current = id;
    focusSession(id);
  };
  return (
    <div className="wait-names" ref={boxRef}>
      <ul className="wait-list">
        {named.map(w => (
          <li key={w.id} data-fresh={now - w.waiting.since < FRESH_MS || undefined}>
            <button
              type="button"
              className="wait-entry"
              onClick={() => go(w.id)}
              aria-label={queueEntryName(w.label, w.waiting, now - w.waiting.since)}
              {...hint.bind({ label: w.label, detail: queueEntryDetail(w.waiting) })}
            >
              <QueueEntryWords w={w} now={now} />
            </button>
          </li>
        ))}
        {named.length > 0 && rest.length > 0 && (
          <li>
            <button
              type="button"
              className="wait-more"
              onClick={onMore}
              aria-label={`${rest.length} more waiting; open the session list`}
              aria-keyshortcuts={singleKeys ? "L" : undefined}
              {...hint.bind({
                label: "Open the session list",
                keys: singleKeys ? "L" : undefined,
                detail: queueLines(rest, now),
              })}
            >+{rest.length} more</button>
          </li>
        )}
      </ul>
      {/* Every name at the width it would draw, and "+N more" at its widest,
          laid out where nothing sees them, so the queue knows what fits
          before it draws a name it would have to cut. */}
      {waitingSessions.length > 0 && <span className="wait-ruler" ref={rulerRef} aria-hidden>
        {waitingSessions.map(w => (
          <span key={w.id} className="wait-entry"><QueueEntryWords w={w} now={now} /></span>
        ))}
        <span className="wait-more">+{waitingSessions.length} more</span>
      </span>}
      {hint.node}
    </div>
  );
}

/** What each answer means, for the chip's title and the region's sentence. */
const NOTIFY_SAID_MEANS = {
  on: "The deck will raise a system notification when a session blocks on you and this tab is in the background",
  blocked: "Notifications are blocked for this page. Only your browser can undo that — its site settings for this address",
} as const;

/** What the always-mounted region says about the browser's answer, or nothing
 *  (#1763). The whole of it rather than the chip's two words: what they mean
 *  is on the chip only as a hover title, which a screen reader cannot be
 *  relied on to reach — and for a refusal, the remedy is that half. */
export function notifySaidSentence(notifySaid: "on" | "blocked" | null): string {
  if (notifySaid === "on") return `Notifications on. ${NOTIFY_SAID_MEANS.on}.`;
  if (notifySaid === "blocked") return `${NOTIFY_SAID_MEANS.blocked}.`;
  return "";
}

export function NotifySaid({ notifySaid }: { notifySaid: "on" | "blocked" }) {
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
      title={NOTIFY_SAID_MEANS[notifySaid]}
    >{notifySaid === "on" ? "notifications on" : "notifications blocked"}</span>
  );
}

export function ReadoutGroup({
  versionCheck, welcome, desktopUpdate, pause, announcements, notify,
  waitingSessions, waitingCursorRef, focusSession, live, now, incidents, queueNamed,
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
  /** How many of the waiting sessions the queue beside the count names. */
  queueNamed: number;
}) {
  const { version, notice, noticeOpen, showNotice, versionChecking, loadVersion } = versionCheck;
  const { chipVersion, openReleaseNotes } = welcome;
  const { readyAppUpdate } = desktopUpdate;
  const { paused, pauseGate } = pause;
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
      <div className="vis-hidden" role="status" aria-atomic="true">{notifySaidSentence(notifySaid)}</div>
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
      {waitingSessions.length > 0 && (
        <WaitingStat waitingSessions={waitingSessions} waitingCursorRef={waitingCursorRef} focusSession={focusSession}
          now={now} named={queueNamed} />
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
          is allowed to touch. A status rather than an alert: this is the
          outcome of something they just did, not an interruption — and it is
          spoken by the always-mounted region above, not by this chip. */}
      {notifySaid && <NotifySaid notifySaid={notifySaid} />}
    </div>
  );
}
