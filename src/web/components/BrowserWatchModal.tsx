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
import { tabStripMove } from "../tablist-keys";

export interface WatchEpisode {
  host: string;
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
  extension: { present: boolean; enabled: boolean; allUrls: boolean; sensitiveApis: string[] } | null;
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
  level: "ok" | "info" | "warn";
  text: string;
}

interface WatchBrowser {
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
  coverage: { startedMs: number; oldestVisitMs: number | null; logPath: string; archived: number; now: number };
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
}: {
  onClose: () => void;
  onSeen: (ms: number) => void;
}) {
  const dialogRef = useModalDismiss(onClose);
  const [snap, setSnap] = useState<WatchSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quiet, setQuiet] = useState(15);
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [why, setWhy] = useState(false);
  const [tab, setTab] = useState<"history" | "live">("history");
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
      setSnap(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [quiet]);

  useEffect(() => { void load(false); }, [load]);

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

  const watched = snap?.profiles.filter(p => p.visits > 0 || p.hasClaudeExt) ?? [];

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
            <button className="btn" onClick={() => void load(true)} title="Re-read every profile now">
              {busy ? "reading…" : "refresh"}
            </button>
            <button className="btn icon-btn" onClick={onClose} aria-label="Close">×</button>
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
            <section className="bw-controls">
              <label>
                <span>Quiet for at least</span>
                <select value={quiet} onChange={e => { setQuiet(Number(e.target.value)); void save({ quietMinutes: Number(e.target.value) }); }}>
                  <option value={5}>5 min</option>
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                  <option value={60}>60 min</option>
                </select>
              </label>
              {/* A real switch, not a button whose label names the action. "turn
                  off" made the reader work out the current state from the verb
                  offered — a toggle SHOWS it, and role="switch" says the same
                  thing to a screen reader. It sits with the other two settings
                  because that is what it is. */}
              {/* CALLED "WATCHING", THE SAME WORD AS EVERYTHING ELSE. It was
                  "Keep a copy" for one revision, which describes the mechanism
                  accurately and named nothing anybody was looking for — the
                  topbar tooltip says watching, the tab's dot means watching,
                  and a person hunting for the watcher's switch read past it.
                  One thing, one name. What it actually changes is on the row
                  beside it and in the title. */}
              <label className="bw-switch-field">
                <span>Watching</span>
                <span className="bw-switch-line">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={snap.settings.enabled}
                    aria-label={`Watching, ${snap.settings.enabled ? "on" : "off"}`}
                    className="bw-toggle"
                    onClick={() => void save({ enabled: !snap.settings.enabled })}
                    title={snap.settings.enabled
                      ? "On — the deck keeps its own copy, so an episode it has seen survives the browsing history being cleared"
                      : "Off — the list below is still read live from the browser's own history; clearing that history would lose it"}
                  >
                    <span className="bw-toggle-knob" />
                  </button>
                  <span className="bw-switch-state">
                    {saving ? "saving"
                      : snap.settings.enabled ? `on · ${snap.coverage.archived} kept`
                      : "off"}
                  </span>
                </span>
              </label>

              {/* Only the modes this platform can carry out. A reaction that
                  silently does nothing is worse than one never offered: the
                  user arms it, believes they are covered, and finds out on the
                  day it mattered. `close-tab` is macOS-only — AppleScript is
                  the one interface that can close a single tab by URL. */}
              <label>
                <span>When it finds one</span>
                <select
                  value={snap.settings.reaction}
                  onChange={e => void save({ reaction: e.target.value as WatchSettings["reaction"] })}
                  disabled={!snap.settings.enabled}
                  title={snap.settings.enabled
                    ? "What to do besides writing it down."
                    : "Turn Watching on to arm a reaction."}
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

              <div className="bw-count">
                <strong>{snap.episodes.length}</strong>
                <span>{snap.episodes.length === 1 ? "episode" : "episodes"}</span>
                <button className="bw-why" onClick={() => setWhy(w => !w)} aria-expanded={why}>
                  what is this?
                </button>
              </div>
            </section>
          )}

          {why && (
            <p className="bw-lead">
              Chrome marks a navigation that came from an extension or a command rather than from a
              click. These are the ones that happened while nobody had touched the browser for {quiet} minutes.{" "}
              <strong>Usually that is your own agent doing what you asked.</strong> Worth a look when it is not.
              Nothing from before this deck started is read.
            </p>
          )}


          {snap && (
            /* Two views, because they answer two questions. The list says what
               happened; the log says whether anything is looking. A watch whose
               only output is an empty list cannot tell "I checked, and there was
               nothing" from "I am not checking", and the shell tool this
               descends from was trusted largely because it said the first one
               out loud, every few minutes, in a running commentary. */
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
                  // One tab stop for the whole strip, which is the other half of
                  // what the role means; the modal's focus trap already skips a
                  // negative tabIndex.
                  tabIndex={tab === t.id ? 0 : -1}
                  className={`bw-tab${tab === t.id ? " on" : ""}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                  {t.id === "live" && snap.settings.enabled && <span className="bw-tab-live" aria-hidden />}
                </button>
              ))}
            </div>
          )}
          {snap && tab === "history" && snap.episodes.length === 0 && (
            <div className="bw-empty">
              <strong>Nothing a program did on its own</strong>
              <p>
                Nothing has been driven by a program since this deck started.
                {snap && <> Watching since {new Date(snap.coverage.startedMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.</>}
              </p>
            </div>
          )}

          {snap && tab === "live" && (
            <section className="bw-log" id={BW_PANEL_ID} role="tabpanel" aria-labelledby={bwTabId(tab)} aria-label="What the watch has been doing">
              {snap.log.length === 0 ? (
                <p className="bw-note">Nothing yet. The deck writes a line here each time it looks.</p>
              ) : snap.log.map((l, i) => (
                <div className={`bw-log-line ${l.level}`} key={`${l.atMs}-${i}`}>
                  <span className="bw-log-time">
                    {new Date(l.atMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className="bw-log-text">{l.text}</span>
                </div>
              ))}
            </section>
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
              <h4>Browsers</h4>
              {/* Every browser the deck knows how to look at, installed or not.
                  "Chrome is installed and has never been opened" and "Chrome is
                  not installed" are different answers, and a list of only what
                  was found cannot tell them apart. */}
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
                        {b.relay.state === "live" ? `relay: ${b.relay.count} connection${b.relay.count === 1 ? "" : "s"}`
                          : b.relay.state === "none-seen" ? "relay: none seen"
                          : "relay: cannot tell"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <p className="bw-note">
                Only navigations since a deck was watching are read — nothing from before that,
                and nothing while it is down.
                {snap && (
                  <> Every address is written in full to{" "}
                    {/* Selectable in one click, because the next thing a person
                        does with this path is paste it into a terminal. */}
                    <code className="bw-path">{snap.coverage.logPath}</code>{" "}
                    — query strings and fragments included, so an inspection later
                    can tell a jobs list from a settings page.</>
                )}
                {" "}A relay reading is never conclusive: the name shares an address with
                api.anthropic.com, and this probe cannot see some browsers' sockets at all.
                {snap.degraded && " One profile could not be read in full; see the activity log."}
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
