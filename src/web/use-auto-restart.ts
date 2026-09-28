// Restarting the deck: the auto-update switch, the press behind the banner's
// Restart, the idle stretch an automatic one waits for, and what the banner says
// about each of them.
//
// Lifted out of App.tsx's `Inner`, where it sat under a banner reading "restart"
// that went on to head 2,300 more lines — the camera, the layout, Claude FM, the
// notifier — none of which it describes. Every setter is private, along with the
// attempt counter and the refs that keep one press from handing back another's
// result.
//
// It depends on the version state, because a restart is only ever the deck
// landing a version: `version` to see it land, `notice`/`noticeOpen` for what the
// banner is offering, and `upgradeFailure` for an npx upgrade that came back on
// the old version.
//
// Like the notifier, it is handed its half of the one /api/prefs read App.tsx
// makes, through `loadAutoRestartPrefs`, rather than reading prefs itself.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import { selfPressAccepted } from "./panel-press";
import { activeCount, autoRestartRemainingMs, autoRestartStep, restartEndedInFailure, restartLandingStep, restartSafety } from "./restart";
import type { GraphState } from "./reducer";
import type { VersionInfo, VersionNotice } from "./use-version-check";
import { readStored, removeStored } from "./storage";

const AUTO_RESTART_KEY = "agent-dag.autoRestart";
// Per-tab, not per-browser: it guards one reload, not a preference.
const BUNDLE_RELOAD_KEY = "agent-dag.bundleReloadedFor";

export interface AutoRestartDeps {
  /** The clock the banner's fuse is read against, ticking in App.tsx. */
  now: number;
  stateRef: MutableRefObject<GraphState>;
  version: VersionInfo | null;
  notice: VersionNotice | null;
  noticeOpen: boolean;
  upgradeFailure: string | null;
}

/** What /api/prefs answers, as far as this hook reads it. */
export interface AutoRestartPrefsAnswer {
  prefs?: { autoUpdate?: boolean };
}

export function useAutoRestart({ now, stateRef, version, notice, noticeOpen, upgradeFailure }: AutoRestartDeps) {
  // ── restart ───────────────────────────────────────────────────────────────
  // The server cannot restart itself without racing its own listener onto a
  // random fallback port, so the supervisor owns it and this only asks.
  const [autoRestart, setAutoRestart] = useState<boolean>(() => readStored(AUTO_RESTART_KEY) !== "0");
  /** Whether this page has pressed the switch. A press is newer than anything
   *  the prefs load can bring back, so that load leaves the switch alone. */
  const autoTouchedRef = useRef(false);
  // ON THE SERVER NOW, as `autoUpdate` in prefs.json: the deck also updates
  // itself while nobody is looking at it — with no page open at all — and that
  // needs the same answer (auto-update.mjs). The initialiser above still reads
  // the old key so a switch turned off before the move renders off at once; the
  // prefs load further down carries it over and removes it. Optimistic like the
  // notifications switch, and corrected by the server's answer.
  const toggleAutoRestart = useCallback(() => {
    const next = !autoRestart;
    autoTouchedRef.current = true;
    removeStored(AUTO_RESTART_KEY);
    setAutoRestart(next);
    fetch("/api/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoUpdate: next }),
    }).then(r => (r.ok ? r.json() : null)).then(d => {
      if (d?.ok) setAutoRestart(d.prefs?.autoUpdate !== false);
    }).catch(() => {});
  }, [autoRestart]);
  const [restarting, setRestarting] = useState(false);
  // "npx" gets its own word everywhere, because it is a download and not a
  // process restart: it takes tens of seconds, and a banner that says
  // "restarting…" for a minute reads as a hang.
  const [restartMode, setRestartMode] = useState<"restart" | "npx">("restart");
  const [restartedTo, setRestartedTo] = useState<string | null>(null);
  const restartAskedRef = useRef(false);
  // The failure the server was already reporting when this attempt started, so
  // the one it reports afterwards can be told apart from it. Without that, the
  // note left by the previous failed npx relaunch — still on disk until the
  // supervisor clears it at the top of the next one — would read as this
  // attempt's own outcome the moment the retry was clicked.
  const askedFailureRef = useRef<string | null>(null);
  // Counts asks, so a timeout only ever hands back the state of the attempt
  // that armed it. Now that a failure ends an attempt early, a retry can be
  // running while its predecessor's three minutes are still on the clock.
  const restartAttemptRef = useRef(0);
  const askRestart = useCallback(async (opts?: { upgrade?: boolean }) => {
    // The guard the `disabled` used to be, now that the two buttons that call
    // this stay enabled while their own request is out (#620). It was already
    // here as `if (restartAskedRef.current) return` — the ref is what a second
    // Enter meets, and the rule is what it is spelled as.
    if (!selfPressAccepted(restartAskedRef.current)) return;
    const upgrade = opts?.upgrade === true;
    restartAskedRef.current = true;
    askedFailureRef.current = upgradeFailure;
    const attempt = ++restartAttemptRef.current;
    setRestartMode(upgrade ? "npx" : "restart");
    setRestarting(true);
    // Remembered across the reconnect so the deck can confirm what it landed
    // on rather than claiming success the moment the request was accepted.
    try { window.sessionStorage.setItem("agent-dag.restartPending", notice?.to ?? ""); } catch {}
    // The socket dying IS the restart, so a rejection here is a success signal
    // as often as a failure one — neither is worth acting on.
    try {
      await fetch("/api/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upgrade }),
      });
    } catch { /* expected */ }
    // Nothing came back. Rather than leave a disabled button and a banner
    // frozen mid-sentence, hand the control back so it can be tried again —
    // after long enough that an npx fetch on a slow line is not cut short.
    window.setTimeout(() => {
      if (restartAttemptRef.current !== attempt) return; // a later ask owns the state now
      if (!restartAskedRef.current) return;
      restartAskedRef.current = false;
      setRestarting(false);
      try { window.sessionStorage.removeItem("agent-dag.restartPending"); } catch {}
    }, upgrade ? 180_000 : 30_000);
  }, [notice?.to, upgradeFailure]);

  // Nothing running for a sustained stretch is the only safe moment: a restart
  // mid-turn silently drops the hook events fired during the gap, leaving tools
  // stuck in flight on the canvas until the stale sweeper reaps them. The rule
  // itself lives in restart.ts, where it can be tested.
  const idleSinceRef = useRef<number | null>(null);
  useEffect(() => {
    const busy = activeCount(stateRef.current.agents.values()) > 0;
    const step = autoRestartStep({
      enabled: autoRestart,
      kind: notice?.kind,
      canRestart: version?.canRestart === true,
      // #804: the same condition the switch renders under, so the deck never
      // restarts itself at a moment when nothing on screen offers to stop it.
      noticeOpen,
      // Not in a tab nobody is looking at. A background tab's timers are
      // throttled rather than stopped, so a forgotten one could restart the
      // server under the tab in use — see RestartGate.visible.
      visible: document.visibilityState === "visible",
      busy,
      idleSince: idleSinceRef.current,
      now,
    });
    idleSinceRef.current = step.idleSince;
    if (step.restart) askRestart();
  }, [autoRestart, notice?.kind, version?.canRestart, noticeOpen, now, askRestart]);

  // WHAT THE BANNER SAYS ABOUT THIS PRESS, from the two things the effect above
  // already decides with. Both were computed and thrown away: the deck knew
  // whether a restart was safe and whether one was counting down, and told the
  // reader neither.
  //
  // Read at render, from the same `now` the effect ticks on. `idleSinceRef` is
  // a ref rather than state because the clock must not itself cause renders —
  // this component already re-renders on every tick — and reading it here is
  // safe for the one reason that matters: it holds an ABSOLUTE timestamp, so a
  // value one tick old still yields an exact remainder against the current
  // `now`. A duration would have gone stale; an instant cannot.
  const activeNow = activeCount(stateRef.current.agents.values());
  const restartCopy = restartSafety(activeNow);
  const restartFuseMs = autoRestartRemainingMs({
    enabled: autoRestart,
    kind: notice?.kind,
    canRestart: version?.canRestart === true,
    noticeOpen,
    visible: document.visibilityState === "visible",
    busy: activeNow > 0,
    idleSince: idleSinceRef.current,
    now,
  });

  // Landed — here, or in the bundle that is about to replace this one. The page
  // is code too and nothing else reloads it, so both outcomes hang off the same
  // move of `running` and have to be decided together: as two effects they were
  // flushed in one synchronous pass, and since location.reload() only schedules
  // the navigation the second one still deleted the pending marker that was
  // supposed to carry the confirmation across it. The rule lives in restart.ts.
  useEffect(() => {
    const running = version?.running;
    let pending: string | null = null;
    let lastTried: string | null = null;
    try {
      pending = window.sessionStorage.getItem("agent-dag.restartPending");
      lastTried = window.sessionStorage.getItem(BUNDLE_RELOAD_KEY);
    } catch { return; }
    const step = restartLandingStep({ bundle: __APP_VERSION__, running, pending, lastTried });
    if (step === "reload") {
      try { window.sessionStorage.setItem(BUNDLE_RELOAD_KEY, running ?? ""); } catch { return; }
      window.location.reload();
      return; // the marker stays put; the new bundle is the one that can show it
    }
    if (step !== "confirm") return;
    try { window.sessionStorage.removeItem("agent-dag.restartPending"); } catch {}
    restartAskedRef.current = false;
    setRestarting(false);
    setRestartedTo(running ?? null);
    const t = window.setTimeout(() => setRestartedTo(null), 6000);
    return () => window.clearTimeout(t);
  }, [version?.running]);

  // Didn't land. A failed `npx -y <spec>@latest` comes back on the OLD version
  // and the same port, so `running` never moves and the check above waits for a
  // version that is not coming — leaving the retry button disabled and reading
  // "fetching…" for the full three minutes, beside a banner already spelling
  // out why the update failed. The supervisor's note is the end of the attempt,
  // and this is the tab hearing it. The rule lives in restart.ts.
  useEffect(() => {
    if (!restarting) return;
    if (!restartEndedInFailure({ asked: askedFailureRef.current, reported: upgradeFailure })) return;
    try { window.sessionStorage.removeItem("agent-dag.restartPending"); } catch {}
    restartAskedRef.current = false;
    setRestarting(false);
  }, [restarting, upgradeFailure]);

  /** The auto-update half of the one /api/prefs read App.tsx makes. */
  const loadAutoRestartPrefs = useCallback((d: AutoRestartPrefsAnswer) => {
    // The auto-update switch, which lives here now (see toggleAutoRestart).
    // One that was turned off while it was a localStorage key is carried
    // over once, and then the key is gone. Not over a press made while this
    // answer was on its way — see autoTouchedRef.
    if (!autoTouchedRef.current) {
      const legacyOff = readStored(AUTO_RESTART_KEY) === "0";
      removeStored(AUTO_RESTART_KEY);
      if (legacyOff && d.prefs?.autoUpdate !== false) {
        setAutoRestart(false);
        fetch("/api/prefs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ autoUpdate: false }),
        }).catch(() => {});
      } else {
        setAutoRestart(d.prefs?.autoUpdate !== false);
      }
    }
  }, []);

  return { autoRestart, toggleAutoRestart, restarting, restartMode, restartedTo, askRestart,
           restartCopy, restartFuseMs, loadAutoRestartPrefs };
}
