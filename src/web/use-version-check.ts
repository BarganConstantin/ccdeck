// Is this deck running the code it was last upgraded to?
//
// A deck upgraded while it was running keeps executing the old code, silently
// and indefinitely. Nothing else in the product can tell you that, so this asks
// the server which version it actually booted with, and the banner and the chip
// are drawn from the answer.
//
// Lifted out of App.tsx's `Inner` unchanged. It sat under a section banner
// reading "version drift" that also covered the SSE stream's `live` and
// `tabCapped` flags above it and the whole desktop-app updater below it —
// neither of which is this concern. `live` is now a parameter, because the one
// thing this needs from the stream is the moment it comes back; the desktop
// updater stays where it was.
//
// What the extraction is worth beyond the line count: four of these eleven
// names stop being visible to the other five thousand lines. `setVersion`,
// `setVersionChecking`, `forceVersionIfStale` and the forced-check timestamp are
// this hook's business, and nothing outside it should be able to reach them.
// The banner's show and dismiss joined it afterwards. They had been left in
// `Inner` and were the only reason `setVersionDismissed` and the storage key it
// writes had to leave this file at all. With them here, the dismissal — which
// version was put away, and where that is remembered — is private too, and
// App.tsx asks for exactly four things about the notice: what it is, whether it
// is showing, and the two ways to change that.
import { useCallback, useEffect, useRef, useState } from "react";

import { noticeIsOpen, noticeKeyFor } from "./version-chip";

const VERSION_DISMISSED_KEY = "agent-dag.versionNoticeDismissed";

// How stale the last registry lookup may get before a poll asks npm again
// instead of accepting the server's cached answer. Three times the poll
// interval: long enough that a run of forced checks cannot turn the ~20-byte
// registry GET into traffic — the cost stays the one request the README
// advertises — and short enough that a release published while somebody is
// looking at the deck still reaches them inside the poll's next few turns.
const VERSION_FORCE_MS = 15 * 60_000;

/** The banner the server decided to offer, if any. */
export type VersionNotice = { kind: "restart" | "upgrade"; from: string; to: string };

/** What GET /api/version answers. `running` is the version this server process
 *  booted with; `installed` is what is on disk right now. They diverge the
 *  moment npm upgrades a deck that is already running, and Node's module cache
 *  means the process keeps executing the old code until it restarts. */
export type VersionInfo = {
  /** The package the server asked npm about, which is the one its `command`
   *  would install — `ccdeck` for a deck started with `npx ccdeck`. */
  name: string;
  running: string | null;
  installed: string | null;
  /** npm's newest version that is confirmed installable under `name`. */
  latest: string | null;
  /** A version npm's dist-tag names that the registry cannot serve yet. Never
   *  offered: the tag moves before the version does, and a restart taken inside
   *  that window fails with ETARGET. */
  latestPending?: string | null;
  notice: VersionNotice | null;
  command: string;
  // False when nothing is supervising the process, or when --no-persist means a
  // restart would take the canvas with it.
  canRestart?: boolean;
  /** When npm was last asked, so the chip can say it. Null when the check is off. */
  checkedAt?: number | null;
  /** When the last attempt FAILED, null once one succeeds.
   *
   *  Computed, serialised, delivered — and until #1046 declared nowhere on this
   *  side, so it was dropped at the door. The server's own comment says what it
   *  is for: "the single most common reason for a missing update button — a
   *  proxy, a flaky line, an offline machine — is indistinguishable from being
   *  up to date" without it. And `checkedAt` deliberately does NOT move on a
   *  failure ("checked 2 minutes ago" over an hour-old answer is the one thing
   *  that field must never say), so on a machine behind a proxy the chip said
   *  `checked 3h ago` beside a cached `npm has vX` and offered nothing, with
   *  the one fact that explained it sitting unread in the response. */
  checkFailedAt?: number | null;
  checkDisabled?: boolean;
  /** Why an in-app `npm i -g` is refused here, or null when it is allowed. */
  upgradeBlocked?: string | null;
  /** How this copy can update itself: install in place, come back through npx,
   *  or not at all — in which case the command is the whole answer. */
  upgradeMode?: "install" | "npx" | null;
  /** `at` is when the failure was recorded — the only thing that tells one
   *  failed npx relaunch from the one before it, since a retry that breaks the
   *  same way reports the same command and the same error. */
  upgrade?: { state: "idle" | "running" | "done" | "failed"; command: string | null; error: string | null; at?: number | null };
  /** Which of the three published commands the user typed, when the server can
   *  prove it — and null everywhere it cannot: a global install on Windows,
   *  where npm's shim swallows the name before the process starts, and a git
   *  checkout, where nothing was typed. Never guessed, so a null here means the
   *  notice below stays away rather than that it picks the likeliest name.
   *  Deliberately separate from `name` above, which is the upgrade target: for
   *  a global install that is the published package whichever bin was run. */
  invokedAs?: string | null;
  /** The second line of that notice, already written: the command to type next
   *  time under npx, and the reassurance that it is on the PATH already for an
   *  install — the same one ships all three. Null when there is nothing to say,
   *  which is every shape where `invokedAs` above is null too.
   *
   *  A string rather than a flag, and computed on the server rather than here,
   *  because the browser has no honest way to tell those two apart on its own —
   *  the field it used to guess from (`upgradeMode`) answers whether this copy
   *  may install over itself, which `AGENTS_DECK_NO_INSTALL=1` turns off for
   *  npx and global installs alike. The terminal row renders this same string
   *  from this same function, which is what keeps the two surfaces one answer. */
  renameFix?: string | null;
};

export interface VersionCheck {
  /** The server's answer, or null until the first one lands. */
  version: VersionInfo | null;
  /** The banner the server decided to offer, or null. */
  notice: VersionNotice | null;
  /** Whether that banner is showing. Dismissal is kept per version, so a later
   *  release brings it back rather than staying silenced for good (#804). */
  noticeOpen: boolean;
  /** Reveal the banner. Idempotent — the chip only ever reveals (#715). */
  showNotice: () => void;
  /** Put the banner away for this version, persistently. */
  dismissNotice: () => void;
  /** True only during a FORCED check, which is the only one slow enough to be
   *  worth showing. */
  versionChecking: boolean;
  /** Returns the round trip, so a caller that has to know when the answer
   *  landed can wait for it — `startUpgrade` is the one (#620). */
  loadVersion: (force?: boolean) => Promise<void>;
}

/**
 * @param live Whether this tab's event stream is connected. A reconnect is the
 *   end of a restart and the only moment the answer is known to have changed.
 */
export function useVersionCheck(live: boolean): VersionCheck {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [versionDismissed, setVersionDismissed] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try { return window.localStorage.getItem(VERSION_DISMISSED_KEY) ?? ""; } catch { return ""; }
  });
  // `force` asks npm now instead of reusing the answer cached on disk. Used by
  // the chip, because "no banner" and "no check ran" look identical from here.
  const lastForcedRef = useRef(0);
  // A forced check is a round-trip to the registry, and on a slow line that is
  // seconds during which the chip would otherwise not move at all — clicking it
  // felt like clicking nothing. Only forced checks are shown: the unforced
  // polls are answered from a marker on disk and would just make the chip
  // flicker for no reason the user could act on.
  const [versionChecking, setVersionChecking] = useState(false);
  // Returns the round trip so a caller that has to know when the answer landed
  // can wait for it — startUpgrade is the one, and holds its press lock until
  // /api/version has reported the run it just started (#620).
  const loadVersion = useCallback((force = false) => {
    if (force) { lastForcedRef.current = Date.now(); setVersionChecking(true); }
    return fetch(force ? "/api/version?refresh=1" : "/api/version")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setVersion(d as VersionInfo); })
      .catch(() => {})
      .finally(() => { if (force) setVersionChecking(false); });
  }, []);
  // Every unforced poll is answered from the server's on-disk marker, so once a
  // deck had checked, nothing it could do would ever learn about a release
  // published afterwards until that marker's hour was up — reported as seven
  // releases shipping with no banner on any of four running decks. The client is
  // the right place to decide how fresh the answer has to be, so the periodic
  // poll forces on a slower cadence of its own rather than never.
  //
  // Gated on the ref rather than forced every time, because forcing skips the
  // server's window entirely: the ~20-byte registry GET still happens at most
  // once per interval per deck, whether the trigger was the poll, a tab
  // regaining focus, or the chip — all of them stamp the same ref.
  const forceVersionIfStale = useCallback(() => {
    loadVersion(Date.now() - lastForcedRef.current >= VERSION_FORCE_MS);
  }, [loadVersion]);
  useEffect(() => {
    // Unforced: the server asks npm on the first call of its own process, so a
    // deck the user has just started is already answering with a fresh number.
    loadVersion();
    const iv = window.setInterval(forceVersionIfStale, 5 * 60_000);
    // Coming back to this tab is exactly the moment after someone ran the
    // upgrade in another window, and exactly the moment to be right — cheaper
    // and far more timely than waiting out the interval.
    const onVis = () => { if (document.visibilityState === "visible") forceVersionIfStale(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadVersion, forceVersionIfStale]);
  useEffect(() => { if (live) loadVersion(); }, [live, loadVersion]);

  const notice = version?.notice ?? null;
  // Keyed to the version it is about, so dismissing today's notice does not
  // silence next month's release — and, through `noticeOpen`, does not turn
  // off restart-to-update for good either (#804). The rule is version-chip.ts's
  // so it can be driven (#1175).
  const noticeKey = noticeKeyFor(notice);
  const noticeOpen = noticeIsOpen(notice, versionDismissed);
  // Two idempotent halves rather than one toggle (#715). The chip used to flip
  // this, which was fine while flipping it was all the chip did; it now opens
  // the release notes as well, and a click that opens a modal AND silently
  // reverses the state of the strip behind it is a click nobody can predict the
  // second time. So the chip only ever reveals — press it twice and the banner
  // is shown twice — and putting the banner away moved entirely to the × that
  // always spelled it.
  const showNotice = useCallback(() => {
    setVersionDismissed("");
    try { window.localStorage.setItem(VERSION_DISMISSED_KEY, ""); } catch { /* private mode */ }
  }, []);
  const dismissNotice = useCallback(() => {
    if (!notice) return;
    setVersionDismissed(noticeKey);
    try { window.localStorage.setItem(VERSION_DISMISSED_KEY, noticeKey); } catch { /* private mode */ }
  }, [notice, noticeKey]);

  return { version, notice, noticeOpen, showNotice, dismissNotice, versionChecking, loadVersion };
}
