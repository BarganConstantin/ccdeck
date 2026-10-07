// What the history read says for the Fork look's marks, against real
// repositories: whether a commit's message has a body (the ↩ after its
// subject), which commits HEAD has not pushed to its upstream (the blue dot),
// and which upstream each branch follows (a branch and its upstream share one
// badge). The upstream is measured only when there is one to measure by, an
// upstream name is never read as an option, and the read writes nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { commitAll, emptyRepo, repoWith, sh, tempDir, write } from "./git-fixture";
import { sourceOf } from "./client-source";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-git-log-fork-"));
const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;
const prevEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");

// @ts-expect-error — plain .mjs server module, no types
const { readLog } = await import("../../server/git-reads.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { resolveRepo } = await import("../../server/git-repo.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");

const made: string[] = [DIR];
const track = (d: string) => { made.push(d); return d; };
const headOf = async (dir: string) => (await resolveRepo(dir)).head;
const log = async (dir: string) => {
  const r = await readLog(dir, await headOf(dir));
  expect(r.ok).toBe(true);
  return r.commits as Array<{ sha: string; subject: string; hasBody: boolean; unpushed?: boolean; refs: { local: string[]; remote: string[]; upstream?: Record<string, string> } }>;
};
const unpushed = async (dir: string) => (await log(dir)).filter(c => c.unpushed).map(c => c.subject);

/** A repository on `main` pushed to a bare origin it tracks, then `extra`
 *  commits made after the push. */
function tracked(extra: string[]): { dir: string; origin: string } {
  const origin = track(tempDir("ccdeck-git-log-fork-origin-"));
  sh(origin, ["init", "-q", "--bare", "-b", "main", "."]);
  const dir = track(repoWith({ "a.txt": "one\n" }));
  sh(dir, ["remote", "add", "origin", origin]);
  sh(dir, ["push", "-q", "-u", "origin", "main"]);
  extra.forEach((s, i) => { write(dir, { "a.txt": `${s}\n` }); commitAll(dir, s, `2026-01-0${i + 3}T03:04:05Z`); });
  return { dir, origin };
}

afterAll(() => {
  for (const k of KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  for (const d of made) rmTempDir(d);
});

describe("a log commit's body", () => {
  it("says whether the message has more than its subject, trailers included", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    write(dir, { "a.txt": "two\n" });
    sh(dir, ["add", "-A"]);
    sh(dir, ["commit", "-q", "-m", "feat: with a body\n\nWhy it changed."]);
    write(dir, { "a.txt": "three\n" });
    sh(dir, ["add", "-A"]);
    sh(dir, ["commit", "-q", "-m", "fix: only a trailer\n\nCo-Authored-By: Claude <noreply@anthropic.com>"]);
    write(dir, { "a.txt": "four\n" });
    commitAll(dir, "chore: subject alone");
    const by = new Map((await log(dir)).map(c => [c.subject, c.hasBody]));
    expect(by.get("feat: with a body")).toBe(true);
    expect(by.get("fix: only a trailer")).toBe(true);
    expect(by.get("chore: subject alone")).toBe(false);
    expect(by.get("first")).toBe(false);
  });
});

describe("the commits HEAD has not pushed", () => {
  it("flags what HEAD has and its upstream does not, and nothing once it is pushed", async () => {
    const { dir } = tracked(["second", "third"]);
    expect(await unpushed(dir)).toEqual(["third", "second"]);
    const commits = await log(dir);
    expect(commits.find(c => c.subject === "first")!.unpushed).toBeUndefined();
    sh(dir, ["push", "-q", "origin", "main"]);
    expect(await unpushed(dir)).toEqual([]);
  });

  it("names each branch's upstream on its commit, for the badge they share", async () => {
    const { dir } = tracked([]);
    sh(dir, ["branch", "side"]);
    const tip = (await log(dir))[0];
    expect(tip.refs.local.sort()).toEqual(["main", "side"]);
    expect(tip.refs.remote).toEqual(["origin/main"]);
    expect(tip.refs.upstream).toEqual({ main: "origin/main" });
  });

  it("flags nothing for a branch with no upstream, a detached HEAD, a gone upstream or one that is a local branch", async () => {
    const plain = track(repoWith({ "a.txt": "one\n" }));
    write(plain, { "a.txt": "two\n" });
    commitAll(plain, "second");
    expect(await unpushed(plain)).toEqual([]);
    expect((await log(plain)).every(c => c.refs.upstream === undefined)).toBe(true);

    const { dir: detached } = tracked(["second"]);
    sh(detached, ["checkout", "-q", "--detach", "HEAD"]);
    expect(await unpushed(detached)).toEqual([]);

    const { dir: gone } = tracked(["second"]);
    sh(gone, ["update-ref", "-d", "refs/remotes/origin/main"]);
    expect(await unpushed(gone)).toEqual([]);
    expect((await log(gone)).length).toBe(2);

    const local = track(repoWith({ "a.txt": "one\n" }));
    sh(local, ["branch", "base"]);
    sh(local, ["branch", "--set-upstream-to=base"]);
    write(local, { "a.txt": "two\n" });
    commitAll(local, "second");
    expect(await unpushed(local)).toEqual([]);
  });

  it("flags nothing for a branch only behind its upstream", async () => {
    const { dir, origin } = tracked([]);
    const other = join(track(tempDir("ccdeck-git-log-fork-other-")), "clone");
    sh(origin, ["clone", "-q", origin, other]);
    write(other, { "b.txt": "theirs\n" });
    commitAll(other, "theirs");
    sh(other, ["push", "-q", "origin", "main"]);
    sh(dir, ["fetch", "-q", "origin"]);
    expect(await unpushed(dir)).toEqual([]);
  });

  it("never reads an upstream's name as an option, and writes nothing while it reads", async () => {
    const dir = track(emptyRepo());
    write(dir, { "a.txt": "one\n" });
    commitAll(dir, "first");
    // A remote-tracking branch git accepts with an option's spelling.
    sh(dir, ["update-ref", "refs/remotes/origin/--output=stolen", "HEAD"]);
    sh(dir, ["config", "remote.origin.url", join(dir, "nowhere")]);
    sh(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    sh(dir, ["config", "branch.main.remote", "origin"]);
    sh(dir, ["config", "branch.main.merge", "refs/heads/--output=stolen"]);
    write(dir, { "a.txt": "two\n" });
    commitAll(dir, "second");
    const index = join(dir, ".git", "index");
    const before = { bytes: readFileSync(index), at: statSync(index).mtimeMs };
    expect(await unpushed(dir)).toEqual(["second"]);
    expect(existsSync(join(dir, "stolen"))).toBe(false);
    expect(readFileSync(index).equals(before.bytes)).toBe(true);
    expect(statSync(index).mtimeMs).toBe(before.at);
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
  });

  it("goes through the one way the deck runs git, the upstream spelled as a full ref", () => {
    const reads = readFileSync(new URL("../../server/git-reads.mjs", import.meta.url), "utf8");
    const fn = reads.slice(reads.indexOf("async function withUnpushed("), reads.indexOf("/** The window, and after it HEAD's own line"));
    expect(fn).toMatch(/await git\("rev-list", \[`--max-count=\$\{limit\}`, `refs\/remotes\/\$\{upstream\}\.\.HEAD`, "--"\], \{ cwd: topLevel \}\)/);
    expect(fn).not.toMatch(/execFile|spawn|@\{u/);
  });
});

describe("the log route", () => {
  let server: Server;
  let port = 0;
  let repo = "";

  const read = (path: string): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { "x-ccdeck-token": hookToken() } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(out || "null") }));
    });
    req.on("error", reject);
    req.end();
  });
  const event = (payload: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/event", method: "POST", headers: { "Content-Type": "application/json" } }, res => { res.resume(); res.on("end", () => resolve()); });
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });

  beforeAll(async () => {
    repo = tracked(["feat: unpushed\n\nwith a body"]).dir;
    server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
    port = (server.address() as AddressInfo).port;
    await event({ hook_event_name: "SessionStart", session_id: "S-fork", cwd: repo });
  });
  afterAll(async () => { await new Promise<void>(done => server.close(() => done())); });

  it("answers each commit with hasBody, and unpushed on what HEAD has not pushed", async () => {
    const r = await read(`/api/git/log?session=S-fork`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const [tip, first] = r.body.commits;
    expect(tip).toMatchObject({ subject: "feat: unpushed", hasBody: true, unpushed: true, refs: { local: ["main"], upstream: { main: "origin/main" } } });
    expect(first).toMatchObject({ subject: "first", hasBody: false, refs: { remote: ["origin/main"] } });
    expect(first.unpushed).toBeUndefined();
  });

  it("carries both fields in the view's own types", () => {
    expect(sourceOf("git-view-types.ts")).toMatch(/hasBody\?: boolean;/);
    expect(sourceOf("git-view-types.ts")).toMatch(/unpushed\?: boolean;/);
  });
});
