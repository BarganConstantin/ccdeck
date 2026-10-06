// What every git surface calls an agent: one rule, the one the card's collision
// mark uses, so a chip in the history, the header's scope chip, the glance,
// the files' group header and the collision lines all say what the canvas
// says — "api-fix", or "web-app · 3893" for an unnamed session beside another
// in the same workspace — and never just the folder the session runs in,
// which the git view's header already names as the repository.
import { describe, expect, it } from "vitest";
import { agentNameIn, agentNamer, cardName, collisionTarget, commitAgentKeys, otherAgentName, subagentTails, type NamedCard } from "../git-agent-name";
import { agentAriaLabel } from "../agent-copy";
import { sourceOf } from "./client-source";

const UI = "cc150ea9-0000-4000-8000-00000000ad61";
const BUG = "d6a0523b-0000-4000-8000-000000003893";
const root = (sessionId: string, extra: Partial<NamedCard> = {}): NamedCard => ({ id: sessionId, sessionId, kind: "root", label: "web-app", ...extra });
const sub = (sessionId: string, key: string, label: string): NamedCard => ({ id: `${sessionId}::${key}`, sessionId, kind: "subagent", label });
const board = (...cards: NamedCard[]) => new Map(cards.map(c => [c.id, c]));

describe("an agent's name on every git surface", () => {
  it("is the session's name when Claude Code gave it one", () => {
    const agents = board(root(UI, { sessionName: "web-ui" }), root(BUG, { sessionName: "web-bugfix" }));
    expect(agentNameIn(agents, UI, null)).toBe("web-ui");
    expect(cardName(agents, agents.get(BUG)!)).toBe("web-bugfix");
  });

  it("is the workspace for a Codex or unnamed session, told apart by the id's tail the cluster header shows", () => {
    const alone = board(root(UI, { label: "shop-api-fix" }));
    expect(agentNameIn(alone, UI, null)).toBe("shop-api-fix");
    const two = board(root(UI), root(BUG, { sessionName: "  " }));
    expect(agentNameIn(two, UI, null)).toBe("web-app · ad61");
    expect(agentNameIn(two, BUG, null)).toBe("web-app · 3893");
  });

  it("gives a session with no name its cluster header's id tail whenever another session works in that workspace, named or not", () => {
    // api-fix is named; the session beside it in shop-api-auth is not. Its
    // cluster header reads SHOP-API-AUTH · 3893, and without the tail the
    // card titled shop-api-auth would read as colliding with itself.
    const agents = board(root(UI, { label: "shop-api-auth", sessionName: "api-fix" }), root(BUG, { label: "shop-api-auth" }));
    expect(agentNameIn(agents, BUG, null)).toBe("shop-api-auth · 3893");
    // A named session keeps its name alone.
    expect(agentNameIn(agents, UI, null)).toBe("api-fix");
    expect(agentNamer(agents.values())(BUG, null)).toBe("shop-api-auth · 3893");
    expect(cardName(agents, agents.get(BUG)!)).toBe("shop-api-auth · 3893");
    // Alone in its workspace it needs none.
    expect(agentNameIn(board(root(BUG, { label: "shop-api-auth" }), root(UI, { sessionName: "api-fix" })), BUG, null)).toBe("shop-api-auth");
  });

  it("tells two subagents of one session of the same type apart by their keys' tails", () => {
    const cards = [root(UI, { label: "infra" }), sub(UI, "b0000000000gp001", "general-purpose"), sub(UI, "b0000000000gp002", "general-purpose"),
      sub(UI, "c1", "test-writer"), sub(BUG, "b0000000000gp003", "general-purpose")];
    const agents = board(...cards);
    expect(agentNameIn(agents, UI, "b0000000000gp001")).toBe("general-purpose · p001");
    expect(agentNameIn(agents, UI, "b0000000000gp002")).toBe("general-purpose · p002");
    expect(cardName(agents, agents.get(`${UI}::b0000000000gp002`)!)).toBe("general-purpose · p002");
    expect(agentNamer(cards)(UI, "b0000000000gp001")).toBe("general-purpose · p001");
    // One of its type in its session, or one in another session: its type alone.
    expect(agentNameIn(agents, UI, "c1")).toBe("test-writer");
    expect(agentNameIn(agents, BUG, "b0000000000gp003")).toBe("general-purpose");
    expect(otherAgentName(agentNamer(cards), { sessionId: UI, agentId: "b0000000000gp002" })).toBe("↳ general-purpose · p002");
  });

  it("is a subagent's own label, its type, never its session's", () => {
    const agents = board(root(UI, { sessionName: "api-fix" }), sub(UI, "a4f1", "test-writer"));
    expect(agentNameIn(agents, UI, "a4f1")).toBe("test-writer");
    expect(cardName(agents, agents.get(`${UI}::a4f1`)!)).toBe("test-writer");
  });

  it("is null for a card that left the board, so the caller falls back to what the server sent", () => {
    const agents = board(root(UI, { sessionName: "api-fix" }));
    expect(agentNameIn(agents, UI, "gone")).toBeNull();
    expect(agentNameIn(agents, BUG, null)).toBeNull();
  });

  it("says the same worked out once for a whole board", () => {
    const cards = [root(UI), root(BUG), root("f00d-1", { label: "web-app", sessionName: "api-fix" }), sub(BUG, "ag7", "docs-sync"),
      sub(BUG, "ag8", "docs-sync"), sub(BUG, "ag9", "reader")];
    const name = agentNamer(cards);
    const agents = board(...cards);
    for (const [sid, key] of [[UI, null], [BUG, null], ["f00d-1", null], [BUG, "ag7"], [BUG, "ag8"], [BUG, "ag9"], [BUG, "gone"]] as const) {
      expect(name(sid, key)).toBe(agentNameIn(agents, sid, key));
    }
  });
});

describe("a subagent card's title beside its collision warnings", () => {
  it("carries the same id tail the warnings name it by, when another subagent of its session shares its type", () => {
    const a = sub(UI, "5c1e7a90d4b2f001", "general-purpose"), b = sub(UI, "5c1e7a90d4b2f002", "general-purpose");
    const agents = board(root(UI), a, b, sub(UI, "9aa0", "test-writer"), sub(BUG, "77f001", "general-purpose"), root(BUG));
    const tails = subagentTails(agents.values());
    expect(tails.get(a.id)).toBe("f001");
    expect(tails.get(b.id)).toBe("f002");
    // One of its type in its session, another session's, or a root: no tail.
    expect(tails.has(`${UI}::9aa0`)).toBe(false);
    expect(tails.has(`${BUG}::77f001`)).toBe(false);
    expect(tails.has(UI)).toBe(false);
    // Word for word what a warning says after its ↳.
    const name = agentNamer(agents.values());
    expect(`${b.label} · ${tails.get(b.id)}`).toBe(name(UI, "5c1e7a90d4b2f002"));
    expect(otherAgentName(name, { sessionId: UI, agentId: "5c1e7a90d4b2f002" } as never)).toBe(`↳ general-purpose · ${tails.get(b.id)}`);
  });

  it("is drawn on the card, its tail kept whole beside a cut type, and said in the card's accessible name", () => {
    expect(sourceOf("canvas-flow.ts")).toMatch(/const nameTail = tails\.get\(a\.id\);/);
    const node = sourceOf("components/AgentNode.tsx");
    expect(node).toMatch(/\{data\.nameTail && <span className="label-tail">· \{data\.nameTail\}<\/span>\}/);
    // A type cut to make room keeps its whole name, tail included, in the tooltip; the clock never wraps.
    expect(node).toMatch(/title=\{data\.nameTail \? \[`\$\{data\.label\} · \$\{data\.nameTail\}`, cardTooltip\]\.filter\(Boolean\)\.join\("\\n"\) : cardTooltip\}/);
    const card = { id: `${UI}::5c1e7a90d4b2f002`, sessionId: UI, kind: "subagent", label: "general-purpose", state: "active", toolCount: 1, tools: [], usage: { inputTokens: 0, outputTokens: 0 } } as never;
    expect(agentAriaLabel({ ...(card as object), nameTail: "f002" } as never, 0)).toMatch(/^general-purpose · f002, subagent/);
  });
});

describe("the other agent of a collision", () => {
  const cards = [root(UI, { sessionName: "web-ui" }), root(BUG, { sessionName: "web-bugfix" }), sub(BUG, "ag7", "docs-sync")];
  const name = agentNamer(cards);
  const agents = board(...cards);

  it("is named as the card's mark names it: ↳ for a subagent", () => {
    expect(otherAgentName(name, { sessionId: BUG, agentId: null })).toBe("web-bugfix");
    expect(otherAgentName(name, { sessionId: BUG, agentId: "ag7" })).toBe("↳ docs-sync");
    expect(otherAgentName(name, { sessionId: BUG, agentId: "gone" })).toBe("a subagent of web-bugfix");
    expect(otherAgentName(name, { sessionId: "nobody", agentId: null })).toBe("another agent");
  });

  it("goes to that agent's card, or its session's when the subagent left the board", () => {
    expect(collisionTarget(agents, { sessionId: BUG, agentId: "ag7" })).toBe(`${BUG}::ag7`);
    expect(collisionTarget(agents, { sessionId: BUG, agentId: "gone" })).toBe(BUG);
    expect(collisionTarget(agents, { sessionId: "nobody", agentId: "x" })).toBe("nobody::x");
  });
});

describe("every git surface asks the one helper", () => {
  const view = sourceOf("components/GitView.tsx");
  const glance = sourceOf("components/GitGlance.tsx");
  const mark = sourceOf("git-card-mark.ts");

  it("is the card mark's own rule, not a second copy of it", () => {
    expect(mark).toMatch(/const namer = agentNamer\(byId\.values\(\)\);/);
    expect(mark).toMatch(/otherAgentName\(namer, r\)/);
    expect(mark).not.toMatch(/distinctIdTail/);
  });

  it("names agents in the view by card name, never by the folder label", () => {
    expect(view).toMatch(/agentNameIn\(stateRef\.current\.agents, /);
    expect(view).not.toMatch(/agents\.get\(id\)\?\.label/);
    // The scope chip and the Uncommitted row say the focus's name.
    expect(view).toMatch(/<span className="gv-scope-who">\{narrow \? `↳ \$\{focusName\}` : focusName\}<\/span>/);
    expect(view).toMatch(/uncommitted=\{\{ files: counts\.changed, byFocus: counts\.files, label: focusName \}\}/);
    expect(view).toMatch(/name=\{focusName\}/);
    // The collision line names the other agent as its card's mark does.
    expect(view).toMatch(/const otherOf = \(c: \{ with: GitCollisionRef \}\) => otherAgentName\(nameOf, c\.with\);/);
  });

  it("renames the history's chips when a session is renamed while the view is open", () => {
    // The namer reads the live cards, so its identity alone never told the
    // history its chips had new words: they kept the old name until the next
    // history read. It changes now whenever a name the chips carry does.
    expect(view).toMatch(/const chipNames = commitAgentKeys\(data\.commits\)\.map\(\(\[s, a\]\) => agentNameIn\(stateRef\.current\.agents, s, a\) \?\? ""\)\.join\("\\u0001"\);/);
    expect(view).toMatch(/const nameOf = useCallback\(\(sessionId: string, agentId: string \| null\) => agentNameIn\(stateRef\.current\.agents, sessionId, agentId\), \[chipNames\]\);/);
  });

  it("lists each agent a history's commits were seen made by, once", () => {
    const seen = (sessionId: string, agentId: string | null = null) => ({ sessionId, agentId, level: "seen" });
    const commits = [
      { agent: seen("s1") }, { agent: seen("s1") }, { agent: seen("s1", "sub") }, { agent: null }, { agent: { level: "trailer", name: "Claude" } }, { agent: seen("s2") },
    ];
    expect(commitAgentKeys(commits as never)).toEqual([["s1", null], ["s1", "sub"], ["s2", null]]);
    expect(commitAgentKeys(null)).toEqual([]);
  });

  it("names the glance's other agents the same way", () => {
    expect(glance).toMatch(/agentNameIn\(stateRef\.current\.agents, /);
    expect(glance).toMatch(/const other = collision \? otherAgentName\(nameOf, collision\.with\) : "";/);
    expect(glance).not.toMatch(/agents\.get\(id\)\?\.label/);
  });
});

describe("focusing another agent looks the same from every git surface", () => {
  const view = sourceOf("components/GitView.tsx");
  const glance = sourceOf("components/GitGlance.tsx");
  const parts = sourceOf("components/GitViewParts.tsx");

  it("tells a pointer press from a key press on the collision line and Show on canvas", () => {
    expect(parts).toMatch(/const press = \(e: \{ detail: number \}\) => onFocus\(pressHow\(e\)\);/);
    expect(parts).toMatch(/onClick=\{e => onShow\(facts\.cardId!, pressHow\(e\)\)\}/);
  });

  it("keeps the wide line's words whole in its tooltip, the CLI included", () => {
    expect(parts).toMatch(/const cli = otherCli \? ` \(\$\{otherCli\}\)` : "";/);
    expect(parts).toMatch(/: `\$\{other\}\$\{cli\} also edited \$\{c\.files\.join\(", "\)\} \$\{since\}`;/);
    expect(parts).toMatch(/<div className="gv-collide-line" role="note" title=\{said\}>/);
  });

  it("goes from the glance as a card's mark does", () => {
    expect(glance).toMatch(/onFocus=\{how => goToAgentCard\(collisionTarget\(stateRef\.current\.agents, collision\.with\), how\)\}/);
  });

  it("lights the card once after a pointer press in the wide view, and animates nothing from a key", () => {
    expect(view).toMatch(/onSelectAgent\(id\);\s*if \(how === "pointer"\) requestAnimationFrame\(\(\) => flashCard\(id\)\);/);
    expect(view).toMatch(/onShowCard\(id\);[\s\S]{0,140}if \(how === "pointer"\) requestAnimationFrame\(\(\) => flashCard\(id\)\);/);
  });
});
