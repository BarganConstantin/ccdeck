import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { claudePids, createTrafficRadar, parseRadarSockets, parseRadarWorkspaces } from "../../server/traffic-radar.mjs";
import { radarVariables, readRadarConfig, safeRadarValue } from "../../server/traffic-radar-config.mjs";
import { GUARDED_READS } from "../../server/request-gates.mjs";

const secret = "private-secret-value";
const socket = (pid = 42, destination = "192.0.2.16:4317") => `p${pid}\nn127.0.0.1:5000->${destination}\n`;
const configuration = { sources: [], variables: [] };

describe("Telemetry Radar privacy boundary", () => {
  it("allows only named telemetry variables, never arbitrary settings", () => {
    const variables = radarVariables({ env: {
      ANTHROPIC_API_KEY: secret,
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${secret}`,
      OTEL_EXPORTER_OTLP_ENDPOINT: `https://user:${secret}@collector.example:4317/private/${secret}?key=${secret}`,
      OTEL_LOG_USER_PROMPTS: "1",
    }, permissions: { secret } }, "User settings");
    expect(variables).toEqual([
      { key: "OTEL_LOG_USER_PROMPTS", value: "Enabled", source: "User settings" },
      { key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "https://collector.example:4317", source: "User settings" },
      { key: "OTEL_EXPORTER_OTLP_HEADERS", value: "Configured (hidden)", source: "User settings" },
    ]);
    expect(JSON.stringify(variables)).not.toContain(secret);
  });

  it("hides malformed values and raw API file paths", () => {
    expect(safeRadarValue("OTEL_LOG_RAW_API_BODIES", `file:/private/${secret}`)).toBe("Enabled (file destination hidden)");
    expect(safeRadarValue("OTEL_LOG_USER_PROMPTS", secret)).toBe("Unknown (value hidden)");
    expect(safeRadarValue("OTEL_LOG_USER_PROMPTS", { secret })).toBe("Invalid (value hidden)");
    expect(safeRadarValue("OTEL_EXPORTER_OTLP_ENDPOINT", `file://${secret}`)).toBe("Invalid (value hidden)");
    expect(safeRadarValue("OTEL_LOGS_EXPORTER", secret)).toBe("Unknown (value hidden)");
    expect(safeRadarValue("OTEL_LOGS_EXPORT_INTERVAL", "0")).toBe("Invalid (value hidden)");
    expect(safeRadarValue("OTEL_LOGS_EXPORT_INTERVAL", "5000")).toBe("5000 ms");
    expect(safeRadarValue("OTEL_LOGS_EXPORTER", "otlp,console")).toBe("otlp, console");
  });

  it("distinguishes missing files from denied or malformed configuration", async () => {
    const readJson = vi.fn(async (path: string) => {
      if (path.endsWith("remote-settings.json")) throw Object.assign(new Error(secret), { code: "ENOENT" });
      if (path.includes("/Library/")) throw Object.assign(new Error(secret), { code: "EACCES" });
      return { env: { OTEL_LOG_USER_PROMPTS: "0" } };
    });
    const result = await readRadarConfig({ home: "/test", env: {}, readJson });
    expect(result.sources.map(s => s.status)).toEqual(["read", "absent", "unavailable"]);
    expect(result.variables[0].value).toBe("Disabled");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(readJson).toHaveBeenCalledTimes(3);
    expect(readJson.mock.calls.map(c => c[0]).join(" ")).not.toMatch(/projects|history|credentials/);
  });

  it("guards the route that exposes user-specific metadata", () => {
    expect(GUARDED_READS.has("/api/system/traffic-radar")).toBe(true);
    const source = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    expect(source).toContain('url.pathname === "/api/system/traffic-radar"');
  });
});

describe("Claude process and socket attribution", () => {
  it("does not read argv and does not mistake other providers for Claude", () => {
    expect(claudePids(" 42 /usr/local/bin/claude\n43 /bin/node\n44 /bin/codex\n45 /bin/claude-native\n46 /bin/claude-helper\n42 /bin/claude")).toEqual([42, 45]);
  });

  it("filters by PID, deduplicates peers and handles IPv6", () => {
    expect(parseRadarSockets(socket() + socket() + socket(43) + socket(42, "[2001:db8::1]:443") + "n*:9999\nnsecret:0\n", [42])).toEqual([
      { pid: 42, destination: "192.0.2.16:4317" },
      { pid: 42, destination: "[2001:db8::1]:443" },
    ]);
  });

  it("takes workspace from cwd rather than command arguments", () => {
    expect([...parseRadarWorkspaces("p42\nn/test/vcrm-core\np43\nn/private/elsewhere\n", [42], "/test")]).toEqual([[42, "~/vcrm-core"]]);
  });
});

describe("on-demand observation", () => {
  it("shares a single in-flight sample and recent result", async () => {
    let at = 10_000;
    const run = vi.fn(async (_file: string, args: string[]) => args.includes("pid=,comm=") ? "42 /bin/claude" : args.includes("cwd") ? "p42\nn/test/vcrm-core\n" : socket());
    const config = vi.fn(async () => configuration);
    const radar = createTrafficRadar({ platform: "darwin", now: () => at, run, config });
    const [a, b] = await Promise.all([radar.read(), radar.read()]);
    expect(a).toBe(b);
    expect(a.status).toBe("observing");
    expect(a.connections[0]).toMatchObject({ active: true, lastSeenAt: at });
    expect(run).toHaveBeenCalledTimes(3);
    expect(await radar.read()).toBe(a);
    at += 5_000;
    await radar.read();
    expect(run).toHaveBeenCalledTimes(6);
    expect(run.mock.calls.every(([, args]) => !args.includes("command=") && !args.includes("e"))).toBe(true);
  });

  it("does not equate a failed socket sample with absent traffic", async () => {
    let at = 10_000;
    let output: string | null = socket();
    const run = vi.fn(async (file: string, args: string[]) => file === "/bin/ps" ? "42 /bin/claude" : args.includes("cwd") ? "" : output);
    const radar = createTrafficRadar({ platform: "darwin", now: () => at, run, config: async () => configuration });
    await radar.read();
    at += 5_000;
    output = null;
    const result = await radar.read();
    expect(result.status).toBe("unavailable");
    expect(result.connections[0].active).toBeNull();
    expect(result.alerts[0].message).toContain("visibility lost");
  });

  it("shows an empty successful observation without claiming telemetry is disabled", async () => {
    const run = vi.fn(async (file: string) => file === "/bin/ps" ? "42 /bin/claude" : "");
    const radar = createTrafficRadar({ platform: "darwin", run, config: async () => ({ sources: [], variables: [{ key: "OTEL_LOGS_EXPORTER", source: "User settings", value: "otlp" }] }) });
    const result = await radar.read();
    expect(result.status).toBe("observing");
    expect(result.connections).toEqual([]);
    expect(result.config.variables[0].value).toBe("otlp");
  });

  it("does not scan other processes or invoke lsof when no Claude is identified", async () => {
    const run = vi.fn(async () => "43 /bin/codex\n44 /bin/node");
    const radar = createTrafficRadar({ platform: "darwin", run, config: async () => configuration });
    expect((await radar.read()).processCount).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("alerts on new destinations and content enablement, not normal repeated samples", async () => {
    let at = 10_000;
    let destination = "192.0.2.16:4317";
    let content = "Disabled";
    const radar = createTrafficRadar({ platform: "darwin", now: () => at,
      run: async (file: string, args: string[]) => file === "/bin/ps" ? "42 /bin/claude" : args.includes("cwd") ? "" : socket(42, destination),
      config: async () => ({ sources: [], variables: [{ key: "OTEL_LOG_USER_PROMPTS", source: "User settings", value: content }] }),
    });
    expect((await radar.read()).alerts).toEqual([]);
    at += 5_000;
    expect((await radar.read()).alerts).toEqual([]);
    destination = "192.0.2.17:4317";
    content = "Enabled";
    at += 5_000;
    expect((await radar.read()).alerts.map(a => a.message)).toEqual([
      "New Claude connection destination: 192.0.2.17:4317",
      "Content capture configuration changed to enabled. Review settings below.",
    ]);
    at += 5_000;
    expect((await radar.read()).alerts).toHaveLength(2);
  });

  it("resets observation history after the reader has been closed", async () => {
    let at = 10_000;
    let connected = true;
    const radar = createTrafficRadar({ platform: "darwin", now: () => at,
      run: async (file: string, args: string[]) => file === "/bin/ps" ? "42 /bin/claude" : args.includes("cwd") ? "" : connected ? socket() : "",
      config: async () => configuration,
    });
    await radar.read();
    at += 40_000;
    connected = false;
    const next = await radar.read();
    expect(next.connections).toEqual([]);
    expect(next.alerts).toEqual([]);
  });

  it.each(["linux", "win32"])("reports unavailable platform coverage on %s without subprocesses", async platform => {
    const run = vi.fn();
    const config = vi.fn();
    const result = await createTrafficRadar({ platform, run, config }).read();
    expect(result.status).toBe("unsupported");
    expect(run).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
  });
});
