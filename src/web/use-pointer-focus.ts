// Which element a pointer put focus on.
//
// Lifted out of App.tsx's `Inner` unchanged: one ref and the two capture-phase
// listeners that fill it, which the canvas keydown handler reads to let a
// button the mouse pressed stop swallowing single-key shortcuts (#851; the
// rule itself is ownsKeystroke's). Nothing else writes the ref.
import { useEffect, useRef } from "react";

export function usePointerFocus() {
  // Which element a POINTER put focus on, so a button the mouse pressed stops
  // swallowing the single-key shortcuts (#851; the rule is ownsKeystroke's).
  // Tracked here because the browser cannot be asked at keydown time —
  // `:focus-visible` is re-decided by the keystroke itself. A focus that lands
  // within a moment of a press came from the press; any other focus (Tab, a
  // dialog handing focus back) clears the mark.
  const pointerFocusRef = useRef<EventTarget | null>(null);
  useEffect(() => {
    let pressedAt = -Infinity;
    const onPress = () => { pressedAt = performance.now(); };
    const onFocus = (e: FocusEvent) => {
      pointerFocusRef.current = performance.now() - pressedAt < 250 ? e.target : null;
    };
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("focusin", onFocus, true);
    return () => {
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("focusin", onFocus, true);
    };
  }, []);

  return pointerFocusRef;
}
