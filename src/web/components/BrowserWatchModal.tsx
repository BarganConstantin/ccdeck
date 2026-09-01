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
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useModalDismiss } from "./use-modal-dismiss";

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

export interface WatchSnapshot {
  ok: true;
  settings: WatchSettings;
  verdict: "nothing-exposed" | "protected" | "exposed";
  relay: {
    path: string;
    readable: boolean;
    blocked: boolean | null;
    ours: string[];
    foreign: string[];
    command: { command: string; needsAdmin: boolean; note: string } | null;
  };
  profiles: WatchProfile[];
  episodes: WatchEpisode[];
  coverage: { requestedSinceMs: number; oldestVisitMs: number | null; archived: number; now: number };
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

const VERDICT_COPY: Record<WatchSnapshot["verdict"], { label: string; detail: string; tone: string }> = {
  "nothing-exposed": {
    label: "Nothing exposed",
    detail: "The Claude in Chrome extension is not installed in any browser here.",
    tone: "ok",
  },
  protected: {
    label: "Protected",
    detail: "The relay does not resolve, so no new session can attach. A connection the browser already holds survives until it restarts.",
    tone: "ok",
  },
  exposed: {
    label: "Exposed",
    detail: "Any Claude Code session signed in to your Anthropic account — on any machine — can attach to this browser without a prompt here.",
    tone: "err",
  },
};

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
  const [days, setDays] = useState(30);
  const [quiet, setQuiet] = useState(15);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/browser-watch?days=${days}&quiet=${quiet}${refresh ? "&refresh=1" : ""}`);
      if (!r.ok) throw new Error(`the deck answered ${r.status}`);
      setSnap(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [days, quiet]);

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

  const copy = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

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

  const v = snap ? VERDICT_COPY[snap.verdict] : null;
  const watched = snap?.profiles.filter(p => p.visits > 0 || p.hasClaudeExt) ?? [];
  const reach = snap?.coverage.oldestVisitMs ?? null;

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
          {error && (
            <div className="bw-verdict err">
              <strong>Could not read</strong>
              <p>{error}</p>
            </div>
          )}

          {v && snap && (
            <section className={`bw-verdict ${v.tone}`}>
              <strong>{v.label}</strong>
              <p>{v.detail}</p>
              {snap.relay.command && snap.verdict !== "nothing-exposed" && (
                <div className="bw-cmd">
                  <div className="bw-cmd-label">
                    {snap.relay.blocked ? "To allow the relay again" : "To close it"} — run this yourself; the deck never asks for your password.
                  </div>
                  <code>{snap.relay.command.command}</code>
                  <button className="btn" onClick={() => copy(snap.relay.command!.command)}>
                    {copied ? "copied" : "copy"}
                  </button>
                  <p className="bw-cmd-note">{snap.relay.command.note}</p>
                </div>
              )}
              {snap.relay.foreign.length > 0 && (
                <p className="bw-foreign">
                  Something else already maps this host in {snap.relay.path}:{" "}
                  {snap.relay.foreign.map(l => <code key={l}>{l}</code>)}
                </p>
              )}
            </section>
          )}

          {snap && (
            <section className={`bw-switch${snap.settings.enabled ? " on" : ""}`}>
              <div className="bw-switch-text">
                <strong>{snap.settings.enabled ? "Watching" : "Not watching"}</strong>
                <p>
                  {snap.settings.enabled
                    ? <>The deck is keeping its own copy of what it finds, so an episode it has
                        already seen survives the browsing history being cleared.
                        {snap.coverage.archived > 0 && <> {snap.coverage.archived} kept so far.</>}</>
                    : <>The list below is read live out of the browser's own history, which works
                        whether or not the deck was running. Turn this on and the deck also writes
                        down what it sees — the half a cleared history would otherwise take with it.</>}
                </p>
              </div>
              <button
                className="btn"
                onClick={() => void save({ enabled: !snap.settings.enabled })}
                aria-pressed={snap.settings.enabled}
              >
                {saving ? "saving…" : snap.settings.enabled ? "turn off" : "turn on"}
              </button>
            </section>
          )}

          {snap && (
            <section className="bw-controls">
              <label>
                <span>Look back</span>
                <select value={days} onChange={e => { setDays(Number(e.target.value)); void save({ windowDays: Number(e.target.value) }); }}>
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                </select>
              </label>
              <label>
                <span>Quiet before it counts</span>
                <select value={quiet} onChange={e => { setQuiet(Number(e.target.value)); void save({ quietMinutes: Number(e.target.value) }); }}>
                  <option value={5}>5 min</option>
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                  <option value={60}>60 min</option>
                </select>
              </label>
            </section>
          )}

          {snap && snap.episodes.length === 0 && (
            <div className="bw-empty">
              <strong>Nothing a program did on its own</strong>
              <p>
                Every navigation in the last {days} days happened while somebody was using the browser.
                {reach !== null && <> The oldest visit on record is {day(reach)}.</>}
              </p>
            </div>
          )}

          {snap && snap.episodes.length > 0 && (
            // Said once, above the list, because without it the first row reads
            // as an accusation with no evidence: "www.google.com · 1 page" is
            // meaningless until you know both what put it there and what it is
            // not. Most of these are the reader's own agent doing what they
            // asked, and the panel should say so before they wonder.
            <p className="bw-lead">
              {snap.episodes.length} {snap.episodes.length === 1 ? "time" : "times"} in the last {days} days,
              a program opened a page here while nobody had used the browser for {quiet} minutes.
              Chrome marks these itself — it is how it records a navigation that came from an
              extension or a command rather than from a click.{" "}
              <strong>Usually that is your own agent doing what you asked.</strong>{" "}
              Worth a look when it is not.
            </p>
          )}

          {grouped.map(g => (
            <section className="bw-day" key={g.label}>
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
              <h4>Watched</h4>
              <ul className="bw-profiles">
                {watched.map(p => (
                  <li key={`${p.browser}/${p.profile}`}>
                    <span className="bw-prof-name">{p.name}{p.profile !== "Default" && ` · ${p.profile}`}</span>
                    <span className="bw-prof-meta">
                      {p.visits.toLocaleString()} visits
                      {p.hasClaudeExt && p.extension?.allUrls && " · extension can read every site"}
                      {p.hasClaudeExt && p.extension?.enabled === false && " · extension disabled"}
                      {!p.hasClaudeExt && " · no Claude extension"}
                      {p.degraded && ` · ${p.reason ?? "could not read"}`}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="bw-note">
                Read from each browser's own history, which it writes whether or not the deck is running —
                so a deck that was closed all weekend still answers for it.
                {snap.degraded && " One profile could not be read in full; see the note beside it."}
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
