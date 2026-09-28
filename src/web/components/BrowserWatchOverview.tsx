// Browser Watch's "Activity overview": the radar, what programs opened in each
// watched browser, when the deck last looked, and the quiet gate's countdown.
//
// Lifted out of BrowserWatchModal.tsx unchanged, with the one-second clock that
// only this section reads: the countdown and "Last checked" are the two things
// in the dialog that move while nothing is fetched, so the tick re-renders this
// section rather than the whole dialog.
import { useEffect, useState } from "react";

import WatchRadar from "./WatchRadar";
import type { Palette } from "../palette";
import {
  agoLabel, armsIn, untilLabel, visitTotals,
  type WatchBrowser, type WatchSnapshot,
} from "../browser-watch-model";

export default function BrowserWatchOverview({
  snap,
  watching,
  palette,
}: {
  snap: WatchSnapshot;
  /** The dialog's one list of watched browsers (see watchedBrowsers): the
   *  radar puts blip i at angle i/n, and the profile rows beside it name the
   *  same i. */
  watching: WatchBrowser[];
  /** Handed down rather than read here — see WatchRadar. */
  palette: Palette;
}) {
  const [showKey, setKey] = useState(false);
  // Its own clock, so the countdown moves every second rather than jumping
  // whenever the panel happens to refetch.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  /** The quiet gate, if it is currently closed. It lives beside the numbers it
   *  decides rather than in the toolbar, where it was a third idea competing
   *  with the mode and its count. */
  const gate = armsIn(snap.coverage.lastHumanMs, snap.coverage.quietMs, tick);

  return (
    <section className="bw-sec">
      <h4 className="bw-sec-head">
        Activity overview
        {/* Progressive disclosure. The three-line explanation of
            what the disc's marks mean was permanent furniture in a
            column that has real work to do — and it is read once,
            by one reader, on one day. Behind a press, and the press
            is a real control with a real name rather than an icon
            that has to be guessed at. */}
        <button
          className="bw-help"
          onClick={() => setKey(k => !k)}
          aria-expanded={showKey}
          aria-label="What the sweep and the dots mean"
        >?</button>
      </h4>

      {/* The disc is a SIGNATURE, not a chart. At 176px it was the
          largest thing on the panel and most of what it said —
          which browsers, running or not — was already in Watched
          Profiles below it and in the feed beside it. What it alone
          gives is the glance: something is sweeping, so something
          is alive. That is worth 88px, not 176. */}
      <div className="bw-glance">
        <WatchRadar
          browsers={watching.map(b => ({
            key: b.key,
            name: b.name,
            running: b.running,
            lastReadMs: snap.profiles.find(p => p.browser === b.key)?.lastWrittenMs ?? null,
          }))}
          findings={snap.episodes.slice(0, 6).map(e => ({ browser: e.browser ?? null, atMs: e.endMs }))}
          watching={snap.settings.enabled}
          palette={palette}
        />
        <ul className="bw-counts">
          {visitTotals(watching, snap.profiles).map(t => (
            <li key={t.key}>
              <span className="bw-count-n">{t.visits.toLocaleString("en-US")}</span>
              <span className="bw-count-of">{t.name}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Two short lines by design rather than one long one that
          wraps wherever the column happens to end. The first says
          what the figures ARE — rows in the browser's own history,
          newer than this deck's start, not visits a person made and
          not findings. The second is the only part that moves. */}
      <p className="bw-since">Pages a program opened, since this deck started</p>
      {/* THE DECK'S OWN CLOCK, NOT THE BROWSER'S. This read
          `lastWrittenMs`, which is the History file's mtime — when
          the BROWSER last wrote, not when the watch last looked. On
          a machine nobody is browsing it would climb past an hour
          while the deck kept checking every ten seconds, and the
          panel would read as though the watch had stopped. */}
      {snap.coverage.checkedMs > 0 && (
        <p className="bw-since">
          Last checked {agoLabel(snap.coverage.checkedMs, tick)}
          {snap.coverage.checks > 0 && (
            <> · {snap.coverage.checks.toLocaleString("en-US")}{" "}
            {snap.coverage.checks === 1 ? "check" : "checks"}</>
          )}
        </p>
      )}
      {gate !== null && (
        /* The quiet gate, where it belongs: beside the numbers it
           decides. In the toolbar it was a third idea competing
           with the mode and its count. */
        <p className="bw-gate">You are browsing — a program page would count in {untilLabel(gate)}</p>
      )}

      {showKey && (
        <dl className="bw-key">
          <dt>Sweep</dt><dd>one poll of every watched profile</dd>
          <dt>Dot</dt><dd>a browser, further out the longer since it last wrote history</dd>
          <dt>Ring</dt><dd>a finding, leaving the browser it came from</dd>
        </dl>
      )}
    </section>
  );
}
