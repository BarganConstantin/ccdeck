/** Small action icons must keep their shape across system symbol fonts. */
export function RefreshGlyph() {
  return <svg className="refresh-glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11.6 6.2A4.8 4.8 0 1 0 11 9.6" />
    <path d="M11.9 2.6v3.7h-3.6" />
  </svg>;
}

export function ExternalLinkGlyph() {
  return <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3.3 10.7L10.7 3.3M5.5 3.3h5.2v5.2" />
  </svg>;
}

/** The computer cannot be reached: a screen with a stroke through it. Stroke
 *  only, in currentColor, like the glyphs above. */
export function UnreachableGlyph() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" />
    <path d="M5.5 13.75h5M8 11.25v2.5M2.5 1.75l11 12.5" />
  </svg>;
}
