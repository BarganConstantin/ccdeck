// The player behind the deck's own two tones (#704): built once, on mount, and
// woken by the first gesture anywhere on the page that the browser counts.
//
// Lifted out of App.tsx's `Inner`. `chimesRef` is passed in rather than owned,
// and that is forced rather than chosen: the tone settings need the player to
// audition a change, and the player needs the tone settings to play one, so the
// ref has to exist before either hook runs. This hook fills it; use-tone-prefs.ts
// reads it.
//
// Nothing here is rebuilt when a setting changes. Every setting the player needs
// is read through a ref at play time — on or off, what each tone is set to,
// which custom clip it points at, and what to do when that clip fails — which is
// why the effect's dependency list is empty and correctly so.
//
// It used to hand back whether the browser had let the page sound yet, for the
// topbar speaker's tooltip to say "waiting for a click". The speaker left the
// bar (2026-10-07), and nothing else shows that state: Settings › Sounds is
// opened by a click or a key, the gestures that wake the player below. So it
// keeps the state to itself rather than re-render the deck on a value nobody
// reads.
import { useEffect, type MutableRefObject } from "react";

import { getCustomNotificationAsset, type CustomSelections } from "./notification-audio";
import { createChimePlayer } from "./chime-player";
import { type Chime, type TonePrefs } from "./sound";

type ChimePlayer = ReturnType<typeof createChimePlayer>;

export interface ChimePlayerDeps {
  /** Filled here on mount; null until then. */
  chimesRef: MutableRefObject<ChimePlayer | null>;
  soundOnRef: MutableRefObject<boolean | null>;
  tonePrefsRef: MutableRefObject<TonePrefs>;
  customSelectionsRef: MutableRefObject<CustomSelections>;
  fallbackCustomRef: MutableRefObject<(chime: Chime, expectedId?: string) => void>;
}

export function useChimePlayer({ chimesRef, soundOnRef, tonePrefsRef, customSelectionsRef, fallbackCustomRef }: ChimePlayerDeps): void {
  useEffect(() => {
    const player = createChimePlayer({
      enabled: () => soundOnRef.current === true,
      prefs: () => tonePrefsRef.current,
      customSelection: () => customSelectionsRef.current,
      loadCustom: getCustomNotificationAsset,
      onCustomFailure: (chime, id) => fallbackCustomRef.current(chime, id),
    });
    chimesRef.current = player;
    // Any gesture anywhere unlocks it. `pointerdown` rather than `click` so a
    // press on the canvas counts, and `keydown` so a keyboard-only user is not
    // left permanently silent. Not once (#1760): Escape and a touch's
    // pointerdown are not activation, and the context stays suspended after
    // them, so every press asks again until the context runs — `pointerup`
    // being the one a touch is counted on.
    const WAKE_EVENTS = ["pointerdown", "pointerup", "keydown"] as const;
    const sleep = () => {
      for (const type of WAKE_EVENTS) window.removeEventListener(type, wake, { capture: true } as EventListenerOptions);
    };
    const wake = () => {
      player.unlock();
      if (player.context?.state === "running") sleep();
    };
    for (const type of WAKE_EVENTS) window.addEventListener(type, wake, { capture: true });
    return sleep;
  }, []);
}
