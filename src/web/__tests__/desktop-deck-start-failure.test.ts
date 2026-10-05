// The desktop app's own deck, when it cannot start.
//
// A deck that cannot install its Claude hooks — a settings.json that does not
// parse, or one a past `sudo claude` left owned by root — prints why and exits
// in its first second, and its supervisor does not restart a deck that never
// served. The app went on waiting the whole forty seconds anyway, the tray
// saying "Starting the deck…" and then "No deck running", and the reason was
// only ever in deck-app.log. A launcher that could not be written threw out of
// the start altogether, into an `await` at startup that then skipped the rest
// of the app's setup.
//
// The start and its wait are own-deck.mjs's startOwnDeck now, run here against
// a stand-in child and a log in a temp dir; what the tray says is tray-menu.mjs,
// and the last block pins main.mjs's use of both, since main.mjs imports
// electron and cannot be loaded here.
import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { startOwnDeck } from "../../../desktop/own-deck.mjs";
import { statusLine, trayMenuItems } from "../../../desktop/tray-menu.mjs";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-deck-start-"));
afterAll(() => rmTempDir(DIR));

let n = 0;
/** A deck-app.log with an earlier run's lines already in it. */
function log() {
  const file = join(DIR, `deck-app-${n++}.log`);
  writeFileSync(file, "ccdeck  an earlier run\n  ✓ Claude hooks  /old/hook.js\n");
  return file;
}

/** What the deck prints on its way out when the hooks cannot be installed
 *  (bin/cli/startup.js). */
const HOOKS_FAILED = [
  "  ✓ workspace  (all)",
  "  ✗ Claude hooks  not installed",
  "",
  "  ccdeck: /home/x/.claude/settings.json is not valid JSON — fix the file or move it aside.",
  "  Or start with --no-claude to run without Claude hooks.",
  "",
].join("\n");

describe("a deck that exits while it is starting", () => {
  it("ends the wait at once, with what the deck said on its way out", async () => {
    const logFile = log();
    let looks = 0;
    const began = Date.now();
    const out = await startOwnDeck({
      logFile,
      start: (exited: (code: number | null, signal: string | null) => void) => {
        setTimeout(() => { appendFileSync(logFile, HOOKS_FAILED); exited(1, null); }, 20);
      },
      look: async () => { looks++; },
      found: () => false,
      tries: 40,
      everyMs: 100,
    });
    // Forty looks a tenth of a second apart is four seconds; the deck was gone
    // after a fiftieth of one.
    expect(Date.now() - began, "the wait went on after the deck had exited").toBeLessThan(1500);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("settings.json is not valid JSON");
    // Only this start's lines: the earlier run's are not the reason.
    expect(out.reason).not.toContain("an earlier run");
    expect(out.reason).not.toContain("/old/hook.js");
    // And it looked once more after the exit, before calling it a failure.
    expect(looks).toBeGreaterThanOrEqual(1);
  });

  it("says how it exited when it said nothing", async () => {
    const out = await startOwnDeck({
      logFile: log(),
      start: (exited: (code: number | null, signal: string | null) => void) => { setTimeout(() => exited(1, null), 10); },
      look: async () => {},
      found: () => false,
      tries: 40,
      everyMs: 100,
    });
    expect(out).toEqual({ ok: false, reason: expect.stringMatching(/exit code 1/) });
  });

  it("is no failure when the look after the exit finds a deck — one already running took over", async () => {
    let there = false;
    const out = await startOwnDeck({
      logFile: log(),
      start: (exited: (code: number | null, signal: string | null) => void) => { setTimeout(() => { there = true; exited(0, null); }, 10); },
      look: async () => {},
      found: () => there,
      tries: 40,
      everyMs: 100,
    });
    expect(out).toEqual({ ok: true });
  });
});

describe("a start that throws", () => {
  it("is a failed start with the reason, not a rejection", async () => {
    // writeLauncher's mkdir in a ~/.claude the person cannot write to.
    const err = Object.assign(new Error("EACCES: permission denied, mkdir '/home/x/.claude/agent-dag'"), { code: "EACCES" });
    const out = await startOwnDeck({
      logFile: log(),
      start: () => { throw err; },
      look: async () => {},
      found: () => false,
      tries: 3,
      everyMs: 10,
    });
    expect(out).toEqual({ ok: false, reason: expect.stringContaining("EACCES: permission denied") });
  });

  it("is a failed start when the log itself cannot be read", async () => {
    const out = await startOwnDeck({
      logFile: join(DIR, "no-such-dir", "deck-app.log"),
      start: (exited: (code: number | null, signal: string | null) => void) => { setTimeout(() => exited(1, null), 10); },
      look: async () => {},
      found: () => false,
      tries: 40,
      everyMs: 100,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/exit code 1/);
  });
});

describe("a deck that comes up", () => {
  it("is found, and no reason is made up", async () => {
    let looks = 0;
    const out = await startOwnDeck({
      logFile: log(),
      start: () => {},
      look: async () => { looks++; },
      found: () => looks >= 2,
      tries: 40,
      everyMs: 10,
    });
    expect(out).toEqual({ ok: true });
  });

  it("is not called a failure while it is still starting at the end of the wait", async () => {
    // Still running, still not listening: it may yet come up, and the app's
    // five-second look attaches it then.
    const out = await startOwnDeck({
      logFile: log(),
      start: () => {},
      look: async () => {},
      found: () => false,
      tries: 3,
      everyMs: 10,
    });
    expect(out).toEqual({ ok: false, reason: null });
  });
});

describe("what the tray says after a failed start", () => {
  const quiet = { icon: "offline", waiting: 0, running: 0, title: "ccdeck", blocked: [] as unknown[] };
  const s = (over: Record<string, unknown>) =>
    statusLine({ restarting: null, starting: null, deck: null, snapshot: quiet, ...over });

  it("says the deck could not start, rather than that none is running", () => {
    expect(s({ startFailed: "ccdeck: settings.json is not valid JSON" })).toBe("The deck could not start");
    expect(s({ startFailed: null })).toBe("No deck running");
    // A start under way, or a deck that answered since, outranks it.
    expect(s({ startFailed: "x", starting: Promise.resolve() })).toBe("Starting the deck…");
    expect(s({ startFailed: "x", deck: { port: 4317 }, snapshot: { ...quiet, icon: "idle" } })).toBe("Idle");
  });

  it("still offers to start it again", () => {
    const items = trayMenuItems({
      now: 0, snapshot: quiet, deck: null, starting: null, restarting: null, notifyOn: null,
      openAtLogin: false, appVersion: "3.40.0", update: { status: "idle" }, startFailed: "x",
    }, { startDeck: () => {} } as never) as Array<{ label?: string; enabled?: boolean }>;
    expect(items[0]).toEqual({ label: "The deck could not start", enabled: false });
    expect(items.some(i => i.label === "Start the deck")).toBe(true);
  });
});

describe("the app's wiring", () => {
  const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");
  const fn = (name: string) => {
    const at = main.search(new RegExp(`(?:async )?function ${name}\\(`));
    expect(at, `${name} is gone or renamed`).toBeGreaterThan(-1);
    return main.slice(at, main.indexOf("\n}\n", at));
  };

  it("starts its deck through startOwnDeck, which hears the deck exit", () => {
    const body = fn("ensureDeck");
    expect(body).toContain("await startOwnDeck({");
    // The launcher is written inside the start, where a throw is a failed start.
    expect(body).toMatch(/start: exited => \{\s*const launcher = writeLauncher\(process\.execPath\);/);
    expect(body).toMatch(/ownDeck\.track\(startDeck\(\{[\s\S]*?exited\(code, signal\);/);
    // And says why, in the tray and in front of the person.
    expect(body).toContain("startFailed = started.reason;");
    expect(body).toContain("sayStartFailed(started.reason, logFile);");
  });

  it("does not let a failed start stop the rest of startup, or go unhandled", () => {
    expect(main).toMatch(/await ensureDeck\(\)\.catch\(err => trace\(/);
    expect(main).not.toMatch(/^ {2}await ensureDeck\(\);$/m);
    expect(fn("openWindow")).toMatch(/ensureDeck\(\)\.then\(found => \{ if \(found\) openWindow\(steal\); \}\)\.catch\(/);
    // Start the deck opens the window only for a deck that came up: a failed
    // start went on into openWindow, which started a second one.
    expect(main).toMatch(/startDeck: \(\) => ensureDeck\(\)\.then\(found => \{ if \(found\) openWindow\(\); \}\)\.catch\(/);
  });

  it("shows the reason in the tray until a deck answers", () => {
    expect(main).toContain("statusLine({ restarting, starting, deck, snapshot, startFailed })");
    expect(fn("buildMenu")).toContain("startFailed,");
    expect(fn("attach")).toContain("if (found) startFailed = null;");
  });
});
