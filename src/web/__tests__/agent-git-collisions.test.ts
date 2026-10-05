// When two live agents can step on each other in git, in two levels: a quiet
// one (they share a working tree, or a branch of one repository) and a sharp
// one (running at the same time, both edited the same file since it was last
// committed). Different worktrees on different branches never collide.
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { collisionFacts } from "../../server/agent-git-collisions.mjs";

type Agent = {
  sessionId: string; agentId?: string | null; kind?: string; cwd?: string; live?: boolean;
  repo?: { top: string; commonDir: string } | null; branch?: string | null; edits?: { path: string; at: number }[];
};

const T = 1_760_000_000_000;
const MAIN = { top: "/w/app", commonDir: "/w/app/.git" };
const WT = { top: "/w/app-wt", commonDir: "/w/app/.git" };

const agent = (sessionId: string, extra: Partial<Agent> = {}): Agent => ({
  sessionId, agentId: null, kind: "claude", cwd: "/w/app", live: true, repo: MAIN, branch: "main", edits: [], ...extra,
});
const edit = (path: string, at = T) => ({ path, at });
const dirty = (...paths: string[]) => (p: string) => paths.includes(p);
const ends = (pairs: { a: { sessionId: string; agentId: string | null }; b: { sessionId: string; agentId: string | null } }[]) =>
  pairs.map(p => `${p.a.sessionId}/${p.a.agentId ?? "-"} ⇄ ${p.b.sessionId}/${p.b.agentId ?? "-"}`);

describe("quiet collisions", () => {
  it("two sessions in one working tree", () => {
    const { quiet, sharp } = collisionFacts([agent("s1"), agent("s2", { kind: "codex" })]);
    expect(quiet).toEqual([{ a: { sessionId: "s1", agentId: null }, b: { sessionId: "s2", agentId: null }, reason: "same-worktree", top: "/w/app", commonDir: "/w/app/.git", branch: "main" }]);
    expect(sharp).toEqual([]);
  });

  it("two sessions on one branch of one repository, in different worktrees", () => {
    const { quiet } = collisionFacts([agent("s1"), agent("s2", { repo: WT, cwd: "/w/app-wt" })]);
    expect(quiet).toEqual([{ a: { sessionId: "s1", agentId: null }, b: { sessionId: "s2", agentId: null }, reason: "same-branch", top: null, commonDir: "/w/app/.git", branch: "main" }]);
  });

  it("never different worktrees on different branches, nor two detached heads, nor separate repositories", () => {
    expect(collisionFacts([agent("s1"), agent("s2", { repo: WT, branch: "feature/x" })]).quiet).toEqual([]);
    expect(collisionFacts([agent("s1", { branch: null }), agent("s2", { repo: WT, branch: null })]).quiet).toEqual([]);
    expect(collisionFacts([agent("s1"), agent("s2", { repo: { top: "/other", commonDir: "/other/.git" } })]).quiet).toEqual([]);
  });

  it("not within one session: its subagents share its folder by design", () => {
    const { quiet } = collisionFacts([agent("s1"), agent("s1", { agentId: "sub-a" }), agent("s1", { agentId: "sub-b" })]);
    expect(quiet).toEqual([]);
  });

  it("names a subagent of one session that shares another session's worktree", () => {
    const { quiet } = collisionFacts([
      agent("s1", { repo: WT, branch: "feature/x" }),
      agent("s1", { agentId: "sub-a" }),
      agent("s2"),
    ]);
    expect(ends(quiet)).toEqual(["s1/sub-a ⇄ s2/-"]);
  });

  it("only between live agents with a repository", () => {
    expect(collisionFacts([agent("s1"), agent("s2", { live: false })]).quiet).toEqual([]);
    expect(collisionFacts([agent("s1"), agent("s2", { repo: null })]).quiet).toEqual([]);
  });
});

describe("sharp collisions", () => {
  it("two sessions that both edited one file since its last commit", () => {
    const facts = collisionFacts(
      [agent("s1", { edits: [edit("/w/app/src/a.ts", T + 10), edit("/w/app/src/b.ts", T + 20)] }),
        agent("s2", { edits: [edit("/w/app/src/a.ts", T + 30), edit("/w/app/src/b.ts", T + 40), edit("/w/app/c.ts")] })],
      { lastCommittedAt: (p: string) => (p === "/w/app/src/b.ts" ? T + 25 : T) },
    );
    expect(facts.sharp).toEqual([{ a: { sessionId: "s1", agentId: null }, b: { sessionId: "s2", agentId: null }, files: ["/w/app/src/a.ts"] }]);
    // The quiet level still stands beside it.
    expect(facts.quiet).toHaveLength(1);
  });

  it("two subagents of one session, but not a session and its own subagent", () => {
    const facts = collisionFacts([
      agent("s1", { edits: [edit("/w/app/x.ts", T + 1)] }),
      agent("s1", { agentId: "sub-a", edits: [edit("/w/app/x.ts", T + 2)] }),
      agent("s1", { agentId: "sub-b", edits: [edit("/w/app/x.ts", T + 3)] }),
    ], { isDirty: dirty("/w/app/x.ts") });
    expect(ends(facts.sharp)).toEqual(["s1/sub-a ⇄ s1/sub-b"]);
    expect(facts.sharp[0].files).toEqual(["/w/app/x.ts"]);
  });

  it("uses 'currently dirty' when no commit times are given, and stays silent with neither", () => {
    const pair = [agent("s1", { edits: [edit("/w/app/a.ts"), edit("/w/app/b.ts")] }), agent("s2", { edits: [edit("/w/app/a.ts"), edit("/w/app/b.ts")] })];
    expect(collisionFacts(pair, { isDirty: dirty("/w/app/b.ts") }).sharp[0].files).toEqual(["/w/app/b.ts"]);
    expect(collisionFacts(pair).sharp).toEqual([]);
    // A file never committed has no last commit, and every edit to it counts.
    expect(collisionFacts(pair, { lastCommittedAt: () => null }).sharp[0].files).toEqual(["/w/app/a.ts", "/w/app/b.ts"]);
  });

  it("clears once the file is committed after both edits, or one agent is no longer live", () => {
    const pair = [agent("s1", { edits: [edit("/w/app/a.ts", T + 1)] }), agent("s2", { edits: [edit("/w/app/a.ts", T + 2)] })];
    expect(collisionFacts(pair, { lastCommittedAt: () => T + 3 }).sharp).toEqual([]);
    expect(collisionFacts([pair[0], { ...pair[1], live: false }], { lastCommittedAt: () => null }).sharp).toEqual([]);
  });

  it("never between different worktrees, whose files are different files", () => {
    const facts = collisionFacts([
      agent("s1", { branch: "a", edits: [edit("/w/app/src/a.ts")] }),
      agent("s2", { repo: WT, cwd: "/w/app-wt", branch: "b", edits: [edit("/w/app-wt/src/a.ts")] }),
    ], { lastCommittedAt: () => null });
    expect(facts).toEqual({ quiet: [], sharp: [] });
  });

  it("compares paths the way the platform does", () => {
    const pair = [
      agent("s1", { repo: { top: "C:\\W\\App", commonDir: "C:\\W\\App\\.git" }, edits: [edit("C:\\W\\App\\Src\\A.ts")] }),
      agent("s2", { repo: { top: "c:\\w\\app", commonDir: "c:\\w\\app\\.git" }, edits: [edit("c:/w/app/src/a.ts")] }),
    ];
    const win = collisionFacts(pair, { lastCommittedAt: () => null, platform: "win32" });
    expect(win.quiet.map((q: { reason: string }) => q.reason)).toEqual(["same-worktree"]);
    expect(win.sharp[0].files).toEqual(["C:\\W\\App\\Src\\A.ts"]);
    const linux = collisionFacts([
      agent("s1", { edits: [edit("/w/app/A.ts")] }), agent("s2", { edits: [edit("/w/app/a.ts")] }),
    ], { lastCommittedAt: () => null, platform: "linux" });
    expect(linux.sharp).toEqual([]);
  });

  it("ignores junk without throwing", () => {
    expect(collisionFacts(null)).toEqual({ quiet: [], sharp: [] });
    expect(collisionFacts([null, {}, { sessionId: 3 }, agent("s1", { edits: [null, { path: 5 }] as never })])).toEqual({ quiet: [], sharp: [] });
  });
});
