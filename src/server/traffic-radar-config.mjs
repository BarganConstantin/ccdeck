import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";

const BOOLEAN_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY", "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
  "ENABLE_ENHANCED_TELEMETRY_BETA", "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES", "OTEL_LOG_MANAGED_SETTINGS",
];
const SIGNALS = ["METRICS", "LOGS", "TRACES"];
const ENDPOINT_KEYS = ["OTEL_EXPORTER_OTLP_ENDPOINT", ...SIGNALS.map(s => `OTEL_EXPORTER_OTLP_${s}_ENDPOINT`)];
const EXPORTER_KEYS = SIGNALS.map(s => `OTEL_${s}_EXPORTER`);
const INTERVAL_KEYS = ["OTEL_METRIC_EXPORT_INTERVAL", "OTEL_LOGS_EXPORT_INTERVAL", "OTEL_TRACES_EXPORT_INTERVAL"];
const HEADER_KEYS = ["OTEL_EXPORTER_OTLP_HEADERS", ...SIGNALS.map(s => `OTEL_EXPORTER_OTLP_${s}_HEADERS`)];
export const RADAR_KEYS = [...BOOLEAN_KEYS, ...ENDPOINT_KEYS, ...EXPORTER_KEYS, ...INTERVAL_KEYS, ...HEADER_KEYS];

export function safeRadarValue(key, raw) {
  if (HEADER_KEYS.includes(key)) return "Configured (hidden)";
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return "Invalid (value hidden)";
  const value = String(raw).trim();
  if (BOOLEAN_KEYS.includes(key)) {
    if (key === "OTEL_LOG_RAW_API_BODIES" && value.startsWith("file:")) return "Enabled (file destination hidden)";
    if (["1", "true"].includes(value)) return "Enabled";
    if (["0", "false"].includes(value)) return "Disabled";
    return "Unknown (value hidden)";
  }
  if (ENDPOINT_KEYS.includes(key)) {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return "Invalid (value hidden)";
      return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
    } catch { return "Invalid (value hidden)"; }
  }
  if (EXPORTER_KEYS.includes(key)) {
    const exporters = value.split(",").map(s => s.trim());
    return exporters.length && exporters.every(s => ["otlp", "console", "none", "prometheus"].includes(s))
      ? exporters.join(", ") : "Unknown (value hidden)";
  }
  if (INTERVAL_KEYS.includes(key)) {
    return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 86_400_000
      ? `${Number(value)} ms` : "Invalid (value hidden)";
  }
  return "Unknown (value hidden)";
}

export function radarVariables(settings, source) {
  const env = settings?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  return RADAR_KEYS.filter(key => Object.hasOwn(env, key)).map(key => ({
    key, value: safeRadarValue(key, env[key]), source,
  }));
}

async function readBoundedJson(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 262_144) throw new Error("invalid_file");
    const buffer = Buffer.alloc(262_145);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 262_144) throw new Error("oversize");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

export async function readRadarConfig({ home = homedir(), env = process.env, readJson = readBoundedJson } = {}) {
  const dir = claudeConfigDir(env, home);
  const files = [
    ["User settings", join(dir, "settings.json")],
    ["Cached organization settings", join(dir, "remote-settings.json")],
    ["Managed settings", "/Library/Application Support/ClaudeCode/managed-settings.json"],
  ];
  const sources = await Promise.all(files.map(async ([name, path]) => {
    try {
      const settings = await readJson(path);
      return { name, status: "read", variables: radarVariables(settings, name) };
    } catch (error) {
      return { name, status: error?.code === "ENOENT" ? "absent" : "unavailable", variables: [] };
    }
  }));
  return { sources: sources.map(({ name, status }) => ({ name, status })), variables: sources.flatMap(s => s.variables) };
}
