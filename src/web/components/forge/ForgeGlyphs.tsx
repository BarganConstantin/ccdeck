// The GitHub and GitLab panel's own small drawings (#2179): the state marks
// a run, a change, a review or an issue carries, and the chevron on a button
// that opens a list. Drawn in the deck's icon hand (action-glyphs.tsx,
// integration-glyphs.tsx): a 14-unit box, currentColor strokes with round
// caps, so a mark takes its state's colour from the word's tone and keeps it
// under forced colours, and keeps its shape on every system's fonts.
//
// ONE FAMILY. A run's states are a ring with a sign in it — passed a check,
// failed a cross, running half full, pending a clock, canceled struck
// through, skipped a pair of chevrons, manual a play mark, none a dash. A
// change's are its own shapes: open a ring round a dot, draft a broken ring,
// merged two lines becoming one, closed struck through. A review's stand
// alone: approved is a bare check (passed is a ringed one, so the two never
// read alike on one row), changes requested a plus over a minus, commented a
// speech bubble, a pending review an eye. A warning is the shared triangle
// (integration-glyphs.tsx WarnMark). The word always stands beside the mark.
import type { GlyphName } from "../../forge-panel";

const RING = <circle cx="7" cy="7" r="5.6" />;

function shape(name: GlyphName) {
  switch (name) {
    case "passed":
    case "done":
      return <>{RING}<path d="m4.6 7.2 1.7 1.7 3.2-3.5" /></>;
    case "failed":
      return <>{RING}<path d="M5 5l4 4M9 5 5 9" /></>;
    case "running":
      return <>{RING}<path d="M7 3.6a3.4 3.4 0 0 1 0 6.8z" fill="currentColor" stroke="none" /></>;
    case "pending":
      return <>{RING}<path d="M7 4.2V7l1.9 1.2" /></>;
    case "canceled":
    case "closed":
      return <>{RING}<path d="m3.1 10.9 7.8-7.8" /></>;
    case "skipped":
      return <>{RING}<path d="m4.7 5 2 2-2 2M7.5 5l2 2-2 2" /></>;
    case "manual":
      return <>{RING}<path d="M5.8 4.7v4.6L9.4 7z" /></>;
    case "none":
      return <>{RING}<path d="M4.7 7h4.6" /></>;
    case "warning":
      return <><path d="M7 1.9 12.9 12H1.1Z" /><path d="M7 5.6v2.9M7 10.3v.05" /></>;
    case "open":
      return <>{RING}<circle cx="7" cy="7" r="2" fill="currentColor" stroke="none" /></>;
    case "draft":
      return <circle cx="7" cy="7" r="5.6" strokeDasharray="2.4 2" />;
    case "merged":
      return <path d="M4.4 2.4v2.8c0 2.3 2.6 2.7 2.6 4.8v1.6M9.6 2.4v2.8c0 2.3-2.6 2.7-2.6 4.8" />;
    case "approved":
    case "resolved":
      return <path d="m2.6 7.4 2.9 2.9 5.9-6.4" />;
    case "changes-requested":
      return <path d="M7 2.4v5.2M4.4 5h5.2M4.4 11h5.2" />;
    case "commented":
      return <path d="M2.2 2.8h9.6v6.6H6.4l-2.5 2.2V9.4H2.2z" />;
    case "review-pending":
      return <><path d="M1.4 7S3.4 3.4 7 3.4 12.6 7 12.6 7 10.6 10.6 7 10.6 1.4 7 1.4 7z" /><circle cx="7" cy="7" r="1.7" /></>;
    case "info":
      return <>{RING}<path d="M7 6.5v3.4M7 4.4v.05" /></>;
    case "linked":
      return <path d="M2.4 5h9L9.2 2.8M11.6 9h-9l2.2 2.2" />;
  }
}

/** A state's mark, drawn. `size` is its box in pixels; a mark drawn smaller
 *  than the words (a reviewer's, on a face) takes a heavier stroke. */
export function StateGlyph({ name, size = 12, weight = 1.3 }: { name: GlyphName; size?: number; weight?: number }) {
  return (
    <svg className="fg-glyph" data-glyph={name} width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {shape(name)}
    </svg>
  );
}

/** The chevron on a button that opens a list under it. */
export function ChevronGlyph() {
  return (
    <svg className="fgl-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4l2.5 2.5L7.5 4" />
    </svg>
  );
}
