export interface RadarVariable {
  key: string;
  value: string;
  source: string;
}

export interface RadarSnapshot {
  ok: boolean;
  sampledAt: number;
  platform: string;
  pollMs: number;
  status: "unsupported" | "unavailable" | "observing";
  processCount: number;
  limited?: boolean;
  config: {
    sources: { name: string; status: "read" | "absent" | "unavailable" }[];
    variables: RadarVariable[];
  } | null;
  connections: {
    pid: number;
    destination: string;
    workspace: string | null;
    firstSeenAt: number;
    lastSeenAt: number;
    active: boolean | null;
  }[];
  alerts: { id: number; message: string; at: number }[];
}

export function radarStatus(snapshot: RadarSnapshot | null, failed = false): string {
  if (failed) return "Visibility interrupted";
  if (!snapshot) return "Reading configuration and connections…";
  if (snapshot.status === "unsupported") return "Connection monitoring is available on macOS";
  if (snapshot.status === "unavailable") return "Connection visibility incomplete";
  if (snapshot.connections.some(connection => connection.active)) return "Connections observed";
  return "No connections observed in this sample";
}

export function captureSummary(variables: RadarVariable[]): string {
  const content = variables.filter(v => [
    "OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES",
  ].includes(v.key));
  if (content.some(v => v.value.startsWith("Enabled"))) return "Content capture enabled in a configuration source";
  if (content.length) return "Review capture flags; live session settings are unverified";
  return "Content capture settings unknown";
}
