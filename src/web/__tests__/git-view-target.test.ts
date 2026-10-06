// Which repository the git view opens on, and when it does not open at all.
import { describe, expect, it } from "vitest";
import { gitFactsFor, gitFocus, gitViewOpens, subagentKey } from "../git-view-target";
import type { GitFacts } from "../types";

const repo: GitFacts = { state: "repo", branch: "develop", stale: 0 };

describe("the repository an agent's view is about", () => {
  it("is the agent's own when it has one, else its session's", () => {
    const own: GitFacts = { state: "repo", branch: "docs", stale: 0 };
    expect(gitFactsFor({ git: own }, { git: repo })).toBe(own);
    expect(gitFactsFor({}, { git: repo })).toBe(repo);
    expect(gitFactsFor({}, null)).toBeUndefined();
  });
});

describe("whether the view opens", () => {
  it("opens on a repository, and before the server has said anything", () => {
    expect(gitViewOpens(repo)).toBe(true);
    expect(gitViewOpens(undefined)).toBe(true);
  });

  it("does not open on a folder git cannot read", () => {
    for (const state of ["not-a-repo", "no-git", "bare", "unsafe", "gone"] as const) {
      expect(gitViewOpens({ state, stale: 0 }), state).toBe(false);
    }
  });
});

describe("whose work it shows", () => {
  const root = { id: "s1", sessionId: "s1", kind: "root" as const };
  const sub = { id: "s1::a4f1", sessionId: "s1", kind: "subagent" as const };

  it("shows a session's whole team from its main node", () => {
    expect(gitFocus(root, false)).toEqual({ sessionId: "s1", agentIds: null });
    expect(subagentKey(root)).toBeNull();
  });

  it("narrows to a subagent from its node, until widened", () => {
    expect(subagentKey(sub)).toBe("a4f1");
    expect(gitFocus(sub, false)).toEqual({ sessionId: "s1", agentIds: ["a4f1"] });
    expect(gitFocus(sub, true)).toEqual({ sessionId: "s1", agentIds: null });
  });
});
