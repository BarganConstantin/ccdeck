// The collision mark on a card: who a card shares its folder or branch with,
// which file another live agent also edited, how the other agent is named, and
// the row as the card draws it — absent, and the card unchanged, when there is
// nothing to say.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import { nodeDataFor } from "../canvas-flow";
import { FLASH_ATTR, flashCard } from "../card-flash";
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

  it("names a session with no name beside a named one in its workspace by the id's tail, as its cluster header does", () => {
    // api-fix (named) and an unnamed session, both in shop-api-auth: every
    // card on the board is titled shop-api-auth, so the bare label would read
    // as the card colliding with itself.
    const marks = cardMarks([
      root(API, { label: "shop-api-auth", sessionName: "api-fix", gitCollisions: { quiet: [], sharp: [sharpWith(UI, ["src/auth/session.ts"])] } }),
      root(UI, { label: "shop-api-auth", gitCollisions: { quiet: [], sharp: [sharpWith(API, ["src/auth/session.ts"])] } }),
    ]);
    expect(marks.get(API)!.said).toBe("also edited by shop-api-auth · ad61");
    expect(marks.get(API)!.title).toContain("Select shop-api-auth · ad61.");
    expect(marks.get(UI)!.said).toBe("also edited by api-fix");
  });

  it("tells two subagents of one type apart where it names them", () => {
    const team: GitCollisions = { quiet: [], sharp: [sharpWith(API, ["README.md"], "b0000000000gp001", "b0000000000gp002"), sharpWith(API, ["README.md"], "b0000000000gp002", "b0000000000gp001")] };
    const marks = cardMarks([
      root(API, { label: "infra", gitCollisions: team }),
      sub(API, "b0000000000gp001", { label: "general-purpose" }),
      sub(API, "b0000000000gp002", { label: "general-purpose" }),
    ]);
    expect(marks.get(API)!.said).toBe("edited by ↳ general-purpose · p001 and ↳ general-purpose · p002");
    expect(marks.get(`${API}::b0000000000gp001`)!.said).toBe("also edited by ↳ general-purpose · p002");
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
    // Who still counts is the server's rule, never "running": a card whose
    // turn ended reads DONE while its session is still open.
    expect(marks.get(UI)!.title).toBe("src/app.ts also edited by web-bugfix since it was last committed.\nNeither has ended.\nSelect web-bugfix.");
    expect(marks.get(UI)!.title).not.toMatch(/running/);
    // The git view's collision line says it the same way.
    const line = sourceOf("components/GitViewParts.tsx");
    expect(line).not.toMatch(/are running/);
    // One sentence for every line the collision draws, wide and glance alike.
    expect(line).toMatch(/const ended = who\.length > 1 \? "None of them has ended\." : "Neither has ended\.";/);
    expect(line.match(/\$\{ended\}|\{ended\}/g)?.length).toBeGreaterThanOrEqual(3);
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
    expect(marks.get(UI)!.title).toContain("None of them has ended.");
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

describe("the main card speaks for its team without taking a teammate's collision as its own", () => {
  const TEAM = "ef0af835-d7df-4151-a311-6aea5eb3ecc2";
  const HOT = "933fc571-70f8-4e61-9e01-7de849629a07";
  const away = (key: string, label: string, folder: string) =>
    sub(TEAM, key, { label, cwd: folder, git: { state: "repo", topLevel: folder, stale: 0 } });

  it("names a subagent in a folder of its own in front of the agent it shares that folder with, and gives its folder", () => {
    // The session works in web-app; its subagent elsewhere-agent works in
    // shop-api, where develop-hotfix is. web-ui shares web-app with the session.
    const team: GitCollisions = {
      quiet: [quietWith(HOT, "same-worktree", "else3"), quietWith(UI)],
      sharp: [],
    };
    const marks = cardMarks([
      root(TEAM, { gitCollisions: team }),
      away("else3", "elsewhere-agent", "/w/shop-api"),
      root(HOT, { sessionName: "develop-hotfix", label: "shop-api", cwd: "/w/shop-api", git: { state: "repo", topLevel: "/w/shop-api", stale: 0 } }),
      root(UI, { sessionName: "web-ui" }),
    ]);
    const m = marks.get(TEAM)!;
    // Its own neighbour leads the row.
    expect(m).toMatchObject({ level: "quiet", said: "shares folder with web-ui", tail: "+1", target: UI });
    expect(m.title).toBe([
      "shares folder with web-ui (/w/web-app).",
      "↳ elsewhere-agent shares folder with develop-hotfix (/w/shop-api).",
      "Select web-ui.",
    ].join("\n"));
    expect(m.title).not.toMatch(/develop-hotfix \(\/w\/web-app\)/);
    // The subagent's own card says it as its own, with its own folder.
    expect(marks.get(`${TEAM}::else3`)).toMatchObject({ said: "shares folder with develop-hotfix", target: HOT });
    expect(marks.get(`${TEAM}::else3`)!.title).toContain("(/w/shop-api)");
  });

  it("leads with the teammate when that is all there is, and still goes to the other agent", () => {
    const marks = cardMarks([
      root(TEAM, { gitCollisions: { quiet: [quietWith(HOT, "same-worktree", "else3")], sharp: [] } }),
      away("else3", "elsewhere-agent", "/w/shop-api"),
      root(HOT, { sessionName: "develop-hotfix" }),
    ]);
    expect(marks.get(TEAM)).toMatchObject({
      level: "quiet", said: "↳ elsewhere-agent shares folder with develop-hotfix", target: HOT,
      words: "↳ elsewhere-agent shares folder with develop-hotfix",
    });
    const branch = cardMarks([
      root(TEAM, { gitCollisions: { quiet: [quietWith(HOT, "same-branch", "else3")], sharp: [] } }),
      away("else3", "elsewhere-agent", "/w/shop-api-2"),
      root(HOT, { sessionName: "develop-hotfix" }),
    ]);
    expect(branch.get(TEAM)!.said).toBe("↳ elsewhere-agent on the same branch as develop-hotfix");
    expect(branch.get(TEAM)!.title).toContain("↳ elsewhere-agent on the same branch as develop-hotfix, in another folder.");
  });

  it("names both sides of a sharp one a teammate in another folder has, with that folder", () => {
    const marks = cardMarks([
      root(TEAM, { gitCollisions: { quiet: [], sharp: [sharpWith(HOT, ["src/money.ts"], "else3")] } }),
      away("else3", "elsewhere-agent", "/w/shop-api"),
      root(HOT, { sessionName: "develop-hotfix" }),
    ]);
    expect(marks.get(TEAM)).toMatchObject({ level: "sharp", lead: "money.ts", said: "edited by ↳ elsewhere-agent and develop-hotfix", target: HOT });
    expect(marks.get(TEAM)!.title.split("\n")[0])
      .toBe("src/money.ts edited by both ↳ elsewhere-agent and develop-hotfix since it was last committed, in /w/shop-api.");
  });

  it("keeps a subagent in the session's own folder speaking as the team", () => {
    const marks = cardMarks([
      root(UI, { gitCollisions: { quiet: [], sharp: [sharpWith(BUG, ["src/app.ts"], "ag1")] } }),
      sub(UI, "ag1"),
      root(BUG, { sessionName: "web-bugfix" }),
    ]);
    expect(marks.get(UI)).toMatchObject({ said: "also edited by web-bugfix" });
  });

  it("says two of its own subagents on one file once, naming both, and goes to the first", () => {
    // The server sends the pair from each side.
    const team: GitCollisions = {
      quiet: [],
      sharp: [sharpWith(TEAM, ["src/team-shared.ts"], "wr001", "wr002"), sharpWith(TEAM, ["src/team-shared.ts"], "wr002", "wr001")],
    };
    const marks = cardMarks([
      root(TEAM, { gitCollisions: team }),
      sub(TEAM, "wr001", { label: "writer-one" }),
      sub(TEAM, "wr002", { label: "writer-two" }),
    ]);
    const m = marks.get(TEAM)!;
    expect(m).toMatchObject({
      level: "sharp", lead: "team-shared.ts", said: "edited by ↳ writer-one and ↳ writer-two", tail: "", target: `${TEAM}::wr001`,
      words: "src/team-shared.ts edited by ↳ writer-one and ↳ writer-two",
    });
    expect(m.title).toBe([
      "src/team-shared.ts edited by both ↳ writer-one and ↳ writer-two since it was last committed.",
      "Neither has ended.",
      "Select ↳ writer-one.",
    ].join("\n"));
    expect(m.title).not.toContain("also edited");
    // Each subagent's own card names the other one.
    expect(marks.get(`${TEAM}::wr001`)).toMatchObject({ said: "also edited by ↳ writer-two", target: `${TEAM}::wr002` });
    expect(marks.get(`${TEAM}::wr002`)).toMatchObject({ said: "also edited by ↳ writer-one", target: `${TEAM}::wr001` });
  });

  it("does not hand a teammate's collision in another folder to a subagent of the session's folder", () => {
    const team: GitCollisions = { quiet: [], sharp: [sharpWith(HOT, ["src/money.ts"], "else3")] };
    const marks = cardMarks([
      root(TEAM, { gitCollisions: team }),
      away("else3", "elsewhere-agent", "/w/shop-api"),
      sub(TEAM, "ag9", { label: "reader" }),
      root(HOT, { sessionName: "develop-hotfix" }),
    ]);
    expect(marks.has(`${TEAM}::ag9`)).toBe(false);
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
    expect(sourceOf("canvas-flow.ts")).toMatch(/agentAriaLabel\(dataFor\(a\), now, selectedIds\.has\(a\.id\), gitWords\(dataFor\(a\)\)\)/);
  });
});

describe("the zoomed-out faces", () => {
  const sharp = (other: string): GitCollisions => ({ quiet: [quietWith(other)], sharp: [sharpWith(other, ["src/app.ts"])] });
  const face = (html: string) => html.slice(html.indexOf('class="lod-face"'));

  it("keep a small error mark for a card's own sharp collision, with its words on hover", () => {
    const f = face(card(webApp(sharp(BUG)), UI));
    expect(f).toMatch(/<span class="lod-clash" title="src\/app\.ts also edited by web-bugfix"><svg[^>]*aria-hidden="true"/);
    expect(f).toContain('<span class="lod-clash-word">same file</span>');
    // On the name's line, after it.
    expect(f.indexOf("lod-clash")).toBeGreaterThan(f.indexOf('class="lod-name"'));
    expect(f.indexOf("lod-clash")).toBeLessThan(f.indexOf("</div>"));
  });

  it("keep nothing for a quiet one, nor for a subagent that only shares its session's", () => {
    expect(face(card(webApp({ quiet: [quietWith(BUG)], sharp: [] }), UI))).not.toContain("lod-clash");
    expect(face(card(webApp(sharp(BUG)), `${UI}::ag1`))).not.toContain("lod-clash");
    expect(face(card(webApp(), UI))).not.toContain("lod-clash");
  });

  it("say \"same file\" only where the face has room, and centre the mark alone on the narrowest", () => {
    const css = sheetText();
    expect(css).toMatch(/\.lod-clash \{[^}]*color: var\(--err\);[^}]*margin-left: auto;/);
    expect(css).toContain(".lod-clash-word { display: none; }");
    expect(css).toMatch(/@container lod \(min-width: 130px\) \{\s*\.lod-clash-word \{ display: inline; \}\s*\}/);
    const narrow = /@container lod \(max-width: 72px\) \{[^@]*\}/.exec(css)![0];
    expect(narrow).toMatch(/\.alert-mark,\s*\.lod-clash \{ margin-left: 0; \}/);
  });
});

describe("a press on the mark", () => {
  const row = sourceOf("components/GitCardMark.tsx");
  const press = row.slice(row.indexOf("onClick={e => {"), row.indexOf("onDoubleClick"));

  it("is the mark's own: it selects the other agent and brings it into the uncovered pane, not this card", () => {
    expect(press).toMatch(/e\.stopPropagation\(\);/);
    expect(press).toMatch(/goToAgentCard\(target, pressHow\(e\)\);/);
    expect(sourceOf("agent-goto.ts")).toMatch(/focusAgentFrom\(target\);/);
    // The page's focuser selects, then frames the card with focus-camera.ts
    // against the panels and the open git view.
    expect(sourceOf("App.tsx")).toMatch(/setGitAgentFocuser\(id => \{ selectAgent\(id, false\); window\.requestAnimationFrame\(\(\) => focusAgent\(id\)\); \}\)/);
    expect(sourceOf("use-agent-focus.ts")).toMatch(/right: Math\.max\(railInsetRef\.current, gitViewCover\(\)\) \+ 32/);
  });

  it("lights the other card once after a pointer press, and moves the keyboard onto it after a key press", () => {
    // One way to another agent's card for every git surface (agent-goto.ts).
    const goto = sourceOf("agent-goto.ts");
    expect(goto).toMatch(/if \(how === "key"\) requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => focusCanvasNode\(target\)\)\);\s*else requestAnimationFrame\(\(\) => flashCard\(target\)\);/);
    expect(goto).toMatch(/e\.detail === 0 \? "key" : "pointer"/);
    expect(row).not.toMatch(/Notification|notify|chime|sound|Audio/i);
  });

  it("is a real button in the card's tab order, with the deck's ring", () => {
    expect(row).toMatch(/<button[\s\S]*?type="button"[\s\S]*?className="git-mark"/);
    const css = sheetText();
    // No rule takes the ring away or recolours it.
    expect(css).not.toMatch(/\.git-mark:focus-visible \{[^}]*outline: none/);
    expect(css).not.toMatch(/\.git-mark[^{]*:focus[^{]*\{[^}]*outline-color/);
  });
});

describe("the flash", () => {
  type Listener = (e: { animationName: string }) => void;
  const g = globalThis as unknown as { document?: unknown; CSS?: unknown };
  const saved = { document: g.document, CSS: g.CSS };
  afterEach(() => { g.document = saved.document; g.CSS = saved.CSS; });

  function fakeNode() {
    const attrs = new Map<string, string>();
    const listeners = new Set<Listener>();
    let reads = 0;
    const node = {
      setAttribute: (k: string, v: string) => { attrs.set(k, v); },
      removeAttribute: (k: string) => { attrs.delete(k); },
      get offsetWidth() { reads++; return 260; },
      addEventListener: (_: string, l: Listener) => { listeners.add(l); },
      removeEventListener: (_: string, l: Listener) => { listeners.delete(l); },
    };
    return { node, attrs, listeners, reads: () => reads, end: (animationName: string) => { for (const l of [...listeners]) l({ animationName }); } };
  }

  it("marks the card's wrapper and lets go when the halo's animation ends", () => {
    const f = fakeNode();
    let asked = "";
    g.CSS = { escape: (s: string) => s };
    g.document = { querySelector: (sel: string) => { asked = sel; return f.node; } };
    flashCard("s1::ag1");
    expect(asked).toBe('.react-flow__node[data-id="s1::ag1"]');
    expect(f.attrs.has(FLASH_ATTR)).toBe(true);
    expect(f.reads()).toBe(1);
    f.end("git-mark-in");
    expect(f.attrs.has(FLASH_ATTR)).toBe(true);
    f.end("card-flash-face");
    expect(f.attrs.has(FLASH_ATTR)).toBe(false);
    expect(f.listeners.size).toBe(0);
  });

  it("does nothing for a card that is not on the canvas", () => {
    g.CSS = { escape: (s: string) => s };
    g.document = { querySelector: () => null };
    expect(() => flashCard("gone")).not.toThrow();
  });

  it("is a halo in the session's colour, held while the camera arrives, on the face when zoomed out, and on-then-off under reduced motion", () => {
    const css = sheetText();
    expect(css).toContain(".react-flow__node[data-flash] .agent-node { animation: card-flash 1.4s cubic-bezier(0.23, 1, 0.32, 1); }");
    expect(css).toContain(".react-flow__node[data-flash] .lod-face { animation: card-flash-face 1.4s cubic-bezier(0.23, 1, 0.32, 1); }");
    expect(css).toMatch(/@keyframes card-flash \{\s*0%, 40% \{ box-shadow: 0 0 0 8px color-mix\(in srgb, var\(--accent\) 40%, transparent\)/);
    expect(css).toMatch(/\.canvas-wrap\[data-lod="compact"\] \.react-flow__node\[data-flash\] \.agent-node,\s*\.canvas-wrap\[data-lod="overview"\] \.react-flow__node\[data-flash\] \.agent-node \{ animation: none; \}/);
    expect(css).toContain(".react-flow__node[data-flash] .agent-node { animation: card-flash 1.4s step-end; }");
    expect(css).toContain(".react-flow__node[data-flash] .lod-face { animation: card-flash-face 1.4s step-end; }");
  });
});

describe("marks that come and go", () => {
  const row = sourceOf("components/GitCardMark.tsx");
  const css = sheetText();

  it("are always asked for, so a mark that stops being true can fade before its row goes", () => {
    expect(sourceOf("components/AgentNode.tsx")).toContain("<GitMarkRow mark={gitMark} agentId={data.id} />");
    expect(row).toContain("const shown = mark ?? last;");
    expect(row).toContain("const leaving = mark == null && last != null;");
    expect(row).toMatch(/onAnimationEnd=\{e => \{ if \(leaving && e\.animationName === "git-mark-out"\) setLast\(null\); \}\}/);
  });

  it("take a leaving row out of the tab order and the accessibility tree, and give the keyboard to the card", () => {
    expect(row).toMatch(/tabIndex=\{leaving \? -1 : undefined\}/);
    expect(row).toMatch(/aria-hidden=\{leaving \? true : undefined\}/);
    expect(row).toMatch(/if \(leaving && ref\.current != null && ref\.current === document\.activeElement\) focusCanvasNode\(agentId\);/);
    expect(css).toMatch(/\.agent-node \.git-mark\[data-leaving\] \{\s*pointer-events: none;/);
  });

  it("keep the same button when sharp turns quiet or back, so a keyboard on it stays there, and fade the new words in", () => {
    // Remounting the button on a new level threw away the focused node and
    // left the keyboard on the page's body.
    expect(row).not.toMatch(/key=\{shown\.level\}/);
    expect(row).not.toMatch(/\bkey=/);
    const effect = row.slice(row.indexOf("useLayoutEffect(() => {"), row.indexOf("}, [level]);"));
    expect(effect).toMatch(/if \(was == null \|\| was === level\) return;/);
    expect(effect).toMatch(/\.getAnimations\(\)/);
    expect(effect).toMatch(/animationName === "git-mark-in"\) \{ an\.cancel\(\); an\.play\(\); \}/);
  });

  it("fade in and out in 150ms with no travel, and are simply there and gone under reduced motion", () => {
    expect(/\n\.agent-node \.git-mark \{[^}]*animation: git-mark-in 150ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both;/.test(css)).toBe(true);
    expect(css).toMatch(/\.agent-node \.git-mark\[data-leaving\] \{[^}]*animation: git-mark-out 150ms cubic-bezier\(0\.23, 1, 0\.32, 1\) forwards;/);
    expect(css).toContain("@keyframes git-mark-in { from { opacity: 0; } }");
    expect(css).toContain("@keyframes git-mark-out { to { opacity: 0; } }");
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.agent-node \.git-mark \{[^}]*\}[^}]*\}/.exec(css)![0];
    expect(reduced).toMatch(/\.agent-node \.git-mark \{[^}]*animation: none;/);
    expect(reduced).toContain(".agent-node .git-mark[data-leaving] { animation: git-mark-out 1ms linear forwards; }");
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

  it("lets the file's name give way after the sentence, so the tail never spills out of a narrow card", () => {
    // A 220px subagent card: glyph, three gaps, the name at up to half the
    // row and "+1 · in this session" did not fit, and the tail ran past the
    // card's edge. The sentence goes first, then the name down to a stub;
    // the tail never.
    const lead = rule(".agent-node .git-mark-lead");
    expect(lead).toContain("flex: 0 1 auto;");
    expect(lead).toContain("min-width: 4ch;");
    expect(lead).toMatch(/text-overflow: ellipsis/);
    expect(rule(".agent-node .git-mark-said")).toContain("flex: 0 1000 auto;");
    expect(css).toContain(".agent-node .git-mark-tail { flex: none; white-space: nowrap; }");
    // Nothing drawn past the row's own edge, whatever the words.
    expect(rule(".agent-node .git-mark")).toContain("overflow: hidden;");
  });

  it("keeps one gap between the file's name and the tail when the sentence between them gives way to nothing", () => {
    // The row's 6px gap sat on both sides of a sentence shrunk to no width:
    // 12px between the name and "· in this session". The sentence takes the
    // gap before it back and carries it inside, where it goes with the words.
    const said = rule(".agent-node .git-mark-said");
    expect(said).toContain("margin-left: -6px;");
    expect(rule(".agent-node .git-mark")).toContain("gap: 6px;");
    expect(css).toMatch(/\.agent-node \.git-mark-said::before \{ content: ""; display: inline-block; width: 6px; \}/);
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


describe("DESIGN.md's States table", () => {
  const design = readFileSync(fileURLToPath(new URL("../../../DESIGN.md", import.meta.url)), "utf8");
  const states = design.slice(design.indexOf("## States"), design.indexOf("## Motion"));
  const row = (state: string) => states.split("\n").find(l => l.startsWith(`| ${state} |`)) ?? "";

  it("gives every git state a row with a token, a mark and a word", () => {
    for (const [state, token, mark, word] of [
      ["Quiet collision", "`--muted`", "folder glyph", "`shares folder with web-bugfix`"],
      ["Sharp collision", "`--err`, never `--warn`", "clash glyph", "`same file`"],
      ["Detached HEAD", "`--muted`", "commit glyph", "`detached at 4e1b9c0`"],
      ["Commit seen by ccdeck", "lane's colour", "◆", "`seen by ccdeck`"],
      ["Commit known from its message", "lane's colour", "◇", "`from the commit message`"],
      ["No agent seen", "lane's colour", "○", "`no agent seen`"],
    ]) {
      const r = row(state);
      expect(r, state).not.toBe("");
      expect(r.split(" | ")).toHaveLength(5);
      for (const part of [token, mark, word]) expect(r, `${state}: ${part}`).toContain(part);
    }
    expect(row("No agent seen")).toContain('never "made by a human"');
  });
});
