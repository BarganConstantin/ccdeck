// Browser Watch's findings: what a program opened while nobody was browsing,
// one card per episode, grouped by day, each one expandable to its addresses
// and dismissable.
//
// Lifted out of BrowserWatchModal.tsx unchanged, with the three formatters only
// a card reads and the expanded card, which is this list's own state. Dismiss
// is the dialog's: the server owns what has been reviewed (see useBrowserWatch).
import { useMemo, useState } from "react";

import type { WatchEpisode, WatchSnapshot } from "../browser-watch-model";

/** `17:03 → 17:44`, or a single time when an episode is one page. */
function span(e: WatchEpisode): string {
  // 24-hour, like every other clock in this panel. It was the reader's locale,
  // so on an en-US machine an episode's head read `01:28 PM` directly above its
  // own URL rows reading `13:28` — two clocks in one card, and the reader left
  // to work out they are the same minute.
  const t = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return e.count === 1 || e.endMs - e.startMs < 60_000 ? t(e.startMs) : `${t(e.startMs)} → ${t(e.endMs)}`;
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** "41 minutes", "2 minutes", "" for an instant. The headline of a card is how
 *  long a program was working, which is the part that separates one opened tab
 *  from something that ran for three quarters of an hour. */
function lasted(e: WatchEpisode): string {
  const mins = Math.round((e.endMs - e.startMs) / 60_000);
  return mins < 1 ? "" : `${mins} min`;
}

export default function BrowserWatchFindings({
  snap,
  dismiss,
}: {
  snap: WatchSnapshot;
  /** Mark an episode reviewed, on the server, and read the snapshot again. */
  dismiss: (e: WatchEpisode) => Promise<void>;
}) {
  const [open, setOpen] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const out: { label: string; episodes: WatchEpisode[] }[] = [];
    for (const e of snap.episodes) {
      const label = day(e.startMs);
      const last = out[out.length - 1];
      if (last && last.label === label) last.episodes.push(e);
      else out.push({ label, episodes: [e] });
    }
    return out;
  }, [snap]);

  return (
    <section className="bw-findings">
      <h4 className="bw-sec-head bw-head-row">
        Findings
        {/* No count at zero: the body directly below already says
            "Nothing found yet", and a `none` beside it is the same
            sentence twice in two vocabularies. */}
        {snap.episodes.length > 0 && (
          <span className="bw-feed-count">
            {snap.episodes.length} {snap.episodes.length === 1 ? "episode" : "episodes"}
          </span>
        )}
      </h4>
      <div className="bw-eps">
        {grouped.length === 0 ? (
          <div className="bw-empty">
            <p className="bw-empty-head">Nothing found yet</p>
            <p className="bw-empty-note">
              An episode lands here when a program opens pages in a browser nobody has touched for{" "}
              {snap.settings.quietMinutes}{" "}
              {snap.settings.quietMinutes === 1 ? "minute" : "minutes"}. On most machines that is
              rare, so an empty list is the ordinary result rather than a sign something is wrong.
            </p>
            {!snap.settings.enabled && (
              <p className="bw-empty-note">
                Watching is off, so this shows only what this deck has seen since it started.
                Anything an earlier run recorded comes back when you switch it on.
              </p>
            )}
          </div>
        ) : grouped.map(g => (
          <div className="bw-day" key={g.label}>
            <h4 className="bw-sec-head">{g.label}</h4>
            {g.episodes.map(e => {
              const id = `${e.host}-${e.startMs}`;
              const isOpen = open === id;
              return (
                <div className={`bw-ep${isOpen ? " open" : ""}`} key={id}>
                  {/* A row holding two controls rather than one
                      control holding another: a button inside a
                      button is invalid markup and the inner one is
                      unreachable. The disclosure keeps the whole
                      row it always had; the dismiss sits beside
                      it. */}
                  <div className="bw-ep-row">
                    <button
                      className="bw-ep-head"
                      onClick={() => setOpen(isOpen ? null : id)}
                      aria-expanded={isOpen}
                    >
                      <span className="bw-chev" aria-hidden>{isOpen ? "▾" : "▸"}</span>
                      <span className="bw-ep-host">{e.host}</span>
                      <span className="bw-ep-meta">
                        {span(e)}
                        {lasted(e) && <> · {lasted(e)}</>}
                        {e.provisional && (
                          <>
                            {" · "}
                            <span title="Its quiet window has not closed yet. If somebody used the browser in the minutes after it, it is withdrawn; until then it is not written down and no reaction runs.">
                              provisional
                            </span>
                          </>
                        )}
                      </span>
                      <span className="bw-ep-count">{e.count} {e.count === 1 ? "page" : "pages"}</span>
                    </button>
                    {/* DISMISS, NOT DELETE, and the title says which.
                        The panel rebuilds episodes from the browser's
                        own history every ten seconds, so a row that
                        was merely removed would come straight back;
                        what this records is that the reader has seen
                        it. The log file keeps the addresses either
                        way — a list you can tidy is not the same
                        thing as a record you can trust, and this
                        panel promises the second one. */}
                    <button
                      className="glyph-btn bw-ep-x"
                      onClick={() => void dismiss(e)}
                      aria-label={`Dismiss ${e.host}`}
                      title="Dismiss — it leaves this list for good, and stays in the log file"
                    >×</button>
                  </div>
                  {isOpen && (
                    <ul className="bw-urls">
                      {e.urls.map((u, i) => (
                        <li key={`${u.url}-${u.timeMs}-${i}`}>
                          <span className="bw-url-time">
                            {new Date(u.timeMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}
                          </span>
                          <span className="bw-url">{u.url}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
