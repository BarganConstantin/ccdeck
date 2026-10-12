import { useEffect, useRef, useState } from "react";
import { containPopoverKeys } from "../shortcuts";
import { useModalDismiss } from "./use-modal-dismiss";
import RadioIcon from "./RadioIcon";

/** A real waiting state: disappears as soon as the component or stations arrive. */
export default function RadioLoading({ opening = false }: { opening?: boolean }) {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return <div className="radio-tuning" role="status" data-paused={hidden || undefined}>
    <svg className="radio-tuning-art" viewBox="0 0 240 112" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g className="radio-tuning-tower"><circle cx="40" cy="24" r="4" /><path d="M40 28v60 M40 36L24 88h32L40 36 M31 66h18 M28 77h24 M20 92h40" /><path d="M29 17a15 15 0 0 0 0 14 M51 17a15 15 0 0 1 0 14" /></g>
      <g className="radio-tuning-send"><path d="M75 26q7 8 0 16" /><path d="M102 26q7 8 0 16" /><path d="M129 26q7 8 0 16" /></g>
      <g className="radio-tuning-receiver"><path d="M165 49l30-22" /><rect x="154" y="49" width="66" height="43" rx="7" /><path d="M161 92v3 M213 92v3 M163 60h17 M163 66h17 M163 72h17 M163 78h17" /><circle cx="202" cy="65" r="7" /><path d="M202 62v3l3 2 M197 81h10" /></g>
    </svg>
    <strong>{opening ? "Opening Radio" : "Tuning into the world"}</strong>
    <span>{opening ? "Getting your explorer ready…" : "Finding stations…"}</span>
  </div>;
}

export function RadioOpening({ onClose }: { onClose: () => void }) {
  const keyboardOpened = useRef(document.activeElement?.matches(":focus-visible") ?? false);
  const dialog = useModalDismiss(onClose);
  return <div ref={dialog} className="radio-loading nodrag nopan" role="dialog" aria-modal="true" aria-label="Opening Radio" data-keyboard-interaction={keyboardOpened.current || undefined} onKeyDown={containPopoverKeys}>
    <button type="button" className="icon-btn" aria-label="Close radio" onClick={onClose}><RadioIcon name="close" /></button>
    <RadioLoading opening />
  </div>;
}
