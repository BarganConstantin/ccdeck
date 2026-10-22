// The GitHub and GitLab panel's own small drawings (#2179): the chevron on a
// button that opens a list, and the check beside the current choice in one.
// Drawn in the deck's icon hand (action-glyphs.tsx): currentColor strokes,
// round caps, no fills of their own.

/** The chevron on a button that opens a list under it. */
export function ChevronGlyph() {
  return (
    <svg className="fgl-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4l2.5 2.5L7.5 4" />
    </svg>
  );
}

/** The check beside the current choice in a list. */
export function CheckGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}
