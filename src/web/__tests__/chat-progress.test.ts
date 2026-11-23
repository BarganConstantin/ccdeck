// Where a message sent from Chat stands, and what its session is doing
// (chat-progress.ts): what Chat says under the conversation's last line.
//
// THE TWO FAILURES THIS PINS. A Codex session was sent "este gata?" after a
// turn with tool calls; the conversation showed the message, then nothing,
// while the board said working: Chat drew only transcript turns and never the
// session's state. And the composer's "Message sent to the session." was the
// terminal's socket taking the keys: a message the agent never took (left in
// its input, or typed into a dialog) showed nowhere in Chat and still read as
// sent.
import { describe, expect, it } from "vitest";
import {
  CONFIRM_MS, QUIET_MS, TAKEN_GRACE_MS, chatShown, echoes, pendingFor, settlePending, waitsInChat, wasTaken,
  type ChatFacts, type ChatPending,
} from "../chat-progress";
import type { ChatTurn } from "../components/chat/chat-model";

const T0 = 1_700_000_000_000;

/** A conversation after a completed turn with a tool call, as the reported one was. */
const DONE_TURN: ChatTurn[] = [
  { kind: "user", text: "list the folder please" },
  { kind: "tool", name: "exec_command", arg: "ls -la", mark: "terminal" },
  { kind: "assistant", text: "I listed the folder." },
];

function facts(over: Partial<ChatFacts> = {}): ChatFacts {
  return { turns: DONE_TURN, prompts: 1, state: "idle", connected: true, asked: false, ...over };
}

/** Sent at T0 from a session that was resting. */
const sent = (text = "este gata?", from: Partial<ChatFacts> = {}) => pendingFor(text, facts(from), T0);

describe("a message on its way", () => {
  it("says Sending… at once, with the message, and looks again when it would be late", () => {
    const p = sent();
    expect(p).toEqual({ text: "este gata?", since: T0, prompts: 1, echoes: 0, behind: false });
    const shown = chatShown(p, facts(), T0 + 300);
    expect(shown.outgoing).toEqual({ text: "este gata?", state: "sending" });
    expect(shown.activity).toBeUndefined();
    expect(shown.next).toBe(T0 + CONFIRM_MS);
    expect(chatShown(p, facts(), T0 + CONFIRM_MS - 1).outgoing?.state).toBe("sending");
  });

  // The confirmed failure path: the terminal took the keys ("sent"), the
  // session never said it took the message, and Chat said nothing at all.
  it("says it was not taken once the session, free to take it, has not in CONFIRM_MS", () => {
    const p = sent("stuck: please check");
    const shown = chatShown(p, facts(), T0 + CONFIRM_MS);
    expect(shown.outgoing).toEqual({ text: "stuck: please check", state: "unconfirmed" });
    expect(shown.next, "nothing more to wait for: only the session can move it").toBeUndefined();
    // It stays until the session takes it, or another message replaces it.
    expect(settlePending(p, facts(), T0 + 10 * CONFIRM_MS)).toBe(p);
  });

  it("is not taken at once when the pane has no connection to have sent it on", () => {
    expect(chatShown(sent(), facts({ connected: false }), T0 + 10).outgoing?.state).toBe("unconfirmed");
  });

  it("waits behind a turn still at work however long it runs, then is late from when that turn ends", () => {
    const busy = facts({ state: "working", detail: "Shell · npm test · 40s", tool: true });
    const p = sent("and then the docs", { state: "working" });
    expect(p.behind).toBe(true);
    const meanwhile = chatShown(p, busy, T0 + 5 * CONFIRM_MS);
    expect(meanwhile.outgoing?.state).toBe("sending");
    // The session's own work goes on above it.
    expect(meanwhile.activity).toEqual({ state: "working", detail: "Shell · npm test · 40s" });
    expect(settlePending(p, busy, T0 + 5 * CONFIRM_MS)).toBe(p);
    const ended = T0 + 6 * CONFIRM_MS;
    const freed = settlePending(p, facts(), ended)!;
    expect(freed).toMatchObject({ behind: false, since: ended });
    expect(chatShown(freed, facts(), ended + CONFIRM_MS - 1).outgoing?.state).toBe("sending");
    expect(chatShown(freed, facts(), ended + CONFIRM_MS).outgoing?.state).toBe("unconfirmed");
  });
});

describe("taken", () => {
  it("by the board's prompt count (UserPromptSubmit, Codex's user_message): working, the message drawn until the conversation is read again", () => {
    const p = sent();
    const board = facts({ prompts: 2, state: "working" });
    expect(wasTaken(p, board)).toBe(true);
    expect(chatShown(p, board, T0 + 800)).toMatchObject({ outgoing: { state: "taken" }, activity: { state: "working" } });
    // Read again: the conversation's own line takes its place.
    const read = facts({ prompts: 2, state: "working", turns: [...DONE_TURN, { kind: "user", text: "este gata?" }] });
    expect(chatShown(p, read, T0 + 900).outgoing).toBeUndefined();
  });

  // The reported case: Codex's rollout says the message was taken before the
  // board's watcher does, and the board then says working for a turn that
  // writes nothing for a while. Chat drew the message and empty space.
  it("by the conversation, ahead of the board: the session is working on it, and stays so while the board says working", () => {
    const p = sent();
    const turns: ChatTurn[] = [...DONE_TURN, { kind: "user", text: "este gata?" }];
    const early = chatShown(p, facts({ turns }), T0 + 600);
    expect(early.outgoing).toBeUndefined();
    expect(early.activity).toEqual({ state: "working" });
    const settled = settlePending(p, facts({ turns }), T0 + 600)!;
    expect(settled.takenAt).toBe(T0 + 600);
    const board = facts({ turns, prompts: 2, state: "working", heardAt: T0 + 1500 });
    const worked = settlePending(settled, board, T0 + 1600)!;
    expect(worked.worked).toBe(true);
    for (const at of [T0 + 5_000, T0 + 17_000, T0 + 31_000]) {
      expect(chatShown(worked, board, at).activity?.state, `${at - T0} ms after`).toBe("working");
    }
    // The turn ends: the reply is the answer, and the record goes.
    const replied = facts({ turns: [...turns, { kind: "assistant", text: "Yes, it is done." }], prompts: 2, state: "idle" });
    expect(settlePending(worked, replied, T0 + 32_000)).toBeUndefined();
    expect(chatShown(undefined, replied, T0 + 32_000)).toEqual({});
  });

  it("an earlier message with the same words is not this one being taken", () => {
    const turns: ChatTurn[] = [{ kind: "user", text: "yes" }, { kind: "assistant", text: "Done." }];
    const p = pendingFor("yes", facts({ turns }), T0);
    expect(p.echoes).toBe(1);
    expect(wasTaken(p, facts({ turns }))).toBe(false);
    expect(wasTaken(p, facts({ turns: [...turns, { kind: "user", text: "yes" }] }))).toBe(true);
  });

  it("matches the conversation's spelling: spaces, a cut text, a slash command as typed", () => {
    expect(echoes([{ kind: "user", text: "two\r\nlines  here" }], "two\nlines here ")).toBe(1);
    const long = "a".repeat(5000);
    expect(echoes([{ kind: "user", text: `${"a".repeat(3999)}…` }], long)).toBe(1);
    expect(echoes([{ kind: "user", text: "b…" }], long)).toBe(0);
    expect(echoes([{ kind: "command", name: "/model", args: "opus" }], "/model opus")).toBe(1);
    expect(echoes([{ kind: "assistant", text: "este gata?" }], "este gata?"), "only your side counts").toBe(0);
  });

  it("is drawn here only for a grace once taken, if the board never says the turn began", () => {
    const p = { ...sent(), takenAt: T0 + 500 };
    const board = facts({ prompts: 2 });
    expect(chatShown(p, board, T0 + 600)).toMatchObject({ outgoing: { state: "taken" }, activity: { state: "working" }, next: T0 + 500 + TAKEN_GRACE_MS });
    expect(settlePending(p, board, T0 + 500 + TAKEN_GRACE_MS - 1)).toBe(p);
    expect(settlePending(p, board, T0 + 500 + TAKEN_GRACE_MS)).toBeUndefined();
  });

  it("settles to the same object when nothing moved, so the stage does not render for nothing", () => {
    const p: ChatPending = { ...sent(), takenAt: T0 + 500, worked: true };
    const board = facts({ prompts: 2, state: "working" });
    expect(settlePending(p, board, T0 + 9_000)).toBe(p);
  });
});

describe("what the session is doing", () => {
  it("working says the header's tool and time; a long silence with no call open says so instead", () => {
    const withTool = facts({ state: "working", detail: "Bash · npm test · 7m 38s", tool: true, heardAt: T0 });
    expect(chatShown(undefined, withTool, T0 + 10 * 60_000)).toEqual({ activity: { state: "working", detail: "Bash · npm test · 7m 38s" } });
    const thinking = facts({ state: "working", heardAt: T0 });
    expect(chatShown(undefined, thinking, T0 + QUIET_MS - 1)).toEqual({ activity: { state: "working" }, next: T0 + QUIET_MS });
    expect(chatShown(undefined, thinking, T0 + QUIET_MS)).toEqual({ activity: { state: "working", quiet: "2m" }, next: T0 + 3 * 60_000 });
    expect(chatShown(undefined, thinking, T0 + 3 * 60_000 + 5_000).activity?.quiet).toBe("3m");
  });

  it("waiting is said only where no card in Chat asks it already", () => {
    expect(chatShown(undefined, facts({ state: "waiting" }), T0).activity).toEqual({ state: "waiting" });
    expect(chatShown(undefined, facts({ state: "waiting", asked: true }), T0).activity).toBeUndefined();
    expect(waitsInChat([{ kind: "ask", questions: [], running: true }])).toBe(true);
    expect(waitsInChat([{ kind: "plan", text: "", running: true }])).toBe(true);
    expect(waitsInChat([{ kind: "ask", questions: [], answers: ["1"] }])).toBe(false);
    expect(waitsInChat([])).toBe(false);
  });

  // Claude Code sends no Stop hook for an Esc, so after Chat's Stop the board
  // went on saying working: Chat drew "Interrupted", then "is working…" under
  // it, and a message sent next waited behind that turn for good.
  it("a turn the conversation says you stopped is over, whatever the board says", () => {
    const stopped: ChatTurn[] = [...DONE_TURN, { kind: "user", text: "slow" }, { kind: "notice", what: "interrupted" }];
    const stale = facts({ turns: stopped, prompts: 2, state: "working", heardAt: T0 });
    expect(chatShown(undefined, stale, T0 + 1_000)).toEqual({});
    expect(chatShown(undefined, stale, T0 + 10 * 60_000), "never quiet either").toEqual({});
    const p = pendingFor("stuck: please check", stale, T0);
    expect(p.behind).toBe(false);
    expect(chatShown(p, stale, T0 + CONFIRM_MS).outgoing?.state).toBe("unconfirmed");
    // Sent while the turn ran, then stopped: from then it is the session's to take.
    const behind = pendingFor("next", facts({ turns: stopped.slice(0, -1), prompts: 2, state: "working" }), T0);
    expect(behind.behind).toBe(true);
    expect(settlePending(behind, stale, T0 + 3_000)).toMatchObject({ behind: false, since: T0 + 3_000 });
    // The next message it takes is a turn again.
    const next: ChatTurn[] = [...stopped, { kind: "user", text: "go on" }];
    expect(chatShown(undefined, facts({ turns: next, prompts: 3, state: "working" }), T0).activity).toEqual({ state: "working" });
  });

  it("says nothing for a session at rest, or one the pane only reconnects to", () => {
    for (const state of ["idle", "ready", "ended", "attaching", "detached", "elsewhere", "none"]) {
      expect(chatShown(undefined, facts({ state }), T0), state).toEqual({});
    }
  });
});
