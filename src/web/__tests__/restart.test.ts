// The deck can now restart itself when a newer version is sitting on disk.
// Everything about that is recoverable except one thing: hook events fired
// while the server is down are lost permanently — hook/hook.js gives each POST
// a 1s timeout, swallows ECONNREFUSED and never retries — leaving tools stuck
// in flight on the canvas. So the gate that decides "now is a safe moment" is
// the part worth pinning down.
import { describe, it, expect } from "vitest";
import {
  activeCount, autoRestartRemainingMs, autoRestartStep, countdownLabel, restartSafety,
  shouldReloadBundle, IDLE_BEFORE_RESTART_MS,
} from "../restart";

const NOW = 1_800_000_000_000;
const ok = {
  enabled: true,
  kind: "restart" as string | null | undefined,
  canRestart: true,
  noticeOpen: true,
  busy: false,
  idleSince: null as number | null,
  now: NOW,
};

describe("autoRestartStep", () => {
  it("starts the clock on the first quiet tick rather than restarting at once", () => {
    expect(autoRestartStep(ok)).toEqual({ idleSince: NOW, restart: false, remainingMs: IDLE_BEFORE_RESTART_MS });
  });

  it("waits out the full window", () => {
    const started = NOW - IDLE_BEFORE_RESTART_MS + 1;
    expect(autoRestartStep({ ...ok, idleSince: started }).restart).toBe(false);
    expect(autoRestartStep({ ...ok, idleSince: NOW - IDLE_BEFORE_RESTART_MS }).restart).toBe(true);
  });

  it("never restarts while an agent is running", () => {
    // The whole point. A restart here drops the hook events of a live turn.
    const almost = { ...ok, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS };
    expect(autoRestartStep({ ...almost, busy: true }).restart).toBe(false);
  });

  it("makes work reset the clock, not pause it", () => {
    // A single busy tick in the middle of a quiet stretch must buy another full
    // window — otherwise a burst of work is followed instantly by a restart.
    const almost = { ...ok, idleSince: NOW - IDLE_BEFORE_RESTART_MS + 500 };
    const interrupted = autoRestartStep({ ...almost, busy: true });
    expect(interrupted.idleSince).toBeNull();
    const next = autoRestartStep({ ...ok, idleSince: interrupted.idleSince, now: NOW + 1000 });
    expect(next).toEqual({ idleSince: NOW + 1000, restart: false, remainingMs: IDLE_BEFORE_RESTART_MS });
  });

  it("does nothing when the user turned it off", () => {
    expect(autoRestartStep({ ...ok, enabled: false, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS }))
      .toEqual({ idleSince: null, restart: false, remainingMs: null });
  });

  it("never acts on an upgrade notice — that would need an install we do not do", () => {
    const stale = { ...ok, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS };
    expect(autoRestartStep({ ...stale, kind: "upgrade" }).restart).toBe(false);
    expect(autoRestartStep({ ...stale, kind: null }).restart).toBe(false);
    expect(autoRestartStep({ ...stale, kind: undefined }).restart).toBe(false);
  });

  it("does nothing while the banner holding the switch is dismissed (#804)", () => {
    // The behaviour and its only control were gated on different things: the
    // switch renders inside `noticeOpen && notice`, the effect was keyed on
    // `notice?.kind`. Dismiss the banner with its × and the deck would still
    // exit, respawn and reload the page thirty seconds after the last agent
    // went quiet, with nothing on screen having offered to stop it.
    const stale = { ...ok, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS };
    expect(autoRestartStep({ ...stale, noticeOpen: false }))
      .toEqual({ idleSince: null, restart: false, remainingMs: null });
    // And the clock is reset rather than paused, like every other
    // disqualification here: bringing the banner back buys a full window, not
    // whatever was left of the old one.
    expect(autoRestartStep({ ...ok, noticeOpen: false }).idleSince).toBeNull();
    // The other direction, so the gate is not simply "never".
    expect(autoRestartStep(stale).restart).toBe(true);
  });

  it("counts down on the same gate it restarts on, so the two cannot disagree", () => {
    // The clock ran for four releases with nothing rendering it: the switch
    // said `auto when idle` whether the deck was two seconds from killing its
    // own process or not counting at all. The countdown is now the cancel
    // affordance, which means it has to be true — a banner counting down to a
    // restart that will not happen is worse than the silence it replaced.
    expect(autoRestartRemainingMs(ok)).toBe(IDLE_BEFORE_RESTART_MS);
    expect(autoRestartRemainingMs({ ...ok, idleSince: NOW - 10_000 })).toBe(IDLE_BEFORE_RESTART_MS - 10_000);
    // Nothing counts while nothing would restart. Each of these is a separate
    // disqualification in the gate, and every one of them has to reach here.
    for (const off of [
      { enabled: false }, { busy: true }, { noticeOpen: false },
      { canRestart: false }, { kind: "upgrade" }, { kind: null },
    ]) {
      const g = { ...ok, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS, ...off };
      expect(autoRestartRemainingMs(g), JSON.stringify(off)).toBeNull();
      expect(autoRestartStep(g).restart, JSON.stringify(off)).toBe(false);
    }
    // And zero is the tick that restarts, not merely a small number.
    const due = { ...ok, idleSince: NOW - IDLE_BEFORE_RESTART_MS };
    expect(autoRestartRemainingMs(due)).toBe(0);
    expect(autoRestartStep(due).restart).toBe(true);
    expect(autoRestartRemainingMs({ ...ok, idleSince: NOW - IDLE_BEFORE_RESTART_MS + 1 })).toBe(1);
    expect(autoRestartStep({ ...ok, idleSince: NOW - IDLE_BEFORE_RESTART_MS + 1 }).restart).toBe(false);
  });

  it("never counts below zero, however long the window has been over", () => {
    // The restart is asked for on the tick it comes due, but a tab whose timer
    // was throttled can arrive at this a minute late — and `auto in -47s` is
    // worse than no clock at all.
    expect(autoRestartRemainingMs({ ...ok, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS })).toBe(0);
  });

  it("says the countdown the way a reader would", () => {
    expect(countdownLabel(18_000)).toBe("18s");
    // Rounded UP, so the label never shows a second the deck has already spent:
    // `0s` on screen while nothing has happened yet reads as a hang.
    expect(countdownLabel(17_400)).toBe("18s");
    expect(countdownLabel(0)).toBe("0s");
    expect(countdownLabel(-5)).toBe("0s");
    expect(countdownLabel(59_000)).toBe("59s");
    // Minutes only past the point where counting seconds stops being how
    // anybody says it.
    expect(countdownLabel(60_000)).toBe("1:00");
    expect(countdownLabel(125_000)).toBe("2:05");
  });

  it("obeys the server when it says a restart is impossible", () => {
    // Unsupervised, or --no-persist, where restarting would wipe the canvas.
    const stale = { ...ok, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS };
    expect(autoRestartStep({ ...stale, canRestart: false }).restart).toBe(false);
  });

  it("recovers from a clock that jumped backwards", () => {
    // Laptop wake, NTP correction. A negative elapsed must not read as "not yet"
    // for however long the jump was.
    const step = autoRestartStep({ ...ok, idleSince: NOW + 60_000 });
    expect(step).toEqual({ idleSince: NOW, restart: false, remainingMs: IDLE_BEFORE_RESTART_MS });
  });
});

describe("what the restart button says, and what it says beside itself", () => {
  // The rule at the top of this file was enforced on the timer and nowhere
  // else: `askRestart` had no busy check and neither did the server, so the
  // deliberate press — the one a person makes after reading the banner — was
  // the least guarded path in the feature. It is a label rather than a
  // confirmation dialog because a modal over a live canvas is worse than a true
  // word, and because the honest version costs no second click when the machine
  // is actually quiet.
  it("names the press for what it does to work in flight", () => {
    expect(restartSafety(0)).toEqual({ label: "Restart now", clause: "nothing is running" });
    expect(restartSafety(2).label).toBe("Restart anyway");
    expect(restartSafety(2).clause).toBe("2 agents are running — their events during the restart are lost");
  });

  it("counts one agent as one", () => {
    expect(restartSafety(1).clause).toBe("1 agent is running — their events during the restart are lost");
  });

  it("says something in every state, because the reassurance is the point", () => {
    // Silence when idle would make the busy clause read as an error rather than
    // as an answer to "is this safe" — and "is this safe" is the question the
    // press asks whether or not anything is running.
    for (const n of [0, 1, 5]) {
      expect(restartSafety(n).clause.length, `${n} agents`).toBeGreaterThan(0);
      expect(restartSafety(n).label, `${n} agents`).toMatch(/^Restart /);
    }
  });

  it("counts only what is actually running", () => {
    const agents = [{ state: "active" }, { state: "idle" }, { state: "active" }, {}, { state: "done" }];
    expect(activeCount(agents)).toBe(2);
    expect(activeCount([])).toBe(0);
    // The same answer the gate uses, so the word on the button and the clock
    // beside it cannot describe two different machines.
    expect(autoRestartRemainingMs({ ...ok, busy: activeCount(agents) > 0 })).toBeNull();
  });
});

describe("shouldReloadBundle", () => {
  // Reported from a real deck: after it restarted itself onto v1.32.0 the tab
  // still showed v1.31.0's banner, without the Restart button that version
  // added — because the page kept executing the bundle it had downloaded. The
  // button "only appeared after a refresh". Nothing else reloads the page, so
  // this does.
  it("reloads when the page's own code is older than the server's", () => {
    expect(shouldReloadBundle({ bundle: "1.31.0", running: "1.32.0", lastTried: null })).toBe(true);
  });

  it("stays put when they match", () => {
    expect(shouldReloadBundle({ bundle: "1.32.0", running: "1.32.0", lastTried: null })).toBe(false);
  });

  it("reloads at most once per server version", () => {
    // `npm version` without a rebuild leaves the bundle permanently behind the
    // package version — every checkout mid-release. Without this guard that is
    // an endless reload loop.
    expect(shouldReloadBundle({ bundle: "1.31.0", running: "1.32.0", lastTried: "1.32.0" })).toBe(false);
    // A later version is a new reason, and gets its own single attempt.
    expect(shouldReloadBundle({ bundle: "1.31.0", running: "1.33.0", lastTried: "1.32.0" })).toBe(true);
  });

  it("does nothing before the server has answered", () => {
    expect(shouldReloadBundle({ bundle: "1.31.0", running: null, lastTried: null })).toBe(false);
    expect(shouldReloadBundle({ bundle: null, running: "1.32.0", lastTried: null })).toBe(false);
  });
});
