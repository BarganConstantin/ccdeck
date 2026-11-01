import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
// @ts-expect-error plain server module
import { createWriteGuard, WRITE_OUTCOMES, writeOutcome } from "../../server/integrations/write-guard.mjs";
// @ts-expect-error plain server module
import { createJiraWriteGuard } from "../../server/integrations/jira-write-guard.mjs";
import { writeOutcomeOf } from "../write-outcome";

const dirs: string[] = [];
async function tmp() {
  const dir = await mkdtemp(join(tmpdir(), "ccdeck-write-guard-core-"));
  dirs.push(dir);
  return dir;
}
// Every reservation a test begins is released before its directory goes, so no
// marker server or active entry outlives the test.
const held: { guard: any; operation: any }[] = [];
async function begin(guard: any, input: any) {
  const result = await guard.begin(input);
  if (result.operation) held.push({ guard, operation: result.operation });
  return result;
}
afterEach(async () => {
  for (const { guard, operation } of held.splice(0)) await guard.finish(operation, false).catch(() => {});
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

// A fake provider: accepts only { connectionId, thing: "a" | "b" }.
const fake = {
  record(input: any) {
    if (typeof input.connectionId !== "string" || !["a", "b"].includes(input.thing)) throw new Error("Invalid fake scope");
    return { connectionId: input.connectionId, thing: input.thing };
  },
  key: (rec: any) => JSON.stringify(["fake", rec.connectionId, rec.thing]),
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("write guard core", () => {
  it("reserves what the provider scope accepts and refuses the rest", async () => {
    const dir = await tmp();
    const guard = createWriteGuard({ name: "Fake", dir: () => dir, scope: fake });
    await expect(begin(guard, { connectionId: "c", thing: "z" })).rejects.toThrow("Invalid fake scope");
    expect(await readdir(dir).catch(() => [])).toEqual([]);
    const { operation } = await begin(guard, { connectionId: "c", thing: "a" });
    expect(operation).toMatchObject({ connectionId: "c", thing: "a", state: "pending" });
    const again = await begin(guard, { connectionId: "c", thing: "a" });
    expect(again.conflict?.state).toBe("pending");
    // A different scope is not blocked by the first one.
    const other = await begin(guard, { connectionId: "c", thing: "b" });
    expect(other.operation).toBeTruthy();
    await guard.finish(operation, "confirmed");
    await guard.finish(other.operation, true);
    const [kept] = await guard.list("c");
    expect(kept.state).toBe("confirmed");
    expect(await guard.acknowledge("c", operation.operationId)).toEqual({ ok: true });
    expect(await guard.list("c")).toEqual([]);
  });

  it("makes the scope hash from the provider's key string", async () => {
    const dir = await tmp();
    const input = { connectionId: "c", thing: "a" };
    const guard = createWriteGuard({ name: "Fake", dir: () => dir, scope: fake });
    await begin(guard, input);
    expect(await readdir(dir)).toContain(`${sha(fake.key(input))}.json`);
    // Another provider keying the same input differently writes another file.
    const dir2 = await tmp();
    const other = { record: fake.record, key: (rec: any) => JSON.stringify(["other", rec.connectionId, rec.thing]) };
    const guard2 = createWriteGuard({ name: "Other", dir: () => dir2, scope: other });
    await begin(guard2, input);
    const files = await readdir(dir2);
    expect(files).toContain(`${sha(other.key(input))}.json`);
    expect(files).not.toContain(`${sha(fake.key(input))}.json`);
  });

  it("refuses a provider record without a connectionId and writes nothing", async () => {
    const dir = await tmp();
    const bad = { record: () => ({ thing: "a" }), key: () => "k" };
    const guard = createWriteGuard({ name: "Bad", dir: () => dir, scope: bad });
    await expect(begin(guard, { thing: "a" })).rejects.toThrow("Invalid guard scope");
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("never lets a write that may have landed be retried by itself", async () => {
    const dir = await tmp();
    const guard = createWriteGuard({ name: "Fake", dir: () => dir, scope: fake });
    const { operation } = await begin(guard, { connectionId: "c", thing: "a" });
    // Finishing without a verdict leaves the reservation behind, as uncertain once the writer is gone.
    await guard.finish(operation, false);
    const [left] = await guard.list("c");
    expect(left.state).toBe("uncertain");
    const retry = await begin(guard, { connectionId: "c", thing: "a" });
    expect(retry.operation).toBeUndefined();
    expect(retry.conflict.state).toBe("uncertain");
  });

  it("names the provider in its unavailable error", async () => {
    const dir = await tmp();
    const locks = { tryLock() { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); }, unlock() {} };
    const guard = createWriteGuard({ name: "Fake", dir: () => dir, locks, scope: fake });
    await expect(guard.begin({ connectionId: "c", thing: "a" })).rejects.toMatchObject({ kind: "unavailable", message: expect.stringContaining("Fake writes are unavailable") });
  });
});

describe("write outcomes", () => {
  it("has the four outcomes, frozen", () => {
    expect(WRITE_OUTCOMES).toEqual({ saving: "saving", saved: "saved", failed: "failed", uncertain: "uncertain" });
    expect(Object.isFrozen(WRITE_OUTCOMES)).toBe(true);
  });
  it("maps a reservation read to an outcome, and never to failed", () => {
    expect(writeOutcome({ state: "pending" })).toBe("saving");
    expect(writeOutcome({ state: "confirmed" })).toBe("saved");
    expect(writeOutcome({ state: "uncertain" })).toBe("uncertain");
    expect(writeOutcome({ state: "other" })).toBeNull();
    expect(writeOutcome(undefined)).toBeNull();
  });
  it("reads a guard operation with the server's table, on both sides", () => {
    for (const state of ["pending", "confirmed", "uncertain"]) {
      expect(writeOutcomeOf({ operation: { state } })).toBe(writeOutcome({ state }));
    }
    expect(writeOutcomeOf({ busy: true, operation: { state: "pending" } })).toBe("saving");
    expect(writeOutcomeOf({ operation: { state: "weird" } })).toBe("uncertain");
    expect(writeOutcomeOf({ operation: {} })).toBe("uncertain");
  });
  it("reads the client write state as one outcome", () => {
    const idle = { busy: false, uncertain: false, error: "", draft: "" };
    expect(writeOutcomeOf(idle)).toBeNull();
    expect(writeOutcomeOf({ ...idle, busy: true })).toBe("saving");
    expect(writeOutcomeOf({ ...idle, uncertain: true, error: "Check Jira before trying again." })).toBe("uncertain");
    expect(writeOutcomeOf({ ...idle, error: "No." })).toBe("failed");
    expect(writeOutcomeOf({ ...idle, draft: "text" })).toBeNull();
  });
});

describe("Jira adapter", () => {
  const key = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

  it("keeps the on-disk hash and record shape of the old guard", async () => {
    const dir = await tmp();
    const guard = createJiraWriteGuard({ dir: () => dir });
    const { operation } = await begin(guard, { connectionId: "synthetic-a", kind: "comment", issueKey: "MOCK-1" });
    // Pinned digest of the scope the old code hashed.
    const digest = key(["synthetic-a", "comment", "MOCK-1"]);
    expect(digest).toBe("9cb94d07ec85b9bd689f8fd61adb6cf2dcf27e6db2ef9d4577a7c0aa8c84a0a5");
    const stored = JSON.parse(await readFile(join(dir, `${digest}.json`), "utf8"));
    expect(Object.keys(stored)).toEqual(["connectionId", "kind", "issueKey", "operationId", "state"]);
    expect(stored).toEqual({ connectionId: "synthetic-a", kind: "comment", issueKey: "MOCK-1", operationId: operation.operationId, state: "pending" });
    const move = await begin(guard, { connectionId: "synthetic-a", kind: "move", boardId: "7", issueKeys: ["MOCK-1", "MOCK-2"] });
    const moveStored = JSON.parse(await readFile(join(dir, `${key(["synthetic-a", "move", ""])}.json`), "utf8"));
    expect(Object.keys(moveStored)).toEqual(["connectionId", "kind", "boardId", "issueKeys", "operationId", "state"]);
    expect(move.operation.operationId).toBe(moveStored.operationId);
  });

  it("reads a reservation written before the upgrade", async () => {
    const dir = await tmp();
    const old = { connectionId: "synthetic-a", kind: "status", issueKey: "MOCK-9", operationId: "11111111-1111-4111-8111-111111111111", state: "confirmed" };
    await writeFile(join(dir, `${key(["synthetic-a", "status", "MOCK-9"])}.json`), JSON.stringify(old));
    const guard = createJiraWriteGuard({ dir: () => dir });
    expect(await guard.list("synthetic-a")).toEqual([old]);
    // The same scope is still held by the old record.
    const blocked = await guard.begin({ connectionId: "synthetic-a", kind: "status", issueKey: "MOCK-9" });
    expect(blocked.conflict).toEqual(old);
    expect(await guard.acknowledge("synthetic-a", old.operationId)).toEqual({ ok: true });
    expect(await guard.list("synthetic-a")).toEqual([]);
  });

  it("refuses exactly what it refused before", async () => {
    const dir = await tmp();
    const guard = createJiraWriteGuard({ dir: () => dir });
    const bad: any[] = [
      { connectionId: "", kind: "comment", issueKey: "MOCK-1" },
      { connectionId: "x".repeat(65), kind: "comment", issueKey: "MOCK-1" },
      { connectionId: "c", kind: "delete", issueKey: "MOCK-1" },
      { connectionId: "c", kind: "comment", issueKey: "mock-1" },
      { connectionId: "c", kind: "comment", issueKey: "MOCK-0" },
      { connectionId: "c", kind: "move", boardId: "0", issueKeys: ["MOCK-1"] },
      { connectionId: "c", kind: "move", boardId: "7", issueKeys: [] },
      { connectionId: "c", kind: "move", boardId: "7", issueKeys: Array.from({ length: 51 }, (_, i) => `MOCK-${i + 1}`) },
      { connectionId: "c", kind: "move", boardId: "7", issueKeys: ["bad"] },
    ];
    for (const input of bad) await expect(guard.begin(input)).rejects.toThrow(/Invalid guard/);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });
});
