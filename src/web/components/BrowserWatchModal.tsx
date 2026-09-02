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
export function modeState(
  snap: { settings: { enabled: boolean }; coverage: { archived: number } },
  saving: boolean,
): { kind: "saving" | "off" | "on"; word: string; detail: string } {
  if (saving) return { kind: "saving", word: "Saving", detail: "" };
  if (!snap.settings.enabled) return { kind: "off", word: "Paused", detail: "this run only" };
  const n = snap.coverage.archived;
  return {
    kind: "on",
    word: "Watching",
    // "0 kept" was cryptic: nobody should have to work out what it counts. It
    // counts episodes the watch has recorded, so that is what it says — and at
    // zero it says the state rather than the number, because "nothing yet" is
    // a sentence and "0" is a puzzle.
    detail: n === 0 ? "nothing captured yet" : `${n} ${n === 1 ? "episode" : "episodes"} captured`,
  };
}

/** What the watch actually reads: visits per browser, summed across its
 *  profiles, because a browser is what the reader names and a profile is how
 *  the deck stores it. */
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
 *  full words rather than `12s`: this sits beside figures, and two numbers side
 *  by side invite being read as one quantity. */
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
  const [showKey, setKey] = useState(false);
  const [restOpen, setRestOpen] = useState(false);
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
  /** Watched profiles, summed — the header's scope line, which is the shortest
   *  true answer to "how much is this looking at". */
  const profileCount = watching.reduce((n, b) => n + b.profiles, 0);
  /** The quiet gate, if it is currently closed. It lives beside the numbers it
   *  decides rather than in the toolbar, where it was a third idea competing
   *  with the mode and its count. */
  const gate = snap ? armsIn(snap.coverage.lastHumanMs, snap.coverage.quietMs, tick) : null;
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
        {/* `modal-tool-id` is an IDENTIFIER slot everywhere else in the deck —
            a truncated tool id, a session id, a version range — and it was
            carrying a twelve-word sentence here. What belongs in it is the
            watch's scope, which is short, true, and happens to be the two
            things a first-time reader wants: how much is being watched, and
            where it goes. The explanation lives in the empty state and in
            "What Browser Watch can access", which is where somebody looks for
            it rather than reads past it. */}
        <header className="modal-head">
          <div className="modal-title">
            <span className="modal-tool-name" id="bw-title">Browser watch</span>
            <span className="modal-tool-id">
              {snap
                ? `${profileCount} ${profileCount === 1 ? "profile" : "profiles"} · local only`
                : "local only"}
            </span>
          </div>
          <div className="modal-actions">
            {/* Two glyphs, one component, which is what every other header in
                the deck is. `…` while it works, so the box does not change
                size mid-press. No `disabled` (#620/#518): a control that
                removes itself on press takes the focus with it, so the handler
                refuses the second press instead. */}
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
              <p>Reading each browser&apos;s history. The first look copies the file, which takes a moment.</p>
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
              {/* One container, two views: as free-standing pills they read as
                  two buttons that each do something rather than as navigation
                  between two views of one subject. */}
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

              {/* THE STATE, SAID IN WORDS SOMEBODY CAN ACT ON. It read
                  "Watching · 0 kept", and nobody should have to work out what
                  "kept" counts. It counts episodes the watch has recorded, so
                  that is what it says. The quiet gate's countdown is a
                  different fact about detection sensitivity and moved to the
                  overview, beside the numbers it qualifies. */}
              <p className="bw-mode">
                <span className={`bw-mode-dot${snap.settings.enabled ? " on" : ""}`} aria-hidden />
                <span className="bw-mode-word" key={modeState(snap, saving).kind}>
                  {modeState(snap, saving).word}
                </span>
                <span className="bw-mode-detail">{modeState(snap, saving).detail}</span>
              </p>

              <button className="bw-why" onClick={() => setWhy(w => !w)} aria-expanded={why}>
                settings
              </button>
            </div>
          )}

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
                <button className="bw-why" onClick={() => setAccess(a => !a)} aria-expanded={access}>
                  <span className="bw-chev" aria-hidden>{access ? "▾" : "▸"}</span> What Browser Watch can access
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
                    <dt>Never reads</dt>
                    <dd>
                      Anything from before this deck started, cookies, saved passwords, page contents, or
                      any browser profile with no history file.
                    </dd>
                  </dl>
                )}
              </div>
            </div>
          )}

          {snap && trouble && (
            /* Absent when the ordinary case holds, rather than green. A line
               that reads "everything is fine" on every render is one its reader
               learns to skip, and then it says nothing on the day it changes. */
            <p className={`bw-trouble ${trouble.kind}`} role="status">{trouble.text}</p>
          )}

          {snap && tab === "live" && (
            <div className="bw-work">
              <aside className="bw-side">
                <section className="bw-sec">
                  <h4 className="bw-sec-head">
                    Activity overview
                    {/* Progressive disclosure. The three-line explanation of
                        what the disc's marks mean was permanent furniture in a
                        column that has real work to do — and it is read once,
                        by one reader, on one day. Behind a press, and the press
                        is a real control with a real name rather than an icon
                        that has to be guessed at. */}
                    <button
                      className="bw-help"
                      onClick={() => setKey(k => !k)}
                      aria-expanded={showKey}
                      aria-label="What the sweep and the dots mean"
                    >?</button>
                  </h4>

                  {/* The disc is a SIGNATURE, not a chart. At 176px it was the
                      largest thing on the panel and most of what it said —
                      which browsers, running or not — was already in Watched
                      Profiles below it and in the feed beside it. What it alone
                      gives is the glance: something is sweeping, so something
                      is alive. That is worth 88px, not 176. */}
                  <div className="bw-glance">
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
                    <ul className="bw-counts">
                      {visitTotals(watching, snap.profiles).map(t => (
                        <li key={t.key}>
                          <span className="bw-count-n">{t.visits.toLocaleString("en-US")}</span>
                          <span className="bw-count-of">{t.name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Two short lines by design rather than one long one that
                      wraps wherever the column happens to end. The first says
                      what the figures ARE — rows in the browser's own history,
                      newer than this deck's start, not visits a person made and
                      not findings. The second is the only part that moves. */}
                  <p className="bw-since">History entries since this deck started</p>
                  {lastRead !== null && (
                    <p className="bw-since">Last look {agoLabel(lastRead, tick)}</p>
                  )}
                  {gate !== null && (
                    /* The quiet gate, where it belongs: beside the numbers it
                       decides. In the toolbar it was a third idea competing
                       with the mode and its count. */
                    <p className="bw-gate">You are browsing — a program page would count in {untilLabel(gate)}</p>
                  )}

                  {showKey && (
                    <dl className="bw-key">
                      <dt>Sweep</dt><dd>one poll of every watched profile</dd>
                      <dt>Dot</dt><dd>a browser, further out the longer since its history was read</dd>
                      <dt>Ring</dt><dd>a finding, leaving the browser it came from</dd>
                    </dl>
                  )}
                </section>

                <section className="bw-sec">
                  <h4 className="bw-sec-head">Watched profiles</h4>
                  <ul className="bw-profiles">
                    {watching.map(b => (
                      <li key={b.key}>
                        <span className={`bw-prof-dot${b.running ? " on" : ""}`} aria-hidden />
                        <span className="bw-prof-name">{b.name}</span>
                        <span className="bw-prof-state">{b.running ? "running" : "idle"}</span>
                        {b.running && b.relay.state === "live" && (
                          /* NEUTRAL, NOT AMBER. This was one of the strongest
                             accents on the panel, for a fact the probe cannot
                             actually establish: the relay shares an address
                             with claude.ai, so an open tab is indistinguishable
                             from an agent channel. What a tool cannot
                             distinguish must not be the loudest thing on its
                             screen. It states what was seen and keeps the
                             qualification on its title. */
                          <span className="bw-relay" title={b.relay.why}>connected to Anthropic</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {rest.length > 0 && (
                    <>
                      <button className="bw-why bw-rest-head" onClick={() => setRestOpen(v => !v)} aria-expanded={restOpen}>
                        <span className="bw-chev" aria-hidden>{restOpen ? "▾" : "▸"}</span>{" "}
                        {rest.length} not watched
                      </button>
                      {restOpen && (
                        <p className="bw-rest">
                          {rest.map(b => b.name).join(", ")} — not installed, or installed and never
                          opened, so there is no history to read.
                        </p>
                      )}
                    </>
                  )}
                </section>
              </aside>

              <section className="bw-feed" id={BW_PANEL_ID} role="tabpanel" aria-labelledby={bwTabId(tab)}>
                <h4 className="bw-sec-head bw-feed-head">
                  Live activity
                  <span className="bw-feed-count">
                    {snap.log.length} {snap.log.length === 1 ? "entry" : "entries"}
                  </span>
                </h4>
                <div className="bw-log" aria-live="polite" aria-relevant="additions">
                  {snap.log.length === 0 ? (
                    <p className="bw-note">The deck writes a line here each time it looks at a profile.</p>
                  ) : snap.log.map(l => (
                    /* Keyed on what the line SAYS, not where it sits: the log is
                       newest-first, so an index in the key remounts the whole
                       transcript and the arrival animation fires on all sixteen
                       lines instead of the one that is new. */
                    <div
                      className={`bw-log-line ${l.level}${l.parts ? "" : " sys"}`}
                      key={`${l.atMs}-${l.level}-${l.text}`}
                    >
                      {/* 24-hour and not the reader's locale: an en-US clock
                          renders "06:28:55 PM", four characters wider than the
                          column, and a log is 24-hour everywhere anyway. */}
                      <span className="bw-log-time">
                        {new Date(l.atMs).toLocaleTimeString("en-GB", { hour12: false })}
                      </span>
                      {l.parts ? (
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
                        <span className="bw-log-sys">{l.text}</span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {snap && tab === "history" && (
            /* The panel exists even when the list does not. `role="tabpanel"`
               and the id the tabs point at used to ride on the first day
               section, so a machine that had found nothing rendered no panel at
               all and `aria-controls` named an element that was not there. */
            <section className="bw-eps" id={BW_PANEL_ID} role="tabpanel" aria-labelledby={bwTabId(tab)}>
              {grouped.length === 0 ? (
                <div className="bw-empty">
                  <p className="bw-empty-head">Nothing found yet</p>
                  <p className="bw-empty-note">
                    An episode lands here when a program opens pages in a browser nobody has touched for{" "}
                    {snap.settings.quietMinutes}{" "}
                    {snap.settings.quietMinutes === 1 ? "minute" : "minutes"}. On most machines that is
                    rare, so an empty list is the ordinary result rather than a sign something is wrong.
                  </p>
                  {!snap.settings.enabled && (
                    <p className="bw-empty-note">
                      Watching is off, so this shows only what this deck has seen since it started.
                      Anything an earlier run recorded comes back when you switch it on.
                    </p>
                  )}
                </div>
              ) : grouped.map(g => (
                <div className="bw-day" key={g.label}>
                  <h4 className="bw-sec-head">{g.label}</h4>
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
                          <span className="bw-chev" aria-hidden>{isOpen ? "▾" : "▸"}</span>
                          <span className="bw-ep-host">{e.host}</span>
                          <span className="bw-ep-meta">
                            {span(e)}
                            {lasted(e) && <> · {lasted(e)}</>}
                          </span>
                          <span className="bw-ep-count">{e.count} {e.count === 1 ? "page" : "pages"}</span>
                        </button>
                        {isOpen && (
                          <ul className="bw-urls">
                            {e.urls.map((u, i) => (
                              <li key={`${u.url}-${u.timeMs}-${i}`}>
                                <span className="bw-url-time">
                                  {new Date(u.timeMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}
                                </span>
                                <span className="bw-url">{u.url}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </section>
          )}

          {snap && (
            /* THE CONTROL ZONE. It used to restate "2 of 8 browsers watched ·
               Brave running", which Watched Profiles already says two hundred
               pixels away — three places telling one fact. The left half now
               says the thing that changes with the switch and is said nowhere
               else, and the right half is the switch, labelled. */
            <footer className="bw-status">
              <span className="bw-status-text">
                {snap.settings.enabled
                  ? `Recording what it finds · ${snap.coverage.archived} ${snap.coverage.archived === 1 ? "episode" : "episodes"} on disk`
                  : "Paused — nothing new is being recorded"}
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
