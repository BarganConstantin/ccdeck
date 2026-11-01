import { t as translateNow, type TFunction } from "./i18n";

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

export function radarStatus(snapshot: RadarSnapshot | null, failed = false, t: TFunction = translateNow): string {
  if (failed) return t("radar.status.interrupted");
  if (!snapshot) return t("radar.status.reading");
  if (snapshot.status === "unsupported") return t("radar.status.unsupported");
  if (snapshot.status === "unavailable") return t("radar.status.incomplete");
  if (snapshot.connections.some(connection => connection.active && !connection.connecting)) return t("radar.status.observed");
  return t("radar.status.none");
}

export function connectionLabel(connection: { active: boolean | null; connecting?: boolean }, stale = false, t: TFunction = translateNow): string {
  if (stale || connection.active === null) return t("radar.conn.unavailable");
  if (connection.connecting) return connection.active ? t("radar.conn.connecting") : t("radar.conn.attempted");
  return connection.active ? t("radar.conn.active") : t("radar.conn.previous");
}

export function captureSummary(variables: RadarVariable[], t: TFunction = translateNow): string {
  const content = variables.filter(v => [
    "OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES",
  ].includes(v.key));
  if (content.some(v => v.value.startsWith("Enabled"))) return t("radar.capture.enabled");
  if (content.length) return t("radar.capture.review");
  return t("radar.capture.unknown");
}
