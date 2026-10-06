// The recap's mark, which the card, the session list, the hover peek and the
// recap note all draw. It was declared in AgentNode.tsx, beside the first of
// them, so the other three imported the card to get a glyph.

/** Claude Code's own mark for a recap: the ※ the terminal prints in front of
 *  one. Drawn rather than typed — U+203B comes from whichever fallback font a
 *  platform has, at whatever weight that font chose, and this has to be the
 *  same small figure on macOS, Windows and Linux. Decoration beside the word
 *  "recap", so it is hidden from assistive technology. */
export function RecapMark() {
  return (
    <svg className="recap-glyph" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
      <path d="M3.3 3.3l5.4 5.4M8.7 3.3l-5.4 5.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <circle cx="6" cy="1.2" r="1.05" fill="currentColor" />
      <circle cx="6" cy="10.8" r="1.05" fill="currentColor" />
      <circle cx="1.2" cy="6" r="1.05" fill="currentColor" />
      <circle cx="10.8" cy="6" r="1.05" fill="currentColor" />
    </svg>
  );
}

/** The mark in front of a session's note (session-note.ts): Claude Code's ※
 *  when the note is its recap, and otherwise a plain dot — the ※ is Claude
 *  Code's sign for a recap, and a line the deck read off a reply is not one.
 *  Decoration beside the note's word, hidden like the ※. */
export function NoteMark({ recap }: { recap: boolean }) {
  if (recap) return <RecapMark />;
  return (
    <svg className="recap-glyph note-glyph" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="3" fill="currentColor" />
    </svg>
  );
}
