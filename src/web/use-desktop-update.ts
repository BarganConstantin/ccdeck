// The desktop app's own updater, as the page sees it.
//
// Lifted out of App.tsx's `Inner` unchanged — the state, the press rule behind
// "Restart to update", and the stream event that releases a press. It was one
// contiguous eighty-five-line block with no other concern inside it, which is
// rarer in `Inner` than it sounds and is why this one moved whole.
//
// Eight of its thirteen names stop being visible to the rest of the component:
// `desktopUpdate` itself, all three setters and all four refs. Five come back
// through the return, and the stream handler — which used to reach into four of
// those refs inline — now calls one method and cannot see any of them. The body
// of that method is the old handler verbatim, comment included, because the
// discipline it documents is the whole of what makes the press rule correct.
import { useCallback, useEffect, useRef, useState } from "react";

import { inDesktopApp } from "./in-app";
import { readDesktopUpdate, readyDesktopUpdate, updateRestartRefusal, UPDATE_RESTART_WAIT_MS,
         type DesktopUpdateState, type UpdateRestartFailure } from "./desktop-update";
import { selfPressAccepted } from "./panel-press";

export interface DesktopUpdateControls {
  /** True from the press until the app answers, fails, or the stream releases it. */
  desktopUpdateRestarting: boolean;
  /** Why the last press did not end in a restart, and for which version. */
  desktopUpdateFailure: { failure: UpdateRestartFailure; version: string } | null;
  /** The update the app has staged and is ready to install, or null. */
  readyAppUpdate: ReturnType<typeof readyDesktopUpdate>;
  /** What the app's updater last reported — checking, downloading, current —
   *  or null outside the app and until it has said anything. What's new reads
   *  it to say where the app's own check stands. */
  appUpdate: DesktopUpdateState | null;
  askDesktopUpdateRestart: (updateVersion: string) => Promise<void>;
  /** Hand the `desktop-update` stream event's raw data straight to this. */
  onDesktopUpdateEvent: (data: string) => void;
}

/** @param live Whether this tab's event stream is connected. */
export function useDesktopUpdate(live: boolean): DesktopUpdateControls {
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateState | null>(null);
  const [desktopUpdateRestarting, setDesktopUpdateRestarting] = useState(false);
  /** Why the last press of Restart to update did not end in a restart, and for
   *  which version. Null until one fails, and again from the next press. */
  const [desktopUpdateFailure, setDesktopUpdateFailure] = useState<
    { failure: UpdateRestartFailure; version: string } | null
  >(null);
  // The stream coming back is the end of a restart, and the only moment the
  // answer is known to have changed. Without this the banner sat on
  // "restarting…" until the five-minute poll came round — and in a background
  // tab, where visibilitychange never fires, that was the only thing left.
  // On every (re)connect, not once: the app republishes its updater state when
  // its own stream comes back, and after a deck restart that can land before
  // this page's stream does, so the broadcast alone would be missed. Counted
  // against the stream's own frames so a slow answer cannot overwrite a newer
  // one that arrived while it was in flight.
  const desktopUpdateFramesRef = useRef(0);
  useEffect(() => {
    if (!live || !inDesktopApp()) return;
    let cancelled = false;
    const frames = desktopUpdateFramesRef.current;
    fetch("/api/desktop-update")
      .then(r => r.ok ? r.json() : null)
      .then(value => {
        if (cancelled || desktopUpdateFramesRef.current !== frames) return;
        const next = readDesktopUpdate(value);
        if (next) setDesktopUpdate(next);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [live]);

  const readyAppUpdate = readyDesktopUpdate(desktopUpdate);
  // The press rule (#620): the button stays enabled while its request is out,
  // and this ref is what a second Enter meets. Handed back after a while, as
  // askRestart does, because the answer to a restart that worked is the
  // window closing — one still here after half a minute did not happen.
  // HANDED BACK WITH A REASON. It used to be handed back and nothing else: a
  // 409 from the deck, or the half minute running out, turned "Restarting…"
  // back into the button it had been, which looks exactly like a press that
  // never registered, so the only thing left to try was the same press again.
  // Each way it can fail now leaves a sentence in the dialog saying which, and
  // naming the tray's line as the way out — that one talks to the updater
  // directly and works in every case here, including a deck that has lost the
  // app altogether.
  // ONE PRESS AT A TIME, and only that one handed back. The half-minute clock
  // used to be a bare setTimeout that checked the shared "asked" flag, so a
  // press the stream had already released (the update stopped being ready),
  // followed by a press for the next version, gave the old clock a flag that
  // was true again: it fired "has not restarted after 30 seconds" into the new
  // press seconds after it began. The same was true of a slow answer to the old
  // request. So the clock's id is kept to be cleared — by a new press, by every
  // hand-back and by the stream's release — and each press carries a number,
  // and a hand-back for any number but the latest is about a press that is
  // already over.
  const desktopUpdateAskedRef = useRef(false);
  const desktopUpdateTimerRef = useRef(0);
  const desktopUpdatePressRef = useRef(0);
  useEffect(() => () => window.clearTimeout(desktopUpdateTimerRef.current), []);
  const askDesktopUpdateRestart = useCallback(async (updateVersion: string) => {
    if (!selfPressAccepted(desktopUpdateAskedRef.current)) return;
    const press = ++desktopUpdatePressRef.current;
    window.clearTimeout(desktopUpdateTimerRef.current);
    desktopUpdateAskedRef.current = true;
    setDesktopUpdateRestarting(true);
    setDesktopUpdateFailure(null);
    const handBack = (failure: UpdateRestartFailure) => {
      if (press !== desktopUpdatePressRef.current) return;
      window.clearTimeout(desktopUpdateTimerRef.current);
      desktopUpdateAskedRef.current = false;
      setDesktopUpdateRestarting(false);
      setDesktopUpdateFailure({ failure, version: updateVersion });
    };
    try {
      const response = await fetch("/api/desktop-update/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: updateVersion }),
      });
      if (!response.ok) return handBack(updateRestartRefusal(await response.json().catch(() => null)));
    } catch {
      return handBack("unreachable");
    }
    if (press !== desktopUpdatePressRef.current) return;
    desktopUpdateTimerRef.current = window.setTimeout(() => handBack("timeout"), UPDATE_RESTART_WAIT_MS);
  }, []);

  const onDesktopUpdateEvent = useCallback((data: string) => {
    if (!inDesktopApp()) return;
    try {
      const next = readDesktopUpdate(JSON.parse(data));
      if (next) {
        desktopUpdateFramesRef.current++;
        setDesktopUpdate(next);
        if (next.status !== "ready") {
          // The press that was out is over, and so are its clock and any
          // answer still on its way (see askDesktopUpdateRestart).
          desktopUpdatePressRef.current++;
          window.clearTimeout(desktopUpdateTimerRef.current);
          desktopUpdateAskedRef.current = false;
          setDesktopUpdateRestarting(false);
        }
      }
    } catch { /* ignore */ }
  }, []);

  return { desktopUpdateRestarting, desktopUpdateFailure, readyAppUpdate, appUpdate: desktopUpdate,
           askDesktopUpdateRestart, onDesktopUpdateEvent };
}
