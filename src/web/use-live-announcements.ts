// What the deck says aloud for a screen reader: that a session is waiting on
// you, and that Browser Watch has something unread.
//
// Lifted out of App.tsx's `Inner`. Its opening line used to point at "the two
// lines above", the tab title and favicon effect, which did not come with it; it
// now names what it means. `setWatchSaid` goes out as it is — the Browser Watch
// dialog clears the region with it when the reader has just read the findings,
// before the seen stamp, and that order is components/DeckDialogs.tsx's to keep.
import { useEffect, useState } from "react";

import { blockedAnnouncement, nextAnnouncement } from "./block-announce";
import type { BlockedSession } from "./ambient-counts";

export interface LiveAnnouncementsDeps {
  waitingSessions: BlockedSession[];
  /** Browser Watch findings nobody has looked at yet. */
  watchUnseen: number;
}

export function useLiveAnnouncements({ waitingSessions, watchUnseen }: LiveAnnouncementsDeps) {
  // The same fact the tab title, the favicon and the topbar chip carry, on the
  // one channel that had it from none of them: spoken.
  //
  // A blocked session reached the tab title, the favicon, the amber topbar chip
  // and the card's own row, and every one of those four is a thing you have to
  // look at. #372: the deck's one alarm-worthy event was announced nowhere,
  // while the stat strip beside it was a live region wrapped around a counter
  // that moves on every hook event. Both halves are the same mistake — a live
  // region spent on what changes rather than on what matters — and the second
  // half is the more expensive one, because a region that talks through a tool
  // storm is a region the user switches off before the first real alarm.
  //
  // `blockedAnnouncement` is pure and runs on the render path; `nextAnnouncement`
  // is the reducer that decides whether that sentence is news. Both live in
  // block-announce.ts, where a suite with no DOM can call them — see the file
  // for why the all-clear string is load-bearing and why this is a reducer over
  // committed state rather than a latch advanced during render.
  //
  // The effect depends on the SENTENCE, not on the session list. `waitingSessions`
  // is rebuilt whenever `revision` moves — which is every event AND every sweep,
  // since #536 — so a list-shaped dependency would re-run this through every
  // event of every tool storm, and through the 250ms tick besides, to discover
  // each time that nothing had changed. A string dependency runs it only when
  // the words move, and React's own bail-out on an identical state value means
  // even that costs no render.
  //
  // This said `lastSeq` until #575. The argument was right and the mechanism
  // named was not: `lastSeq` advances on the envelope path alone, so by the time
  // anyone read this sentence it was describing a dependency the memo above no
  // longer had. A comment that explains a dependency has to be corrected with
  // it, or it becomes the reason the next person restores the wrong one.
  const [blockedSaid, setBlockedSaid] = useState("");
  const blockedNow = blockedAnnouncement(waitingSessions);
  useEffect(() => {
    setBlockedSaid(said => nextAnnouncement(said, blockedNow));
  }, [blockedNow]);

  const [watchSaid, setWatchSaid] = useState("");
  const watchNow = watchUnseen > 0
    ? `Browser watch has ${watchUnseen} unread ${watchUnseen === 1 ? "finding" : "findings"}.`
    : "";
  useEffect(() => {
    setWatchSaid(said => nextAnnouncement(said, watchNow, "Browser watch has no unread findings."));
  }, [watchNow]);

  return { blockedSaid, watchSaid, setWatchSaid };
}
