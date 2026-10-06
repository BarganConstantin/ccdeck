// The git view's four phases: closed, opening, open, closing.
//
// The panel slides in over 200ms from where the detail rail stands and back
// out over 150ms (styles/git-view.css). A phase ends when the panel's own
// transition does — `transitionend`, the panel's transform, or its opacity
// where reduced motion turns the slide into a fade — and never on a timer, so a
// reopen that lands while the panel is still on its way out turns it round
// where it stands instead of racing a timeout that would hide it a moment
// later. A keyboard open or close moves nothing: it goes straight to the
// settled phase.
//
// The rules are plain functions so they can be held to that without a browser;
// the hook below is the little that puts them on an element.
import { useEffect, useRef, useState, type RefObject, type TransitionEvent } from "react";

export type GitViewPhase = "closed" | "opening" | "open" | "closing";

/** How the panel moves this time: along its transition, or not at all. */
export type GitViewMotion = "animate" | "instant";

/** The phase after the reader asked for the panel open (`want`) or closed,
 *  by a gesture that animates (a pointer) or not (a key). */
export function phaseAfterRequest(phase: GitViewPhase, want: boolean, animate: boolean): GitViewPhase {
  if (want) {
    if (phase === "open") return "open";
    if (phase === "opening") return animate ? "opening" : "open";
    return animate ? "opening" : "open";
  }
  if (phase === "closed") return "closed";
  if (phase === "closing") return animate ? "closing" : "closed";
  return animate ? "closing" : "closed";
}

/** The phase after a `transitionend` reached the panel. `own` is whether it
 *  was the panel's own transition rather than a child's bubbling up. Only the
 *  two properties the panel travels on end a phase, and only while the
 *  reader still wants what the phase is heading for. */
export function phaseAfterTransition(
  phase: GitViewPhase, want: boolean, ev: { own: boolean; property: string },
): GitViewPhase {
  if (!ev.own || (ev.property !== "transform" && ev.property !== "opacity")) return phase;
  return settled(phase, want);
}

/** Where a moving phase lands when its motion is over (or never started). */
function settled(phase: GitViewPhase, want: boolean): GitViewPhase {
  if (phase === "opening" && want) return "open";
  if (phase === "closing" && !want) return "closed";
  return phase;
}

/** Whether the panel is in the DOM: in every phase but closed. */
export function panelMounted(phase: GitViewPhase): boolean {
  return phase !== "closed";
}

/**
 * The phase for a panel the reader wants open or closed, and what to put on it.
 *
 * Derived during render rather than in an effect, so the frame that mounts the
 * panel is the frame the request was made in. A frame into a moving phase the
 * panel is asked whether a transition is actually running: when the property
 * was already where it was going — a close requested before the panel moved —
 * no transition starts and no `transitionend` will come, so the phase settles
 * there.
 */
export function useGitViewPhase(want: boolean, animate: boolean): {
  phase: GitViewPhase;
  motion: GitViewMotion;
  panelRef: RefObject<HTMLElement>;
  onTransitionEnd: (e: TransitionEvent<HTMLElement>) => void;
} {
  const [s, setS] = useState<{ phase: GitViewPhase; want: boolean; motion: GitViewMotion }>(
    { phase: "closed", want: false, motion: "instant" },
  );
  let state = s;
  if (s.want !== want) {
    state = { phase: phaseAfterRequest(s.phase, want, animate), want, motion: animate ? "animate" : "instant" };
    setS(state);
  }
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (state.phase !== "opening" && state.phase !== "closing") return;
    const raf = requestAnimationFrame(() => {
      const el = panelRef.current;
      const running = el?.getAnimations?.().some(a => a.playState === "running" || a.pending);
      if (!running) setS(prev => ({ ...prev, phase: settled(prev.phase, prev.want) }));
    });
    return () => cancelAnimationFrame(raf);
  }, [state.phase, state.want]);

  const onTransitionEnd = (e: TransitionEvent<HTMLElement>) => {
    const ev = { own: e.target === e.currentTarget, property: e.propertyName };
    setS(prev => {
      const phase = phaseAfterTransition(prev.phase, prev.want, ev);
      return phase === prev.phase ? prev : { ...prev, phase };
    });
  };

  return { phase: state.phase, motion: state.motion, panelRef, onTransitionEnd };
}
