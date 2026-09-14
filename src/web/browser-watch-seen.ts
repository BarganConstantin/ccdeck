// What the topbar needs of Browser Watch without loading the dialog (#883).
//
// The watch badge counts the episodes the reader has not opened, and that is two
// small things: where the "last looked" time is kept, and which episodes began
// after it. They lived in BrowserWatchModal.tsx, so the topbar's import of them
// pulled the whole 1,188-line dialog into the main bundle. Here, the dialog
// loads only when it opens.

/** Where the time the reader last opened Browser Watch is kept. */
export const SEEN_KEY = "agent-dag.browserWatch.seenMs";

/** Episodes that began after the reader last looked.
 *
 *  Keyed on the episode's START rather than its end: an episode that is still
 *  being added to would otherwise flip back to unread every time its last visit
 *  moves, and a badge that reappears without anything new happening is a badge
 *  people learn to ignore. */
export function unseenEpisodes<T extends { startMs: number }>(episodes: T[], seenMs: number): T[] {
  return episodes.filter(e => e.startMs > seenMs);
}
