// What the page keeps of a session's /context snapshot, and how the Context
// tab draws it: a head line, one bar, a row per category with its share of the
// window, the deferred rows apart with a dash, "Since then" for what the
// session added after it, the lists behind disclosures and a foot that says how
// old it is. A session with no snapshot keeps the tab it had, plus one line
// saying how to get one; a Codex session keeps its tab unchanged.
// context-snapshot.test.ts pins the parse and the event.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Inspector from "../components/Inspector";
import { ContextView } from "../components/ContextModal";
import { INSPECTOR_TAB_KEY } from "../inspector-tab";
import { applyEvent, initialState, type GraphState } from "../reducer";
import {
  CATEGORY_KEYS, SINCE_FLOOR, categorySlug, isContextSnapshot, mcpGroups, mcpToolCount, mergeSnapshot, snapTokens, snapshotLayout,
} from "../context-snapshot";
import { contextFill } from "../context-figure";
import { en } from "../i18n/en";
import type { AgentNodeData, ContextBreakdown, ContextSnapshot, HookEnvelope, HookPayload } from "../types";
import { sheetText } from "./sheet-source";
import { WEB_DIR } from "./client-source";
import { nowAt } from "../use-now";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The snapshot the parser makes of a real bounded /context (see the fixture
 *  in context-snapshot.test.ts): MCP tools deferred, every list present. */
function snapshot(over: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    at: iso(Date.now() - 3 * MIN),
    model: "claude-opus-4-7[1m]",
    used: 113_600, max: 600_000, pct: 19, estimated: false,
    categories: [
      { name: "System prompt", tokens: 5000, pct: 0.8, deferred: false },
      { name: "System tools", tokens: 16_100, pct: 2.7, deferred: false },
      { name: "System tools (deferred)", tokens: 26_400, pct: 4.4, deferred: true },
      { name: "MCP tools (deferred)", tokens: 66_900, pct: 11.2, deferred: true },
      { name: "MCP server instructions", tokens: 1700, pct: 0.3, deferred: false },
      { name: "Custom agents", tokens: 3600, pct: 0.6, deferred: false },
      { name: "Memory files", tokens: 26_900, pct: 4.5, deferred: false },
      { name: "Skills", tokens: 10_000, pct: 1.7, deferred: false },
      { name: "Messages", tokens: 35_700, pct: 5.9, deferred: false },
    ],
    free: 453_400,
    buffer: { name: "Autocompact buffer", tokens: 33_000 },
    mcpTools: [
      { name: "mcp__figma__get_screenshot", server: "figma", tokens: 2400 },
      { name: "mcp__github__create_issue", server: "github", tokens: 1200 },
      { name: "mcp__github__get_issue", server: "github", tokens: 800 },
    ],
    mcpServers: [{ server: "github", tools: 40, tokens: 30_100 }, { server: "slack", tools: 12, tokens: 8400 }],
    agents: [{ type: "code-reviewer", source: "Project", tokens: 1100 }, { type: "planner", source: "User", tokens: 900 }],
    memory: [{ type: "Project", path: "/work/shop/CLAUDE.md", tokens: 14_500 }, { type: "User", path: "/home/me/.claude/CLAUDE.md", tokens: 12_400 }],
    skills: [{ name: "pdf", source: "Plugin (anthropic-skills)", tokens: 120 }],
    more: { agents: { count: 8, tokens: 1600 }, skills: { count: 40, tokens: 9800 } },
    ...over,
  };
}

const ctx = (over: Partial<ContextBreakdown> = {}): ContextBreakdown => ({
  msgsUser: 3, msgsAssistant: 3, toolUses: 2, toolResults: 2, systemReminders: 0, currentContextTokens: 113_600, memoryFiles: [], ...over,
});

// ─── What the page keeps ────────────────────────────────────────────────────

let seq = 0;
const apply = (state: GraphState, payload: Record<string, unknown>) =>
  applyEvent(state, { seq: ++seq, receivedAt: 1000, payload: payload as HookPayload } as HookEnvelope);
const observed = (context: Record<string, unknown>) => ({ hook_event_name: "ContextObserved", session_id: "s1", context });
const card = () => {
  const s = initialState();
  apply(s, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/work/shop" });
  return s;
};
const kept = (s: GraphState) => s.agents.get("s1")!.context?.snapshot;

describe("the snapshot a session keeps", () => {
  it("lands with the counts, and stays through passes that do not carry it", () => {
    const s = card();
    apply(s, observed({ ...ctx(), snapshot: snapshot({ at: iso(1000) }) }));
    expect(kept(s)?.used).toBe(113_600);
    apply(s, observed({ msgsUser: 9, currentContextTokens: 140_000 }));
    expect(kept(s)?.at).toBe(iso(1000));
    expect(s.agents.get("s1")!.context!.msgsUser).toBe(9);
    // The context_tokens stamp on a hook payload keeps it as well.
    apply(s, { hook_event_name: "Stop", session_id: "s1", context_tokens: 150_000 });
    expect(kept(s)?.at).toBe(iso(1000));
  });

  it("is replaced by a newer one, never by an older one", () => {
    const s = card();
    apply(s, observed({ snapshot: snapshot({ at: iso(5000), used: 1 }) }));
    apply(s, observed({ snapshot: snapshot({ at: iso(9000), used: 2 }) }));
    expect(kept(s)?.used).toBe(2);
    apply(s, observed({ snapshot: snapshot({ at: iso(7000), used: 3 }) }));
    expect(kept(s)?.used).toBe(2);
  });

  it("is dropped by null, the server's word for a /clear or /compact after it", () => {
    const s = card();
    apply(s, observed({ snapshot: snapshot() }));
    apply(s, observed({ snapshot: null }));
    expect(kept(s)).toBeUndefined();
    expect(s.agents.get("s1")!.context!.msgsUser).toBe(0);
  });

  it("ignores a snapshot it cannot draw", () => {
    const s = card();
    apply(s, observed({ snapshot: snapshot({ at: iso(1000) }) }));
    for (const junk of [{}, { used: 5, max: 0, categories: [] }, { used: "5", max: 10, categories: [] }, [], "x", 7]) {
      apply(s, observed({ snapshot: junk }));
      expect(kept(s)?.at).toBe(iso(1000));
    }
    expect(isContextSnapshot(snapshot())).toBe(true);
    expect(mergeSnapshot(undefined, { used: 1, max: 2 })).toBeUndefined();
  });

  it("waits for the card when it arrives first", () => {
    const s = initialState();
    apply(s, observed({ ...ctx(), snapshot: snapshot({ at: iso(1000) }) }));
    apply(s, observed({ msgsUser: 7 }));
    expect(s.agents.has("s1")).toBe(false);
    apply(s, { hook_event_name: "PreToolUse", session_id: "s1", cwd: "/work/shop", tool_name: "Read", tool_use_id: "t1", tool_input: {} });
    expect(kept(s)?.at).toBe(iso(1000));
    expect(s.agents.get("s1")!.context!.msgsUser).toBe(7);
  });
});

// ─── The rows ───────────────────────────────────────────────────────────────

describe("the rows of the breakdown", () => {
  it("runs the bar from the biggest category down, then the buffer, then free space; the deferred apart", () => {
    const layout = snapshotLayout(snapshot(), 113_600);
    expect(layout.rows.map(r => r.id)).toEqual([
      "messages", "memory-files", "system-tools", "skills", "system-prompt", "custom-agents", "mcp-server-instructions", "buffer", "free",
    ]);
    expect(layout.rows.map(r => r.tone)).toEqual(["messages", "memory", "tools", "other", "other", "other", "other", "buffer", "free"]);
    expect(layout.deferred.map(r => [r.id, r.pct])).toEqual([["mcp-tools-deferred", null], ["system-tools-deferred", null]]);
    expect(layout).toMatchObject({ used: 113_600, max: 600_000, since: 0 });
    expect(layout.rows[0].pct).toBe(5.9);
  });

  it("adds what the session took after /context as Since then, out of the free space", () => {
    const layout = snapshotLayout(snapshot(), 128_200);
    expect(layout.since).toBe(14_600);
    expect(layout.used).toBe(128_200);
    const since = layout.rows.find(r => r.id === "since")!;
    expect(since).toMatchObject({ tokens: 14_600, pct: 2.4, tone: "since" });
    expect(layout.rows.map(r => r.id).slice(-3)).toEqual(["since", "buffer", "free"]);
    expect(layout.rows.find(r => r.id === "free")!.tokens).toBe(453_400 - 14_600);
    expect(Math.round(layout.pct)).toBe(21);
  });

  it("leaves Since then out when the session has not moved past /context's own rounding", () => {
    expect(snapshotLayout(snapshot(), 113_600 + SINCE_FLOOR - 1).since).toBe(0);
    expect(snapshotLayout(snapshot(), 90_000).since).toBe(0);
    expect(snapshotLayout(snapshot(), 0).used).toBe(113_600);
  });

  it("groups the MCP tools by server, loaded and deferred, and counts every one", () => {
    expect(mcpGroups(snapshot())).toEqual([
      { server: "figma", tools: [{ name: "mcp__figma__get_screenshot", tokens: 2400 }], tokens: 2400, deferred: 0, deferredTokens: 0 },
      { server: "github", tools: [{ name: "mcp__github__create_issue", tokens: 1200 }, { name: "mcp__github__get_issue", tokens: 800 }], tokens: 2000, deferred: 40, deferredTokens: 30_100 },
      { server: "slack", tools: [], tokens: 0, deferred: 12, deferredTokens: 8400 },
    ]);
    expect(mcpToolCount(snapshot())).toBe(55);
    expect(mcpToolCount(snapshot({ more: { mcpTools: { count: 5, tokens: 900 } } }))).toBe(60);
  });

  it("prints a count as /context does: a decimal only under 10k and past 1M, never a trailing .0", () => {
    const cases: Array<[number, string]> = [
      [0, "0"], [850, "850"], [999, "999"], [1000, "1k"], [3140, "3.1k"], [5000, "5k"], [9949, "9.9k"], [9950, "10k"],
      [10_000, "10k"], [35_700, "36k"], [600_000, "600k"], [999_499, "999k"], [999_500, "1M"], [1_000_000, "1M"], [1_240_000, "1.2M"],
    ];
    for (const [n, want] of cases) expect(snapTokens(n), String(n)).toBe(want);
    expect(snapTokens(Number.NaN)).toBe("0");
    expect(snapTokens(-5)).toBe("0");
  });

  it("gives the window figure everywhere /context's window and count, once the session has one", () => {
    const base = { usage: NO_USAGE, model: "claude-opus-4-7", contextWindow: 200_000 } as unknown as AgentNodeData;
    // No snapshot: the deck's own estimate over the model's window, as before.
    expect(contextFill({ ...base, context: ctx({ currentContextTokens: 50_000 }) })).toMatchObject({ used: 50_000, limit: 200_000 });
    // A snapshot: its window, and its count until the session has grown past it.
    expect(contextFill({ ...base, context: ctx({ currentContextTokens: 110_000, snapshot: snapshot() }) })).toMatchObject({ used: 113_600, limit: 600_000 });
    expect(contextFill({ ...base, context: ctx({ currentContextTokens: 128_200, snapshot: snapshot() }) })).toMatchObject({ used: 128_200, limit: 600_000 });
    // Only Claude Code has /context: a Codex session handed one keeps its own figure.
    expect(contextFill({ ...base, provider: "codex", context: ctx({ currentContextTokens: 50_000, snapshot: snapshot() }) } as AgentNodeData))
      .toMatchObject({ used: 50_000, limit: 200_000 });
  });

  it("names every category Claude Code writes in the reader's language", () => {
    const names = [
      "Messages", "Memory files", "System tools", "System tools (deferred)", "System prompt", "Skills", "Custom agents",
      "MCP tools", "MCP tools (deferred)", "MCP server instructions", "Free space", "Autocompact buffer", "Compact buffer",
    ];
    for (const name of names) {
      const key = CATEGORY_KEYS[categorySlug(name)];
      expect(key, name).toBeDefined();
      expect((en as Record<string, string>)[key], name).toBe(name);
    }
  });
});

// ─── The tab ────────────────────────────────────────────────────────────────

function stubStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  vi.stubGlobal("window", {
    get localStorage() {
      return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
    },
  });
}
afterEach(() => { vi.unstubAllGlobals(); });

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const A = (over: Partial<AgentNodeData> = {}) => ({
  id: "s", sessionId: "s", label: "shop", kind: "root", state: "active", childCount: 0, tools: [], toolCount: 0,
  usage: NO_USAGE, prompts: [], startedAt: 1000, model: "claude-opus-4-7", contextWindow: 600_000, cwd: "/work/shop", ...over,
}) as unknown as AgentNodeData;
const tab = (agent: AgentNodeData) => {
  stubStore({ [INSPECTOR_TAB_KEY]: "context" });
  return renderToStaticMarkup(createElement(Inspector, {
    selected: agent, agents: new Map([[agent.id, agent]]), onSelectAgent: () => {}, onClose: () => {}, detail: createElement("div"),
  }));
};
/** The text of each element of a class, tags stripped, in order. */
const texts = (html: string, cls: string) =>
  [...html.matchAll(new RegExp(`<[a-z]+ class="${cls}"[^>]*>([\\s\\S]*?)</(?:span|p|li)>`, "g"))].map(m => m[1].replace(/<[^>]+>/g, ""));

describe("the Context tab with a snapshot", () => {
  it("heads the tab with /context's own window and count, once, and draws one bar of the used categories", () => {
    // The model id says 200k; /context said 600k, and the head says what the bar draws.
    const out = tab(A({ contextWindow: undefined, context: ctx({ snapshot: snapshot() }) }));
    expect(out).toContain('<span class="insp-fig">114k / 600k · 19%</span>');
    // The Inspector's head is the figure: the breakdown does not print it a second time.
    expect(out).not.toContain("ctx-snap-head");
    expect(out).toMatch(/<div class="ctx-snap-bar" role="img" aria-label="What fills the context window">/);
    const tones = [...out.matchAll(/class="ctx-snap-seg" data-tone="([a-z]+)"/g)].map(m => m[1]);
    // Free space is the bar's own track; deferred categories are not in the window.
    expect(tones).toEqual(["messages", "memory", "tools", "other", "other", "other", "other", "buffer"]);
    // The breakdown takes the meter's place.
    expect(out).not.toContain("ctx-window-bar");
    expect(out).not.toContain("ctx-snap-hint");
  });

  it("lists a row per category with its tokens and share, the deferred apart with a dash", () => {
    const out = tab(A({ context: ctx({ snapshot: snapshot() }) }));
    expect(texts(out, "ctx-snap-name")).toEqual([
      "Messages", "Memory files", "System tools", "Skills", "System prompt", "Custom agents", "MCP server instructions",
      "Autocompact buffer", "Free space", "MCP tools (deferred)", "System tools (deferred)",
    ]);
    // As /context prints them: a decimal only under 10k, never a trailing ".0".
    expect(texts(out, "ctx-snap-tok")).toEqual(["36k", "27k", "16k", "10k", "5k", "3.6k", "1.7k", "33k", "453k", "67k", "26k"]);
    expect(texts(out, "ctx-snap-pct")).toEqual(["5.9%", "4.5%", "2.7%", "1.7%", "0.8%", "0.6%", "0.3%", "5.5%", "75.6%", "—", "—"]);
    expect(out).toMatch(/<ul class="ctx-snap-rows ctx-snap-deferred">/);
    expect(out).toContain('title="Deferred: loaded into the window only when used">—</span>');
  });

  it("adds Since then from the tab's own estimate when the session has grown past the snapshot", () => {
    const out = tab(A({ context: ctx({ currentContextTokens: 128_200, snapshot: snapshot() }) }));
    expect(texts(out, "ctx-snap-name")).toContain("Since then");
    const at = texts(out, "ctx-snap-name").indexOf("Since then");
    expect(texts(out, "ctx-snap-tok")[at]).toBe("15k");
    expect(texts(out, "ctx-snap-pct")[at]).toBe("2.4%");
    expect(out).toContain('<span class="insp-fig">128k / 600k · 21%</span>');
    expect(out).toMatch(/class="ctx-snap-seg" data-tone="since"/);
    // Not there when it has not grown.
    expect(tab(A({ context: ctx({ snapshot: snapshot() }) }))).not.toContain("Since then");
  });

  it("keeps the lists behind closed disclosures with their counts, the bounded ones with their last row", () => {
    const out = tab(A({ context: ctx({ snapshot: snapshot() }) }));
    const lists = [...out.matchAll(/<details class="ctx-snap-list"><summary class="ctx-files-toggle"><span>([^<]+)<\/span><span class="ctx-files-count">([^<]+)<\/span>/g)]
      .map(m => [m[1], m[2]]);
    expect(lists).toEqual([["MCP tools", "55"], ["Memory files", "2"], ["Custom agents", "10"], ["Skills", "41"]]);
    expect(out).not.toMatch(/<details[^>]* open/);
    // The MCP tools by server: the server, its tool count and its loaded tokens, then its tools.
    // A server with some tools loaded and the rest deferred says so, and its
    // figure's title says what all of it would cost.
    expect(out).toContain('<li class="ctx-snap-group"><span class="ctx-snap-item">github</span><span class="ctx-snap-meta">2 of 42 loaded</span><span class="ctx-md-size" title="32k if all were loaded">2k</span>');
    expect(out).toContain('<span class="ctx-snap-item">figma</span><span class="ctx-snap-meta">1 tool</span><span class="ctx-md-size" title="2,400">2.4k</span>');
    expect(out).toContain('<li class="ctx-snap-sub"><span class="ctx-snap-item">mcp__github__create_issue</span>');
    // A server with nothing loaded says what it would cost, and takes no tokens.
    expect(out).toMatch(/<span class="ctx-snap-item">slack<\/span><span class="ctx-snap-meta">12 tools<\/span><span class="ctx-md-size" title="8.4k if all were loaded">—<\/span>/);
    // Memory files by path, the folder above kept; agents and skills with their source.
    expect(out).toMatch(/<li title="Project"><span class="path-text ctx-md-path"[^>]*>[\s\S]*?CLAUDE\.md<\/span><\/span><span class="ctx-md-size" title="14,500">15k<\/span>/);
    expect(out).toContain('<span class="ctx-snap-item">code-reviewer</span><span class="ctx-snap-meta">Project</span>');
    expect(out).toContain('<li class="ctx-snap-more"><span class="ctx-snap-item">and 8 more</span><span class="ctx-md-size" title="1,600">1.6k</span></li>');
    expect(out).toContain('<li class="ctx-snap-more"><span class="ctx-snap-item">and 40 more</span>');
  });

  it("leaves out a list /context did not print", () => {
    const out = tab(A({ context: ctx({ snapshot: snapshot({ mcpTools: [], mcpServers: [], agents: [], skills: [], more: {} }) }) }));
    expect(texts(out, "ctx-files-toggle").map(s => s.replace(/\d+$/, ""))).toEqual(["Memory files"]);
  });

  it("says where it came from and how old it is", () => {
    // The foot reads the shared half-minute clock, not Date.now().
    const at = iso(nowAt(30_000) - 3 * MIN - 1000);
    const out = tab(A({ context: ctx({ snapshot: snapshot({ at }) }) }));
    expect(out).toMatch(/<p class="ctx-window-note ctx-snap-foot" title="[^"]+">From \/context · 3m ago<\/p>/);
    const estimated = tab(A({ context: ctx({ snapshot: snapshot({ at, estimated: true }) }) }));
    expect(estimated).toContain(">Estimated by /context · 3m ago</p>");
  });

  it("keeps the rest of the tab as it was", () => {
    const out = tab(A({ context: ctx({ snapshot: snapshot() }) }));
    for (const word of ["Cumulative usage", "Transcript composition", "CLAUDE.md files in scope"]) expect(out).toContain(word);
  });

  it("is the modal's body too, with the figure over its bar and no transcript line above it", () => {
    const out = renderToStaticMarkup(createElement(ContextView, { agent: A({ context: ctx({ snapshot: snapshot() }) }), meta: true }));
    expect(out).toContain('<span class="ctx-snap-used">19% used</span>');
    expect(out).toContain(">114k / 600k</span>");
    expect(out).not.toContain("ctx-window-pct");
    // "Estimated from the transcript." would contradict the foot's "From /context".
    expect(out).not.toContain("ctx-approx");
    const without = renderToStaticMarkup(createElement(ContextView, { agent: A({ context: ctx() }), meta: true }));
    expect(without).toContain('<p class="ctx-approx">');
  });
});

describe("the Context tab without a snapshot", () => {
  it("is today's tab, with one quiet line saying how to get the breakdown", () => {
    const out = tab(A({ context: ctx() }));
    expect(out).toContain("ctx-window-bar");
    expect(out).toMatch(/<p class="ctx-window-note">Estimated from the transcript\.<\/p><p class="ctx-window-note ctx-snap-hint">Run \/context in this session to see what fills it\.<\/p>/);
    expect(out).not.toContain("ctx-snap-bar");
    expect(out.match(/ctx-snap-hint/g)).toHaveLength(1);
  });

  it("says nothing of /context to a Codex session, even one handed a snapshot, or to a subagent", () => {
    const codex = tab(A({ provider: "codex", model: "gpt-5", context: ctx({ snapshot: snapshot() }) }));
    expect(codex).not.toMatch(/ctx-snap|\/context/);
    expect(codex).toContain("ctx-window-bar");
    const sub = tab(A({ id: "c1", kind: "subagent", parentId: "s", context: ctx() }));
    expect(sub).not.toContain("ctx-snap-hint");
  });

  it("says nothing of /context to an opencode or Copilot session either: only Claude Code has it", () => {
    for (const provider of ["opencode", "copilot"] as const) {
      const out = tab(A({ provider, context: ctx({ snapshot: snapshot() }) }));
      expect(out, provider).not.toMatch(/ctx-snap|\/context/);
    }
  });
});

describe("how the breakdown is drawn", () => {
  const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
  const snapRules = [...css.matchAll(/([^{}]*\.ctx-snap[^{}]*)\{([^}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));

  it("colours every band and swatch from the theme's tokens, in both themes", () => {
    expect(snapRules.length).toBeGreaterThan(10);
    for (const r of snapRules) expect(r.body, r.sel).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    for (const [tone, token] of [["messages", "--usage-blue"], ["memory", "--usage-orange"], ["tools", "--usage-teal"], ["other", "--usage-zinc"], ["since", "--usage-purple"]]) {
      const rule = snapRules.find(r => r.sel.includes(`.ctx-snap-key[data-tone="${tone}"]`) && r.sel.includes(`.ctx-snap-seg[data-tone="${tone}"]`));
      expect(rule?.body, tone).toContain(`var(${token})`);
    }
  });

  it("sets its rows in the tab's small type, and keeps the bar 6px like the meter it replaces", () => {
    const body = (sel: string) => snapRules.find(r => r.sel === sel)?.body ?? "";
    expect(body(".ctx-snap-row")).toContain("font-size: calc(12px + var(--ui-text-increase, 0px))");
    expect(body(".ctx-snap-head")).toContain("font-size: calc(12px + var(--ui-text-increase, 0px))");
    expect(body(".ctx-snap-bar")).toContain("height: 6px");
  });

  it("adds no button and no control of its own", () => {
    const source = readFileSync(join(WEB_DIR, "components/ContextSnapshot.tsx"), "utf8");
    expect(source).not.toMatch(/<button|onClick/);
  });
});
