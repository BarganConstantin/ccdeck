export interface RadarVariable {
  key: string;
  value: string;
  rawValue?: string;
  source: string;
  editable?: boolean;
  blockedReason?: string;
  /** Read from a running Claude process's launch environment (Linux): evidence, not a switch. */
  launch?: boolean;
}

export interface RadarSnapshot {
  ok: boolean;
  sampledAt: number;
  platform: string;
  pollMs: number;
  status: "unsupported" | "unavailable" | "observing";
  processCount: number;
  limited?: boolean;
  /** Claude processes whose sockets could not be read, such as another user's. */
  uninspected?: number;
  environment?: RadarVariable[];
  config: {
    sources: { name: string; status: "read" | "absent" | "unavailable" }[];
    variables: RadarVariable[];
    unsetFlags?: string[];
  } | null;
  connections: {
    pid: number;
    destination: string;
    workspace: string | null;
    firstSeenAt: number;
    lastSeenAt: number;
    active: boolean | null;
    /** Every socket to this destination is still awaiting a reply (Linux SYN-SENT). */
    connecting?: true;
  }[];
  alerts: { id: number; message: string; at: number }[];
}

export function radarStatus(snapshot: RadarSnapshot | null, failed = false): string {
  if (failed) return "Visibility interrupted";
  if (!snapshot) return "Reading configuration and connections…";
  if (snapshot.status === "unsupported") return "Connection monitoring is unavailable on this operating system";
  if (snapshot.status === "unavailable") return "Connection visibility incomplete";
  if (snapshot.connections.some(connection => connection.active && !connection.connecting)) return "Connections observed";
  return "No connections observed in this sample";
}

export function connectionLabel(connection: { active: boolean | null; connecting?: boolean }, stale = false): string {
  if (stale || connection.active === null) return "Visibility unavailable";
  if (connection.connecting) return connection.active ? "Connecting · no reply yet" : "Attempted · no reply seen";
  return connection.active ? "Active connection" : "Previously observed";
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
