// The Browser Watch badge on the topbar: what it counts, the slow poll behind it,
// and the moment the reader last looked.
//
// Lifted out of App.tsx's `Inner`. The dialog's open state is not here, because
// which modal is showing is use-dialogs.ts's business; this is only the number on
// the eye and what it takes to keep that number honest.
//
// `markWatchSeen` replaces two lines the dialog's handler in App.tsx used to run
// back to back — set the timestamp, then write it through to storage. Split like
// that, the second was a convention: forget it and the badge relights on every
// reload. Named here, both happen or neither does, and the timestamp's setter and
// the episode list are private.
import { useCallback, useEffect, useMemo, useState } from "react";

import { SEEN_KEY, unseenEpisodes } from "./browser-watch-seen";
import type { WatchEpisode } from "./browser-watch-model";
import { readStored, writeStored } from "./storage";

export interface BrowserWatchBadge {
  /** Whether the watch is switched on, as of the last poll or the dialog's switch. */
  watchOn: boolean;
  /** For the dialog, which owns the switch and reports it here at once rather
   *  than leaving the eye lit for up to one poll. */
  setWatchOn: (on: boolean) => void;
  /** Episodes nobody has looked at yet — the number on the badge. */
  watchUnseen: number;
  /** The reader has looked, as of `ms`: remembered in state and in storage. */
  markWatchSeen: (ms: number) => void;
}

export function useBrowserWatchBadge(): BrowserWatchBadge {
  /** Episodes the reader has not looked at yet, and the moment they last did.
   *  The badge is the whole reason the topbar can afford another control: at
   *  rest this button is an outline like the five beside it, and it only
   *  acquires a number when something happened that nobody has read. #720 took
   *  a resting pill OUT of this bar for saying nothing; a second one that said
   *  "no findings" all day would be the same mistake with a different icon. */
  const [watchSeenMs, setWatchSeenMs] = useState(() => Number(readStored(SEEN_KEY)) || 0);
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

  const watchUnseen = useMemo(
    () => unseenEpisodes(watchEpisodes, watchSeenMs).length,
    [watchEpisodes, watchSeenMs],
  );

  const markWatchSeen = useCallback((ms: number) => {
    setWatchSeenMs(ms);
    writeStored(SEEN_KEY, String(ms));
  }, []);

  return { watchOn, setWatchOn, watchUnseen, markWatchSeen };
}
