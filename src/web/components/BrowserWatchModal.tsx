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
import BrowserWatchSettings from "./BrowserWatchSettings";
import BrowserWatchStatus from "./BrowserWatchStatus";
import RemoteControl from "./RemoteControl";
import type { Palette } from "../palette";
import { selfPressProps } from "../panel-press";
import { watchedBrowsers, watchTrouble } from "../browser-watch-model";
import { useBrowserWatch } from "../use-browser-watch";

/** The moment the reader last had this panel open, so the topbar badge can
 *  count what has appeared since. Per-browser by construction — it is this
 *  reader's own reading position, not a fact about the machine — which is why
 *  it lives in localStorage and not on the server. */
// In a module of their own since #883, so the topbar can count unseen episodes
// without loading this dialog; re-exported for everything that reads them here.
import { SEEN_KEY, unseenEpisodes } from "../browser-watch-seen";
export { SEEN_KEY, unseenEpisodes };

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
            <BrowserWatchSettings
              snap={snap} quiet={quiet} setQuiet={setQuiet} save={save}
              access={access} setAccess={setAccess}
            />
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
            <BrowserWatchStatus snap={snap} saving={saving} save={save} why={why} setWhy={setWhy} />
          )}
        </div>
      </div>
    </div>
  );
}
