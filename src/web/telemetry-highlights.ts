import type { Json } from "./components/JsonInspector";
import type { RadarSession } from "./telemetry-inspection";

export type TelemetryFields = Record<string, Json>;
export const PROMPT_FIELDS = ["prompt_text", "user_prompt", "prompt", "gen_ai.prompt", "gen_ai.input.messages"];
export const RESPONSE_FIELDS = ["response", "assistant_response", "completion", "gen_ai.completion", "gen_ai.output.messages"];
export const PROJECT_FIELDS = ["project.name", "project_name", "project", "workspace.name", "workspace", "repository.name", "repo.name"];
export const DIRECTORY_FIELDS = ["cwd", "working_directory", "working.directory", "process.cwd", "process.working_directory", "workspace.path", "project.path", "project_path"];
export const objectValue = (value: Json | undefined): TelemetryFields => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const arrayValue = (value: Json | undefined): Json[] => Array.isArray(value) ? value : [];
export function otlpValue(value: Json | undefined): Json {
  const v = objectValue(value);
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue", "bytesValue"]) if (v[key] !== undefined) return v[key];
  if (v.arrayValue) return arrayValue(objectValue(v.arrayValue).values).map(otlpValue);
  if (v.kvlistValue) return attributes(objectValue(v.kvlistValue).values);
  return null;
}
export function attributes(value: Json | undefined): TelemetryFields {
  return Object.fromEntries(arrayValue(value).map(item => { const a = objectValue(item); return [String(a.key), otlpValue(a.value)]; }));
}
export const redactedValue = (value: Json) => typeof value === "string" && /^(?:\[redacted\]|<redacted>|\(redacted\)|redacted)$/i.test(value.trim());
export function fieldEvidence(fields: TelemetryFields, aliases: string[]) {
  const keys = aliases.filter(key => fields[key] !== undefined && fields[key] !== null && fields[key] !== "");
  const key = keys.find(key => !redactedValue(fields[key])) ?? keys[0];
  return key ? { state: redactedValue(fields[key]) ? "redacted" as const : "included" as const, key, value: fields[key] }
    : { state: "absent" as const, key: null, value: null };
}
/** A short excerpt from actual exported fields; never reconstruct hidden text. */
export function promptPreview(payload: Json | undefined): string | null {
  let hidden = false;
  const root = objectValue(payload);
  for (const [resources, scopes, records] of [["resourceLogs", "scopeLogs", "logRecords"], ["resourceSpans", "scopeSpans", "spans"], ["resourceMetrics", "scopeMetrics", "metrics"]]) {
    for (const resource of arrayValue(root[resources])) for (const scope of arrayValue(objectValue(resource)[scopes])) for (const record of arrayValue(objectValue(scope)[records])) {
      const evidence = fieldEvidence(attributes(objectValue(record).attributes), PROMPT_FIELDS);
      if (evidence.state === "redacted") hidden = true;
      if (evidence.state === "included") {
        const text = (typeof evidence.value === "string" ? evidence.value : JSON.stringify(evidence.value)).replace(/\s+/g, " ").trim();
        if (text) return text.length > 180 ? `${text.slice(0, 180)}…` : text;
      }
    }
  }
  return hidden ? "Prompt redacted" : null;
}
export function recordPriority(record: TelemetryFields) {
  const fields = attributes(record.attributes);
  if (/error|fatal/i.test(String(record.severityText ?? "")) || (typeof record.severityNumber === "number" && record.severityNumber >= 17)) return 0;
  if (fieldEvidence(fields, ["error.message", "exception.message", "error", "error_type"]).state !== "absent" || fields.success === false) return 0;
  if (fieldEvidence(fields, PROMPT_FIELDS).state !== "absent") return 1;
  if (fieldEvidence(fields, RESPONSE_FIELDS).state !== "absent") return 2;
  if (fieldEvidence(fields, ["tool_name", "tool.name", "gen_ai.tool.name", "model", "gen_ai.request.model", "cost_usd", "input_tokens"]).state !== "absent") return 3;
  const name = String(record.eventName ?? record.name ?? fields["event.name"] ?? "");
  if (/^(?:claude_code[._])?(?:plugin[._]loaded|managed[._]settings[._]resolved)$/i.test(name)) return 4;
  if (record.body !== undefined && otlpValue(record.body) !== null && otlpValue(record.body) !== "") return 3;
  return 4;
}
/** Local project context requires an exact captured session ID, never a socket guess. */
export function projectEvidence(fields: TelemetryFields, sessions: RadarSession[]) {
  const project = fieldEvidence(fields, PROJECT_FIELDS), directory = fieldEvidence(fields, DIRECTORY_FIELDS);
  if (project.state !== "absent" || directory.state !== "absent") return { source: "export" as const, project, directory };
  const session = fieldEvidence(fields, ["session.id", "session_id", "gen_ai.conversation.id"]);
  const matches = sessions.filter(s => s.id === session.value && s.workspace);
  const paths = new Set(matches.map(s => s.workspace!));
  if (paths.size === 1) return { source: "local" as const, project: { state: "included" as const, value: matches[0].project ?? matches[0].label, key: null }, directory: { state: "included" as const, value: matches[0].workspace!, key: null } };
  return { source: "absent" as const, project, directory };
}
