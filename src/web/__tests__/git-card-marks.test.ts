// The collision mark on a card: who a card shares its folder or branch with,
// which file another live agent also edited, how the other agent is named, and
// the row as the card draws it — absent, and the card unchanged, when there is
// nothing to say.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import { nodeDataFor } from "../canvas-flow";
import { cardMarks, type MarkAgent } from "../git-card-mark";
import { loadGitPrefs } from "../git-pref";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, GitCollisions, HookEnvelope, HookPayload } from "../types";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const UI = "cc150ea9-f70e-4728-9598-4d2a11dbad61";
const BUG = "d6a0523b-ce80-4aa7-8fe1-1831b1613893";
const API = "e3200d5a-11bf-41d8-9bc9-36c533ef1f4e";

const root = (sessionId: string, over: Partial<MarkAgent> = {}): MarkAgent => ({
  id: sessionId, sessionId, kind: "root", label: "web-app", state: "active", cwd: "/w/web-app",
  git: { state: "repo", topLevel: "/w/web-app", stale: 0 }, ...over,
});
const sub = (sessionId: string, key: string, over: Partial<MarkAgent> = {}): MarkAgent => ({
  id: `${sessionId}::${key}`, sessionId, kind: "subagent", label: "test-writer", state: "active", cwd: "/w/web-app", ...over,
});
const quietWith = (sessionId: string, reason: "same-worktree" | "same-branch" = "same-worktree", agentId: string | null = null): GitCollisions["quiet"][number] =>
  ({ agentId, with: { sessionId, agentId: null }, reason, branch: "feature/x" });
const sharpWith = (sessionId: string, files: string[], agentId: string | null = null, other: string | null = null): GitCollisions["sharp"][number] =>
  ({ agentId, with: { sessionId, agentId: other }, files });

describe("the quiet mark: two agents in one folder, or on one branch", () => {
  it("is on both cards, muted, naming the other session by the name the cluster header shows", () => {
    const marks = cardMarks([
      root(UI, { sessionName: "web-ui", gitCollisions: { quiet: [quietWith(BUG)], sharp: [] } }),
      root(BUG, { sessionName: "web-bugfix", gitCollisions: { quiet: [quietWith(UI)], sharp: [] } }),
    ]);
    expect(marks.get(UI)).toMatchObject({ level: "quiet", target: BUG, lead: "", said: "shares folder with web-bugfix", tail: "", session: false });
    expect(marks.get(BUG)).toMatchObject({ level: "quiet", target: UI, said: "shares folder with web-ui" });
    expect(marks.get(UI)!.title).toBe("shares folder with web-bugfix (/w/web-app).\nSelect web-bugfix.");
  });

  it("names a session with no name by its workspace, and by the id's tail when the workspace is this card's own", () => {
    const marks = cardMarks([
      root(UI, { gitCollisions: { quiet: [quietWith(BUG)], sharp: [] } }),
      root(BUG, { gitCollisions: { quiet: [quietWith(UI)], sharp: [] } }),
    ]);
    // The cluster headers read WEB-APP · AD61 and WEB-APP · 3893.
    expect(marks.get(UI)!.said).toBe("shares folder with web-app · 3893");
    expect(marks.get(BUG)!.said).toBe("shares folder with web-app · ad61");
  });

  it("says the same branch in another worktree in its own words", () => {
    const marks = cardMarks([
      root(UI, { gitCollisions: { quiet: [quietWith(API, "same-branch")], sharp: [] } }),
      root(API, { label: "shop-api-auth" }),
    ]);
    expect(marks.get(UI)).toMatchObject({ said: "same branch as shop-api-auth", words: "same branch as shop-api-auth" });
    expect(marks.get(UI)!.title).toContain("same branch as shop-api-auth, in another folder.");
  });

  it("counts the other agents it does not name, and names them all in the tooltip", () => {
    const marks = cardMarks([
      root(UI, { gitCollisions: { quiet: [quietWith(BUG), quietWith(API)], sharp: [] } }),
      root(BUG, { sessionName: "web-bugfix" }),
      root(API, { sessionName: "docs-pass" }),
    ]);
    expect(marks.get(UI)).toMatchObject({ said: "shares folder with web-bugfix", tail: "+1" });
    expect(marks.get(UI)!.title).toContain("shares folder with docs-pass (/w/web-app).");
  });

  it("puts nothing on a card nobody collides with, nor between a session and its own subagent", () => {
    // shop-api-auth: the main card and test-writer share a folder by design,
    // and the server never pairs them.
    const marks = cardMarks([root(API, { label: "shop-api-auth" }), sub(API, "a4f1c9e27b3d5086")]);
    expect(marks.size).toBe(0);
    expect(cardMarks([root(API, { gitCollisions: { quiet: [], sharp: [] } }), sub(API, "a4f1")]).size).toBe(0);
  });

  it("keeps a mark that says the same thing as the last board's, so the card does not redraw for it", () => {
    const board = [root(UI, { gitCollisions: { quiet: [quietWith(BUG)], sharp: [] } }), root(BUG)];
    const first = cardMarks(board);
    const again = cardMarks(board.map(a => ({ ...a })), first);
    expect(again.get(UI)).toBe(first.get(UI));
    const moved = cardMarks([board[0], root(BUG, { sessionName: "web-bugfix" })], first);
    expect(moved.get(UI)).not.toBe(first.get(UI));
  });
});

describe("the sharp mark: the same file, edited by two live agents since it was last committed", () => {
  it("names the file first and the other agent after it, on both cards, with the path in the tooltip", () => {
    const marks = cardMarks([
      root(UI, { sessionName: "web-ui", gitCollisions: { quiet: [quietWith(BUG)], sharp: [sharpWith(BUG, ["src/app.ts"])] } }),
      root(BUG, { sessionName: "web-bugfix", gitCollisions: { quiet: [quietWith(UI)], sharp: [sharpWith(UI, ["src/app.ts"])] } }),
    ]);
    // Sharp wins the row; the quiet entry for the same agent says nothing more.
    expect(marks.get(UI)).toMatchObject({ level: "sharp", target: BUG, lead: "app.ts", said: "also edited by web-bugfix", tail: "", session: false });
    expect(marks.get(UI)!.words).toBe("src/app.ts also edited by web-bugfix");
    expect(marks.get(UI)!.title).toBe("src/app.ts also edited by web-bugfix since it was last committed.\nBoth are running.\nSelect web-bugfix.");
    expect(marks.get(BUG)).toMatchObject({ level: "sharp", target: UI, said: "also edited by web-ui" });
  });

  it("counts several files and lists them in the tooltip", () => {
    const marks = cardMarks([
      root(UI, { gitCollisions: { quiet: [], sharp: [sharpWith(BUG, ["src/app.ts", "src/format.ts"])] } }),
      root(BUG, { sessionName: "web-bugfix" }),
    ]);
    expect(marks.get(UI)).toMatchObject({ lead: "2 files", said: "also edited by web-bugfix", words: "2 files also edited by web-bugfix" });
    expect(marks.get(UI)!.title).toContain("2 files (src/app.ts, src/format.ts) also edited by web-bugfix since they were last committed.");
  });

  it("counts the other agents, and keeps a quiet one it does not cover in the tooltip", () => {
    const marks = cardMarks([
      root(UI, { gitCollisions: { quiet: [quietWith(API, "same-branch")], sharp: [sharpWith(BUG, ["src/app.ts"]), sharpWith(API, ["src/app.ts"])] } }),
      root(BUG, { sessionName: "web-bugfix" }),
      root(API, { sessionName: "rate-review" }),
    ]);
    expect(marks.get(UI)).toMatchObject({ level: "sharp", lead: "app.ts", said: "also edited by web-bugfix", tail: "+1" });
    expect(marks.get(UI)!.title).toContain("src/app.ts also edited by rate-review since it was last committed.");
    expect(marks.get(UI)!.title).toContain("All of them are running.");
    const quietOnly = cardMarks([
      root(UI, { gitCollisions: { quiet: [quietWith(API, "same-branch")], sharp: [sharpWith(BUG, ["src/app.ts"])] } }),
      root(BUG, { sessionName: "web-bugfix" }), root(API, { sessionName: "rate-review" }),
    ]);
    expect(quietOnly.get(UI)!.tail).toBe("");
    expect(quietOnly.get(UI)!.title).toContain("Also same branch as rate-review, in another folder.");
  });

  it("starts its tooltip from the row's own words, so a row cut short is whole there", () => {
    const marks = cardMarks([
      root(UI, { gitCollisions: { quiet: [], sharp: [sharpWith(BUG, ["src/components/InvoicePreviewComponent.test.tsx"])] } }),
      root(BUG, { sessionName: "account-management-oauth-flow" }),
    ]);
    const m = marks.get(UI)!;
    expect(m.title.split("\n")[0]).toContain(`${m.lead}`);
    expect(m.title.split("\n")[0]).toContain(m.said);
  });

  it("names another session's subagent with ↳, and goes to its card", () => {
    const marks = cardMarks([
      root(UI, { gitCollisions: { quiet: [], sharp: [sharpWith(API, ["src/app.ts"], null, "ag7")] } }),
      root(API, { label: "shop-api-auth" }),
      sub(API, "ag7", { label: "docs-sync" }),
    ]);
    expect(marks.get(UI)).toMatchObject({ said: "also edited by ↳ docs-sync", target: `${API}::ag7` });
  });

  it("is on a subagent's card for the files that subagent edited itself", () => {
    const marks = cardMarks([
      root(UI, { gitCollisions: { quiet: [], sharp: [sharpWith(BUG, ["src/app.ts"], "ag1")] } }),
      sub(UI, "ag1"),
      root(BUG, { sessionName: "web-bugfix" }),
    ]);
    expect(marks.get(`${UI}::ag1`)).toMatchObject({ level: "sharp", lead: "app.ts", said: "also edited by web-bugfix", session: false, tail: "" });
    // The main card speaks for the whole team, as the git view from it does.
    expect(marks.get(UI)).toMatchObject({ level: "sharp", lead: "app.ts" });
  });

  it("says · in this session on a running subagent in the session's folder that did not edit the file", () => {
    const team = { quiet: [quietWith(BUG)], sharp: [sharpWith(BUG, ["src/app.ts"])] };
    const marks = cardMarks([root(UI, { gitCollisions: team }), sub(UI, "ag1"), root(BUG, { sessionName: "web-bugfix" })]);
    expect(marks.get(`${UI}::ag1`)).toMatchObject({ level: "sharp", lead: "app.ts", said: "also edited by web-bugfix", tail: "· in this session", session: true });
    expect(marks.get(`${UI}::ag1`)!.words).toBe("src/app.ts also edited by web-bugfix in this session");
    expect(marks.get(`${UI}::ag1`)!.title).toContain("In this session, not in this subagent's own files.");
    // Not for a quiet one alone: the session's own card already says that.
    expect(cardMarks([root(UI, { gitCollisions: { quiet: [quietWith(BUG)], sharp: [] } }), sub(UI, "ag1"), root(BUG)]).has(`${UI}::ag1`)).toBe(false);
    // Not once it has finished, nor from a folder of its own.
    expect(cardMarks([root(UI, { gitCollisions: team }), sub(UI, "ag1", { state: "done" }), root(BUG)]).has(`${UI}::ag1`)).toBe(false);
    const elsewhere = sub(UI, "ag1", { cwd: "/w/web-app-docs", git: { state: "repo", topLevel: "/w/web-app-docs", stale: 0 } });
    expect(cardMarks([root(UI, { gitCollisions: team }), elsewhere, root(BUG)]).has(`${UI}::ag1`)).toBe(false);
  });
});

// ---------------------------------------------------------------- the card

const T0 = 1_700_000_000_000;
let seq = 0;
const send = (s: GraphState, payload: HookPayload, at = T0) =>
  applyEvent(s, { seq: ++seq, receivedAt: at, source: "hook", payload } as HookEnvelope);

/** The web-app pair from the fixture, on a board, with the collisions given. */
function webApp(ui?: GitCollisions, bug?: GitCollisions): GraphState {
  let s = initialState();
  s = send(s, { hook_event_name: "SessionStart", session_id: UI, cwd: "/w/web-app" });
  s = send(s, { hook_event_name: "SessionStart", session_id: BUG, cwd: "/w/web-app" });
  s = send(s, { hook_event_name: "SubagentStart", session_id: UI, cwd: "/w/web-app", agent_id: "ag1", agent_type: "test-writer" });
  s.agents.get(UI)!.sessionName = "web-ui";
  s.agents.get(BUG)!.sessionName = "web-bugfix";
  if (ui) s = send(s, { hook_event_name: "GitCollisions", session_id: UI, collisions: ui } as HookPayload);
  if (bug) s = send(s, { hook_event_name: "GitCollisions", session_id: BUG, collisions: bug } as HookPayload);
  return s;
}

/** A card as the canvas draws it, from the canvas's own node data. */
function card(s: GraphState, id: string): string {
  const data = nodeDataFor(s, () => {})(s.agents.get(id)!);
  return renderToStaticMarkup(createElement(ReactFlowProvider, null,
    createElement(AgentNode as never, { id, data, selected: false })));
}
const markRow = (html: string) => /<button[^>]*class="git-mark[^"]*"[\s\S]*?<\/button>/.exec(html)?.[0] ?? null;

describe("the quiet mark on the card", () => {
  const quiet = (other: string): GitCollisions => ({ quiet: [quietWith(other)], sharp: [] });

  it("is a button under the session's name, with the whole sentence in its tooltip", () => {
    const html = card(webApp(quiet(BUG), quiet(UI)), UI);
    const row = markRow(html)!;
    expect(row).toContain('data-level="quiet"');
    expect(row).toContain('type="button"');
    expect(row).toContain("shares folder with web-bugfix");
    expect(row).toContain('title="shares folder with web-bugfix (/w/web-app).\nSelect web-bugfix."');
    // Under the session-name row and above the activity chart.
    expect(html.indexOf("git-mark")).toBeGreaterThan(html.indexOf('class="session-name"'));
    expect(html.indexOf("git-mark")).toBeLessThan(html.indexOf('class="meta"'));
  });

  it("draws nothing at all on a card with no collision, so its rows and height are what they were", () => {
    const before = card(webApp(), UI);
    expect(before).not.toContain("git-mark");
    const after = card(webApp(quiet(BUG)), BUG);
    expect(after).not.toContain("git-mark");
  });

  it("is gone with every other git mark while Appearance › Git is off", () => {
    loadGitPrefs({ prefs: { git: false } });
    try {
      expect(card(webApp(quiet(BUG)), UI)).not.toContain("git-mark");
    } finally {
      loadGitPrefs({ prefs: { git: true } });
    }
  });

  it("rides on the canvas's node data, built once per board revision", () => {
    const s = webApp(quiet(BUG));
    const data = nodeDataFor(s, () => {})(s.agents.get(UI)!) as AgentNodeData & { gitMark?: { said: string } };
    expect(data.gitMark?.said).toBe("shares folder with web-bugfix");
    expect(sourceOf("canvas-flow.ts")).toMatch(/marks: cardMarks\(state\.agents\.values\(\), entry\?\.marks\)/);
  });
});

describe("the sharp mark on the card", () => {
  const sharp = (other: string, files = ["src/app.ts"]): GitCollisions => ({ quiet: [quietWith(other)], sharp: [sharpWith(other, files)] });

  it("leads with the clash glyph, named in words, then the file and the agent", () => {
    const row = markRow(card(webApp(sharp(BUG), sharp(UI)), UI))!;
    expect(row).toContain('data-level="sharp"');
    expect(row).toMatch(/<span class="git-mark-glyph" role="img" aria-label="same file"><svg[^>]*aria-hidden="true"/);
    // The glyph is two arrows meeting at a bar, never a close ×.
    expect(row).toContain('d="M7 2.6v8.8M1.4 7h3.4M3.4 5 5.2 7 3.4 9M12.6 7H9.2M10.6 5 8.8 7l1.8 2"');
    expect(row).toMatch(/<b class="git-mark-lead">app\.ts<\/b><span class="git-mark-said">also edited by web-bugfix<\/span>/);
    expect(row).not.toContain("git-mark-tail");
  });

  it("dashes its edge and keeps its tail on a subagent that only shares the danger with its session", () => {
    const row = markRow(card(webApp(sharp(BUG)), `${UI}::ag1`))!;
    expect(row).toContain("data-session");
    expect(row).toContain('<span class="git-mark-tail">· in this session</span>');
  });

  it("tells a screen reader about a card's own sharp collision in the card's name, at every zoom", async () => {
    const { agentAriaLabel } = await import("../agent-copy");
    const s = webApp(sharp(BUG));
    const a = s.agents.get(UI)!;
    expect(agentAriaLabel(a, T0, false, "src/app.ts also edited by web-bugfix")).toMatch(/^web-app, session, live, src\/app\.ts also edited by web-bugfix, /);
    expect(agentAriaLabel(a, T0, false)).not.toContain("also edited");
    expect(sourceOf("canvas-flow.ts")).toMatch(/agentAriaLabel\(a, now, selectedIds\.has\(a\.id\), gitWords\(dataFor\(a\)\)\)/);
  });
});

describe("the mark's look", () => {
  const css = sheetText();
  const rule = (sel: string) => {
    const at = css.indexOf(`\n${sel} {`);
    expect(at, sel).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };

  it("is muted, with no edge and no wash, and lights its words only under the pointer", () => {
    const q = rule('.agent-node .git-mark[data-level="quiet"]');
    expect(q).toContain("color: var(--muted)");
    expect(q).not.toMatch(/background|border-color|--warn|--err/);
    expect(css).toMatch(/\.agent-node \.git-mark\[data-level="quiet"\]:hover \{ color: var\(--text\); \}/);
    expect(rule(".agent-node .git-mark")).toMatch(/transition: background-color 120ms ease, color 120ms ease, transform 120ms ease;/);
  });

  it("never widens the card it is on: the sentence gives way inside the room the card already has", () => {
    const base = rule(".agent-node .git-mark");
    expect(base).toContain("contain: inline-size");
    expect(base).toContain("width: 100%");
    expect(rule(".agent-node .git-mark-said")).toMatch(/text-overflow: ellipsis/);
  });

  it("presses like every labelled control, and the press stands still under reduced motion", () => {
    expect(css).toContain(".agent-node .git-mark:active { transform: scale(0.97); }");
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.agent-node \.git-mark:active[\s\S]*?\{ transform: none; \}/.exec(css);
    expect(reduced).not.toBeNull();
  });

  it("draws sharp in the error colour on an edge — never amber, which is for waiting on you", () => {
    const sh = rule('.agent-node .git-mark[data-level="sharp"]');
    expect(sh).toContain("color: var(--err)");
    expect(sh).toContain("border-color: color-mix(in srgb, var(--err) 70%, transparent)");
    expect(css.slice(css.indexOf("THE COLLISION MARK"), css.indexOf("THE COLLISION MARK") + 6000)).not.toContain("--warn");
    expect(css).toMatch(/\.agent-node \.git-mark\[data-level="sharp"\]:hover \{ background: color-mix\(in srgb, var\(--err\) 9%, transparent\); \}/);
    expect(css).toContain('.agent-node .git-mark[data-session] { border-style: dashed; }');
  });

  it("keeps its edge under a Windows contrast theme", () => {
    expect(/@media \(forced-colors: active\) \{[\s\S]*?\.agent-node \.git-mark\[data-level="sharp"\][^{]*\{ border-color: CanvasText; \}/.test(css)).toBe(true);
  });
});

