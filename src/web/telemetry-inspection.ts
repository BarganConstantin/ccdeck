import type { RadarSnapshot, RadarVariable } from "./traffic-radar";
export interface RadarSession { id: string; label: string }
export function configuredDestinations(variables: RadarVariable[]) {
  return [...new Set(variables.filter(v => v.key.endsWith("ENDPOINT")).map(v => v.value).filter(v => /^https?:\/\//.test(v)))];
}
/** Socket evidence is independent of settings and never identifies telemetry. */
export function observedDestinations(snapshot: RadarSnapshot | null) {
  if (snapshot?.status !== "observing") return [];
  return [...new Set(snapshot.connections.filter(c => c.active === true).map(c => c.destination))];
}
export function captureAddress(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return null;
    return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  } catch { return null; }
}
export function configuredState(variables: RadarVariable[]) {
  const values = variables.filter(v => v.key === "CLAUDE_CODE_ENABLE_TELEMETRY").map(v => v.value);
  if (!values.length) return "Unknown";
  if (new Set(values).size > 1) return "Conflicting settings";
  return values[0] === "Enabled" ? "Enabled in settings" : values[0] === "Disabled" ? "Disabled in settings" : "Unknown";
}
export interface TelemetryFileRow { line: number; raw: string; label: string; sessionId: string | null; sessionIds: string[]; timestamp: string | null; valid: boolean }
export function parseTelemetryFile(text: string): TelemetryFileRow[] {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];
  // A whole JSON document and a JSONL stream are both useful inspection inputs.
  let lines: string[];
  try { JSON.parse(trimmed); lines = [trimmed]; } catch { lines = text.replace(/^\uFEFF/, "").split(/\r?\n/); }
  if (lines.length > 10000) throw new Error("This file has more than 10,000 lines. Choose a smaller export.");
  return lines.flatMap<TelemetryFileRow>((raw, index) => {
    if (!raw.trim()) return [];
    try {
      const value = JSON.parse(raw);
      const record = value && typeof value === "object" ? value : {};
      const ids = new Set<string>();
      const pending: unknown[] = [value];
      while (pending.length) {
        const entry = pending.pop();
        if (!entry || typeof entry !== "object") continue;
        if (Array.isArray(entry)) { for (const child of entry) pending.push(child); continue; }
        const node = entry as Record<string, unknown>;
        for (const key of ["session.id", "session_id", "sessionId"]) if (typeof node[key] === "string") ids.add(node[key] as string);
        if (["session.id", "session_id"].includes(String(node.key))) {
          const attribute = node.value as { stringValue?: unknown } | undefined;
          if (typeof attribute?.stringValue === "string") ids.add(attribute.stringValue);
        }
        for (const child of Object.values(node)) pending.push(child);
      }
      return [{ line: index + 1, raw, sessionIds: [...ids], label: String(record.eventName ?? record.event?.name ?? record.type ?? record.model ?? "JSON record").slice(0, 160),
        sessionId: typeof (record.session_id ?? record.sessionId ?? record["session.id"]) === "string" ? (record.session_id ?? record.sessionId ?? record["session.id"]) : null,
        timestamp: typeof record.timestamp === "string" ? record.timestamp : null, valid: true }];
    } catch { return [{ line: index + 1, raw, label: "Invalid JSON", sessionId: null, timestamp: null, sessionIds: [], valid: false }]; }
  });
}
