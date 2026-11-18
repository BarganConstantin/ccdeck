import { KitIcon } from "./kit-icons";

/** Small action icons are V4's kit drawings, so they keep their shape across
 *  system symbol fonts. The refresh arrow keeps its class: the busy button
 *  spins it. */
export function RefreshGlyph() {
  return <KitIcon name="update" className="refresh-glyph" />;
}

export function ExternalLinkGlyph() {
  return <KitIcon name="external" />;
}

/** The computer cannot be reached: the kit's broken link. */
export function UnreachableGlyph() {
  return <KitIcon name="unreachable" />;
}
