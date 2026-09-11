// The deck updates itself while nobody is looking at it (auto-update.mjs).
//
// Asked for in as many words: when a new version appears, update on its own if
// the user is not focused on the deck's tab. Until this an install needed a
// press, the restart after it needed a tab somebody was looking at, and a deck
// with no tab open — the common case since 3.20.0, when the deck started
// outliving its terminal — stayed on its old code for good.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createActivity, OPEN_CAP_MS } from "../../server/activity.mjs";
import { AWAY_BOOT_GRACE_MS, AWAY_QUIET_MS, AWAY_RETRY_MS, awayGate, awayUpdateStep } from "../../server/auto-update.mjs";
import { createPresence, PRESENCE_TTL_MS } from "../../server/presence.mjs";
import { DEFAULTS, normalise } from "../../server/deck-prefs.mjs";
import { IDLE_BEFORE_RESTART_MS } from "../restart";
import { PRESENCE_BEAT_MS, presenceShouldSend, tabLooking } from "../presence";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const MIN = 60_000;

describe("when the deck may update itself", () => {
  const clear = {
    enabled: true, supervised: true, restarting: false, sinceBootMs: AWAY_BOOT_GRACE_MS,
    looking: false, busy: false, quietMs: AWAY_QUIET_MS,
  };

  it("may, with nobody looking, nothing running and its boot behind it", () => {
    expect(awayGate(clear)).toBe(true);
  });

  it("may not while somebody is looking at it — the banner is theirs then", () => {
    expect(awayGate({ ...clear, looking: true })).toBe(false);
  });

  it("may not in the middle of a turn, or in the quiet straight after one", () => {
    expect(awayGate({ ...clear, busy: true })).toBe(false);
    expect(awayGate({ ...clear, quietMs: AWAY_QUIET_MS - 1 })).toBe(false);
  });

  it("means by idle what the page means", () => {
    expect(AWAY_QUIET_MS).toBe(IDLE_BEFORE_RESTART_MS);
  });

  it("may not with the switch off, with nothing to restart it, or with a restart already going", () => {
    expect(awayGate({ ...clear, enabled: false })).toBe(false);
    expect(awayGate({ ...clear, supervised: false })).toBe(false);
    expect(awayGate({ ...clear, restarting: true })).toBe(false);
  });

  it("waits out the boot grace, so a relaunch that lands on the old version cannot loop", () => {
    expect(awayGate({ ...clear, sinceBootMs: AWAY_BOOT_GRACE_MS - 1 })).toBe(false);
  });
});

describe("what it does once it may", () => {
  const now = 100 * MIN;
  const upgrade = { kind: "upgrade", from: "3.20.0", to: "3.21.0" };
  const restart = { kind: "restart", from: "3.20.0", to: "3.21.0" };

  it("restarts into code that is already on disk", () => {
    expect(awayUpdateStep({ notice: restart, mode: null, installing: false, lastTry: null, now }))
      .toEqual({ act: "restart", target: "restart:3.21.0" });
  });

  it("installs over a global install, and the next tick restarts into it", () => {
    const first = awayUpdateStep({ notice: upgrade, mode: "install", installing: false, lastTry: null, now });
    expect(first).toEqual({ act: "install", target: "upgrade:3.21.0" });
    // The install landed: the notice is a restart now, which is a different
    // attempt from the install and is not held back by it.
    const lastTry = { target: first.target, at: now };
    expect(awayUpdateStep({ notice: restart, mode: "install", installing: false, lastTry, now: now + MIN }).act)
      .toBe("restart");
  });

  it("relaunches through npx, where there is nothing to install", () => {
    expect(awayUpdateStep({ notice: upgrade, mode: "npx", installing: false, lastTry: null, now }).act).toBe("npx");
  });

  it("leaves a checkout, an unwritable prefix and an opt-out to a person", () => {
    expect(awayUpdateStep({ notice: upgrade, mode: null, installing: false, lastTry: null, now }).act).toBeNull();
  });

  it("does nothing while an install is running, or when nothing is newer", () => {
    expect(awayUpdateStep({ notice: upgrade, mode: "install", installing: true, lastTry: null, now }).act).toBeNull();
    expect(awayUpdateStep({ notice: null, mode: "install", installing: false, lastTry: null, now }).act).toBeNull();
  });

  it("does not repeat an attempt inside the retry window, and a newer version is a new attempt", () => {
    const lastTry = { target: "upgrade:3.21.0", at: now };
    expect(awayUpdateStep({ notice: upgrade, mode: "install", installing: false, lastTry, now: now + AWAY_RETRY_MS - 1 }).act)
      .toBeNull();
    expect(awayUpdateStep({ notice: upgrade, mode: "install", installing: false, lastTry, now: now + AWAY_RETRY_MS }).act)
      .toBe("install");
    const newer = { ...upgrade, to: "3.22.0" };
    expect(awayUpdateStep({ notice: newer, mode: "install", installing: false, lastTry, now: now + 1 }).act).toBe("install");
  });

  it("counts a clock that moved backwards as time elapsed", () => {
    const lastTry = { target: "restart:3.21.0", at: now + 10 * MIN };
    expect(awayUpdateStep({ notice: restart, mode: null, installing: false, lastTry, now }).act).toBe("restart");
  });
});

describe("whether a turn is running", () => {
  it("opens on the prompt and closes on Stop", () => {
    const a = createActivity();
    a.note({ hook_event_name: "UserPromptSubmit", session_id: "s1" }, 1000);
    expect(a.busy(2000)).toBe(true);
    a.note({ hook_event_name: "PreToolUse", session_id: "s1" }, 3000);
    a.note({ hook_event_name: "Stop", session_id: "s1" }, 4000);
    expect(a.busy(5000)).toBe(false);
  });

  it("is busy while any one session is", () => {
    const a = createActivity();
    a.note({ hook_event_name: "UserPromptSubmit", session_id: "s1" }, 1000);
    a.note({ hook_event_name: "UserPromptSubmit", session_id: "s2" }, 1000);
    a.note({ hook_event_name: "SessionEnd", session_id: "s1" }, 2000);
    expect(a.busy(3000)).toBe(true);
  });

  it("does not count a CLI sitting at its prompt, or the idle reminder after a turn", () => {
    const a = createActivity();
    a.note({ hook_event_name: "SessionStart", session_id: "s1" }, 1000);
    a.note({ hook_event_name: "Notification", session_id: "s1" }, 2000);
    expect(a.busy(3000)).toBe(false);
    expect(a.quietMs(3000)).toBe(Infinity);
  });

  it("stops waiting on a session that never said Stop", () => {
    const a = createActivity();
    a.note({ hook_event_name: "PreToolUse", session_id: "s1" }, 0);
    expect(a.busy(OPEN_CAP_MS)).toBe(true);
    expect(a.busy(OPEN_CAP_MS + 1)).toBe(false);
  });

  it("measures quiet from the last turn event of any session", () => {
    const a = createActivity();
    a.note({ hook_event_name: "Stop", session_id: "s1" }, 5000);
    expect(a.quietMs(5000 + AWAY_QUIET_MS)).toBe(AWAY_QUIET_MS);
  });

  it("ignores anything that is not a hook payload", () => {
    const a = createActivity();
    a.note(null, 1000);
    a.note({ type: "system" }, 1000);
    a.note({ hook_event_name: "UserPromptSubmit" }, 1000);   // no session: quiet moves, nothing opens
    expect(a.busy(2000)).toBe(false);
    expect(a.quietMs(2000)).toBe(1000);
  });
});

describe("whether anybody is looking", () => {
  it("is a tab's live claim, until it takes it back or its beat runs out", () => {
    const p = createPresence();
    expect(p.looking(0)).toBe(false);
    expect(p.report("tab-1", true, 0)).toBe(true);
    expect(p.looking(PRESENCE_TTL_MS)).toBe(true);
    expect(p.looking(PRESENCE_TTL_MS + 1)).toBe(false);
    p.report("tab-1", true, 0);
    p.report("tab-1", false, 1);
    expect(p.looking(2)).toBe(false);
  });

  it("holds while any one of several tabs is looking", () => {
    const p = createPresence();
    p.report("a", true, 0);
    p.report("b", false, 0);
    expect(p.looking(1)).toBe(true);
  });

  it("refuses an id no page would make", () => {
    const p = createPresence();
    expect(p.report("../../etc", true, 0)).toBe(false);
    expect(p.report("x".repeat(65), true, 0)).toBe(false);
    expect(p.report(42 as unknown as string, true, 0)).toBe(false);
    expect(p.looking(0)).toBe(false);
  });

  it("is renewed three times inside the server's window", () => {
    expect(PRESENCE_BEAT_MS * 3).toBeLessThanOrEqual(PRESENCE_TTL_MS);
  });

  it("means on screen AND holding the keyboard", () => {
    expect(tabLooking({ visibilityState: "visible", hasFocus: () => true })).toBe(true);
    // A deck on a second monitor while the person types into a terminal.
    expect(tabLooking({ visibilityState: "visible", hasFocus: () => false })).toBe(false);
    expect(tabLooking({ visibilityState: "hidden", hasFocus: () => true })).toBe(false);
  });

  it("beats while looking, says goodbye once, and says nothing from a tab never looked at", () => {
    expect(presenceShouldSend(null, false)).toBe(false);
    expect(presenceShouldSend(null, true)).toBe(true);
    expect(presenceShouldSend(true, true)).toBe(true);
    expect(presenceShouldSend(true, false)).toBe(true);
    expect(presenceShouldSend(false, false)).toBe(false);
  });
});

describe("the switch", () => {
  const app = src("../App.tsx");

  it("is on unless somebody turned it off, and only a real boolean turns it off", () => {
    expect(DEFAULTS.autoUpdate).toBe(true);
    expect(normalise({}).autoUpdate).toBe(true);
    expect(normalise({ autoUpdate: false }).autoUpdate).toBe(false);
    expect(normalise({ autoUpdate: "false" }).autoUpdate).toBe(true);
  });

  it("is read and written on the server, where a deck with no page open can see it", () => {
    expect(app).toMatch(/body: JSON\.stringify\(\{ autoUpdate: next \}\)/);
    expect(app).toMatch(/setAutoRestart\(d\.prefs\?\.autoUpdate !== false\);/);
    expect(app).not.toMatch(/localStorage\.setItem\(AUTO_RESTART_KEY/);
  });

  it("carries a switch turned off before the move over once, and drops the old key", () => {
    expect(app).toMatch(/legacyOff = window\.localStorage\.getItem\(AUTO_RESTART_KEY\) === "0";/);
    expect(app).toMatch(/window\.localStorage\.removeItem\(AUTO_RESTART_KEY\);/);
    expect(app).toMatch(/body: JSON\.stringify\(\{ autoUpdate: false \}\)/);
  });

  it("never lets that load undo a press made while it was on its way", () => {
    // Found in review: a switch still off from its localStorage days, pressed
    // on before the prefs answer landed, was flipped back off by the carry-over
    // that answer triggered. The press marks the page and drops the old key.
    const toggle = app.slice(app.indexOf("const toggleAutoRestart = useCallback("));
    expect(toggle.slice(0, 400)).toMatch(/autoTouchedRef\.current = true;/);
    expect(toggle.slice(0, 400)).toMatch(/localStorage\.removeItem\(AUTO_RESTART_KEY\)/);
    expect(app).toMatch(/if \(!autoTouchedRef\.current\) \{\s*let legacyOff = false;/);
  });
});

describe("the wiring", () => {
  const index = src("../../server/index.mjs");
  const app = src("../App.tsx");

  it("learns about turns from every live event and never from a replay", () => {
    expect(index).toContain("if (!opts.replay) activity.note(raw, evt.receivedAt);");
  });

  it("takes presence on a route only the deck's own page can post to", () => {
    expect(index).toMatch(/url\.pathname === "\/api\/presence"\)\s+return guard\(handlePresence\(req, res\), res\);/);
    const open = /const OPEN_MUTATIONS = new Set\(\[([^\]]*)\]\)/.exec(index)?.[1] ?? "";
    expect(open).not.toMatch(/presence/);
  });

  it("takes a report that found nothing newer as the answer for a few minutes", () => {
    // The report is not free: on Windows it proves the npm prefix writable by
    // creating a file in it, and a deck left alone overnight would do that once
    // a minute. The npm lookup behind it is hourly regardless.
    expect(index).toContain("_awayNothingUntil = now + AWAY_RECHECK_MS;");
    expect(index).toContain("if (now < _awayNothingUntil && _awayNothingUntil - now <= AWAY_RECHECK_MS) return null;");
  });

  it("arms the tick when the server starts, and asks again after the lookup", () => {
    const start = index.indexOf("export async function startServer(");
    expect(index.indexOf("_awayTimer = setInterval(", start)).toBeGreaterThan(start);
    expect(index).toContain("if (presence.looking(again) || activity.busy(again) || _restarting) return null;");
  });

  it("acts only through what a press would do", () => {
    expect(index).toContain("su.startUpgrade({ pkgRoot: PKG_ROOT });");
    expect(index).toContain('handOffRestart(step.act === "npx" ? "npx" : null);');
    // The press goes through the same hand-off.
    const press = index.slice(index.indexOf("async function handleRestart("));
    expect(press.slice(0, press.indexOf("\nfunction handOffRestart("))).toContain("handOffRestart(mode);");
  });

  it("has every tab report its focus, with a goodbye that outlives the page", () => {
    expect(app).toMatch(/fetch\("\/api\/presence", \{/);
    expect(app).toContain("keepalive: true,");
    expect(app).toContain('window.addEventListener("pagehide", bye);');
    expect(app).toContain("const iv = window.setInterval(tick, PRESENCE_BEAT_MS);");
  });
});
