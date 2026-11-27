import type { TerminalProvider } from "./terminal-api";

export interface SavedSession {
  id: string;
  provider: TerminalProvider;
  cwd: string;
  title: string;
  updatedAt: number;
  unavailable: "folder" | "profile" | null;
}

export interface SessionHistoryPage {
  rows: SavedSession[];
  next: number | null;
  limited: boolean;
}

export async function sessionHistory(query: string, provider: TerminalProvider | "all", offset: number, signal: AbortSignal): Promise<SessionHistoryPage> {
  const params = new URLSearchParams({ q: query, provider, offset: String(offset) });
  const response = await fetch(`/api/session/history?${params}`, { signal });
  if (!response.ok) throw new Error("History unavailable");
  const body = await response.json();
  if (body?.ok !== true || !Array.isArray(body.rows)) throw new Error("History unavailable");
  return body;
}
