// Which features got used today (feature-use.mjs, feature-use.ts): the page's
// beacon, the server's own routes, and what reaches the "active" report.
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error — plain JS module, no types
import { handleFeature, noteRouteFeature, routeFeature } from "../../server/feature-use.mjs";
// @ts-expect-error — plain JS module, no types
import { usageDay } from "../../server/usage-day.mjs";
import { noteFeature } from "../feature-use";
import { stepTerminalText } from "../terminal-text-size";

const today = () => usageDay.saved().current?.features ?? [];

function post(body: unknown) {
  const req = Readable.from([typeof body === "string" ? body : JSON.stringify(body)]);
  const res = {
    headersSent: false,
    status: 0,
    text: "",
    writeHead(status: number) { res.status = status; res.headersSent = true; },
    end(text: string) { res.text = text; },
  };
  return { req, res };
}

describe("POST /api/feature", () => {
  it("keeps a name off the list as used today", async () => {
    const { req, res } = post({ name: "usage-history" });
    await handleFeature(req, res);
    expect(res.status).toBe(200);
    expect(today()).toContain("usage-history");
  });

  it("refuses anything else, and keeps nothing of it", async () => {
    for (const body of [{ name: "/home/alice/secret" }, { name: 7 }, {}, "not json"]) {
      const { req, res } = post(body);
      await handleFeature(req, res);
      expect(res.status).toBe(400);
    }
    expect(today().join(" ")).not.toMatch(/alice|secret/);
  });
});

describe("the server's own routes", () => {
  it("count the actions somebody takes on purpose", () => {
    noteRouteFeature("POST", "/api/claude-accounts/switch");
    noteRouteFeature("POST", "/api/lan/invite");
    expect(today()).toEqual(expect.arrayContaining(["account-switch", "lan-pairing"]));
  });

  it("never count a read the page makes on its own", () => {
    const before = today().length;
    for (const path of ["/api/claude-accounts", "/api/quota", "/api/claude-fm", "/api/cswap-auto", "/api/lan"]) {
      noteRouteFeature("GET", path);
    }
    expect(today().length).toBe(before);
  });

  it("are noted past the deck's gates, and the page's route sits above the 404", () => {
    const src = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    const gates = src.indexOf("!OPEN_MUTATIONS.has(url.pathname) && !isAuthorizedMutation(req)");
    const noted = src.indexOf("noteRouteFeature(req.method, url.pathname);");
    const route = src.indexOf('url.pathname === "/api/feature"');
    const notFound = src.indexOf("AN UNMATCHED /api/ PATH IS A 404");
    expect(gates).toBeGreaterThan(0);
    expect(noted).toBeGreaterThan(gates);
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(notFound);
  });
});

describe("the page's beacon", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("says a name once a day, and again after a beacon that was not queued", () => {
    const sent: string[] = [];
    let queue = false;
    vi.stubGlobal("navigator", { sendBeacon: (url: string, body: string) => { sent.push(`${url} ${body}`); return queue; } });
    noteFeature("feedback");          // not queued: forgotten, so tried again
    queue = true;
    noteFeature("feedback");
    noteFeature("feedback");          // already said today
    expect(sent).toEqual([
      '/api/feature {"name":"feedback"}',
      '/api/feature {"name":"feedback"}',
    ]);
  });

  it("never uses fetch, so a panel's own requests stay its own", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", undefined);
    noteFeature("keyboard-help");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says the terminal's text size was changed on a press, and never the size", () => {
    const sent: string[] = [];
    vi.stubGlobal("navigator", { sendBeacon: (_url: string, body: string) => { sent.push(body); return true; } });
    stepTerminalText("larger");
    stepTerminalText("reset");
    expect(sent).toEqual(['{"name":"terminal-text-size"}']);
  });
});

// The features added after 4.3.0. Each is a fixed name, a yes for the day, and
// is said where the thing is done: the server's own routes for what passes one,
// the page's beacon for what reaches the session through its terminal instead.
describe("the features added after 4.3.0", () => {
  it("are the deck's own POST routes for a session started, reopened or renamed, Claude Code and Codex's accounts", () => {
    expect(Object.fromEntries([
      "/api/terminal/launch", "/api/terminal/adopt", "/api/session-name", "/api/claude-install", "/api/claude-settings",
      "/api/codex-profile-select", "/api/codex-profile-add", "/api/codex-profile-remove", "/api/codex-profile-rename",
      "/api/codex-profile-replace-login", "/api/codex-auto",
    ].map(path => [path, routeFeature("POST", path)]))).toEqual({
      "/api/terminal/launch": "session-launch",
      "/api/terminal/adopt": "session-reopen",
      "/api/session-name": "session-rename",
      "/api/claude-install": "claude-install",
      "/api/claude-settings": "claude-settings",
      "/api/codex-profile-select": "codex-account-switch",
      "/api/codex-profile-add": "codex-accounts-manage",
      "/api/codex-profile-remove": "codex-accounts-manage",
      "/api/codex-profile-rename": "codex-accounts-manage",
      "/api/codex-profile-replace-login": "codex-accounts-manage",
      "/api/codex-auto": "codex-auto-switch",
    });
  });

  it("never count a pane attaching by itself, or a read a panel makes on its own", () => {
    for (const [method, path] of [
      ["POST", "/api/terminal/open"], ["POST", "/api/terminal/claim"], ["GET", "/api/terminal/status"],
      ["GET", "/api/terminal/target"], ["GET", "/api/claude-settings"], ["GET", "/api/claude-install"],
      ["GET", "/api/codex-auto"], ["GET", "/api/codex-profiles"], ["GET", "/api/codex-profile-login-state"],
      ["POST", "/api/codex-profile-login-start"],
    ]) expect(routeFeature(method, path)).toBeUndefined();
  });

  it("count a Jira move, status change or comment by its shape, and nothing else under Jira's routes as a change", () => {
    for (const path of [
      "/api/integrations/jira/c-1/board/42/move",
      "/api/integrations/jira/c-1/issue/ABC-12/transitions",
      "/api/integrations/jira/c-1/issue/ABC-12/comment",
    ]) expect(routeFeature("POST", path)).toBe("jira-change");
    for (const [method, path] of [
      ["POST", "/api/integrations/jira/c-1/write-guard/acknowledge"],
      ["POST", "/api/integrations/jira/c-1/board/42/move/again"],
      ["POST", "/api/integrations/github/c-1/issue/ABC-12/comment"],
      ["POST", "/api/integrations/connections"],
    ]) expect(routeFeature(method, path)).toBeUndefined();
    // A read of the same issue is still the provider's panel read, nothing more.
    expect(routeFeature("GET", "/api/integrations/jira/c-1/issue/ABC-12/comment")).toBe("jira");
  });

  it("are names the page's beacon may say, and the server keeps", async () => {
    const page = [
      "quick-open", "workspace", "workspace-split", "terminal-pane", "chat", "codex-accounts-panel",
      "chat-reply", "chat-answer", "chat-decision", "chat-stop", "terminal-text-size", "tour-done", "tour-skipped",
    ];
    for (const name of page) {
      const { req, res } = post({ name });
      await handleFeature(req, res);
      expect(res.status).toBe(200);
    }
    expect(today()).toEqual(expect.arrayContaining(page));
  });

  it("are said where the page does each thing, and only once it is done", () => {
    const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    expect(src("../components/QuickOpen.tsx")).toContain('useFeatureUse("quick-open");');
    const app = src("../App.tsx");
    expect(app).toContain('useFeatureUse("workspace", inWorkspace && stage.workspaceOffered);');
    expect(app).toContain('useFeatureUse("workspace-split", inWorkspace && stage.workspaceOffered && paneCount(stage.split) > 1);');
    expect(src("../components/CodexAccountsPanel.tsx")).toContain('useFeatureUse("codex-accounts-panel", shown);');
    const stage = src("../components/terminal/TerminalStage.tsx");
    expect(stage).toContain('useFeatureUse("terminal-pane", p.show.kind !== "empty");');
    expect(stage).toContain('useFeatureUse("chat", chatOn);');
    // An answer, a reply or a Stop counts once the deck sent it, never on a refusal.
    expect(stage).toMatch(/const result = session\.sendPrompt\(text, key\);\s*if \(result === "sent"\) \{\s*setChatSent\(sent => sent \+ 1\);\s*noteFeature\("chat-reply"\);/);
    expect(stage).toMatch(/const result = await session\.sendAsk\(steps, key\);\s*if \(result === "sent" \|\| result === "partial"\) \{\s*setChatSent\(sent => sent \+ 1\);\s*noteFeature\("chat-answer"\);/);
    expect(stage).toMatch(/const result = await session\.sendAsk\(stopSteps\(\), key\);\s*if \(result === "sent" \|\| result === "partial"\) \{\s*setChatSent\(sent => sent \+ 1\);\s*noteFeature\("chat-stop"\);/);
    expect(stage).toContain('onSent: () => { setChatSent(sent => sent + 1); noteFeature("chat-decision"); },');
  });
});
