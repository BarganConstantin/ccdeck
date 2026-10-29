import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
// @ts-expect-error plain server module
import { createJiraWriteGuard } from "../../server/integrations/jira-write-guard.mjs";

import { createRequire } from "node:module";
const native = createRequire(import.meta.url)(join(process.cwd(), 'node_modules/fs-native-extensions/prebuilds', `${process.platform}-${process.arch}`, 'fs-native-extensions.node'));
const tryLock = (fd: number) => { try { native.tryLock(fd, 0, 0, true); return true; } catch (err: any) { if (err.code === 'EAGAIN') return false; throw err; } };
const unlock = (fd: number) => native.unlock(fd, 0, 0);

const dirs: string[] = [];
async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "ccdeck-jira-guard-test-"));
  dirs.push(dir);
  return { dir, guard: createJiraWriteGuard({ dir: () => dir }) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const comment = { connectionId: "synthetic-a", kind: "comment", issueKey: "MOCK-1" };

describe("durable Jira write guard", () => {
  it("refuses writes before reserving when filesystem locking is unsupported", async () => {
    const { dir } = await rig();
    const guard = createJiraWriteGuard({ dir: () => dir, locks: { tryLock() { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); }, unlock() {} } });
    await assert.rejects(guard.begin(comment), (err: any) => err.kind === 'unavailable');
    assert.deepEqual(await guard.list(comment.connectionId), []);
    assert.ok(!(await readdir(dir)).some(name => name.startsWith('running-')));
  });
  it("waits for a concurrent acknowledgement before finalizing", async () => {
    const { guard, dir } = await rig();
    const { operation } = await guard.begin(comment);
    const digest = createHash('sha256').update(JSON.stringify([comment.connectionId, comment.kind, comment.issueKey])).digest('hex');
    const handle = await open(join(dir, `lock-${digest}`), 'a+', 0o600);
    assert.equal(tryLock(handle.fd), true);
    const finishing = guard.finish(operation, 'confirmed');
    const acknowledging = guard.acknowledge(comment.connectionId, operation.operationId);
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal((await guard.list(comment.connectionId))[0].state, 'pending');
    } finally { unlock(handle.fd); await handle.close(); }
    await finishing;
    const ack = await acknowledging;
    if (!ack.ok) assert.deepEqual(await guard.acknowledge(comment.connectionId, operation.operationId), { ok: true });
    assert.deepEqual(await guard.list(comment.connectionId), []);
  });

  it("recovers a scope lock when its process is killed", async () => {
    const { guard, dir } = await rig();
    const { operation } = await guard.begin(comment);
    const digest = createHash('sha256').update(JSON.stringify([comment.connectionId, comment.kind, comment.issueKey])).digest('hex');
    const nativeUrl = pathToFileURL(join(process.cwd(), 'node_modules/fs-native-extensions/prebuilds', `${process.platform}-${process.arch}`, 'fs-native-extensions.node')).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { open } from 'node:fs/promises'; import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url'; const native = createRequire(import.meta.url)(fileURLToPath(${JSON.stringify(nativeUrl)})); const h = await open(${JSON.stringify(join(dir, `lock-${digest}`))}, 'a+', 0o600); native.tryLock(h.fd, 0, 0, true); console.log('ready'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout!, 'data');
      const finishing = guard.finish(operation, 'confirmed');
      await new Promise(resolve => setTimeout(resolve, 50));
      child.kill('SIGKILL');
      await once(child, 'exit');
      await finishing;
      assert.equal((await guard.list(comment.connectionId))[0].state, 'confirmed');
      assert.deepEqual(await guard.acknowledge(comment.connectionId, operation.operationId), { ok: true });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });

  it("confirms and acknowledges while the former scope port stays occupied", async () => {
    const { guard } = await rig();
    const { operation } = await guard.begin(comment);
    const digest = createHash('sha256').update(JSON.stringify([comment.connectionId, comment.kind, comment.issueKey])).digest('hex');
    const port = 20000 + (parseInt(digest.slice(0, 8), 16) % 40000);
    const unrelated = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => unrelated.once('error', reject).listen(port, '127.0.0.1', resolve));
    try {
      await guard.finish(operation, 'confirmed');
      assert.equal((await guard.list(comment.connectionId))[0].state, 'confirmed');
      assert.deepEqual(await guard.acknowledge(comment.connectionId, operation.operationId), { ok: true });
      assert.deepEqual(await guard.list(comment.connectionId), []);
    } finally { await new Promise<void>(resolve => unrelated.close(() => resolve())); }
  }, 3000);

  it("does not mistake a reused PID or port for the interrupted writer", async () => {
    const { guard, dir } = await rig();
    const moduleUrl = pathToFileURL(join(process.cwd(), "src/server/integrations/jira-write-guard.mjs")).href;
    const script = `import { createJiraWriteGuard } from ${JSON.stringify(moduleUrl)}; const guard = createJiraWriteGuard({dir: () => process.argv[1]}); await guard.begin(${JSON.stringify(comment)});`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, dir]);
    const marker = (await readdir(dir)).find(name => name.startsWith('running-'))!;
    const identity = JSON.parse(await readFile(join(dir, marker), 'utf8'));
    const unrelated = createServer(socket => socket.end('unrelated process'));
    await new Promise<void>((resolve, reject) => unrelated.once('error', reject).listen(identity.port, '127.0.0.1', resolve));
    try {
      // The current process is alive, simulating a reused PID.
      const renamed = marker.replace(/-\d+$/, `-${process.pid}`);
      await writeFile(join(dir, renamed), JSON.stringify(identity));
      const [operation] = await guard.list(comment.connectionId);
      assert.equal(operation.state, 'uncertain');
      assert.deepEqual(await guard.acknowledge(comment.connectionId, operation.operationId), { ok: true });
    } finally { await new Promise<void>(resolve => unrelated.close(() => resolve())); }
  });

  it("keeps a live writer pending across processes and recovers after it is killed", async () => {
    const { guard, dir } = await rig();
    const moduleUrl = pathToFileURL(join(process.cwd(), "src/server/integrations/jira-write-guard.mjs")).href;
    const script = `import { createJiraWriteGuard } from ${JSON.stringify(moduleUrl)}; const guard = createJiraWriteGuard({dir: () => process.argv[1]}); const result = await guard.begin(${JSON.stringify(comment)}); console.log(JSON.stringify(result.operation)); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const [chunk] = await once(child.stdout!, 'data');
      const operation = JSON.parse(chunk.toString());
      assert.equal((await guard.list(comment.connectionId))[0].state, 'pending');
      assert.equal((await guard.acknowledge(comment.connectionId, operation.operationId)).conflict.state, 'pending');
      child.kill('SIGKILL');
      await once(child, 'exit');
      assert.equal((await guard.list(comment.connectionId))[0].state, 'uncertain');
      assert.deepEqual(await guard.acknowledge(comment.connectionId, operation.operationId), { ok: true });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
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
