// #997. Two reads on the 4Hz tick that re-derived a value nobody had changed.
//
// `setNow` (App.tsx) re-renders the deck four times a second whether or not
// anything is happening, so anything unguarded in the render body or in an
// effect with no dependency array runs 240 times a minute on a board with
// nothing on it. Two things were:
//
//   1. the rail-inset effect had NO dependency array, so every one of those 240
//      renders ran a document-wide `querySelectorAll` plus up to three
//      `getBoundingClientRect` reads to re-measure a strip that had not moved;
//   2. the open-tool lookup built `Array.from(agents.values()).flatMap(a =>
//      a.tools)` — a flat array of every tool on the board — and then called
//      `.find` on it, while the tool modal was open.
//
// ── MEASURED, on this machine, node 22, before and after ────────────────────
//
// The effect body, replayed against React's own dependency rule over 60s of
// renders at 4Hz (240 renders):
//
//              idle deck                before 240   after   1
//              a working session        before 240   after   6
//              a panel toggled each 1s  before 240   after  60
//
// One open-tool lookup, mean of 20,000 calls, at the documented ceiling
// (AGENT_CAP 200 x MAX_TOOLS_PER_AGENT 200) and on a real board. Four runs, so
// the wall clock is a RANGE — the box was running other work and a single
// figure would be a number dressed up as a measurement:
//
//                                  entries written     microseconds per call
//    200x200, hit on agent 0     old 40,200  new 0     old 1015-2503  new 0.07-0.76
//    200x200, hit on agent 199   old 40,200  new 0     old 1139-2764  new  105-352
//    12 agents x 40 tools        old    492  new 0     old  6.7-17.4  new  1.0-3.0
//
// The entry counts are the honest half and they are exact: "entries" is array
// elements written into a new array by `Array.from` or `flatMap`, counted by
// wrapping both, where a heap delta is at the mercy of when GC ran. The old
// form pays the full 40,200 whatever the answer is, which is why the first row
// is the interesting one — the call a user clicks is usually on the session
// they were already looking at, and that is the case that went from a
// 40,200-entry copy to a single `.find`.
//
// ── WHAT THIS FILE CAN AND CANNOT CATCH ─────────────────────────────────────
//
// There is no DOM in this suite and nothing here renders React, so "how many
// times did that effect run" is not observable from inside it — the same limit
// `render-path-cost-612-613.test.ts` states for itself, and the same two
// answers apply. The lookup is a pure function over the agents map, so its
// linearity is asserted by COUNTING the reads it makes through a Proxy, which
// is deterministic and not a timing test. The effect is asserted as source
// text, because its dependency array is the whole of the fix and a dependency
// array is a thing you can read.
//
// It cannot catch a fifth input to the rail's geometry being added to the sheet
// without being added to the dependency array. The drift guard that IS possible
// is the one below: `detailShown` and the JSX that mounts `.detail` have to say
// the same thing, and the case asserts both halves, so changing the mount
// condition alone goes red.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findToolOnBoard } from "../reducer";
import type { AgentNodeData, ToolCall } from "../types";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

/** A board of `n` agents with `toolsEach` calls apiece, shaped like the reducer
 *  builds them: only the fields the lookup reads are filled in. */
function board(n: number, toolsEach: number): Map<string, AgentNodeData> {
  const m = new Map<string, AgentNodeData>();
  for (let i = 0; i < n; i++) {
    const tools: ToolCall[] = [];
    for (let j = 0; j < toolsEach; j++) tools.push({ id: `a${i}-t${j}`, name: "Bash", startedAt: j } as ToolCall);
    m.set(`a${i}`, { id: `a${i}`, tools } as AgentNodeData);
  }
  return m;
}

/** The same board, with every agent behind a Proxy that counts reads of
 *  `tools`. One read per agent the walk opens, so the count IS how far the walk
 *  got — the measurement the old form could not win, because materialising the
 *  flat array reads `tools` off every agent before it compares anything. */
function counted(m: Map<string, AgentNodeData>): { agents: Map<string, AgentNodeData>; reads: () => number } {
  let n = 0;
  const out = new Map<string, AgentNodeData>();
  for (const [id, a] of m) {
    out.set(id, new Proxy(a, {
      get(t, k, r) { if (k === "tools") n++; return Reflect.get(t, k, r); },
    }));
  }
  return { agents: out, reads: () => n };
}

describe("the open tool is found without building a list of the ones it is not", () => {
  it("returns the call, and null when the board does not have it", () => {
    const b = board(4, 5);
    expect(findToolOnBoard(b, "a2-t3")?.id).toBe("a2-t3");
    expect(findToolOnBoard(b, "a0-t0")?.id).toBe("a0-t0");
    expect(findToolOnBoard(b, "nobody")).toBeNull();
    expect(findToolOnBoard(new Map(), "a0-t0")).toBeNull();
  });

  it("stops at the agent that owns the call instead of opening every one", () => {
    // 200 agents, the documented AGENT_CAP. The call is on the first, which is
    // the common case: the tool a user clicks is on a session they were already
    // looking at. The old form read `tools` off all 200 to build the flat array
    // before it compared a single id — 40,200 array entries written to answer a
    // question that was settled by the first.
    const { agents, reads } = counted(board(200, 200));
    expect(findToolOnBoard(agents, "a0-t199")?.id).toBe("a0-t199");
    expect(reads()).toBe(1);
  });

  it("opens every agent only when the board really does not have the call", () => {
    // The ceiling is still the ceiling — nothing here claims the walk is free,
    // only that it is not paid up front. A miss is the one case that costs the
    // same either way, and it is the case the modal cannot reach: `openedToolId`
    // is set from a call that was on the board when it was clicked.
    const { agents, reads } = counted(board(200, 200));
    expect(findToolOnBoard(agents, "nobody")).toBeNull();
    expect(reads()).toBe(200);
  });

  it("returns the FIRST match in agent order, which is what it replaced", () => {
    // tool_use_id is a global key with no session scope (#1009, open), so two
    // agents can hold a call under one id. `toolIndex` would answer this lookup
    // in O(1) and would answer it with the NEWEST copy; the walk answers with
    // the first in insertion order, which is what `Array.from(...).flatMap(...)
    // .find(...)` did. Pinned so the index cannot be swapped in as a pure
    // speed-up: it would be a different answer, and choosing between them is
    // #1009's business rather than this one's.
    const m = new Map<string, AgentNodeData>();
    const first = { id: "dup", name: "Bash", startedAt: 1 } as ToolCall;
    const second = { id: "dup", name: "Read", startedAt: 2 } as ToolCall;
    m.set("older", { id: "older", tools: [first] } as AgentNodeData);
    m.set("newer", { id: "newer", tools: [second] } as AgentNodeData);
    expect(findToolOnBoard(m, "dup")).toBe(first);
  });

  it("is what App.tsx uses, with no flat copy left on the render path", () => {
    // The shape half. `openedTool` is computed in the render body and cannot be
    // gated on anything — `modalOpenRef` reads it on the next line — so the only
    // place the cost can be removed is the lookup itself.
    expect(app).toMatch(/openedToolId \? findToolOnBoard\(stateRef\.current\.agents, openedToolId\) : null;/);
    expect(app).not.toMatch(/\.flatMap\(a => a\.tools\)/);
  });
});

describe("the rail inset is measured when something can have moved it", () => {
  /** The effect body plus its dependency array, as source text. */
  const railEffect = /const cover = railCover\(canvasRef\.current\);[\s\S]{0,200}?\}, \[([^\]]*)\]\);/.exec(app);

  it("has a dependency array at all, which is the whole of #997's first half", () => {
    // Before: `});` — no array, so React re-ran it after every commit. On an
    // idle deck that is 240 document-wide `querySelectorAll` calls a minute for
    // a number that changes when a panel opens, which on an idle deck is never.
    expect(railEffect).not.toBeNull();
  });

  it("names every input that can move the rail relative to the canvas", () => {
    const deps = (railEffect?.[1] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    // Each of these is a rule in styles.css, and dropping any one of them is a
    // rail that measures 360px or 300px wrong until something else re-renders
    // with a changed dependency:
    //   machinePhase / usagePhase  mount, and the `.leaving` class railCover
    //                              filters out. The PHASES, not the open flags:
    //                              usePanelPresence flips the flag one render
    //                              BEFORE the panel is in the DOM, so a flag
    //                              dependency measures the frame before the
    //                              panel exists and never looks again.
    //   usagePanelOpen             `.sysdetail.shifted`, +300px, driven by the
    //                              raw flag a render ahead of usagePhase.
    //   detailShown                `--rail-r`, 368px against 8px, both panels.
    //   canvasSize.w               the canvas box the cover is measured against,
    //                              and the only way the accounts panel and a
    //                              window resize reach this.
    expect(deps).toEqual(["machinePhase", "usagePhase", "usagePanelOpen", "detailShown", "canvasSize.w"]);
  });

  it("derives detailShown from the same condition that mounts the panel", () => {
    // The drift guard. `--rail-r` keys off `.detail` being in the DOM, and
    // `detailOpen` is not that: the panel is `detailOpen && selected`, so a deck
    // with the panel enabled and nothing selected has no `.detail` and a rail
    // 360px further right. Both halves are pinned, so changing the mount
    // condition without changing the derivation goes red here.
    expect(app).toMatch(/const detailShown = detailOpen && selected != null;/);
    expect(app).toMatch(/\{detailOpen && selected \? \(/);
  });

  it("keeps railCover to the two callers that are not on the render path", () => {
    // Its declaration, `fitLeft`'s use of it — which runs on an explicit fit and
    // not per tick — and the effect above. A third call added to the render body
    // would reintroduce the document-wide query this removed, under another
    // name, and nothing else in the file would notice.
    expect([...app.matchAll(/\brailCover\(/g)].length).toBe(3);
  });
});
