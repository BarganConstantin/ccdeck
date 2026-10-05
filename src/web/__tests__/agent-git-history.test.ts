// Two readers of commit history the deck did not watch being written, or that
// was rewritten after it was: the agent trailers in a commit message (a weaker
// mark, "from the commit message"), and the match that carries a stored
// commit's attribution across an amend, rebase or squash.
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { trailerAttribution } from "../../server/agent-git-trailers.mjs";
// @ts-expect-error — .mjs server module, no types
import { attributeCommits, matchRewritten } from "../../server/agent-git-rewrite.mjs";

const msg = (...paragraphs: string[]) => paragraphs.join("\n\n") + "\n";

describe("trailerAttribution", () => {
  it("reads Claude's co-author trailer in its spellings", () => {
    for (const t of [
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "Co-authored-by: Claude Opus 4.5 <noreply@anthropic.com>",
      "co-authored-by:Claude Code <claude@anthropic.com>",
      "Co-Authored-By: Claude",
      "Co-authored-by: Someone <bot@anthropic.com>",
    ]) {
      expect(trailerAttribution(msg("feat: x", "Body.", t)), t).toEqual({ agent: "claude", source: "trailer", trailer: "co-authored-by" });
    }
  });

  it("reads Codex's co-author trailer", () => {
    for (const t of ["Co-authored-by: Codex <noreply@openai.com>", "Co-Authored-By: codex", "Co-authored-by: OpenAI Codex <codex@openai.com>"]) {
      expect(trailerAttribution(msg("fix: y", t)), t).toEqual({ agent: "codex", source: "trailer", trailer: "co-authored-by" });
    }
  });

  it("reads a Claude-Session trailer", () => {
    expect(trailerAttribution(msg("chore: z", "Claude-Session: https://claude.ai/code/session_01AbC")))
      .toEqual({ agent: "claude", source: "trailer", trailer: "claude-session" });
    expect(trailerAttribution(msg("chore: z", "claude-session : abc"))).toMatchObject({ agent: "claude" });
  });

  it("reads only the trailer block — the last paragraph — and CRLF messages", () => {
    // Prose that merely mentions the trailer is not one.
    expect(trailerAttribution(msg("docs: attribution", "Co-Authored-By: Claude is what Claude Code adds.", "Signed-off-by: A <a@x>"))).toBeNull();
    expect(trailerAttribution("feat: x\r\n\r\nBody\r\n\r\nCo-authored-by: Codex <noreply@openai.com>\r\n")).toMatchObject({ agent: "codex" });
    // A subject alone has no trailer block.
    expect(trailerAttribution("Co-Authored-By: Claude")).toBeNull();
    // Trailing blank lines and comment lines do not hide the block.
    expect(trailerAttribution("feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n# a comment\n\n\n")).toMatchObject({ agent: "claude" });
  });

  it("takes the first agent the block names", () => {
    expect(trailerAttribution(msg("feat: both", "Co-authored-by: Codex <noreply@openai.com>\nCo-Authored-By: Claude <noreply@anthropic.com>")))
      .toMatchObject({ agent: "codex" });
  });

  it("accepts trailer lines or key/value pairs already split out of the message", () => {
    expect(trailerAttribution(["Signed-off-by: A <a@x>", "Co-Authored-By: Claude <noreply@anthropic.com>"])).toMatchObject({ agent: "claude" });
    expect(trailerAttribution([{ key: "Co-authored-by", value: "Codex <noreply@openai.com>" }])).toMatchObject({ agent: "codex" });
  });

  it("names no agent for other co-authors, other trailers, or junk", () => {
    for (const m of [
      msg("feat: x", "Co-authored-by: Jane Doe <jane@example.com>"),
      msg("feat: x", "Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>"),
      msg("feat: x", "Reviewed-by: Claude Shannon <claude@bell-labs.com>"),
      msg("feat: x", "Co-authored-by: Claudette <c@example.com>"),
      "", null, 42, {}, [], [null, 3],
    ]) expect(trailerAttribution(m), String(m)).toBeNull();
  });
});

// ── the rewrite fallback ─────────────────────────────────────────────────────

const T = 1_760_000_000_000; // ms
const sha = (c: string) => c.repeat(40).slice(0, 40);
type Commit = { sha: string; subject: string; authorTime: number; branch?: string | null };

const record = (s: string, extra: Record<string, unknown> = {}) => ({
  v: 1, repo: "/r/.git", sha: s, shaFull: s.length === 40, subject: "feat: thing", authorTime: T, branch: "agent/x",
  sessionId: "s1", agentId: null, kind: "claude", at: T + 100, confidence: "seen", ...extra,
});

describe("attributeCommits", () => {
  it("marks a commit whose SHA is stored as seen, full or short", () => {
    const commits: Commit[] = [{ sha: sha("a"), subject: "feat: thing", authorTime: T, branch: "agent/x" }, { sha: sha("b"), subject: "other", authorTime: T + 5000 }];
    const got = attributeCommits([record(sha("a")), record("bbbbbbb", { subject: "other", authorTime: null })], commits);
    expect(got.get(sha("a"))).toMatchObject({ confidence: "seen", record: { sha: sha("a") } });
    expect(got.get(sha("b"))).toMatchObject({ confidence: "seen", record: { sha: "bbbbbbb" } });
    expect(got.size).toBe(2);
  });

  it("carries an amended or rebased commit's attribution over by subject and author time", () => {
    const rewritten: Commit = { sha: sha("c"), subject: "feat: thing", authorTime: T, branch: "agent/x" };
    const got = attributeCommits([record(sha("a"))], [rewritten]);
    expect(got.get(sha("c"))).toMatchObject({ confidence: "matched", record: { sha: sha("a") } });
    // Author time in seconds, as git prints %at, matches too.
    expect(attributeCommits([record(sha("a"))], [{ ...rewritten, authorTime: T / 1000 }]).get(sha("c"))?.confidence).toBe("matched");
    // No branch known on either side does not block it.
    expect(attributeCommits([record(sha("a"), { branch: null })], [rewritten]).get(sha("c"))?.confidence).toBe("matched");
    expect(attributeCommits([record(sha("a"))], [{ ...rewritten, branch: null }]).get(sha("c"))?.confidence).toBe("matched");
  });

  it("never matches across branches, subjects or seconds", () => {
    const base: Commit = { sha: sha("c"), subject: "feat: thing", authorTime: T, branch: "agent/x" };
    for (const c of [{ ...base, branch: "main" }, { ...base, subject: "feat: thing (amended)" }, { ...base, authorTime: T + 1000 }]) {
      expect(attributeCommits([record(sha("a"))], [c]).size, JSON.stringify(c)).toBe(0);
    }
  });

  it("never matches an ambiguous case", () => {
    const twin = (s: string): Commit => ({ sha: sha(s), subject: "feat: thing", authorTime: T, branch: "agent/x" });
    // Two current commits fit one record.
    expect(attributeCommits([record(sha("a"))], [twin("c"), twin("d")]).size).toBe(0);
    // Two records fit one current commit.
    expect(attributeCommits([record(sha("a")), record(sha("b"), { sessionId: "s2" })], [twin("c")]).size).toBe(0);
    // A short SHA that is a prefix of two current commits.
    const pre = [{ sha: "abcdef1" + "0".repeat(33), subject: "x", authorTime: T }, { sha: "abcdef1" + "1".repeat(33), subject: "y", authorTime: T }];
    expect(attributeCommits([record("abcdef1", { authorTime: null })], pre).size).toBe(0);
    // A record that cannot be matched without an author time is not guessed at.
    expect(attributeCommits([record(sha("a"), { authorTime: null })], [twin("c")]).size).toBe(0);
    // Nor one with no subject.
    expect(attributeCommits([record(sha("a"), { subject: "" })], [{ ...twin("c"), subject: "" }]).size).toBe(0);
  });

  it("does not give a commit that is seen in its own right to an older record", () => {
    // `git commit --amend` recorded on its own: the amended commit is seen,
    // and the pre-amend record (same subject and time) must not take it.
    const amended: Commit = { sha: sha("c"), subject: "feat: thing", authorTime: T, branch: "agent/x" };
    const got = attributeCommits([record(sha("a")), record(sha("c"), { at: T + 900, agentId: "sub-1" })], [amended]);
    expect(got.get(sha("c"))).toMatchObject({ confidence: "seen", record: { agentId: "sub-1" } });
    expect(got.size).toBe(1);
  });

  it("answers an empty map for junk", () => {
    expect(attributeCommits(null, null).size).toBe(0);
    expect(attributeCommits([null, {}, record("zz")], [null, { sha: 5 }]).size).toBe(0);
  });
});

describe("matchRewritten", () => {
  it("lists only the matches made by the fallback", () => {
    const commits: Commit[] = [
      { sha: sha("a"), subject: "seen one", authorTime: T, branch: "agent/x" },
      { sha: sha("c"), subject: "feat: thing", authorTime: T + 60_000, branch: "agent/x" },
    ];
    const recs = [record(sha("a"), { subject: "seen one" }), record(sha("b"), { authorTime: T + 60_000 })];
    expect(matchRewritten(recs, commits)).toEqual([{ sha: sha("c"), record: recs[1], confidence: "matched" }]);
  });
});
