import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
// @ts-expect-error — plain server ES module
import { run, runInteractive, runDetached, killLiveChildren, liveChildPids, killTree } from "../../server/exec.mjs";
// @ts-expect-error — plain server ES module
import { watchChild } from "../../server/exec-children.mjs";

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function waitFor(check: () => Promise<boolean> | boolean, ms = 2000) {
  const until = Date.now() + ms;
  do {
    if (await check()) return true;
    await delay(20);
  } while (Date.now() < until);
  return false;
}

// Ordinary descendants: no detach/unref, signal handlers or inherited pipes
// keeping the parent alive. The PID file is written by the grandchild itself,
// so it proves both processes were running before cancellation or shutdown.
async function tree() {
  const dir = await mkdtemp(join(tmpdir(), "ccdeck-exec-descendants-"));
  const file = join(dir, "pids.json");
  const descendant = `
    require('node:fs').writeFileSync(process.argv[2], JSON.stringify([Number(process.argv[1]), process.pid]));
    setTimeout(() => {}, 60000);
  `;
  const parent = `
    require('node:child_process').spawn(process.execPath,
      ['-e', ${JSON.stringify(descendant)}, String(process.pid), process.argv[1]], {stdio: 'ignore'});
    setTimeout(() => {}, 60000);
  `;
  const pids = async (): Promise<number[]> => {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { return []; }
  };
  return {
    args: ["-e", parent, file],
    async ready() {
      expect(await waitFor(async () => (await pids()).length === 2, 2500), "grandchild reached its own code").toBe(true);
      const pair = await pids();
      expect(pair.every(alive)).toBe(true);
      return pair;
    },
    async cleanup() {
      const pair = await pids();
      for (const pid of pair.reverse()) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      expect(await waitFor(() => pair.every(pid => !alive(pid))), "synthetic PIDs cleaned up").toBe(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform === "win32")("owned POSIX command descendants", () => {
  it("ends the parent and grandchild at the real run deadline", async () => {
    const t = await tree();
    try {
      const pending = run(process.execPath, t.args, { timeout: 3000 });
      const pair = await t.ready();
      expect(await pending).toMatchObject({ ok: false, code: "ETIMEDOUT", timedOut: true });
      expect(await waitFor(() => pair.every(pid => !alive(pid))), "deadline must stop both owned processes").toBe(true);
    } finally { await t.cleanup(); }
  }, 10000);

  it("ends descendants when an interactive command is cancelled", async () => {
    const t = await tree();
    const handle = runInteractive(process.execPath, t.args, { timeout: 30000 });
    try {
      const pair = await t.ready();
      handle.kill();
      expect(await handle.done).toMatchObject({ ok: false, killed: true, timedOut: false });
      expect(await waitFor(() => pair.every(pid => !alive(pid))), "cancel must stop both owned processes").toBe(true);
    } finally { handle.kill(); await t.cleanup(); }
  }, 10000);

  it("reaps descendants during shutdown before the command deadline", async () => {
    const t = await tree();
    try {
      const pending = run(process.execPath, t.args, { timeout: 30000 });
      const pair = await t.ready();
      expect(killLiveChildren()).toBeGreaterThan(0);
      expect(await pending).toMatchObject({ ok: false, timedOut: false });
      expect(await waitFor(() => pair.every(pid => !alive(pid))), "shutdown must stop both owned processes").toBe(true);
    } finally { await t.cleanup(); }
  }, 10000);

  it("ends both processes at the interactive deadline too", async () => {
    const t = await tree();
    const handle = runInteractive(process.execPath, t.args, { timeout: 3000 });
    try {
      const pair = await t.ready();
      expect(await handle.done).toMatchObject({ ok: false, code: "ETIMEDOUT", timedOut: true });
      expect(await waitFor(() => pair.every(pid => !alive(pid)))).toBe(true);
    } finally { handle.kill(); await t.cleanup(); }
  }, 10000);

  it("leaves intentionally detached jobs out of the shutdown sweep", async () => {
    const t = await tree();
    try {
      runDetached(process.execPath, t.args);
      const pair = await t.ready();
      expect(liveChildPids()).not.toContain(pair[0]);
      killLiveChildren();
      expect(pair.every(alive)).toBe(true);
    } finally { await t.cleanup(); }
  }, 10000);

  it("stops the ccusage runner's descendants on its deadline", async () => {
    const t = await tree();
    vi.stubEnv("AGENTS_DECK_CCUSAGE", process.execPath);
    // Only advance the runner's 90-second timer. The subprocesses and their
    // pipes are real; readiness and PID checks use real node:timers promises.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // An explicit executable bypasses installation and provider discovery.
      // @ts-expect-error — plain server ES module
      const { runCcusage } = await import("../../server/ccusage-runner.mjs");
      const pending = runCcusage(t.args).catch((error: Error) => error);
      const pair = await t.ready();
      vi.advanceTimersByTime(90000);
      expect(await pending).toMatchObject({ reason: "timeout" });
      expect(await waitFor(() => pair.every(pid => !alive(pid)))).toBe(true);
    } finally {
      vi.useRealTimers(); vi.unstubAllEnvs();
      killLiveChildren(); await t.cleanup();
    }
  }, 10000);

  it("tracks ccusage work for shutdown before its own deadline", async () => {
    const t = await tree();
    vi.stubEnv("AGENTS_DECK_CCUSAGE", process.execPath);
    try {
      // @ts-expect-error — plain server ES module
      const { runCcusage } = await import("../../server/ccusage-runner.mjs");
      const pending = runCcusage(t.args).catch((error: Error) => error);
      const pair = await t.ready();
      expect(liveChildPids()).toContain(pair[0]);
      killLiveChildren();
      expect(await pending).toBeInstanceOf(Error);
      expect(await waitFor(() => pair.every(pid => !alive(pid)))).toBe(true);
    } finally {
      vi.unstubAllEnvs(); killLiveChildren(); await t.cleanup();
    }
  }, 10000);
});

describe("process group ownership guards", () => {
  it("does not treat a tracked child as owning its inherited POSIX group", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const signal = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn() });
    try {
      watchChild(child);
      killTree(child);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(signal).not.toHaveBeenCalled();
    } finally {
      child.emit("close"); signal.mockRestore();
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("forgets group ownership after close, so a stale handle cannot signal a reused PID", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const signal = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = Object.assign(new EventEmitter(), { pid: 4321, kill: vi.fn() });
    try {
      watchChild(child, { processGroup: true });
      killTree(child, "SIGTERM");
      expect(signal).toHaveBeenCalledWith(-4321, "SIGTERM");
      child.emit("close");
      signal.mockClear();
      killTree(child);
      expect(signal).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      child.emit("close"); signal.mockRestore();
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("buffered command output", () => {
  it("decodes split UTF-8 and keeps failure output and exit status", async () => {
    const result = await run(process.execPath, ["-e", `
      const bytes = Buffer.from('a🙂z');
      process.stdout.write(bytes.subarray(0, 3));
      setTimeout(() => { process.stdout.write(bytes.subarray(3)); process.stderr.write('failed'); process.exitCode = 7; }, 20);
    `]);
    expect(result).toMatchObject({ ok: false, code: 7, stdout: "a🙂z", stderr: "failed", timedOut: false });
  });

  it("enforces the configured output byte budget", async () => {
    const result = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(8192)); setTimeout(() => {}, 60000)"], { maxBuffer: 1024 });
    expect(result).toMatchObject({ ok: false, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
    expect(Buffer.byteLength(result.stdout)).toBe(1024);
  });
});
