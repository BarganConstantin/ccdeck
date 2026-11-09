import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Fault only the private fixture's filesystem boundary. The store, queue,
// metadata writer and report worker all run their production implementations.
const faults = vi.hoisted(() => ({
  read: null as null | ((path: string) => Promise<void>),
  list: null as null | ((path: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: async (...args: unknown[]) => {
      await faults.read?.(String(args[0]));
      return Reflect.apply(real.readFile, real, args);
    },
    readdir: async (...args: unknown[]) => {
      await faults.list?.(String(args[0]));
      return Reflect.apply(real.readdir, real, args);
    },
  };
});
const disk = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
// @ts-expect-error — plain server ES module
const { createToolAudit } = await import("../../server/tool-audit.mjs");
const NOW = Date.parse("2026-11-09T10:00:00Z");
const dirs: string[] = [], audits: ReturnType<typeof createToolAudit>[] = [];
const auditAt = (dir: string) => {
  const audit = createToolAudit({ dir, now: () => NOW });
  audits.push(audit);
  return audit;
};
const denied = () => Object.assign(new Error("synthetic metadata read refusal"), { code: "EACCES" });
const query = { provider: "all", days: 90 };

afterEach(async () => {
  faults.read = faults.list = null;
  for (const audit of audits.splice(0)) await audit.close().catch(() => {});
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function seeded() {
  const dir = await mkdtemp(join(tmpdir(), "ccdeck-audit-init-"));
  dirs.push(dir);
  const seed = auditAt(dir);
  await seed.start();
  await seed.configure(30);
  await seed.close();
  const file = join(dir, "settings.json");
  const original = await disk.readFile(file, "utf8");
  return { dir, file, original, meta: JSON.parse(original) };
}

function bufferCall(audit: ReturnType<typeof createToolAudit>) {
  const call = { session_id: "synthetic-session", tool_use_id: "synthetic-call", tool_name: "Bash",
    tool_input: { command: "git status --short" } };
  audit.observe({ ...call, hook_event_name: "PreToolUse" }, "hook", { receivedAt: NOW });
  audit.observe({ ...call, hook_event_name: "PostToolUse" }, "hook", { receivedAt: NOW + 500 });
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

describe("tool history initialization after storage recovery", () => {
  it("refuses unreadable metadata, then retries the same instance and flushes buffered calls once", async () => {
    const f = await seeded();
    const audit = auditAt(f.dir);
    faults.read = async path => { if (path === f.file) throw denied(); };
    await expect(audit.start()).rejects.toMatchObject({ code: "EACCES" });
    bufferCall(audit);
    await expect(audit.status()).rejects.toMatchObject({ code: "EACCES" });
    await expect(audit.close()).rejects.toMatchObject({ code: "EACCES" });
    expect(await disk.readFile(f.file, "utf8")).toBe(f.original);
    expect((await readdir(f.dir)).filter(name => name.endsWith(".jsonl"))).toEqual([]);

    faults.read = null;
    await audit.start();
    expect(await audit.status()).toMatchObject({ ok: true, storageOk: true, dropped: 0,
      deviceId: f.meta.deviceId, epoch: f.meta.epoch, retentionDays: 30 });
    await audit.close();
    expect(await audit.report(query)).toMatchObject({ total: 1, completed: 1, duplicates: 0 });
    expect(await audit.report(query)).toMatchObject({ total: 1, completed: 1, duplicates: 0 });
    const journals = (await readdir(f.dir)).filter(name => name.endsWith(".jsonl"));
    expect(journals).toHaveLength(1);
    expect((await disk.readFile(join(f.dir, journals[0]), "utf8")).trim().split("\n")).toHaveLength(2);
    expect(await disk.readFile(f.file, "utf8")).toBe(f.original);
    const restarted = auditAt(f.dir);
    await restarted.start();
    expect(await restarted.report(query)).toMatchObject({ total: 1, completed: 1, duplicates: 0 });
  });

  it("shares each in-flight initialization across concurrent callers, including the retry", async () => {
    const f = await seeded();
    const audit = auditAt(f.dir);
    let reads = 0, failure: Error | null = denied();
    let entered = gate(), release = gate();
    faults.read = async path => {
      if (path !== f.file) return;
      reads++;
      entered.open();
      await release.promise;
      if (failure) throw failure;
    };
    const first = [audit.start(), audit.start(), audit.status()].map(p => p.catch((e: Error) => e));
    try {
      await entered.promise;
      expect(reads).toBe(1);
    } finally { release.open(); }
    expect(await Promise.all(first)).toEqual([failure, failure, failure]);
    expect(reads).toBe(1);
    expect(await disk.readFile(f.file, "utf8")).toBe(f.original);

    failure = null;
    entered = gate(); release = gate();
    bufferCall(audit);
    const retry = [audit.start(), audit.start(), audit.status(), audit.close()];
    try {
      await entered.promise;
      expect(reads).toBe(2);
    } finally { release.open(); }
    const results = await Promise.all(retry);
    expect(results[2]).toMatchObject({ ok: true, storageOk: true, deviceId: f.meta.deviceId, epoch: f.meta.epoch });
    expect(reads).toBe(2);
    expect(await audit.report(query)).toMatchObject({ total: 1, completed: 1, duplicates: 0 });
    expect(reads).toBe(2);
    expect(await disk.readFile(f.file, "utf8")).toBe(f.original);
  });

  it("discards partially initialized metadata before a failed read or a newly missing file", async () => {
    const f = await seeded();
    const audit = auditAt(f.dir);
    // The settings were read, but the initialization's retention scan failed.
    faults.list = async path => { if (path === f.dir) throw denied(); };
    await expect(audit.start()).rejects.toMatchObject({ code: "EACCES" });
    bufferCall(audit);
    faults.list = null;
    faults.read = async path => { if (path === f.file) throw denied(); };
    await expect(audit.start()).rejects.toMatchObject({ code: "EACCES" });
    expect(await disk.readFile(f.file, "utf8")).toBe(f.original);
    expect((await readdir(f.dir)).filter(name => name.endsWith(".jsonl"))).toEqual([]);

    // An operator really removed the settings file; ENOENT may create new
    // metadata, but cannot reuse the previous failed attempt's identity.
    faults.read = null;
    await rm(f.file);
    await audit.start();
    const status = await audit.status();
    expect(status).toMatchObject({ ok: true, storageOk: true, retentionDays: 90 });
    expect(status.deviceId).not.toBe(f.meta.deviceId);
    expect(status.epoch).not.toBe(f.meta.epoch);
    const saved = JSON.parse(await disk.readFile(f.file, "utf8"));
    expect(saved).toMatchObject({ deviceId: status.deviceId, epoch: status.epoch, retentionDays: 90 });
    expect(await audit.report(query)).toMatchObject({ total: 1, completed: 1, duplicates: 0 });
  });

  it.each(["{bad}", JSON.stringify({ v: 1, retentionDays: 30 })])(
    "keeps malformed metadata refused and unchanged until it is repaired: %s", async malformed => {
      const f = await seeded();
      await writeFile(f.file, malformed);
      const audit = auditAt(f.dir);
      bufferCall(audit);
      await expect(audit.start()).rejects.toThrow();
      await expect(audit.status()).rejects.toThrow();
      expect(await disk.readFile(f.file, "utf8")).toBe(malformed);
      expect((await readdir(f.dir)).filter(name => name.endsWith(".jsonl"))).toEqual([]);

      await writeFile(f.file, f.original);
      await audit.start();
      expect(await audit.status()).toMatchObject({ ok: true, deviceId: f.meta.deviceId, epoch: f.meta.epoch, retentionDays: 30 });
      expect(await audit.report(query)).toMatchObject({ total: 1, completed: 1, duplicates: 0 });
      expect(await disk.readFile(f.file, "utf8")).toBe(f.original);
    },
  );
});
