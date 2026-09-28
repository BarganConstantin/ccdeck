// What a program drove in this machine's browsers while nobody was browsing,
// and whether the relay that lets a stranger drive them is open.
//
// A dialog rather than a docked panel, and the width is the reason: an episode
// is a list of URLs, the accounts panel is 288px, and a truncated address is
// exactly the thing a person needs to read whole before deciding whether to
// care.
//
// THE VOCABULARY IS LOAD-BEARING. Nothing here says "intrusion". The one
// episode this rule found in 46 days of real history was almost certainly the
// author's own Claude Code session driving a browser he had asked it to drive.
// A panel that cries theft on the first card teaches its reader to close it,
// and then it is worthless on the day it is right. It reports what a program
// did and shows the evidence; the person reading it decides what it was.
import { useEffect, useRef, useState } from "react";
import { useModalDismiss } from "./use-modal-dismiss";
import BrowserWatchFeed from "./BrowserWatchFeed";
import BrowserWatchFindings from "./BrowserWatchFindings";
import BrowserWatchOverview from "./BrowserWatchOverview";
import BrowserWatchProfiles from "./BrowserWatchProfiles";
import RemoteControl from "./RemoteControl";
import type { Palette } from "../palette";
import { selfPressProps } from "../panel-press";
import {
  logBytesLabel, watchedBrowsers, watchTrouble,
  type WatchSettings,
} from "../browser-watch-model";
import { useBrowserWatch } from "../use-browser-watch";

/** The moment the reader last had this panel open, so the topbar badge can
 *  count what has appeared since. Per-browser by construction — it is this
 *  reader's own reading position, not a fact about the machine — which is why
 *  it lives in localStorage and not on the server. */
// In a module of their own since #883, so the topbar can count unseen episodes
// without loading this dialog; re-exported for everything that reads them here.
import { SEEN_KEY, unseenEpisodes } from "../browser-watch-seen";
export { SEEN_KEY, unseenEpisodes };

/**
 * What the bar says about the watch, and which of four things it is saying.
 *
 * The kind exists so the text can cross-fade when the meaning changes without
 * flickering while the countdown counts: `counting` holds for fourteen minutes
 * while its own last characters move every second.
 */
function modeState(
  snap: { settings: { enabled: boolean } },
  saving: boolean,
): { kind: "saving" | "off" | "on"; word: string; detail: string } {
  if (saving) return { kind: "saving", word: "Saving", detail: "" };
  // ONE QUESTION, ONE ANSWER. This carried an episode count as well — "Watching
  // · nothing captured yet" — and the two ideas fought: a reader with visible
  // browser activity in the feed below was being told nothing had been
  // captured, which is true of episodes and reads as false of the panel.
  // Persistence belongs to the footer, which says it in the same noun the
  // Episodes tab uses. This line says whether the watch is running.
  if (!snap.settings.enabled) return { kind: "off", word: "Paused", detail: "nothing new is recorded" };
  return { kind: "on", word: "Watching", detail: "" };
}

/** The two views, in order. Kept as data because the strip's keyboard model is
 *  index arithmetic and a hand-written pair of buttons cannot take part in it. */
/* Activity first, because it is the view that opens and the one that answers
   "is this working". `Log` named the implementation — it sounds like debug
   output, and the question somebody brings to this view is not a question
   about logs. */
/* NO TABS. Two views were never two modes: one of them is the product — what
   a program opened while nobody was browsing — and the other is the evidence
   the machinery is running. They are not peers, and a tab strip claims they
   are. Worse, on an ordinary machine the product's view is EMPTY (findings are
   rare, which the panel says itself) and the diagnostic view is full, so the
   press that reached the thing this panel exists for always led to nothing.
   One column, findings above the feed. */

export default function BrowserWatchModal({
  onClose,
  onSeen,
  onWatching,
  palette,
}: {
  onClose: () => void;
  onSeen: (ms: number) => void;
  /** The topbar keeps its own copy of "is it watching", refreshed on a
   *  five-minute poll. The switch is in here, so without this the eye stays
   *  lit for up to five minutes after it is turned off — the one control whose
   *  whole job is to be true at a glance, lying. */
  onWatching: (on: boolean) => void;
  /** Handed down rather than read here — see WatchRadar. */
  palette: Palette;
}) {
  const dialogRef = useModalDismiss(onClose);
  const { snap, error, writeError, setWriteError, busy, quiet, setQuiet, saving, load, dismiss, save } =
    useBrowserWatch(onWatching);
  const [why, setWhy] = useState(false);
  const [access, setAccess] = useState(false);

  // Reading the panel is what marks it read, and it is recorded on the way out
  // rather than on the way in: a dialog opened and dismissed in the same second
  // still counts, but the badge does not clear before the list has rendered.
  // ON UNMOUNT, WHICH IS WHAT THIS ALWAYS CLAIMED TO BE (#782). The dependency
  // was `[onSeen]`, and App hands a fresh arrow every render while re-rendering
  // every 250ms from its own tick — so the cleanup WAS the 250ms loop. The
  // badge cleared the moment the dialog opened rather than on the way out, any
  // episode the 10s poll added while reading was stamped seen before it was
  // ever badged, and localStorage was written four times a second.
  //
  // A ref for the callback and an empty dependency list, the pattern
  // use-modal-dismiss.ts already uses for `onDismissRef`.
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  useEffect(() => () => onSeenRef.current(Date.now()), []);

  // The snapshot's browsers, split once: the side column's two sections each
  // take their half, and the header counts from the first.
  const watching = watchedBrowsers(snap?.browsers);
  const rest = (snap?.browsers ?? []).filter(b => !(b.installed && b.profiles > 0));
  const trouble = snap ? watchTrouble(snap) : null;
  /** Watched profiles, summed — the header's scope line, which is the shortest
   *  true answer to "how much is this looking at". */
  const profileCount = watching.reduce((n, b) => n + b.profiles, 0);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal bw-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bw-title"
      >
        {/* `modal-tool-id` is an IDENTIFIER slot everywhere else in the deck —
            a truncated tool id, a session id, a version range — and it was
            carrying a twelve-word sentence here. What belongs in it is the
            watch's scope, which is short, true, and happens to be the two
            things a first-time reader wants: how much is being watched, and
            where it goes. The explanation lives in the empty state and in
            "What Browser Watch can access", which is where somebody looks for
            it rather than reads past it. */}
        <header className="modal-head">
          <div className="modal-title">
            <span className="modal-tool-name" id="bw-title">Browser watch</span>
            <span className="modal-tool-id">
              {snap
                ? `${profileCount} ${profileCount === 1 ? "profile" : "profiles"} · local only`
                : "local only"}
            </span>
          </div>
          <div className="modal-actions">
            {/* Two glyphs, one component, which is what every other header in
                the deck is. `…` while it works, so the box does not change
                size mid-press. No `disabled` (#620/#518): a control that
                removes itself on press takes the focus with it, so the handler
                refuses the second press instead. */}
            <button
              className="glyph-btn"
              onClick={() => void load(true)}
              {...selfPressProps(busy)}
              aria-label="Re-read every profile now"
              title="Re-read every profile now"
            >{busy ? "…" : "↻"}</button>
            <button className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <div className="modal-body bw-body">
          {!snap && !error && (
            <div className="bw-loading">
              <span className="bw-loading-bar" aria-hidden />
              <p>Reading each browser&apos;s history. The first look copies the file, which takes a moment.</p>
            </div>
          )}

          {error && (
            <div className="bw-state">
              <div className="bw-row err">
                <span className="bw-dot" aria-hidden />
                <span className="bw-row-label">Could not read</span>
                <span className="bw-row-detail">{error}</span>
              </div>
            </div>
          )}

          {snap && trouble && (
            /* Absent when the ordinary case holds, rather than green. A line
               that reads "everything is fine" on every render is one its reader
               learns to skip, and then it says nothing on the day it changes. */
            <p className={`bw-trouble ${trouble.kind}`} role="status">{trouble.text}</p>
          )}

          {snap && (
            <div className="bw-work">
              <aside className="bw-side">
                <BrowserWatchOverview snap={snap} watching={watching} palette={palette} />

                <BrowserWatchProfiles watching={watching} rest={rest} />

                {snap.relay && <RemoteControl relay={snap.relay} />}
              </aside>

              {/* THE PRODUCT, ABOVE THE EVIDENCE. This was a second tab,
                  which claimed the two were peers. They are not: this is what
                  the panel exists to report, and the feed below is how you can
                  see the machinery running. On an ordinary machine this list is
                  empty — findings are rare, which the panel says itself — so
                  the press that reached it always led to nothing. Now the
                  answer to "has anything been found" needs no press at all. */}
              <div className="bw-main">
                <BrowserWatchFindings snap={snap} dismiss={dismiss} />

                <BrowserWatchFeed snap={snap} />
              </div>
            </div>
          )}

          {snap && why && (
            <div className="bw-settings">
              <label title={
                "A program opening a page counts as a finding only if nobody had touched the browser "
                + "for this long. Shorter catches more and reports more of your own work; longer is quieter."
              }>
                <span>Nobody browsing for</span>
                <select value={quiet ?? snap.settings.quietMinutes} onChange={e => { setQuiet(Number(e.target.value)); void save({ quietMinutes: Number(e.target.value) }); }}>
                  <option value={1}>1 min</option>
                  <option value={5}>5 min</option>
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                  <option value={60}>60 min</option>
                </select>
              </label>

              <label>
                <span>When it finds one</span>
                <select
                  value={snap.settings.reaction}
                  onChange={e => void save({ reaction: e.target.value as WatchSettings["reaction"] })}
                  disabled={!snap.settings.enabled}
                  title={snap.settings.enabled
                    ? "What to do besides writing it down."
                    : "Turn watching on to arm a reaction."}
                >
                  {(snap.reactions ?? ["notify"]).map(r => (
                    <option key={r} value={r}>
                      {r === "notify" ? "notify me"
                        : r === "close-tab" ? "close the tab"
                        : "quit the browser"}
                    </option>
                  ))}
                </select>
              </label>

              <div className="bw-settings-note">
                <p>
                  Chrome marks a navigation that came from an extension or a command rather than from a
                  click. These are the ones that happened while nobody had touched the browser for the
                  time above. <strong>Usually that is your own agent doing what you asked.</strong>
                </p>
                <button className="bw-why" onClick={() => setAccess(a => !a)} aria-expanded={access}>
                  <span className="bw-chev" aria-hidden>{access ? "▾" : "▸"}</span> What Browser Watch can access
                </button>
                {access && (
                  <dl className="bw-access">
                    <dt>Reads</dt>
                    <dd>
                      A copy of each browser&apos;s own history database — the live file is locked while
                      the browser holds it. Only rows newer than the moment this deck started:{" "}
                      {new Date(snap.coverage.startedMs).toLocaleString()}.
                    </dd>
                    <dt>Keeps</dt>
                    <dd>
                      Only while the switch is on, and only the episodes it flagged — never your ordinary
                      browsing. In <code className="bw-path">{snap.coverage.logPath}</code>
                      {typeof snap.coverage.logBytes === "number" ? ` (${logBytesLabel(snap.coverage.logBytes)})` : ""},
                      with every address written in full so you can check it yourself.
                    </dd>
                    <dt>Sends</dt>
                    <dd>
                      Nothing. No part of this reads or writes over the network; the deck serves on
                      127.0.0.1 and this panel talks only to it.
                    </dd>
                    <dt>Never reads</dt>
                    <dd>
                      Anything from before this deck started, cookies, saved passwords, page contents, or
                      any browser profile with no history file.
                    </dd>
                  </dl>
                )}
              </div>
            </div>
          )}

          {writeError && (
            /* BESIDE THE CONTROLS, NOT AT THE TOP (#803). Every write in this
               dialog starts down here — the switch in the footer and the two
               selects in Settings — and a body that scrolls would have put the
               report of the failure off screen above the press that caused it.
               It has a dismiss of its own because nothing else may clear it:
               the poll that used to is a READ succeeding, which says nothing
               about whether the setting was stored. */
            <div className="bw-state bw-write-err" role="alert">
              <div className="bw-row err">
                <span className="bw-dot" aria-hidden />
                <span className="bw-row-label">Could not save that setting</span>
                <span className="bw-row-detail">{writeError} — the switches below show what is stored, not what you pressed.</span>
                <button
                  className="glyph-btn bw-write-err-x"
                  onClick={() => setWriteError(null)}
                  aria-label="Dismiss"
                  title="Dismiss"
                >×</button>
              </div>
            </div>
          )}

          {snap && (
            /* THE CONTROL ZONE. It used to restate "2 of 8 browsers watched ·
               Brave running", which Watched Profiles already says two hundred
               pixels away — three places telling one fact. The left half now
               says the thing that changes with the switch and is said nowhere
               else, and the right half is the switch, labelled. */
            <footer className="bw-status">
              {/* THE STATE SITS BESIDE THE CONTROL THAT CHANGES IT. It had a
                  row of its own holding one word and one link, which is a whole
                  band of the panel spent on two small things — and it put the
                  readout at the top while the switch it describes was at the
                  bottom. Together they are one sentence: what the watch is
                  doing, and the control for it. */}
              <span className={`bw-mode-dot${snap.settings.enabled ? " on" : ""}`} aria-hidden />
              <span className="bw-mode-word" key={modeState(snap, saving).kind}>
                {modeState(snap, saving).word}
              </span>
              {/* THE ONE PLACE PERSISTENCE IS SAID, in the noun the Findings
                  section uses. One concept, one noun, one place. */}
              <span className="bw-status-text">
                {snap.coverage.archived === 0
                  ? (snap.settings.enabled ? "No episodes recorded yet" : "No episodes on disk")
                  : `${snap.coverage.archived} ${snap.coverage.archived === 1 ? "episode" : "episodes"} on disk`}
              </span>
              {/* `htmlFor` forwards the CLICK to a button, which is why the
                  whole label operates the switch — but it does not NAME one:
                  `<label>` names form controls, and a button is not among them.
                  So the switch was announcing itself as "switch, on" with no
                  word for what it switches. `aria-labelledby` points at the
                  same visible text, so the two cannot drift apart. */}
              {/* A GEAR, NOT THE WORD. `settings` spelled out took a control's
                  worth of width for a disclosure nobody opens twice, and the
                  deck already draws icons this way — the topbar's eye is inline
                  SVG at 13px, stroke 1.5, in currentColor. Same drawing, same
                  `.glyph-btn` box as the header's ↻ and ×, and a real
                  accessible name so the picture never has to carry the meaning
                  on its own. */}
              <button
                className={`glyph-btn bw-gear${why ? " on" : ""}`}
                onClick={() => setWhy(w => !w)}
                aria-expanded={why}
                aria-label="Settings"
                title="Settings"
              >
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
                  <circle cx="7" cy="7" r="2.1" />
                  <path d="M7 1.2v1.6M7 11.2v1.6M1.2 7h1.6M11.2 7h1.6M2.9 2.9l1.1 1.1M10 10l1.1 1.1M11.1 2.9L10 4M4 10l-1.1 1.1" />
                </svg>
              </button>
              <label className="bw-switch" htmlFor="bw-enabled">
                <span className="bw-switch-label" id="bw-enabled-label">Watch browser activity</span>
                <button
                  id="bw-enabled"
                  type="button"
                  role="switch"
                  aria-checked={snap.settings.enabled}
                  aria-labelledby="bw-enabled-label"
                  className="switch"
                  onClick={() => void save({ enabled: !snap.settings.enabled })}
                  title={snap.settings.enabled
                    ? "On — every episode it finds is written down, so the list outlives the browsing history being cleared"
                    : "Off — showing only what this deck has seen since it started. Anything an earlier run archived is hidden until you switch back on, and nothing new is kept"}
                >
                  <span className="switch-knob" />
                </button>
              </label>
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}
