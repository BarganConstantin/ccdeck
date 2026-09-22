// The file a session leaves the deck as.
//
// "Export session JSON" is the one place the canvas becomes something a person
// keeps: it is attached to bug reports, pasted into issues, and filed as a
// record of a noteworthy run. That makes it a FORMAT, with the two obligations
// a format has — it says which version it is, and it holds what it says it
// holds and nothing else.
//
// Both halves lived inside App.tsx as a module-private function that also built
// a Blob, made an <a> and clicked it, so no test could import either one (#1175).
// What a test could not see was the part that matters most: every tool call on
// the canvas carries its full `input` and `response` — file contents, command
// output, whatever the tool was handed — and the export deliberately drops them.
// A refactor that spread `...t` instead would put all of that into a file people
// paste in public, with the suite green.
//
// The download itself stays in App.tsx, where the DOM is. This module answers
// what goes in the file and what the file is called.
import { PRODUCT } from "./brand";
import type { AgentNodeData, ToolCall } from "./types";

/** The version of this file format. Bump it when a reader of an older export
 *  would be wrong about what it is looking at — not when a field is added that
 *  an older reader can ignore. */
export const SESSION_EXPORT_SCHEMA = 1;

/** One tool call as the file carries it: what it was, how it went, how long it
 *  took, and what it cost. */
export interface ExportedTool {
  id: string;
  name: string;
  inputPreview: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  errorPreview?: string;
  usage?: ToolCall["usage"];
}

/** One agent — the root, or one of its subagents. */
export interface ExportedAgent {
  id: string;
  kind: AgentNodeData["kind"];
  label: string;
  parentId?: string;
  state: AgentNodeData["state"];
  startedAt: number;
  endedAt?: number;
  model?: string;
  cwd?: string;
  usage: AgentNodeData["usage"];
  prompts: AgentNodeData["prompts"];
  tools: ExportedTool[];
}

/** The whole file. */
export interface SessionExport {
  schemaVersion: number;
  exportedAt: string;
  sessionId: string;
  label: string;
  cwd?: string;
  startedAt: number;
  endedAt?: number;
  model?: string;
  agents: ExportedAgent[];
}

/**
 * A tool call reduced to what a file may carry.
 *
 * NAMED FIELDS, never a spread. `input` and `response` hold whatever the tool
 * was given and whatever it answered — the contents of a file that was read,
 * the output of a command, an API response that may carry a token — and the
 * previews beside them are already bounded and already the thing a reader of
 * this file wants. Spreading the call would make the export as large as the
 * transcript and would put those payloads into a file people attach to public
 * issues, and it is the sort of change that looks like a tidy-up.
 */
function exportTool(t: ToolCall): ExportedTool {
  return {
    id: t.id,
    name: t.name,
    inputPreview: t.inputPreview,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    ok: t.ok,
    errorPreview: t.errorPreview,
    usage: t.usage,
  };
}

/**
 * The portable snapshot of ONE session: its root and every subagent under it.
 *
 * Null when the root is not on the board, because a file named after a session
 * the deck cannot describe is worse than no file.
 *
 * `agents` is filtered on `sessionId`, so nothing from a neighbouring session
 * on the same canvas can ride along — the canvas is shared and the file is not,
 * and a bug report that carries somebody else's session is the kind of leak
 * nobody looks for.
 */
export function sessionExport(
  state: { agents: Map<string, AgentNodeData> }, sessionId: string, nowIso: string,
): SessionExport | null {
  const root = state.agents.get(sessionId);
  if (!root) return null;
  const agents: AgentNodeData[] = [];
  for (const a of state.agents.values()) {
    if (a.sessionId === sessionId) agents.push(a);
  }
  return {
    schemaVersion: SESSION_EXPORT_SCHEMA,
    exportedAt: nowIso,
    sessionId,
    label: root.label,
    cwd: root.cwd,
    startedAt: root.startedAt,
    endedAt: root.endedAt,
    model: root.model,
    agents: agents.map(a => ({
      id: a.id,
      kind: a.kind,
      label: a.label,
      parentId: a.parentId,
      state: a.state,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      model: a.model,
      cwd: a.cwd,
      usage: a.usage,
      prompts: a.prompts,
      tools: a.tools.map(exportTool),
    })),
  };
}

/**
 * What the browser saves the file as.
 *
 * A session's label is whatever the working directory or the first prompt made
 * it, so it can hold anything a path or a sentence can — `/`, `:`, a space, a
 * quote. Everything outside `[a-z0-9._-]` becomes `_` rather than being
 * stripped, so two labels that differ only in punctuation still differ here.
 * An empty label falls back to `session`, because a file called
 * `ccdeck--abcdef12.json` says less than one that admits it has no name.
 *
 * The id is cut to eight characters: enough to tell two exports of the same
 * afternoon apart, short enough that the name stays readable in a download
 * list.
 */
export function exportFileName(label: string | undefined | null, sessionId: string): string {
  const safeLabel = (label || "session").replace(/[^a-z0-9._-]/gi, "_");
  return `${PRODUCT}-${safeLabel}-${sessionId.slice(0, 8)}.json`;
}
