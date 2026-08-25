// What the arrow keys mean inside a tab strip.
//
// `role="tab"` is not a label, it is a contract, and it has three clauses: the
// whole strip is ONE stop in the tab order, the arrow keys walk between the
// members, and every member points at the panel it controls. The deck has met
// that contract in exactly zero places and has now answered it twice, in
// opposite directions.
//
// UsageHistoryModal's range strip (#381) dropped the role. That was right
// there: the strip's members do not control panels at all — they redraw the
// same chart over a different number of days — so the third clause could never
// have been met however much keyboard code was written under it, and a role
// that can never be honoured is a role to delete. It became
// `role="group"` + `aria-pressed`, which promises only what it does.
//
// The sign-in dialog (#581) is the other case, and the reason it was scoped
// out of #381 rather than swapped with it: its two members really do swap two
// panels. Signing in to Anthropic and pasting a share from another deck are
// two different journeys through the same dialog — that is what the file's own
// opening comment says — and a tab widget is the name for exactly that. So
// here the honest end is the other one: keep the role and pay for it. This
// file is the keyboard clause, and it is a decision about an index rather than
// anything to do with the DOM, which is why it lives out here where a
// plain-node test can read it — the same reason shortcuts.ts, canvas-keys.ts
// and modal-dismiss.ts exist.
//
// Left and Right only. A horizontal tablist owns the horizontal arrows; Up and
// Down scroll the dialog and belong to the browser, and taking them would cost
// a keyboard user the one way to read a panel taller than the modal. Home and
// End are the ends of the strip. Everything else falls through untouched,
// including Tab, which is how focus LEAVES the strip for the panel and must
// never be claimed here, and Escape, which belongs to the dismiss stack in
// modal-dismiss.ts and closes the dialog from anywhere inside it.
import { isBrowserChord, type ChordModifiers } from "./shortcuts";

/** A keystroke reduced to what the strip's rule reads. Structural rather than
 *  a KeyboardEvent so a test can pass a plain object, the way ChordModifiers
 *  and FocusTarget are. */
export interface TabStripKey extends ChordModifiers {
  key: string;
}

/** What a keystroke that arrived on a tab strip is for. */
export type TabStripMove =
  /** Not the strip's key. Leave it entirely alone — no preventDefault, which
   *  is the difference between a widget that owns four keys and one that eats
   *  every key aimed past it. */
  | { kind: "pass" }
  /** Select the tab at this index and move focus onto it. Automatic
   *  activation: the strip swaps two panels that are already rendered and cost
   *  nothing to show, so making the user press Enter after arriving would be
   *  ceremony. */
  | { kind: "select"; index: number };

/**
 * Where an arrow lands.
 *
 * `current` is where the selected tab sits, and -1 is allowed: focus can be on
 * the strip without any member being selected yet in some other caller, and a
 * first Right should then land on the first tab rather than on nothing.
 *
 * Both ends wrap, which is what a tablist does and what stepTarget already
 * does for the canvas — with two members, Left and Right are the same gesture,
 * and a keyboard user who cannot get back to the first tab without Home is a
 * keyboard user who has been given a dead end.
 */
export function tabStripMove(e: TabStripKey, current: number, count: number): TabStripMove {
  // Ctrl+Right jumps a word, Cmd+Left goes back a page, Alt+Home is the
  // browser's home. The deck stands aside for the same chords everywhere, and
  // through the same rule so there is only ever one answer to "is this the
  // browser's keystroke".
  if (count <= 0 || isBrowserChord(e)) return { kind: "pass" };
  const at = current >= 0 && current < count ? current : -1;
  switch (e.key) {
    case "ArrowRight":
      return { kind: "select", index: at === -1 ? 0 : (at + 1) % count };
    case "ArrowLeft":
      return { kind: "select", index: at === -1 ? count - 1 : (at - 1 + count) % count };
    case "Home":
      return { kind: "select", index: 0 };
    case "End":
      return { kind: "select", index: count - 1 };
    default:
      return { kind: "pass" };
  }
}
