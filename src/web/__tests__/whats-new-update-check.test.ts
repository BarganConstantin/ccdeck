// What's new › Check for updates, and the action strip it sits in.
//
// The owner asked for a way to ask for an update from What's new: the version
// chip was the only one, and on a phone, or in a topbar somebody has not
// learned, it is easy to miss. Then for the dialog's stacked rows to become one
// strip of small buttons with icons. What these cases hold:
//
//   - every state the line under the strip can be in, on every install shape,
//     in the exact words it says them (update-check.ts);
//   - that the button is the chip's own check, under the server's own rate
//     floor, and that the offer is the banner's own action;
//   - the strip as drawn: three buttons with glyphs, each sentence kept as a
//     description, Restart last, and the line a live region from the start.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

import {
  CHECK_MIN_BUSY_MS, CHECKS_OFF, DECK_UNREACHABLE, NPM_UNREACHABLE, runUpdateCheck, updateCheckState,
  type UpdateCheckFacts,
} from "../update-check";
import type { VersionInfo } from "../use-version-check";
import { UPGRADE_BLOCK_TEXT } from "../components/VersionBanner";
import ReleaseActions, { RESTART_WHY, TOUR_WHY, UpdateLineView } from "../components/ReleaseActions";

const { homeRef } = vi.hoisted(() => ({ homeRef: { dir: null as string | null } }));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  const patched = { ...actual, homedir: () => homeRef.dir ?? actual.homedir() };
  return { ...patched, default: patched };
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const NOW = 1_900_000_000_000;
const MIN = 60_000;
const MENU = "the ccdeck menu in the menu bar";

const version = (over: Partial<VersionInfo> = {}): VersionInfo => ({
  name: "ccdeck", running: "3.38.6", installed: "3.38.6", latest: "3.38.6", latestPending: null, notice: null,
  command: "npm i -g ccdeck@latest", canRestart: true, checkedAt: NOW - 12 * MIN, checkFailedAt: null,
  checkDisabled: false, upgradeBlocked: null, upgradeMode: "install",
  upgrade: { state: "idle", command: null, error: null }, ...over,
});
const OUT: Partial<VersionInfo> = { latest: "3.38.7", notice: { kind: "upgrade", from: "3.38.6", to: "3.38.7" }, checkedAt: NOW };
const NPX: Partial<VersionInfo> = { upgradeMode: "npx", upgradeBlocked: "npx", command: "npx -y ccdeck@latest" };
const CHECKOUT: Partial<VersionInfo> = { upgradeMode: null, upgradeBlocked: "git_checkout", command: "git pull && npm run build" };

const facts = (over: Partial<UpdateCheckFacts> = {}): UpdateCheckFacts => ({
  version: version(), running: "3.38.6", checking: false, answered: false, unreachable: false, now: NOW,
  upgradeState: "idle", copied: false, restarting: false,
  app: { inApp: false, update: null, version: null, menu: MENU }, ...over,
});
const stateOf = (over: Partial<UpdateCheckFacts> = {}) => updateCheckState(facts(over), UPGRADE_BLOCK_TEXT);
const lineOf = (over: Partial<UpdateCheckFacts> = {}) => stateOf(over)!.line;
const inApp = (update: UpdateCheckFacts["app"] extends infer A ? A extends { update: infer U } ? U : never : never) =>
  facts({ version: version({ latest: null, checkedAt: null, checkDisabled: true }), app: { inApp: true, update, version: "3.38.6", menu: MENU } });

describe("the line under the actions, state by state", () => {
  it("idle: offers the check, and says when the last one ran", () => {
    expect(stateOf()).toEqual({
      canCheck: true, checking: false,
      line: { said: "", tone: "answer", age: "Last checked 12 min ago.", command: null, action: null },
    });
    // Never checked: nothing to date, and nothing made up.
    expect(lineOf({ version: version({ checkedAt: null }) })).toMatchObject({ said: "", age: null });
    expect(lineOf({ version: null })).toMatchObject({ said: "", age: null });
  });

  it("checking: the button turns and the line says so", () => {
    expect(stateOf({ checking: true })).toEqual({
      canCheck: true, checking: true, line: { said: "Checking…", tone: "answer", age: null, command: null, action: null },
    });
  });

  it("up to date: the running version, and when it was confirmed", () => {
    expect(lineOf({ answered: true, version: version({ checkedAt: NOW }) }))
      .toEqual({ said: "You're on the latest, 3.38.6.", tone: "answer", age: "Checked just now.", command: null, action: null });
    // A checkout that leads npm is not "on the latest", and says what it is.
    expect(lineOf({ answered: true, running: "3.39.0", version: version({ running: "3.39.0", installed: "3.39.0", checkedAt: NOW }) }).said)
      .toBe("You're on 3.39.0, ahead of npm's 3.38.6.");
  });

  it("not available yet: names the version, says it cannot be installed, and when the deck looks again", () => {
    expect(lineOf({ answered: true, version: version({ latestPending: "3.38.7", checkedAt: NOW }) }))
      .toEqual({ said: "3.38.7 is tagged on npm but can't be installed yet. The deck looks again in five minutes.", tone: "answer", age: null, command: null, action: null });
  });

  it("failure: npm not reached, the button back to a check", () => {
    const failed = version({ checkFailedAt: NOW, checkedAt: NOW - 12 * MIN });
    expect(stateOf({ answered: true, version: failed }))
      .toEqual({ canCheck: true, checking: false, line: { said: NPM_UNREACHABLE, tone: "warn", age: null, command: null, action: null } });
    expect(NPM_UNREACHABLE).toBe("Couldn't reach npm. Try again.");
    // Found by the background poll rather than a press: dated.
    expect(lineOf({ version: version({ checkFailedAt: NOW - 3 * MIN, checkedAt: NOW - 70 * MIN }) }))
      .toMatchObject({ said: NPM_UNREACHABLE, age: "Last tried 3 min ago." });
    // A failure older than the last success is history, not news.
    expect(lineOf({ version: version({ checkFailedAt: NOW - 30 * MIN, checkedAt: NOW - 12 * MIN }) }).said).toBe("");
  });

  it("failure: the deck itself did not answer", () => {
    expect(lineOf({ unreachable: true, answered: true })).toMatchObject({ said: DECK_UNREACHABLE, tone: "warn" });
    expect(DECK_UNREACHABLE).toBe("Couldn't reach the deck. Try again.");
  });

  it("installed and waiting for a restart: points at Restart, the strip's own", () => {
    const waiting = { notice: { kind: "restart" as const, from: "3.38.6", to: "3.38.7" }, installed: "3.38.7" };
    expect(lineOf({ version: version(waiting) }).said).toBe("3.38.7 is installed. Restart the deck to start running it.");
    expect(lineOf({ version: version({ ...waiting, canRestart: false }) }).said).toBe("3.38.7 is installed. Restart ccdeck to start running it.");
  });
});

describe("an update available, offered as the banner offers it on each channel", () => {
  it("a global npm install: Update now, then Installing… while npm runs", () => {
    expect(lineOf({ version: version(OUT) })).toEqual({
      said: "3.38.7 is out.", tone: "answer", age: null, command: null,
      action: { kind: "install", label: "Update now", busy: false, why: "Runs npm i -g ccdeck@latest here, then restarts once nothing is running." },
    });
    expect(lineOf({ version: version(OUT), upgradeState: "running" }))
      .toMatchObject({ said: "Installing 3.38.7…", action: { kind: "install", busy: true } });
    expect(lineOf({ version: version(OUT), upgradeState: "done" })).toMatchObject({ said: "3.38.7 is installed.", action: null });
    // A failed install leaves the command, as the banner does.
    expect(lineOf({ version: version(OUT), upgradeState: "failed" })).toEqual({
      said: "Installing 3.38.7 failed. Run it yourself:", tone: "answer", age: null, command: "npm i -g ccdeck@latest",
      action: { kind: "copy", label: "Copy", busy: false },
    });
  });

  it("npx: Update & restart, which is a restart that fetches; Retry after one came back on the old version", () => {
    expect(lineOf({ version: version({ ...OUT, ...NPX }) })).toEqual({
      said: "3.38.7 is out.", tone: "answer", age: null, command: null,
      action: {
        kind: "npx", label: "Update & restart", busy: false,
        why: "Runs npx -y ccdeck@latest and hands it this port. Nothing is installed globally — npx unpacks its own copy.",
      },
    });
    expect(lineOf({ version: version({ ...OUT, ...NPX }), restarting: true }).action).toMatchObject({ kind: "npx", busy: true });
    expect(lineOf({ version: version({ ...OUT, ...NPX }), upgradeState: "failed" }))
      .toMatchObject({ said: "The last update to 3.38.7 came back on 3.38.6.", action: { kind: "npx", label: "Retry update" } });
    // Unsupervised, npx cannot come back by itself: the command, in the banner's words.
    expect(lineOf({ version: version({ ...OUT, ...NPX, canRestart: false }) })).toEqual({
      said: "3.38.7 is out, but npx runs from a cache that cannot be upgraded in place — run:", tone: "answer", age: null,
      command: "npx -y ccdeck@latest", action: { kind: "copy", label: "Copy", busy: false },
    });
  });

  it("a source checkout, and every other shape that cannot install in place: the command to run", () => {
    expect(lineOf({ version: version({ ...OUT, ...CHECKOUT }) })).toEqual({
      said: "3.38.7 is out, but this deck runs from a git checkout — pull instead:", tone: "answer", age: null,
      command: "git pull && npm run build", action: { kind: "copy", label: "Copy", busy: false },
    });
    expect(lineOf({ version: version({ ...OUT, ...CHECKOUT }), copied: true }).action).toMatchObject({ label: "Copied" });
    for (const blocked of ["one_off", "not_writable", "retired_name"]) {
      expect(lineOf({ version: version({ ...OUT, upgradeMode: null, upgradeBlocked: blocked }) }).said)
        .toBe(`3.38.7 is out, but ${UPGRADE_BLOCK_TEXT[blocked]}`);
    }
    // A reason this build has no words for, or one naming a prototype member,
    // is not a sentence (#474).
    expect(lineOf({ version: version({ ...OUT, upgradeMode: null, upgradeBlocked: "constructor" }) }).said).toBe("3.38.7 is out. Run:");
  });

  it("the desktop app: the app's own updater, and its verified update is the dialog's top door", () => {
    expect(updateCheckState(inApp({ status: "downloading", version: "3.38.7" }), UPGRADE_BLOCK_TEXT))
      .toEqual({ canCheck: false, checking: false, line: { said: "3.38.7 is out. The app is downloading it.", tone: "note", age: null, command: null, action: null } });
    // Ready: the door at the top says it, with Restart to update; nothing here.
    expect(updateCheckState(inApp({ status: "ready", version: "3.38.7" }), UPGRADE_BLOCK_TEXT)).toBeNull();
  });
});

describe("where no check can run, the line says why instead of offering a button", () => {
  it("update checks switched off", () => {
    expect(stateOf({ version: version({ latest: null, checkedAt: null, checkDisabled: true }) }))
      .toEqual({ canCheck: false, checking: false, line: { said: CHECKS_OFF, tone: "note", age: null, command: null, action: null } });
    expect(CHECKS_OFF).toBe("Update checks are off on this deck (AGENTS_DECK_NO_UPDATE_CHECK or AGENTS_DECK_NO_INSTALL).");
  });

  it("the desktop app's own deck, which leaves updates to the app: its updater's state, and the menu that can check", () => {
    const said = (update: Parameters<typeof inApp>[0]) => updateCheckState(inApp(update), UPGRADE_BLOCK_TEXT)!.line.said;
    expect(said(null)).toBe(`The app keeps itself up to date. To check now, use Check for updates in ${MENU}.`);
    expect(said({ status: "idle", version: null })).toBe(`The app keeps itself up to date. To check now, use Check for updates in ${MENU}.`);
    expect(said({ status: "checking", version: null })).toBe("The app is checking for updates…");
    expect(said({ status: "current", version: null })).toBe(`You're on the latest, 3.38.6. To check again, use Check for updates in ${MENU}.`);
    expect(said({ status: "error", version: null })).toBe(`The app's last update check failed. Try Check for updates in ${MENU}.`);
    expect(said({ status: "downloading", version: null })).toBe("The app is downloading an update.");
  });

  it("the app attached to a deck from npm keeps the chip's check, which works there", () => {
    const attached = facts({ app: { inApp: true, update: { status: "current", version: null }, version: "3.38.6", menu: MENU } });
    expect(updateCheckState(attached, UPGRADE_BLOCK_TEXT)!.canCheck).toBe(true);
  });
});

describe("the press is the chip's own check, under the same rules", () => {
  it("asks for the forced check the chip asks for, once, and holds the button busy at least a moment", async () => {
    const loadVersion = vi.fn(async () => version());
    const waited: number[] = [];
    const result = await runUpdateCheck(loadVersion, async ms => { waited.push(ms); });
    expect(loadVersion).toHaveBeenCalledTimes(1);
    expect(loadVersion).toHaveBeenCalledWith(true);
    expect(waited).toEqual([CHECK_MIN_BUSY_MS]);
    expect(result).toBe("answered");
  });

  it("tells a deck that did not answer from npm that did not", async () => {
    expect(await runUpdateCheck(async () => null, async () => {})).toBe("unreachable");
  });

  it("is the same loadVersion the chip calls, from the same version check", () => {
    // The chip's healthy branch forces the check as it opens the dialog.
    expect(read("../components/VersionChip.tsx")).toContain("onClick={() => { openReleaseNotes(); loadVersion(true); }}");
    // The button runs the press over the dialog's versionCheck…
    expect(read("../components/ReleaseActions.tsx")).toContain("await runUpdateCheck(versionCheck.loadVersion);");
    // …which is the one App.tsx hands the topbar, where the chip is.
    expect(read("../components/DeckDialogs.tsx")).toMatch(/: \{ versionCheck, upgrade, restart, desktopUpdate, running: chipVersion, onHandOff: closeReleaseNotes \}/);
    const app = read("../App.tsx");
    expect(app).toMatch(/<ReadoutGroup\s+versionCheck=\{versionCheck\}/);
    expect(app).toMatch(/<DeckDialogs\b[^>]*\bversionCheck=\{versionCheck\}/);
    // Busy, never disabled, and one press at a time — joining the chip's check
    // when one is already out (#620).
    expect(read("../components/ReleaseActions.tsx")).toContain("if (!selfPressAccepted(pressingRef.current || versionChecking)) return;");
  });

  it("offers the banner's own actions, not a mechanism of its own", () => {
    const strip = read("../components/ReleaseActions.tsx");
    expect(strip).toContain("if (action.kind === \"copy\") return void upgrade.copyCommand();");
    expect(strip).toContain("if (action.kind === \"install\") void upgrade.startUpgrade();");
    expect(strip).toContain("else void restart.askRestart({ upgrade: true });");
  });
});

describe("the rate rule holds for a press from What's new", () => {
  let home = "";
  let calls: string[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ccdeck-home-"));
    homeRef.dir = home;
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return String(url).endsWith("/dist-tags")
        ? { ok: true, status: 200, json: async () => ({ latest: "3.38.7" }) }
        : { ok: true, status: 200, json: async () => ({ name: "ccdeck", version: "3.38.7" }) };
    }));
    vi.resetModules();
  });
  afterEach(() => {
    homeRef.dir = null;
    vi.unstubAllGlobals();
    rmTempDir(home);
  });

  it("a forced check a moment after the chip's asks npm nothing more, and one a minute on asks once", async () => {
    const { latestOnNpm } = await import("../../server/npm-latest.mjs") as unknown as {
      latestOnNpm: (name: string, now: number, force?: boolean) => Promise<string | null>;
    };
    // The chip's click: the first ask of this process, tag plus confirmation.
    expect(await latestOnNpm("ccdeck", NOW, true)).toBe("3.38.7");
    expect(calls).toHaveLength(2);
    // What's new's button ten seconds later: the server's floor answers it.
    calls = [];
    expect(await latestOnNpm("ccdeck", NOW + 10_000, true)).toBe("3.38.7");
    expect(calls).toEqual([]);
    // A minute on, one ~20-byte GET, as the README says.
    expect(await latestOnNpm("ccdeck", NOW + 60_000, true)).toBe("3.38.7");
    expect(calls).toEqual(["https://registry.npmjs.org/-/package/ccdeck/dist-tags"]);
  });
});

// ── as drawn ────────────────────────────────────────────────────────────────

const noop = () => {};
const wiring = (v: VersionInfo | null, over: { versionChecking?: boolean } = {}) => ({
  versionCheck: { version: v, notice: v?.notice ?? null, noticeOpen: false, showNotice: noop, dismissNotice: noop,
    versionChecking: over.versionChecking ?? false, loadVersion: async () => v },
  upgrade: { upgradeState: "idle", upgradeFailure: null, startUpgrade: async () => {}, copyCommand: async () => {}, cmdCopied: false },
  restart: { restarting: false, askRestart: async () => {} },
  desktopUpdate: { appUpdate: null, readyAppUpdate: null },
  running: "3.38.6",
  onHandOff: noop,
}) as never;
const draw = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ReleaseActions, props));
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(m => m[0]);
const text = (tag: string) => tag.replace(/<[^>]+>/g, "");

describe("the strip as drawn", () => {
  const live = version({ checkedAt: Date.now() - 12 * MIN });

  it("is three small buttons, each a glyph and a word, Restart last and set apart", () => {
    const html = draw({ onTour: noop, onRestart: noop, updateCheck: wiring(live) });
    const all = buttons(html);
    expect(all.map(text)).toEqual(["Take the tour", "Check for updates", "Restart"]);
    for (const b of all) {
      expect(b).toMatch(/^<button type="button" class="btn rn-act/);
      expect(b).toMatch(/<svg class="glyph"[^>]*aria-hidden="true"/);
    }
    expect(all[2]).toMatch(/class="btn rn-act rn-act-restart"/);
  });

  it("keeps each row's sentence as the button's description", () => {
    const html = draw({ onTour: noop, onRestart: noop, updateCheck: wiring(live) });
    const describedBy = (b: string) => /aria-describedby="([^"]+)"/.exec(b)![1];
    const sentence = (id: string) => new RegExp(`<span hidden="" id="${id.replace(/[:]/g, "\\:")}">([^<]+)</span>`).exec(html)?.[1];
    const [tour, check, restart] = buttons(html);
    expect(sentence(describedBy(tour))).toBe(TOUR_WHY);
    expect(TOUR_WHY).toBe("Eight pictures of what the deck shows.");
    expect(sentence(describedBy(check))).toBe("Ask npm now whether a newer ccdeck is out.");
    expect(sentence(describedBy(restart))).toBe(RESTART_WHY);
  });

  it("mounts the answer as a polite live region from the start, and keeps the age readable but out of it", () => {
    const html = draw({ onTour: noop, updateCheck: wiring(live) });
    expect(html).toContain('<p class="rn-update-line" data-tone="answer"><span class="rn-update-what" role="status"></span>'
      + '<span class="rn-update-age">Last checked 12 min ago.</span></p>');
    // Nothing checked yet: the region is still there, and empty.
    expect(draw({ updateCheck: wiring(version({ checkedAt: null })) }))
      .toContain('<p class="rn-update-line" data-tone="answer"><span class="rn-update-what" role="status"></span></p>');
    // Empty, it takes no room and no gap, and stays in the tree.
    expect(read("../styles/dialogs.css")).toContain(".release-notes .rn-update-what:empty { position: absolute; }");
  });

  it("stands Restart down while the line offers an update, which restarts too", () => {
    const html = draw({ onTour: noop, onRestart: noop, updateCheck: wiring(version(OUT)) });
    expect(buttons(html).map(text)).toEqual(["Take the tour", "Check for updates", "Update now"]);
    // A command to copy restarts nothing, so Restart stays beside it.
    const copy = draw({ onTour: noop, onRestart: noop, updateCheck: wiring(version({ ...OUT, ...CHECKOUT })) });
    expect(buttons(copy).map(text)).toEqual(["Take the tour", "Check for updates", "Restart", "Copy"]);
  });

  it("is busy, never disabled, while the chip's check is out", () => {
    const html = draw({ onTour: noop, updateCheck: wiring(live, { versionChecking: true }) });
    const check = buttons(html).find(b => text(b) === "Check for updates")!;
    expect(check).toContain('aria-busy="true"');
    expect(check).not.toContain("disabled");
    expect(html).toContain('<span class="rn-update-what" role="status">Checking…</span>');
  });

  it("draws no Check for updates where none can run, and says why on the line", () => {
    const html = draw({ onTour: noop, onRestart: noop, updateCheck: wiring(version({ checkDisabled: true, latest: null, checkedAt: null })) });
    expect(buttons(html).map(text)).toEqual(["Take the tour", "Restart"]);
    expect(html).toContain(`<p class="rn-update-line" data-tone="note"><span class="rn-update-what" role="status">${CHECKS_OFF}</span>`);
  });

  it("draws nothing at all when it has nothing to offer", () => {
    expect(draw({})).toBe("");
  });
});

describe("the line as drawn", () => {
  const line = (over: Partial<VersionInfo>) => updateCheckState(facts({ version: version(over) }), UPGRADE_BLOCK_TEXT)!.line;

  it("puts the banner's update on the line as its primary, saying what a press does, at a 24px target and 32px under a finger", () => {
    const html = renderToStaticMarkup(createElement(UpdateLineView, { line: line(OUT), onAct: noop, whyId: "why" }));
    expect(html).toBe('<p class="rn-update-line" data-tone="answer"><span class="rn-update-what" role="status">3.38.7 is out.</span>'
      + '<button type="button" class="btn primary rn-line-act" aria-describedby="why">Update now</button>'
      + '<span hidden="" id="why">Runs npm i -g ccdeck@latest here, then restarts once nothing is running.</span></p>');
    expect(read("../styles/dialogs.css")).toMatch(/\.release-notes \.rn-line-act \{ min-height: 24px;/);
    expect(read("../styles/touch-and-forced-colours.css")).toMatch(/\.release-notes \.rn-line-act,\s*\.release-notes \.rn-update-line \{ min-height: 32px; \}/);
  });

  it("draws a check that came to nothing in the warning's ink, and a standing note in the muted one", () => {
    const css = read("../styles/dialogs.css");
    expect(css).toContain('.release-notes .rn-update-line[data-tone="warn"] .rn-update-what { color: var(--warn); }');
    expect(css).toContain('.release-notes .rn-update-line[data-tone="note"] .rn-update-what { color: var(--muted); }');
  });

  it("keeps a command and its Copy together, so they wrap as one", () => {
    const html = renderToStaticMarkup(createElement(UpdateLineView, { line: line({ ...OUT, ...CHECKOUT }), onAct: noop }));
    expect(html).toContain('<span class="rn-update-cmd"><code class="rn-code">git pull &amp;&amp; npm run build</code>'
      + '<button type="button" class="btn rn-line-act">Copy</button></span></p>');
  });
});

describe("motion and contrast themes", () => {
  const css = read("../styles/dialogs.css");
  it("turns the arrow while a check is out, and not under reduced motion", () => {
    expect(css).toContain('.release-notes .rn-act[aria-busy="true"] .glyph { animation: spin 900ms linear infinite; }');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.release-notes \.rn-act\[aria-busy="true"\] \.glyph \{ animation: none; \}/);
  });
  it("marks the busy button in the highlight under forced colours", () => {
    expect(read("../styles/touch-and-forced-colours.css")).toContain('.release-notes .rn-act[aria-busy="true"] { border-color: Highlight; }');
  });
});
