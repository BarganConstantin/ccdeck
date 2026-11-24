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
afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).window;
});

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
function stageOn(show: StageShow, { statusBar = true, adopt, open, folder }: {
  statusBar?: boolean;
  adopt?: () => Promise<unknown>;
  /** The deck's answer to an open; the pane is attached when it is left out. */
  open?: () => Promise<unknown>;
  /** The deck's answer about a folder (terminal-api's checkFolder); none: a
   *  deck the stage does not ask, as before. */
  folder?: (cwd: string) => Promise<unknown>;
} = {}) {
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
    open: vi.fn(open ?? (async () => OPENED)),
    adopt: vi.fn(adopt ?? (async () => ({ ok: true, ticket: `t-adopt-${conns.length}`, target: { kind: "A", label: "" } }))),
    launch: vi.fn(async () => ({ ok: true, sessionId: "", name: "ccdeck-codex-1a2b3c4d", ticket: "t-launch" })),
    codexUpdated: vi.fn(async () => false),
    checkFolder: folder ? vi.fn(folder) : undefined,
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
  const onNewSession = vi.fn();
  const onLaunchAgain = vi.fn();
  const onStartIn = vi.fn();
  const props: TerminalStageProps = {
    show, geometry, cell: ASSUMED_CELL, readToken: () => "", expanded: false, firstRun: false, asksWaiting: false,
    onClose, onToggleExpand: vi.fn(), onFirstRunDone: vi.fn(), onNewSession,
    onCols: vi.fn(), onColsReset: vi.fn(), onWantKeys, takeTypeAhead: () => "", holdsTypeAhead: () => null,
    onStartNew, onStartIn,
    ...(show.kind === "launch" ? { onLaunchAgain } : {}),
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
  return { view, props, api, conns, closed, clock, term, textarea, pressed, onWantKeys, onClose, onStartNew, onNewSession, onLaunchAgain, onStartIn, header, bar, body, phase, live, crashed };
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
    // CHANGED ON PURPOSE (missing folder): the card's Start new session here
    // asks about the folder first; this deck has no folder question, so it is
    // the same press at once.
    expect(typeof s.body().onStartNew).toBe("function");
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

// A folder that went away under an ended pane — a git worktree removed, a
// project moved or renamed. Reopen here, Start again and Start new session
// here ask the deck about the folder first; gone, the pane keeps its last
// frame and names the folder, with Choose folder… (a NEW session in another
// folder, never this conversation moved) and Check again (the press it
// stopped, once the folder is back). Nothing is started by itself.
describe("an ended pane whose folder is gone", () => {
  const NEXT = "Choose folder… starts a new session elsewhere; this conversation stays with its folder.";
  const MISSING = { ok: false, code: "missing" };
  /** The deck's answers about the folder, in turn; the last one stays. */
  const answers = (...said: unknown[]) => async () => (said.length > 1 ? said.shift() : said[0]);
  const launchShow: StageShow = { kind: "launch", agent: "codex", cwd: "/w/paycore", name: "paycore", hue: 270, key: "k1" };

  it("names the folder on Reopen here, keeps the frame, and reopens nothing", async () => {
    const s = stageOn(SHOW, { folder: answers(MISSING) });
    await s.crashed();
    s.header().end!.onAction();
    await flush();
    expect(s.api.checkFolder).toHaveBeenCalledWith("/w/paycore");
    expect(s.phase()).toEqual({ kind: "folder-gone", cwd: "/w/paycore", code: "folder-missing", agent: "codex", sessionId: CODEX_REF.sessionId, frame: true });
    expect(s.header().status.phrase, "the header names it").toBe("paycore not found");
    expect(s.header().end).toMatchObject({
      sentence: `paycore is not there any more. ${NEXT}`, action: "Choose folder…", alt: { action: "Check again" },
    });
    // Beside a mouse the end bar's buttons are in the header: the kept frame
    // carries the line itself, where the reader looks.
    expect(s.body().frameNote).toEqual({ lead: "paycore is not there any more.", next: NEXT, where: "/w/paycore" });
    expect(s.header().end?.title).toBe(en["board.stage.folderGone.body"]);
    expect(s.bar().end ?? null, "never on both").toBeNull();
    expect(s.api.adopt, "never resumed, here or anywhere else").not.toHaveBeenCalled();
    expect(s.api.launch).not.toHaveBeenCalled();
    expect(s.onStartNew).not.toHaveBeenCalled();
    expect(s.onClose).not.toHaveBeenCalled();
    expect(s.conns, "nothing new connected: the old frame stays").toHaveLength(1);
    s.view.unmount();
  });

  it("reopens the conversation here, once, when Check again finds the folder back", async () => {
    const s = stageOn(SHOW, { folder: answers(MISSING, MISSING, { ok: true, cwd: "/w/paycore" }) });
    await s.crashed();
    s.header().end!.onAction();
    await flush();
    s.header().end!.alt!.onAction();
    expect(s.header().end?.alt).toMatchObject({ action: "Checking…", busy: true });
    s.header().end!.alt!.onAction();
    await flush();
    expect(s.api.checkFolder, "one question for a double press").toHaveBeenCalledTimes(2);
    expect(s.header().end?.sentence, "still gone: said so").toBe(`The folder is still not there. ${NEXT}`);
    expect(s.body().frameNote?.lead, "on the frame, where it was not before").toBe("The folder is still not there.");
    expect(s.api.adopt).not.toHaveBeenCalled();
    s.header().end!.alt!.onAction();
    await flush();
    expect(s.api.adopt, "the Reopen here it stopped, once").toHaveBeenCalledTimes(1);
    expect((s.api.adopt.mock.calls as unknown[][])[0][0], "the same conversation, in its own folder").toEqual(CODEX_REF);
    s.live(1);
    expect(s.phase().kind).toBe("live");
    expect(s.onStartIn).not.toHaveBeenCalled();
    s.view.unmount();
  });

  it("starts a launch again only in a folder that is there", async () => {
    const s = stageOn(launchShow, { folder: answers(MISSING, { ok: true, cwd: "/w/paycore" }) });
    await s.crashed();
    expect(s.header().end?.action).toBe("Start Codex again");
    s.header().end!.onAction();
    await flush();
    expect(s.onLaunchAgain, "not started in a folder that is gone").not.toHaveBeenCalled();
    expect(s.phase()).toEqual({ kind: "folder-gone", cwd: "/w/paycore", code: "folder-missing", agent: "codex", frame: true });
    expect(s.header().end?.title, "a launch has no conversation to keep").toBe("Choose another folder to start Codex there.");
    expect(s.api.launch, "only the first launch").toHaveBeenCalledTimes(1);
    s.header().end!.alt!.onAction();
    await flush();
    expect(s.onLaunchAgain, "Check again: the Start again it stopped, once").toHaveBeenCalledTimes(1);
    s.view.unmount();
  });

  it("starts a new session here only in a folder that is there", async () => {
    const s = stageOn(SHOW, { folder: answers({ ok: true, cwd: "/w/paycore" }, MISSING) });
    await s.crashed();
    s.header().end!.onAction();
    await flush();
    s.live(1);
    s.clock.now += 500;
    s.conns[1].onExit?.({ reason: "ended", exitStatus: 0 });
    await flush();
    expect(s.phase()).toEqual({ kind: "ended", unresumed: true });
    s.header().end!.alt!.onAction();
    await flush();
    expect(s.onStartNew, "never started in a folder that is gone").not.toHaveBeenCalled();
    expect(s.phase()).toMatchObject({ kind: "folder-gone", cwd: "/w/paycore", agent: "codex", frame: true });
    s.view.unmount();
  });

  it("starts a NEW session in the folder chosen in the app's dialog, never this conversation there", async () => {
    let chosen: string | null = "/w/elsewhere";
    (globalThis as Record<string, unknown>).window = { addEventListener() {}, removeEventListener() {}, ccdeckFolder: { choose: async () => chosen } };
    const s = stageOn(SHOW, { folder: answers(MISSING) });
    await s.crashed();
    s.header().end!.onAction();
    await flush();
    s.header().end!.onAction();
    await flush();
    expect(s.onStartIn).toHaveBeenCalledWith("codex", "/w/elsewhere");
    expect(s.api.adopt, "the conversation stays with its folder").not.toHaveBeenCalled();
    expect(s.onNewSession).not.toHaveBeenCalled();
    chosen = null;
    s.header().end!.onAction();
    await flush();
    expect(s.onStartIn, "the dialog closed: nothing").toHaveBeenCalledTimes(1);
    s.view.unmount();
  });

  it("says the line in the pane's own keys bar on a phone, a live region with the path on hover, and draws none on the frame", async () => {
    const s = stageOn(SHOW, { statusBar: false, folder: answers(MISSING) });
    await s.crashed();
    s.bar().end!.onAction();
    await flush();
    expect(s.bar().end).toMatchObject({ sentence: `paycore is not there any more. ${NEXT}`, where: "/w/paycore", live: true, action: "Choose folder…" });
    expect(s.header().end ?? null).toBeNull();
    expect(s.body().frameNote, "never said twice").toBeUndefined();
    const bar = mount(KeysBar, { owner: "board", name: "paycore", chordLabel: "Ctrl+Shift+X", canType: false, asksWaiting: false, firstRun: false, onFirstRunDone: vi.fn(), onTypeHere: vi.fn(), end: s.bar().end } as KeysBarProps).tree;
    const line = one(bar, el => el.props?.className === "ts-end")!;
    expect([line.props.role, line.props.title]).toEqual(["status", "/w/paycore"]);
    s.view.unmount();
  });

  it("opens New session, with the agent chosen, where there is no dialog to ask", async () => {
    const s = stageOn(SHOW, { folder: answers(MISSING) });
    await s.crashed();
    s.header().end!.onAction();
    await flush();
    const end = s.header().end!;
    expect(end.id).toMatch(/^ts-choose-/);
    end.onAction();
    expect(s.onNewSession, "anchored on Choose folder…, the folder that is gone never chosen").toHaveBeenCalledWith(end.id, { agent: "codex", gone: "/w/paycore" });
    expect(s.onStartIn).not.toHaveBeenCalled();
    expect(s.api.adopt).not.toHaveBeenCalled();
    s.view.unmount();
  });
});

describe("the folder-gone card", () => {
  const cwd = "/home/u/code/worktrees/a-very-long-project-name/feature-branch-folder";
  const phase = { kind: "folder-gone", cwd, code: "folder-missing", agent: "claude", sessionId: "s1" } as StagePhase;
  const draw = (p: StagePhase, over: Partial<StageBodyProps> = {}) => {
    page(false);
    const acts = { onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(), onChooseFolder: vi.fn(), chooseFolderId: "ts-choose-9", ...over };
    // The card is a component of its own: drawn as the page would draw it.
    const card = mount(StateCard, { phase: p, ...acts } as Omit<StageBodyProps, "hostRef">).tree as Drawn | null;
    const tree = card && typeof card.type === "function" ? mount(card.type as (q: unknown) => unknown, card.props).tree : card;
    return { tree, ...acts };
  };

  it("names the folder, says the conversation stays with it, and offers Choose folder…, Check again and Not now", () => {
    const { tree, onChooseFolder, onRetry, onNotNow, onAdopt } = draw(phase);
    const ctx = one(tree, el => el.props?.className === "ts-ctx")!;
    expect(ctx.props.title, "the whole path on hover").toBe(cwd);
    expect(textOf(ctx), "the end of it, which names it").toBe("…/a-very-long-project-name/feature-branch-folder");
    expect(textOf(tree)).toContain("This folder is not there any more");
    expect(textOf(tree)).toContain("The conversation stays with this folder.");
    const choose = one(tree, el => el.type === "button" && textOf(el).trim() === "Choose folder…")!;
    expect(choose.props.id).toBe("ts-choose-9");
    expect(choose.props["data-stage-land"]).toBe(true);
    (choose.props.onClick as () => void)();
    expect(onChooseFolder).toHaveBeenCalledTimes(1);
    const check = one(tree, el => el.type === "button" && textOf(el).trim() === "Check again")!;
    (check.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
    (one(tree, el => el.type === "button" && textOf(el).trim() === "Not now")!.props.onClick as () => void)();
    expect(onNotNow).toHaveBeenCalledTimes(1);
    expect(onAdopt, "no Reopen here on it").not.toHaveBeenCalled();
    expect(one(tree, el => el.type === "button" && textOf(el).trim() === "Reopen here")).toBeNull();
  });

  it("says a launch's and a denied folder's own words, and Checking… / still gone as it asks", () => {
    expect(textOf(draw({ ...phase, sessionId: undefined } as StagePhase).tree)).toContain("Choose another folder to start Claude Code there.");
    expect(textOf(draw({ ...phase, code: "folder-denied" } as StagePhase).tree)).toContain("This account may not open this folder");
    const busy = draw({ ...phase, busy: true } as StagePhase).tree;
    expect(one(busy, el => el.type === "button" && textOf(el).trim() === "Checking…")?.props["aria-busy"]).toBe(true);
    const still = draw({ ...phase, checked: true } as StagePhase).tree;
    expect(textOf(one(still, el => el.props?.role === "status")!)).toBe("The folder is still not there.");
    const plain = draw(phase, { onChooseFolder: undefined }).tree;
    expect(one(plain, el => el.type === "button" && textOf(el).trim() === "Choose folder…"), "nothing to choose with").toBeNull();
    expect(one(plain, el => el.type === "button" && textOf(el).trim() === "Check again")?.props["data-stage-land"]).toBe(true);
  });

  it("draws nothing over the ended frame it keeps: the end bar has the choices", () => {
    expect(draw({ ...phase, frame: true } as StagePhase).tree).toBeNull();
  });
});

// The likeliest case: the folder went (a worktree removed, a project renamed)
// and the reader then opens the ended session. The deck answers that it cannot
// be reopened for want of its folder; the pane says so as a Reopen here would
// have — the folder named, Choose folder…, Check again, Not now — and Check
// again, once the folder is back, leaves it where an open of an ended session
// does: Reopen here offered, never pressed for the reader.
describe("opening an ended session whose folder is gone", () => {
  const goneTarget = (adoptable: boolean) => ({
    ok: false,
    target: adoptable
      ? { kind: "gone", label: "This session has ended; reopening it here continues the conversation in a new terminal.", adoptable: true }
      : { kind: "gone", label: "This session has ended, and its project folder is no longer there to reopen it in.", adoptable: false },
  });

  it("names the folder with Choose folder…, Check again and Not now, and opens the ended card once it is back", async () => {
    let back = false;
    const s = stageOn(SHOW, {
      open: async () => goneTarget(back),
      folder: async (cwd: string) => (back ? { ok: true, cwd } : { ok: false, code: "missing" }),
    });
    await flush();
    await flush();
    expect(s.api.checkFolder).toHaveBeenCalledWith("/w/paycore");
    expect(s.phase()).toEqual({ kind: "folder-gone", cwd: "/w/paycore", code: "folder-missing", agent: "codex", sessionId: CODEX_REF.sessionId });
    expect(s.header().status.phrase).toBe("paycore not found");
    expect(s.header().end ?? null, "no frame: the card speaks, with its own buttons").toBeNull();
    expect(s.body().onChooseFolder, "Choose folder… on the card").toBeTypeOf("function");
    expect(s.body().frameNote).toBeUndefined();

    s.body().onRetry();
    await flush();
    expect(s.phase(), "still gone: said so").toMatchObject({ kind: "folder-gone", checked: true });
    expect(s.api.open).toHaveBeenCalledTimes(1);

    back = true;
    s.body().onRetry();
    await flush();
    await flush();
    expect(s.api.open, "opened again, as before").toHaveBeenCalledTimes(2);
    expect(s.phase()).toMatchObject({ kind: "not-attachable", target: { kind: "gone", adoptable: true } });
    expect(s.api.adopt, "Reopen here stays the reader's press").not.toHaveBeenCalled();
    expect(s.api.launch).not.toHaveBeenCalled();
    s.view.unmount();
  });

  it("starts a new session in the folder chosen, never this conversation there", async () => {
    (globalThis as Record<string, unknown>).window = { addEventListener() {}, removeEventListener() {}, ccdeckFolder: { choose: async () => "/w/elsewhere" } };
    const s = stageOn(SHOW, { open: async () => goneTarget(false), folder: async () => ({ ok: false, code: "missing" }) });
    await flush();
    await flush();
    s.body().onChooseFolder!();
    await flush();
    expect(s.onStartIn).toHaveBeenCalledWith("codex", "/w/elsewhere");
    expect(s.api.adopt).not.toHaveBeenCalled();
    s.view.unmount();
  });

  it("keeps the card the deck described when the folder is there after all", async () => {
    const s = stageOn(SHOW, { open: async () => goneTarget(false), folder: async (cwd: string) => ({ ok: true, cwd }) });
    await flush();
    await flush();
    expect(s.phase()).toMatchObject({ kind: "not-attachable", target: { kind: "gone", adoptable: false } });
    s.view.unmount();
  });
});
