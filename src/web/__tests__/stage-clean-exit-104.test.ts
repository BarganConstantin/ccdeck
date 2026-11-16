// Internal #104: a pane whose agent ended itself closes.
//
// /exit, Ctrl+D or anything else that exits the agent with status 0, while
// the pane watched it run, closes that pane: the Board's stage closes, a
// Workspace pane empties (the stage's onClose is the ✕'s own action, which
// StageShell picks). Every other ending keeps the pane, its last frame and
// Reopen: a crash (non-zero), a kill (a signal), an ending tmux gave no
// status for, an ending that came within seconds of the pane going live (a
// failed start, or a dead pane opened for its last frame), one the pane
// never watched (atOpen), someone else taking the pane, a lost connection
// and a restarting deck.
//
// The stage runs under fake-react with a fake deck API, connection and
// terminal (use-terminal-session's seam), as reopen-here-focus.test.ts runs it.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { flush, mount, one, type Drawn } from "./fake-react";
import TerminalStage, { type StageShow, type TerminalStageProps } from "../components/terminal/TerminalStage";
import KeysBar, { type KeysBarProps } from "../components/terminal/KeysBar";
import StageBody, { type StageBodyProps } from "../components/terminal/StageBody";
import { CLEAN_END_MIN_LIVE_MS } from "../components/terminal/stage-model";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import type { ConnectOptions, TerminalConnection, TerminalExit } from "../terminal-protocol";
import type { SessionDeps, StageTerminal } from "../use-terminal-session";

const geometry = stageGeometry({ appW: 1440, bodyH: 848, cellW: 8, cellH: 18, expanded: false, narrow: false, storedCols: null });
const show: StageShow = {
  kind: "session",
  session: {
    ref: { sessionId: "s1", provider: "claude", cwd: "/w/paycore" }, name: "paycore", hue: 270,
    status: { state: "idle", phrase: "idle" } as never,
  },
};
const OPENED = { ok: true, ticket: "t-open", target: { kind: "A", label: "" } };

afterEach(() => { delete (globalThis as Record<string, unknown>).document; });

function stage() {
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
  const deps: Partial<SessionDeps> = {
    api: { status: vi.fn(), open: vi.fn(async () => OPENED), adopt: vi.fn(), launch: vi.fn() } as never,
    connect: o => { conns.push(o); return connection; },
    mount: () => Promise.resolve(term),
    now: () => clock.now,
  };
  const onClose = vi.fn();
  const props: TerminalStageProps = {
    show, geometry, cell: ASSUMED_CELL, readToken: () => "", expanded: false, firstRun: false, asksWaiting: false,
    onClose, onToggleExpand: vi.fn(), onFirstRunDone: vi.fn(), onNewSession: vi.fn(),
    onCols: vi.fn(), onColsReset: vi.fn(), holdsTypeAhead: () => null,
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
  const live = () => conns[0].onReset?.({ cols: 80, rows: 24, seed: new Uint8Array(0) });
  /** Live for `ms`, then the deck says the pane ended this way. */
  const endAfter = async (ms: number, exit: TerminalExit) => {
    await flush();
    live();
    expect(phase().kind).toBe("live");
    clock.now += ms;
    conns[0].onExit?.(exit);
    await flush();
  };
  return { view, props, onClose, bar, phase, endAfter };
}

describe("a pane whose agent ended itself (internal #104)", () => {
  it("closes once when the agent exits with status 0 while the pane watched it", async () => {
    const s = stage();
    await s.endAfter(CLEAN_END_MIN_LIVE_MS, { reason: "ended", exitStatus: 0 });
    expect(s.phase()).toEqual({ kind: "ended", clean: true });
    expect(s.onClose, "the pane closes, through the same action as its ✕").toHaveBeenCalledTimes(1);
    s.view.rerender({ ...s.props });
    await flush();
    expect(s.onClose, "and only once").toHaveBeenCalledTimes(1);
    s.view.unmount();
  });

  for (const [what, ms, exit] of [
    ["a crash: a non-zero status", 60_000, { reason: "ended", exitStatus: 1 }],
    ["a kill: a signal", 60_000, { reason: "ended", exitSignal: 9 }],
    ["an ending tmux gave no status for", 60_000, { reason: "ended" }],
    ["a failed start: status 0 within seconds of going live", CLEAN_END_MIN_LIVE_MS - 1, { reason: "ended", exitStatus: 0 }],
    ["a pane already dead when it was opened", 60_000, { reason: "ended", atOpen: true, exitStatus: 0 }],
    ["someone else taking the pane", 60_000, { reason: "detached" }],
    ["the deck losing tmux", 60_000, { reason: "error", message: "The deck lost its connection to tmux." }],
  ] as const) {
    it(`keeps the pane, its last frame and its way back for ${what}`, async () => {
      const s = stage();
      await s.endAfter(ms, exit as TerminalExit);
      expect(s.onClose).not.toHaveBeenCalled();
      if (exit.reason === "ended") expect(s.bar().end?.action, "Reopen is still offered").toBe("Reopen here");
      s.view.unmount();
    });
  }

  it("keeps the pane through a restarting deck, which reconnects rather than ends", async () => {
    const s = stage();
    await s.endAfter(60_000, { reason: "server-shutdown" });
    expect(s.onClose).not.toHaveBeenCalled();
    expect(s.phase().kind).not.toBe("ended");
    s.view.unmount();
  });
});
