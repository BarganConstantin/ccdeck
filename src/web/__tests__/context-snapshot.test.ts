// Claude Code's /context breakdown, from the transcript line to the event that
// carries it.
//
// `/context` draws its grid on the terminal and adds one meta user line to the
// transcript: the same breakdown as markdown, built by Claude Code's own
// function (2.1.332). `claude -p /context` prints the same markdown, which a
// transcript keeps inside <local-command-stdout>. These pin the parse, which
// line counts as a snapshot, the rule that keeps the newest one until a /clear
// or /compact drops it, and the event the server sends it on: once per new
// snapshot, null once dropped, nothing in between. context-snapshot-tab.test.ts
// pins what the page keeps and draws.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { CONTEXT_USAGE_MARK, contextSnapshotOf, foldContextSnapshotLine, mayMoveSnapshot, parseContextSnapshot, parseTokenCount } from "../../server/context-snapshot.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { foldEnrichment as serverFold } from "../../server/evicted-enrichment.mjs";
import { foldEnrichment as pageFold } from "../parked-enrichment";
import type { ContextSnapshot, HookPayload } from "../types";

// Nothing here goes near the real ~/.claude: the memory-file scan the context
// pass runs walks up to HOME, so HOME is a temp folder.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-ctx-snapshot-"));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
// @ts-expect-error — plain .mjs server module, no types
const { connectEventSink } = await import("../../server/event-sink.mjs");
// @ts-expect-error — plain .mjs server module, no types
const enrichment = await import("../../server/session-enrichment.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { scanTranscript } = await import("../../server/transcript-scan.mjs");

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  rmTempDir(DIR);
});
afterEach(() => { vi.useRealTimers(); });

/** A table in the shape Noo writes it: the heading, a blank line, the header
 *  row, the separator, the rows, a blank line. */
const table = (heading: string, header: string, sep: string, rows: string[]) =>
  `### ${heading}\n\n| ${header} |\n|${sep}|\n${rows.map(r => `| ${r} |\n`).join("")}\n`;

/** The markdown Claude Code 2.1.332's Noo() writes for a bounded `/context`,
 *  with the numbers of a real session: MCP tools deferred, every list present,
 *  the agents and skills over ten rows and folded into "and N more". */
function noo({ buffer = "Autocompact buffer", estimate = false, raised = false } = {}) {
  let md = "## Context Usage\n\n";
  md += "**Model:** claude-opus-4-7[1m]  \n";
  md += "**Tokens:** 113.6k / 600k (19%)\n";
  if (raised) md += "\n**Auto-compact window:** raised from 200k to 600k tokens in this conversation, to fit what loads with every request\n";
  md += "\n";
  if (estimate) md += "This token count is an estimate.\n\n";
  const cats = [
    "System prompt | 5k | 0.8%",
    "System tools | 16.1k | 2.7%",
    "System tools (deferred) | 26.4k | 4.4%",
    "MCP tools (deferred) | 66.9k | 11.2%",
    "MCP server instructions | 1.7k | 0.3%",
    "Custom agents | 3.6k | 0.6%",
    "Memory files | 26.9k | 4.5%",
    "Skills | 10k | 1.7%",
    "Messages | 35.7k | 5.9%",
  ];
  // Noo lists "Compact buffer" with the other categories, and only
  // "Autocompact buffer" after Free space.
  if (buffer === "Compact buffer") cats.push("Compact buffer | 33k | 5.5%");
  cats.push("Free space | 453.4k | 75.6%");
  if (buffer === "Autocompact buffer") cats.push("Autocompact buffer | 33k | 5.5%");
  md += table("Estimated usage by category", "Category | Tokens | Percentage", "----------|--------|------------", cats);
  md += table("MCP Tools", "Tool | Server | Tokens", "------|--------|--------", [
    "mcp__figma__get_screenshot | figma | 2.4k",
    "mcp__github__create_issue | github | 1.2k",
    "mcp__github__get_issue | github | 800",
  ]);
  md += table("Other MCP tools, by server", "Server | Tools | Tokens if all were loaded", "--------|-------|---------------------------", [
    "github | 40 | 30.1k",
    "slack | 12 | 8.4k",
  ]);
  md += table("Custom Agents", "Agent Type | Source | Tokens", "------------|--------|--------", [
    ...Array.from({ length: 10 }, (_, i) => `agent-${i} | ${i % 2 ? "Project" : "User"} | ${200 - i}`),
    "and 8 more |  | 1.6k",
  ]);
  md += table("Memory Files", "Type | Path | Tokens", "------|------|--------", [
    "Project | /work/shop/CLAUDE.md | 14.5k",
    "User | /home/me/.claude/CLAUDE.md | 12.4k",
  ]);
  md += table("Skills", "Skill | Source | Tokens", "-------|--------|--------", [
    ...Array.from({ length: 10 }, (_, i) => `skill-${i} | Plugin (anthropic-skills) | ${120 - i}`),
    "and 40 more |  | 9.8k",
  ]);
  return md;
}

const T0 = Date.parse("2026-11-28T10:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The meta line `/context` adds, in the shape Claude Code writes user lines. */
const META = (content: unknown, at = T0, extra: Record<string, unknown> = {}) => JSON.stringify({
  parentUuid: "a1", isSidechain: false, userType: "external", type: "user", isMeta: true,
  message: { role: "user", content }, timestamp: iso(at), uuid: "b2", sessionId: "s1", version: "2.1.332", ...extra,
});
const USER = (content: unknown, at: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "user", isSidechain: false, message: { role: "user", content }, timestamp: iso(at), ...extra,
});
const ASSISTANT = (at: number) => JSON.stringify({
  type: "assistant", timestamp: iso(at), message: { model: "claude-opus-4-7", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 120_000, output_tokens: 10 } },
});
const COMPACT_BOUNDARY = (at: number) => JSON.stringify({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: iso(at) });
const command = (name: string) => `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args></command-args>`;

describe("a /context block", () => {
  it("reads Claude Code's compact figures as whole tokens", () => {
    expect(parseTokenCount("3.1k")).toBe(3100);
    expect(parseTokenCount("86k")).toBe(86_000);
    expect(parseTokenCount("1.2m")).toBe(1_200_000);
    expect(parseTokenCount("1m")).toBe(1_000_000);
    expect(parseTokenCount("512")).toBe(512);
    expect(parseTokenCount("12,345")).toBe(12_345);
    expect(parseTokenCount("4.5K")).toBe(4500);
    expect(parseTokenCount("~800 tokens")).toBe(800);
    for (const bad of ["", "k", "lots", "1.2.3k", "-5"]) expect(parseTokenCount(bad), bad).toBeNull();
  });

  it("reads every figure and every list of a full block", () => {
    const snap = parseContextSnapshot(noo())!;
    expect(snap).toMatchObject({ model: "claude-opus-4-7[1m]", used: 113_600, max: 600_000, pct: 19, estimated: false, free: 453_400 });
    expect(snap.buffer).toEqual({ name: "Autocompact buffer", tokens: 33_000 });
    // Free space and the buffer are kept apart from the categories.
    expect(snap.categories.map((c: { name: string }) => c.name)).toEqual([
      "System prompt", "System tools", "System tools (deferred)", "MCP tools (deferred)", "MCP server instructions",
      "Custom agents", "Memory files", "Skills", "Messages",
    ]);
    expect(snap.categories[0]).toEqual({ name: "System prompt", tokens: 5000, pct: 0.8, deferred: false });
    expect(snap.categories[3]).toEqual({ name: "MCP tools (deferred)", tokens: 66_900, pct: 11.2, deferred: true });
    expect(snap.mcpTools).toEqual([
      { name: "mcp__figma__get_screenshot", server: "figma", tokens: 2400 },
      { name: "mcp__github__create_issue", server: "github", tokens: 1200 },
      { name: "mcp__github__get_issue", server: "github", tokens: 800 },
    ]);
    expect(snap.mcpServers).toEqual([{ server: "github", tools: 40, tokens: 30_100 }, { server: "slack", tools: 12, tokens: 8400 }]);
    expect(snap.agents).toHaveLength(10);
    expect(snap.agents[1]).toEqual({ type: "agent-1", source: "Project", tokens: 199 });
    expect(snap.memory).toEqual([
      { type: "Project", path: "/work/shop/CLAUDE.md", tokens: 14_500 },
      { type: "User", path: "/home/me/.claude/CLAUDE.md", tokens: 12_400 },
    ]);
    expect(snap.skills[0]).toEqual({ name: "skill-0", source: "Plugin (anthropic-skills)", tokens: 120 });
    // The bounded tail: "| and 8 more |  | 1.6k |".
    expect(snap.more).toEqual({ agents: { count: 8, tokens: 1600 }, skills: { count: 40, tokens: 9800 } });
  });

  it("takes a Compact buffer from among the categories, the estimate line, and the raised-window line", () => {
    const snap = parseContextSnapshot(noo({ buffer: "Compact buffer", estimate: true, raised: true }))!;
    expect(snap.buffer).toEqual({ name: "Compact buffer", tokens: 33_000 });
    expect(snap.categories.some((c: { name: string }) => /buffer/i.test(c.name))).toBe(false);
    expect(snap.estimated).toBe(true);
    expect(snap.max).toBe(600_000);
  });

  it("is the same block unwrapped from a command's stdout", () => {
    expect(parseContextSnapshot(`<local-command-stdout>${noo()}</local-command-stdout>`)).toEqual(parseContextSnapshot(noo()));
  });

  it("is nothing for text that is not a Context Usage block, and never throws", () => {
    for (const text of ["", "hello", "## Usage\n**Tokens:** 1k / 2k (50%)", "# Context Usage", undefined, null, 42, {}]) {
      expect(parseContextSnapshot(text as never), String(text)).toBeNull();
    }
    // A heading with nothing to size a window by says nothing either.
    expect(parseContextSnapshot("## Context Usage\n\nnothing here")).toBeNull();
  });

  it("skips what it cannot read and keeps the rest", () => {
    const md = "## Context Usage\n\n**Model:** m\n**Tokens:** 10k / 200k (5%)\n\n"
      + table("Estimated usage by category", "Category | Tokens | Percentage", "---|---|---", [
        "Messages | lots | 1%", "| broken", "System prompt | 3k", "Skills | 2k | 1.0%",
      ])
      + "### Something new\n\n| A | B | C |\n|---|---|---|\n| x | y | 9k |\n\n"
      + table("Memory Files", "Type | Path | Tokens", "---|---|---", ["User |  | 1k", "Project | /a|b/CLAUDE.md | 2k"]);
    const snap = parseContextSnapshot(md)!;
    expect(snap.categories).toEqual([
      // Two cells: the share is worked out from the window.
      { name: "System prompt", tokens: 3000, pct: 1.5, deferred: false },
      { name: "Skills", tokens: 2000, pct: 1, deferred: false },
    ]);
    // A path holding a "|" keeps it; a row with no path is skipped.
    expect(snap.memory).toEqual([{ type: "Project", path: "/a|b/CLAUDE.md", tokens: 2000 }]);
    expect(snap.mcpTools).toEqual([]);
    expect(snap.agents).toEqual([]);
    expect(snap.skills).toEqual([]);
    expect(snap.buffer).toBeNull();
    expect(snap.more).toEqual({});
  });

  it("sizes the window from the rows when the Tokens line is missing", () => {
    const md = "## Context Usage\n\n" + table("Estimated usage by category", "Category | Tokens | Percentage", "---|---|---", [
      "Messages | 20k | 10%", "MCP tools (deferred) | 5k | 2.5%", "Free space | 150k | 75%", "Autocompact buffer | 30k | 15%",
    ]);
    expect(parseContextSnapshot(md)).toMatchObject({ used: 20_000, max: 200_000, pct: 10 });
  });

  it("bounds the lists and the strings a hostile block can put on the wire", () => {
    const rows = Array.from({ length: 500 }, (_, i) => `tool-${i} | ${"s".repeat(1000)} | 1k`);
    const snap = parseContextSnapshot("## Context Usage\n\n**Tokens:** 1k / 2k (50%)\n\n" + table("MCP Tools", "Tool | Server | Tokens", "---|---|---", rows))!;
    expect(snap.mcpTools).toHaveLength(200);
    expect(snap.mcpTools[0].server.length).toBe(300);
  });
});

describe("which transcript line is a snapshot", () => {
  it("is the meta user line /context adds, with the line's own time", () => {
    const snap = contextSnapshotOf(META(noo()))!;
    expect(snap.at).toBe(iso(T0));
    expect(snap.used).toBe(113_600);
  });

  it("reads the content as a string or as text blocks", () => {
    const blocks = [{ type: "text", text: noo().slice(0, 200) }, { type: "text", text: noo().slice(200) }];
    expect(contextSnapshotOf(META(blocks))).toEqual(contextSnapshotOf(META(noo())));
  });

  it("is a command's stdout too, which is not a meta line", () => {
    const line = USER(`<local-command-stdout>${noo()}</local-command-stdout>`, T0);
    expect(contextSnapshotOf(line)).toMatchObject({ used: 113_600, at: iso(T0) });
  });

  it("is not a prompt someone pasted the block into, a subagent's line, or a line with no time", () => {
    expect(contextSnapshotOf(USER(noo(), T0)), "a prompt").toBeNull();
    expect(contextSnapshotOf(META(noo(), T0, { isSidechain: true })), "a sidechain").toBeNull();
    expect(contextSnapshotOf(META(noo(), T0, { timestamp: "later" })), "no time").toBeNull();
    expect(contextSnapshotOf(JSON.stringify({ type: "assistant", isMeta: true, timestamp: iso(T0), message: { content: noo() } })), "the model's").toBeNull();
    // The file is being appended to while it is read; a torn line is ordinary.
    expect(contextSnapshotOf(META(noo()).slice(0, 300))).toBeNull();
  });

  it("is found by the mark the watch's tap looks for", () => {
    expect(META(noo())).toContain(CONTEXT_USAGE_MARK);
    expect(mayMoveSnapshot(META(noo()))).toBe(true);
    expect(mayMoveSnapshot(USER(command("clear"), T0))).toBe(true);
    expect(mayMoveSnapshot(COMPACT_BOUNDARY(T0))).toBe(true);
    expect(mayMoveSnapshot(ASSISTANT(T0))).toBe(false);
  });
});

describe("the newest snapshot, until the window it describes is thrown away", () => {
  const fold = (...lines: string[]) => {
    const out: { contextSnapshot: (ContextSnapshot & { at: string }) | null } = { contextSnapshot: null };
    for (const line of lines) foldContextSnapshotLine(out, line);
    return out.contextSnapshot;
  };
  const later = noo().replace("113.6k / 600k (19%)", "150k / 600k (25%)");

  it("keeps the latest, with its time", () => {
    const snap = fold(META(noo()), ASSISTANT(T0 + MIN), META(later, T0 + 5 * MIN), ASSISTANT(T0 + 6 * MIN))!;
    expect(snap.used).toBe(150_000);
    expect(snap.at).toBe(iso(T0 + 5 * MIN));
  });

  it("is dropped by /clear, /compact and an automatic compact after it", () => {
    expect(fold(META(noo()), USER(command("clear"), T0 + MIN))).toBeNull();
    expect(fold(META(noo()), USER(command("compact"), T0 + MIN))).toBeNull();
    expect(fold(META(noo()), USER([{ type: "text", text: command("compact") }], T0 + MIN))).toBeNull();
    expect(fold(META(noo()), COMPACT_BOUNDARY(T0 + MIN))).toBeNull();
  });

  it("stands after a /clear or /compact that came before it", () => {
    expect(fold(USER(command("clear"), T0 - MIN), META(noo()))?.at).toBe(iso(T0));
    expect(fold(COMPACT_BOUNDARY(T0 - MIN), META(noo()))?.at).toBe(iso(T0));
  });

  it("is not dropped by other commands, a subagent's compact, or the model quoting the marker", () => {
    expect(fold(META(noo()), USER(command("context"), T0 + MIN))).not.toBeNull();
    expect(fold(META(noo()), USER(command("model"), T0 + MIN))).not.toBeNull();
    expect(fold(META(noo()), JSON.stringify({ ...JSON.parse(COMPACT_BOUNDARY(T0 + MIN)), isSidechain: true }))).not.toBeNull();
    expect(fold(META(noo()), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: command("clear") }] } }))).not.toBeNull();
  });

  it("rides the transcript cursor, across appends", async () => {
    const path = join(DIR, "cursor.jsonl");
    writeFileSync(path, ASSISTANT(T0 - MIN) + "\n" + META(noo()) + "\n");
    expect((await scanTranscript(path)).contextSnapshot).toMatchObject({ used: 113_600, at: iso(T0) });
    appendFileSync(path, ASSISTANT(T0 + MIN) + "\n");
    expect((await scanTranscript(path)).contextSnapshot).toMatchObject({ at: iso(T0) });
    appendFileSync(path, USER(command("compact"), T0 + 2 * MIN) + "\n");
    expect((await scanTranscript(path)).contextSnapshot).toBeNull();
  });
});

describe("the event the snapshot rides", () => {
  const events: Record<string, any>[] = [];
  connectEventSink((raw: Record<string, any>) => { events.push(raw); });
  const contextEvents = (sid: string) => events.filter(e => e.hook_event_name === "ContextObserved" && e.session_id === sid);
  /** One context pass, past the 4 s throttle, and the event it sent. */
  const pass = async (sid: string, path: string, clock: { now: number }) => {
    clock.now += 5000;
    vi.setSystemTime(clock.now);
    const before = contextEvents(sid).length;
    enrichment.maybeResolveContext({ session_id: sid, transcript_path: path, cwd: DIR });
    await vi.waitFor(() => expect(contextEvents(sid).length).toBe(before + 1));
    return contextEvents(sid).at(-1)!;
  };

  it("carries a new snapshot once, nothing while it stands, and null once it is dropped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = { now: T0 };
    const sid = "emit-1";
    const path = join(DIR, "emit-1.jsonl");
    writeFileSync(path, ASSISTANT(T0 - MIN) + "\n");
    // A session that never ran /context never carries the field.
    expect("snapshot" in (await pass(sid, path, clock)).context).toBe(false);
    appendFileSync(path, META(noo()) + "\n");
    const first = await pass(sid, path, clock);
    expect(first.context.snapshot).toMatchObject({ used: 113_600, at: iso(T0) });
    // The counts still go out on every pass; the snapshot does not.
    expect(first.context.msgsAssistant).toBe(1);
    appendFileSync(path, ASSISTANT(T0 + MIN) + "\n");
    expect("snapshot" in (await pass(sid, path, clock)).context).toBe(false);
    appendFileSync(path, USER(command("clear"), T0 + 2 * MIN) + "\n");
    expect((await pass(sid, path, clock)).context.snapshot).toBeNull();
    expect("snapshot" in (await pass(sid, path, clock)).context).toBe(false);
  });

  it("is sent off the output watch's tail without waiting for a hook", async () => {
    const sid = "tail-1";
    const path = join(DIR, "tail-1.jsonl");
    writeFileSync(path, ASSISTANT(T0 - MIN) + "\n");
    enrichment.onTranscriptTail(sid, ASSISTANT(T0 - MIN), path);
    appendFileSync(path, META(noo()) + "\n");
    enrichment.onTranscriptTail(sid, META(noo()), path);
    await vi.waitFor(() => expect(contextEvents(sid)).toHaveLength(1));
    // Only the snapshot: the counts and the memory files are the hook pass's.
    expect(Object.keys(contextEvents(sid)[0].context)).toEqual(["snapshot"]);
    expect(contextEvents(sid)[0].context.snapshot.at).toBe(iso(T0));
  });

  it("is sent again after a Clear, whose ring no longer holds it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = { now: T0 + 60 * MIN };
    const sid = "emit-2";
    const path = join(DIR, "emit-2.jsonl");
    writeFileSync(path, META(noo()) + "\n");
    expect((await pass(sid, path, clock)).context.snapshot).toBeTruthy();
    expect("snapshot" in (await pass(sid, path, clock)).context).toBe(false);
    enrichment.clearEnrichmentGates();
    expect((await pass(sid, path, clock)).context.snapshot).toBeTruthy();
  });
});

describe("a snapshot folded while it waits for a card or behind the ring", () => {
  const snap = (at: number, used = 1000) => ({ ...parseContextSnapshot(noo())!, used, at: iso(at) });
  const ev = (context: Record<string, unknown>) => ({ hook_event_name: "ContextObserved", session_id: "s1", context }) as HookPayload;

  it("folds the same way on the page and on the server", () => {
    const cases: Array<[HookPayload, HookPayload]> = [
      [ev({ msgsUser: 1, snapshot: snap(T0) }), ev({ msgsUser: 2 })],
      [ev({ snapshot: snap(T0) }), ev({ snapshot: snap(T0 + MIN, 2000) })],
      [ev({ snapshot: snap(T0 + MIN, 2000) }), ev({ snapshot: snap(T0) })],
      [ev({ snapshot: snap(T0) }), ev({ snapshot: null })],
      [ev({ snapshot: null }), ev({ msgsUser: 3 })],
      [ev({ snapshot: snap(T0) }), ev({ snapshot: { used: "lots" } })],
    ];
    for (const [a, b] of cases) expect(serverFold(a, b)).toEqual(pageFold(a, b));
    const [keep, newer, older, dropped, stays, junk] = cases.map(([a, b]) => pageFold(a, b).context as Record<string, any>);
    expect(keep).toMatchObject({ msgsUser: 2, snapshot: { at: iso(T0) } });
    expect(newer.snapshot.at).toBe(iso(T0 + MIN));
    expect(older.snapshot.at).toBe(iso(T0 + MIN));
    expect(dropped.snapshot).toBeNull();
    expect(stays).toMatchObject({ snapshot: null, msgsUser: 3 });
    expect(junk.snapshot.at).toBe(iso(T0));
  });
});
