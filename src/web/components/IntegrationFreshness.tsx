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
// it spins it stays pressable and focused (#518) but a second press does
// nothing rather than starting a second read.
// Lay it at the end of a toolbar row: it takes the free space and lets the
// sentence shorten with an ellipsis before Refresh would move.
import { useEffect, useRef, useState } from "react";
import { RefreshGlyph } from "./action-glyphs";
import { WarnMark } from "./integration-glyphs";
import { currentLanguage, t as translateNow, useT, type TFunction } from "../i18n";
import { selfPressAccepted, selfPressProps } from "../panel-press";

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
export function freshnessWords({ loadedAt, loading, stale }: FreshnessState, now = Date.now(), t: TFunction = translateNow): {
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
  const ago = loadedAt != null ? agoText(now - loadedAt, t) : null;
  const make = (tone: FreshnessTone, word: string, join = "", age: string | null = null) =>
    ({ tone, word, join, ago: age, text: `${word}${join}${age ?? ""}` });
  if (loading) return loadedAt != null ? make("updating", t("integrations.fresh.updating")) : make("reading", t("integrations.fresh.reading"));
  if (loadedAt == null) return make("none", "");
  if (stale) return make("stale", t("integrations.fresh.notUpdated"), t("integrations.fresh.joinStale"), ago);
  return make("updated", t("integrations.fresh.updated"), " ", ago);
}

/** "just now", "5m ago", "3h ago", "2d ago" from an age in milliseconds. */
function agoText(ms: number, t: TFunction): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t("integrations.fresh.now");
  if (s < 3600) return t("integrations.fresh.m", { n: Math.floor(s / 60) });
  if (s < 86400) return t("integrations.fresh.h", { n: Math.floor(s / 3600) });
  return t("integrations.fresh.d", { n: Math.floor(s / 86400) });
}

/** The word a screen reader hears when the state turns, never on a tick. */
function announcement(tone: FreshnessTone, seenRead: boolean, t: TFunction): string {
  if (tone === "reading" || tone === "updating") return t("integrations.fresh.updating");
  if (!seenRead) return "";
  return tone === "stale" ? t("integrations.fresh.notUpdated") : tone === "updated" ? t("integrations.fresh.updated") : "";
}

export default function IntegrationFreshness({ loadedAt, loading, stale = false, onRefresh, label, disabled = false, now }: FreshnessState & {
  onRefresh: () => void;
  /** Refresh's accessible name, naming what it reads again: "Refresh the board". */
  label: string;
  disabled?: boolean;
  /** The clock, for tests; the line keeps its own time otherwise. */
  now?: number;
}) {
  const t = useT();
  const [, tick] = useState(0);
  // The press handler reads the latest busy flag, not the one its render closed over.
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const [seenRead, setSeenRead] = useState(false);
  useEffect(() => {
    if (loadedAt == null) return;
    const t = window.setInterval(() => tick(n => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [loadedAt]);
  useEffect(() => { if (loading) setSeenRead(true); }, [loading]);

  const words = freshnessWords({ loadedAt, loading, stale }, now ?? Date.now(), t);
  const at = loadedAt != null ? new Date(loadedAt) : null;
  return (
    <div className="ig-freshness" data-tone={words.tone}>
      {words.tone !== "none" && (
        <span className="ig-fresh">
          {words.tone === "stale" && <WarnMark />}
          <span className="ig-fresh-word">{words.word}</span>
          {words.join}
          {at && words.ago && <time dateTime={at.toISOString()} title={at.toLocaleString(currentLanguage())}>{words.ago}</time>}
        </span>
      )}
      <span className="vis-hidden" role="status">{announcement(words.tone, seenRead, t)}</span>
      <button type="button" className="glyph-btn ig-refresh" aria-label={label} title={t("integrations.fresh.refresh")}
        {...selfPressProps(loading, disabled)} data-loading={loading || undefined}
        onClick={() => { if (!selfPressAccepted(loadingRef.current)) return; onRefresh(); }}>
        <RefreshGlyph />
      </button>
    </div>
  );
}
