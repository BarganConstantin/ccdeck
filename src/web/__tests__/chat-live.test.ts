// What keeps Chat light while it lives (chat-turn-align.ts, chat-live.ts,
// chat-blocks.ts): a turn read again is the object it was, the turns of two
// reads are lined up so a slid window or older turns in front keep each turn's
// place, and a block whose turns and props did not change is not drawn again.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { alignTurns, sameTurns, turnInterner } from "../chat-turn-align";
import { sameBlockProps } from "../components/chat/chat-live";
import { MemoAssistantBlock, MemoRecordLine, MemoYourCommand, MemoYourMessage } from "../components/chat/chat-blocks";
import { AssistantBlock, RecordLine, YourCommand, YourMessage } from "../components/chat/ChatTurn";
import type { ChatTurn } from "../components/chat/chat-model";

const said = (text: string): ChatTurn => ({ kind: "assistant", text });
const you = (text: string): ChatTurn => ({ kind: "user", text });
const bash = (arg: string, running?: boolean): ChatTurn => ({ kind: "tool", name: "Bash", arg, ...(running ? { running } : {}) });
/** A read as the server hands it over: every turn a new object. */
const fresh = (turns: ChatTurn[]) => turns.map(turn => structuredClone(turn));

describe("one object per thing said", () => {
  it("gives a turn read again the object it was", () => {
    const intern = turnInterner();
    const first = intern(fresh([you("go"), said("a"), bash("npm test")]));
    const again = intern(fresh([you("go"), said("a"), bash("npm test")]));
    expect(again).not.toBe(first);
    again.forEach((turn, i) => expect(turn).toBe(first[i]));
    expect(sameTurns(first, again)).toBe(true);
  });

  it("gives a turn that changed a new object, and keeps the rest", () => {
    const intern = turnInterner();
    const first = intern(fresh([said("a"), bash("npm test", true)]));
    const then = intern(fresh([said("a"), bash("npm test")]));
    expect(then[0]).toBe(first[0]);
    expect(then[1]).not.toBe(first[1]);
    expect(sameTurns(first, then)).toBe(false);
  });

  it("keeps two turns that say the same as one object, and forgets what the last read did not have", () => {
    const intern = turnInterner();
    const first = intern(fresh([said("ok"), you("x"), said("ok")]));
    expect(first[2]).toBe(first[0]);
    const gone = first[1];
    intern(fresh([said("ok")]));
    expect(intern(fresh([you("x")]))[0]).not.toBe(gone);
  });

  it("says two runs differ by length as well as by turn", () => {
    const [a, b] = [said("a"), said("b")];
    expect(sameTurns([a, b], [a])).toBe(false);
    expect(sameTurns([a, b], [a, b])).toBe(true);
    expect(sameTurns([], [])).toBe(true);
  });
});

describe("lining up two reads", () => {
  const intern = turnInterner();
  const read = (...words: string[]) => intern(words.map(w => (w.startsWith(">") ? you(w.slice(1)) : said(w))));

  it("counts the turns that arrived at the end", () => {
    expect(alignTurns(read("a", "b"), read("a", "b", "c", "d"))).toEqual({ dropped: 0, arrived: 2 });
  });

  it("sees the window slide: as many turns, one gone from the front, one new at the end", () => {
    expect(alignTurns(read("a", "b", "c"), read("b", "c", "d"))).toEqual({ dropped: 1, arrived: 1 });
    expect(alignTurns(read("a", "b", "c"), read("c", "d", "e"))).toEqual({ dropped: 2, arrived: 2 });
  });

  it("sees older turns come in front, with nothing new at the end", () => {
    expect(alignTurns(read("c", "d"), read("a", "b", "c", "d"))).toEqual({ dropped: -2, arrived: 0 });
  });

  it("does not count a turn that changed in place as one that arrived", () => {
    const before = intern([said("a"), bash("npm test", true)]);
    const after = intern([said("a"), bash("npm test")]);
    expect(alignTurns(before, after)).toEqual({ dropped: 0, arrived: 0 });
    const more = intern([said("a"), bash("npm test"), said("done")]);
    expect(alignTurns(before, more)).toEqual({ dropped: 0, arrived: 1 });
  });

  it("tells a call made twice running from the one before it", () => {
    const before = intern([said("a"), bash("ls")]);
    const after = intern([said("a"), bash("ls"), bash("ls")]);
    expect(alignTurns(before, after)).toEqual({ dropped: 0, arrived: 1 });
  });

  it("finds nothing in another conversation, or in no turns", () => {
    expect(alignTurns(read("a", "b"), read("x", "y"))).toBeNull();
    expect(alignTurns([], read("a"))).toBeNull();
    expect(alignTurns(read("a"), [])).toBeNull();
  });
});

describe("a block drawn again only when it changed", () => {
  const intern = turnInterner();
  const turns = intern([said("a"), bash("ls")]);
  const send = async () => "sent" as const;

  it("bails for the same turns read again, as new objects interned back", () => {
    expect(sameBlockProps({ turns, provider: "claude" }, { turns: intern(fresh(turns)), provider: "claude" })).toBe(true);
  });

  it("draws again for a turn changed, added or gone", () => {
    expect(sameBlockProps({ turns }, { turns: intern([said("a"), bash("ls -la")]) })).toBe(false);
    expect(sameBlockProps({ turns }, { turns: [...turns, said("b")] })).toBe(false);
    expect(sameBlockProps({ turns }, { turns: turns.slice(1) })).toBe(false);
  });

  it("compares a waiting question's way of being answered field by field", () => {
    const ask = { send, at: 1 };
    expect(sameBlockProps({ turns, ask }, { turns, ask: { send, at: 1 } })).toBe(true);
    expect(sameBlockProps({ turns, ask }, { turns, ask: { send, at: 0 } })).toBe(false);
    expect(sameBlockProps({ turns, ask }, { turns, ask: { send, at: 1, blocked: "busy" } })).toBe(false);
    expect(sameBlockProps({ turns, ask }, { turns, ask: { send: async () => "sent" as const, at: 1 } })).toBe(false);
    expect(sameBlockProps({ turns, ask }, { turns })).toBe(false);
    expect(sameBlockProps({ turns }, { turns, ask: undefined })).toBe(true);
  });

  it("compares every other prop as it is, a prop it does not know included", () => {
    expect(sameBlockProps({ turns, todoAt: 1 }, { turns, todoAt: 1 })).toBe(true);
    expect(sameBlockProps({ turns, todoAt: 1 }, { turns, todoAt: undefined })).toBe(false);
    expect(sameBlockProps({ turns, provider: "claude" }, { turns, provider: "codex" })).toBe(false);
    expect(sameBlockProps({ turns }, { turns, later: () => {} })).toBe(false);
  });
});

describe("the blocks ChatView draws", () => {
  it("are React's memo of each block, the assistant's with sameBlockProps", () => {
    const memo = Symbol.for("react.memo");
    const of = (m: unknown) => m as { $$typeof: symbol; type: unknown; compare: unknown };
    expect(of(MemoAssistantBlock).$$typeof).toBe(memo);
    expect(of(MemoAssistantBlock).type).toBe(AssistantBlock);
    expect(of(MemoAssistantBlock).compare).toBe(sameBlockProps);
    for (const [made, from] of [[MemoYourMessage, YourMessage], [MemoYourCommand, YourCommand], [MemoRecordLine, RecordLine]] as const) {
      expect(of(made).$$typeof).toBe(memo);
      expect(of(made).type).toBe(from);
    }
  });

  it("and ChatView draws those, not the plain blocks", () => {
    const src = readFileSync(new URL("../components/chat/ChatView.tsx", import.meta.url), "utf8");
    for (const name of ["MemoAssistantBlock", "MemoYourMessage", "MemoYourCommand", "MemoRecordLine"]) expect(src).toContain(`<${name} `);
    expect(src).not.toMatch(/<(AssistantBlock|YourMessage|YourCommand|RecordLine)\b/);
  });
});
