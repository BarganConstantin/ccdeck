// Browser Watch's snapshot, and the three things the dialog does with it: read
// it — on open, every ten seconds, and on the ↻ — change a setting, and dismiss
// an episode.
//
// Lifted out of BrowserWatchModal.tsx unchanged. The server owns every part of
// this: the settings file is what the watch runs on and the dismissals are what
// the next poll rebuilds the list from, so the dialog keeps no copy of either
// and only renders what the last read said. What the dialog does keep — which
// disclosure is open, which episode is expanded — is its own business and
// stays in it.
import { useCallback, useEffect, useRef, useState } from "react";

import type { WatchEpisode, WatchSettings, WatchSnapshot } from "./browser-watch-model";
import { selfPressAccepted } from "./panel-press";

export interface BrowserWatch {
  /** The last snapshot that answered, or null until the first one does. */
  snap: WatchSnapshot | null;
  /** Why the last READ failed, cleared by the next one that succeeds. */
  error: string | null;
  /** Why the last WRITE failed (#803), which no read may clear. */
  writeError: string | null;
  setWriteError: (message: string | null) => void;
  /** A read is out — the ↻ shows `…` while one is. */
  busy: boolean;
  /** What the quiet select shows: the stored value, or the one just picked. */
  quiet: number | null;
  setQuiet: (minutes: number | null) => void;
  /** A setting is on its way to the server. */
  saving: boolean;
  /** Read the snapshot; `true` asks the server to re-read every profile. */
  load: (refresh: boolean) => Promise<void>;
  dismiss: (e: WatchEpisode) => Promise<void>;
  save: (patch: Partial<WatchSettings>) => Promise<void>;
}

/** @param onWatching told whether the watch is on after every read, so the
 *    topbar's eye follows the switch at once rather than on its own poll. */
export function useBrowserWatch(onWatching: (on: boolean) => void): BrowserWatch {
  const [snap, setSnap] = useState<WatchSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* A FAILED WRITE IS NOT A FAILED READ (#803). Both used to land in `error`,
     which the render captioned "Could not read" and the ten-second poll cleared
     on its next success — so pressing the switch and having it fail showed a
     sentence about reading history, and ten seconds later showed nothing at
     all, with the setting still where it was. A write gets its own slot, its
     own wording, and no poll may touch it: it stands until the user dismisses
     it or a later write succeeds. */
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /* Null until the first snapshot answers. The stored value is the truth and
     this control only displays it — seeded from a literal, it showed 15 to
     somebody who had chosen 1, and then sent that 15 back on every poll. */
  const [quiet, setQuiet] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  /* Read by `load`, which must not take `saving` as a dependency: it would
     rebuild the callback on every save and restart both the mount fetch and the
     ten-second interval that are keyed on it. */
  const savingRef = useRef(false);

  const load = useCallback(async (refresh: boolean) => {
    /* #620 leaves the pressed control enabled, so the HANDLER is what refuses
       the second press. Read off a ref rather than `busy`: the state a handler
       closed over is a render old, and the second press lands before the next
       one. Only a forced read is guarded — the ten-second poll is not somebody
       pressing anything, and must not be turned away by a press still out. */
    if (refresh && !selfPressAccepted(busyRef.current)) return;
    busyRef.current = refresh;
    setBusy(true);
    try {
      /* NO `?quiet=`. The server treats that parameter as an override of the
         stored setting, and the panel was sending its own un-seeded default on
         every poll — so a person who chose a 1-minute gate had their episodes
         classified against 15 minutes, silently, for as long as the panel was
         open. The select saves on change, so the store is already the truth by
         the time the next poll goes out; there was never anything for the
         override to add. */
      const r = await fetch(`/api/browser-watch${refresh ? "?refresh=1" : ""}`);
      if (!r.ok) throw new Error(`the deck answered ${r.status}`);
      const next = await r.json();
      setSnap(next);
      // Follow the store, except while a save is in flight — the optimistic
      // value the user just picked must not be overwritten by a snapshot that
      // was already on its way out when they picked it.
      //
      // THE IN-FLIGHT CONDITION THE COMMENT ALWAYS CLAIMED (#803). It read
      // `q === null ? … : q`, which only ever writes on the transition out of
      // null — so after the first snapshot the local value won forever, while
      // the paragraph two hundred pixels above rendered
      // `snap.settings.quietMinutes` straight from the server. Change it from a
      // second tab, or while the deck is briefly unreachable, and one dialog
      // stated two different settings with nothing able to correct it.
      if (!savingRef.current) setQuiet(next?.settings?.quietMinutes ?? 15);
      onWatching(next?.settings?.enabled === true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [onWatching]);

  useEffect(() => { void load(false); }, [load]);

  // LIVE WHILE THE LOG IS OPEN, AND ONLY THEN. The Log answers "is this thing
  // working", and an answer that stops updating the moment you look at it
  // answers the opposite. Ten seconds is fast enough to read as live and far
  // above what it costs: the server serves from a cache keyed on each History
  // file's mtime, so a browser nobody is using is one `stat` per profile.
  //
  // One view now, so no condition: the feed and the findings are on screen
  // together and both want the same poll.
  useEffect(() => {
    const t = setInterval(() => { void load(false); }, 10_000);
    return () => clearInterval(t);
  }, [load]);

  /** Mark an episode reviewed, so it leaves the list and stays gone.
   *
   *  The server owns it. A client that hid the row locally would show it again
   *  on the very next poll, because the panel rebuilds episodes from the
   *  browser's history rather than from its own memory — which is the same
   *  reason the server stores a dismissal instead of deleting a row.
   *
   *  Reloads in `finally`: if the write failed, the row coming back is the
   *  honest report of that, and a row that vanished on a failed write would be
   *  a lie the next poll would correct anyway. */
  const dismiss = useCallback(async (e: WatchEpisode) => {
    try {
      await fetch("/api/browser-watch/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: e.host, startMs: e.startMs }),
      });
    } finally {
      await load(false);
    }
  }, [load]);
  /** Change a setting on the server, which owns it: the file on disk is what
   *  the watch runs on, and a client that kept its own copy would disagree with
   *  it the moment a second tab was open. */
  const save = useCallback(async (patch: Partial<WatchSettings>) => {
    savingRef.current = true;
    setSaving(true);
    try {
      const r = await fetch("/api/browser-watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`the deck answered ${r.status}`);
      await load(false);
      setWriteError(null);
    } catch (e) {
      setWriteError(e instanceof Error ? e.message : String(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [load]);

  return { snap, error, writeError, setWriteError, busy, quiet, setQuiet, saving, load, dismiss, save };
}
