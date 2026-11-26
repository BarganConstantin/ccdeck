// What Chat's ⋯ offers and how a Compact is followed to its end
// (chat-actions.ts): Compact for Claude Code only, a run that ends once, on its
// record or what the screen and the conversation say, the reason a blocked
// Compact gives, the last reply's words as its own Copy takes them, and the
// session details the deck has, never a zero.
import { describe, expect, it } from "vitest";
import {
  COMPACT_COMMAND, COMPACT_SAID, COMPACT_SETTLE_MS, COMPACT_START_MS,
  compactBlocked, compactedSince, compactMarks, compactOffered, compactRecord, compactRun, compactStep,
  isCompactCommand, lastReply, replyText, sessionDetails,
} from "../chat-actions";
import type { ChatTurn } from "../components/chat/chat-model";
import { en } from "../i18n/en";
import { t } from "../i18n";

const T0 = 1_700_000_000_000;

const BEFORE: ChatTurn[] = [
  { kind: "user", text: "fix the test" },
  { kind: "assistant", text: "Fixed." },
];
const compacted = (over: Partial<Extract<ChatTurn, { kind: "command" }>> = {}): ChatTurn =>
  ({ kind: "command", name: COMPACT_COMMAND, output: "Compacted", at: T0 + 30_000, ...over });

describe("what the menu offers", () => {
  it("offers Compact for Claude Code only: the deck reads no other agent's compaction", () => {
    expect(compactOffered("claude")).toBe(true);
    for (const other of ["codex", "opencode", "copilot", undefined] as const) expect(compactOffered(other)).toBe(false);
  });

  it("knows a /compact, with or without instructions, and nothing that only starts like one", () => {
    expect(isCompactCommand("/compact")).toBe(true);
    expect(isCompactCommand("  /compact keep the API notes")).toBe(true);
    expect(isCompactCommand("/compacted")).toBe(false);
    expect(isCompactCommand("please /compact")).toBe(false);
  });

  it("says each end in the catalog, and the one Chat already says nowhere", () => {
    for (const [end, key] of Object.entries(COMPACT_SAID)) {
      if (end === "untaken") expect(key).toBeNull();
      else expect(en[key!], end).toBeTruthy();
    }
  });
});

describe("a Compact, followed to its end", () => {
  it("begins with the /compact lines the conversation holds", () => {
    const turns = [...BEFORE, compacted({ at: T0 - 60_000 })];
    expect(compactMarks(turns)).toBe(1);
    expect(compactRun(turns, T0)).toEqual({ at: T0, marks: 1, seen: false });
  });

  it("ends done on the new /compact line, once", () => {
    const run = compactRun(BEFORE, T0);
    const step = compactStep(run, { turns: [...BEFORE, compacted()], compacting: false }, T0 + 31_000);
    expect(step).toEqual({ run: null, end: "done" });
  });

  it("finds its record by time once the window the conversation is read in has slid", () => {
    const run = compactRun([...BEFORE, compacted({ at: T0 - 90_000 })], T0);
    // The older line slid out of the window; the new one keeps the count at one.
    expect(compactRecord(run, [...BEFORE, compacted()])).not.toBeNull();
    expect(compactRecord(run, [...BEFORE, compacted({ at: T0 - 90_000 })])).toBeNull();
  });

  it("ends failed on a record Claude Code printed an error to, and cancelled when that error says so", () => {
    const run = compactRun(BEFORE, T0);
    expect(compactStep(run, { turns: [...BEFORE, compacted({ failed: true, output: "Error during compaction: Conversation too long" })], compacting: false }, T0 + 5_000).end).toBe("failed");
    expect(compactStep(run, { turns: [...BEFORE, compacted({ failed: true, output: "Error: Compaction canceled." })], compacting: false }, T0 + 5_000).end).toBe("cancelled");
  });

  it("marks the run seen while the line shows, and keeps the same run while nothing moves", () => {
    const run = compactRun(BEFORE, T0);
    const seen = compactStep(run, { turns: BEFORE, compacting: true }, T0 + 1_000).run!;
    expect(seen).toEqual({ at: T0, marks: 0, seen: true });
    expect(compactStep(seen, { turns: BEFORE, compacting: true }, T0 + 2_000).run).toBe(seen);
  });

  it("ends cancelled when the line goes and the turn says it was interrupted (Esc in Term)", () => {
    const seen = { at: T0, marks: 0, seen: true };
    const turns: ChatTurn[] = [...BEFORE, { kind: "notice", what: "interrupted", at: T0 + 4_000 }];
    expect(compactStep(seen, { turns, compacting: false }, T0 + 5_000)).toEqual({ run: null, end: "cancelled" });
    // An interruption from before the run is not this one's.
    const old: ChatTurn[] = [...BEFORE, { kind: "notice", what: "interrupted", at: T0 - 4_000 }];
    expect(compactStep(seen, { turns: old, compacting: false }, T0 + 5_000).end).toBeUndefined();
  });

  it("waits COMPACT_SETTLE_MS for the record after the line goes, then says it cannot tell", () => {
    const seen = { at: T0, marks: 0, seen: true };
    const gone = compactStep(seen, { turns: BEFORE, compacting: false }, T0 + 10_000);
    expect(gone.run).toEqual({ ...seen, goneAt: T0 + 10_000 });
    expect(gone.next).toBe(T0 + 10_000 + COMPACT_SETTLE_MS);
    expect(compactStep(gone.run!, { turns: BEFORE, compacting: false }, T0 + 12_000).run).toBe(gone.run);
    expect(compactStep(gone.run!, { turns: BEFORE, compacting: false }, T0 + 10_000 + COMPACT_SETTLE_MS)).toEqual({ run: null, end: "unknown" });
    // The line back before then: still compacting, the wait starts again later.
    expect(compactStep(gone.run!, { turns: BEFORE, compacting: true }, T0 + 12_000).run).toEqual(seen);
  });

  it("ends at once when the message was not taken, and after COMPACT_START_MS when the line never showed", () => {
    const run = compactRun(BEFORE, T0);
    expect(compactStep(run, { turns: BEFORE, compacting: false }, T0 + 1_000)).toEqual({ run, next: T0 + COMPACT_START_MS });
    expect(compactStep(run, { turns: BEFORE, compacting: false, untaken: true }, T0 + 10_000)).toEqual({ run: null, end: "untaken" });
    expect(compactStep(run, { turns: BEFORE, compacting: false }, T0 + COMPACT_START_MS)).toEqual({ run: null, end: "unseen" });
  });
});

describe("a compaction the screen showed", () => {
  it("is over once the conversation has its /compact line, never on an older one", () => {
    expect(compactedSince([...BEFORE, compacted({ at: T0 + 30_000 })], T0)).toBe(true);
    expect(compactedSince([...BEFORE, compacted({ at: T0 - 60_000 })], T0)).toBe(false);
    expect(compactedSince(BEFORE, T0)).toBe(false);
  });
});

describe("why Compact cannot go now", () => {
  it("gives the box's own reason first, then a compaction under way, then the turn at work", () => {
    expect(compactBlocked({ unavailable: "This session is read-only.", compacting: true, working: true }, t, "Claude Code")).toBe("This session is read-only.");
    expect(compactBlocked({ compacting: true, working: true }, t, "Claude Code")).toBe(en["board.chat.actions.compacting"]);
    expect(compactBlocked({ compacting: false, working: true }, t, "Claude Code")).toBe("Available once Claude Code finishes this turn.");
    expect(compactBlocked({ compacting: false, working: false }, t, "Claude Code")).toBeNull();
  });
});

describe("the last reply's words", () => {
  it("are its prose as the reply's own Copy takes them, paragraph by paragraph, in Markdown", () => {
    const turns: ChatTurn[] = [
      { kind: "user", text: "first" },
      { kind: "assistant", text: "Old reply." },
      { kind: "user", text: "second" },
      { kind: "assistant", text: "Looking at **it**." },
      { kind: "tool", name: "Read", arg: "src/a.ts", mark: "file" },
      { kind: "assistant", text: "Done:\n\n- one" },
    ];
    expect(replyText(turns.slice(3))).toBe("Looking at **it**.\n\nDone:\n\n- one");
    expect(lastReply(turns)).toBe("Looking at **it**.\n\nDone:\n\n- one");
  });

  it("skip a block with no words, and a command's output, back to the last reply that has some", () => {
    const turns: ChatTurn[] = [
      { kind: "user", text: "go" },
      { kind: "assistant", text: "The answer." },
      { kind: "user", text: "and now" },
      { kind: "tool", name: "Bash", arg: "ls", mark: "terminal" },
      compacted(),
    ];
    expect(lastReply(turns)).toBe("The answer.");
    expect(lastReply([{ kind: "user", text: "hi" }])).toBe("");
  });
});

describe("Session details", () => {
  it("says the context and the spend as the header's chip and the Sessions list say them", () => {
    const rows = sessionDetails({ context: { used: 50_000, window: 200_000 }, spend: 1.234 }, t);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/context$/);
    expect(rows[1]).toContain("$1.23");
  });

  it("leaves out a figure the deck does not have, never a zero", () => {
    expect(sessionDetails({ context: null, spend: undefined }, t)).toEqual([]);
    expect(sessionDetails({ context: { used: 0, window: 200_000 }, spend: 0 }, t)).toEqual([]);
  });
});
