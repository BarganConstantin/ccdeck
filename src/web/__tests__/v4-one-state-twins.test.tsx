// V4 critique, round 3, points 2 and 3.
//
// 2. One state on every surface: a session that ended with a failed call drew
//    the cross and "1 failed" on its card, and done's tick in the Sessions list.
//    Every surface now asks node-face.ts sessionMark for the mark; the list row
//    says the count the card says and stays in its Done group.
// 3. Look-alikes get the shortest difference: three sessions read "ccdeck ·
//    Write the release notes for 3.83" on the board and in the list. Only where
//    two or more share the name and the task line does each draw when it started.
import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import SessionList, { buildRows, rank } from "../components/SessionList";
import { NavigatorView } from "../components/BoardNavigator";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { nodeDataFor } from "../canvas-flow";
import { clusterBounds, type ClusterNode } from "../cluster-bounds";
import { navigatorSessions } from "../board-navigator";
import { faceStatus, sessionMark } from "../node-face";
import { railFailed, railGlyph, twinClocks, twinStart } from "../rail-row-copy";
import { clockTime } from "../i18n/format";
import { sessionLine } from "../quick-open-items";
import { cardStatus } from "../inspector-state";
import { paneStatus } from "../inspector-status-pane";
import { resetSessionsSeen } from "../session-seen";
import { sheetRules } from "./sheet-cascade";
import { sheetText } from "./sheet-source";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;
let seq = 0;
const send = (s: GraphState, sid: string, payload: Record<string, unknown>, at: number) =>
  applyEvent(s, { seq: ++seq, receivedAt: T0 + at, source: "hook", payload: { session_id: sid, ...payload } as HookPayload } as HookEnvelope);
const begin = (s: GraphState, sid: string, cwd: string, prompt: string, at: number) => {
  s = send(s, sid, { hook_event_name: "SessionStart", cwd }, at);
  return send(s, sid, { hook_event_name: "UserPromptSubmit", prompt }, at + 1);
};

const NOTES = "Write the release notes for 3.83";

/** The board of the critique: three sessions that read the same (two working,
 *  one done), one other working session, and "site", which finished with a
 *  failed call. The look-alikes started 20s apart, so two share a minute. */
function board(): GraphState {
  let s = initialState();
  s = begin(s, "n1", "/code/ccdeck", NOTES, 0);
  s = begin(s, "n2", "/code/ccdeck", NOTES, 20_000);
  s = begin(s, "n3", "/code/ccdeck", NOTES, 40_000);
  s = send(s, "n3", { hook_event_name: "Stop" }, 50_000);
  s = begin(s, "map", "/code/ccdeck", "Fix the minimap overlap on the board", 0);
  s = begin(s, "site", "/code/site", "Run the test suite and fix what fails", 0);
  s = send(s, "site", { hook_event_name: "Stop" }, 30_000);
  s.agents.get("site")!.toolErrorCount = 1;
  return s;
}

beforeEach(() => { seq = 0; resetSessionsSeen(); });

const rules = sheetRules();
function decl(selector: string, prop: string): string | undefined {
  let found: string | undefined;
  for (const r of rules) {
    if (r.media !== null || !r.selectors.includes(selector)) continue;
    const m = [...r.body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].at(-1);
    if (m) found = m[1].trim();
  }
  return found;
}

const card = (data: Partial<AgentNodeData> & { twin?: "minute" | "second" }) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
  createElement(AgentNode as never, { id: "s", data: {
    sessionId: "s", id: "s", label: "ccdeck", cwdBasename: "ccdeck", kind: "root", state: "active", childCount: 0, tools: [], toolCount: 3,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
    prompts: [{ text: NOTES, at: T0 }], startedAt: T0, ...data,
  }, selected: false } as never)));

// ── point 2 ─────────────────────────────────────────────────────────────────

describe("one mark for a session, from sessionMark", () => {
  it("draws the cross for a finished session whose calls failed, and for a stopped turn", () => {
    expect(sessionMark({ kind: "root", state: "done", toolErrorCount: 1 })).toBe("err");
    expect(sessionMark({ kind: "root", state: "done", stopFailure: { kind: "other" } as never })).toBe("err");
    expect(sessionMark({ kind: "root", state: "err" })).toBe("err");
  });
  it("keeps the tick when nothing failed, and the live ring on a session still at work", () => {
    expect(sessionMark({ kind: "root", state: "done" })).toBe("done");
    expect(sessionMark({ kind: "root", state: "active", toolErrorCount: 3 })).toBe("live");
    expect(sessionMark({ kind: "subagent", state: "done", toolErrorCount: 2 })).toBe("err");
  });
  it("reads a list row, which holds its drawn state and its count and no kind", () => {
    expect(sessionMark({ state: "done", toolErrorCount: 1 })).toBe("err");
    expect(sessionMark({ state: "done" })).toBe("done");
  });
});

describe("the Sessions list says what the card says", () => {
  const rows = () => buildRows(board(), T0 + 100_000);
  const row = (id: string) => rows().find(r => r.sessionId === id)!;

  it("files the failed session under Done and draws the cross, as the command menu does", () => {
    const site = row("site");
    expect(site.state).toBe("done");
    expect(site.toolErrorCount).toBe(1);
    expect([2, 3]).toContain(rank(site));
    expect(railGlyph(site, rank(site))).toBe("error");
    expect(sessionLine(site).tone).toBe("error");
    // The count the card's face says beside the same cross.
    expect(railFailed(site, rank(site))).toBe("1 failed");
    const face = faceStatus(board().agents.get("site")!);
    expect(face).toMatchObject({ mark: "err", word: "1 failed" });
  });

  it("says no count on a clean row, a running row or a turn that stopped on an error", () => {
    const done = row("n3");
    expect(railGlyph(done, rank(done))).toBe("done");
    expect(railFailed(done, rank(done))).toBeNull();
    const busy = { ...row("map"), toolErrorCount: 2 };
    expect(railGlyph(busy, rank(busy))).toBe("working");
    expect(railFailed(busy, rank(busy))).toBeNull();
    const stopped = { ...row("site"), state: "err" as const };
    expect(railGlyph(stopped, rank(stopped))).toBe("error");
    expect(railFailed(stopped, rank(stopped))).toBeNull();
  });

  it("draws the cross and leads the second line with the count", () => {
    const html = renderToStaticMarkup(createElement(SessionList, {
      state: board(), now: T0 + 100_000, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
    }));
    const item = html.slice(html.indexOf('data-rail-id="site"'));
    const site = item.slice(0, item.indexOf("</li>"));
    expect(site).toContain('data-glyph="error"');
    expect(site).toContain('<span class="sl-failed">1 failed</span> · Run the test suite and fix what fails');
    expect(html.match(/class="sl-failed"/g)).toHaveLength(1);
  });

  it("sets the count in the cross's ink", () => {
    expect(decl(".session-list .sl-failed", "color")).toBe("var(--err)");
    expect(decl(".session-list .sl-failed", "font-weight")).toBe("500");
  });
});

describe("the card's head and the Inspector agree with the face", () => {
  it("says 1 failed beside the cross on a finished card whose calls failed", () => {
    const out = card({ state: "done", toolErrorCount: 1 });
    expect(out).toMatch(/<span class="state-line" data-tone="err"><svg class="state-mark" data-kind="err"[\s\S]*?<\/svg><span class="state-word">1 failed<\/span><\/span>/);
    expect(card({ state: "done" })).toMatch(/<span class="state-line" data-tone="done"><svg class="state-mark" data-kind="done"[\s\S]*?<span class="state-word">Done<\/span>/);
  });

  it("draws the cross in the Inspector's head, on the Board and in the Workspace", () => {
    const s = board();
    const site = s.agents.get("site")!;
    expect(cardStatus(site)).toEqual({ glyph: "error", phrase: "1 failed" });
    expect(paneStatus(site, s.agents, T0 + 100_000).glyph).toBe("error");
    expect(paneStatus(s.agents.get("n3")!, s.agents, T0 + 100_000).glyph).toBe("done");
  });

  it("draws the cross on the navigator's tile", () => {
    const s = board();
    const dataFor = nodeDataFor(s, () => {});
    const nodes: ClusterNode[] = [...s.agents.values()].map((a, i) => ({
      type: "agent", position: { x: 0, y: i * 300 }, width: 240, height: 80, data: dataFor(a),
    }));
    const html = renderToStaticMarkup(createElement(NavigatorView, {
      clusters: clusterBounds(nodes), sessions: navigatorSessions(nodes), width: 436, density: "tiles", attachedId: null, onOpen: () => {},
    }));
    const tile = (id: string) => {
      const at = html.slice(html.indexOf(`data-nav-session="${id}"`));
      return /<span class="nav-id"><svg class="state-mark" data-kind="(\w+)"/.exec(at)?.[1];
    };
    expect(tile("site")).toBe("err");
    expect(tile("n3")).toBe("done");
  });
});

// ── point 3 ─────────────────────────────────────────────────────────────────

describe("which sessions read the same (twinClocks)", () => {
  const at = (h: number, m: number, sec = 0) => new Date(2026, 10, 12, h, m, sec).getTime();

  it("adds the start time to every session that shares the name and the task", () => {
    const twins = twinClocks([
      { id: "a", title: "ccdeck", task: NOTES, startedAt: at(14, 32) },
      { id: "b", title: "ccdeck", task: NOTES, startedAt: at(14, 40) },
      { id: "c", title: "ccdeck", task: "Fix the minimap", startedAt: at(14, 32) },
    ]);
    expect([...twins]).toEqual([["a", "minute"], ["b", "minute"]]);
  });

  it("adds nothing when the task differs, or when there is one session", () => {
    expect(twinClocks([
      { id: "a", title: "ccdeck", task: NOTES, startedAt: at(14, 32) },
      { id: "b", title: "ccdeck", task: "Review the open pull requests", startedAt: at(14, 32) },
      { id: "c", title: "site", task: NOTES, startedAt: at(14, 32) },
    ]).size).toBe(0);
    expect(twinClocks([{ id: "a", title: "ccdeck", task: NOTES, startedAt: at(14, 32) }]).size).toBe(0);
    expect(twinClocks([]).size).toBe(0);
  });

  it("reads names as a reader does, and an absent task as an empty one", () => {
    expect(twinClocks([
      { id: "a", title: "ccdeck ", task: NOTES, startedAt: at(14, 32) },
      { id: "b", title: "CCDECK", task: ` ${NOTES}`, startedAt: at(14, 33) },
    ]).size).toBe(2);
    expect(twinClocks([
      { id: "a", title: "ccdeck", startedAt: at(9, 0) },
      { id: "b", title: "ccdeck", task: "", startedAt: at(9, 5) },
    ]).size).toBe(2);
  });

  it("takes the seconds too when two of them started in the same minute", () => {
    const twins = twinClocks([
      { id: "a", title: "ccdeck", task: NOTES, startedAt: at(14, 32, 5) },
      { id: "b", title: "ccdeck", task: NOTES, startedAt: at(14, 32, 40) },
      { id: "c", title: "ccdeck", task: NOTES, startedAt: at(15, 1) },
    ]);
    expect([...twins.values()]).toEqual(["second", "second", "second"]);
    expect(twinStart(at(14, 32, 5), "second")).toBe(clockTime(at(14, 32, 5), true));
    expect(twinStart(at(14, 32, 5), "minute")).toBe(clockTime(at(14, 32, 5)));
    expect(clockTime(at(14, 32, 5), true)).not.toBe(clockTime(at(14, 32, 40), true));
  });
});

describe("the Sessions list draws the start time on look-alike rows only", () => {
  it("marks the three look-alikes, done one included, and leaves the others as they were", () => {
    const rows = buildRows(board(), T0 + 100_000);
    const twin = Object.fromEntries(rows.map(r => [r.sessionId, r.twin]));
    // n1 and n2 started in the same minute, so the group takes its seconds.
    expect(twin).toEqual({ n1: "second", n2: "second", n3: "second", map: undefined, site: undefined });
  });

  it("leads the second line with it, so the name keeps the first line whole", () => {
    const s = board();
    const html = renderToStaticMarkup(createElement(SessionList, {
      state: s, now: T0 + 100_000, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
    }));
    expect(html.match(/class="sl-start"/g)).toHaveLength(3);
    const n1 = html.slice(html.indexOf('data-rail-id="n1"'));
    const row = n1.slice(0, n1.indexOf("</li>"));
    const line1 = row.slice(row.indexOf('class="sl-line1"'), row.indexOf('class="sl-line2'));
    expect(line1).toContain('<span class="sl-label">ccdeck</span>');
    expect(line1).not.toContain("sl-start");
    expect(row).toMatch(new RegExp(`class="sl-line2[^"]*"><span class="sl-start">${clockTime(T0, true)}</span> · `));
    const site = html.slice(html.indexOf('data-rail-id="site"'));
    expect(site.slice(0, site.indexOf("</li>"))).not.toContain("sl-start");
  });
});

describe("the board draws the start time on look-alike cards only", () => {
  it("is decided among the cards drawn, and kept with the copy until that changes", () => {
    const s = board();
    const all = new Set(s.agents.keys());
    const open = () => {};
    const dataFor = nodeDataFor(s, open, all);
    expect(["n1", "n2", "n3", "map", "site"].map(id => dataFor(s.agents.get(id)!).twin))
      .toEqual(["second", "second", "second", undefined, undefined]);
    const first = dataFor(s.agents.get("map")!);
    expect(nodeDataFor(s, open, all)(s.agents.get("map")!)).toBe(first);
    // n2 off the board: n1 and n3 still read the same, a minute apart.
    const without = new Set([...all].filter(id => id !== "n2"));
    const fewer = nodeDataFor(s, () => {}, without);
    expect(fewer(s.agents.get("n1")!).twin).toBe("minute");
    expect(fewer(s.agents.get("n3")!).twin).toBe("minute");
    // Only n1 left: a session that reads like no other is the card it was.
    const one = nodeDataFor(s, () => {}, new Set([...all].filter(id => id !== "n2" && id !== "n3")));
    expect(one(s.agents.get("n1")!)).not.toHaveProperty("twin");
  });

  it("leads the task line with it on the detail face, and puts it after the word on the face at a distance", () => {
    const out = card({ twin: "minute", model: "claude-opus-5-5" });
    const time = clockTime(T0);
    // The head keeps the name whole: nothing between it and the model.
    expect(out).toContain('<span class="label">ccdeck</span><span class="model-text"');
    expect(out).toMatch(new RegExp(`<div class="task-line"[^>]*><span class="twin-start" title="Started ${time}">${time}</span> · ${NOTES}</div>`));
    expect(out).toContain(`<span class="lod-name">${NOTES}</span><span class="lod-start">${time}</span><span class="lod-state">Working</span>`);
  });

  it("draws the time alone on the task line of a look-alike that was asked nothing", () => {
    const out = card({ twin: "minute", prompts: [] });
    const time = clockTime(T0);
    expect(out).toMatch(new RegExp(`<div class="task-line"><span class="twin-start" title="Started ${time}">${time}</span></div>`));
  });

  it("leaves a card that reads like no other exactly as it was", () => {
    const out = card({ model: "claude-opus-5-5" });
    expect(out).not.toContain("twin-start");
    expect(out).not.toContain("lod-start");
  });

  it("sets it in the quiet mono, puts it after the word on two lines, and never draws it below 40%", () => {
    expect(decl(".lod-start", "color")).toBe("var(--muted)");
    expect(decl(".lod-start", "font-family")).toBe("var(--font-mono)");
    expect(decl(".lod-start", "flex")).toBe("none");
    expect(decl(".canvas-wrap[data-far] .agent-node .lod-start", "display")).toBe("none");
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    const block = css.slice(css.indexOf("@container lod (min-height: 28px)"));
    expect(block.slice(0, block.indexOf("\n}\n"))).toContain(".lod-start { order: 1; }");
  });
});
