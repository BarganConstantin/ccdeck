// The navigator has to say exactly what the board says. It stands in for the
// board while a session has the stage, and a reader who glances from a tile to
// the stage header and back must not meet a second vocabulary: a face that
// reads "Needs you" on the board and something else here, a clock a second
// apart from the card's, a hue a few degrees off. So the tiles are built from
// the board's own helpers — faceSignal with the card's words, elapsed(),
// StateMark, sessionHue, the cluster header — and these cases hold them to it
// by rendering the board's real card (AgentNode) and the navigator from the
// same reducer state and comparing what each one prints.
//
// The rest pins the parts of the v3 design a reader acts on: the socket (the
// tile of the session on the stage, with its chevron and aria-current), one
// tab stop for the whole navigator, the rail as faces only, the task on the
// rim, and the sheet drawing at exactly the sizes board-navigator.ts lays out.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import { NavigatorView, quietLine } from "../components/BoardNavigator";
import { modelChipText } from "../model-label";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { nodeDataFor } from "../canvas-flow";
import { clusterBounds, type Cluster, type ClusterNode } from "../cluster-bounds";
import { FACE_H, ROW_H, TILE_PAD, navigatorClusters, navigatorFrame, navigatorSessions, type NavDensity } from "../board-navigator";
import { sessionHue } from "../session-hue";
import { sheetText } from "./sheet-source";
import { withoutComments } from "./tsx-scan";
import type { HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;

/** Four sessions driven through the real reducer, so the cards are the shapes
 *  the deck holds: one stopped on a permission prompt, one working with two
 *  subagents, one running a call, and one that finished and says nothing. */
function build(): GraphState {
  let seq = 0;
  let state = initialState();
  const send = (payload: Record<string, unknown>, at: number) => {
    state = applyEvent(state, { seq: ++seq, receivedAt: at, source: "hook", payload: payload as HookPayload } as HookEnvelope);
  };
  send({ hook_event_name: "SessionStart", session_id: "pay", cwd: "/code/paycore" }, T0);
  send({ hook_event_name: "UserPromptSubmit", session_id: "pay", prompt: "push the branch" }, T0 + 1_000);
  send({ hook_event_name: "PreToolUse", session_id: "pay", tool_name: "Bash", tool_use_id: "p1", tool_input: { command: "git push" } }, T0 + 2_000);
  send({ hook_event_name: "Notification", session_id: "pay", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, T0 + 3_000);

  send({ hook_event_name: "SessionStart", session_id: "boom", cwd: "/code/boom-next-gen" }, T0);
  send({ hook_event_name: "UserPromptSubmit", session_id: "boom", prompt: "migrate billing" }, T0 + 1_000);
  for (const [i, type] of ["Explore", "code-reviewer"].entries()) {
    send({ hook_event_name: "PreToolUse", session_id: "boom", tool_name: "Task", tool_use_id: `b${i}`, tool_input: { subagent_type: type, description: type } }, T0 + 2_000 + i);
    send({ hook_event_name: "SubagentStart", session_id: "boom", parent_tool_use_id: `b${i}`, subagent_type: type }, T0 + 2_100 + i);
  }
  // A call while a subagent runs is the subagent's, so one row has something
  // of its own to say.
  send({ hook_event_name: "PreToolUse", session_id: "boom", tool_name: "Grep", tool_use_id: "g1", tool_input: { pattern: "billing" } }, T0 + 2_200);

  send({ hook_event_name: "SessionStart", session_id: "read", cwd: "/code/vcrm-core" }, T0);
  send({ hook_event_name: "UserPromptSubmit", session_id: "read", prompt: "look" }, T0 + 1_000);
  send({ hook_event_name: "PreToolUse", session_id: "read", tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: "/code/vcrm-core/Mailbox.cs" } }, T0 + 2_000);

  send({ hook_event_name: "SessionStart", session_id: "quiet", cwd: "/code/vicinae" }, T0);
  send({ hook_event_name: "UserPromptSubmit", session_id: "quiet", prompt: "done?" }, T0 + 1_000);
  send({ hook_event_name: "Stop", session_id: "quiet" }, T0 + 5_000);
  // The title Claude Code gives a session reaches the card from its transcript,
  // not from a hook, so it is set the way that path leaves it: on the root.
  state.agents.get("boom")!.sessionTitle = "Migrate billing to per-model pricing";
  return state;
}

/** The board's nodes for that state, as React Flow would hold them once laid
 *  out: two columns, roots on the left of their subagents. */
function boardNodes(state: GraphState): ClusterNode[] {
  const dataFor = nodeDataFor(state, () => {});
  const column: Record<string, number> = { pay: 0, boom: 0, read: 1, quiet: 1 };
  const y: Record<number, number> = { 0: 0, 1: 0 };
  const nodes: ClusterNode[] = [];
  for (const sid of ["pay", "boom", "read", "quiet"]) {
    const agents = [...state.agents.values()].filter(a => a.sessionId === sid);
    const x = column[sid] * 1400;
    const top = y[column[sid]];
    agents.forEach((a, i) => nodes.push({
      type: "agent",
      position: a.kind === "root" ? { x, y: top } : { x: x + 400, y: top + (i - 1) * 100 },
      width: 240,
      height: 80,
      data: dataFor(a),
    }));
    y[column[sid]] = top + Math.max(1, agents.length) * 100 + 200;
  }
  return nodes;
}

const state = build();
const nodes = boardNodes(state);
const clusters: Cluster[] = clusterBounds(nodes);
const sessions = navigatorSessions(nodes);

function navigator(density: NavDensity = "tiles", attachedId: string | null = "boom", withNew = true): string {
  return renderToStaticMarkup(createElement(NavigatorView, {
    clusters, sessions, width: 436, density, attachedId,
    onOpen: () => {},
    onNewSession: withNew ? () => {} : undefined,
  }));
}

/** The board's own card for an agent, rendered as the canvas renders it. */
function card(id: string): string {
  const data = nodes.find(n => n.data?.id === id)!.data!;
  return renderToStaticMarkup(createElement(ReactFlowProvider, null,
    createElement(AgentNode as any, { id, data, selected: false })));
}

const decode = (s: string) => s.replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'");

/** The text of the first element carrying `cls`, tags stripped. */
function textOf(html: string, cls: string): string | null {
  const m = new RegExp(`<(\\w+)[^>]*class="${cls}"[^>]*>(.*?)</\\1>`).exec(html);
  return m ? decode(m[2]) : null;
}

/** One tile's markup, from its opening tag to the next tile's. */
function tile(html: string, sessionId: string): string {
  const start = html.indexOf(`data-nav-session="${sessionId}"`);
  expect(start, `a tile for ${sessionId}`).toBeGreaterThan(-1);
  const next = html.indexOf("data-nav-session=", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

describe("a tile says what the board's card says", () => {
  const html = navigator();

  it("puts the board face's own signal on its second line", () => {
    // A working session with subagents, and one running a call: the card's
    // distance face and the tile print the same sentence.
    for (const id of ["boom", "read"]) {
      const board = textOf(card(id), "lod-long");
      expect(board, `${id} has a signal on the board`).toBeTruthy();
      expect(textOf(tile(html, id), "nav-signal"), id).toBe(board);
    }
  });

  it("leads a blocked session's line with 'waiting' and how long, then the face's sentence", () => {
    const board = textOf(card("pay"), "lod-long")!;
    const line = textOf(tile(html, "pay"), "nav-signal")!;
    const waited = textOf(card("pay"), "waiting-row permission")?.match(/(\d+(?:ms|s|m \d\ds|h \d+m))$/)?.[1];
    expect(line).toBe(`waiting ${waited} · ${board}`);
    // And the triangle in the clock's place, as the face draws it.
    expect(tile(html, "pay")).toContain('class="alert-mark"');
    expect(tile(html, "pay")).not.toContain('class="nav-el"');
  });

  it("says a quiet session's state in the card's own word, and what runs it, when the face has nothing to say", () => {
    expect(textOf(card("quiet"), "lod-long"), "the board's face is silent").toBeNull();
    expect(textOf(tile(html, "quiet"), "nav-signal")).toBe("done · Claude Code");
  });

  it("names what runs a quiet session in the words of the card's model chip, or by the agent's name before it has one", () => {
    expect(quietLine({ state: "active", model: "claude-opus-5-5", effort: "xhigh", provider: "claude" })).toBe("live · Opus 5.5 · xhigh");
    expect(quietLine({ state: "done", model: "gpt-5.5-codex", provider: "codex" })).toBe(`done · ${modelChipText("gpt-5.5-codex")}`);
    expect(quietLine({ state: "active", provider: "codex" })).toBe("live · Codex");
    expect(quietLine({ state: "error" })).toBe("err · Claude Code");
  });

  it("shows the card's clock, to the second", () => {
    for (const id of ["boom", "read", "quiet"]) {
      expect(textOf(tile(html, id), "nav-el"), id).toBe(textOf(card(id), "time"));
    }
  });

  it("draws the session in the card's hue and with the card's state mark", () => {
    for (const id of ["pay", "boom", "read", "quiet"]) {
      const t = tile(html, id);
      expect(t, id).toContain(`--session-hue:${sessionHue(id)}`);
      const mark = /class="state-mark" data-kind="(\w+)"/;
      expect(mark.exec(t)?.[1], id).toBe(mark.exec(card(id))?.[1]);
    }
  });

  it("lists each subagent with its mark, its name and its own face's words", () => {
    const t = tile(html, "boom");
    const subs = [...state.agents.values()].filter(a => a.sessionId === "boom" && a.kind === "subagent");
    expect(subs).toHaveLength(2);
    expect((t.match(/class="nav-row"/g) ?? []).length).toBe(2);
    const said = [...t.matchAll(/<span class="nav-row-said"[^>]*>([^<]*)<\/span>/g)].map(m => decode(m[1]));
    const boardSaid = subs.map(sub => textOf(card(sub.id), "lod-long")).filter(Boolean);
    expect(boardSaid.length, "a subagent on the board has something to say").toBeGreaterThan(0);
    expect(said).toEqual(boardSaid);
    for (const sub of subs) expect(t, sub.label).toContain(`<span class="nav-row-name">${sub.label}</span>`);
    // The trunk in the board's edge classes, one branch per row, live ones flowing.
    expect((t.match(/class="sess-edge sess-(?:live|idle)"/g) ?? []).length).toBe(2);
  });

  it("names the workspace on the face and the task on the rim, as the board's pill does", () => {
    expect(clusters.filter(c => c.name).map(c => c.sessionId), "the fixture has a named session").toEqual(["boom"]);
    // Cut where the board's pill cuts it, which is never past the card's row.
    expect(textOf(card("boom"), "session-name")).toBe("Migrate billing to per-model pricing");
    expect(textOf(tile(html, "boom"), "nav-pill")).toBe("Migrate billing to per-model pr…");
    for (const c of clusters) {
      const t = tile(html, c.sessionId);
      expect(textOf(t, "nav-name"), c.sessionId).toBe(c.label);
      if (c.name) expect(textOf(t, "nav-pill"), c.sessionId).toBe(c.name);
      else expect(t, c.sessionId).not.toContain("nav-pill");
    }
  });

  it("is named for a screen reader by the card's own accessible name", () => {
    expect(tile(html, "read")).toMatch(/aria-label="vcrm-core, session, live/);
  });
});

describe("the socket", () => {
  it("is the attached session's tile: marked, current, with the chevron toward the stage", () => {
    const html = navigator("tiles", "boom");
    const socket = tile(html, "boom");
    expect(socket).toContain("data-attached");
    expect(socket).toContain('aria-current="true"');
    expect(socket).toContain('class="nav-socket"');
    expect(socket).toMatch(/aria-label="[^"]*, on the stage"/);
    for (const other of ["pay", "read", "quiet"]) {
      const t = tile(html, other);
      expect(t, other).not.toContain("data-attached");
      expect(t, other).not.toContain("nav-socket");
      expect(t, other).not.toContain("aria-current");
    }
  });

  it("is nowhere when nothing is on the stage", () => {
    const html = navigator("tiles", null);
    expect(html).not.toContain("data-attached");
    expect(html).not.toContain("nav-socket");
  });
});

describe("the keyboard", () => {
  it("has one tab stop for the whole navigator, on the socket", () => {
    const html = navigator("tiles", "read");
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect(tile(html, "read")).toContain('tabindex="0"');
  });

  it("starts on the first tile when nothing is on the stage", () => {
    const html = navigator("tiles", null);
    const first = navigatorFrame(navigatorClusters(clusters, sessions), 436, "tiles").tiles[0].sessionId;
    expect(tile(html, first)).toContain('tabindex="0"');
  });

  it("ignores a shift-press and opens the session on any other", () => {
    // No DOM here to dispatch a click into, so the handler's shape is the
    // evidence: the shift test comes first and returns before onOpen.
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../components/BoardNavigator.tsx", import.meta.url)), "utf8"));
    expect(src).toMatch(/if \(e\.shiftKey\) return;\s*onOpen\(id, \{ keyboard: e\.detail === 0 \}\);/);
  });
});

describe("the header and the rail", () => {
  it("puts '+ New session' first and the count of sessions beside it", () => {
    const html = navigator();
    expect(html.indexOf("nav-new")).toBeLessThan(html.indexOf("data-nav-session"));
    expect(html).toContain('aria-label="New session"');
    expect(textOf(html, "nav-count")).toBe("4 sessions");
  });

  it("leaves the button out when there is nothing to start a session with", () => {
    expect(navigator("tiles", "boom", false)).not.toContain("nav-new");
  });

  it("draws faces only in the rail, in one column", () => {
    const html = navigator("rail");
    expect(html).toContain('data-density="rail"');
    expect(html).not.toContain("nav-row");
    expect(html).not.toContain("nav-trunk");
    const lefts = new Set([...html.matchAll(/class="nav-tile"[^>]*style="left:(\d+)px/g)].map(m => m[1]));
    expect(lefts.size).toBe(1);
  });

  it("places each tile where navigatorFrame put it", () => {
    const html = navigator();
    const frame = navigatorFrame(navigatorClusters(clusters, sessions), 436, "tiles");
    for (const t of frame.tiles) {
      expect(tile(html, t.sessionId), t.sessionId).toContain(`style="left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px`);
    }
  });
});

describe("the sheet draws at the sizes the frame lays out", () => {
  const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
  const body = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  const px = (selector: string, prop: string) => Number(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([\\d.]+)px`).exec(body(selector))?.[1]);

  it("gives the face the frame's height and inset, and a row the frame's height", () => {
    // The press target is the face's box; the face fills it.
    expect(px(".nav-open", "height")).toBe(FACE_H);
    expect(px(".nav-open", "top")).toBe(TILE_PAD);
    expect(px(".nav-open", "left")).toBe(TILE_PAD);
    expect(body(".nav-face")).toMatch(/inset: 0;/);
    expect(px(".nav-row", "height")).toBe(ROW_H);
  });

  it("stops the flowing trunk and the socket's flash under reduced motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .nav-trunk"));
    expect(reduced).toMatch(/\.nav-trunk \.sess-edge\.sess-live \{ animation: none; \}/);
    expect(reduced).toMatch(/\.nav-tile\[data-attached\]\[data-flash\] \.nav-face \{ animation: none; \}/);
  });

  it("keeps the socket and the trunk visible under a Contrast theme, in the deck's one forced-colours block", () => {
    const forced = css.slice(css.indexOf("@media (forced-colors: active) {"));
    expect(forced).toMatch(/\.nav-tile\[data-attached\] \.nav-face,\s*\.nav-tile\[data-attached\] \.nav-rim \{ border-color: Highlight; \}/);
    expect(forced).toMatch(/\.nav-socket \{ color: Highlight; \}/);
    expect(forced).toMatch(/\.nav-trunk \.sess-edge\.sess-live,\s*\.nav-trunk \.sess-edge\.sess-idle \{ stroke: CanvasText; \}/);
  });

  it("draws the face's edge on the face and nothing on the button but the deck's focus ring", () => {
    // A border on the button would be a control's boundary, held to 3:1 by
    // control-edges; the face's edge is a state, as a card's is.
    expect(body(".nav-open")).toMatch(/border: 0;/);
    expect(css).not.toMatch(/\.nav-open:focus-visible/);
    expect(css).not.toMatch(/\.nav-face:focus-visible/);
  });

  it("draws the face's state edge in both themes", () => {
    for (const state of ["active", "done", "err"]) {
      expect(css).toContain(`.nav-face[data-state="${state}"] { --nav-edge:`);
      expect(css).toContain(`:root[data-theme="light"] .nav-face[data-state="${state}"] { --nav-edge:`);
    }
  });
});
