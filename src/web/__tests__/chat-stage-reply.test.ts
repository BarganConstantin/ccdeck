import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { mount, one, textOf } from "./fake-react";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import TerminalStage, { type TerminalStageProps } from "../components/terminal/TerminalStage";
import StageHeader from "../components/terminal/StageHeader";
import KeysBar from "../components/terminal/KeysBar";
import { ChatComposerSlot } from "../use-screens";
import type { ChatComposerProps } from "../components/chat/ChatComposer";
import type { StagePhase } from "../components/terminal/stage-model";

const held = vi.hoisted(() => ({
  subject: "session:a", phase: { kind: "live", sizeOwner: "dock", readOnly: false } as StagePhase,
  sendPrompt: vi.fn(() => "sent"), focus: vi.fn(), release: vi.fn(),
}));
vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../use-terminal-session", async importOriginal => ({
  ...await importOriginal<typeof import("../use-terminal-session")>(),
  useTerminalSession: () => ({
    subject: held.subject, phase: held.phase, keysOwner: "board", streaming: false,
    hostRef: { current: null }, sendPrompt: held.sendPrompt, focus: held.focus,
    release: held.release, adopt: vi.fn(), retry: vi.fn(), type: vi.fn(), press: vi.fn(), holdsFocus: () => false,
  }),
}));
vi.mock("../use-screens", async importOriginal => ({
  ...await importOriginal<typeof import("../use-screens")>(),
  useScreenFlags: () => ({ chat: true, decision: false }),
}));
vi.mock("../use-session-transcript", async importOriginal => ({
  ...await importOriginal<typeof import("../use-session-transcript")>(),
  useSessionTranscript: () => ({ state: "ready", turns: [] }),
}));

beforeEach(() => {
  held.subject = "session:a";
  held.phase = { kind: "live", sizeOwner: "dock", readOnly: false };
  held.sendPrompt.mockReset().mockReturnValue("sent");
  held.focus.mockClear(); held.release.mockClear();
});
function props(id = "a", waiting = false): TerminalStageProps {
  return {
    show: { kind: "session", session: {
      ref: { sessionId: id, provider: "claude", cwd: "/demo" }, name: id,
      status: { state: waiting ? "waiting" : "idle", phrase: "", emphasis: "", tool: null, arg: null },
      context: null, hue: 1,
    } },
    geometry: stageGeometry({ appW: 1200, bodyH: 700, cellW: 8, cellH: 18, expanded: false, narrow: false, storedCols: null, fill: true }),
    cell: ASSUMED_CELL, readToken: () => "", expanded: false, firstRun: false, asksWaiting: false,
    onClose: vi.fn(), onToggleExpand: vi.fn(), onFirstRunDone: vi.fn(), onNewSession: vi.fn(), onCols: vi.fn(), onColsReset: vi.fn(),
  } as TerminalStageProps;
}
function header(view: ReturnType<typeof mount<TerminalStageProps>>) {
  return one(view.tree, el => el.type === StageHeader)!.props;
}
function changeView(view: ReturnType<typeof mount<TerminalStageProps>>, next: "chat" | "term") {
  (header(view).view as { onChange(next: string): void }).onChange(next);
}
function composer(view: ReturnType<typeof mount<TerminalStageProps>>): ChatComposerProps {
  const bar = one(view.tree, el => el.type === KeysBar)!;
  const input = bar.props.composer as ReactElement<ChatComposerProps>;
  expect(input.type).toBe(ChatComposerSlot);
  return input.props;
}

describe("direct Chat reply wiring", () => {
  it("keeps drafts per session and across Chat/Term switches", () => {
    const view = mount(TerminalStage, props()); changeView(view, "chat");
    composer(view).onChange("draft A");
    changeView(view, "term"); changeView(view, "chat");
    expect(composer(view).value).toBe("draft A");
    held.subject = "session:b"; view.rerender(props("b"));
    expect(composer(view).value).toBe(""); composer(view).onChange("draft B");
    held.subject = "session:a"; view.rerender(props());
    expect(composer(view).value).toBe("draft A");
    expect(held.sendPrompt).not.toHaveBeenCalled();
    view.unmount();
  });

  it("sends to the bound subject and keeps Chat selected without focusing xterm", () => {
    const view = mount(TerminalStage, props()); changeView(view, "chat");
    expect(composer(view).onSend("two\nlines")).toBe("sent");
    expect(held.sendPrompt).toHaveBeenCalledWith("two\nlines", "session:a");
    expect((header(view).view as { current: string }).current).toBe("chat");
    expect(held.focus).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each([
    { phase: { kind: "attaching", reconnect: true }, waiting: false, subject: "session:a" },
    { phase: { kind: "live", sizeOwner: "dock", readOnly: true }, waiting: false, subject: "session:a" },
    { phase: { kind: "live", sizeOwner: "dock", readOnly: false }, waiting: true, subject: "session:a" },
    { phase: { kind: "live", sizeOwner: "dock", readOnly: false }, waiting: false, subject: "session:previous" },
  ])("refuses a send while the connection/request is unavailable: $phase.kind, waiting=$waiting", state => {
    held.phase = state.phase as StagePhase; held.subject = state.subject;
    const view = mount(TerminalStage, props("a", state.waiting)); changeView(view, "chat");
    expect(composer(view).unavailable).toBeTruthy();
    expect(composer(view).onSend("keep my draft")).toBe("unavailable");
    expect(held.sendPrompt).not.toHaveBeenCalled(); view.unmount();
  });

  it("replaces the old handoff footer while retaining end/ask actions", () => {
    const onAction = vi.fn();
    const view = mount(KeysBar, {
      owner: "board", name: "demo", chordLabel: "Ctrl+Shift+X", canType: false, asksWaiting: false,
      firstRun: false, paneless: true, chat: true, chatCannotType: true, composer: "Reply input",
      onFirstRunDone: vi.fn(), onTypeHere: vi.fn(),
      end: { sentence: "Session ended", action: "Reopen here", onAction },
    });
    expect(textOf(view.tree)).toContain("Reply input");
    expect(textOf(view.tree)).toContain("Reopen here");
    expect(textOf(view.tree)).not.toContain("Replies are available");
    expect(one(view.tree, el => el.type === "footer")!.props.hidden).toBeUndefined();
    view.unmount();
  });
});
