import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { systemCommand, powershell, WINDOWS_PROCESSES, windowsSockets, linuxSockets } from './traffic-radar-platform.mjs';
import { readRadarConfig } from "./traffic-radar-config.mjs";

export function claudePids(text) {
  const pids = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match && ["claude", "claude-native"].includes(match[2].split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "").toLowerCase())) {
      const pid = Number(match[1]);
      if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

export function parseRadarSockets(text, pids) {
  const allowed = new Set(pids);
  const sockets = new Map();
  let pid = null;
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trimEnd();
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (!allowed.has(pid) || !line.startsWith("n")) continue;
    const peer = line.slice(1).split("->")[1];
    if (!peer) continue;
    const match = /^(\[[0-9a-fA-F:.%]+\]|[0-9.]+):(\d+)$/.exec(peer);
    if (!match) continue;
    const port = Number(match[2]);
    if (port < 1 || port > 65535) continue;
    const destination = `${match[1]}:${port}`;
    sockets.set(`${pid}|${destination}`, { pid, destination });
  }
  return [...sockets.values()];
}

export function parseRadarWorkspaces(text, pids, home = homedir()) {
  const allowed = new Set(pids);
  const workspaces = new Map();
  let pid = null;
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trimEnd();
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (allowed.has(pid) && line.startsWith("n/")) {
      const path = line.slice(1);
      workspaces.set(pid, path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
    }
  }
  return workspaces;
}

export function createTrafficRadar({ platform = process.platform, now = Date.now, run = systemCommand, config = readRadarConfig, readLinuxSockets = linuxSockets } = {}) {
  let pending = null;
  let cached = null;
  let previousAt = null;
  let previousConfig = null;
  const seen = new Map();
  let alerts = [];
  let serial = 0;
  const addAlert = (message, at) => {
    alerts.unshift({ id: ++serial, message, at });
    alerts = alerts.slice(0, 8);
  };

  async function sample() {
    const sampledAt = now();
    if (previousAt !== null && sampledAt - previousAt > 30_000) {
      seen.clear();
      alerts = [];
      previousConfig = null;
    }
    const base = { ok: true, sampledAt, platform, pollMs: 5_000, processCount: 0, connections: [], alerts: [] };
    if (!["darwin", "linux", "win32"].includes(platform)) return { ...base, status: "unsupported", config: null };
    const [configuration, processes] = await Promise.all([config({ platform }), platform === "win32" ? run("powershell.exe", powershell(WINDOWS_PROCESSES)) : run("/bin/ps", ["-axo", "pid=,comm="])]);
    const nextConfig = new Map(configuration.variables.filter(v => !v.key.endsWith("HEADERS")).map(v => [`${v.source}:${v.key}`, v.value]));
    if (previousConfig) {
      for (const [key, value] of nextConfig) {
        if (previousConfig.get(key) === value) continue;
        const variable = key.slice(key.indexOf(":") + 1);
        if (variable.includes("ENDPOINT")) addAlert("Telemetry destination configuration changed. Review settings below.", sampledAt);
        if (/^OTEL_LOG_/.test(variable) && value.startsWith("Enabled")) addAlert("Content capture configuration changed to enabled. Review settings below.", sampledAt);
      }
    }
    const pids = claudePids(processes);
    const selected = pids.slice(0, 64);
    let sockets = "";
    let cwd = "";
    if (selected.length && platform === "linux") ({ sockets, cwd } = await readLinuxSockets(selected));
    else if (selected.length && platform === "win32") sockets = await run("powershell.exe", powershell(windowsSockets(selected)));
    else if (selected.length) [sockets, cwd] = await Promise.all([
      run("/usr/sbin/lsof", ["-nP", "-a", "-p", selected.join(","), "-iTCP", "-sTCP:ESTABLISHED", "-Fpn"]),
      run("/usr/sbin/lsof", ["-nP", "-a", "-p", selected.join(","), "-d", "cwd", "-Fpn"]),
    ]);
    const workspaces = parseRadarWorkspaces(cwd, selected);
    const status = processes === null || sockets === null ? "unavailable" : "observing";
    if (cached?.status === "observing" && status === "unavailable") addAlert("Connection visibility lost. A failed sample does not mean traffic stopped.", sampledAt);
    const current = parseRadarSockets(sockets, selected);
    const active = new Set(current.map(s => `${s.pid}|${s.destination}`));
    const destinations = new Set([...seen.values()].map(s => s.destination));
    for (const connection of current) {
      const key = `${connection.pid}|${connection.destination}`;
      if (!seen.has(key)) {
        if (previousAt !== null && previousConfig && !destinations.has(connection.destination)) addAlert(`New Claude connection destination: ${connection.destination}`, sampledAt);
        destinations.add(connection.destination);
        seen.set(key, { ...connection, workspace: workspaces.get(connection.pid) ?? null, firstSeenAt: sampledAt, lastSeenAt: sampledAt });
      } else seen.get(key).lastSeenAt = sampledAt;
    }
    for (const [key, connection] of seen) if (sampledAt - connection.lastSeenAt > 300_000) seen.delete(key);
    while (seen.size > 100) seen.delete(seen.keys().next().value);
    previousAt = sampledAt;
    previousConfig = nextConfig;
    return { ...base, status, config: configuration, processCount: pids.length, limited: pids.length > selected.length,
      connections: [...seen.entries()].map(([key, value]) => ({ ...value, active: status === "observing" ? active.has(key) : null }))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt), alerts };
  }

  return {
    read() {
      if (pending) return pending;
      if (cached && now() - cached.sampledAt < 3_000) return Promise.resolve(cached);
      pending = sample().then(result => { cached = result; return result; }).finally(() => { pending = null; });
      return pending;
    },
  };
}

export const trafficRadar = createTrafficRadar();
