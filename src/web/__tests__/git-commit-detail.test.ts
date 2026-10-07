// One commit as the inspector's Commit tab reads it: who wrote it and who
// committed it (two people, two times, when a commit was applied by someone
// else), and the whole message after its subject — trailers kept, blank lines
// at the end dropped, a body past the cap cut on a character and said to be.
// Against real repositories, through the same read the route answers with.
import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { commitAll, repoWith, sh, tempDir, write } from "./git-fixture";

const HOME = tempDir("ccdeck-git-commit-detail-home-");
const KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;
const prev = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.XDG_CONFIG_HOME = join(HOME, ".config");

// @ts-expect-error — plain .mjs server module, no types
const { readCommit, parseCommitRecord, BODY_MAX } = await import("../../server/git-reads.mjs");

const made: string[] = [HOME];
const track = (dir: string) => { made.push(dir); return dir; };
afterAll(() => {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  for (const dir of made) rmTempDir(dir);
});

/** Commit everything with `message` as written by someone else, at another time. */
function commitAs(dir: string, message: string, author: string, authorDate: string): string {
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-q", "--allow-empty", "--cleanup=verbatim", `--author=${author}`, `--date=${authorDate}`, "-F", "-"], message, "2026-03-04T05:06:07Z");
  return sh(dir, ["rev-parse", "HEAD"]).trim();
}

describe("readCommit's committer and body", () => {
  it("names the committer apart from the author, each with their own time", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    write(dir, { "a.txt": "two\n" });
    const sha = commitAs(dir, "fix(api): round half up\n", "Grace Hopper <grace@example.com>", "2025-12-01T10:00:00Z");
    const r = await readCommit(dir, sha);
    expect(r.ok).toBe(true);
    expect(r.commit.author).toEqual({ name: "Grace Hopper", email: "grace@example.com" });
    expect(Date.parse(r.commit.date)).toBe(Date.parse("2025-12-01T10:00:00Z"));
    expect(r.commit.committer.name).toBe("Ada Lovelace");
    expect(r.commit.committer.email).toBe("ada@example.com");
    expect(Date.parse(r.commit.committer.date)).toBe(Date.parse("2026-03-04T05:06:07Z"));
    // Strict ISO, as the author's date is.
    expect(r.commit.committer.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$|Z$/);
  });

  it("answers the whole message after the subject, trailers kept and the last blank lines dropped", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    write(dir, { "a.txt": "two\n" });
    const message = [
      "feat(auth): issue a session cookie",
      "",
      "The cookie is HttpOnly and SameSite=Lax.",
      "  Indented lines stay as they are.",
      "",
      "Second paragraph.",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "",
      "",
    ].join("\n");
    const sha = commitAs(dir, message, "Ada Lovelace <ada@example.com>", "2026-01-02T03:04:05Z");
    const r = await readCommit(dir, sha);
    expect(r.commit.subject).toBe("feat(auth): issue a session cookie");
    expect(r.commit.body).toBe([
      "The cookie is HttpOnly and SameSite=Lax.",
      "  Indented lines stay as they are.",
      "",
      "Second paragraph.",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
    ].join("\n"));
    expect(r.commit.clipped).toBeUndefined();
    // The record keeps the shape readLog gives it.
    expect(r.commit.trailers).toEqual([{ key: "Co-Authored-By", value: "Claude <noreply@anthropic.com>" }]);
    expect(r.commit.parents).toHaveLength(1);
  });

  it("answers an empty body for a subject-only commit, and keeps a unit separator inside the body", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const plain = commitAll(dir, "chore: nothing else to say");
    expect((await readCommit(dir, plain)).commit.body).toBe("");
    const odd = commitAs(dir, "odd\n\nbefore\x1fafter\n", "Ada Lovelace <ada@example.com>", "2026-01-02T03:04:05Z");
    expect((await readCommit(dir, odd)).commit.body).toBe("before\x1fafter");
  });

  it("cuts a body past the cap on a whole character and says it was cut", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    // Three-byte characters, so the cap falls inside one.
    const long = "€".repeat(Math.ceil(BODY_MAX / 3) + 10);
    const sha = commitAs(dir, `big\n\n${long}\n`, "Ada Lovelace <ada@example.com>", "2026-01-02T03:04:05Z");
    const r = await readCommit(dir, sha);
    expect(r.commit.clipped).toBe(true);
    expect(Buffer.byteLength(r.commit.body)).toBeLessThanOrEqual(BODY_MAX);
    expect(Buffer.byteLength(r.commit.body)).toBeGreaterThan(BODY_MAX - 3);
    expect(r.commit.body).toMatch(/^€+$/);
  });

  it("parses nothing that is not a whole record", () => {
    expect(parseCommitRecord("")).toBeNull();
    expect(parseCommitRecord("not\x1fenough\x1ffields")).toBeNull();
    const sha = "a".repeat(40);
    expect(parseCommitRecord(["nothex", "", "n", "e", "d", "cn", "ce", "cd", "s", ""].join("\x1f"))).toBeNull();
    expect(parseCommitRecord([sha, "", "n", "e", "d", "cn", "ce", "cd", "s", "b"].join("\x1f"))).toMatchObject({
      sha, author: { name: "n", email: "e" }, committer: { name: "cn", email: "ce", date: "cd" }, subject: "s", body: "b",
    });
  });
});
