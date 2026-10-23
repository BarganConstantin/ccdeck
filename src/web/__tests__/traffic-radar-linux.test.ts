import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePids, createTrafficRadar, parseRadarSockets } from "../../server/traffic-radar.mjs";
import { linuxSockets, linuxVersionedClaude, readEnviron, readProc } from "../../server/traffic-radar-platform.mjs";
import { radarTargets } from "../../server/traffic-radar-service.mjs";
import { observedDestinations } from "../telemetry-inspection";

// Linux Radar evidence first written on an earlier, unreleased branch, rebuilt
// on the current /proc reader rather than that branch's full /proc scan and
// `ss` dependency.
const secret = "private-secret-value";
const config = async () => ({ sources: [], variables: [] });
const failure = (code: string) => Object.assign(new Error(code), { code });
const tcpRow = (remote: string, inode: string, state = "01") => `0: 0100007F:1234 ${remote} ${state} 0:0 0:0 0 1000 0 ${inode}`;
const procPid = (path: string) => Number(path.split("/")[2]);
const noLaunch = { readEnv: async () => Buffer.alloc(0) };

describe("Claude Code processes on Linux", () => {
  it("confirms processes named by their version through the native installer's executable, never argv", async () => {
    const exe: Record<number, string> = {
      42: "/home/test/.local/share/claude/versions/2.1.308",
      43: "/home/test/.local/share/claude/versions/2.1.299 (deleted)",
      44: "/opt/tool/versions/1.2.3",
    };
    const link = vi.fn(async (path: string) => { if (exe[procPid(path)]) return exe[procPid(path)]; throw failure("ENOENT"); });
    expect(await linuxVersionedClaude("41 claude\n 42 2.1.308\n43 2.1.299\n44 1.2.3\n45 node\n46 2.1\n47 2.1.300\n", { link })).toEqual([42, 43]);
    expect(link.mock.calls.map(([path]) => path)).toEqual(["/proc/42/exe", "/proc/43/exe", "/proc/44/exe", "/proc/47/exe"]);
  });

  it("recognizes the binary the VS Code extension ships, by its executable name", () => {
    // The linux-x64 extension package (2.1.308) carries exactly one executable: resources/native-binary/claude.
    expect(claudePids("4242 claude\n4243 /home/test/.vscode/extensions/anthropic.claude-code-2.1.308-linux-x64/resources/native-binary/claude\n4244 code\n")).toEqual([4242, 4243]);
  });

  it("counts Claude started by its versioned path with the claude command, on Linux only", async () => {
    const readLinuxSockets = vi.fn(async () => ({ sockets: "", cwd: "", denied: 0, launch: [] }));
    const findLinuxClaude = vi.fn(async () => [42]);
    const radar = createTrafficRadar({ platform: "linux", config, run: async () => "41 claude\n42 2.1.308\n", readLinuxSockets, findLinuxClaude });
    expect((await radar.read()).processCount).toBe(2);
    expect(readLinuxSockets).toHaveBeenCalledWith([41, 42]);
    const darwin = vi.fn(async () => [42]);
    const run = async (file: string) => file === "/bin/ps" ? "41 /bin/claude\n42 2.1.308" : "";
    expect((await createTrafficRadar({ platform: "darwin", config, run, findLinuxClaude: darwin }).read()).processCount).toBe(1);
    expect(darwin).not.toHaveBeenCalled();
  });
});

describe("Linux visibility when a Claude process cannot be inspected", () => {
  it("keeps observing readable processes and counts the one it could not inspect", async () => {
    const result = await linuxSockets([41, 42], {
      ...noLaunch,
      list: async (path: string) => { if (path === "/proc/41/fd") throw failure("EACCES"); return ["3"]; },
      link: async (path: string) => path.endsWith("cwd") ? "/home/test/project" : "socket:[100]",
      read: async (path: string) => "header\n" + (path.endsWith("tcp6") ? "" : tcpRow("100200C0:10DD", "100")),
    });
    expect(result.sockets).toContain("192.0.2.16:4317");
    expect(result.denied).toBe(1);
    const radar = createTrafficRadar({ platform: "linux", config, run: async () => "41 claude\n42 claude", findLinuxClaude: async () => [], readLinuxSockets: async () => result });
    expect(await radar.read()).toMatchObject({ status: "observing", processCount: 2, uninspected: 1,
      connections: [{ pid: 42, destination: "192.0.2.16:4317", active: true }] });
  });

  it("stays unavailable when no Claude process could be inspected", async () => {
    const result = await linuxSockets([41, 42], { ...noLaunch, list: async (path: string) => { throw failure(path.includes("/41/") ? "EACCES" : "ENOENT"); } });
    expect(result.sockets).toBeNull();
    const radar = createTrafficRadar({ platform: "linux", config, run: async () => "41 claude\n42 claude", findLinuxClaude: async () => [], readLinuxSockets: async () => result });
    expect(await radar.read()).toMatchObject({ status: "unavailable", uninspected: 1 });
  });
});

describe("Linux socket tables", () => {
  // A /proc file reports size 0 and answers one page per read. Node 18's
  // fs.promises.readFile stopped after that first page, so a busy machine's
  // socket table lost every row past about the 27th. This handle answers the
  // way procfs does.
  const procFile = (data: Buffer, page = 4050) => {
    let at = 0;
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({
      read: async (buffer: Buffer, offset: number, length: number) => {
        const bytesRead = data.copy(buffer, offset, at, Math.min(at + page, at + length, data.length));
        at += bytesRead;
        return { bytesRead, buffer };
      },
      close,
    }));
    return { open, close };
  };

  it("reads a /proc file to its end one page at a time, within a bound", async () => {
    const table = Buffer.from(["header", ...Array.from({ length: 1200 }, (_, i) => tcpRow("100200C0:10DD", String(1000 + i)))].join("\n"));
    const whole = procFile(table);
    expect((await readProc("/proc/42/net/tcp", 67_108_864, whole.open))?.equals(table)).toBe(true);
    expect(whole.open).toHaveBeenCalledWith("/proc/42/net/tcp", "r");
    expect(whole.close).toHaveBeenCalledTimes(1);
    const over = procFile(table);
    expect(await readProc("/proc/42/net/tcp", table.length - 1, over.open)).toBeNull();
    expect(over.close).toHaveBeenCalledTimes(1);
  });

  it("parses a network namespace's table once per sample and retries a failed shared read", async () => {
    const links = (path: string) => path.endsWith("ns/net") ? "net:[4026531840]" : path.endsWith("cwd") ? "/home/test/project" : path.includes("/41/") ? "socket:[100]" : "socket:[200]";
    const read = vi.fn(async (path: string) => "header\n" + (path.endsWith("tcp6") ? "" : [tcpRow("100200C0:10DD", "100"), tcpRow("110200C0:10DD", "200")].join("\n")));
    const result = await linuxSockets([41, 42, 43], { ...noLaunch, list: async () => ["3"], link: async (path: string) => links(path), read });
    expect(read).toHaveBeenCalledTimes(2);
    expect(parseRadarSockets(result.sockets, [41, 42, 43]).sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 41, destination: "192.0.2.16:4317" }, { pid: 42, destination: "192.0.2.17:4317" }, { pid: 43, destination: "192.0.2.17:4317" },
    ]);
    const flaky = vi.fn(async (path: string) => { if (path === "/proc/41/net/tcp") throw failure("ENOENT"); return read(path); });
    const retried = await linuxSockets([41, 42], { ...noLaunch, list: async () => ["3"], link: async (path: string) => links(path), read: flaky });
    expect(retried.sockets).toContain("192.0.2.17:4317");
  });
});

describe("Linux connection attempts", () => {
  it("keeps attempts with no reply apart from established connections", async () => {
    const sockets: Record<string, string> = { 3: "socket:[100]", 4: "socket:[200]", 5: "socket:[300]", 6: "socket:[400]" };
    const result = await linuxSockets([42], {
      ...noLaunch,
      list: async () => Object.keys(sockets),
      link: async (path: string) => path.endsWith("cwd") ? "/home/test/project" : sockets[path.split("/").at(-1)!],
      read: async (path: string) => "header\n" + (path.endsWith("tcp6") ? "" : [
        tcpRow("100200C0:10DD", "100", "02"),
        tcpRow("110200C0:01BB", "200", "01"),
        tcpRow("110200C0:01BB", "300", "02"),
        tcpRow("120200C0:10DD", "400", "06"),
      ].join("\n")),
    });
    expect(parseRadarSockets(result.sockets, [42])).toEqual([
      { pid: 42, destination: "192.0.2.16:4317", connecting: true },
      { pid: 42, destination: "192.0.2.17:443" },
    ]);
  });

  it("marks a sampled attempt connecting until it is established, and never targets it for monitoring", async () => {
    let at = 10_000;
    let sockets = "p42\nnlocal->192.0.2.16:4317\nTST=SYN_SENT\n";
    const radar = createTrafficRadar({ platform: "linux", now: () => at, config, run: async () => "42 claude", findLinuxClaude: async () => [],
      readLinuxSockets: async () => ({ sockets, cwd: "", denied: 0, launch: [] }) });
    const first = await radar.read();
    expect(first.connections).toEqual([expect.objectContaining({ destination: "192.0.2.16:4317", active: true, connecting: true })]);
    expect(observedDestinations(first)).toEqual([]);
    expect(radarTargets(first).observed).toEqual([]);
    sockets = "p42\nnlocal->192.0.2.16:4317\n";
    at += 5_000;
    const second = await radar.read();
    expect(second.connections[0]).not.toHaveProperty("connecting");
    expect(observedDestinations(second)).toEqual(["192.0.2.16:4317"]);
    expect(radarTargets(second).observed).toEqual(["192.0.2.16:4317"]);
  });
});

describe("Claude's launch environment on Linux", () => {
  const environ = (...extra: string[]) => Buffer.from([
    `ANTHROPIC_API_KEY=${secret}`, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${secret}`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=http://user:${secret}@192.0.2.16:4317/v1`,
    "CLAUDE_CODE_ENABLE_TELEMETRY=1", `PATH=/${secret}`, ...extra, "",
  ].join("\0"));

  it("reads only allowlisted telemetry variables, one row per value across processes", async () => {
    const environs: Record<number, Buffer> = { 41: environ("OTEL_LOG_USER_PROMPTS=1"), 42: environ("OTEL_LOG_USER_PROMPTS=0"), 43: environ("OTEL_LOG_USER_PROMPTS=1") };
    const readEnv = vi.fn(async (path: string) => { if (procPid(path) === 44) throw failure("EACCES"); return environs[procPid(path)]; });
    const result = await linuxSockets([41, 42, 43, 44], { list: async () => [], link: async () => "/home/test/project", read: async () => "header\n", readEnv });
    expect(readEnv.mock.calls.map(([path]) => path).sort()).toEqual(["/proc/41/environ", "/proc/42/environ", "/proc/43/environ", "/proc/44/environ"]);
    expect(result.denied).toBe(0);
    let at = 10_000;
    const radar = createTrafficRadar({ platform: "linux", now: () => at, config, run: async () => "41 claude\n42 claude\n43 claude\n44 claude", findLinuxClaude: async () => [], readLinuxSockets: async () => result });
    const snapshot = await radar.read();
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.status).toBe("observing");
    expect(snapshot.config.variables).toEqual([]);
    expect(snapshot.environment.map((v: { key: string; value: string; source: string }) => [v.key, v.value, v.source])).toEqual([
      ["CLAUDE_CODE_ENABLE_TELEMETRY", "Enabled", "Process launch environment · PID 41 and 2 more"],
      ["OTEL_LOG_USER_PROMPTS", "Enabled", "Process launch environment · PID 41 and 1 more"],
      ["OTEL_EXPORTER_OTLP_ENDPOINT", "http://192.0.2.16:4317", "Process launch environment · PID 41 and 2 more"],
      ["OTEL_EXPORTER_OTLP_HEADERS", "Configured (hidden)", "Process launch environment · PID 41 and 2 more"],
      ["OTEL_LOG_USER_PROMPTS", "Disabled", "Process launch environment · PID 42"],
    ]);
    expect(snapshot.environment.every((v: { launch?: boolean }) => v.launch === true)).toBe(true);
    expect(snapshot.environment.filter((v: { editable?: boolean }) => v.editable === false).map((v: { key: string }) => v.key)).toEqual(["CLAUDE_CODE_ENABLE_TELEMETRY", "OTEL_LOG_USER_PROMPTS", "OTEL_LOG_USER_PROMPTS"]);
    expect(radarTargets(snapshot).configured).toEqual(["192.0.2.16:4317"]);
    // A saved settings switch replaces settings evidence only; process evidence stays.
    radar.updateConfig({ sources: [], variables: [] });
    expect((await radar.read()).environment).toHaveLength(5);
    // Processes starting and stopping are not settings changes.
    at += 5_000;
    expect((await radar.read()).alerts).toEqual([]);
  });

  it("reads at most 256 KiB of a process environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "radar-environ-"));
    try {
      await writeFile(join(dir, "small"), environ());
      await writeFile(join(dir, "large"), Buffer.alloc(262_145, 65));
      expect((await readEnviron(join(dir, "small")))?.toString()).toContain("CLAUDE_CODE_ENABLE_TELEMETRY=1");
      expect(await readEnviron(join(dir, "large"))).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
