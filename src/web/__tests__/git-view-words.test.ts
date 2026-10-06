// What the git view and the glance say: a branch's standing, the collisions
// that concern the agent in view, the three marks a commit can carry, and the
// one line for a folder with no repository to show.
import { describe, expect, it } from "vitest";
import {
  collisionCardId, collisionsFor, commitMark, commitWho, readStateLine, shortAge, subjectParts, upstreamWords,
} from "../git-view-words";
import type { GitCollisions } from "../types";

const head = { branch: "feature/x", detached: false, sha: "abc", short: "abc", unborn: false };

describe("the branch against its upstream", () => {
  it("says ahead and behind as of the last fetch, and that the deck never fetches", () => {
    const w = upstreamWords({ head, upstream: { name: "origin/x", ahead: 4, behind: 1, gone: false } });
    expect(w).toEqual({ text: "↑4 ↓1", title: "Against origin/x, as of the last fetch. ccdeck never fetches.", word: false });
  });

  it("says up to date, no upstream, and a gone upstream in words", () => {
    expect(upstreamWords({ head, upstream: { name: "origin/x", ahead: 0, behind: 0, gone: false } })?.text).toBe("up to date");
    expect(upstreamWords({ head, upstream: null })?.text).toBe("no upstream");
    expect(upstreamWords({ head, upstream: { name: "origin/x", ahead: 0, behind: 0, gone: true } })?.text).toBe("upstream gone");
  });

  it("says nothing for a detached HEAD, which has no branch to stand", () => {
    expect(upstreamWords({ head: { ...head, detached: true, branch: null }, upstream: null })).toBeNull();
  });
});

describe("the collisions that concern the agent in view", () => {
  const c: GitCollisions = {
    quiet: [
      { agentId: null, with: { sessionId: "s2", agentId: null }, reason: "same-worktree", branch: "develop" },
      { agentId: null, with: { sessionId: "s3", agentId: null }, reason: "same-branch", branch: "develop" },
    ],
    sharp: [
      { agentId: null, with: { sessionId: "s2", agentId: null }, files: ["src/app.ts"] },
      { agentId: "a1", with: { sessionId: "s4", agentId: "b" }, files: ["x.ts"] },
    ],
  };

  it("puts a sharp one first and folds a quiet one with the same agent into it", () => {
    const team = collisionsFor(c, { sessionId: "s1", agentIds: null });
    expect(team.map(x => [x.level, x.with.sessionId])).toEqual([["sharp", "s2"], ["sharp", "s4"], ["quiet", "s3"]]);
    expect(team[0].files).toEqual(["src/app.ts"]);
  });

  it("keeps a subagent's own when the view is narrowed to it", () => {
    expect(collisionsFor(c, { sessionId: "s1", agentIds: ["a1"] }).map(x => x.with.sessionId)).toEqual(["s4"]);
    expect(collisionsFor(undefined, { sessionId: "s1", agentIds: null })).toEqual([]);
  });

  it("names the other agent's card", () => {
    expect(collisionCardId({ sessionId: "s4", agentId: "b" })).toBe("s4::b");
    expect(collisionCardId({ sessionId: "s2", agentId: null })).toBe("s2");
  });
});

describe("who made a commit, and how the deck knows", () => {
  it("carries one of three marks, each named", () => {
    expect(commitMark({ sessionId: "s", agentId: null, label: "api-fix", confidence: "seen" })).toEqual({ level: "seen", words: "seen by ccdeck" });
    expect(commitMark({ agent: "claude", confidence: "trailer" })).toEqual({ level: "trailer", words: "from the commit message" });
    expect(commitMark(null)).toEqual({ level: "round", words: "no agent seen" });
  });

  it("names the agent by its label, its card's name when it has none, or the CLI a trailer names", () => {
    const card = (id: string) => (id === "s1" ? "rate-review" : null);
    expect(commitWho({ sessionId: "s1", agentId: null, label: null, confidence: "seen" }, card)).toBe("rate-review");
    expect(commitWho({ sessionId: "s1", agentId: null, label: "api-fix", confidence: "seen" }, card)).toBe("api-fix");
    expect(commitWho({ agent: "codex", confidence: "trailer" }, card)).toBe("Codex");
    expect(commitWho(null, card)).toBeNull();
  });
});

describe("the small words", () => {
  it("has one line for each folder with no repository to show", () => {
    for (const s of ["not-a-repo", "gone", "no-git", "bare", "unsafe", "timeout", "error", "off"] as const) {
      expect(readStateLine(s, "~/code/notes")?.lead, s).toBeTruthy();
    }
    expect(readStateLine("not-a-repo", "~/code/notes")).toEqual({ folder: "~/code/notes", lead: "is not a git repository.", rest: "" });
    expect(readStateLine("not-a-repo", null)?.lead).toBe("This folder is not a git repository.");
    expect(readStateLine("repo", null)).toBeNull();
  });

  it("ages a commit in a dense row's words", () => {
    expect(shortAge(0, 30_000)).toBe("now");
    expect(shortAge(0, 4 * 60_000)).toBe("4m");
    expect(shortAge(0, 3 * 3_600_000)).toBe("3h");
    expect(shortAge(0, 2 * 86_400_000)).toBe("2d");
  });

  it("splits a conventional prefix from the subject", () => {
    expect(subjectParts("feat(api): add sliding-window rate limiter")).toEqual({ prefix: "feat(api):", rest: "add sliding-window rate limiter" });
    expect(subjectParts("Merge branch 'x' into 'develop'")).toEqual({ prefix: "", rest: "Merge branch 'x' into 'develop'" });
  });
});
