import type { AgentNodeData } from "./types";

export type VisualFamilyAgent = Pick<AgentNodeData, "id" | "sessionId" | "provider" | "kind" | "parentId">;

export interface VisualFamily {
  /** Stable grouping key for layout and visual wrappers; never a telemetry id. */
  familyKey: string;
  /** The root to focus or label for this visual family. */
  rootId: string;
}

/**
 * Resolve visual families without changing provider session identity.
 *
 * Claude children keep their long-standing sessionId grouping. A Codex child
 * joins the Codex root reached through real parentId links. Missing parents,
 * cross-provider links and cycles stay isolated per node so unknown ancestry
 * can never merge unrelated sessions.
 */
export function buildVisualFamilies(agents: Iterable<VisualFamilyAgent>): Map<string, VisualFamily> {
  const rows = [...agents];
  const byId = new Map(rows.map(agent => [agent.id, agent]));
  const resolved = new Map<string, { family: VisualFamily; valid: boolean }>();
  const resolving = new Set<string>();

  const resolve = (agent: VisualFamilyAgent): { family: VisualFamily; valid: boolean } => {
    const cached = resolved.get(agent.id);
    if (cached) return cached;

    if (agent.provider !== "codex") {
      const rootId = agent.sessionId || agent.id;
      const value = { family: { familyKey: `session:${rootId}`, rootId }, valid: true };
      resolved.set(agent.id, value);
      return value;
    }
    if (agent.kind === "root") {
      const value = { family: { familyKey: `codex-family:${agent.id}`, rootId: agent.id }, valid: true };
      resolved.set(agent.id, value);
      return value;
    }
    if (agent.kind !== "subagent" || !agent.parentId || resolving.has(agent.id)) {
      const value = { family: { familyKey: `codex-node:${agent.id}`, rootId: agent.id }, valid: false };
      resolved.set(agent.id, value);
      return value;
    }

    resolving.add(agent.id);
    const parent = byId.get(agent.parentId);
    const ancestor = parent?.provider === "codex" ? resolve(parent) : undefined;
    resolving.delete(agent.id);
    const value = ancestor?.valid
      ? ancestor
      : { family: { familyKey: `codex-node:${agent.id}`, rootId: agent.id }, valid: false };
    resolved.set(agent.id, value);
    return value;
  };

  return new Map(rows.map(agent => [agent.id, resolve(agent).family]));
}
