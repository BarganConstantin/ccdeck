// A reliable way back from an ended pane.
//
// A pane whose agent ended — a crash, a kill, a Codex that updated itself and
// was not restarted — keeps its last frame and offers Reopen here. Pressed, it
// resumed the session, but said nothing while it worked: its button went
// away, the header said "reconnecting… Nothing typed now is sent.", a refusal
// was a card whose Try again opened the dead pane again, and an agent that
// could not resume the conversation (it ended as soon as it was reopened)
// left the same ended pane and the same Reopen here, as if nothing had been
// pressed. Now:
//
//   - the frame stays and the button says Reopening… while it works; a second
//     press starts nothing, and the keys go into the pane once it is live;
//   - a refusal says the deck's words under "Could not reopen this session.",
//     with Try again reopening again and Start new session here beside it;
//   - an agent that ends as soon as it is reopened "could not resume": Try
//     again, and Start new session here, a new session of the same agent in
//     the same folder, only ever on its own press;
//   - a deliberate ending (exit 0 after a real run) still closes the pane, a
//     pane emptied while it reopens stays empty, and a pane beside it is never
//     touched.
//
// The stage runs under fake-react with a fake deck API, connection and
// terminal (use-terminal-session's seam), as reopen-here-focus.test.ts runs it.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { flush, mount, one, textOf, type Drawn } from "./fake-react";
import TerminalStage, { endView, settlesFocus, type StageShow, type TerminalStageProps } from "../components/terminal/TerminalStage";
import KeysBar, { type KeysBarProps } from "../components/terminal/KeysBar";
import StageHeader, { type StageHeaderProps } from "../components/terminal/StageHeader";
import StageBody, { StateCard, type StageBodyProps } from "../components/terminal/StageBody";
import { CLEAN_END_MIN_LIVE_MS, headerStatus, stageAnnouncement, type StagePhase } from "../components/terminal/stage-model";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import type { ConnectOptions, TerminalConnection, TerminalExit } from "../terminal-protocol";
import type { SessionDeps, StageTerminal, StageTerminalEvents } from "../use-terminal-session";
import { en } from "../i18n/en";

const geometry = stageGeometry({ appW: 1440, bodyH: 848, cellW: 8, cellH: 18, expanded: false, narrow: false, storedCols: null });
const CODEX_REF = { sessionId: "019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5b", provider: "codex" as const, cwd: "/w/paycore" };
const OTHER_REF = { sessionId: "019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5c", provider: "claude" as const, cwd: "/w/ledger" };
const sessionShow = (ref: { sessionId: string; provider: "claude" | "codex"; cwd: string }, name: string): StageShow => ({
  kind: "session",
  session: { ref, name, hue: 270, status: { state: "idle", phrase: "idle" } as never },
});
const SHOW = sessionShow(CODEX_REF, "paycore");
const OPENED = { ok: true, ticket: "t-open", target: { kind: "A", label: "" } };
const CRASH: TerminalExit = { reason: "ended", exitStatus: 1 };

type Doc = { body: unknown; activeElement: unknown };
const doc = () => (globalThis as unknown as { document: Doc }).document;
afterEach(() => { delete (globalThis as Record<string, unknown>).document; });

/** A document where the focus can be, with the window's status bar the keys
 *  bar is drawn in beside a mouse (`statusBar`), so the end action is the
 *  header's, as on a desktop. */
function page(statusBar: boolean) {
  const body = { id: "body" };
  const slot = { id: "ccdeck-stage-status" };
  (globalThis as Record<string, unknown>).document = statusBar
    ? { body, activeElement: body, getElementById: (id: string) => (id === slot.id ? slot : null) }
    : { body, activeElement: body };
  return body;
}

/** The stage on a fake deck, showing `show`, live once opened. */
function stageOn(show: StageShow, { statusBar = true, adopt }: { statusBar?: boolean; adopt?: () => Promise<unknown> } = {}) {
  if (!(globalThis as Record<string, unknown>).document) page(statusBar);
  const clock = { now: 1_000_000 };
  /** The control the reader pressed, and where a press leaves the focus. */
  const pressed = { tagName: "BUTTON", focus: vi.fn(() => { doc().activeElement = pressed; }) };
  const root = {
    contains: (n: unknown) => n === pressed,
    querySelector: (sel: string) => (sel === "[data-stage-land]" ? pressed : null),
  };
  let events: StageTerminalEvents | null = null;
  const textarea = { id: `pane-${show.kind === "session" ? show.session.name : "x"}` };
  const term: StageTerminal & { focus: ReturnType<typeof vi.fn> } = {
    cols: 80, rows: 24,
    write: (_data, done) => { done?.(); },
    reset() {}, resize() {}, setTheme() {}, tmuxVersion() {}, viewAnswers() {},
    focus: vi.fn(() => { doc().activeElement = textarea; events?.onFocusChange(true); }),
    blur: () => { events?.onFocusChange(false); },
    hasFocus: () => doc().activeElement === textarea,
    applicationCursorKeys: () => false,
    scrollForInput() {},
    setFontSize() {},
    cell: () => null,
    dispose() {},
  };
  const conns: ConnectOptions[] = [];
  const closed: number[] = [];
  const api = {
    status: vi.fn(),
    open: vi.fn(async () => OPENED),
    adopt: vi.fn(adopt ?? (async () => ({ ok: true, ticket: `t-adopt-${conns.length}`, target: { kind: "A", label: "" } }))),
    launch: vi.fn(),
    codexUpdated: vi.fn(async () => false),
  };
  const deps: Partial<SessionDeps> = {
    api: api as never,
    connect: o => {
      const i = conns.push(o) - 1;
      const connection: TerminalConnection = {
        sendInput: () => true, sendSize: () => true, sendPaste: () => true, sendColours: () => true, sendAck: () => true,
        close() { closed.push(i); },
      };
      return connection;
    },
    mount: (_host, _init, ev) => { events = ev; return Promise.resolve(term); },
    now: () => clock.now,
  };
  let request = 0;
  const onWantKeys = vi.fn(() => { request += 1; view.rerender({ ...props, focusRequest: request }); });
  const onClose = vi.fn();
  const onStartNew = vi.fn();
  const props: TerminalStageProps = {
    show, geometry, cell: ASSUMED_CELL, readToken: () => "", expanded: false, firstRun: false, asksWaiting: false,
    onClose, onToggleExpand: vi.fn(), onFirstRunDone: vi.fn(), onNewSession: vi.fn(),
    onCols: vi.fn(), onColsReset: vi.fn(), onWantKeys, takeTypeAhead: () => "", holdsTypeAhead: () => null,
    onStartNew,
    sessionDeps: deps,
  };
  const view = mount(TerminalStage, props, {
    commit: tree => {
      const section = one(tree, el => el.type === "section") as Drawn | null;
      const rootRef = section?.ref as { current: unknown } | undefined;
      if (rootRef && !rootRef.current) rootRef.current = root;
      const stageBody = one(tree, el => el.type === StageBody) as Drawn | null;
      const host = (stageBody?.props as unknown as StageBodyProps | undefined)?.hostRef;
      if (host && !host.current) host.current = {} as HTMLDivElement;
    },
  });
  const header = () => one(view.tree, el => el.type === StageHeader)!.props as unknown as StageHeaderProps;
  const bar = () => one(view.tree, el => el.type === KeysBar)!.props as unknown as KeysBarProps;
  const body = () => one(view.tree, el => el.type === StageBody)!.props as unknown as StageBodyProps;
  const phase = () => body().phase;
  /** Connection `i` draws its first frame: the pane is live. */
  const live = (i: number) => conns[i].onReset?.({ cols: 80, rows: 24, seed: new Uint8Array(0) });
  /** The pane opens, runs a minute, and its agent crashes. */
  const crashed = async () => {
    await flush();
    live(0);
    expect(phase().kind).toBe("live");
    clock.now += 60_000;
    conns[0].onExit?.(CRASH);
    await flush();
    expect(phase()).toEqual({ kind: "ended" });
  };
  return { view, props, api, conns, closed, clock, term, textarea, pressed, onWantKeys, onClose, onStartNew, header, bar, body, phase, live, crashed };
}

describe("the words and states of a reopen", () => {
  const act = { reopen: vi.fn(), attachAgain: vi.fn(), startNew: vi.fn() };

  it("says Reopening… on a busy end bar, and still offers no second way while it works", () => {
    const end = endView({ kind: "ended", busy: true }, SHOW, act);
    expect(end).toMatchObject({ action: en["board.stage.reopening"], busy: true, onAction: act.reopen });
    expect(end?.alt, "no new session offered while a reopen works").toBeUndefined();
    expect(endView({ kind: "ended" }, SHOW, act)).toEqual({ sentence: en["board.stage.sessionEnded"], action: "Reopen here", onAction: act.reopen });
  });

  it("offers Try again and, beside it, a new session of the same agent for a session that could not resume", () => {
    const end = endView({ kind: "ended", unresumed: true }, SHOW, act)!;
    expect(end.sentence).toBe("Codex could not resume this conversation: it ended as soon as it was reopened.");
    expect(end.action).toBe("Try again");
    expect(end.onAction, "Try again is a reopen").toBe(act.reopen);
    expect(end.alt).toEqual({ action: "Start new session here", title: "Starts a new Codex session in this project. The ended conversation stays as it was.", onAction: act.startNew });
    expect(endView({ kind: "ended", unresumed: true }, SHOW, { ...act, startNew: undefined })?.alt, "nothing to start it with: no offer").toBeUndefined();
  });

  it("says it in the header and once in the live region", () => {
    expect(headerStatus({ state: "ended", phrase: "ended 2m ago" }, { kind: "ended", unresumed: true })).toEqual({ state: "ended", phrase: "could not resume" });
    expect(stageAnnouncement("paycore", { kind: "ended", unresumed: true })).toBe("paycore could not be resumed. Try again, or start a new session in its project.");
  });

  it("does not land a request for the keys on the button while it reopens: it waits for the pane", () => {
    expect(settlesFocus({ kind: "ended", busy: true })).toBe(false);
    expect(settlesFocus({ kind: "ended" })).toBe(true);
    expect(settlesFocus({ kind: "error", message: "x", reopen: true, busy: true })).toBe(false);
  });

  it("draws the second way in the header and in the phone's end bar, never disabled", () => {
    page(false);
    const onAction = vi.fn(), onAlt = vi.fn();
    const end = { sentence: "s", action: "Try again", onAction, alt: { action: "Start new session here", title: "tip", onAction: onAlt } };
    const head = mount(StageHeader, {
      identity: "session:a", name: "paycore", provider: "codex", status: { state: "ended", phrase: "could not resume" },
      keysOwner: "board", chordLabel: "Ctrl+Shift+X", canType: false, expanded: false, takeover: false,
      onKeys: vi.fn(), onExpand: vi.fn(), onClose: vi.fn(), end,
    } as StageHeaderProps).tree;
    const alt = one(head, el => el.type === "button" && textOf(el).trim() === "Start new session here")!;
    expect(alt.props.title).toBe("tip");
    expect(alt.props.disabled).toBeUndefined();
    expect(alt.props["data-stage-land"], "the keys land on Try again, not on a new session").toBeUndefined();
    (alt.props.onClick as () => void)();
    expect(onAlt).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
    const barTree = mount(KeysBar, { owner: "board", name: "paycore", chordLabel: "Ctrl+Shift+X", canType: false, asksWaiting: false, firstRun: false, onFirstRunDone: vi.fn(), onTypeHere: vi.fn(), end } as KeysBarProps).tree;
    expect(one(barTree, el => el.type === "button" && textOf(el).trim() === "Start new session here")?.props.title).toBe("tip");
  });

  it("draws a refused reopen's card: the deck's words, Try again (Reopening… while busy), Start new session here, Not now", () => {
    page(false);
    const onRetry = vi.fn(), onStartNew = vi.fn(), onNotNow = vi.fn();
    const props = (phase: StagePhase, over: Partial<StageBodyProps> = {}) => ({
      phase, onAdopt: vi.fn(), onNotNow, onRetry, onNewSession: vi.fn(), onStartNew, startNewTip: "tip", ...over,
    }) as Omit<StageBodyProps, "hostRef">;
    const draw = (phase: StagePhase, over: Partial<StageBodyProps> = {}) => mount(StateCard, props(phase, over)).tree;
    const refused: StagePhase = { kind: "error", message: "tmux could not start the session.", reopen: true };
    const card = draw(refused);
    expect(textOf(card)).toContain("Could not reopen this session.");
    expect(textOf(card)).toContain("tmux could not start the session.");
    const retry = one(card, el => el.type === "button" && textOf(el).trim() === "Try again")!;
    expect(retry.props["data-stage-land"]).toBe(true);
    (retry.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
    const fresh = one(card, el => el.type === "button" && textOf(el).trim() === "Start new session here")!;
    expect(fresh.props.title).toBe("tip");
    (fresh.props.onClick as () => void)();
    expect(onStartNew).toHaveBeenCalledTimes(1);
    expect(one(card, el => el.type === "button" && textOf(el).trim() === "Not now")).not.toBeNull();
    const busy = draw({ ...refused, busy: true });
    expect(one(busy, el => el.type === "button" && textOf(el).trim() === "Reopening…")?.props["aria-busy"]).toBe(true);
    const none = draw(refused, { onStartNew: undefined });
    expect(one(none, el => el.type === "button" && textOf(el).trim() === "Start new session here"), "no agent to start: no offer").toBeNull();
  });

  it("says Reopening… on the no-pane card's button while it works", () => {
    page(false);
    const gone = { kind: "gone" as const, label: "This session has ended.", adoptable: true };
    const draw = (busy: boolean) => mount(StateCard, {
      phase: { kind: "not-attachable", target: gone, stillRunning: false, busy } as StagePhase,
      onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(),
    } as Omit<StageBodyProps, "hostRef">).tree;
    expect(one(draw(false), el => el.type === "button" && textOf(el).trim() === "Reopen here")).not.toBeNull();
    expect(one(draw(true), el => el.type === "button" && textOf(el).trim() === "Reopening…")?.props["aria-busy"]).toBe(true);
  });
});

describe("Reopen here on an ended pane", () => {
  it("keeps the frame and its button, saying Reopening…; a double press reopens once; the keys go into the pane once it is live", async () => {
    let answer!: (a: unknown) => void;
    const s = stageOn(SHOW, { adopt: () => new Promise(res => { answer = res; }) });
    await s.crashed();
    expect(s.header().end?.action).toBe("Reopen here");

    s.pressed.focus();
    s.header().end!.onAction();
    s.header().end!.onAction();
    expect(s.api.adopt, "one reopen in flight").toHaveBeenCalledTimes(1);
    expect((s.api.adopt.mock.calls as unknown[][])[0][0], "the same conversation, in its own folder").toEqual(CODEX_REF);
    expect(s.onWantKeys, "the second press asks for nothing").toHaveBeenCalledTimes(1);
    expect(s.phase()).toEqual({ kind: "ended", busy: true });
    expect(s.header().end).toMatchObject({ action: "Reopening…", busy: true });
    expect(s.header().status.phrase, "never 'reconnecting…' for a reopen").not.toBe("reconnecting…");
    expect(s.term.focus, "nothing to type into yet").not.toHaveBeenCalled();
    expect(doc().activeElement, "the request is not spent on the button that was pressed").toBe(s.pressed);

    answer({ ok: true, ticket: "t-adopt", target: { kind: "A", label: "" } });
    await flush();
    expect(s.conns).toHaveLength(2);
    s.live(1);
    expect(s.phase().kind).toBe("live");
    expect(s.header().end ?? null, "back: no way back to offer").toBeNull();
    expect(s.term.focus, "the reopened pane took the keys").toHaveBeenCalledTimes(1);
    expect(doc().activeElement).toBe(s.textarea);
    expect(s.onStartNew, "never a new session for a reopen that worked").not.toHaveBeenCalled();
    expect(s.onClose).not.toHaveBeenCalled();
    s.view.unmount();
  });

  it("offers Try again and Start new session here when the reopened agent ends at once, and starts nothing by itself", async () => {
    const s = stageOn(SHOW);
    await s.crashed();
    s.header().end!.onAction();
    await flush();
    s.live(1);
    s.clock.now += 500;
    s.conns[1].onExit?.({ reason: "ended", exitStatus: 0 });
    await flush();
    expect(s.phase()).toEqual({ kind: "ended", unresumed: true });
    expect(s.header().status.phrase).toBe("could not resume");
    expect(s.header().end).toMatchObject({ action: "Try again", sentence: "Codex could not resume this conversation: it ended as soon as it was reopened." });
    expect(s.header().end?.alt?.action).toBe("Start new session here");
    // A clean exit 0 at once is the resume failing, not the agent ending itself.
    expect(s.onClose, "the pane stays, to say why").not.toHaveBeenCalled();
    expect(s.onStartNew, "a new session only on its own press").not.toHaveBeenCalled();
    expect(s.api.adopt).toHaveBeenCalledTimes(1);

    s.header().end!.onAction();
    await flush();
    expect(s.api.adopt, "Try again reopens again").toHaveBeenCalledTimes(2);
    expect(s.conns).toHaveLength(3);
    s.conns[2].onExit?.({ reason: "ended", atOpen: true });
    await flush();
    expect(s.phase()).toEqual({ kind: "ended", unresumed: true });

    s.header().end!.alt!.onAction();
    expect(s.onStartNew, "pressed: a new session in this pane").toHaveBeenCalledTimes(1);
    expect(s.api.adopt).toHaveBeenCalledTimes(2);
    s.view.unmount();
  });

  it("says a refused reopen on the card, whose Try again reopens again and whose Start new session here is pressed only", async () => {
    let refuse = true;
    const s = stageOn(SHOW, {
      adopt: async () => (refuse ? { ok: false, status: 500, error: "tmux could not start the session." } : { ok: true, ticket: "t-again", target: { kind: "A", label: "" } }),
    });
    await s.crashed();
    s.header().end!.onAction();
    await flush();
    expect(s.phase()).toEqual({ kind: "error", message: "tmux could not start the session.", reopen: true });
    expect(s.body().onStartNew).toBe(s.onStartNew);
    expect(s.body().startNewTip).toBe("Starts a new Codex session in this project. The ended conversation stays as it was.");
    expect(s.onStartNew).not.toHaveBeenCalled();

    refuse = false;
    s.body().onRetry();
    await flush();
    expect(s.api.adopt, "Try again reopens, never an open of the dead pane").toHaveBeenCalledTimes(2);
    expect(s.api.open).toHaveBeenCalledTimes(1);
    s.live(1);
    expect(s.phase().kind).toBe("live");
    expect(s.term.focus, "back, with the keys").toHaveBeenCalled();
    s.view.unmount();
  });
});

describe("what a reopen leaves alone", () => {
  it("still closes a pane whose agent ended itself, and reopens nothing", async () => {
    const s = stageOn(SHOW);
    await flush();
    s.live(0);
    s.clock.now += CLEAN_END_MIN_LIVE_MS + 60_000;
    s.conns[0].onExit?.({ reason: "ended", exitStatus: 0 });
    await flush();
    expect(s.onClose, "a deliberate /exit closes the pane").toHaveBeenCalledTimes(1);
    expect(s.api.adopt).not.toHaveBeenCalled();
    expect(s.onStartNew).not.toHaveBeenCalled();
    s.view.unmount();
  });

  it("leaves a pane emptied while it reopens empty: the late answer attaches nothing", async () => {
    let answer!: (a: unknown) => void;
    const s = stageOn(SHOW, { adopt: () => new Promise(res => { answer = res; }) });
    await s.crashed();
    s.header().end!.onAction();
    // ✕ on a Workspace pane empties it (StageShell's emptyPane).
    s.view.rerender({ ...s.props, show: { kind: "empty" } });
    await flush();
    answer({ ok: true, ticket: "t-late", target: { kind: "A", label: "" } });
    await flush();
    expect(s.conns.map(c => c.ticket), "nothing attached for a pane that was closed").not.toContain("t-late");
    expect(s.phase()).toEqual({ kind: "empty" });
    expect(s.onStartNew).not.toHaveBeenCalled();
    s.view.unmount();
  });

  it("never touches the pane beside it", async () => {
    page(true);
    const a = stageOn(SHOW);
    const b = stageOn(sessionShow(OTHER_REF, "ledger"));
    await flush();
    b.live(0);
    expect(b.phase().kind).toBe("live");
    await a.crashed();
    a.header().end!.onAction();
    a.header().end!.onAction();
    await flush();
    a.live(1);
    expect(a.phase().kind).toBe("live");
    expect(a.api.adopt).toHaveBeenCalledTimes(1);
    expect(b.phase().kind, "the other pane is still live").toBe("live");
    expect(b.closed, "its connection was never closed").toEqual([]);
    expect(b.conns, "nor opened again").toHaveLength(1);
    expect(b.api.adopt).not.toHaveBeenCalled();
    a.view.unmount();
    b.view.unmount();
  });
});
