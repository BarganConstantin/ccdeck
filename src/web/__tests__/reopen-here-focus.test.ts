// "Reopen here" hands the keys to the pane it brings back, as a launch or an
// open does.
//
// Before, it adopted the session and asked for nothing: the button the press
// came from went away with the end bar, the browser dropped the focus on the
// body, and once the resumed pane was live the keys bar said the board had
// the keys. The letters typed next for the agent ran the deck's single-key
// shortcuts instead ("a" opened Accounts). Reopen here now asks for the keys
// the way Try again and Attach again do (onWantKeys). On the card of a
// session with no pane, the card stays up while the reopen works, and the
// request waits for the pane rather than being answered at once by the very
// button that was pressed.
//
// The stage runs under fake-react with a fake deck API, connection and
// terminal (use-terminal-session's seam), and a document that only knows
// where the focus is; the shell's side of a request — a new token per ask —
// is played by the test, as StageShell's stage.focusPane does it.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { flush, mount, one, type Drawn } from "./fake-react";
import TerminalStage, { type StageShow, type TerminalStageProps } from "../components/terminal/TerminalStage";
import KeysBar, { type KeysBarProps } from "../components/terminal/KeysBar";
import StageHeader, { type StageHeaderProps } from "../components/terminal/StageHeader";
import StageBody, { type StageBodyProps } from "../components/terminal/StageBody";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import type { ConnectOptions, TerminalConnection } from "../terminal-protocol";
import type { SessionDeps, StageTerminal, StageTerminalEvents } from "../use-terminal-session";

const geometry = stageGeometry({ appW: 1440, bodyH: 848, cellW: 8, cellH: 18, expanded: false, narrow: false, storedCols: null });
const show: StageShow = {
  kind: "session",
  session: {
    ref: { sessionId: "s1", provider: "claude", cwd: "/w/paycore" }, name: "paycore", hue: 270,
    status: { state: "idle", phrase: "idle" } as never,
  },
};

const OPENED = { ok: true, ticket: "t-open", target: { kind: "A", label: "" } };
const GONE = { ok: false, target: { kind: "gone", label: "This session has ended.", adoptable: true } };

type Doc = { body: unknown; activeElement: unknown };
const doc = () => (globalThis as unknown as { document: Doc }).document;
afterEach(() => { delete (globalThis as Record<string, unknown>).document; });

/** The stage on a fake deck. `open` is what opening the session answers. */
function stageOn(open: unknown, { statusBar = false } = {}) {
  const body = { id: "body" };
  // `statusBar`: the window's status bar the keys bar is drawn in beside a
  // mouse (KeysBar's placement); without one, a phone's stage.
  const slot = { id: "ccdeck-stage-status" };
  (globalThis as Record<string, unknown>).document = statusBar
    ? { body, activeElement: body, getElementById: (id: string) => (id === slot.id ? slot : null) }
    : { body, activeElement: body };
  /** The control the reader pressed: the stage's own, and where a press
   *  leaves the focus. */
  const pressed = { tagName: "BUTTON", focus: vi.fn(() => { doc().activeElement = pressed; }) };
  const root = {
    contains: (n: unknown) => n === pressed,
    querySelector: (sel: string) => (sel === "[data-stage-land]" ? pressed : null),
  };

  let events: StageTerminalEvents | null = null;
  const textarea = { id: "pane" };
  const term: StageTerminal & { focus: ReturnType<typeof vi.fn> } = {
    cols: 80, rows: 24,
    write: (_data, done) => { done?.(); },
    reset() {}, resize() {}, setTheme() {}, tmuxVersion() {}, viewAnswers() {},
    // The textarea taking the focus is what tells the session the pane has the keys.
    focus: vi.fn(() => { doc().activeElement = textarea; events?.onFocusChange(true); }),
    blur: () => { doc().activeElement = body; events?.onFocusChange(false); },
    hasFocus: () => doc().activeElement === textarea,
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
  const adopt = vi.fn(async () => ({ ok: true, ticket: "t-adopt", target: { kind: "A", label: "" } }));
  const deps: Partial<SessionDeps> = {
    api: { status: vi.fn(), open: vi.fn(async () => open), adopt, launch: vi.fn() } as never,
    connect: o => { conns.push(o); return connection; },
    mount: (_host, _init, ev) => { events = ev; return Promise.resolve(term); },
    now: () => Date.now(),
  };

  let request = 0;
  const onWantKeys = vi.fn(() => { request += 1; view.rerender({ ...props, focusRequest: request }); });
  const takeTypeAhead = vi.fn(() => "");
  const props: TerminalStageProps = {
    show, geometry, cell: ASSUMED_CELL, readToken: () => "", expanded: false, firstRun: false, asksWaiting: false,
    onClose: vi.fn(), onToggleExpand: vi.fn(), onFirstRunDone: vi.fn(), onNewSession: vi.fn(),
    onCols: vi.fn(), onColsReset: vi.fn(), onWantKeys, takeTypeAhead, holdsTypeAhead: () => null,
    sessionDeps: deps,
  };
  const view = mount(TerminalStage, props, {
    // The document's part: the stage's root and the terminal's host are
    // attached before the effects run.
    commit: tree => {
      const section = one(tree, el => el.type === "section") as Drawn | null;
      const rootRef = section?.ref as { current: unknown } | undefined;
      if (rootRef && !rootRef.current) rootRef.current = root;
      const stageBody = one(tree, el => el.type === StageBody) as Drawn | null;
      const host = (stageBody?.props as unknown as StageBodyProps | undefined)?.hostRef;
      if (host && !host.current) host.current = {} as HTMLDivElement;
    },
  });
  const bar = () => one(view.tree, el => el.type === KeysBar)!.props as unknown as KeysBarProps;
  const header = () => one(view.tree, el => el.type === StageHeader)!.props as unknown as StageHeaderProps;
  const card = () => one(view.tree, el => el.type === StageBody)!.props as unknown as StageBodyProps;
  const live = (i: number) => conns[i].onReset?.({ cols: 80, rows: 24, seed: new Uint8Array(0) });
  return { view, body, pressed, term, textarea, conns, adopt, onWantKeys, takeTypeAhead, bar, header, card, live, requests: () => request };
}

describe("Reopen here", () => {
  it("in the end bar puts the keys in the resumed pane once it is live", async () => {
    const s = stageOn(OPENED);
    await flush();
    s.live(0);
    expect(s.card().phase.kind).toBe("live");
    s.conns[0].onExit?.({ reason: "ended" });
    expect(s.bar().end?.action).toBe("Reopen here");
    expect(s.bar().owner).toBe("board");

    s.pressed.focus();
    s.bar().end!.onAction();
    expect(s.adopt).toHaveBeenCalledTimes(1);
    expect(s.onWantKeys, "the press asks for the keys, as Try again does").toHaveBeenCalledTimes(1);
    // CHANGED ON PURPOSE (ended-pane restart): the end bar and its button stay
    // while the reopen works, saying so (Reopening…, busy), so the press is
    // answered where it was made and a second press starts nothing.
    expect(s.bar().end, "the end bar says it is reopening").toMatchObject({ action: "Reopening…", busy: true });
    doc().activeElement = s.body;
    expect(s.term.focus, "nothing to type into yet").not.toHaveBeenCalled();

    await flush();
    expect(s.conns).toHaveLength(2);
    s.live(1);
    expect(s.card().phase.kind).toBe("live");
    expect(s.term.focus, "the resumed pane took the keys").toHaveBeenCalledTimes(1);
    expect(doc().activeElement).toBe(s.textarea);
    expect(s.bar().owner).toBe("pane");
    expect(s.takeTypeAhead, "what was typed meanwhile goes to the pane").toHaveBeenCalledWith(s.requests());
    s.view.unmount();
  });

  it("in the pane's header, where the keys bar is out in the status bar, does the same", async () => {
    // Beside a mouse the keys bar is drawn in the window's status bar, far
    // from the pane (and not at all for a split's other pane): the end action
    // is the header's, after "ended", and the bar carries none.
    const s = stageOn(OPENED, { statusBar: true });
    await flush();
    s.live(0);
    expect(s.card().phase.kind).toBe("live");
    expect(s.header().end ?? null, "a live pane has no way back to offer").toBeNull();
    s.conns[0].onExit?.({ reason: "ended" });
    expect(s.header().end?.action).toBe("Reopen here");
    expect(s.bar().end ?? null, "never both").toBeNull();

    s.pressed.focus();
    s.header().end!.onAction();
    expect(s.adopt).toHaveBeenCalledTimes(1);
    expect(s.onWantKeys, "the press asks for the keys, as Try again does").toHaveBeenCalledTimes(1);
    // CHANGED ON PURPOSE (ended-pane restart): the header's button stays while
    // the reopen works, saying so (Reopening…, busy), until the pane is back.
    expect(s.header().end, "the header's button says it is reopening").toMatchObject({ action: "Reopening…", busy: true });
    doc().activeElement = s.body;

    await flush();
    expect(s.conns).toHaveLength(2);
    s.live(1);
    expect(s.term.focus, "the resumed pane took the keys").toHaveBeenCalledTimes(1);
    expect(doc().activeElement).toBe(s.textarea);
    expect(s.bar().owner).toBe("pane");
    s.view.unmount();
  });

  it("on the card of a session with no pane waits for the pane it reopens, then puts the keys in it", async () => {
    const s = stageOn(GONE);
    await flush();
    expect(s.card().phase.kind).toBe("not-attachable");

    s.pressed.focus();
    s.card().onAdopt();
    expect(s.adopt).toHaveBeenCalledTimes(1);
    expect(s.onWantKeys).toHaveBeenCalledTimes(1);
    // A second press while it works is refused, and asks for nothing more.
    s.card().onAdopt();
    expect(s.adopt).toHaveBeenCalledTimes(1);
    expect(s.onWantKeys).toHaveBeenCalledTimes(1);
    expect(s.takeTypeAhead, "the request is not spent on the button that was pressed").not.toHaveBeenCalled();

    await flush();
    s.live(0);
    expect(s.term.focus, "the reopened pane took the keys").toHaveBeenCalledTimes(1);
    expect(doc().activeElement).toBe(s.textarea);
    expect(s.bar().owner).toBe("pane");
    s.view.unmount();
  });

  it("leaves the keys on the board for a pane nobody asked for", async () => {
    // Shown without a press (a restore after a reload, j/k on the board):
    // no request, so the pane does not reach for the keys.
    const s = stageOn(OPENED);
    await flush();
    s.live(0);
    expect(s.card().phase.kind).toBe("live");
    expect(s.onWantKeys).not.toHaveBeenCalled();
    expect(s.term.focus).not.toHaveBeenCalled();
    expect(s.bar().owner).toBe("board");
    s.view.unmount();
  });
});
