// #1811: a session that stopped to ask a question was announced as "waiting for
// your permission".
//
// The sentence was written when only permission prompts were alarms. `asked`
// joined them later (ambient-counts.ts), and the announcement kept saying
// permission — on a bypassPermissions machine, about every block it ever
// announced. A screen-reader user went looking for a prompt that was not there.
// The sentence now says what the session is waiting for, and says it neutrally
// when the blocked sessions are waiting for different things.
import { describe, it, expect } from "vitest";
import { blockedAnnouncement } from "../block-announce";
import { blockedSessions } from "../ambient-counts";
import type { AgentNodeData, WaitingBlock } from "../types";

const root = (label: string, kind: WaitingBlock["kind"], since: number): AgentNodeData => ({
  id: label,
  sessionId: label,
  label,
  kind: "root",
  state: "active",
  startedAt: 1_000,
  tools: [],
  prompts: [],
  toolCount: 0,
  childCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  waiting: { kind, message: kind === "asked" ? "Which branch should I use?" : "Claude needs your permission", since },
} as AgentNodeData);

const say = (...agents: AgentNodeData[]) => blockedAnnouncement(blockedSessions(agents));

describe("what a blocked session is announced as waiting for (#1811)", () => {
  it("says a question is waiting for an answer, not for permission", () => {
    const said = say(root("docs", "asked", 1));
    expect(said).not.toContain("permission");
    expect(said).toBe("docs is waiting for your answer.");
  });

  it("still says permission for a permission prompt", () => {
    expect(say(root("docs", "permission", 1))).toBe("docs is waiting for your permission.");
  });

  it("says the kind the sessions share when there are several", () => {
    expect(say(root("api", "asked", 1), root("web", "asked", 2))).toBe("api and 1 more session are waiting for your answer.");
    expect(say(root("api", "permission", 1), root("web", "permission", 2), root("cli", "permission", 3)))
      .toBe("api and 2 more sessions are waiting for your permission.");
  });

  it("names neither when they are waiting for different things", () => {
    const said = say(root("api", "permission", 1), root("web", "asked", 2));
    expect(said).toBe("api and 1 more session are waiting for you.");
    expect(say(root("api", "asked", 1), root("web", "permission", 2))).toBe("api and 1 more session are waiting for you.");
  });

  it("leaves an idle session out of the sentence, as it is out of the count", () => {
    expect(say(root("api", "asked", 1), root("web", "idle", 2))).toBe("api is waiting for your answer.");
  });
});
