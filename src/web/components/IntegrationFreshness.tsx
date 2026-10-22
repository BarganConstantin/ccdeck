// How old the answer on a panel is, and the Refresh beside it (#2178, #2179).
//
//   <IntegrationFreshness loadedAt={ms | null} loading={bool} stale={bool}
//     onRefresh={fn} label="Refresh the board" disabled? />
//
// One honest line for every panel: "Reading…" before the first answer,
// "Updating…" while a newer one is out, "Updated 5m ago" after it lands, and
// after a read that failed "Not updated · last answer 5m ago", the warning
// mark and its word in --warn and the rest quiet, so the rows still on screen
// are never claimed as fresh. The age keeps time on its own and carries the
// exact moment in its title. The line is not a live region, since its age
// changes every minute; a hidden status says only the transitions (updating,
// updated, not updated). Refresh is the action icon in a glyph button; it
// spins only while a read is out, not at all under reduced motion, and while
// it spins a second press does nothing rather than starting a second read.
// Lay it at the end of a toolbar row: it takes the free space and lets the
// sentence shorten with an ellipsis before Refresh would move.
import { useEffect, useState } from "react";
import { RefreshGlyph } from "./action-glyphs";
import { WarnMark } from "./integration-glyphs";
import { shortAgo } from "../relative-time";

export interface FreshnessState {
  /** When the answer on screen was read (ms), or null before the first one. */
  loadedAt: number | null;
  /** A read is out. */
  loading: boolean;
  /** The last read failed, and what is on screen is the answer before it. */
  stale?: boolean;
}

export type FreshnessTone = "none" | "reading" | "updating" | "updated" | "stale";

/** What the line says, as words and a tone; the age is filled in by the caller's clock. */
export function freshnessWords({ loadedAt, loading, stale }: FreshnessState, now = Date.now()): {
  tone: FreshnessTone;
  /** The state's word: "Updated", "Not updated", "Updating…". */
  word: string;
  /** What follows the word: " · last answer " or " ". Empty when there is no age. */
  join: string;
  /** "5m ago", or null. */
  ago: string | null;
  /** The sentence whole, for a title and for tests. */
  text: string;
} {
  const ago = loadedAt != null ? shortAgo(now - loadedAt) : null;
  const make = (tone: FreshnessTone, word: string, join = "", age: string | null = null) =>
    ({ tone, word, join, ago: age, text: `${word}${join}${age ?? ""}` });
  if (loading) return loadedAt != null ? make("updating", "Updating…") : make("reading", "Reading…");
  if (loadedAt == null) return make("none", "");
  if (stale) return make("stale", "Not updated", " · last answer ", ago);
  return make("updated", "Updated", " ", ago);
}

/** The word a screen reader hears when the state turns, never on a tick. */
function announcement(tone: FreshnessTone, seenRead: boolean): string {
  if (tone === "reading" || tone === "updating") return "Updating…";
  if (!seenRead) return "";
  return tone === "stale" ? "Not updated" : tone === "updated" ? "Updated" : "";
}

export default function IntegrationFreshness({ loadedAt, loading, stale = false, onRefresh, label, disabled = false, now }: FreshnessState & {
  onRefresh: () => void;
  /** Refresh's accessible name, naming what it reads again: "Refresh the board". */
  label: string;
  disabled?: boolean;
  /** The clock, for tests; the line keeps its own time otherwise. */
  now?: number;
}) {
  const [, tick] = useState(0);
  const [seenRead, setSeenRead] = useState(false);
  useEffect(() => {
    if (loadedAt == null) return;
    const t = window.setInterval(() => tick(n => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [loadedAt]);
  useEffect(() => { if (loading) setSeenRead(true); }, [loading]);

  const words = freshnessWords({ loadedAt, loading, stale }, now ?? Date.now());
  const at = loadedAt != null ? new Date(loadedAt) : null;
  return (
    <div className="ig-freshness" data-tone={words.tone}>
      {words.tone !== "none" && (
        <span className="ig-fresh">
          {words.tone === "stale" && <WarnMark />}
          <span className="ig-fresh-word">{words.word}</span>
          {words.join}
          {at && words.ago && <time dateTime={at.toISOString()} title={at.toLocaleString()}>{words.ago}</time>}
        </span>
      )}
      <span className="vis-hidden" role="status">{announcement(words.tone, seenRead)}</span>
      <button type="button" className="glyph-btn ig-refresh" aria-label={label} title="Refresh"
        disabled={disabled} aria-disabled={loading || undefined} data-loading={loading || undefined}
        onClick={() => { if (!loading) onRefresh(); }}>
        <RefreshGlyph />
      </button>
    </div>
  );
}
