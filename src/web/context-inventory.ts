// What a Claude Code session's project has installed, for the Context tab's
// read-only inventories: the skills (SkillsDialog.tsx) and the MCP servers
// (McpServersDialog.tsx), read from GET /api/session/skills and
// /api/session/mcp-servers (src/server/context-inventory-route.mjs) and set
// against the session's last /context: its Skills list says which skills are
// loaded, its MCP tools which servers were connected.
//
// Pure apart from the fetches, so the suite can pin which skill reads as
// loaded, what a search keeps and what each server's status says without a DOM.
import { mcpGroups } from "./context-snapshot";
import type { ContextSnapshot } from "./types";

export const SKILLS_ROUTE = "/api/session/skills";
export const MCP_SERVERS_ROUTE = "/api/session/mcp-servers";

/** Where a skill is installed, as the server says it. */
export type SkillScope = "user" | "project";

/** One skill the server found on disk. */
export interface DiskSkill {
  name: string;
  scope: SkillScope;
  description: string;
  path: string;
}

export type SkillsRead = { kind: "ready"; skills: DiskSkill[]; truncated: boolean } | { kind: "failed" };

/** Where a row's skill comes from: the two folders the server reads, a plugin
 *  (only ever from /context), or a source /context names that the deck does not. */
export type SkillSource = SkillScope | "plugin" | "other";

/** One row of the inventory. */
export interface SkillRow {
  key: string;
  name: string;
  source: SkillSource;
  /** /context's own word for a source the deck does not name. */
  sourceText?: string;
  description: string;
  /** The SKILL.md, when the skill is on disk. */
  path?: string;
  /** Listed by the session's last /context. */
  loaded: boolean;
  /** Its tokens in that /context, when it was listed. */
  tokens?: number;
}

/** The label key of each named source. */
export const SKILL_SOURCE_KEYS: Record<Exclude<SkillSource, "other">, string> = {
  user: "insights.context.memory.scope.user",
  project: "insights.context.memory.scope.project",
  plugin: "insights.context.skills.plugin",
};

const SCOPES: readonly SkillScope[] = ["user", "project"];

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** /context's Source cell as the deck names it: "User", "Project", "Plugin (x)". */
export function snapshotSkillSource(source: string): SkillSource {
  const s = source.trim().toLowerCase();
  if (s.startsWith("user")) return "user";
  if (s.startsWith("project")) return "project";
  if (s.startsWith("plugin")) return "plugin";
  return "other";
}

/** The folder a SKILL.md sits in: the name Claude Code may list it by. */
function folderOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

const ORDER: Record<SkillSource, number> = { project: 0, user: 1, plugin: 2, other: 3 };

/**
 * The skills on disk with the ones the session's last /context listed: a
 * skill on disk that /context listed (by its name or its folder's, from the
 * same source when /context says one the deck names) is loaded, with its
 * tokens; one it did not list is installed; one /context listed and the disk
 * has not (a plugin's, or one gone since) is a loaded row of its own. By name.
 */
export function skillInventory(disk: readonly DiskSkill[], snapshot: ContextSnapshot | null | undefined): SkillRow[] {
  const listed = snapshot?.skills ?? [];
  const taken = new Set<number>();
  const match = (skill: DiskSkill, sameSource: boolean): number => listed.findIndex((l, i) => {
    if (taken.has(i)) return false;
    const source = snapshotSkillSource(l.source);
    if (source === "plugin") return false;
    if (sameSource && source !== skill.scope) return false;
    return l.name === skill.name || l.name === folderOf(skill.path);
  });
  // Every skill's own source first, then any source for the ones left, so a
  // user skill does not take the row a project skill of the same name owns.
  const found = disk.map(skill => {
    const i = match(skill, true);
    if (i >= 0) taken.add(i);
    return i;
  });
  disk.forEach((skill, k) => {
    if (found[k] >= 0) return;
    found[k] = match(skill, false);
    if (found[k] >= 0) taken.add(found[k]);
  });
  const rows: SkillRow[] = disk.map((skill, k) => {
    const i = found[k];
    return {
      key: `${skill.scope}:${skill.path}`,
      name: skill.name,
      source: skill.scope,
      description: skill.description,
      path: skill.path,
      loaded: i >= 0,
      ...(i >= 0 ? { tokens: listed[i].tokens } : {}),
    };
  });
  listed.forEach((l, i) => {
    if (taken.has(i)) return;
    const source = snapshotSkillSource(l.source);
    rows.push({
      key: `context:${i}:${l.name}`,
      name: l.name,
      source,
      ...(source === "other" && l.source ? { sourceText: l.source } : {}),
      description: "",
      loaded: true,
      tokens: l.tokens,
    });
  });
  return rows.sort((a, b) => a.name.localeCompare(b.name) || ORDER[a.source] - ORDER[b.source]);
}

/** The rows whose name or description holds the query, case aside. */
export function filterSkills(rows: readonly SkillRow[], query: string): SkillRow[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...rows];
  return rows.filter(r => r.name.toLocaleLowerCase().includes(q) || r.description.toLocaleLowerCase().includes(q));
}

/** How many skills the last /context folded into "and N more": loaded, but
 *  not named, so the inventory cannot say which. */
export function unnamedLoadedSkills(snapshot: ContextSnapshot | null | undefined): number {
  const n = snapshot?.more?.skills?.count;
  return typeof n === "number" && n > 0 ? n : 0;
}

export async function readSessionSkills(
  session: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<SkillsRead> {
  try {
    const res = await fetchFn(`${SKILLS_ROUTE}?${new URLSearchParams({ session })}`, { cache: "no-store", signal });
    if (!res.ok) return { kind: "failed" };
    const body = await res.json() as unknown;
    if (!isObject(body) || !Array.isArray(body.skills)) return { kind: "failed" };
    const skills: DiskSkill[] = [];
    for (const s of body.skills) {
      if (!isObject(s) || typeof s.name !== "string" || !s.name || typeof s.path !== "string"
        || typeof s.description !== "string" || !SCOPES.includes(s.scope as SkillScope)) continue;
      skills.push({ name: s.name, scope: s.scope as SkillScope, description: s.description, path: s.path });
    }
    return { kind: "ready", skills, truncated: body.truncated === true };
  } catch {
    return { kind: "failed" };
  }
}

// ─── The MCP servers ────────────────────────────────────────────────────────

/** Where a server is configured: the top of Claude Code's state file (user),
 *  that file's entry for this project (local), or the project's .mcp.json. */
export type McpScope = "user" | "local" | "project";
export type McpTransport = "stdio" | "http" | "sse" | "ws";

/** One server the server found configured. */
export interface McpServer {
  name: string;
  scope: McpScope;
  transport: McpTransport | null;
}

export type McpServersRead = { kind: "ready"; servers: McpServer[] } | { kind: "failed" };

/** What the session's last /context says of a server: connected, with how many
 *  of its tools it listed (loaded and deferred), or not seen. Null when the
 *  session has no /context to say. */
export type McpStatus = { seen: true; tools: number } | { seen: false } | null;

/** Where a row's server is configured: one of the three files, or somewhere
 *  the deck does not read (a plugin, claude.ai, the command line) for a server
 *  only /context names. */
export type McpSource = McpScope | "other";

export interface McpRow {
  name: string;
  source: McpSource;
  transport: McpTransport | null;
  status: McpStatus;
}

/** The label key of each source. */
export const MCP_SOURCE_KEYS: Record<McpSource, string> = {
  user: "insights.context.memory.scope.user",
  local: "insights.context.memory.scope.local",
  project: "insights.context.memory.scope.project",
  other: "insights.context.mcp.other",
};

const MCP_SCOPES: readonly McpScope[] = ["user", "local", "project"];
const TRANSPORTS: readonly McpTransport[] = ["stdio", "http", "sse", "ws"];

/**
 * The configured servers with what the session's last /context saw of them: a
 * server it listed tools for (loaded or deferred) was connected; one it did not
 * was not seen. A server /context listed that none of the three files
 * configures is a row of its own, from elsewhere. By name.
 */
export function mcpInventory(servers: readonly McpServer[], snapshot: ContextSnapshot | null | undefined): McpRow[] {
  const groups = snapshot ? mcpGroups(snapshot) : [];
  const tools = new Map(groups.map(g => [g.server, g.tools.length + g.deferred]));
  const status = (name: string): McpStatus => !snapshot ? null
    : tools.has(name) ? { seen: true, tools: tools.get(name)! } : { seen: false };
  const rows: McpRow[] = servers.map(s => ({ name: s.name, source: s.scope, transport: s.transport, status: status(s.name) }));
  const configured = new Set(servers.map(s => s.name));
  for (const g of groups) {
    if (!configured.has(g.server)) rows.push({ name: g.server, source: "other", transport: null, status: status(g.server) });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSessionMcpServers(
  session: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<McpServersRead> {
  try {
    const res = await fetchFn(`${MCP_SERVERS_ROUTE}?${new URLSearchParams({ session })}`, { cache: "no-store", signal });
    if (!res.ok) return { kind: "failed" };
    const body = await res.json() as unknown;
    if (!isObject(body) || !Array.isArray(body.servers)) return { kind: "failed" };
    const servers: McpServer[] = [];
    for (const s of body.servers) {
      if (!isObject(s) || typeof s.name !== "string" || !s.name || !MCP_SCOPES.includes(s.scope as McpScope)) continue;
      const transport = TRANSPORTS.includes(s.transport as McpTransport) ? s.transport as McpTransport : null;
      servers.push({ name: s.name, scope: s.scope as McpScope, transport });
    }
    return { kind: "ready", servers };
  } catch {
    return { kind: "failed" };
  }
}
