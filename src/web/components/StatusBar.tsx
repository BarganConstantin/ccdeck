// V4's Status bar: across the bottom of the window, who has the keys and the
// keys that work there. The words and their keys are a table (status-hints.ts)
// that a test holds against the handler; this draws it.
//
// FIRST-LOAD. It imports no stage code: the stage tells it two things, whether
// it is open (a prop) and, through the pane's data attribute, whose pane holds
// focus (terminal-keys.ts). The layer follows focus live from focusin and
// focusout on the document: no polling, and nothing moves, a change swaps at once.
//
// <footer> is the page's contentinfo landmark. No live region: it would speak on
// every focus move, and everything it names is on the keyboard sheet (?).
import { memo, useEffect, useState } from "react";
import { isCanvasNodeElement } from "../canvas-node-element";
import { platformName } from "../platform";
import { statusViewFor } from "../status-hints";
import { PANE_NAME_ATTR, paneNameOf, TERMINAL_PANEL_SELECTOR } from "../terminal-keys";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { Kbd } from "./Kbd";

interface FocusPlace {
  /** The name of the pane focus is in, or null outside every pane. */
  pane: string | null;
  /** Focus is on a card on the board. */
  onCard: boolean;
}

const placeOf = (el: Element | null): FocusPlace => ({ pane: paneNameOf(el), onCard: isCanvasNodeElement(el) });
const samePlace = (a: FocusPlace, b: FocusPlace) => a.pane === b.pane && a.onCard === b.onCard;

/** Where focus is, kept current from the document's focus events. On focusout
 *  the element focus is going to is `relatedTarget`; document.activeElement is
 *  still the one it leaves. While focus stays in a pane, the pane's name is
 *  watched too: the stage renames it in place when it follows another session
 *  or the session renames itself, and no focus event says so. */
function useFocusPlace(stageOpen: boolean): FocusPlace {
  const [place, setPlace] = useState<FocusPlace>(() => (typeof document === "undefined" ? { pane: null, onCard: false } : placeOf(document.activeElement)));
  useEffect(() => {
    let watched: Element | null = null;
    const names = new MutationObserver(() => read(document.activeElement));
    const read = (el: Element | null) => {
      const next = placeOf(el);
      setPlace(prev => (samePlace(prev, next) ? prev : next));
      const pane = el?.closest?.(TERMINAL_PANEL_SELECTOR) ?? null;
      if (pane === watched) return;
      names.disconnect();
      watched = pane;
      if (pane) names.observe(pane, { attributes: true, attributeFilter: [PANE_NAME_ATTR] });
    };
    const onIn = (e: FocusEvent) => read(e.target as Element | null);
    const onOut = (e: FocusEvent) => read(e.relatedTarget as Element | null);
    // The stage opening or closing moves focus without a focus event the bar
    // can trust (an unmounted pane fires none in every browser): look again.
    read(document.activeElement);
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      names.disconnect();
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, [stageOpen]);
  return place;
}

/** Memoised: App re-renders on its clock several times a second, and the bar's
 *  only inputs are its two props, focus and the single-key switch. */
export default memo(function StatusBar({ stageOpen, zoomedOut, viewChord = null }: {
  stageOpen: boolean;
  zoomedOut: boolean;
  /** Where Ctrl + backtick goes, when the deck claims it (status-hints.ts). */
  viewChord?: "workspace" | "board" | null;
}) {
  const singleKeys = useSingleKeyShortcuts();
  const { pane, onCard } = useFocusPlace(stageOpen);
  const view = statusViewFor({ stageOpen, pane, onCard, zoomedOut, singleKeys, platform: platformName(), viewChord });
  return (
    <footer className="statusbar" aria-label="Keys" data-layer={view.layer}>
      <span className="statusbar-who"><span className="statusbar-dot" aria-hidden />{view.label}</span>
      {view.hints.map(h => (
        <span className="statusbar-hint" key={h.word}>
          <span className="statusbar-caps">
            {h.caps.map(c => <Kbd key={c.text} label={c.spoken}>{c.text}</Kbd>)}
          </span>
          {h.word}
        </span>
      ))}
    </footer>
  );
});
