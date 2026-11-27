// One memory file of a session, read for the Context tab's viewer
// (MemoryFileDialog.tsx) from GET /api/session/memory-file
// (src/server/memory-file-route.mjs). The path is sent as the row has it, `~/`
// included: the server answers only for a path its own scan lists, and it says
// nothing more than "not found" for anything else, so one failure covers it.

export const MEMORY_FILE_ROUTE = "/api/session/memory-file";

export type MemoryFileScope = "project" | "local" | "user" | "auto";

/** Where the row came from: Claude Code's /context ("loaded") or the deck's
 *  own scan of the disk. */
export type MemoryFileSource = "loaded" | "disk";

/** The row a viewer was opened on. */
export interface MemoryFileTarget {
  path: string;
  source: MemoryFileSource;
}

export interface MemoryFile {
  path: string;
  name: string;
  scope: MemoryFileScope;
  bytes: number;
  text: string;
  truncated: boolean;
}

export type MemoryFileRead = { kind: "ready"; file: MemoryFile } | { kind: "failed" };

const SCOPES: readonly MemoryFileScope[] = ["project", "local", "user", "auto"];

/** The scope's label key. */
export const MEMORY_SCOPE_KEYS: Record<MemoryFileScope, string> = {
  project: "insights.context.memory.scope.project",
  local: "insights.context.memory.scope.local",
  user: "insights.context.memory.scope.user",
  auto: "insights.context.memory.scope.auto",
};

/** The source's label key. */
export const MEMORY_SOURCE_KEYS: Record<MemoryFileSource, string> = {
  loaded: "insights.context.memory.loaded",
  disk: "insights.context.memory.disk",
};

/** The last segment of a path, either separator. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export async function readMemoryFile(
  session: string,
  provider: "claude" | "codex",
  path: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<MemoryFileRead> {
  try {
    const query = new URLSearchParams({ session, provider, path });
    const res = await fetchFn(`${MEMORY_FILE_ROUTE}?${query}`, { cache: "no-store", signal });
    if (!res.ok) return { kind: "failed" };
    const body = await res.json() as Partial<Record<keyof MemoryFile, unknown>>;
    if (typeof body.path !== "string" || typeof body.name !== "string" || typeof body.text !== "string"
      || typeof body.bytes !== "number" || !SCOPES.includes(body.scope as MemoryFileScope)) return { kind: "failed" };
    return {
      kind: "ready",
      file: {
        path: body.path, name: body.name, scope: body.scope as MemoryFileScope,
        bytes: body.bytes, text: body.text, truncated: body.truncated === true,
      },
    };
  } catch {
    return { kind: "failed" };
  }
}
