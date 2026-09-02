// What a program drove in this machine's browsers while nobody was browsing,
// and whether the relay that lets a stranger drive them is open.
//
// A dialog rather than a docked panel, and the width is the reason: an episode
// is a list of URLs, the accounts panel is 288px, and a truncated address is
// exactly the thing a person needs to read whole before deciding whether to
// care.
//
// THE VOCABULARY IS LOAD-BEARING. Nothing here says "intrusion". The one
// episode this rule found in 46 days of real history was almost certainly the
// author's own Claude Code session driving a browser he had asked it to drive.
// A panel that cries theft on the first card teaches its reader to close it,
// and then it is worthless on the day it is right. It reports what a program
// did and shows the evidence; the person reading it decides what it was.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModalDismiss } from "./use-modal-dismiss";
import WatchRadar from "./WatchRadar";
import type { Palette } from "../palette";
import { tabStripMove } from "../tablist-keys";

export interface WatchEpisode {
  host: string;
  /** Which browser it happened in — a reaction has to tell one application to
   *  close a tab, and the radar has to know which blip the finding left from. */
  browser: string | null;
  startMs: number;
  endMs: number;
  count: number;
  urls: { url: string; timeMs: number }[];
}

interface WatchProfile {
  browser: string;
  name: string;
  profile: string;
  hasClaudeExt: boolean;
  visits: number;
  findings: number;
  degraded: boolean;
  reason: string | null;
  lastWrittenMs: number | null;
}

export interface WatchSettings {
  enabled: boolean;
  reaction: "notify" | "close-tab" | "quit-browser";
  quietMinutes: number;
  gapMinutes: number;
  windowDays: number;
}

export interface WatchLine {
  atMs: number;
  level: "find" | "act" | "ok" | "info" | "warn";
  text: string;
}

export interface WatchBrowser {
  key: string;
  name: string;
  installed: boolean;
  profiles: number;
  withExtension: string[];
  running: boolean | null;
  relay: { state: "live" | "none-seen" | "unknown"; count: number; why: string };
}

export interface WatchSnapshot {
  ok: true;
  settings: WatchSettings;
  reactions: WatchSettings["reaction"][];
  log: WatchLine[];
  profiles: WatchProfile[];
  browsers: WatchBrowser[];
  episodes: WatchEpisode[];
  coverage: { startedMs: number; oldestVisitMs: number | null; lastHumanMs: number | null; quietMs: number; logPath: string; archived: number; now: number };
  degraded: boolean;
}

/** The moment the reader last had this panel open, so the topbar badge can
 *  count what has appeared since. Per-browser by construction — it is this
 *  reader's own reading position, not a fact about the machine — which is why
 *  it lives in localStorage and not on the server. */
export const SEEN_KEY = "agent-dag.browserWatch.seenMs";

/** Episodes that began after the reader last looked.
 *
 *  Keyed on the episode's START rather than its end: an episode that is still
 *  being added to would otherwise flip back to unread every time its last visit
 *  moves, and a badge that reappears without anything new happening is a badge
 *  people learn to ignore. */
export function unseenEpisodes(episodes: WatchEpisode[], seenMs: number): WatchEpisode[] {
  return episodes.filter(e => e.startMs > seenMs);
}

/**
 * How long until a program opening a page would be reported — or null when it
 * already would be.
 *
 * The shell tool this descends from counted down to "armed" off the keyboard's
 * idle clock. There is no keyboard here and no armed state: the gate is
 * measured from the last navigation a PERSON made, so the honest version of the
 * same question is "you browsed N seconds ago, and the gate opens in M".
 *
 * Ticking, because a countdown that only moves when the panel refetches is a
 * stopped clock that lies for ten seconds at a time.
 */
export function armsIn(lastHumanMs: number | null, quietMs: number, nowMs: number): number | null {
  if (lastHumanMs === null) return null;
  const left = lastHumanMs + quietMs - nowMs;
  return left > 0 ? left : null;
}

/** `2m 30s`, `45s`. Seconds all the way up, because this is a countdown and a
 *  countdown that rounds to minutes appears frozen for a minute at a time. */
export function untilLabel(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

/**
 * The browsers the watch actually reads.
 *
 * ONE definition, because three places render it and two of them have to agree
 * mark for mark: the radar puts blip i at angle i/n and the legend under it
 * names item i. Filter them separately and the day one list changes without the
 * other, every name sits beside the wrong dot — a defect that still looks like
 * a working radar, which is the kind the eye never catches.
 *
 * Installed but never opened is excluded on purpose: it has no profile, so
 * there is no history to read and a blip for it would be a light with nothing
 * behind it.
 */
export function watchedBrowsers(browsers: WatchBrowser[] | undefined): WatchBrowser[] {
  return (browsers ?? []).filter(b => b.installed && b.profiles > 0);
}

/** `17:03 → 17:44`, or a single time when an episode is one page. */
function span(e: WatchEpisode): string {
  const t = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return e.count === 1 || e.endMs - e.startMs < 60_000 ? t(e.startMs) : `${t(e.startMs)} → ${t(e.endMs)}`;
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** "41 minutes", "2 minutes", "" for an instant. The headline of a card is how
 *  long a program was working, which is the part that separates one opened tab
 *  from something that ran for three quarters of an hour. */
function lasted(e: WatchEpisode): string {
  const mins = Math.round((e.endMs - e.startMs) / 60_000);
  return mins < 1 ? "" : `${mins} min`;
}

/** The two views, in order. Kept as data because the strip's keyboard model is
 *  index arithmetic and a hand-written pair of buttons cannot take part in it. */
const TABS = [
  { id: "history" as const, label: "Episodes" },
  { id: "live" as const, label: "Log" },
];
const BW_PANEL_ID = "bw-view";
/** The selected tab names the panel and the panel names it back, which is how
 *  a screen reader gets from "selected, 1 of 2" to the thing that was selected. */
const bwTabId = (id: string) => `bw-tab-${id}`;

export default function BrowserWatchModal({
  onClose,
  onSeen,
  onWatching,
  palette,
}: {
  onClose: () => void;
  onSeen: (ms: number) => void;
  /** The topbar keeps its own copy of "is it watching", refreshed on a
   *  five-minute poll. The switch is in here, so without this the eye stays
   *  lit for up to five minutes after it is turned off — the one control whose
   *  whole job is to be true at a glance, lying. */
  onWatching: (on: boolean) => void;
  /** Handed down rather than read here — see WatchRadar. */
  palette: Palette;
}) {
  const dialogRef = useModalDismiss(onClose);
  const [snap, setSnap] = useState<WatchSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quiet, setQuiet] = useState(15);
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [why, setWhy] = useState(false);
  const [showBrowsers, setShowBrowsers] = useState(false);
  // Its own clock, so the countdown moves every second rather than jumping
  // whenever the panel happens to refetch.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // Opens on the Log, because that is the view that answers "is this thing
  // working" — and a panel that opens on an empty Episodes list looks broken on
  // the machine where nothing has happened, which is most machines most days.
  const [tab, setTab] = useState<"history" | "live">("live");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /** The keyboard half of what role="tab" promises. Arrows move and select;
   *  anything else passes through, so Tab still leaves the strip and Escape
   *  still reaches the dialog. Same rule as the accounts dialog's strip. */
  const onTabKeys = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const move = tabStripMove(e, TABS.findIndex(t => t.id === tab), TABS.length);
    if (move.kind === "pass") return;
    e.preventDefault();
    setTab(TABS[move.index].id);
    tabRefs.current[move.index]?.focus();
  }, [tab]);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/browser-watch?quiet=${quiet}${refresh ? "&refresh=1" : ""}`);
      if (!r.ok) throw new Error(`the deck answered ${r.status}`);
      const next = await r.json();
      setSnap(next);
      onWatching(next?.settings?.enabled === true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [quiet, onWatching]);

  useEffect(() => { void load(false); }, [load]);

  // LIVE WHILE THE LOG IS OPEN, AND ONLY THEN. The Log answers "is this thing
  // working", and an answer that stops updating the moment you look at it
  // answers the opposite. Ten seconds is fast enough to read as live and far
  // above what it costs: the server serves from a cache keyed on each History
  // file's mtime, so a browser nobody is using is one `stat` per profile.
  //
  // Not on the Episodes view: that list changes when an episode is found, which
  // is a handful of times a month, and the badge already carries that news.
  useEffect(() => {
    if (tab !== "live") return;
    const t = setInterval(() => { void load(false); }, 10_000);
    return () => clearInterval(t);
  }, [tab, load]);

  /** Change a setting on the server, which owns it: the file on disk is what
   *  the watch runs on, and a client that kept its own copy would disagree with
   *  it the moment a second tab was open. */
  const save = useCallback(async (patch: Partial<WatchSettings>) => {
    setSaving(true);
    try {
      const r = await fetch("/api/browser-watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`the deck answered ${r.status}`);
      await load(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [load]);

  // Reading the panel is what marks it read, and it is recorded on the way out
  // rather than on the way in: a dialog opened and dismissed in the same second
  // still counts, but the badge does not clear before the list has rendered.
  useEffect(() => () => onSeen(Date.now()), [onSeen]);

  const grouped = useMemo(() => {
    const out: { label: string; episodes: WatchEpisode[] }[] = [];
    for (const e of snap?.episodes ?? []) {
      const label = day(e.startMs);
      const last = out[out.length - 1];
      if (last && last.label === label) last.episodes.push(e);
      else out.push({ label, episodes: [e] });
    }
    return out;
  }, [snap]);

  const watching = watchedBrowsers(snap?.browsers);
  const live = watching.filter(b => b.running).map(b => b.name);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal bw-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bw-title"
      >
        <header className="modal-head">
          <div className="modal-title">
            <span className="modal-tool-name" id="bw-title">Browser watch</span>
            <span className="modal-tool-id">program navigation while nobody was browsing</span>
          </div>
          <div className="modal-actions">
            {/* No `disabled` while it works (#620): a control that removes
                itself on press takes the focus with it and leaves the reader
                nowhere, and the label already says what is happening. A second
                press costs nothing — the server holds one read at a time and
                hands a concurrent caller the same promise. */}
            {/* `glyph-btn` for the close, which is what every other modal
                header in the deck uses — ToolModal, the accounts dialog, the
                usage history. A second spelling of the same control is a second
                thing to maintain and a visible seam. */}
            <button className="ap-manage-btn" onClick={() => void load(true)} title="Re-read every profile now">
              {busy ? "reading…" : "refresh"}
            </button>
            <button className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <div className="modal-body bw-body">
          {!snap && !error && (
            <div className="bw-loading">
              <span className="bw-loading-bar" aria-hidden />
              <p>Reading each browser's history. The first look copies the file, which takes a moment.</p>
            </div>
          )}

          {error && (
            <div className="bw-state">
              <div className="bw-row err">
                <span className="bw-dot" aria-hidden />
                <span className="bw-row-label">Could not read</span>
                <span className="bw-row-detail">{error}</span>
              </div>
            </div>
          )}

          {snap && (
            <div className="bw-bar">
              <div className="bw-tabs" role="tablist" aria-label="Browser watch views" onKeyDown={onTabKeys}>
                {TABS.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={bwTabId(t.id)}
                    ref={el => { tabRefs.current[i] = el; }}
                    aria-selected={tab === t.id}
                    aria-controls={BW_PANEL_ID}
                    tabIndex={tab === t.id ? 0 : -1}
                    className={`bw-tab${tab === t.id ? " on" : ""}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                    {t.id === "history" && snap.episodes.length > 0 && (
                      <span className="bw-tab-count">{snap.episodes.length}</span>
                    )}
                    {t.id === "live" && snap.settings.enabled && <span className="bw-tab-live" aria-hidden />}
                  </button>
                ))}
              </div>

              <div className="bw-bar-right">
                <button
                  type="button"
                  role="switch"
                  aria-checked={snap.settings.enabled}
                  aria-label={`Watching, ${snap.settings.enabled ? "on" : "off"}`}
                  className="bw-toggle"
                  onClick={() => void save({ enabled: !snap.settings.enabled })}
                  title={snap.settings.enabled
                    ? "On — the deck keeps its own copy, so an episode it has seen survives the browsing history being cleared"
                    : "Off — the list is still read live from the browser's own history; clearing that history would lose it"}
                >
                  <span className="bw-toggle-knob" />
                </button>
                <span className="bw-bar-state">
                  {(() => {
                    if (saving) return "saving";
                    if (!snap.settings.enabled) return "not watching";
                    const left = armsIn(snap.coverage.lastHumanMs, snap.coverage.quietMs, tick);
                    // The gate, said as the thing a person sitting at the
                    // browser wants to know: not "quiet gate 15m" but "a page
                    // opened now would not count, and here is when it would".
                    return left === null
                      ? `watching · ${snap.coverage.archived} kept`
                      : `you are browsing · counts in ${untilLabel(left)}`;
                  })()}
                </span>
                <button className="bw-why" onClick={() => setWhy(w => !w)} aria-expanded={why}>
                  settings
                </button>
              </div>
            </div>
          )}

          {snap && tab === "live" && (
            /* Side by side, because each was wasting the other's space: the
               disc is bounded by height and left the width beside it empty,
               and the lines are short and left a field of nothing to their
               right. The picture answers "is this alive", the transcript
               answers "what exactly happened", and they are read together. */
            <div className="bw-live">
              <div className="bw-scope">
                <WatchRadar
                browsers={watchedBrowsers(snap.browsers)
                  .map(b => ({
                    key: b.key,
                    name: b.name,
                    running: b.running,
                    lastReadMs: snap.profiles.find(p => p.browser === b.key)?.lastWrittenMs ?? null,
                  }))}
                findings={snap.episodes.slice(0, 6).map(e => ({ browser: e.browser ?? null, atMs: e.endMs }))}
                watching={snap.settings.enabled}
                palette={palette}
              />
                {/* The names, as real text under the disc rather than drawn on
                    it: "Google Chrome" is wider than half this column, so
                    reserving canvas room for it collapsed the disc to a coin —
                    and text themes, wraps and reads aloud, which canvas text
                    does none of. */}
                <ul className="bw-legend">
                  {watchedBrowsers(snap.browsers).map(b => (
                    <li key={b.key} className={b.running ? "on" : ""}>
                      <span className="bw-legend-dot" aria-hidden />
                      {b.name}
                    </li>
                  ))}
                </ul>
              </div>
              <section className="bw-log" id={BW_PANEL_ID} role="tabpanel" aria-labelledby={bwTabId(tab)} aria-label="What the watch has been doing">
                {snap.log.length === 0 ? (
                  <p className="bw-note">Nothing yet. The deck writes a line here each time it looks.</p>
                ) : snap.log.map((l, i) => (
                  <div className={`bw-log-line ${l.level}`} key={`${l.atMs}-${i}`}>
                    {/* 24-hour, and not the reader's locale. An en-US clock
                        renders "06:28:55 PM", which is four characters wider than
                        the column and collided with the text beside it — and a
                        log is written in 24-hour time everywhere anyway. */}
                    <span className="bw-log-time">
                      {new Date(l.atMs).toLocaleTimeString("en-GB", { hour12: false })}
                    </span>
                    <span className="bw-log-text">{l.text}</span>
                  </div>
                ))}
              </section>
            </div>
          )}

          {tab === "history" && grouped.map((g, i) => (
            <section className="bw-day" key={g.label} {...(i === 0 ? { id: BW_PANEL_ID, role: "tabpanel", "aria-labelledby": bwTabId(tab) } : {})}>
              <h4>{g.label}</h4>
              {g.episodes.map(e => {
                const id = `${e.host}-${e.startMs}`;
                const isOpen = open === id;
                return (
                  <div className={`bw-ep${isOpen ? " open" : ""}`} key={id}>
                    <button
                      className="bw-ep-head"
                      onClick={() => setOpen(isOpen ? null : id)}
                      aria-expanded={isOpen}
                    >
                      <span className="bw-ep-host">{e.host}</span>
                      <span className="bw-ep-meta">
                        {span(e)}
                        {lasted(e) && <> · {lasted(e)}</>}
                        {" · "}
                        {e.count} {e.count === 1 ? "page" : "pages"}
                      </span>
                      <span className="bw-ep-chev" aria-hidden>{isOpen ? "▾" : "▸"}</span>
                    </button>
                    {isOpen && (
                      <ul className="bw-urls">
                        {e.urls.map((u, i) => (
                          <li key={`${u.url}-${u.timeMs}-${i}`}>
                            <span className="bw-url-time">
                              {new Date(u.timeMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                            </span>
                            <span className="bw-url">{u.url}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </section>
          ))}

          {snap && (
            <section className="bw-foot">
              {/* One line, expandable. Which browsers are watched is asked once
                  and then known; it was standing at the same weight as the
                  findings, which are the reason the panel exists. */}
              <button className="bw-foot-head" onClick={() => setShowBrowsers(v => !v)} aria-expanded={showBrowsers}>
                <span className="bw-foot-chev" aria-hidden>{showBrowsers ? "▾" : "▸"}</span>
                {watching.length} of {(snap.browsers ?? []).length} browsers watched
                {live.length > 0 && <span className="bw-foot-live"> · {live.join(", ")} running</span>}
              </button>

              {showBrowsers && (
                <ul className="bw-browsers">
                  {(snap.browsers ?? []).map(b => (
                    <li key={b.key} className={b.installed ? "" : "absent"}>
                      <span className="bw-prof-name">{b.name}</span>
                      <span className="bw-prof-meta">
                        {!b.installed ? "not installed"
                          : b.profiles === 0 ? "installed, never opened"
                          : `${b.profiles} profile${b.profiles === 1 ? "" : "s"}`}
                        {b.withExtension.length > 0 && " · Claude extension"}
                        {b.installed && (b.running ? " · running" : " · not running")}
                      </span>
                      {b.installed && b.running && (
                        <span className={`bw-relay ${b.relay.state}`} title={b.relay.why}>
                          {b.relay.state === "live" ? `relay: ${b.relay.count}`
                            : b.relay.state === "none-seen" ? "relay: none seen"
                            : "relay: cannot tell"}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {snap && why && (
            <div className="bw-settings">
              <label title={
                "A program opening a page counts as a finding only if nobody had touched the browser "
                + "for this long. Shorter catches more and reports more of your own work; longer is quieter."
              }>
                <span>Nobody browsing for</span>
                <select value={quiet} onChange={e => { setQuiet(Number(e.target.value)); void save({ quietMinutes: Number(e.target.value) }); }}>
                  <option value={1}>1 min</option>
                  <option value={5}>5 min</option>
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                  <option value={60}>60 min</option>
                </select>
              </label>

              <label>
                <span>When it finds one</span>
                <select
                  value={snap.settings.reaction}
                  onChange={e => void save({ reaction: e.target.value as WatchSettings["reaction"] })}
                  disabled={!snap.settings.enabled}
                  title={snap.settings.enabled
                    ? "What to do besides writing it down."
                    : "Turn watching on to arm a reaction."}
                >
                  {(snap.reactions ?? ["notify"]).map(r => (
                    <option key={r} value={r}>
                      {r === "notify" ? "notify me"
                        : r === "close-tab" ? "close the tab"
                        : "quit the browser"}
                    </option>
                  ))}
                </select>
              </label>

              <p className="bw-settings-note">
                Chrome marks a navigation that came from an extension or a command rather than from a
                click. These are the ones that happened while nobody had touched the browser for the
                time above. <strong>Usually that is your own agent doing what you asked.</strong>{" "}
                Nothing from before this deck started is read, and every address is written in full to{" "}
                <code className="bw-path">{snap.coverage.logPath}</code>.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
