// V4 top-10, the Inspector's next step. The calm Inspector (#6) left one
// button in its body, Show recap for a finished session, so answering a
// session that waits, or looking at its terminal, meant knowing the Workspace
// key or finding the card. Now the row under the title block offers the one
// next step for the session's state: Answer, the body's only Primary, for a
// session stopped on a person; Open, Quiet, for any other; Show recap stays
// beside it for a finished one. Both go through the press Enter on a Sessions
// row makes (App's openSessionWithKeys), and neither is drawn where the deck
// has no terminal, as no card or row opens one there either.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Detail, { inspectorNextStep } from "../components/Detail";
import type { AgentNodeData, WaitingBlock } from "../types";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const BLOCK = (kind: WaitingBlock["kind"]): WaitingBlock => ({ kind, message: "Claude needs your permission to use Bash", since: 1500 });
const A = (over: Partial<AgentNodeData> = {}) => ({
  id: "sess-1", sessionId: "sess-1", label: "api", kind: "root", state: "active", childCount: 0, toolCount: 3,
  tools: [], usage: USAGE, prompts: [{ text: "Ship it", at: 1200 }], startedAt: 1000, ...over,
}) as unknown as AgentNodeData;

/** The states the brief names, as the card and the pane would call them. */
const STATES: Record<string, AgentNodeData> = {
  needsYou: A({ waiting: BLOCK("permission") }),
  asked: A({ waiting: BLOCK("asked") }),
  working: A(),
  // Ready: an own session that has had no prompt yet (node-face.ts neverPrompted).
  ready: A({ toolCount: 0, prompts: [] }),
  // Done, waiting for its next prompt: the idle block is no alarm (#348).
  yourTurn: A({ state: "done", endedAt: 5000, waiting: BLOCK("idle") }),
  done: A({ state: "done", endedAt: 5000 }),
  error: A({ state: "err", endedAt: 5000 }),
};

const draw = (agent: AgentNodeData, over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(Detail, {
  agent, now: 30_000, onOpenTool: () => {}, onShowSummary: () => {}, onExportSession: () => {}, onRemove: () => {},
  onOpenSession: () => {}, ...over,
}));
/** The row under the title block, or null when it is not drawn. */
const rowOf = (html: string): string | null => /<\/header>(<div class="hero-actions">[\s\S]*?<\/div>)/.exec(html)?.[1] ?? null;
const buttonsOf = (row: string | null) => [...(row ?? "").matchAll(/<button ([^>]*)>([^<]*)<\/button>/g)].map(m => ({ attrs: m[1], text: m[2] }));

describe("which step, per state (inspectorNextStep)", () => {
  const can = { canOpen: true, stageSession: null };

  it("is Answer for a session stopped on a person, permission or question", () => {
    expect(inspectorNextStep(STATES.needsYou, can)).toBe("answer");
    expect(inspectorNextStep(STATES.asked, can)).toBe("answer");
  });

  it("is Open for working, ready, done (an idle turn too) and failed", () => {
    for (const k of ["working", "ready", "yourTurn", "done", "error"]) expect(inspectorNextStep(STATES[k], can), k).toBe("open");
  });

  it("is nothing for a subagent, even one whose session waits", () => {
    const sub = A({ id: "sess-1::a1", kind: "subagent", waiting: BLOCK("permission") });
    expect(inspectorNextStep(sub, can)).toBeNull();
    expect(inspectorNextStep({ ...sub, waiting: null } as AgentNodeData, can)).toBeNull();
  });

  it("is nothing in any state where the deck cannot open a terminal", () => {
    for (const [k, agent] of Object.entries(STATES)) expect(inspectorNextStep(agent, { canOpen: false, stageSession: null }), k).toBeNull();
  });

  it("drops Open for the session the stage already shows, and keeps Answer, which gives its pane the keys", () => {
    const here = { canOpen: true, stageSession: "sess-1" };
    expect(inspectorNextStep(STATES.working, here)).toBeNull();
    expect(inspectorNextStep(STATES.done, here)).toBeNull();
    expect(inspectorNextStep(STATES.needsYou, here)).toBe("answer");
    // Another session on the stage changes nothing for this one.
    expect(inspectorNextStep(STATES.working, { canOpen: true, stageSession: "sess-2" })).toBe("open");
  });
});

describe("the row under the title block", () => {
  it("draws Answer as the Primary button, named for the session, first after the title block", () => {
    const row = rowOf(draw(STATES.needsYou));
    expect(row).toBe('<div class="hero-actions"><button type="button" class="btn primary" aria-label="Answer api">Answer</button></div>');
  });

  it("draws Open as a Quiet button for working, ready and failed, with no recap beside it", () => {
    for (const k of ["working", "ready", "error"]) {
      expect(rowOf(draw(STATES[k])), k).toBe('<div class="hero-actions"><button type="button" class="btn" aria-label="Open api">Open</button></div>');
    }
  });

  it("keeps Show recap beside Open for a finished session, both Quiet, Open first, two at most", () => {
    for (const k of ["done", "yourTurn"]) {
      const buttons = buttonsOf(rowOf(draw(STATES[k])));
      expect(buttons.map(b => b.text), k).toEqual(["Open", "Show recap"]);
      for (const b of buttons) expect(b.attrs, k).toMatch(/^type="button" class="btn"( |$)/);
    }
  });

  it("gives the Primary weight to Answer only: no other state, and nothing else in the body, wears it", () => {
    for (const [k, agent] of Object.entries(STATES)) {
      const html = draw(agent);
      const primaries = html.match(/class="btn primary"/g) ?? [];
      expect(primaries.length, k).toBe(inspectorNextStep(agent, { canOpen: true, stageSession: null }) === "answer" ? 1 : 0);
    }
  });

  it("draws Answer and Show recap together when a finished session is also stopped on a person", () => {
    const both = A({ state: "done", endedAt: 5000, waiting: BLOCK("asked") });
    const buttons = buttonsOf(rowOf(draw(both)));
    expect(buttons.map(b => b.text)).toEqual(["Answer", "Show recap"]);
    expect(buttons[0].attrs).toContain('class="btn primary"');
    expect(buttons[1].attrs).toMatch(/class="btn"/);
  });

  it("is hidden where the deck has no terminal: nothing for a running session, Recap alone for a finished one", () => {
    const none = { onOpenSession: undefined };
    for (const k of ["needsYou", "asked", "working", "ready", "error"]) {
      expect(draw(STATES[k], none), k).not.toContain("hero-actions");
    }
    expect(buttonsOf(rowOf(draw(STATES.done, none))).map(b => b.text)).toEqual(["Show recap"]);
  });

  it("is hidden for the session the stage already shows, but for its Answer", () => {
    const here = { stageSession: "sess-1" };
    expect(draw(STATES.working, here)).not.toContain("hero-actions");
    expect(buttonsOf(rowOf(draw(STATES.done, here))).map(b => b.text)).toEqual(["Show recap"]);
    expect(buttonsOf(rowOf(draw(STATES.needsYou, here))).map(b => b.text)).toEqual(["Answer"]);
  });

  it("draws nothing for a subagent", () => {
    const sub = A({ id: "sess-1::a1", kind: "subagent", parentId: "sess-1", waiting: BLOCK("permission") });
    expect(draw(sub)).not.toContain("hero-actions");
  });

  it("is the first control after the title block's ⋯: nothing focusable between them", () => {
    const html = draw(STATES.needsYou);
    const more = html.indexOf('class="glyph-btn hero-more"');
    const answer = html.indexOf('class="btn primary"');
    expect(more).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(more);
    const between = html.slice(html.indexOf("</button>", more) + "</button>".length, html.lastIndexOf("<button", answer));
    expect(between).not.toMatch(/<(button|a|input|select|textarea|summary)\b|tabindex=/);
  });

  it("takes the 32px floor under a coarse pointer, as the Details row under it does", () => {
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");
    expect(coarse).toMatch(/\.detail \.hero-actions \.btn \{ min-height: 32px; \}/);
  });
});

// Pressing the buttons is v4-inspector-next-step-press.test.ts, which runs
// Detail on fake-react.

describe("the handler is the one the deck already opens a session with", () => {
  const app = sourceOf("App.tsx");
  const aside = sourceOf("components/DetailAside.tsx");
  const detail = sourceOf("components/Detail.tsx");

  it("is App's openSessionWithKeys, Enter on a Sessions row: the session in the pane, the keys in it", () => {
    expect(app).toMatch(/const openSessionWithKeys = useCallback\(\(sessionId: string\) => \{\s*if \(removedAgentIds\.has\(sessionId\)\) bringBack\(\[sessionId\]\);\s*openInPane\(sessionId, \{ focusPane: true \}\);\s*\}/);
    expect(app).toContain("onOpenKeys={inWorkspace ? openSessionWithKeys : undefined}");
  });

  it("is handed to every Inspector App mounts, and only where the deck has a terminal", () => {
    const mounts = app.split("<DetailAside").slice(1).map(s => s.slice(0, s.indexOf("/>")));
    expect(mounts).toHaveLength(2);
    for (const m of mounts) {
      expect(m).toContain("onOpenSession={stage.enabled ? openSessionWithKeys : undefined}");
      // On the stage: what the deck's other readers of "the session on the
      // stage" read, from the moment it is asked for until it starts to leave.
      expect(m).toContain("stageSession={stage.enabled && stageClaimsKeys(stage.shell.phase) ? targetSession(stage.shell.target) : null}");
    }
    // The same gate the canvas's Terminal button is drawn behind.
    expect(app).toContain("onTerminal={stage.enabled ? stage.openFromButton : undefined}");
    // No second way: each Inspector is handed that one opener and no other.
    for (const m of mounts) expect(m.match(/onOpenSession=/g)).toHaveLength(1);
  });

  it("goes straight through the frame to the row, which calls it with the session's id and nothing else", () => {
    expect(aside).toContain("onOpenSession={onOpenSession}");
    expect(aside).toContain("stageSession={stageSession}");
    expect(detail.match(/onOpenSession\(/g)).toHaveLength(1);
    expect(detail).toContain("onClick={() => onOpenSession(agent.sessionId)}");
  });
});
