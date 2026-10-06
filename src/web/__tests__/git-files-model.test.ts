// The file list as rows: every change git reports, the focused agent's files
// first under its name, the rest quieter below — from the fixture worktree
// where api-fix and its subagent test-writer left every kind of change.
import { describe, expect, it } from "vitest";
import { changeMark, commitRows, fileKey, pathCounts, rowOrder, uncommittedList, type GitEdit, type StatusEntry } from "../git-files-model";

const ENTRIES: StatusEntry[] = [
  { path: "data/products.csv", area: "unstaged", change: "modified" },
  { path: "package-lock.json", area: "unstaged", change: "modified" },
  { path: "public/logo.png", area: "unstaged", change: "modified" },
  { path: "src/auth/jwt.ts", area: "staged", change: "renamed", from: "src/auth/token.ts" },
  { path: "src/auth/password.ts", area: "staged", change: "added" },
  { path: "src/auth/session.ts", area: "staged", change: "modified" },
  { path: "src/auth/session.ts", area: "unstaged", change: "modified" },
  { path: "src/generated/api-types.ts", area: "unstaged", change: "modified" },
  { path: "src/legacy/basic-auth.ts", area: "unstaged", change: "deleted" },
  { path: "scratch", area: "untracked", change: "untracked", directory: true },
  { path: "src/auth/oauth-callback.ts", area: "untracked", change: "untracked" },
  { path: "test/auth/session.test.ts", area: "untracked", change: "untracked" },
];

const TW = "a4f1c9e27b3d5086";
const EDITS: GitEdit[] = [
  { path: "test/auth/session.test.ts", agentId: TW, label: "test-writer", at: 5 },
  { path: "src/auth/oauth-callback.ts", agentId: null, label: "api-fix", at: 4 },
  { path: "src/auth/session.ts", agentId: null, label: "api-fix", at: 3 },
  { path: "src/auth/password.ts", agentId: null, label: "api-fix", at: 2 },
  { path: "src/routes/login.ts", agentId: null, label: "api-fix", at: 1 },
];

const TEAM = { sessionId: "e3200d5a", agentIds: null };
const paths = (rows: { path: string; area: string }[]) => rows.map(r => `${r.area[0]}:${r.path}`);

describe("the uncommitted list, for the whole session", () => {
  const list = uncommittedList(ENTRIES, EDITS, TEAM, [], "api-fix");

  it("puts the files the session's agents edited first, the rest below", () => {
    expect(paths(list.mine)).toEqual([
      "s:src/auth/password.ts", "s:src/auth/session.ts", "u:src/auth/session.ts",
      "u:src/auth/oauth-callback.ts", "u:test/auth/session.test.ts",
    ]);
    expect(list.other.map(r => r.path)).toEqual([
      "data/products.csv", "package-lock.json", "public/logo.png", "src/auth/jwt.ts",
      "src/generated/api-types.ts", "src/legacy/basic-auth.ts", "scratch",
    ]);
    expect(rowOrder(list).length).toBe(ENTRIES.length);
  });

  it("names the session and says its subagents are in it", () => {
    expect(list.label).toBe("Edited by api-fix and its subagents");
    expect(uncommittedList(ENTRIES, EDITS.filter(e => e.agentId === null), TEAM, [], "api-fix").label).toBe("Edited by api-fix");
  });

  it("tags a file a subagent edited with the subagent's name", () => {
    expect(list.mine.find(r => r.path === "test/auth/session.test.ts")?.sub).toBe("test-writer");
    expect(list.mine.find(r => r.path === "src/auth/password.ts")?.sub).toBeNull();
  });

  it("lists a file staged and changed again twice, both rows tagged with their stage", () => {
    const session = list.mine.filter(r => r.path === "src/auth/session.ts");
    expect(session.map(r => r.stage)).toEqual(["staged", "unstaged"]);
    expect(new Set(session.map(r => r.key)).size).toBe(2);
    // A file unstaged alone needs no tag; a staged one always says so.
    expect(list.other.find(r => r.path === "data/products.csv")?.stage).toBeNull();
    expect(list.mine.find(r => r.path === "src/auth/password.ts")?.stage).toBe("staged");
  });

  it("counts a file staged and unstaged once", () => {
    expect(list.files).toBe(11);
  });

  it("gives every change its letter and its word", () => {
    expect(changeMark("untracked")).toEqual({ letter: "U", word: "untracked" });
    expect(changeMark("conflict")).toEqual({ letter: "!", word: "conflict" });
    expect(changeMark("something new")).toEqual({ letter: "M", word: "modified" });
    const jwt = list.other.find(r => r.path === "src/auth/jwt.ts")!;
    expect(jwt).toMatchObject({ letter: "R", word: "renamed", from: "src/auth/token.ts" });
  });

  it("collapses lock and generated files, never a folder", () => {
    const by = (p: string) => rowOrder(list).find(r => r.path === p)!;
    expect(by("package-lock.json").collapsed).toBe("lock");
    expect(by("src/generated/api-types.ts").collapsed).toBe("generated");
    expect(by("scratch")).toMatchObject({ collapsed: null, directory: true });
    expect(by("src/auth/session.ts").collapsed).toBeNull();
  });

  it("has no counts for a status entry the server sent none for", () => {
    expect(list.mine[0].counts).toBeNull();
    expect(list.counted).toBe(false);
    const withCounts = uncommittedList([{ path: "a.ts", area: "unstaged", change: "modified", added: 3, removed: 1 }], [], TEAM, []);
    expect(withCounts.other[0].counts).toEqual({ added: 3, removed: 1, binary: false });
  });

  it("carries the counts the status sent, like a commit's files: per side, binary marked", () => {
    const counted = uncommittedList([
      { path: "src/auth/session.ts", area: "staged", change: "modified", added: 12, removed: 3, binary: false },
      { path: "src/auth/session.ts", area: "unstaged", change: "modified", added: 1204, removed: 0, binary: false },
      { path: "public/logo.png", area: "unstaged", change: "modified", added: 0, removed: 0, binary: true },
      { path: "scratch", area: "untracked", change: "untracked", directory: true },
    ], [], TEAM, []);
    expect(counted.other.map(r => r.counts)).toEqual([
      { added: 12, removed: 3, binary: false },
      { added: 1204, removed: 0, binary: false },
      { added: 0, removed: 0, binary: true },
      null,
    ]);
    // A row with nothing known keeps the column, so the stage tags line up.
    expect(counted.counted).toBe(true);
  });
});

describe("one file's counts, as the glance says them", () => {
  const e = (area: string, extra: Partial<StatusEntry>): StatusEntry => ({ path: "src/a.ts", area, change: "modified", ...extra });

  it("adds a file's staged and unstaged counts together, as one file changed", () => {
    expect(pathCounts([e("staged", { added: 12, removed: 3 }), e("unstaged", { added: 4, removed: 1 }), { path: "b.ts", area: "unstaged", change: "modified", added: 9, removed: 9 }], "src/a.ts"))
      .toEqual({ added: 16, removed: 4, binary: false });
  });

  it("calls a file binary when either side is, and knows nothing when a side is unknown", () => {
    expect(pathCounts([e("staged", { added: 0, removed: 0, binary: true }), e("unstaged", { added: 2, removed: 0 })], "src/a.ts")).toEqual({ added: 0, removed: 0, binary: true });
    expect(pathCounts([e("staged", { added: 1, removed: 0 }), e("unstaged", {})], "src/a.ts")).toBeNull();
    expect(pathCounts([], "src/a.ts")).toBeNull();
  });
});

describe("marks that follow a file", () => {
  it("finds a renamed file's edits under its old name", () => {
    const edits: GitEdit[] = [{ path: "src/auth/token.ts", agentId: null, label: "api-fix", at: 1 }];
    const list = uncommittedList(ENTRIES, edits, TEAM, [], "api-fix");
    expect(list.mine.map(r => r.path)).toEqual(["src/auth/jwt.ts"]);
  });

  it("marks an untracked folder when an agent wrote a file inside it", () => {
    const edits: GitEdit[] = [{ path: "scratch/login-notes.md", agentId: null, label: "api-fix", at: 1 }];
    expect(uncommittedList(ENTRIES, edits, TEAM, [], "api-fix").mine.map(r => r.path)).toEqual(["scratch"]);
  });

  it("puts a sharp collision on the file it names, under either name of a rename", () => {
    const list = uncommittedList(ENTRIES, EDITS, TEAM, [{ path: "src/auth/session.ts", with: "rate-review" }, { path: "src/auth/token.ts", with: "docs" }], "api-fix");
    expect(list.mine.filter(r => r.clash).map(r => `${r.area}:${r.clash}`)).toEqual(["staged:rate-review", "unstaged:rate-review"]);
    expect(list.other.find(r => r.path === "src/auth/jwt.ts")?.clash).toBe("docs");
  });
});

describe("the uncommitted list, from a subagent", () => {
  const list = uncommittedList(ENTRIES, EDITS, { sessionId: "e3200d5a", agentIds: [TW] }, [], "test-writer");

  it("keeps only the subagent's files first, and names it alone", () => {
    expect(list.mine.map(r => r.path)).toEqual(["test/auth/session.test.ts"]);
    expect(list.label).toBe("Edited by test-writer");
    expect(list.mine[0].sub).toBeNull();
  });

  it("tags the session's other files with who edited them", () => {
    expect(list.other.find(r => r.path === "src/auth/password.ts")?.other).toBe("api-fix");
    expect(list.other.find(r => r.path === "data/products.csv")?.other).toBeNull();
  });

  it("falls back to the subagent's label when the card's name is not given", () => {
    expect(uncommittedList(ENTRIES, EDITS, { sessionId: "e", agentIds: [TW] }, []).label).toBe("Edited by test-writer");
  });
});

describe("a commit's files", () => {
  it("keeps git's order, with counts and the binary flag", () => {
    const rows = commitRows([
      { path: "src/routes/login.ts", change: "added", added: 42, removed: 0, binary: false },
      { path: "public/logo.png", change: "modified", added: 0, removed: 0, binary: true },
      { path: "src/auth/jwt.ts", from: "src/auth/token.ts", change: "renamed", added: 1, removed: 1, binary: false },
    ]);
    expect(rows.map(r => r.key)).toEqual([fileKey({ path: "src/routes/login.ts", area: "commit" }), "commit:public/logo.png", "commit:src/auth/jwt.ts"]);
    expect(rows[1].counts).toEqual({ added: 0, removed: 0, binary: true });
    expect(rows[2]).toMatchObject({ letter: "R", from: "src/auth/token.ts", stage: null, marked: false });
  });
});
