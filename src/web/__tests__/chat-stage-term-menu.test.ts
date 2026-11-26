// One pane's Chat and Term are one conversation, and what Term asks that the
// transcript does not hold is said in Chat. TerminalStage reads the session's
// own screen once its turn is over (use-live-compaction.ts useLiveScreen): a
// menu the agent draws itself goes on Chat's live row with its choices as
// words, takes the place of "Waiting for you", and holds the composer, whose
// Enter would pick the highlighted choice. A card in Chat that asks the
// question wins. The read, the transcript and the keys all go to the subject
// the stage shows, through Chat/Term switches and from one session to another.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { mount, one } from "./fake-react";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import TerminalStage, { type TerminalStageProps } from "../components/terminal/TerminalStage";
import StageHeader from "../components/terminal/StageHeader";
import StageBody from "../components/terminal/StageBody";
import KeysBar from "../components/terminal/KeysBar";
import { ChatComposerSlot } from "../use-screens";
import type { ChatComposerProps } from "../components/chat/ChatComposer";
import type { ChatActivity, ChatLive, ChatTurn } from "../components/chat/chat-model";
import type { StagePhase } from "../components/terminal/stage-model";
import { MENU_MISSES } from "../live-activity";
import { STATUS_POLL_MS } from "../use-screen-status";
import { t } from "../i18n";

const held = vi.hoisted(() => ({
  subject: "session:a", phase: { kind: "live", sizeOwner: "dock", readOnly: false } as StagePhase,
  /** What each session's terminal draws, by subject. */
  screens: {} as Record<string, string>,
  readScreen: null as unknown as (subject: string) => string | null,
  sendPrompt: null as unknown as (text: string, subject: string) => string,
  /** Each session Chat's transcript was asked for, in order. */
  read: [] as Array<string | null>,
  turns: [] as ChatTurn[],
}));
vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../use-terminal-session", async importOriginal => ({
  ...await importOriginal<typeof import("../use-terminal-session")>(),
  useTerminalSession: () => ({
    subject: held.subject, phase: held.phase, keysOwner: "board", streaming: false,
    hostRef: { current: null }, sendPrompt: held.sendPrompt, sendAsk: vi.fn(async () => "sent"), focus: vi.fn(),
    release: vi.fn(), adopt: vi.fn(), retry: vi.fn(), type: vi.fn(), press: vi.fn(), holdsFocus: () => false,
    readScreen: held.readScreen,
  }),
}));
vi.mock("../use-screens", async importOriginal => ({
  ...await importOriginal<typeof import("../use-screens")>(),
  useScreenFlags: () => ({ chat: true, decision: false }),
}));
vi.mock("../use-session-transcript", async importOriginal => ({
  ...await importOriginal<typeof import("../use-session-transcript")>(),
  useSessionTranscript: ({ session }: { session: string | null }) => { held.read.push(session); return { state: "ready", turns: held.turns }; },
}));

const SAVE_MENU = [
  "⏺ Here is the agent I wrote for you: reviewer.md",
  "",
  " Save this agent?",
  " ❯ 1. Looks good — save it",
  "   2. Discard and exit",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");
const IDLE = "⏺ Saved reviewer.md.\n\n> \n  ? for shortcuts";

beforeEach(() => {
  vi.useFakeTimers();
  held.subject = "session:a";
  held.phase = { kind: "live", sizeOwner: "dock", readOnly: false };
  held.screens = { "session:a": SAVE_MENU, "session:b": IDLE };
  held.readScreen = vi.fn((subject: string) => held.screens[subject] ?? null);
  held.sendPrompt = vi.fn(() => "sent");
  held.read = [];
  held.turns = [];
});
afterEach(() => { vi.useRealTimers(); });

function props(id = "a", state: "idle" | "waiting" | "working" = "waiting", provider = "claude"): TerminalStageProps {
  return {
    show: { kind: "session", session: {
      ref: { sessionId: id, provider, cwd: "/demo" }, name: id,
      status: { state, phrase: "", emphasis: "", tool: null, arg: null },
      context: null, hue: 1,
    } },
    geometry: stageGeometry({ appW: 1200, bodyH: 700, cellW: 8, cellH: 18, expanded: false, narrow: false, storedCols: null, fill: true }),
    cell: ASSUMED_CELL, readToken: () => "", expanded: false, firstRun: false, asksWaiting: false,
    onClose: vi.fn(), onToggleExpand: vi.fn(), onFirstRunDone: vi.fn(), onNewSession: vi.fn(), onCols: vi.fn(), onColsReset: vi.fn(),
  } as TerminalStageProps;
}
type View = ReturnType<typeof mount<TerminalStageProps>>;
type Shown = { live?: ChatLive; activity?: ChatActivity; session?: string; onShowTerm(): void };
const screens = (view: View) => one(view.tree, el => el.type === StageBody)!.props.screens as Shown;
const header = (view: View) => one(view.tree, el => el.type === StageHeader)!.props;
const changeView = (view: View, next: "chat" | "term") => (header(view).view as { onChange(next: string): void }).onChange(next);
function composer(view: View): ChatComposerProps {
  const input = one(view.tree, el => el.type === KeysBar)!.props.composer as ReactElement<ChatComposerProps>;
  expect(input.type).toBe(ChatComposerSlot);
  return input.props;
}

describe("a menu only Term shows, in Chat", () => {
  it("is said on the live row with both choices, in place of \"Waiting for you\", and holds the composer", () => {
    const view = mount(TerminalStage, props()); changeView(view, "chat");
    expect(held.readScreen).toHaveBeenCalledWith("session:a");
    expect(screens(view).live?.menu?.options).toEqual(["Looks good — save it", "Discard and exit"]);
    expect(screens(view).activity).toBeUndefined();
    expect(composer(view).unavailable).toBe(t("board.chat.waiting"));
    expect(composer(view).onSend("save it")).toBe("unavailable");
    expect(held.sendPrompt).not.toHaveBeenCalled();
    // Show Term on the row is the pane's own switch.
    screens(view).onShowTerm();
    expect((header(view).view as { current: string }).current).toBe("term");
    view.unmount();
  });

  it("clears once the menu has left the screen, and Chat says what it said before", async () => {
    const view = mount(TerminalStage, props("a", "idle")); changeView(view, "chat");
    expect(screens(view).live?.menu).toBeDefined();
    held.screens["session:a"] = IDLE;
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * MENU_MISSES);
    expect(screens(view).live).toBeUndefined();
    expect(composer(view).unavailable).toBeUndefined();
    view.unmount();
  });

  it("gives way to a card in Chat that asks the question", () => {
    held.turns = [{ kind: "ask", questions: [], running: true } as ChatTurn];
    const view = mount(TerminalStage, props()); changeView(view, "chat");
    expect(screens(view).live).toBeUndefined();
    view.unmount();
  });

  it("is not read while the session works: the working row speaks for the turn", () => {
    const view = mount(TerminalStage, props("a", "working")); changeView(view, "chat");
    expect(screens(view).live).toBeUndefined();
    view.unmount();
  });

  it("is Codex's too, named as Codex by the row", () => {
    const view = mount(TerminalStage, props("a", "waiting", "codex")); changeView(view, "chat");
    expect(screens(view).live?.menu?.options).toEqual(["Looks good — save it", "Discard and exit"]);
    view.unmount();
  });
});

describe("Chat and Term in one pane", () => {
  it("read one session through Chat/Term switches and a switch to another session", () => {
    const view = mount(TerminalStage, props()); changeView(view, "chat");
    for (let i = 0; i < 3; i++) { changeView(view, "term"); changeView(view, "chat"); }
    expect(screens(view).session).toBe("claude:a");
    expect(held.read.length).toBeGreaterThan(0);
    expect(held.read.filter(s => s !== null).every(s => s === "a")).toBe(true);
    // Another session on the pane: its transcript, its screen, and no menu of a's.
    held.read = [];
    held.subject = "session:b"; view.rerender(props("b"));
    expect(screens(view).session).toBe("claude:b");
    expect(held.read).toContain("b");
    expect(held.read.filter(s => s !== null).every(s => s === "b")).toBe(true);
    expect(held.readScreen).toHaveBeenLastCalledWith("session:b");
    expect(screens(view).live).toBeUndefined();
    // And back: a's menu is a's again.
    held.subject = "session:a"; view.rerender(props("a"));
    expect(screens(view).live?.menu?.options).toEqual(["Looks good — save it", "Discard and exit"]);
    view.unmount();
  });

  it("never reads the screen of a terminal still attached to the previous session", () => {
    // The stage shows b while the terminal is still a's: the composer waits,
    // and nothing is read off a's screen for b.
    held.subject = "session:a";
    const view = mount(TerminalStage, props("b")); changeView(view, "chat");
    expect(held.readScreen).not.toHaveBeenCalled();
    expect(screens(view).live).toBeUndefined();
    view.unmount();
  });
});
