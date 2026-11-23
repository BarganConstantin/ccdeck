// A Codex that updated itself comes back in its pane by itself.
//
// Codex's own update prompt runs the install on "Update now", prints "Update
// ran successfully! Please restart Codex." and exits 0. The pane then did what
// any clean ending does and closed, or showed Reopen here, and
// the reader had to press it. Now, when the deck says the codex on disk was
// replaced while the pane ran (the session hook's `updated`), the stage does
// what its end bar offers, once: Reopen here for a session, which resumes it
// here, Launch again for a launch that never had one. A restarted Codex that
// updates again keeps its end bar; an update that failed or was cancelled
// ends the pane as before.
//
// The stage runs under fake-react with a fake deck API, connection and
// terminal (use-terminal-session's seam), as stage-clean-exit-104.test.ts does.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { flush, mount, one, type Drawn } from "./fake-react";
import TerminalStage, { type StageShow, type TerminalStageProps } from "../components/terminal/TerminalStage";
import KeysBar, { type KeysBarProps } from "../components/terminal/KeysBar";
import StageBody, { type StageBodyProps } from "../components/terminal/StageBody";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import type { ConnectOptions, TerminalConnection, TerminalExit } from "../terminal-protocol";
import type { SessionDeps, StageTerminal } from "../use-terminal-session";

const geometry = stageGeometry({ appW: 1440, bodyH: 848, cellW: 8, cellH: 18, expanded: false, narrow: false, storedCols: null });
const CODEX_REF = { sessionId: "019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5b", provider: "codex" as const, cwd: "/w/paycore" };
const SESSION: StageShow = {
  kind: "session",
  session: {
    ref: CODEX_REF, name: "paycore", hue: 270,
    status: { state: "idle", phrase: "idle" } as never,
  },
};
const launchShow = (key: string): StageShow => ({ kind: "launch", agent: "codex", cwd: "/w/paycore", name: "paycore", hue: 270, key });
const OPENED = { ok: true, ticket: "t-open", target: { kind: "A", label: "" } };
const ADOPTED = { ok: true, ticket: "t-adopt", target: { kind: "A", label: "" } };
const LAUNCHED = { ok: true, sessionId: "", name: "ccdeck-codex-1a2b3c4d", ticket: "t-launch" };
const UPDATED_EXIT: TerminalExit = { reason: "ended", exitStatus: 0 };

afterEach(() => { delete (globalThis as Record<string, unknown>).document; });

/** The stage on a fake deck, showing `show`. `updated` is the deck's answer
 *  to "did that Codex update itself?". */
function stage(show: StageShow, updated: () => Promise<boolean> = async () => true) {
  const body = { id: "body" };
  (globalThis as Record<string, unknown>).document = { body, activeElement: body };
  const clock = { now: 1_000_000 };
  const term: StageTerminal = {
    cols: 80, rows: 24,
    write: (_data, done) => { done?.(); },
    reset() {}, resize() {}, setTheme() {}, tmuxVersion() {}, viewAnswers() {},
    focus() {}, blur() {}, hasFocus: () => false,
    applicationCursorKeys: () => false,
    scrollForInput() {},
    setFontSize() {},
    cell: () => null,
    dispose() {},
  };
  const conns: ConnectOptions[] = [];
  const connection: TerminalConnection = {
    sendInput: () => true, sendSize: () => true, sendPaste: () => true, sendColours: () => true, sendAck: () => true, close() {},
  };
  const api = {
    status: vi.fn(),
    open: vi.fn(async () => OPENED),
    adopt: vi.fn(async () => ADOPTED),
    launch: vi.fn(async () => LAUNCHED),
    codexUpdated: vi.fn(updated),
  };
  const deps: Partial<SessionDeps> = {
    api: api as never,
    connect: o => { conns.push(o); return connection; },
    mount: () => Promise.resolve(term),
    now: () => clock.now,
  };
  const onClose = vi.fn();
  const onWantKeys = vi.fn();
  const onLaunchAgain = vi.fn();
  const props: TerminalStageProps = {
    show, geometry, cell: ASSUMED_CELL, readToken: () => "", expanded: false, firstRun: false, asksWaiting: false,
    onClose, onWantKeys, onToggleExpand: vi.fn(), onFirstRunDone: vi.fn(), onNewSession: vi.fn(),
    onCols: vi.fn(), onColsReset: vi.fn(), holdsTypeAhead: () => null,
    ...(show.kind === "launch" ? { onLaunchAgain } : {}),
    sessionDeps: deps,
  };
  const view = mount(TerminalStage, props, {
    commit: tree => {
      const section = one(tree, el => el.type === "section") as Drawn | null;
      const rootRef = section?.ref as { current: unknown } | undefined;
      if (rootRef && !rootRef.current) rootRef.current = { contains: () => false, querySelector: () => null };
      const stageBody = one(tree, el => el.type === StageBody) as Drawn | null;
      const host = (stageBody?.props as unknown as StageBodyProps | undefined)?.hostRef;
      if (host && !host.current) host.current = {} as HTMLDivElement;
    },
  });
  const bar = () => one(view.tree, el => el.type === KeysBar)!.props as unknown as KeysBarProps;
  const phase = () => (one(view.tree, el => el.type === StageBody)!.props as unknown as StageBodyProps).phase;
  /** The latest connection goes live, runs for `ms`, and ends this way. */
  const runThenEnd = async (ms: number, exit: TerminalExit) => {
    await flush();
    const conn = conns[conns.length - 1];
    conn.onReset?.({ cols: 80, rows: 24, seed: new Uint8Array(0) });
    expect(phase().kind).toBe("live");
    clock.now += ms;
    conn.onExit?.(exit);
    await flush();
  };
  return { view, props, api, conns, onClose, onWantKeys, onLaunchAgain, bar, phase, runThenEnd };
}

describe("a Codex session that updated itself", () => {
  it("is reopened here once, with the keys asked for, and its pane is never closed", async () => {
    const s = stage(SESSION);
    await s.runThenEnd(45_000, UPDATED_EXIT);
    expect(s.api.codexUpdated).toHaveBeenCalledWith(45_000);
    expect(s.api.adopt, "Reopen here, as the end bar offers it").toHaveBeenCalledTimes(1);
    expect((s.api.adopt.mock.calls as unknown[][])[0][0], "the same session, in its own folder").toEqual(CODEX_REF);
    expect(s.onWantKeys, "the keys go to the pane it brings back").toHaveBeenCalledTimes(1);
    expect(s.onClose, "an update is not the agent ending itself").not.toHaveBeenCalled();
    // CHANGED ON PURPOSE (ended-pane restart): a Reopen here keeps the ended
    // frame up, busy (its button says Reopening…), instead of "reconnecting…".
    expect(s.phase()).toEqual({ kind: "ended", busy: true });
    expect(s.bar().end, "the end bar says it is reopening").toMatchObject({ action: "Reopening…", busy: true });
    s.view.rerender({ ...s.props });
    await flush();
    expect(s.api.adopt, "and only once").toHaveBeenCalledTimes(1);
    s.view.unmount();
  });

  it("keeps its end bar when the Codex it restarted updates again: once per session", async () => {
    const s = stage(SESSION);
    await s.runThenEnd(45_000, UPDATED_EXIT);
    expect(s.api.adopt).toHaveBeenCalledTimes(1);
    expect(s.conns).toHaveLength(2);
    await s.runThenEnd(30_000, UPDATED_EXIT);
    expect(s.api.codexUpdated).toHaveBeenCalledTimes(2);
    expect(s.phase()).toEqual({ kind: "ended", updated: true });
    expect(s.api.adopt, "never a second time by itself").toHaveBeenCalledTimes(1);
    expect(s.onClose).not.toHaveBeenCalled();
    expect(s.bar().end?.action, "Reopen here is offered instead").toBe("Reopen here");
    s.view.unmount();
  });

  it("closes as any clean ending does when the deck says it did not update, and only once it has said", async () => {
    let answer!: (updated: boolean) => void;
    const s = stage(SESSION, () => new Promise<boolean>(res => { answer = res; }));
    await s.runThenEnd(45_000, UPDATED_EXIT);
    expect(s.phase()).toEqual({ kind: "ended" });
    expect(s.onClose, "not while the deck is asked").not.toHaveBeenCalled();
    answer(false);
    await flush();
    expect(s.onClose).toHaveBeenCalledTimes(1);
    expect(s.api.adopt).not.toHaveBeenCalled();
    s.view.unmount();
  });

  it("keeps the pane and its Reopen here when the update failed: Codex exits non-zero and the deck is not asked", async () => {
    const s = stage(SESSION);
    await s.runThenEnd(45_000, { reason: "ended", exitStatus: 1 });
    expect(s.api.codexUpdated).not.toHaveBeenCalled();
    expect(s.api.adopt).not.toHaveBeenCalled();
    expect(s.onClose).not.toHaveBeenCalled();
    expect(s.bar().end?.action).toBe("Reopen here");
    s.view.unmount();
  });
});

describe("a Codex launch that updated itself before it had a session", () => {
  it("is launched again once, as its end bar offers, and never closed", async () => {
    const s = stage(launchShow("k1"));
    await s.runThenEnd(20_000, UPDATED_EXIT);
    expect(s.api.launch).toHaveBeenCalledTimes(1);
    expect(s.onLaunchAgain, "Launch again: there is no session to reopen").toHaveBeenCalledTimes(1);
    expect(s.api.adopt).not.toHaveBeenCalled();
    expect(s.onClose).not.toHaveBeenCalled();
    s.view.rerender({ ...s.props });
    await flush();
    expect(s.onLaunchAgain, "and only once").toHaveBeenCalledTimes(1);
    s.view.unmount();
  });

  it("counts the launch it started as the one it replaced: an update there keeps its Launch again", async () => {
    const s = stage(launchShow("k1"));
    await s.runThenEnd(20_000, UPDATED_EXIT);
    expect(s.onLaunchAgain).toHaveBeenCalledTimes(1);
    // What StageShell's Launch again does: a new launch, by a new key.
    s.view.rerender({ ...s.props, show: launchShow("k2") });
    await flush();
    expect(s.api.launch).toHaveBeenCalledTimes(2);
    await s.runThenEnd(20_000, UPDATED_EXIT);
    expect(s.phase()).toEqual({ kind: "ended", updated: true });
    expect(s.onLaunchAgain, "never a second time by itself").toHaveBeenCalledTimes(1);
    expect(s.bar().end?.onAction, "the button is still there to press").toBe(s.onLaunchAgain);
    expect(s.onClose).not.toHaveBeenCalled();
    s.view.unmount();
  });
});
