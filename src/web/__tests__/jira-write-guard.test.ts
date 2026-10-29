import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
// @ts-expect-error plain server module
import { createJiraWriteGuard } from "../../server/integrations/jira-write-guard.mjs";

const dirs: string[] = [];
async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "ccdeck-jira-guard-test-"));
  dirs.push(dir);
  return { dir, guard: createJiraWriteGuard({ dir: () => dir }) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const comment = { connectionId: "synthetic-a", kind: "comment", issueKey: "MOCK-1" };

describe("durable Jira write guard", () => {
  it("retains an interrupted reservation after the server process exits", async () => {
    const { guard, dir } = await rig();
    const moduleUrl = pathToFileURL(join(process.cwd(), "src/server/integrations/jira-write-guard.mjs")).href;
    const script = `import { createJiraWriteGuard } from ${JSON.stringify(moduleUrl)}; const guard = createJiraWriteGuard({dir: () => process.argv[1]}); await guard.begin(${JSON.stringify(comment)});`;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, dir]);
    const [operation] = await guard.list(comment.connectionId);
    assert.equal(operation.state, "uncertain");
    assert.equal((await guard.begin(comment)).conflict.operationId, operation.operationId);
    assert.deepEqual(await guard.acknowledge(comment.connectionId, operation.operationId), { ok: true });
  });
  it("rejects concurrent duplicates and cannot acknowledge a pending operation", async () => {
    const { guard } = await rig();
    const results = await Promise.all([guard.begin(comment), guard.begin(comment)]);
    const operation = results.find(r => r.operation)?.operation;
    const conflict = results.find(r => r.conflict)?.conflict;
    assert.ok(operation);
    assert.equal(operation.state, "pending");
    assert.equal(conflict.operationId, operation.operationId);
    assert.equal(conflict.state, "pending");
    assert.equal((await guard.acknowledge(comment.connectionId, operation.operationId)).conflict.state, "pending");
    assert.equal((await guard.list(comment.connectionId)).length, 1);
    await guard.finish(operation, true);
    assert.deepEqual(await guard.list(comment.connectionId), []);
    assert.ok((await guard.begin(comment)).operation);
  });

  it("retains uncertain writes across guard instances until explicitly acknowledged", async () => {
    const { guard, dir } = await rig();
    const { operation } = await guard.begin(comment);
    const restarted = createJiraWriteGuard({ dir: () => dir });
    assert.equal((await restarted.list(comment.connectionId))[0].state, "pending");
    await guard.finish(operation, false);
    const [uncertain] = await restarted.list(comment.connectionId);
    assert.equal(uncertain.operationId, operation.operationId);
    assert.equal(uncertain.state, "uncertain");
    assert.equal((await restarted.begin(comment)).conflict.operationId, operation.operationId);
    assert.deepEqual(await restarted.acknowledge(comment.connectionId, operation.operationId), { ok: true });
    assert.deepEqual(await guard.list(comment.connectionId), []);
    assert.ok((await restarted.begin(comment)).operation);
  });

  it("retains a confirmed receipt across instances until the matching acknowledgement", async () => {
    const { guard, dir } = await rig();
    const { operation } = await guard.begin(comment);
    await guard.finish(operation, 'confirmed');
    const restarted = createJiraWriteGuard({ dir: () => dir });
    assert.equal((await restarted.list(comment.connectionId))[0].state, 'confirmed');
    const moduleUrl = pathToFileURL(join(process.cwd(), "src/server/integrations/jira-write-guard.mjs")).href;
    const script = `import { createJiraWriteGuard } from ${JSON.stringify(moduleUrl)}; const guard = createJiraWriteGuard({dir: () => process.argv[1]}); console.log(JSON.stringify(await guard.list(${JSON.stringify(comment.connectionId)})));`;
    const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, dir]);
    assert.equal(JSON.parse(child.stdout)[0].state, 'confirmed');
    assert.equal((await restarted.begin(comment)).conflict.operationId, operation.operationId);
    assert.deepEqual(await restarted.acknowledge(comment.connectionId, operation.operationId), { ok: true });
    assert.ok((await restarted.begin(comment)).operation);
  });

  it("uses a new operation id for each reservation and rejects stale acknowledgements and finishes", async () => {
    const { guard } = await rig();
    const first = (await guard.begin(comment)).operation;
    await guard.finish(first, false);
    assert.deepEqual(await guard.acknowledge(comment.connectionId, first.operationId), { ok: true });
    const second = (await guard.begin(comment)).operation;
    assert.notEqual(second.operationId, first.operationId);
    assert.deepEqual(await guard.acknowledge(comment.connectionId, first.operationId), { ok: false });
    await assert.rejects(guard.finish(first, true));
    assert.equal((await guard.list(comment.connectionId))[0].operationId, second.operationId);
    assert.equal((await guard.begin(comment)).conflict.operationId, second.operationId);
    await guard.finish(second, true);
  });

  it("isolates connections, issue keys and write kinds", async () => {
    const { guard } = await rig();
    const a = (await guard.begin(comment)).operation;
    const b = (await guard.begin({ ...comment, connectionId: "synthetic-b" })).operation;
    const otherIssue = (await guard.begin({ ...comment, issueKey: "MOCK-2" })).operation;
    const status = (await guard.begin({ ...comment, kind: "status" })).operation;
    assert.ok(a && b && otherIssue && status);
    assert.equal((await guard.list("synthetic-a")).length, 3);
    assert.equal((await guard.list("synthetic-b")).length, 1);
    await guard.finish(a, false);
    assert.deepEqual(await guard.acknowledge("synthetic-b", a.operationId), { ok: false });
    assert.equal((await guard.list("synthetic-a")).length, 3);
    await Promise.all([guard.finish(b, true), guard.finish(otherIssue, true), guard.finish(status, true)]);
  });

  it("serializes moves per connection even for disjoint issue batches", async () => {
    const { guard } = await rig();
    const move = { connectionId: "synthetic-a", kind: "move", boardId: "27", issueKeys: ["MOCK-1", "MOCK-2"] };
    const first = (await guard.begin(move)).operation;
    assert.equal(first.boardId, "27");
    const conflict = (await guard.begin({ ...move, boardId: "28", issueKeys: ["MOCK-3"] })).conflict;
    assert.equal(conflict.operationId, first.operationId);
    assert.equal(conflict.boardId, "27");
    const otherConnection = (await guard.begin({ ...move, connectionId: "synthetic-b" })).operation;
    const otherKind = (await guard.begin(comment)).operation;
    assert.ok(otherConnection && otherKind);
    await guard.finish(first, false);
    assert.equal((await guard.begin({ ...move, issueKeys: ["MOCK-4"] })).conflict.state, "uncertain");
    await Promise.all([guard.finish(otherConnection, true), guard.finish(otherKind, true)]);
  });

  it("persists only allowlisted metadata, without request content or secrets", async () => {
    const { guard, dir } = await rig();
    const secret = "synthetic-secret-never-persist";
    const { operation } = await guard.begin({ ...comment, body: secret, token: secret, extra: { secret } });
    const files = await readdir(dir);
    assert.ok(files.every(name => !name.includes(comment.connectionId) && !name.includes(comment.issueKey) && !name.includes(secret)));
    const records = files.filter(name => name.endsWith(".json"));
    assert.equal(records.length, 1);
    const raw = await readFile(join(dir, records[0]), "utf8");
    assert.ok(!raw.includes(secret));
    assert.deepEqual(JSON.parse(raw), {
      connectionId: comment.connectionId, kind: comment.kind, issueKey: comment.issueKey, operationId: operation.operationId, state: 'pending',
    });
    assert.ok(!JSON.stringify(await guard.list(comment.connectionId)).includes(secret));
    await guard.finish(operation, true);
  });
});
