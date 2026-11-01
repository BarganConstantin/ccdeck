import { t } from "./i18n";

export type SessionSpeed = "auto" | "standard" | "fast" | "flex";
export interface SessionSelection { sessionId: string; agent: "claude" | "codex"; label: string }
export interface SessionTokens {
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheCreationTokens: number; reasoningOutputTokens: number;
}
export interface SessionDetail extends SessionTokens {
  cacheReuse?: { pct: number | null; inputTokens: number; cachedTokens: number;
    measured: number; total: number; unit: string };
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
  if (reply.reason === "not_found") return t("insights.session.err.notFound");
  if (reply.reason === "ambiguous") return t("insights.session.err.ambiguous");
  if (reply.reason === "no_install") return t("insights.session.err.noInstall");
  if (reply.reason === "busy") return t("insights.session.err.busy");
  if (reply.reason === "timeout") return t("insights.session.err.timeout");
  if (/unknown|unrecognized|unexpected|unsupported/i.test(reply.error ?? "") && /speed|--id|session|claude/i.test(reply.error ?? "")) {
    return t("insights.session.err.unsupported");
  }
  return t("insights.session.err.generic");
}
