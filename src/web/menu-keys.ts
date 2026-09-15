// What the arrow keys mean inside a menu.
//
// The accounts panel's `⋯` opens the deck's first `role="menu"`, and that role
// is a contract the way `role="tab"` is in tablist-keys.ts: the items are not
// separate stops in the tab order, the arrow keys walk between them, and Home
// and End are the ends of the list. A menu is vertical, so it owns the two
// keys a tab strip leaves to the browser and leaves alone the two a tab strip
// owns — Left and Right mean nothing in a one-level menu, and taking them would
// be a key eaten for no reason.
//
// Tab and Escape are not answered here. Escape belongs to the dismiss stack in
// modal-dismiss.ts and closes the popover from anywhere inside it; Tab is how
// focus leaves the menu, which is the popover's decision rather than the
// index's. What is left is a decision about a list and a position, so it lives
// where a plain-node test can read it — the same reason tablist-keys.ts does.
import { isBrowserChord, type ChordModifiers } from "./shortcuts";

/** A keystroke reduced to what the rule reads. Structural, so a test can pass
 *  a plain object, the way TabStripKey is. */
export interface MenuKey extends ChordModifiers {
  key: string;
}

export type MenuMove =
  /** Not the menu's key. Left alone entirely — no preventDefault. */
  | { kind: "pass" }
  /** Move focus to the enabled item at this index. */
  | { kind: "focus"; index: number };

/**
 * Where an arrow lands among `count` enabled items, from the one at `current`.
 *
 * -1 is allowed and ordinary: a click on the menu's own padding leaves focus on
 * the menu rather than on an item, and a first Down should then land on the
 * first item rather than on nothing. Both ends wrap, as they do in
 * tabStripMove — four items is short enough that a dead end at the bottom
 * costs more than it protects.
 */
export function menuMove(e: MenuKey, current: number, count: number): MenuMove {
  if (count <= 0 || isBrowserChord(e)) return { kind: "pass" };
  const at = current >= 0 && current < count ? current : -1;
  switch (e.key) {
    case "ArrowDown":
      return { kind: "focus", index: at === -1 ? 0 : (at + 1) % count };
    case "ArrowUp":
      return { kind: "focus", index: at === -1 ? count - 1 : (at - 1 + count) % count };
    case "Home":
      return { kind: "focus", index: 0 };
    case "End":
      return { kind: "focus", index: count - 1 };
    default:
      return { kind: "pass" };
  }
}
