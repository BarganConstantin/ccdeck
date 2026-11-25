// Resume here after exit: a Claude session running in a terminal outside the
// deck, where the move into the deck is not on offer (a Ghostty whose
// scripting cannot find Claude's window, another terminal, a machine that is
// not a Mac) or did not happen. Armed, the pane stays open and waits for that
// exact session to end where it runs, then reopens the same conversation here
// by itself. use-terminal-session.test.ts holds the controller's steps against
// a fake deck; this file holds the card, the stage's wiring, the words in
// every language, and one run against this machine's real process table, with
// stand-in `claude` processes this file starts and stops.
import { afterAll, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { all, one, textOf, type Drawn } from "./fake-react";
import { withoutComments } from "./tsx-scan";
import { rmTempDir } from "./rm-temp-dir";
import {
  AFTER_EXIT_OFFER_MSG, HANDOFF_MANUAL_AFTER_EXIT_MSG, HANDOFF_MANUAL_MSG, HANDOFF_REASON_MSG, StateCard, type StageBodyProps,
} from "../components/terminal/StageBody";
import { REPEAT_PRESS_MS, repeatedPress } from "../components/terminal/TerminalStage";
import {
  AFTER_EXIT_HOW_MSG, AFTER_EXIT_MSG, AFTER_EXIT_WAITING_MSG, RESUME_BY_HAND_MSG, resumeCommand, type StagePhase,
} from "../components/terminal/stage-model";
import { EXIT_WATCH_POLL_MS, createTerminalSession, type SessionDeps, type SessionSnapshot } from "../use-terminal-session";
import { connectTerminal } from "../terminal-protocol";
import type { SessionRef, Ticketed } from "../terminal-api";
import { en } from "../i18n/en";
import { catalogFor } from "../i18n/catalogs";
// @ts-expect-error — plain .mjs server module, no types
import { describeTarget, resolveTarget } from "../../server/terminal-target.mjs";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const button = (tree: unknown, name: string) =>
  one(tree, el => el.type === "button" && (el.props["aria-label"] === name || textOf(el).trim() === name));
const read = (path: string) => withoutComments(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));

const target = { kind: "C" as const, label: "External session", adoptable: true };
const elsewhere = { kind: "not-attachable" as const, target, stillRunning: true, busy: false };
const armed = { ...elsewhere, awaitingExit: true };

function bodyProps(phase: StagePhase, over: Partial<StageBodyProps> = {}): StageBodyProps {
  return {
    hostRef: { current: null }, phase,
    context: { prompt: "Refactor mailbox controller" },
    onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(), ...over,
  };
}
const afterExit = () => ({ arm: vi.fn(), cancel: vi.fn() });
/** The actions row's children as the card lays them out, placeholders kept:
 *  a button keeps its DOM node (and the focus on it) only at the same index. */
const actsOf = (tree: unknown) => (one(tree, el => el.props.className === "ts-acts")?.props.children ?? []) as unknown[];
const slotOf = (tree: unknown) => actsOf(tree).findIndex(c => !!c && typeof c === "object" && "props" in c && (c as Drawn).props["data-after-exit"] !== undefined);

describe("the card", () => {
  it("offers Resume here after exit where no move is, and says what it does", () => {
    const ways = afterExit();
    const props = bodyProps(elsewhere, { afterExit: ways });
    const out = html(createElement(StateCard, props));
    expect(out).toContain(en[AFTER_EXIT_OFFER_MSG]);
    expect(out, "not the line that says to wait for Reopen here").not.toContain(en["board.stage.elsewhere.running"]);
    const tree = StateCard(props);
    const arm = button(tree, en[AFTER_EXIT_MSG]);
    expect(arm?.props.className).toBe("btn primary");
    // Starting a wait is nothing to land on by accident: the keys go to Not now.
    expect(arm?.props["data-stage-land"]).toBeUndefined();
    expect(button(tree, "Not now")?.props["data-stage-land"]).toBe(true);
    (arm!.props.onClick as () => void)();
    expect(ways.arm).toHaveBeenCalledOnce();
    // Without the stage's offer the card is the one it was.
    expect(button(StateCard(bodyProps(elsewhere)), en[AFTER_EXIT_MSG])).toBeNull();
    expect(html(createElement(StateCard, bodyProps(elsewhere)))).toContain(en["board.stage.elsewhere.running"]);
  });

  it("waits with one status line, one line of what to do, and Cancel as its only button", () => {
    const ways = afterExit();
    const props = bodyProps(armed, { afterExit: ways, handoff: { moving: false, reason: "automation-denied", toggle: vi.fn() } });
    const out = html(createElement(StateCard, props));
    expect(out).toMatch(new RegExp(`<p class="ts-text ts-wait" role="status">.*<span>${en[AFTER_EXIT_WAITING_MSG]}</span></p>`));
    expect(out).toContain(en[AFTER_EXIT_HOW_MSG]);
    expect(out, "the move's failure is not said over the wait").not.toContain(en[HANDOFF_REASON_MSG["automation-denied"]]);
    const tree = StateCard(props);
    const buttons = all(tree, el => el.type === "button");
    expect(buttons.map(b => textOf(b).trim())).toEqual(["Cancel"]);
    expect(buttons[0].props["data-stage-land"], "the keys land on Cancel").toBe(true);
    const press = { detail: 1 };
    (buttons[0].props.onClick as (e: unknown) => void)(press);
    expect(ways.cancel).toHaveBeenCalledWith(press);
    expect(ways.arm).not.toHaveBeenCalled();
  });

  it("turns the pressed button into Cancel in place, so the focus stays on it", () => {
    const ways = afterExit();
    const before = StateCard(bodyProps(elsewhere, { afterExit: ways }));
    const after = StateCard(bodyProps(armed, { afterExit: ways }));
    expect(slotOf(before)).toBeGreaterThanOrEqual(0);
    expect(slotOf(after)).toBe(slotOf(before));
    expect(actsOf(after)).toHaveLength(actsOf(before).length);
  });

  it("stands beside a move that did not happen, and replaces one this Ghostty cannot make", () => {
    // Claude busy, Automation denied: Move again leads, the wait beside it, and
    // the way by hand names the wait instead of Reopen here.
    const busy = bodyProps(elsewhere, { afterExit: afterExit(), handoff: { moving: false, reason: "claude-not-ready", toggle: vi.fn() } });
    const out = html(createElement(StateCard, busy));
    expect(out).toContain(en[HANDOFF_REASON_MSG["claude-not-ready"]]);
    expect(out).toContain(en[HANDOFF_MANUAL_AFTER_EXIT_MSG]);
    expect(out).not.toContain(en[HANDOFF_MANUAL_MSG]);
    const tree = StateCard(busy);
    expect(button(tree, "Move session here")?.props.className).toBe("btn primary");
    expect(button(tree, en[AFTER_EXIT_MSG])?.props.className).toBe("btn");
    // Ghostty 1.3: no move at all, the wait leads.
    const old = StateCard(bodyProps(elsewhere, { afterExit: afterExit(), handoff: { moving: false, reason: "ghostty-unsupported", toggle: vi.fn() } }));
    expect(button(old, "Move session here")).toBeNull();
    expect(button(old, en[AFTER_EXIT_MSG])?.props.className).toBe("btn primary");
    expect(html(createElement(StateCard, bodyProps(elsewhere, { afterExit: afterExit(), handoff: { moving: false, reason: "ghostty-unsupported", toggle: vi.fn() } }))))
      .toContain(en[HANDOFF_REASON_MSG["ghostty-unsupported"]]);
  });

  it("is never offered while a move is under way, for a session that ended, or one the deck cannot reopen", () => {
    const moving = StateCard(bodyProps(elsewhere, { afterExit: afterExit(), handoff: { moving: true, toggle: vi.fn() } }));
    expect(button(moving, en[AFTER_EXIT_MSG])).toBeNull();
    // The move's own progress carries the working glyph too.
    expect(html(createElement(StateCard, bodyProps(elsewhere, { handoff: { moving: true, toggle: vi.fn() } }))))
      .toMatch(/<p class="ts-text ts-wait" role="status">.*Moving this session into ccdeck…/);
    const ended = { ...elsewhere, target: { ...target, kind: "gone" as const }, stillRunning: false };
    expect(button(StateCard(bodyProps(ended, { afterExit: afterExit() })), en[AFTER_EXIT_MSG])).toBeNull();
    const notOurs = { ...elsewhere, target: { ...target, adoptable: false } };
    expect(button(StateCard(bodyProps(notOurs, { afterExit: afterExit() })), en[AFTER_EXIT_MSG])).toBeNull();
  });

  it("keeps a held Claude card to two buttons: the wait, and Not now", () => {
    const held = { ...elsewhere, held: "claude" as const };
    const tree = StateCard(bodyProps(held, { afterExit: afterExit(), onStartNew: vi.fn(), startNewTip: "tip" }));
    expect(all(tree, el => el.type === "button").map(b => textOf(b).trim())).toEqual([en[AFTER_EXIT_MSG], "Not now"]);
  });

  it("gives a refused reopen the command that continues it by hand, with its Copy", () => {
    const command = resumeCommand("/home/u/code/paycore", "6f1c2d3e-0000-4000-8000-000000000001");
    const refused = { kind: "error" as const, message: "The deck could not start Claude Code here.", reopen: true };
    const out = html(createElement(StateCard, bodyProps(refused, { resumeCommand: command })));
    expect(out).toContain(en[RESUME_BY_HAND_MSG]);
    const drawn = command.replace(/&/g, "&amp;");
    expect(out).toContain(`<code title="${drawn}">${drawn}</code>`);
    expect(out).toContain('aria-label="Copy the command"');
    expect(button(StateCard(bodyProps(refused, { resumeCommand: command })), "Try again")).not.toBeNull();
    // No command for a session the stage has none for (Codex, Windows).
    expect(html(createElement(StateCard, bodyProps(refused)))).not.toContain(en[RESUME_BY_HAND_MSG]);
  });
});

describe("the pieces the stage builds it from", () => {
  it("writes the resume command for a POSIX shell, quoting a folder that needs it", () => {
    const id = "6f1c2d3e-0000-4000-8000-000000000001";
    expect(resumeCommand("/home/u/code/paycore", id)).toBe(`cd /home/u/code/paycore && claude --resume ${id}`);
    expect(resumeCommand("/Users/ana/My Projects/app", id)).toBe(`cd '/Users/ana/My Projects/app' && claude --resume ${id}`);
    expect(resumeCommand("/tmp/it's $HOME", id)).toBe(`cd '/tmp/it'\\''s $HOME' && claude --resume ${id}`);
  });

  it("reads the rest of a double-click, or a held key, on the Cancel as the first press", () => {
    expect(repeatedPress({ detail: 2 }, 5_000), "the second click of a double-click").toBe(true);
    expect(repeatedPress({ detail: 1 }, REPEAT_PRESS_MS - 1), "a repeat within the window").toBe(true);
    expect(repeatedPress({ detail: 0 }, REPEAT_PRESS_MS - 1), "a held Enter repeating").toBe(true);
    expect(repeatedPress({ detail: 1 }, REPEAT_PRESS_MS), "a press of its own").toBe(false);
    expect(repeatedPress({ detail: 0 }, REPEAT_PRESS_MS + 1), "Enter on Cancel, later").toBe(false);
    expect(repeatedPress(undefined, REPEAT_PRESS_MS + 1)).toBe(false);
  });

  it("offers the wait only once the move check has answered, and gives the keys to the pane after it", () => {
    const stage = read("../components/terminal/TerminalStage.tsx");
    expect(stage).toMatch(/finally \{ if \(!controller\.signal\.aborted\) setCheckedFor\(claudeSource\); \}/);
    expect(stage).toMatch(/const moveAwaited = handoffStopped === "already-sent" \|\| handoffStopped === "continuation-timeout";/);
    expect(stage).toMatch(/\(checkedFor === resumeSource \|\| !couldMove\) && \(movableFor !== resumeSource \|\| handoffStopped !== undefined\)/);
    expect(stage).toMatch(/arm: \(\) => \{ armedAt\.current = Date\.now\(\); session\.resumeAfterExit\(\); \}/);
    expect(stage).toMatch(/if \(!repeatedPress\(e, Date\.now\(\) - armedAt\.current\)\) session\.stopWaitingForExit\(\);/);
    // Move's Cancel answers the same way.
    expect(stage).toMatch(/if \(moving\) \{\s*if \(repeatedPress\(e, Date\.now\(\) - movedAt\.current\)\) return;/);
    // After it came here by itself: the keys into the pane, unless the reader
    // took the focus elsewhere meanwhile.
    expect(stage).toMatch(/if \(!resumed \|\| phase\.kind !== "live" \|\| phase\.readOnly\) return;/);
    expect(stage).toMatch(/if \(!active \|\| active === document\.body \|\| rootRef\.current\?\.contains\(active\)\) p\.onWantKeys\?\.\(\);/);
    expect(stage).toMatch(/afterExit=\{afterExit\}/);
    expect(stage).toMatch(/resumeCommand=\{claudeSource && handoffCwd \? resumeCommand\(handoffCwd, claudeSource\) : undefined\}/);
  });

  it("says every new line in all ten languages", () => {
    const keys = [AFTER_EXIT_MSG, AFTER_EXIT_OFFER_MSG, AFTER_EXIT_WAITING_MSG, AFTER_EXIT_HOW_MSG, HANDOFF_MANUAL_AFTER_EXIT_MSG, RESUME_BY_HAND_MSG];
    for (const lang of ["en", "de", "es", "fr", "ja", "ko", "pt-BR", "ro", "zh-CN", "zh-TW"] as const) {
      const catalog = catalogFor(lang) as Record<string, string>;
      for (const key of keys) {
        expect(catalog[key], `${lang} ${key}`).toBeTruthy();
        if (lang !== "en") expect(catalog[key], `${lang} ${key} is translated`).not.toBe(en[key]);
      }
      // The button's own words appear inside the lines that name it.
      expect(catalog[AFTER_EXIT_OFFER_MSG], lang).toContain(catalog[AFTER_EXIT_MSG]);
      expect(catalog[HANDOFF_MANUAL_AFTER_EXIT_MSG], lang).toContain(catalog[AFTER_EXIT_MSG]);
    }
  });
});

// ---------------------------------------------------------------------------
// The real machine. Two stand-in Claude sessions (sleeping node processes
// named `claude`, each with the record Claude Code writes for a live session:
// its pid, its session id and its start time as the kernel tells it) in one
// folder. The stage's open is answered by the deck's own classification
// (terminal-target.mjs, the engine's reference) reading this machine's real
// process table. Armed on one of them, the stage waits while it runs, reopens
// it once this file stops it, and never asks about, or reopens, the other.

const root = mkdtempSync(join(tmpdir(), "ccdeck-after-exit-"));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
  rmTempDir(root);
});

const SELECTED = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const BESIDE = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5e";
const TMUX_OK = { ok: true, path: "/usr/bin/tmux", version: [3, 6], raw: "tmux 3.6" };

async function standIn(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { argv0: "claude", cwd: root, stdio: "ignore" });
  children.push(child);
  await new Promise(r => setTimeout(r, 150));
  return child;
}

function startTime(pid: number): string {
  return process.platform === "linux"
    ? readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]
    : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" }).trim();
}

const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  return cond();
};

/** A WebSocket that never opens: the adopt's ticket is all this asks about. */
class QuietSocket {
  binaryType = "blob"; readyState = 0;
  onopen = null; onmessage = null; onerror = null; onclose = null;
  constructor(readonly url: string) {}
  send() {}
  close() { this.readyState = 3; }
}

describe("on this machine's real process table, with stand-in Claude processes", () => {
  it("waits while the selected session runs, reopens only it once stopped, and never counts a recycled pid", async () => {
    if (process.platform === "win32") return; // No such wait on Windows (the controller refuses it there).
    const selected = await standIn();
    const beside = await standIn();
    const claudeDir = join(root, "claude");
    const sessions = join(claudeDir, "sessions");
    mkdirSync(sessions, { recursive: true });
    const write = (pid: number, sessionId: string, procStart: string) =>
      writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: root, procStart, kind: "interactive", startedAt: Date.now() }));
    write(selected.pid!, SELECTED, startTime(selected.pid!));
    write(beside.pid!, BESIDE, startTime(beside.pid!));

    const classify = (ref: SessionRef) => resolveTarget(
      { sessionId: ref.sessionId, provider: ref.provider, cwd: ref.cwd },
      { tmux: TMUX_OK, deckSocket: { name: "ccdeck" }, claudeDir, listDeckSessions: async () => [], listPanes: async () => [] },
    );
    const asked: string[] = [];
    const adopted: string[] = [];
    const sockets: QuietSocket[] = [];
    const deps: SessionDeps = {
      api: {
        open: async (ref: SessionRef) => { asked.push(ref.sessionId); return { ok: false, target: describeTarget(await classify(ref)) }; },
        adopt: async (ref: SessionRef) => {
          adopted.push(ref.sessionId);
          // The deck's own rule: nothing is reopened while anything holds it.
          const now = await classify(ref);
          return now.kind === "gone" ? ({ ok: true, ticket: "resumed", target: { kind: "A", label: "here" } } as Ticketed)
            : { ok: false, status: 409, error: "still-running" };
        },
        launch: async () => { throw new Error("a new conversation was started"); },
        status: async () => ({ ok: true, platform: process.platform, tmux: { ok: true } }),
      } as unknown as SessionDeps["api"],
      connect: options => connectTerminal({ ...options, base: "http://127.0.0.1:4317/", createSocket: url => { const s = new QuietSocket(url); sockets.push(s); return s as never; } }),
      mount: () => new Promise(() => {}),
      now: () => Date.now(),
    };
    const snaps: SessionSnapshot[] = [];
    const ctl = createTerminalSession(deps, { onChange: s => snaps.push(s) });
    const ref: SessionRef = { sessionId: SELECTED, provider: "claude", cwd: root };
    try {
      ctl.show({ kind: "session", ref });
      expect(await until(() => snaps.at(-1)?.phase.kind === "not-attachable", 3000)).toBe(true);
      expect(snaps.at(-1)?.phase, "running in a terminal of its own").toMatchObject({ kind: "not-attachable", target: { kind: "C" }, stillRunning: true });

      ctl.resumeAfterExit();
      expect(snaps.at(-1)?.phase).toMatchObject({ awaitingExit: true });
      // Busy there for two looks: it waits, and reopens nothing.
      await new Promise(r => setTimeout(r, EXIT_WATCH_POLL_MS * 2 + 200));
      expect(asked.length, "it looked while it waited").toBeGreaterThanOrEqual(3);
      expect(adopted).toEqual([]);

      // Claude exits there; its pid is then held by another process with a
      // different start time (written as a recycled pid would look). Neither
      // the dead pid nor the stranger counts as the session.
      selected.kill();
      expect(await until(() => selected.exitCode !== null || selected.signalCode !== null, 3000)).toBe(true);
      write(beside.pid!, SELECTED, `${startTime(beside.pid!)}1`);
      expect(await until(() => adopted.length > 0, EXIT_WATCH_POLL_MS * 3)).toBe(true);
      expect(adopted, "the same conversation, once").toEqual([SELECTED]);
      expect(await until(() => sockets.length > 0, 1000)).toBe(true);
      expect(sockets[0].url).toMatch(/ticket=resumed$/);
      expect(new Set(asked), "only the selected session was ever asked about").toEqual(new Set([SELECTED]));
    } finally {
      ctl.dispose();
    }
    // The other session runs on, untouched, and still reads as running.
    expect(beside.exitCode).toBeNull();
    write(beside.pid!, BESIDE, startTime(beside.pid!));
    expect(await classify({ sessionId: BESIDE, provider: "claude", cwd: root })).toEqual({ kind: "C", adoptable: true, pid: beside.pid });
  }, 15_000);
});
