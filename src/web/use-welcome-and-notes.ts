// What changed since you last looked (#712), and the four-picture tour that comes
// before it the first time: when each opens, the notes an upgrade holds back until
// the tour is closed, and the version chip's way back to them.
//
// Lifted out of App.tsx's `Inner` together, because they are one sequence rather
// than two features: a first run gets the tour and no changelog, an upgrade that
// has never seen the tour gets the tour first and the notes when it closes, and
// every later upgrade gets the notes alone. `notesAfterTour` is the hand-off
// between the two halves, and it is private now.
//
// The tour's close used to be written inline in the markup — twenty lines inside
// an onClose that persisted "seen" locally and, in the desktop app, to the prefs
// file (#1212), then released any held notes. It is `closeTour` here, verbatim,
// so the markup says what happens rather than doing it. Every setter is private:
// the tour opens through `openTour` and closes through `closeTour`, and the notes
// close through `closeReleaseNotes`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { inDesktopApp } from "./in-app";
// #712. What to show, and what to record as seen, is decided there rather
// than here: it is the one part of this feature that can be wrong, and a
// pure function over what the store said, what is running and what shipped
// is the only shape a DOM-less suite can ask "what would a user upgrading
// 1.42 to 1.48 have been shown?" — or, since #717, "what does somebody who
// has never run this see on the release they just installed?".
import { RELEASE_NOTES, type VersionNotes, decideReleaseNotes, decideWelcome, notesBetween, readSeen, readTourSeen, remembersSeen, seenStore, writeSeen, writeTourSeen } from "./release-notes";
import type { VersionInfo } from "./use-version-check";

export interface WelcomeAndNotesDeps {
  version: VersionInfo | null;
  /** The desktop app's update that is ready to install, which this dialog offers. */
  readyAppUpdate: { version: string } | null;
}

export function useWelcomeAndNotes({ version, readyAppUpdate }: WelcomeAndNotesDeps) {
  /** The four pictures a deck shows the first time it runs in a browser, and
   *  again from the empty canvas's `Take the tour`. */
  const [tourOpen, setTourOpen] = useState(false);
  /** Notes held back while the tour is up, shown when it closes: an upgrade
   *  into the version that introduced the tour gets the pictures first and the
   *  changelog after, once. Null every other time, including a tour opened by
   *  hand from the empty canvas. */
  const notesAfterTour = useRef<{ entries: VersionNotes[]; since: string | null; firstRun: boolean } | null>(null);

  // ── what changed since you last looked (#712) ─────────────────────────────
  // Most releases put nothing here and this stays shut for months at a time.
  // That silence is the feature: v1.44.0 and v1.44.1 shipped on the same day,
  // and a dialog that opens twice a day is one people learn to dismiss unread —
  // and then it is worthless on the release that moved a hook in their own
  // settings.json.
  //
  // One piece of state carries both halves, because "which notes" and "is it
  // open" are never independently true: null is closed.
  const [releaseNotes, setReleaseNotes] = useState<
    { entries: VersionNotes[]; since: string | null; firstRun: boolean } | null
  >(null);
  // This dialog offering the app's verified update IS that version's one
  // notice (#1182), so the app is told and its native sheet does not ask the
  // same question on top of it, or again after it is closed. Once per version
  // per page; the app keeps the memory, on disk, for both surfaces.
  const offeredAppUpdate = releaseNotes && readyAppUpdate ? readyAppUpdate.version : null;
  const toldAppUpdateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!offeredAppUpdate || toldAppUpdateRef.current === offeredAppUpdate) return;
    toldAppUpdateRef.current = offeredAppUpdate;
    fetch("/api/desktop-update/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: offeredAppUpdate }),
    }).catch(() => {});
  }, [offeredAppUpdate]);
  // Decided once per load and then never again, and the ref is not belt and
  // braces. The decision writes the running version to the store, so a second
  // run would normally answer "seen" on its own — but a store that REFUSES the
  // write keeps answering "nothing stored", and without this the same dialog
  // would come back on every /api/version poll for as long as the tab is open.
  // A deck that cannot remember must show the notes at most once, not forever.
  const releaseNotesDecidedRef = useRef(false);
  useEffect(() => {
    if (releaseNotesDecidedRef.current) return;
    const store = seenStore();
    const stored = readSeen(store);
    // The server's running version, never the bundle's __APP_VERSION__: an
    // upgrade replaces dist/web on disk before the process restarts, so this
    // page can be newer than the code answering it, and notes about behaviour
    // that is not live yet are notes about nothing.
    // `remembers` is the half of #717 that is easy to leave out. A first run
    // now announces the release it just installed, and a profile that refuses
    // storage looks like a first run on EVERY load — so without this the same
    // dialog would come back for the rest of the release on exactly the
    // profiles that can least do anything about it.
    const decision = decideReleaseNotes({ stored, running: version?.running ?? null, notes: RELEASE_NOTES, remembers: remembersSeen(store) });
    // Not an answer yet — /api/version has not come back, or came back without
    // a version. Leave the ref down so the next poll gets to decide.
    if (decision.reason === "no-version") return;
    releaseNotesDecidedRef.current = true;
    if (decision.record) writeSeen(store, decision.record);
    // `firstRun` is what keeps the dialog's first line from telling a new
    // install it "was last caught up at" a version it has never run: on this
    // route `stored` is null for a first run and for nothing else, and the
    // sentence for that has to be its own rather than the browse route's.
    // THE TOUR, TO EVERYONE ONCE, AND THE NOTES AFTER IT. A first run gets the
    // pictures and no changelog — #717's reasoning: what changed since a
    // version they never ran is nothing to them, and the notes stay one click
    // away on the version chip. An upgrade that has never seen the tour gets
    // the tour first and the notes when it closes; every later upgrade gets
    // the notes alone. The order and the once are decideWelcome's, and it is
    // pure, so the cases are pinned without a browser.
    //
    // `firstRun: false` is the only value the dialog can carry from here: the
    // welcome left for the tour, so a changelog opened here is always about an
    // upgrade. The welcome sentence in releaseNotesIntro stays for the day a
    // caller wants it back.
    let alive = true;
    const showWelcome = async () => {
      let tourSeen = readTourSeen(store);
      if (inDesktopApp()) {
        // The desktop window's localhost port changes across restarts. The
        // deck prefs file survives that change; localStorage belongs to the
        // current port only. Carry an existing marker into prefs once.
        try {
          const response = await fetch("/api/prefs");
          if (!response.ok) throw new Error("desktop tour preferences unavailable");
          const data = await response.json();
          if (!data?.ok) throw new Error("desktop tour preferences unavailable");
          const persisted = data.prefs?.tourSeen === true;
          if (tourSeen && !persisted) {
            void fetch("/api/prefs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tourSeen: true }),
              keepalive: true,
            }).catch(() => {});
          }
          tourSeen = tourSeen || persisted;
        } catch {
          // If the durable marker cannot be read, do not show a tour that
          // could repeat after every restart. Release notes still work.
          tourSeen = true;
        }
      }
      if (!alive) return;
      const plan = decideWelcome({ tourSeen, decision });
      const notes = decision.show.length ? { entries: decision.show, since: stored, firstRun: false } : null;
      // Opened here, and marked seen only when a person CLOSES it — see the
      // tour's onClose. Marking it on open was the defect: the deck reloads its
      // own tab when the bundle changes, and updates itself while nobody is
      // looking, so the tour opened in tabs nobody was watching, was recorded
      // as seen, and the people it was for never saw it.
      if (plan.tour) setTourOpen(true);
      if (plan.notes === "now") setReleaseNotes(notes);
      else if (plan.notes === "after") notesAfterTour.current = notes;
    };
    void showWelcome();
    return () => { alive = false; };
  }, [version?.running]);
  // Everything this build has to say, for the version chip — which is the way
  // back after the dialog is dismissed, and the only recovery for a profile
  // whose site data was cleared along with the marker above. The bundle's
  // version is the fallback here and only here: the chip's route is a browse,
  // not an announcement, so a deck whose /api/version never answered should
  // still be able to open it rather than lose the feature entirely.
  const chipVersion = version?.running ?? __APP_VERSION__;
  const everyReleaseNote = useMemo(
    () => notesBetween(RELEASE_NOTES, null, chipVersion),
    [chipVersion],
  );
  // The browse route (#715). `since: null` is what makes it a browse: it is not
  // an announcement, so it neither reads nor writes the seen marker, and it is
  // NOT gated on the run being non-empty — a click that opens a dialog saying
  // "nothing to report yet" is a click that answered; a click that does nothing
  // at all is a broken button. The empty run is nearly unreachable in practice,
  // because a release with nothing of its own still has every release before it
  // to show, but the dialog is written for it and the chip therefore does not
  // have to be.
  const openReleaseNotes = useCallback(() => {
    setReleaseNotes({ entries: everyReleaseNote, since: null, firstRun: false });
  }, [everyReleaseNote]);

  const openTour = useCallback(() => setTourOpen(true), []);
  const closeReleaseNotes = useCallback(() => setReleaseNotes(null), []);
  const closeTour = useCallback(() => {
      setTourOpen(false);
      // Seen means a person closed it — Done, ×, Escape or the scrim. A tab
      // that reloaded with it open never got here, so it opens again.
      writeTourSeen(seenStore());
      if (inDesktopApp()) {
        void fetch("/api/prefs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tourSeen: true }),
          keepalive: true,
        }).catch(() => {});
      }
      // The changelog an upgrade was holding back, now that the pictures
      // have been seen. Taken out of the ref first, so a tour opened by
      // hand later never replays it.
      const held = notesAfterTour.current;
      notesAfterTour.current = null;
      if (held) setReleaseNotes(held);
  }, []);

  return { tourOpen, openTour, closeTour, releaseNotes, closeReleaseNotes, chipVersion, openReleaseNotes };
}
