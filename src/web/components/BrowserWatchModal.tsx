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
import { selfPressAccepted, selfPressProps } from "../panel-press";

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
  /** Present only on a profile read, which is the one line shape that HAS
   *  columns. Everything else — "still watching 2 profiles", "closed the tab" —
   *  is the deck talking rather than an event with a browser and a number, and
   *  renders as a different kind of row. */
  parts?: { browser: string; profile: string; value: string; flagged: number };
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

/**
 * What the bar says about the watch, and which of four things it is saying.
 *
 * The kind exists so the text can cross-fade when the meaning changes without
 * flickering while the countdown counts: `counting` holds for fourteen minutes
 * while its own last characters move every second.
 */
export function barState(
  snap: { settings: { enabled: boolean }; coverage: { lastHumanMs: number | null; quietMs: number; archived: number } },
  saving: boolean,
  nowMs: number,
): { kind: "saving" | "off" | "watching" | "counting"; word: string; detail: string } {
  if (saving) return { kind: "saving", word: "Saving", detail: "" };
  if (!snap.settings.enabled) return { kind: "off", word: "Paused", detail: "showing this run only" };
  const left = armsIn(snap.coverage.lastHumanMs, snap.coverage.quietMs, nowMs);
  // The gate, said as the thing a person sitting at the browser wants to know:
  // not "quiet gate 15m" but "a page opened now would not count, and here is
  // when it would".
  return left === null
    ? { kind: "watching", word: "Watching", detail: `${snap.coverage.archived} kept` }
    : { kind: "counting", word: "Watching", detail: `you are browsing · counts in ${untilLabel(left)}` };
}

/**
 * What this deck can honestly say about a browser's link to Anthropic's relay.
 *
 * IT USED TO PRINT `relay: 2`, AND TWO OF WHAT WAS THE QUESTION NOBODY COULD
 * ANSWER. The number counted ESTABLISHED TCP sockets from that browser to an
 * address `bridge.claudeusercontent.com` resolves to — an address it SHARES
 * with claude.ai and api.anthropic.com. So two could be two agent channels or
 * two open claude.ai tabs, and the count implied a precision the probe does not
 * have. What was actually observed is a connection, so a connection is what it
 * says; the qualification stays on the badge's title, where it reads as a
 * detail rather than as a correction to the label.
 */
export function relayLabel(state: "live" | "none-seen" | "unknown"): string {
  if (state === "live") return "connected to Anthropic";
  if (state === "none-seen") return "no connection seen";
  return "cannot tell";
}

/**
 * How many visits each watched browser contributed to the current read.
 *
 * The panel had a disc and a transcript and no NUMBER anywhere — "is this
 * alive" and "what exactly happened", with "how much" missing between them.
 * Summed across a browser's profiles, because a browser is what the reader
 * names and a profile is how the deck stores it.
 */
export function visitTotals(
  browsers: WatchBrowser[],
  profiles: { browser: string; visits: number }[],
): { key: string; name: string; visits: number; running: boolean | null }[] {
  return browsers.map(b => ({
    key: b.key,
    name: b.name,
    running: b.running,
    visits: profiles.filter(p => p.browser === b.key).reduce((n, p) => n + p.visits, 0),
  }));
}

/** `12 sec ago`, `4 min ago`, or null when nothing has been read yet. Said in
 *  full words rather than `12s`: this sits under a number, and two numbers
 *  side by side invite being read as one quantity. */
export function agoLabel(atMs: number | null, nowMs: number): string | null {
  if (atMs === null) return null;
  const secs = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (secs < 60) return `${secs} sec ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} hr ago`;
}

/**
 * What the panel should be saying about itself right now, when that is not
 * simply "watching and nothing happened".
 *
 * A monitoring tool is judged on its bad states, because they are when somebody
 * actually looks at it. These existed in the data and had no designed form: a
 * profile the deck could not read said so in a log line and nowhere else, and a
 * machine with no browser open was indistinguishable from a quiet one.
 *
 * Returns null when the ordinary case holds, so the banner is absent rather
 * than reassuring — a panel that says "everything is fine" on every render
 * teaches its reader to stop looking at that line.
 */
export function watchTrouble(snap: {
  profiles: { name: string; profile: string; degraded: boolean; reason: string | null }[];
  browsers: WatchBrowser[];
}): { kind: "no-profiles" | "none-running" | "unreadable"; text: string } | null {
  const unreadable = snap.profiles.filter(p => p.degraded);
  if (unreadable.length > 0) {
    // The reason comes from the reader that failed — "database is locked",
    // "no such file" — and is worth more than any sentence written here,
    // because it is the one thing that says WHICH failure this is.
    const first = unreadable[0];
    const rest = unreadable.length - 1;
    return {
      kind: "unreadable",
      text: `${first.name}/${first.profile} could not be read — ${first.reason ?? "no reason given"}`
        + (rest > 0 ? `, and ${rest} more` : "")
        + ". The watch continues on the profiles it can read.",
    };
  }
  const watched = watchedBrowsers(snap.browsers);
  if (watched.length === 0) {
    return {
      kind: "no-profiles",
      text: "No browser on this machine has a profile to read. Open one of the browsers below once and it will be watched from then on.",
    };
  }
  if (!watched.some(b => b.running)) {
    return {
      kind: "none-running",
      text: "No watched browser is running, so nothing can be navigated right now. Their history is still read, and anything found while they were open is still here.",
    };
  }
  return null;
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
/* Activity first, because it is the view that opens and the one that answers
   "is this working". `Log` named the implementation — it sounds like debug
   output, and the question somebody brings to this view is not a question
   about logs. */
const TABS = [
  { id: "live" as const, label: "Activity" },
  { id: "history" as const, label: "Episodes" },
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
  const busyRef = useRef(false);
  /* Null until the first snapshot answers. The stored value is the truth and
     this control only displays it — seeded from a literal, it showed 15 to
     somebody who had chosen 1, and then sent that 15 back on every poll. */
  const [quiet, setQuiet] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [why, setWhy] = useState(false);
  const [access, setAccess] = useState(false);
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
    /* #620 leaves the pressed control enabled, so the HANDLER is what refuses
       the second press. Read off a ref rather than `busy`: the state a handler
       closed over is a render old, and the second press lands before the next
       one. Only a forced read is guarded — the ten-second poll is not somebody
       pressing anything, and must not be turned away by a press still out. */
    if (refresh && !selfPressAccepted(busyRef.current)) return;
    busyRef.current = refresh;
    setBusy(true);
    try {
      /* NO `?quiet=`. The server treats that parameter as an override of the
         stored setting, and the panel was sending its own un-seeded default on
         every poll — so a person who chose a 1-minute gate had their episodes
         classified against 15 minutes, silently, for as long as the panel was
         open. The select saves on change, so the store is already the truth by
         the time the next poll goes out; there was never anything for the
         override to add. */
      const r = await fetch(`/api/browser-watch${refresh ? "?refresh=1" : ""}`);
      if (!r.ok) throw new Error(`the deck answered ${r.status}`);
      const next = await r.json();
      setSnap(next);
      // Follow the store, except while a save is in flight — the optimistic
      // value the user just picked must not be overwritten by a snapshot that
      // was already on its way out when they picked it.
      setQuiet(q => (q === null ? next?.settings?.quietMinutes ?? 15 : q));
      onWatching(next?.settings?.enabled === true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [onWatching]);

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
  const rest = (snap?.browsers ?? []).filter(b => !(b.installed && b.profiles > 0));
  /** The newest of the per-profile read stamps, so the disc can say how fresh
   *  the picture under it is rather than leaving the reader to guess. */
  const trouble = snap ? watchTrouble(snap) : null;
  const lastRead = (snap?.profiles ?? []).reduce<number | null>(
    (best, p) => (p.lastWrittenMs !== null && (best === null || p.lastWrittenMs > best) ? p.lastWrittenMs : best),
    null,
  );

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
            {/* Precise, and it must stay precise: this does not watch "browser
                activity", it reports navigation Chrome itself marked as coming
                from an extension or a command, in a window when nobody had
                touched the browser. The easier sentence would be a lie.
                What the old subtitle left out is the thing a first-time reader
                actually needs, which is not what is detected but where it
                goes. */}
            <span className="modal-tool-id">
              what a program opened while nobody was browsing
              <span className="bw-local"> · read and kept on this machine only</span>
            </span>
          </div>
          <div className="modal-actions">
            {/* Both glyphs, which is what every other header in the deck is:
                the accounts panel and the usage history each pair `↻` with `×`
                at the same size and weight. A worded pill beside a glyph close
                read as two different kinds of control doing the same kind of
                job, and it was the only header in the deck spelt that way.
                `…` while it works, like theirs — the busy state is the glyph,
                so the button does not change size mid-press.

                No `disabled` (#620/#518): a control that removes itself on
                press takes the focus with it and leaves the reader nowhere.
                `selfPressProps` carries `aria-busy` and leaves it enabled, and
                a second press costs nothing — the server holds one read at a
                time and hands a concurrent caller the same promise. */}
            <button
              className="glyph-btn"
              onClick={() => void load(true)}
              {...selfPressProps(busy)}
              aria-label="Re-read every profile now"
              title="Re-read every profile now"
            >{busy ? "…" : "↻"}</button>
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
            <div className="bw-toolbar">
              {/* ONE CONTAINER, TWO VIEWS. As two free-standing outlined pills
                  they read as two buttons that each do something, which is the
                  opposite of what they are: navigation between two views of one
                  subject. The outline moves from each pill to the group. */}
              <div className="bw-seg" role="tablist" aria-label="Browser watch views" onKeyDown={onTabKeys}>
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
                    className={`bw-seg-btn${tab === t.id ? " on" : ""}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                    {t.id === "history" && snap.episodes.length > 0 && (
                      <span className="bw-tab-count">{snap.episodes.length}</span>
                    )}
                  </button>
                ))}
              </div>

              {/* THREE IDEAS, THREE PLACES. This was one sentence carrying the
                  mode, what the watch currently sees, and how long until the
                  gate opens — and a reader had to take it apart every time. The
                  dot and its word are the mode; the countdown is its own
                  column; the switch that changes the mode is in the status bar
                  at the foot, next to a label that says what it controls. */}
              <div className="bw-mode">
                <span className={`bw-mode-dot${snap.settings.enabled ? " on" : ""}`} aria-hidden />
                <span className="bw-mode-word" key={barState(snap, saving, tick).kind}>
                  {barState(snap, saving, tick).word}
                </span>
                <span className="bw-mode-detail">{barState(snap, saving, tick).detail}</span>
              </div>

              <button className="bw-why" onClick={() => setWhy(w => !w)} aria-expanded={why}>
                settings
              </button>
            </div>
          )}

          {snap && trouble && (
            /* Absent when the ordinary case holds, rather than green. A line
               that says "everything is fine" on every render is one its reader
               learns to skip, and then it is worthless on the day it changes. */
            <p className={`bw-trouble ${trouble.kind}`} role="status">{trouble.text}</p>
          )}

          {snap && tab === "live" && (
            <div className="bw-work">
              {/* THE LEFT COLUMN HAS A PURPOSE NOW. It was three fragments that
                  happened to be stacked — a canvas, a legend, a footer — and
                  read as a chart that occupied whatever width was left. Two
                  named sections: how much is happening, and to what. */}
              <aside className="bw-side">
                <section className="bw-sec">
                  <h4 className="bw-sec-head">Activity overview</h4>
                  {/* The numbers the panel never had. The disc answers "is this
                      alive, and over what", which a column of figures answers
                      badly; the figures answer "how much", which the disc
                      answers badly. Neither replaces the other. */}
                  <ul className="bw-counts">
                    {visitTotals(watching, snap.profiles).map(t => (
                      <li key={t.key}>
                        <span className="bw-count-n">{t.visits.toLocaleString("en-US")}</span>
                        <span className="bw-count-of">{t.name}</span>
                      </li>
                    ))}
                  </ul>

                  <WatchRadar
                    browsers={watching.map(b => ({
                      key: b.key,
                      name: b.name,
                      running: b.running,
                      lastReadMs: snap.profiles.find(p => p.browser === b.key)?.lastWrittenMs ?? null,
                    }))}
                    findings={snap.episodes.slice(0, 6).map(e => ({ browser: e.browser ?? null, atMs: e.endMs }))}
                    watching={snap.settings.enabled}
                    palette={palette}
                  />

                  {/* THE LEGEND SAYS WHAT THE MARKS MEAN, not only which name
                      goes with which dot. Every mark on that disc encodes
                      something — the sweep is a poll, the distance out is how
                      stale a profile's read is, a ring leaving a blip is a
                      finding — and none of it was written anywhere a reader
                      could see. A visualization whose legend is a source
                      comment is one nobody can read. */}
                  <ul className="bw-legend">
                    {watching.map(b => (
                      <li key={b.key} className={b.running ? "on" : ""}>
                        <span className="bw-legend-dot" aria-hidden />
                        {b.name}
                      </li>
                    ))}
                  </ul>
                  <p className="bw-legend-key">
                    The sweep is one poll. A dot sits further out the longer it has been
                    since that browser&apos;s history was read; a ring leaving one is a finding.
                    {lastRead !== null && <> Last read {agoLabel(lastRead, tick)}.</>}
                  </p>
                </section>

                <section className="bw-sec">
                  <h4 className="bw-sec-head">Watched profiles</h4>
                  <ul className="bw-profiles">
                    {watching.map(b => (
                      <li key={b.key}>
                        <span className={`bw-prof-dot${b.running ? " on" : ""}`} aria-hidden />
                        <span className="bw-prof-name">{b.name}</span>
                        <span className="bw-prof-state">{b.running ? "running" : "idle"}</span>
                        {b.running && (
                          <span className={`bw-relay ${b.relay.state}`} title={b.relay.why}>
                            {relayLabel(b.relay.state)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {rest.length > 0 && (
                    <p className="bw-rest">
                      Not watched: {rest.map(b => b.name).join(", ")} — not installed, or installed and
                      never opened, so there is no history to read.
                    </p>
                  )}
                </section>
              </aside>

              <section className="bw-feed" id={BW_PANEL_ID} role="tabpanel" aria-labelledby={bwTabId(tab)}>
                <div className="bw-feed-head">
                  <h4 className="bw-sec-head">Live activity</h4>
                  <span className="bw-feed-count">
                    {snap.log.length} {snap.log.length === 1 ? "entry" : "entries"}
                  </span>
                </div>
                <div className="bw-log">
                  {snap.log.length === 0 ? (
                    <p className="bw-note">Nothing yet. The deck writes a line here each time it looks.</p>
                  ) : snap.log.map(l => (
                    /* Keyed on what the line SAYS, not on where it sits. The log
                       is newest-first, so a new line at the top shifts every
                       index below it — an index in the key remounts the whole
                       transcript, and the arrival animation fires on all sixteen
                       lines instead of the one that is actually new. */
                    <div
                      className={`bw-log-line ${l.level}${l.parts ? "" : " sys"}`}
                      key={`${l.atMs}-${l.level}-${l.text}`}
                    >
                      {/* 24-hour, and not the reader's locale. An en-US clock
                          renders "06:28:55 PM", which is four characters wider than
                          the column and collided with the text beside it — and a
                          log is written in 24-hour time everywhere anyway. */}
                      <span className="bw-log-time">
                        {new Date(l.atMs).toLocaleTimeString("en-GB", { hour12: false })}
                      </span>
                      {l.parts ? (
                        /* COLUMNS, because the count is what somebody scans for
                           and at the end of a sentence it lands in a different
                           place on every row — the browser's name decides where.
                           Composed on the server: a client that parsed this back
                           out of the sentence would be a second spelling of one
                           fact, and the two would eventually disagree. */
                        <>
                          <span className="bw-log-browser">{l.parts.browser}</span>
                          <span className="bw-log-profile" title={l.parts.profile}>{l.parts.profile}</span>
                          <span className="bw-log-value">
                            {l.parts.value}
                            {l.parts.flagged > 0 && (
                              <span className="bw-log-flag"> · {l.parts.flagged} flagged</span>
                            )}
                          </span>
                        </>
                      ) : (
                        /* THE DECK TALKING, not an event. "still watching 2
                           profiles — nothing new" is a different kind of
                           statement from "read 27 visits", and rendered
                           identically the two flatten into one texture. It
                           spans the columns and recedes. */
                        <span className="bw-log-sys">{l.text}</span>
                      )}
                    </div>
                  ))}
                </div>
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

          {snap && why && (
            <div className="bw-settings">
              <label title={
                "A program opening a page counts as a finding only if nobody had touched the browser "
                + "for this long. Shorter catches more and reports more of your own work; longer is quieter."
              }>
                <span>Nobody browsing for</span>
                <select value={quiet ?? snap.settings.quietMinutes} onChange={e => { setQuiet(Number(e.target.value)); void save({ quietMinutes: Number(e.target.value) }); }}>
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

              <div className="bw-settings-note">
                <p>
                  Chrome marks a navigation that came from an extension or a command rather than from a
                  click. These are the ones that happened while nobody had touched the browser for the
                  time above. <strong>Usually that is your own agent doing what you asked.</strong>
                </p>
                {/* WHAT IT TOUCHES, SAID PLAINLY. This panel watches browsing,
                    which makes "where does this go" the first question a reader
                    has and the one nothing on screen was answering. Every line
                    below is a fact about the code, not a reassurance: the read
                    floor is the deck's own start, the store is that path, and
                    the deck opens no socket for any of it. */}
                <button className="bw-why" onClick={() => setAccess(a => !a)} aria-expanded={access}>
                  {access ? "▾" : "▸"} What Browser Watch can access
                </button>
                {access && (
                  <dl className="bw-access">
                    <dt>Reads</dt>
                    <dd>
                      A copy of each browser&apos;s own history database — the live file is locked while
                      the browser holds it. Only rows newer than the moment this deck started:{" "}
                      {new Date(snap.coverage.startedMs).toLocaleString()}.
                    </dd>
                    <dt>Keeps</dt>
                    <dd>
                      Only while the switch is on, and only the episodes it flagged — never your ordinary
                      browsing. In <code className="bw-path">{snap.coverage.logPath}</code>, with every
                      address written in full so you can check it yourself.
                    </dd>
                    <dt>Sends</dt>
                    <dd>
                      Nothing. No part of this reads or writes over the network; the deck serves on
                      127.0.0.1 and this panel talks only to it.
                    </dd>
                    <dt>Does not read</dt>
                    <dd>
                      Anything from before this deck started, cookies, saved passwords, page contents, or
                      any browser profile with no history file.
                    </dd>
                  </dl>
                )}
              </div>
            </div>
          )}
          {snap && (
            /* A STATUS BAR, not debug text appended to the panel. It says the
               same thing wherever the view has scrolled to, and it is where the
               switch lives — beside a label that says what it controls, which
               an unlabelled toggle in a toolbar never did. */
            <footer className="bw-status">
              <span className={`bw-mode-dot${snap.settings.enabled ? " on" : ""}`} aria-hidden />
              <span className="bw-status-text">
                {watching.length} of {(snap.browsers ?? []).length} browsers watched
                {live.length > 0 && <span className="bw-status-dim"> · {live.join(", ")} running</span>}
              </span>
              <label className="bw-switch" htmlFor="bw-enabled">
                <span className="bw-switch-label">Watch browser activity</span>
                <button
                  id="bw-enabled"
                  type="button"
                  role="switch"
                  aria-checked={snap.settings.enabled}
                  className="bw-toggle"
                  onClick={() => void save({ enabled: !snap.settings.enabled })}
                  /* The old off-text said "the list is still read live from the
                     browser's own history", which is true and still leaves the
                     reader wrong about what they are looking at: the live read
                     starts at this deck's boot, so switching off also drops
                     every episode an earlier run had archived. They come back
                     on the way in — nothing is deleted — but a list that halves
                     itself needs the sentence that explains it. */
                  title={snap.settings.enabled
                    ? "On — every episode it finds is written down, so the list outlives the browsing history being cleared"
                    : "Off — showing only what this deck has seen since it started. Anything an earlier run archived is hidden until you switch back on, and nothing new is kept"}
                >
                  <span className="bw-toggle-knob" />
                </button>
              </label>
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}
