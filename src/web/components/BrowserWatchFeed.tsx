// Browser Watch's live activity: the deck's own feed of what it saw each time
// it looked at a profile, newest first, with no addresses in it.
//
// Lifted out of BrowserWatchModal.tsx unchanged.
import type { WatchSnapshot } from "../browser-watch-model";

export default function BrowserWatchFeed({ snap }: { snap: WatchSnapshot }) {
  return (
    <section className="bw-feed">
      <h4 className="bw-sec-head bw-head-row">
        Live activity
        {/* `entries` counted log rows and collided with the
            overview's "history entries", which are a different thing
            entirely. These rows are events — a browser adding
            history, a read failing, the reader changing a setting —
            and the successful checks that found nothing are no
            longer among them. */}
        <span className="bw-feed-count">
          {snap.log.length} {snap.log.length === 1 ? "event" : "events"}
        </span>
      </h4>
      {/* WHY THESE ROWS HAVE NO ADDRESSES, said once. `+3 entries`
          is a number about the reader's OWN browsing, and the panel
          was never explaining why it would not say more — which
          reads as a gap rather than as the deliberate line it is.
          Only a finding gets its addresses written down; ordinary
          pages are counted to run the rule and never kept. */}
      <p className="bw-since bw-feed-note">
        Pages you opened yourself — counted to run the rule, never written down.
        Addresses appear under Findings, and only for pages a program opened.
      </p>
      <div className="bw-log" aria-live="polite" aria-relevant="additions">
        {snap.log.length === 0 ? (
          <p className="bw-note">The deck writes a line here each time it looks at a profile.</p>
        ) : snap.log.map(l => (
          /* Keyed on what the line SAYS, not where it sits: the log is
             newest-first, so an index in the key remounts the whole
             transcript and the arrival animation fires on all sixteen
             lines instead of the one that is new. */
          <div
            className={`bw-log-line ${l.level}${l.parts ? "" : " sys"}`}
            key={`${l.atMs}-${l.level}-${l.text}`}
          >
            {/* 24-hour and not the reader's locale: an en-US clock
                renders "06:28:55 PM", four characters wider than the
                column, and a log is 24-hour everywhere anyway. */}
            <span className="bw-log-time">
              {new Date(l.atMs).toLocaleTimeString("en-GB", { hour12: false })}
            </span>
            {l.parts ? (
              <>
                <span className="bw-log-browser">{l.parts.browser}</span>
                <span className="bw-log-profile" title={l.parts.profile}>{l.parts.profile}</span>
                <span className="bw-log-value">
                  {l.parts.value}
                  {l.parts.flagged > 0 && (
                    <span className="bw-log-flag"> · {l.parts.flagged} flagged</span>
                  )}
                </span>
              </>
            ) : (
              <span className="bw-log-sys">{l.text}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
