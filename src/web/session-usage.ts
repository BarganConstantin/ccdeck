export type SessionSpeed = "auto" | "standard" | "fast" | "flex";
export interface SessionSelection { sessionId: string; agent: "claude" | "codex"; label: string }
export interface SessionTokens {
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheCreationTokens: number; reasoningOutputTokens: number;
}
export interface SessionDetail extends SessionTokens {
  sessionId: string; agent: "claude" | "codex"; speed: SessionSpeed;
  totalCost: number; totalTokens: number; firstActivity: string | null;
  lastActivity: string | null; entries: number | null;
  models: (SessionTokens & { model: string; totalTokens: number; missingPricing: boolean })[];
}
export interface SessionReply { ok: boolean; detail?: SessionDetail; reason?: string; error?: string }

export function canInspectSession(agent: string, id: string): agent is SessionSelection["agent"] {
  if (id.includes("..")) return false;
  return agent === "codex"
    ? /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)
    : agent === "claude" && /^[a-z\d][a-z\d._:-]{0,255}$/i.test(id);
}

export function sessionFailure(reply: SessionReply): string {
  if (reply.reason === "not_found") return "No usage found in the local logs for this session.";
  if (reply.reason === "ambiguous") return "More than one local log matches this session ID.";
  if (reply.reason === "no_install") return "Install ccusage to read this session’s usage.";
  if (reply.reason === "busy") return "Other usage reports are still loading. Try again in a moment.";
  if (reply.reason === "timeout") return "The session report took too long. Try again.";
  if (/unknown|unrecognized|unexpected|unsupported/i.test(reply.error ?? "") && /speed|--id|session|claude/i.test(reply.error ?? "")) {
    return "This copy of ccusage does not support the report. Update ccusage and try again.";
  }
  return "Could not read this session’s usage. Try again.";
}
