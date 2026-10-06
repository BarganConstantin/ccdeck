// The local file every agent commit the deck sees is written to, so the marks
// survive restarts, log rotation and cleared sessions: one JSON line per
// commit, appended whole, read back tolerantly, kept under a size cap and never
// holding one commit twice.
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — .mjs server module, no types
import { COMMIT_STORE_FILE, commitStorePath, createCommitStore } from "../../server/agent-git-store.mjs";

type Rec = Record<string, unknown> & { sha: string; at: number; sessionId: string; repo: string };

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-agent-git-store-"));
afterAll(() => rmTempDir(DIR));
let n = 0;
const fresh = () => { const d = join(DIR, `s${++n}`); mkdirSync(d); return join(d, COMMIT_STORE_FILE); };

const T0 = 1_760_000_000_000;
const REPO = "/home/u/proj/.git";
const sha = (i: number) => createHash("sha1").update(String(i)).digest("hex");

const rec = (i: number, extra: Partial<Rec> = {}): Rec => ({
  v: 1, repo: REPO, top: "/home/u/proj", sha: sha(i), shaFull: true, subject: `commit ${i}`, authorTime: T0 + i * 1000,
  branch: "main", detached: false, sessionId: "s-1", agentId: null, label: "proj", agentType: null, model: "claude-opus-5",
  kind: "claude", at: T0 + i * 1000 + 50, cwd: "/home/u/proj", cost: null, durationMs: null, durationFrom: null,
  confidence: "seen", amend: false, subcommand: "commit", ...extra,
});

const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);

describe("where the store lives", () => {
  it("is the deck's data directory, which honours XDG and CCDECK_HOME", () => {
    expect(COMMIT_STORE_FILE).toBe("agent-commits.jsonl");
    expect(commitStorePath("/data/ccdeck")).toBe(join("/data/ccdeck", "agent-commits.jsonl"));
    expect(commitStorePath(undefined, { platform: "linux", env: { XDG_DATA_HOME: "/x/data" }, home: "/home/u" }))
      .toBe(join("/x/data/ccdeck", "agent-commits.jsonl"));
    expect(commitStorePath(undefined, { platform: "linux", env: { CCDECK_HOME: "/portable" }, home: "/home/u" }))
      .toBe(join("/portable", "agent-commits.jsonl"));
  });
});

describe("the commit store", () => {
  it("appends one whole line per commit and reads it back", async () => {
    const path = fresh();
    const store = createCommitStore({ path });
    expect(await store.all()).toEqual([]);
    expect((await store.append(rec(1))).added).toBe(true);
    expect((await store.append(rec(2, { sessionId: "s-2" }))).added).toBe(true);
    expect(lines(path).map(l => JSON.parse(l).sha)).toEqual([sha(1), sha(2)]);
    // A second store over the same file — the next boot — sees both.
    const again = createCommitStore({ path });
    expect((await again.all()).map((r: Rec) => r.subject)).toEqual(["commit 1", "commit 2"]);
    expect((await again.forRepo(REPO)).length).toBe(2);
    expect(await again.forRepo("/elsewhere/.git")).toEqual([]);
    expect((await again.lastForSession("s-1"))?.sha).toBe(sha(1));
    expect(await again.lastForSession("nobody")).toBeNull();
  });

  it("is private to the user", async () => {
    if (process.platform === "win32") return;
    const path = fresh();
    await createCommitStore({ path }).append(rec(1));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("never holds one commit twice, and lets a full SHA replace its short one", async () => {
    const path = fresh();
    const store = createCommitStore({ path });
    expect((await store.append(rec(1))).added).toBe(true);
    expect((await store.append(rec(1, { subject: "again" }))).added).toBe(false);
    // Seen before it could be confirmed: the short SHA…
    const short = rec(2, { sha: sha(2).slice(0, 7), shaFull: false, authorTime: null });
    expect((await store.append(short)).added).toBe(true);
    // …a short SHA of a commit already held is a duplicate…
    expect((await store.append(rec(1, { sha: sha(1).slice(0, 9), shaFull: false }))).added).toBe(false);
    // …and the full one, when it comes, takes its place.
    expect((await store.append(rec(2))).added).toBe(true);
    const all = await store.all();
    expect(all.map((r: Rec) => r.sha)).toEqual([sha(1), sha(2)]);
    // On disk the superseded line is still there until the next compaction;
    // a reader collapses it the same way.
    expect((await createCommitStore({ path }).all()).map((r: Rec) => r.sha)).toEqual([sha(1), sha(2)]);
    // The same SHA in another repo is another commit.
    expect((await store.append(rec(1, { repo: "/other/.git" }))).added).toBe(true);
  });

  it("refuses a record it could never read back", async () => {
    const store = createCommitStore({ path: fresh() });
    for (const bad of [null, {}, rec(1, { sha: "xyz" }), rec(1, { repo: "" }), rec(1, { kind: "cursor" }), rec(1, { at: Number.NaN }), rec(1, { sessionId: 7 as unknown as string })]) {
      expect((await store.append(bad)).added, JSON.stringify(bad)).toBe(false);
    }
    expect(await store.all()).toEqual([]);
  });

  it("reads past corrupt and torn lines, and never glues a new line onto a torn one", async () => {
    const path = fresh();
    const store0 = createCommitStore({ path });
    await store0.append(rec(1));
    appendFileSync(path, "not json\n{\"v\":1}\n\n" + JSON.stringify(rec(2)) + "\n" + JSON.stringify(rec(3)).slice(0, 40));
    const store = createCommitStore({ path });
    expect((await store.all()).map((r: Rec) => r.sha)).toEqual([sha(1), sha(2)]);
    expect(store.stats().skipped).toBe(3);
    await store.append(rec(4));
    // The torn tail stays a single unreadable line; the new record is whole.
    expect((await createCommitStore({ path }).all()).map((r: Rec) => r.sha)).toEqual([sha(1), sha(2), sha(4)]);
  });

  it("keeps whole lines under concurrent appends", async () => {
    const path = fresh();
    const store = createCommitStore({ path });
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => store.append(rec(i + 1, { subject: "x".repeat(2000) }))));
    expect(results.every((r: { added: boolean }) => r.added)).toBe(true);
    const ls = lines(path);
    expect(ls).toHaveLength(40);
    for (const l of ls) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("stays under its size cap by dropping the oldest commits", async () => {
    const path = fresh();
    const maxBytes = 8 * 1024;
    const store = createCommitStore({ path, maxBytes });
    for (let i = 1; i <= 60; i++) await store.append(rec(i));
    expect(statSync(path).size).toBeLessThanOrEqual(maxBytes);
    const kept = (await createCommitStore({ path, maxBytes }).all()).map((r: Rec) => r.subject);
    expect(kept.at(-1)).toBe("commit 60");
    expect(kept).not.toContain("commit 1");
    expect(store.stats().compactions).toBeGreaterThan(0);
  });

  it("compacts a file that is already over the cap when it is first read, dropping junk and duplicates", async () => {
    const path = fresh();
    const big = [rec(1), rec(1), rec(2), rec(3)].map(r => JSON.stringify(r)).join("\n") + "\ngarbage\n" + "x".repeat(4000) + "\n";
    writeFileSync(path, big);
    const store = createCommitStore({ path, maxBytes: 3000 });
    const all = await store.all();
    expect(all.map((r: Rec) => r.sha)).toEqual([sha(1), sha(2), sha(3)]);
    expect(statSync(path).size).toBeLessThanOrEqual(3000);
    expect(lines(path).map(l => JSON.parse(l).sha)).toEqual([sha(1), sha(2), sha(3)]);
  });

  it("does not lose a line another deck appended before it compacted", async () => {
    // Two decks can share one data directory. Compaction re-reads the file
    // rather than writing back its own picture, so a newer line another deck
    // appended in the meantime is kept on its merits.
    const path = fresh();
    const a = createCommitStore({ path, maxBytes: 6 * 1024 });
    const b = createCommitStore({ path, maxBytes: 6 * 1024 });
    for (let i = 1; i <= 5; i++) await a.append(rec(i));
    await b.append(rec(100, { sessionId: "from-b" }));
    for (let i = 6; i <= 20; i++) await a.append(rec(i));
    expect(a.stats().compactions).toBeGreaterThan(0);
    const onDisk = (await createCommitStore({ path }).all()).map((r: Rec) => r.sha);
    expect(onDisk).toContain(sha(100));
    expect(onDisk).toContain(sha(20));
    expect((await a.all()).map((r: Rec) => r.sha)).toContain(sha(100));
  });

  it("sees what another deck appends to the same file, without a restart", async () => {
    // Two decks share one data directory, and only the one writing the events
    // log records live commits.
    const path = fresh();
    const writer = createCommitStore({ path });
    const viewer = createCommitStore({ path });
    await writer.append(rec(1));
    expect((await viewer.all()).map((r: Rec) => r.sha)).toEqual([sha(1)]);
    await writer.append(rec(2));
    await writer.append(rec(3, { sessionId: "s-2" }));
    expect((await viewer.forRepo(REPO)).map((r: Rec) => r.sha)).toEqual([sha(1), sha(2), sha(3)]);
    expect((await viewer.lastForSession("s-2"))?.sha).toBe(sha(3));
    // And what it appends itself is held once, the other deck's lines too.
    await viewer.append(rec(4));
    expect((await viewer.all()).map((r: Rec) => r.sha)).toEqual([sha(1), sha(2), sha(3), sha(4)]);
    expect((await writer.all()).map((r: Rec) => r.sha)).toEqual([sha(1), sha(2), sha(3), sha(4)]);
  });

  it("leaves a line another deck is still writing for the next read", async () => {
    const path = fresh();
    const viewer = createCommitStore({ path });
    await viewer.append(rec(1));
    const line = JSON.stringify(rec(2)) + "\n";
    appendFileSync(path, line.slice(0, 30));
    expect((await viewer.all()).map((r: Rec) => r.sha)).toEqual([sha(1)]);
    appendFileSync(path, line.slice(30));
    expect((await viewer.all()).map((r: Rec) => r.sha)).toEqual([sha(1), sha(2)]);
  });

  it("reads the whole file again once another deck has rewritten it", async () => {
    const path = fresh();
    const maxBytes = 6 * 1024;
    const writer = createCommitStore({ path, maxBytes });
    const viewer = createCommitStore({ path, maxBytes });
    await writer.append(rec(1));
    expect(await viewer.all()).toHaveLength(1);
    for (let i = 2; i <= 30; i++) await writer.append(rec(i));
    expect(writer.stats().compactions).toBeGreaterThan(0);
    const onDisk = (await createCommitStore({ path, maxBytes }).all()).map((r: Rec) => r.sha);
    expect(onDisk).not.toContain(sha(1));
    expect((await viewer.all()).map((r: Rec) => r.sha)).toEqual(onDisk);
  });

  it("keeps a deck's memory-only lines off the disk, and through another deck's rewrite", async () => {
    const path = fresh();
    const maxBytes = 6 * 1024;
    const ramOnly = createCommitStore({ path, maxBytes });
    expect((await ramOnly.append(rec(500, { sessionId: "ram" }), { memoryOnly: true })).added).toBe(true);
    expect((await ramOnly.append(rec(500, { sessionId: "ram" }), { memoryOnly: true })).added).toBe(false);
    expect(() => statSync(path)).toThrow();
    const writer = createCommitStore({ path, maxBytes });
    for (let i = 1; i <= 30; i++) await writer.append(rec(i));
    expect(writer.stats().compactions).toBeGreaterThan(0);
    const held = (await ramOnly.all()).map((r: Rec) => r.sha);
    expect(held).toContain(sha(500));
    expect(held).toContain(sha(30));
    expect((await createCommitStore({ path }).all()).map((r: Rec) => r.sha)).not.toContain(sha(500));
    expect(readFileSync(path, "utf8")).not.toContain("\"ram\"");
  });

  it("answers an unreadable or missing file as empty, without throwing", async () => {
    const store = createCommitStore({ path: join(DIR, "no", "such", "dir", COMMIT_STORE_FILE) });
    expect(await store.all()).toEqual([]);
    const blocked = createCommitStore({ path: DIR }); // a directory, not a file
    expect(await blocked.all()).toEqual([]);
    expect((await blocked.append(rec(1))).added).toBe(false);
  });
});
