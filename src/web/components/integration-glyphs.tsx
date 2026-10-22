// The small marks the integrations' shared parts draw (#2178, #2179), at the
// action icons' spec (action-glyphs.tsx): 13 px on a 14-unit box, a 1.3
// stroke in whatever ink the words beside them are in, hidden from the
// accessible name, and drawn rather than taken from a symbol font, so they keep
// their shape on every system. Refresh and the external link are in
// action-glyphs.tsx and are used from there.

/** A magnifier, at the start of a search field. */
export function SearchGlyph() {
  return <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" aria-hidden>
    <circle cx="6.1" cy="6.1" r="4.1" />
    <path d="m9.2 9.2 3.3 3.3" />
  </svg>;
}

/** The warning mark beside "Not updated" and a stale failure: a triangle and a stroke. */
export function WarnMark() {
  return <svg className="ig-mark" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 1.9 12.9 12H1.1Z" />
    <path d="M7 5.6v2.9" />
    <path d="M7 10.3v.05" />
  </svg>;
}

/** The error mark beside a failure's sentence: a ring and a stroke. */
export function ErrorMark() {
  return <svg className="ig-mark" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="7" cy="7" r="5.6" />
    <path d="M7 4.1v3.4" />
    <path d="M7 9.8v.05" />
  </svg>;
}

/** Copy: two sheets, the front one whole. */
export function CopyGlyph() {
  return <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="4.6" y="4.6" width="7.4" height="7.4" rx="1.2" />
    <path d="M9.4 4.6V2.8a.8.8 0 0 0-.8-.8H2.8a.8.8 0 0 0-.8.8v5.8a.8.8 0 0 0 .8.8h1.8" />
  </svg>;
}

/** Done: the tick a copy turns into for a moment. */
export function CheckGlyph() {
  return <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m2.6 7.4 2.9 2.9 5.9-6.4" />
  </svg>;
}

/** Close or clear: a cross, drawn so it sits on the glyph's own centre. */
export function CrossGlyph() {
  return <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" aria-hidden>
    <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
  </svg>;
}
