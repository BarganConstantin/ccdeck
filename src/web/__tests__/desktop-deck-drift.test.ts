// A deck that serves older code than its own install holds, found by the
// desktop app (desktop/deck-drift.mjs).
//
// An npm deck started before a release kept serving that release's code after
// a newer one was installed under it, through an update of the app itself: the
// app compared the deck only with the deck it carries, only on the look that
// starts its own deck next, and every other look attached to whatever answered.
// The deck knew (GET /api/version: running, installed, a "restart" notice) and
// nothing in the app asked it.
//
// So the app now keeps three versions apart — its own, the deck's install, and
// what the deck serves — and restarts a deck behind its install through the
// deck's own restart route, under the quiet the app updates itself under. These
// pin the rule, run against the real versions comparison, then the answers the
// route really gives, then the app's wiring.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs, no types
import { deckRestartStep, landing, LANDING_MS, restartAnswer, restartTarget, trayDrift, VERSION_LOOK_MS, versionsOf } from "../../../desktop/deck-drift.mjs";
// @ts-expect-error — plain .mjs, no types
import { QUIET_MS, idleSinceNext, quietSinceNext } from "../../../desktop/auto-update.mjs";
// @ts-expect-error — plain .mjs, no types
import { discoverPlan } from "../../../desktop/own-deck.mjs";
// @ts-expect-error — plain .mjs, no types
import { deckJson } from "../../../desktop/deck-link.mjs";
// @ts-expect-error — plain .mjs, no types
import { restartLabel, trayMenuItems, versionLine } from "../../../desktop/tray-menu.mjs";
// @ts-expect-error — plain .mjs, no types
import { olderVersion } from "../../server/running-deck.mjs";

const NOW = 1_795_000_000_000;
const MIN = 60_000;

type Versions = { serving: string; installed: string | null; canRestart: boolean };
type Tried = { to: string; outcome: string; at: number; pid?: number } | null;

/** The deck the field report was about: 4.3.7 serving, 4.3.11 on disk. */
const behind: Versions = { serving: "4.3.7", installed: "4.3.11", canRestart: true };
/** The app left alone for well over a minute, its agents idle as long. */
const quietApp = { windowFocused: false, busy: false, quietSince: NOW - 5 * MIN, idleSince: NOW - 5 * MIN };

const step = (over: Record<string, unknown> = {}) =>
  deckRestartStep({ versions: behind, olderVersion, autoUpdate: true, tried: null, ...quietApp, now: NOW, ...over });

describe("what /api/version says, as the app reads it", () => {
  it("keeps the version the deck serves apart from the one its install holds", () => {
    expect(versionsOf({ running: "4.3.7", installed: "4.3.11", canRestart: true, notice: { kind: "restart" } }))
      .toEqual({ serving: "4.3.7", installed: "4.3.11", canRestart: true });
    // canRestart only when the deck says so: an older deck that does not say
    // is one the app does not restart by itself.
    expect(versionsOf({ running: "4.3.7", installed: "4.3.11" })).toEqual({ serving: "4.3.7", installed: "4.3.11", canRestart: false });
    expect(versionsOf({ running: "4.3.7", installed: null, canRestart: true })).toEqual({ serving: "4.3.7", installed: null, canRestart: true });
  });

  it("is nothing without a version the deck serves", () => {
    for (const report of [null, undefined, "4.3.7", {}, { running: "" }, { running: null, installed: "4.3.11" }]) {
      expect(versionsOf(report)).toBeNull();
    }
  });

  it("names a restart's target only when the install is newer than what is served", () => {
    expect(restartTarget(behind, olderVersion)).toBe("4.3.11");
    // Numeric, field by field: 4.3.10 is newer than 4.3.9.
    expect(restartTarget({ serving: "4.3.9", installed: "4.3.10", canRestart: true }, olderVersion)).toBe("4.3.10");
    expect(restartTarget({ serving: "4.3.11", installed: "4.3.11", canRestart: true }, olderVersion)).toBeNull();
    // A checkout or a deck run ahead of its install has nothing to gain.
    expect(restartTarget({ serving: "4.3.12", installed: "4.3.11", canRestart: true }, olderVersion)).toBeNull();
    expect(restartTarget({ serving: "4.3.7", installed: null, canRestart: true }, olderVersion)).toBeNull();
    expect(restartTarget(null, olderVersion)).toBeNull();
  });
});

describe("the app's version, the install's and the one served, kept apart", () => {
  // `start` is the look that starts the app's own deck next (discoverPlan's
  // willStart); every other look attaches to what it finds. Then the deck it is
  // attached to is judged by its own install, whatever the app carries.
  const cases: Array<{ app: string; serving: string; installed: string; start: string; later: string; drift: string }> = [
    // The field report: the app (4.3.10) newer than what is served, the
    // install newer than both. A start replaces it, as before; any other look
    // attaches, and the deck is then restarted into its own 4.3.11.
    { app: "4.3.10", serving: "4.3.7", installed: "4.3.11", start: "replace", later: "attach", drift: "restart" },
    { app: "4.3.11", serving: "4.3.11", installed: "4.3.11", start: "attach", later: "attach", drift: "none" },
    // A deck newer than the app: attached to, and current with its install.
    { app: "4.3.10", serving: "4.3.11", installed: "4.3.11", start: "attach", later: "attach", drift: "none" },
    // A deck newer than the app, with a newer still installed under it: the
    // app's own version has no say in it.
    { app: "4.3.10", serving: "4.3.11", installed: "4.3.12", start: "attach", later: "attach", drift: "restart" },
    // An app newer than the deck and its install: a start replaces it; a deck
    // attached to otherwise has nothing newer on its own disk.
    { app: "4.3.12", serving: "4.3.11", installed: "4.3.11", start: "replace", later: "attach", drift: "none" },
  ];
  for (const c of cases) {
    it(`app ${c.app}, deck serving ${c.serving} with ${c.installed} installed`, () => {
      const found = { pid: 7, port: 4317, token: "t", version: c.serving };
      const look = (willStart: boolean) => discoverPlan({ found, ours: c.app, ownDeck: null, starting: null, willStart, olderVersion });
      expect(look(true)).toBe(c.start);
      expect(look(false)).toBe(c.later);
      expect(step({ versions: { serving: c.serving, installed: c.installed, canRestart: true } }).act).toBe(c.drift);
    });
  }
});

describe("what the app does about a deck behind its install", () => {
  it("does nothing for a deck that serves what its install holds", () => {
    expect(step({ versions: { serving: "4.3.11", installed: "4.3.11", canRestart: true } })).toEqual({ act: "none", to: null });
    expect(step({ versions: null })).toEqual({ act: "none", to: null });
  });

  it("restarts it, once the app and its agents have been quiet for a minute", () => {
    expect(step()).toEqual({ act: "restart", to: "4.3.11" });
    // Exactly a minute is enough, as for the app's own update.
    expect(step({ quietSince: NOW - QUIET_MS, idleSince: NOW - QUIET_MS }).act).toBe("restart");
  });

  it("waits while somebody is there or an agent is working or waiting", () => {
    expect(step({ windowFocused: true })).toEqual({ act: "wait", to: "4.3.11", why: "in-use" });
    expect(step({ busy: true })).toEqual({ act: "wait", to: "4.3.11", why: "in-use" });
    expect(step({ quietSince: null })).toEqual({ act: "wait", to: "4.3.11", why: "in-use" });
    expect(step({ quietSince: NOW - QUIET_MS + 1 })).toEqual({ act: "wait", to: "4.3.11", why: "in-use" });
    // An agent working or waiting (idleSinceNext answers null for both).
    expect(step({ idleSince: null })).toEqual({ act: "wait", to: "4.3.11", why: "agents" });
    expect(step({ idleSince: NOW - QUIET_MS + 1 })).toEqual({ act: "wait", to: "4.3.11", why: "agents" });
  });

  it("only says so for a deck that cannot restart without losing its canvas", () => {
    expect(step({ versions: { ...behind, canRestart: false } })).toEqual({ act: "notice", to: "4.3.11", why: "cannot-restart" });
  });

  it("follows the deck's own update-by-itself switch, and waits until it is read", () => {
    expect(step({ autoUpdate: false })).toEqual({ act: "notice", to: "4.3.11", why: "switched-off" });
    expect(step({ autoUpdate: null })).toEqual({ act: "wait", to: "4.3.11", why: "switch-unread" });
  });

  it("does not ask twice while one ask is out", () => {
    expect(step({ tried: { to: "4.3.11", outcome: "asked", at: NOW - 1000, pid: 7 } })).toEqual({ act: "wait", to: "4.3.11", why: "restarting" });
  });

  it("gives a turn the deck heard a full quiet minute from its answer", () => {
    const tried = { to: "4.3.11", outcome: "busy", at: NOW - 10_000 };
    expect(step({ tried })).toEqual({ act: "wait", to: "4.3.11", why: "turn-running" });
    expect(step({ tried: { ...tried, at: NOW - QUIET_MS } }).act).toBe("restart");
    // A clock moved back counts as time gone, as in the rest of the update path.
    expect(step({ tried: { ...tried, at: NOW + MIN } }).act).toBe("restart");
  });

  it("never asks again for a version the deck refused or came back old from", () => {
    for (const outcome of ["refused", "failed"]) {
      const tried = { to: "4.3.11", outcome, at: NOW - 3 * 24 * 60 * MIN };
      expect(step({ tried })).toEqual({ act: "notice", to: "4.3.11", why: outcome });
    }
    // A newer install is a new attempt.
    expect(step({ tried: { to: "4.3.11", outcome: "failed", at: NOW }, versions: { ...behind, installed: "4.3.12" } }))
      .toEqual({ act: "restart", to: "4.3.12" });
  });
});

describe("what the deck answered the restart with", () => {
  const servers: Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });

  /** A deck stand-in on 127.0.0.1 answering POST /api/restart, and what it was sent. */
  async function deckAnswering(status: number | null, json: unknown = null) {
    const seen: Array<{ method?: string; url?: string; token?: string | string[]; body: string }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, token: req.headers["x-ccdeck-token"], body });
        if (status === null) return; // a hung deck: never answers
        if (status === 0) { req.socket.destroy(); return; } // gone mid-answer: the restart itself
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    const ask = (timeoutMs = 5000) => deckJson({ port, token: "tok", pid: 7 }, "/api/restart", { method: "POST", body: { whenIdle: true }, timeoutMs })
      .catch((err: Error) => err);
    return { ask, seen };
  }

  it("is the restart, when the deck takes it or drops the socket doing so", async () => {
    const ok = await deckAnswering(200, { ok: true, mode: null });
    expect(restartAnswer(await ok.ask())).toBe("asked");
    // The whenIdle ask, with the app's token: the page's automatic restart.
    expect(ok.seen).toEqual([{ method: "POST", url: "/api/restart", token: "tok", body: '{"whenIdle":true}' }]);
    // Still booting: accepted and held until the boot is over (lifecycle.mjs).
    expect(restartAnswer(await (await deckAnswering(202, { ok: true, booting: true })).ask())).toBe("asked");
    expect(restartAnswer(await (await deckAnswering(0)).ask())).toBe("asked");
  });

  it("is a wait, when the deck hears a turn running", async () => {
    expect(restartAnswer(await (await deckAnswering(409, { ok: false, reason: "busy" })).ask())).toBe("busy");
  });

  it("is a refusal for everything else, which is said and not asked again", async () => {
    for (const [status, reason] of [[501, "unsupervised"], [409, "no_persist"], [409, "log_unwritable"], [401, "unauthenticated"]] as const) {
      expect(restartAnswer(await (await deckAnswering(status, { ok: false, reason })).ask()), `${status} ${reason}`).toBe("refused");
    }
    // A deck that does not answer in time is hung, and nothing is listening is nothing.
    expect(restartAnswer(await (await deckAnswering(null)).ask(150))).toBe("refused");
    expect(restartAnswer(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4317"), { code: "ECONNREFUSED" }))).toBe("refused");
  });
});

describe("what the restart came to, once the deck answers again", () => {
  const tried = { to: "4.3.11", outcome: "asked", at: NOW, pid: 7 };
  const came = (over: Record<string, unknown>) => landing({ tried, pid: 8, serving: "4.3.11", olderVersion, now: NOW + 3000, ...over });

  it("landed, when a deck answers on the version asked for or newer", () => {
    expect(came({})).toBe("landed");
    expect(came({ serving: "4.3.12" })).toBe("landed");
  });

  it("failed, when the new deck still serves older code, or the old one is still there a minute on", () => {
    expect(came({ serving: "4.3.7" })).toBe("failed");
    expect(came({ serving: undefined })).toBe("failed");
    expect(came({ pid: 7, serving: "4.3.7", now: NOW + LANDING_MS })).toBe("failed");
  });

  it("is too early to say while the same deck answers inside the minute", () => {
    expect(came({ pid: 7, serving: "4.3.7", now: NOW + 5000 })).toBe("waiting");
  });

  it("has nothing to settle when no restart is out", () => {
    for (const t of [null, { ...tried, outcome: "busy" }, { ...tried, outcome: "refused" }, { ...tried, outcome: "failed" }]) {
      expect(landing({ tried: t, pid: 8, serving: "4.3.11", olderVersion, now: NOW })).toBeNull();
    }
  });
});

/**
 * The app's ten-second tick, as main.mjs runs it: the quiet and the agents'
 * idle measured by auto-update.mjs, the step, the deck's answer, and the
 * version the deck serves afterwards. `deck` plays the attached deck.
 */
function runTicks({ ticks, agentsBusyAt = () => false, focusedAt = () => false, answer, restartTo }: {
  ticks: number;
  agentsBusyAt?: (i: number) => boolean;
  focusedAt?: (i: number) => boolean;
  /** What POST /api/restart answers on the n-th ask. */
  answer: (n: number) => "asked" | "busy" | "refused";
  /** The version the deck serves after a restart it took. */
  restartTo: string;
}) {
  const deck = { pid: 7, versions: { ...behind } };
  let tried: Tried = null;
  let quietSince: number | null = null;
  let idleSince: number | null = null;
  const asks: number[] = [];
  const acts: string[] = [];
  for (let i = 0; i < ticks; i++) {
    const now = NOW + i * 10_000;
    const busy = tried?.outcome === "asked";
    quietSince = quietSinceNext(quietSince, { windowFocused: focusedAt(i), busy, now });
    idleSince = idleSinceNext(idleSince, { agentsBusy: agentsBusyAt(i), now });
    const s: { act: string; to: string } = deckRestartStep({ versions: deck.versions, olderVersion, autoUpdate: true, tried, windowFocused: focusedAt(i), busy, quietSince, idleSince, now });
    acts.push(s.act);
    if (s.act === "restart") {
      asks.push(i);
      const got = answer(asks.length);
      tried = { to: s.to, outcome: got === "asked" ? "asked" : got, at: now, pid: deck.pid };
      quietSince = null;
      if (got === "busy") idleSince = null;
      if (got === "asked") {
        // The supervisor brings the newer worker up on the same port.
        deck.pid += 1;
        deck.versions = { ...deck.versions, serving: restartTo };
      }
    }
    // The tray stream comes back and the app asks the new deck what it serves.
    const settled = landing({ tried, pid: deck.pid, serving: deck.versions.serving, olderVersion, now });
    if (settled === "landed") tried = null;
    else if (settled === "failed") tried = { ...(tried as NonNullable<Tried>), outcome: "failed", at: now };
  }
  return { asks, acts, deck, tried };
}

describe("over many ticks", () => {
  it("an older deck and an idle app: one restart, verified, then nothing", () => {
    const run = runTicks({ ticks: 200, answer: () => "asked", restartTo: "4.3.11" });
    expect(run.asks).toHaveLength(1);
    expect(run.deck.versions.serving).toBe("4.3.11");
    expect(run.tried).toBeNull();
    expect(run.acts.slice(run.asks[0] + 1).every(a => a === "none")).toBe(true);
  });

  it("an older deck and busy agents: no restart while they work, and the tray keeps saying so", () => {
    const run = runTicks({ ticks: 200, agentsBusyAt: () => true, answer: () => "asked", restartTo: "4.3.11" });
    expect(run.asks).toEqual([]);
    expect(new Set(run.acts)).toEqual(new Set(["wait"]));
    expect(run.deck.versions.serving).toBe("4.3.7");
    // What the tray draws meanwhile: the version served, and the way to the new one.
    const drift = trayDrift(run.deck.versions, olderVersion);
    expect(drift).toEqual({ serving: "4.3.7", to: "4.3.11" });
    expect(versionLine({ appVersion: "4.3.10", deck: { version: "4.3.7" }, drift })).toBe("ccdeck v4.3.10 · deck v4.3.7, v4.3.11 installed");
    expect(restartLabel({ update: { status: "idle" }, drift })).toBe("Restart ccdeck to run v4.3.11");
  });

  it("agents that stop: the restart comes a quiet minute after they do", () => {
    const run = runTicks({ ticks: 200, agentsBusyAt: i => i < 50, answer: () => "asked", restartTo: "4.3.11" });
    expect(run.asks).toHaveLength(1);
    expect(run.asks[0]).toBeGreaterThanOrEqual(50 + QUIET_MS / 10_000);
  });

  it("a focused window holds it off for as long as it is focused", () => {
    expect(runTicks({ ticks: 200, focusedAt: () => true, answer: () => "asked", restartTo: "4.3.11" }).asks).toEqual([]);
  });

  it("a deck that hears a turn: asked again only after another quiet minute", () => {
    const run = runTicks({ ticks: 200, answer: n => (n < 3 ? "busy" : "asked"), restartTo: "4.3.11" });
    expect(run.asks).toHaveLength(3);
    for (let k = 1; k < run.asks.length; k++) expect(run.asks[k] - run.asks[k - 1]).toBeGreaterThanOrEqual(QUIET_MS / 10_000);
    expect(run.deck.versions.serving).toBe("4.3.11");
  });

  it("a deck that refuses: asked once, never again, and said", () => {
    const run = runTicks({ ticks: 500, answer: () => "refused", restartTo: "4.3.11" });
    expect(run.asks).toHaveLength(1);
    expect(run.acts.slice(run.asks[0] + 1).every(a => a === "notice")).toBe(true);
  });

  it("a restart that comes back on the old version: asked once, never again, and said", () => {
    const run = runTicks({ ticks: 500, answer: () => "asked", restartTo: "4.3.7" });
    expect(run.asks).toHaveLength(1);
    expect(run.tried?.outcome).toBe("failed");
    expect(run.acts.slice(run.asks[0] + 1).every(a => a === "notice")).toBe(true);
  });
});

describe("the tray's words for it", () => {
  const deck = { pid: 1, port: 4317, token: "t", version: "4.3.7" };
  const on = { openWindow() {}, startDeck() {}, openInBrowser() {}, toggleNotifications() {}, setOpenAtLogin() {}, restartToUpdate() {}, checkForUpdates() {}, restartDeck() {}, openStatusPage() {}, quit() {} };
  const labels = (over: Record<string, unknown>) => trayMenuItems({
    now: NOW, snapshot: { icon: "idle", waiting: 0, running: 0, title: "ccdeck", blocked: [] }, deck, starting: null, restarting: null,
    notifyOn: true, openAtLogin: false, appVersion: "4.3.10", update: { status: "idle" }, ...over,
  }, on).map((i: { label?: string }) => i.label);

  it("names the version served and the one installed, and the Restart row the version it brings", () => {
    const items = labels({ drift: { serving: "4.3.7", to: "4.3.11" } });
    expect(items).toContain("ccdeck v4.3.10 · deck v4.3.7, v4.3.11 installed");
    expect(items).toContain("Restart ccdeck to run v4.3.11");
    expect(items.indexOf("Restart ccdeck to run v4.3.11")).toBe(items.indexOf("Quit ccdeck") - 1);
  });

  it("says what it said before for a deck that serves what its install holds", () => {
    const items = labels({ drift: null });
    expect(items).toContain("ccdeck v4.3.10 · deck v4.3.7");
    expect(items).toContain("Restart ccdeck");
    expect(labels({ deck: { ...deck, version: "4.3.10" } })).toContain("ccdeck v4.3.10");
  });

  it("leaves the Restart row to the app's own update while one is ready, which that press takes", () => {
    const items = labels({ drift: { serving: "4.3.7", to: "4.3.11" }, update: { status: "ready", version: "4.3.11" } });
    expect(items).toContain("Restart to update to v4.3.11");
    expect(items).toContain("Restart ccdeck");
    expect(items).toContain("ccdeck v4.3.10 · deck v4.3.7, v4.3.11 installed");
    // One that asks for a password is not taken by that press (restartDeck),
    // which restarts the deck: the row says so.
    expect(labels({ drift: { serving: "4.3.7", to: "4.3.11" }, update: { status: "ready", version: "4.3.11" }, updateAsksPassword: true }))
      .toContain("Restart ccdeck to run v4.3.11");
  });
});

describe("the app's wiring", () => {
  const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");
  const fn = (name: string) => {
    const at = main.search(new RegExp(`(?:async )?function ${name}\\(`));
    expect(at, `${name} is gone or renamed`).toBeGreaterThan(-1);
    return main.slice(at, main.indexOf("\n}\n", at));
  };

  it("asks every deck it attaches to, on every look and reconnect, and every few minutes after", () => {
    expect(fn("attach")).toMatch(/live: \(\) => \{[^}]*refreshDeckVersion\(\);[^}]*\}/);
    expect(fn("refreshDeckVersion")).toMatch(/deckJson\(asked, "\/api\/version"/);
    expect(fn("restartOlderDeckWhenQuiet")).toMatch(/Date\.now\(\) - deckVersionsAt >= VERSION_LOOK_MS/);
    expect(VERSION_LOOK_MS).toBe(5 * MIN);
    expect(main).toMatch(/updateWhenQuiet\(\); restartOlderDeckWhenQuiet\(\); \}, 10_000\);/);
  });

  it("restarts through the deck's own route with whenIdle, and nothing else", () => {
    const body = fn("restartOlderDeckWhenQuiet");
    expect(body).toMatch(/deckJson\(asked, "\/api\/restart", \{ method: "POST", body: \{ whenIdle: true \}/);
    // Not the stop route, not a signal, and no deck of the app's own beside it.
    expect(body).not.toMatch(/api\/shutdown|\bstopChild\(|\bstopOwnDeck\(|\.kill\(|\bensureDeck\(|\bstartOwnDeck\(|\bstartDeck\(/);
    // Under the app's own quiet, measured on the same tick.
    expect(body).toMatch(/quietSince,\s*idleSince,/);
    expect(body).toMatch(/busy: !!starting \|\| !!restarting,/);
    expect(body).toMatch(/autoUpdate: deckAutoUpdate,/);
    // And the deck's own switch read again at the moment of asking.
    expect(body).toMatch(/await refreshPrefs\(\);[\s\S]*?if \(deck !== asked \|\| deckAutoUpdate !== true \|\| starting \|\| restarting\) return;[\s\S]*?"\/api\/restart"/);
  });

  it("settles what the restart came to from the deck's next answer", () => {
    expect(fn("refreshDeckVersion")).toMatch(/landing\(\{ tried: deckRestartTried, pid: asked\.pid, serving: deckVersions\?\.serving/);
    expect(fn("refreshPrefs")).toMatch(/deckAutoUpdate = json\?\.prefs \? json\.prefs\.autoUpdate !== false : null;/);
  });

  it("draws the tray from what the deck said", () => {
    expect(fn("buildMenu")).toMatch(/drift: olderVersionOf \? trayDrift\(deckVersions, olderVersionOf\) : null,/);
  });
});
