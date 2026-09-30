// The snapshot Browser Watch reads, and what the panel derives from it.
//
// The shapes are what /api/browser-watch answers — server/browser-watch.mjs
// builds them — and the functions are the panel's pure reads of that answer:
// labels, totals, the trouble banner, the quiet gate's countdown. None of them
// renders anything, so they live apart from the dialog: the dialog imports
// them, and so does the suite, without loading a component to reach a sum.

import { fmtBytes } from "./byte-format";

export interface WatchEpisode {
  host: string;
  /** Which browser it happened in — a reaction has to tell one application to
   *  close a tab, and the radar has to know which blip the finding left from. */
  browser: string | null;
  startMs: number;
  endMs: number;
  count: number;
  urls: { url: string; timeMs: number }[];
  /** A page in it is still inside its quiet window, so a person's visit in the
   *  next few minutes can withdraw it. Not yet written down or reacted to. */
  provisional?: boolean;
}

export interface WatchProfile {
  browser: string;
  name: string;
  profile: string;
  hasClaudeExt: boolean;
  visits: number;
  /** What a PROGRAM opened, ungated — not the same as a finding, which also has
   *  to clear the quiet gate. */
  programVisits: number;
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

/** What relay-guard.mjs can say about this machine, read by browser-watch.mjs
 *  and rendered by components/RemoteControl.tsx (#799). */
export interface RelayGuard {
  relayHost: string;
  hostsPath: string;
  /** Whether the hosts file could be read at all. `blocked: false` from an
   *  unreadable file and from a file with no entry are the same value and not
   *  the same fact. */
  hostsRead: boolean;
  profiles: Array<{
    browser: string;
    name: string;
    profile: string;
    /** Null when the profile's "Secure Preferences" could not be read. Not the
     *  same as "no permissions", and the panel says which. */
    report: { present: boolean; enabled: boolean; allUrls: boolean; sensitiveApis: string[] } | null;
  }>;
  anyExtension: boolean;
  killswitch: { blocked: boolean; ours: string[]; foreign: string[] };
  verdict: "exposed" | "protected" | "nothing-exposed";
  command: Record<"block" | "unblock", { command: string; needsAdmin: boolean; note: string }>;
}

export interface WatchSnapshot {
  ok: true;
  settings: WatchSettings;
  /** Null on a poll that read no browser — the archive-only path. */
  relay: RelayGuard | null;
  reactions: WatchSettings["reaction"][];
  log: WatchLine[];
  profiles: WatchProfile[];
  browsers: WatchBrowser[];
  episodes: WatchEpisode[];
  coverage: { startedMs: number; oldestVisitMs: number | null; lastHumanMs: number | null; quietMs: number; logPath: string; logBytes?: number; checkedMs: number; checks: number; archived: number; now: number };
  degraded: boolean;
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
 * What watch.log holds on disk, said beside the path the panel already names
 * (#989), so the one file in this feature that used to grow without a bound
 * shows the bound holding.
 *
 * NEVER A ZERO FOR A FILE WITH SOMETHING IN IT. The sentence this sits in says
 * every address is written in full, and "0 KB" beside a file holding four of
 * them would contradict it. A log never written says "empty".
 *
 * Every other size is the deck's one byte format (#1663). This printed whole
 * kilobytes of its own, so 1,100 bytes read "1 KB" here and "1.1 KB" in every
 * other panel. fmtBytes keeps the rule above without help: it goes down to
 * bytes, and a count of one reads "1.0 B".
 */
export function logBytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "empty";
  return fmtBytes(bytes);
}

/** What the watch actually reads: visits per browser, summed across its
 *  profiles, because a browser is what the reader names and a profile is how
 *  the deck stores it. */
export function visitTotals(
  browsers: WatchBrowser[],
  profiles: { browser: string; programVisits: number }[],
): { key: string; name: string; visits: number; running: boolean | null }[] {
  // WHAT A PROGRAM OPENED, not every row in the history. This counted all of
  // them, and on a measured profile 58 of 74 were the reader's own browsing —
  // so the panel's largest figure was 78% a different subject, and `23` read as
  // "23 things to look at" when none of them were.
  //
  // Ungated on purpose, and so NOT the same as the findings count beside it: a
  // finding also has to clear the quiet gate. This is "what programs did", the
  // findings are "what they did while you were away", and the two together are
  // the shape of the answer.
  return browsers.map(b => ({
    key: b.key,
    name: b.name,
    running: b.running,
    visits: profiles.filter(p => p.browser === b.key).reduce((n, p) => n + p.programVisits, 0),
  }));
}

/** `12 sec ago`, `4 min ago`, or null when nothing has been read yet. Said in
 *  full words rather than `12s`: this sits beside figures, and two numbers side
 *  by side invite being read as one quantity. */
export function agoLabel(atMs: number | null, nowMs: number): string | null {
  if (atMs === null) return null;
  const secs = Math.max(0, Math.round((nowMs - atMs) / 1000));
  // "0 sec ago" is a machine reading a clock out loud. Under five seconds the
  // honest thing a person says is "just now".
  if (secs < 5) return "just now";
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
