// How much the deck was used on one UTC day (usage-day.mjs): the tally behind
// the counts the "active" report carries. They used to be read off the live
// state at launch, before anybody had done anything, and so mostly said zero.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { FEATURES, createUsageDay, normaliseUsage } from "../../server/usage-day.mjs";

const HOUR = 60 * 60 * 1000;

function tallyAt(start = "2026-09-30T10:00:00Z") {
  let clock = new Date(start);
  const t = createUsageDay({ now: () => clock });
  return { t, later: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe("a day's tally", () => {
  it("counts each session, subagent and project once, however often it is heard from", () => {
    const { t, later } = tallyAt();
    for (let i = 0; i < 5; i++) t.noteUse({ session_id: "s1" });
    t.noteUse({ session_id: "s1", agent_id: "a1" });
    t.noteUse({ session_id: "s1", agent_id: "a1" });
    t.noteUse({ session_id: "s2", agent_id: "a1" });   // another session's subagent, not the same one
    t.noteProject("/home/u/.claude/projects/proj-a/s1.jsonl");
    t.noteProject("/home/u/.claude/projects/proj-a/s2.jsonl");
    t.noteProject("C:\\Users\\u\\.claude\\projects\\proj-b\\s3.jsonl");

    later(24 * HOUR);
    expect(t.finished("2026-10-01")).toEqual({ day: "2026-09-30", sessions: 2, subagents: 2, projects: 2, features: ["claude-sessions"], events: 8, peakMb: 0 });
  });

  it("has nothing finished on its first day", () => {
    const { t } = tallyAt();
    t.noteUse({ session_id: "s1" });
    expect(t.finished("2026-09-30")).toBeNull();
  });

  it("rolls over at UTC midnight, keeping the finished day apart from the new one", () => {
    const { t, later } = tallyAt("2026-09-30T23:30:00Z");
    t.noteUse({ session_id: "s1" });
    later(HOUR);   // 00:30 on the first
    t.noteUse({ session_id: "s2" });
    t.noteUse({ session_id: "s3" });
    // The 6-hourly check-in finds yesterday finished, and today counted apart.
    expect(t.finished("2026-10-01")).toEqual({ day: "2026-09-30", sessions: 1, subagents: 0, projects: 0, features: ["claude-sessions"], events: 1, peakMb: 0 });
    later(24 * HOUR);
    expect(t.finished("2026-10-02")).toEqual({ day: "2026-10-01", sessions: 2, subagents: 0, projects: 0, features: ["claude-sessions"], events: 2, peakMb: 0 });
  });

  it("finishes a day the deck ran past with nothing said since", () => {
    const { t, later } = tallyAt();
    t.noteUse({ session_id: "s1" });
    later(30 * HOUR);
    expect(t.finished("2026-10-01")).toMatchObject({ day: "2026-09-30", sessions: 1 });
  });

  it("never hands the same day out twice once it is marked sent", () => {
    const { t, later } = tallyAt();
    t.noteUse({ session_id: "s1" });
    later(24 * HOUR);
    expect(t.finished("2026-10-01")?.day).toBe("2026-09-30");
    t.markSent("2026-09-30");
    expect(t.finished("2026-10-01")).toBeNull();
    later(24 * HOUR);
    // The deck ran on the first and nobody used it: the second says so, as
    // zero, and does not say the thirtieth again.
    expect(t.finished("2026-10-02")).toEqual({ day: "2026-10-01", sessions: 0, subagents: 0, projects: 0, features: [], events: 0, peakMb: 0 });
  });

  it("ignores what is not a session id or a path", () => {
    const { t, later } = tallyAt();
    for (const raw of [null, undefined, {}, { session_id: 7 }, { session_id: "" }]) t.noteUse(raw);
    t.noteProject("");
    t.noteProject(null);
    later(24 * HOUR);
    // Nothing was counted, so not even a day was opened.
    expect(t.finished("2026-10-01")).toBeNull();
  });
});

describe("what survives a restart", () => {
  it("is counts and days only — never an id or a path", () => {
    const { t } = tallyAt();
    t.noteUse({ session_id: "sess-secret", agent_id: "agent-secret" });
    t.noteProject("/home/alice/.claude/projects/-home-alice-shop/sess-secret.jsonl");
    const saved = JSON.stringify(t.saved());
    for (const secret of ["sess-secret", "agent-secret", "alice", "shop", ".jsonl"]) expect(saved).not.toContain(secret);
    // The days used ride along as a count and the last of them — never the list.
    expect(t.saved()).toEqual({
      current: { day: "2026-09-30", sessions: 1, subagents: 1, projects: 1, features: ["claude-sessions"], events: 1, peakMb: 0 },
      done: null, sent: "", daysUsed: 1, lastUsedDay: "2026-09-30",
    });
  });

  it("comes back as the floor of the same day, under what this run already counted", () => {
    const before = tallyAt().t;
    before.noteUse({ session_id: "s1" });
    before.noteUse({ session_id: "s2" });
    const { t, later } = tallyAt("2026-09-30T15:00:00Z");
    t.noteUse({ session_id: "s3" });   // heard before the prefs were read
    t.restore(before.saved());
    t.noteUse({ session_id: "s4" });
    later(24 * HOUR);
    expect(t.finished("2026-10-01")).toMatchObject({ day: "2026-09-30", sessions: 4 });
  });

  it("comes back as the finished day when the restart is a day later", () => {
    const before = tallyAt().t;
    before.noteUse({ session_id: "s1" });
    const { t } = tallyAt("2026-10-01T08:00:00Z");
    t.restore(before.saved());
    expect(t.finished("2026-10-01")).toEqual({ day: "2026-09-30", sessions: 1, subagents: 0, projects: 0, features: ["claude-sessions"], events: 1, peakMb: 0 });
  });

  it("remembers what was sent, so a restart does not send it again", () => {
    const { t: before, later } = tallyAt();
    before.noteUse({ session_id: "s1" });
    later(24 * HOUR);
    before.markSent(before.finished("2026-10-01").day);
    const { t } = tallyAt("2026-10-01T09:00:00Z");
    t.restore(before.saved());
    expect(t.finished("2026-10-01")).toBeNull();
  });

  it("reads anything else as nothing saved", () => {
    const nothing = { current: null, done: null, sent: "", daysUsed: 0, lastUsedDay: "" };
    expect(normaliseUsage(null)).toEqual(nothing);
    expect(normaliseUsage({ current: { day: "yesterday", sessions: 3 }, sent: 5, daysUsed: -4, lastUsedDay: 7 })).toEqual(nothing);
    expect(normaliseUsage({ current: { day: "2026-09-30", sessions: -2, subagents: 1.5, projects: "3" } }).current)
      .toEqual({ day: "2026-09-30", sessions: 0, subagents: 0, projects: 0, features: [], events: null, peakMb: 0 });
  });
});

describe("what counts as use", () => {
  it("is a live Claude hook or a live Codex rollout line, never a replay or the deck's own events", () => {
    // The pipeline is a module graph too heavy to stand up for one branch, so
    // this pins where the calls sit: inside the live-hook gate, the project
    // beside the transcript path the gate already accepted as Claude's, and
    // the Codex watcher's own live branch — Codex has no hooks (3.36.6 missed it).
    const src = readFileSync(new URL("../../server/event-pipeline.mjs", import.meta.url), "utf8");
    const gate = src.indexOf('if (source === "hook" && !opts.replay) {');
    expect(gate).toBeGreaterThan(0);
    const use = src.indexOf("usageDay.noteUse(raw);");
    const accepted = src.indexOf("isClaudeTranscriptPath(raw.transcript_path)");
    const project = src.indexOf("usageDay.noteProject(raw.transcript_path);");
    expect(use).toBeGreaterThan(gate);
    expect(project).toBeGreaterThan(accepted);
    expect(src.indexOf("noteRefusedTranscript(raw.transcript_path)")).toBeGreaterThan(project);
    const codex = src.indexOf('} else if (source === "codex" && !opts.replay) {');
    expect(codex).toBeGreaterThan(project);
    expect(src.indexOf("usageDay.noteUse(raw);", codex)).toBeGreaterThan(codex);
    expect(src.indexOf("usageDay.noteFolder(raw?.cwd);", codex)).toBeGreaterThan(codex);
    expect(src.match(/usageDay\.note/g)?.length).toBe(4);
  });

  it("counts a Codex session's working directory as its project", () => {
    const { t, later } = tallyAt();
    t.noteUse({ session_id: "c1", provider: "codex" });
    t.noteFolder("/home/u/shop");
    t.noteFolder("/home/u/shop");
    t.noteFolder("/home/u/blog");
    t.noteFolder(undefined);
    later(24 * HOUR);
    expect(t.finished("2026-10-01")).toEqual({ day: "2026-09-30", sessions: 1, subagents: 0, projects: 2, features: ["codex-sessions"], events: 1, peakMb: 0 });
  });
});

describe("the first use", () => {
  it("is remembered once, with when it came and from which CLI", () => {
    const { t, later } = tallyAt();
    expect(t.firstUse()).toBeNull();
    const heard: unknown[] = [];
    t.onFirstUse((f: unknown) => heard.push(f));
    t.noteUse({ session_id: "c1", provider: "codex" });
    later(HOUR);
    t.noteUse({ session_id: "s2" });
    expect(t.firstUse()).toEqual({ at: "2026-09-30T10:00:00.000Z", provider: "codex" });
    expect(heard).toEqual([{ at: "2026-09-30T10:00:00.000Z", provider: "codex" }]);
    // A listener that arrives late hears it at once.
    const late: unknown[] = [];
    t.onFirstUse((f: unknown) => late.push(f));
    expect(late.length).toBe(1);
  });

  it("is not something that was not a session", () => {
    const { t } = tallyAt();
    t.noteUse({});
    t.noteFolder("/home/u/shop");
    expect(t.firstUse()).toBeNull();
  });
});

describe("the features a day used", () => {
  it("are names off the fixed list, once each, and nothing else", () => {
    const { t, later } = tallyAt();
    expect(t.noteFeature("usage-history")).toBe(true);
    t.noteFeature("usage-history");
    t.noteFeature("account-switch");
    expect(t.noteFeature("rm -rf /")).toBe(false);
    expect(t.noteFeature("")).toBe(false);
    later(24 * HOUR);
    expect(t.finished("2026-10-01")?.features).toEqual(["usage-history", "account-switch"]);
  });

  it("say which CLI the day's sessions came from, without being told", () => {
    const { t, later } = tallyAt();
    t.noteUse({ session_id: "s1" });
    t.noteUse({ session_id: "c1", provider: "codex" });
    later(24 * HOUR);
    expect(t.finished("2026-10-01")?.features).toEqual(["claude-sessions", "codex-sessions"]);
  });

  it("survive a restart the same day, and never carry a name off the list back in", () => {
    const { t: before } = tallyAt();
    before.noteFeature("feedback");
    const saved = before.saved();
    saved.current.features.push("not-a-feature");
    const { t, later } = tallyAt("2026-09-30T12:00:00Z");
    t.noteFeature("claude-fm");
    t.restore(saved);
    later(24 * HOUR);
    expect(t.finished("2026-10-01")?.features).toEqual(["feedback", "claude-fm"]);
  });

  it("are the same list the page names, no more", () => {
    // The page's PageFeature union is its half of FEATURES; a name the server
    // does not know would be refused at /api/feature and never counted.
    const page = readFileSync(new URL("../feature-use.ts", import.meta.url), "utf8");
    const union = page.slice(page.indexOf("export type PageFeature"), page.indexOf(";", page.indexOf("export type PageFeature")));
    const named = [...union.matchAll(/"([a-z-]+)"/g)].map(m => m[1]);
    expect(named.length).toBeGreaterThan(10);
    for (const name of named) expect(FEATURES).toContain(name);
  });
});
