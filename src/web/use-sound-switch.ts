// The finish sound's on/off switch, and the one door both of its controls use.
//
// Lifted out of App.tsx's `Inner` unchanged: the flag, the effect that reads it
// back, the toggle, and the two refs the window's keydown listener reads it
// through. What that buys is the writer count. The flag had exactly two writers
// — the read-back on mount and the toggle — and key-help.test.ts refused a
// third, but anything among five thousand lines could have been the third. Now
// the setter is private to this file, and App.tsx gets the state to draw, the
// toggle for the menu's control, and the refs for M.
import { useCallback, useEffect, useState, type MutableRefObject } from "react";

import type { createChimePlayer } from "./chime-player";
import { readStored, writeStored } from "./storage";
import { useMirroredRef } from "./use-mirrored-ref";

type ChimePlayer = ReturnType<typeof createChimePlayer>;

/**
 * @param chimesRef The chime player. Turning the sound on unlocks it, because
 *   that press is the gesture the autoplay rules want.
 */
export function useSoundSwitch(chimesRef: MutableRefObject<ChimePlayer | null>) {
  // The finish sound. Local to this tab since #704: the deck plays it itself,
  // so there is no server state to fetch and no settings.json to write. `null`
  // is kept as the first value for one render only — the switch is not drawn
  // until the stored preference has been read, which keeps it from flashing
  // through "off" on a deck where it is on.
  const [soundOn, setSoundOn] = useState<boolean | null>(null);
  useEffect(() => {
    // Through readStored: a private window, or a browser set to block site
    // data, throws out of the accessor rather than answering null.
    const stored = readStored("agent-dag.sound");
    setSoundOn(stored === null ? true : stored === "on");
  }, []);

  const toggleSound = useCallback(() => {
    setSoundOn(prev => {
      const next = prev !== true;
      writeStored("agent-dag.sound", next ? "on" : "off");
      // Turning it ON is itself the gesture the autoplay rules want, so take
      // it: otherwise the switch says "on" and the next event is still silent
      // because nothing has been pressed since the reload.
      if (next) chimesRef.current?.unlock();
      return next;
    });
  }, []);

  /** The single door to the sound switch, in the shape requestClear already
   *  established for the one other control that answers to two devices.
   *
   *  Which devices those are changed in #711 and the door did not. The topbar
   *  button no longer toggles — it opens the menu — so the two ways to the
   *  switch are now M and the menu's own control, and both arrive here. Shift
   *  used to mean "put my own parked hooks back"; #704 removed the mechanism
   *  that parked them, so there is nothing left for it to mean and a press is
   *  a press whatever is held down. */
  const activateSound = useCallback((_withShift: boolean) => { toggleSound(); }, [toggleSound]);
  // `toggleSound` is rebuilt whenever the switch changes state, so the window
  // keydown listener — registered exactly once, on purpose — reads the current
  // one through a ref rather than listing it as a dependency and re-subscribing.
  const activateSoundRef = useMirroredRef(activateSound);
  /** null until the stored flag has been read back. The button is not drawn in
   *  that window and the key must not fire in it either: there is no state to
   *  invert yet, and "not false" would arm the tones on a guess. */
  const soundOnRef = useMirroredRef(soundOn);

  return { soundOn, toggleSound, activateSoundRef, soundOnRef };
}
