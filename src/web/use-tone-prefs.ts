// What each notification tone is set to, and how a change to one is written
// and auditioned (#711).
//
// Lifted out of App.tsx's `Inner`. This is the LOWER of two layers the tones
// split into: it owns the settings, the preview timer and the write-through to
// storage, and it knows nothing about custom sounds. The custom-sound layer sits
// above it and writes `setTonePrefs` when a clip a tone points at is deleted or
// falls back — a dependency that runs one way only, which is what makes the split
// sound rather than arbitrary.
//
// The preview timer and its unmount cleanup are private now. Nothing outside the
// tone settings ever touched them.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import { clampLevel, figureIdFrom, FIGURE_KEYS, LEVEL_KEYS, PREVIEW_DELAY_MS, readPrefs,
         type Chime, type createChimePlayer, type TonePrefs, type ToneSettings } from "./sound";
import { readStored } from "./storage";
import { useMirroredRef } from "./use-mirrored-ref";

type ChimePlayer = ReturnType<typeof createChimePlayer>;

export interface TonePrefsControls {
  tonePrefs: TonePrefs;
  setTonePrefs: (update: TonePrefs | ((prev: TonePrefs) => TonePrefs)) => void;
  /** The settings as of this render, for the player built once on mount. */
  tonePrefsRef: MutableRefObject<TonePrefs>;
  /** Play one tone as it is currently set; `soon` debounces a slider drag. */
  previewTone: (chime: Chime, soon?: boolean) => void;
  /** Write one tone's settings through to storage, then audition it. */
  changeTone: (chime: Chime, patch: Partial<ToneSettings>) => void;
}

/**
 * The settings are read in the useState initialiser rather than in an effect,
 * unlike the sound on/off flag in App.tsx. That one waits a render because the
 * SWITCH would otherwise flash through "off" on a deck where it is on; these have
 * nothing to flash — they are read by a menu nobody has opened yet, and by the
 * player at play time.
 *
 * `readPrefs` takes the reader as an argument so the whole round trip is a pure
 * function the suite can drive, and the one it is handed is `readStored` — the
 * wrapped read. A private window and a browser with site data blocked throw out
 * of the `localStorage` GETTER, and a useState initialiser is exactly where
 * storage-blocked.test.ts says a throw takes the whole deck down with it.
 *
 * @param chimesRef The chime player, which stays null until the first gesture
 *   unlocks audio. Passed in rather than owned, because the player is built by
 *   the component with dependencies of its own.
 */
export function useTonePrefs(chimesRef: MutableRefObject<ChimePlayer | null>): TonePrefsControls {
  const [tonePrefs, setTonePrefs] = useState<TonePrefs>(() => readPrefs(readStored));
  // The player is built once, on mount, and reads these through the ref at play
  // time — the same shape `enabled` already uses for the flag.
  const tonePrefsRef = useMirroredRef(tonePrefs);

  const previewRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Play one tone as it is currently set.
   *
   * `unlock` first because pressing this may well be the first gesture of a
   * reloaded tab, and the autoplay rules hold the context suspended until
   * something is pressed — the wake listeners cover it, but these are the only
   * controls in the app whose entire purpose is to make a sound, so they ask
   * rather than assume.
   *
   * `true` is the audition flag: the switch governs the deck's own reports, not
   * a press whose whole meaning is "let me hear it". See sound.ts.
   *
   * `soon` is what separates a drag from a press. A slider crossing a dozen
   * steps must collapse to one figure, so a changed setting waits out
   * PREVIEW_DELAY_MS and is superseded by the next change; the Hear-it button
   * is not a stream and fires at once, cancelling anything pending so the two
   * cannot overlap.
   */
  const previewTone = useCallback((chime: Chime, soon = false) => {
    chimesRef.current?.unlock();
    if (previewRef.current !== null) clearTimeout(previewRef.current);
    previewRef.current = null;
    if (!soon) { chimesRef.current?.play(chime, true); return; }
    previewRef.current = setTimeout(() => {
      previewRef.current = null;
      chimesRef.current?.play(chime, true);
    }, PREVIEW_DELAY_MS);
  }, []);

  /**
   * One tone's settings, written and then played back.
   *
   * The level is clamped and the figure id is resolved here as well as inside
   * the player, because this is what gets WRITTEN: a value that survived the
   * round trip unchecked would come back on the next boot and be corrected
   * silently forever after, which is a stored preference that does not match
   * the control showing it.
   */
  const changeTone = useCallback((chime: Chime, patch: Partial<ToneSettings>) => {
    setTonePrefs(prev => {
      const next: ToneSettings = {
        level: clampLevel(patch.level ?? prev[chime].level),
        figure: figureIdFrom(chime, patch.figure ?? prev[chime].figure),
      };
      try {
        localStorage.setItem(LEVEL_KEYS[chime], String(next.level));
        localStorage.setItem(FIGURE_KEYS[chime], next.figure);
      } catch { /* no storage */ }
      return { ...prev, [chime]: next };
    });
    previewTone(chime, true);
  }, [previewTone]);

  // A timer outliving the tab it belongs to is a tone fired into an unmounted
  // tree. Cheap to clear, and the only thing this hook leaves running.
  useEffect(() => () => { if (previewRef.current !== null) clearTimeout(previewRef.current); }, []);

  return { tonePrefs, setTonePrefs, tonePrefsRef, previewTone, changeTone };
}
