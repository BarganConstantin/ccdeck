import { afterEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canResumeSavedSession, createSessionHistoryReader, handleSessionHistory } from "../../server/session-history.mjs";
import { stageShowFor } from "../components/terminal/stage-board";

const CLAUDE = "7db5ef92-31a3-4b01-8a90-16c4015729bc";
const CODEX = "a7cf29c0-4cf5-4210-a277-404152cbfd3b";
const temp: string[] = [];
afterEach(async () => { await Promise.all(temp.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccdeck-saved-")));
  temp.push(root);
  const project = join(root, "vacationcrm");
  const claudeRoot = join(root, "claude", "projects");
  const codexHome = join(root, "codex");
  const claudeDir = join(claudeRoot, "-repo");
  const rolloutDir = join(codexHome, "sessions", "2025", "10", "20");
  for (const dir of [project, claudeDir, rolloutDir]) await mkdir(dir, { recursive: true });
  const claude = join(claudeDir, `${CLAUDE}.jsonl`);
  const codex = join(rolloutDir, `rollout-2025-10-20T04-03-02-${CODEX}.jsonl`);
  const writeRows = (path: string, ...rows: object[]) => writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await writeRows(claude,
    { type: "user", sessionId: CLAUDE, cwd: project, message: { content: "private prompt" } },
    { type: "custom-title", sessionId: CLAUDE, customTitle: "Developer" });
  await writeRows(codex, { type: "session_meta", payload: { id: CODEX, cwd: project } });
  await writeRows(join(codexHome, "session_index.jsonl"), { id: CODEX, thread_name: "Developer" });
  await utimes(codex, 1000, 1000);
  const selection = async () => ({
    homes: [codexHome], available: true, home: codexHome, originalHome: codexHome,
  });
  const read = createSessionHistoryReader({ selection, claudeRoots: () => [claudeRoot], activeClaude: () => claudeRoot });
  return { read, project, selection, codex, claude, claudeRoot, codexHome };
}

const request = (remoteAddress = "127.0.0.1") => ({ socket: { remoteAddress } });
async function list(read: Awaited<ReturnType<typeof fixture>>["read"], query: string, addr?: string) {
  const response = { status: 0, body: undefined as any, writeHead(status: number) { this.status = status; }, end(raw: string) { this.body = JSON.parse(raw); } };
  await handleSessionHistory(request(addr), response, new URL(`http://localhost/?${query}`), { read });
  return response;
}

describe("provider session history", () => {
  it("finds a saved Claude name and an older Codex title across a fresh scan without exposing transcript contents or paths", async () => {
    const f = await fixture();
    const result = await list(f.read, "q=developer");
    expect(result.status).toBe(200);
    expect(result.body.rows).toMatchObject([{ id: CLAUDE, provider: "claude" }, { id: CODEX, provider: "codex" }]);
    expect(JSON.stringify(result.body)).not.toContain("private prompt");
    expect(JSON.stringify(result.body)).not.toContain(".jsonl");
    const filtered = await list(f.read, "q=vacationcrm&provider=codex");
    expect(filtered.body.rows).toMatchObject([{ id: CODEX, provider: "codex" }]);
    expect((await list(f.read, "q=does-not-exist")).body.rows).toHaveLength(0);
  });

  it("never serves history to another device and reports missing folders", async () => {
    const f = await fixture();
    expect((await list(f.read, "", "192.168.0.12")).status).toBe(403);
    await rm(f.project, { recursive: true });
    expect((await list(f.read, "")).body.rows.map((row: { unavailable: string }) => row.unavailable)).toEqual(["folder", "folder"]);
  });

  it("checks that the profile and rollout still match before resuming", async () => {
    const f = await fixture();
    const opts = { read: f.read, selection: f.selection };
    const ref = { provider: "codex", sessionId: CODEX, cwd: f.project };
    expect(await canResumeSavedSession(request(), ref, opts)).toBe(true);
    expect(await canResumeSavedSession(request(), ref, { ...opts, selection: async () => ({ ...await f.selection(), home: "/other" }) })).toBe(false);
    await rm(f.codex);
    expect(await canResumeSavedSession(request(), ref, opts)).toBe(false);
  });

  it("ignores multiply linked transcripts", async () => {
    const f = await fixture();
    await link(f.claude, join(f.claudeRoot, "-repo", `${CODEX}.jsonl`));
    expect((await f.read()).rows.map(row => row.id)).toEqual([CODEX]);
  });

  it("preserves provider and folder in the workspace for a session the board never saw", () => {
    const history = { id: CODEX, provider: "codex" as const, cwd: "/demo", title: "Developer", updatedAt: 1, unavailable: null };
    expect(stageShowFor({ kind: "session", id: CODEX, history }, new Map(), 1)).toMatchObject({
      kind: "session", session: { ref: { sessionId: CODEX, provider: "codex", cwd: "/demo", saved: true }, name: "Developer" },
    });
  });
});
