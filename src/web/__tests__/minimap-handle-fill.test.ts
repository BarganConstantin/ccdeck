// The invisible per-session drag handle is a React Flow node like any other,
// and @reactflow/minimap paints every node it can measure: its selector is
// `!node.hidden && node.width && node.height`, with no node-type test and no
// z-index test. The handle is measured (it is sized to the whole session box)
// and never hidden, so it reached the minimap's nodeColor callback alongside
// the cards.
//
// That callback read `n.data.state`, which a handle does not have — its data
// is `{sessionId, w, h}` — so both branches fell through to the finished
// green. Every live session therefore painted one solid green block over its
// 160px ranksep gaps and its 420px burst lane, whatever the agents inside it
// were actually doing, with the real agent rects drawn on top.
import { describe, it, expect } from "vitest";
import type { AgentState } from "../types";
import { SESSION_GROUP_TYPE, minimapNodeColor, type MinimapNode } from "../minimap";

/** Resolve a CSS custom property to its own name, so assertions name tokens. */
const token = (name: string) => name;

const card = (state: AgentState): MinimapNode =>
  ({ type: "agent", data: { id: "a1", sessionId: "s1", state } });

/** A handle as App builds it: session-sized, and carrying no agent state. */
const handle = {
  type: SESSION_GROUP_TYPE,
  data: { sessionId: "s1", w: 1096, h: 400 },
} as unknown as MinimapNode;

describe("minimap node colour", () => {
  it("paints the invisible session drag handle with nothing at all", () => {
    expect(minimapNodeColor(handle, token)).toBe("transparent");
  });

  it("does not read the handle as a finished agent", () => {
    expect(minimapNodeColor(handle, token)).not.toBe(token("--ok"));
  });

  it("tells a handle from a card by node type, not by its id prefix", () => {
    // `group:<sessionId>` is prune.ts's business; drift between two spellings
    // of the same question is what put the handles in the column-gap maths.
    const prefixOnly: MinimapNode = { type: "agent", data: { id: "group:s1", sessionId: "s1", state: "done" } };
    expect(minimapNodeColor(prefixOnly, token)).toBe(token("--ok"));
  });

  it("still paints a running agent in the in-flight colour", () => {
    expect(minimapNodeColor(card("active"), token)).toBe(token("--inflight"));
  });

  it("still paints a failed agent in the error colour", () => {
    expect(minimapNodeColor(card("err"), token)).toBe(token("--err"));
  });

  it("still paints a finished agent in the ok colour", () => {
    expect(minimapNodeColor(card("done"), token)).toBe(token("--ok"));
  });

  it("survives a node React Flow hands over before its data is attached", () => {
    expect(minimapNodeColor({ type: "agent" }, token)).toBe(token("--ok"));
  });
});

// THE STATE `state` CANNOT SAY.
//
// The reducer sets `waiting` without touching `state`, so a root parked on a
// permission prompt is still "active" and was painted the same --inflight as a
// session that is happily working. Every other surface marks it — the favicon,
// the tab title, the topbar chip, the card's amber WaitingRow, the sidebar's
// top sort tier, the W shortcut — and the minimap is the one a person scans to
// decide WHERE on a large board to fly the camera, which is the question "who
// is blocked on me" asks. Ten sessions with one blocked showed ten
// indistinguishable rects.
describe("a session blocked on a human", () => {
  const paint = (waiting: unknown, state = "active") =>
    minimapNodeColor({ data: { state, waiting } } as never, (n) => n);

  it("is drawn in the warn colour, not as another busy agent", () => {
    expect(paint({ kind: "permission", since: 1 })).toBe("--warn");
    expect(paint({ kind: "asked", since: 1 })).toBe("--warn");
  });

  it("uses isAlarming's rule, so it agrees with the tab strip rather than inventing a sixth", () => {
    // `idle` is deliberately not an alarm anywhere else in the deck — an empty
    // input box is a turn that ended, not a session stuck.
    expect(paint({ kind: "idle", since: 1 })).toBe("--inflight");
  });

  it("outranks state, because a blocked session is still `active`", () => {
    // This is the whole reason the test exists: the block is invisible to the
    // `state` tests below it.
    expect(paint(null)).toBe("--inflight");
    expect(paint({ kind: "permission", since: 1 }, "active")).toBe("--warn");
  });

  it("puts the block ahead of an error, because the block is the actionable one", () => {
    // A session can be both. The error already happened; the block is the one
    // a person can end by looking at it, which is why every other surface sorts
    // waiting to the top (SessionList's rank(), the topbar chip, W). An
    // ordinary errored session is still red.
    expect(paint({ kind: "permission", since: 1 }, "err")).toBe("--warn");
    expect(paint(null, "err")).toBe("--err");
  });
});

