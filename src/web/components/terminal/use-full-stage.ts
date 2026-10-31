// ⤢ as full screen, where full screen is what gives the pane every key
// (tab-keys.ts). Elsewhere ⤢ is what it always was: the stage as wide as the
// deck lets it be.
//
// One state, not two: full screen comes with the width and goes with it. ⤡
// leaves both; so does leaving full screen any other way — Esc held, F11 —
// and so does the stage closing, since the full screen was for the session.
// Only a full screen ⤢ asked for is ever left: one the reader made with F11
// is theirs.
import { useCallback, useEffect, useRef, useState } from "react";
import { canFullStage, enterFullStage, leaveFullStage } from "../../tab-keys";

export interface FullStage {
  /** ⤢ asks for full screen here. */
  can: boolean;
  /** The deck is in the full screen ⤢ asked for. */
  full: boolean;
  /** What ⤢ and ⤡ do. */
  toggle(): void;
}

export function useFullStage(expanded: boolean, toggleExpand: () => void, canOverride?: boolean): FullStage {
  // Asked once: what the browser can do does not change under the page.
  const [can] = useState(() => canOverride ?? canFullStage());
  const [full, setFull] = useState(false);
  /** The page is in full screen because ⤢ put it there. */
  const ours = useRef(false);
  const alive = useRef(true);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const toggleRef = useRef(toggleExpand);
  toggleRef.current = toggleExpand;

  useEffect(() => {
    alive.current = true;
    if (!can) return () => { alive.current = false; };
    const changed = () => {
      if (document.fullscreenElement || !ours.current) return;
      ours.current = false;
      setFull(false);
      // Esc held or F11: the lock goes with the full screen it was for.
      leaveFullStage();
      if (expandedRef.current) toggleRef.current();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      alive.current = false;
      document.removeEventListener("fullscreenchange", changed);
      if (!ours.current) return;
      ours.current = false;
      leaveFullStage();
      if (expandedRef.current) toggleRef.current();
    };
  }, [can]);

  const toggle = useCallback(() => {
    if (expandedRef.current) {
      if (ours.current) {
        ours.current = false;
        setFull(false);
        leaveFullStage();
      }
      toggleRef.current();
      return;
    }
    toggleRef.current();
    if (!can) return;
    // Asked for inside the press: full screen needs the reader's gesture.
    void enterFullStage().then(ok => {
      if (!ok) return;
      // ⤡ pressed, or the stage closed, while the browser was on its way.
      if (!expandedRef.current) { leaveFullStage(); return; }
      if (!alive.current) {
        leaveFullStage();
        toggleRef.current();
        return;
      }
      ours.current = true;
      setFull(true);
    });
  }, [can]);

  return { can, full, toggle };
}
