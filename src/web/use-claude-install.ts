// Claude Code's install as one card sees it: the deck's status, read again
// while an install runs, the jobs this card watched, and the one screen the
// card shows for all of that (claudeInstallView). The session pane and the
// Accounts sign-in both use it, through ClaudeInstall.tsx.
//
// AN OUTCOME IS SHOWN ONLY TO WHO WATCHED IT. The deck keeps the last job's
// outcome; a card shows it only for a job it started or saw running, so a
// failure from an earlier card is not a new card's first screen, and a done
// from before is not a reason to start anything again.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  claudeInstallStatus, startClaudeInstall, type ClaudeInstallReason, type ClaudeInstallStatus,
} from "./claude-install-api";

/** How often the status is read while an install runs. */
export const CLAUDE_INSTALL_POLL_MS = 1000;

/** The one screen the card shows. */
export type ClaudeInstallView =
  /** The deck has not answered yet: the offer, without its command line. */
  | { state: "loading" }
  /** The deck cannot say (no route, no answer): the host's own card stands. */
  | { state: "unavailable" }
  /** Install offered, or only the command where the deck may not download. */
  | { state: "ask"; command: string; shell: ClaudeInstallStatus["shell"]; download: boolean }
  | { state: "running"; command: string; shell: ClaudeInstallStatus["shell"] }
  | { state: "done" }
  | { state: "failed"; reason: ClaudeInstallReason; detail: string | null; command: string; shell: ClaudeInstallStatus["shell"]; download: boolean };

export interface ClaudeInstallViewInput {
  /** undefined while the first read is on its way; null when the deck cannot say. */
  status: ClaudeInstallStatus | null | undefined;
  /** Every job this card started or saw running. */
  watched: ReadonlySet<string>;
  /** The deck refused this card's start (one ran elsewhere, or a failure of its own). */
  refused?: string | null;
}

export function claudeInstallView({ status, watched, refused }: ClaudeInstallViewInput): ClaudeInstallView {
  if (status === undefined) return { state: "loading" };
  if (status === null) return { state: "unavailable" };
  const { command, shell } = status;
  const download = !status.blocked;
  const ours = status.id !== null && watched.has(status.id);
  if (status.state === "running") return { state: "running", command, shell };
  if (ours && status.state === "done") return { state: "done" };
  if (ours && status.state === "failed") {
    return { state: "failed", reason: status.reason ?? "failed", detail: status.detail, command, shell, download };
  }
  // Refused for a reason the status does not show (a start that never ran).
  if (refused && refused !== "running" && refused !== "download-disabled") {
    return { state: "failed", reason: "failed", detail: null, command, shell, download };
  }
  return { state: "ask", command, shell, download };
}

export interface ClaudeInstall {
  view: ClaudeInstallView;
  /** A start is on its way to the deck. */
  pending: boolean;
  install(): Promise<void>;
}

export function useClaudeInstall(): ClaudeInstall {
  const [status, setStatus] = useState<ClaudeInstallStatus | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const watched = useRef(new Set<string>());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const next = await claudeInstallStatus();
    if (!alive.current) return;
    if (next?.state === "running" && next.id) watched.current.add(next.id);
    setStatus(next);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Read again while it runs.
  const running = status?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => { void refresh(); }, CLAUDE_INSTALL_POLL_MS);
    return () => clearTimeout(timer);
  }, [running, status, refresh]);

  const install = useCallback(async () => {
    setPending(true);
    setRefused(null);
    const answer = await startClaudeInstall();
    if (!alive.current) return;
    if (answer.ok) watched.current.add(answer.id);
    else setRefused(answer.code);
    await refresh();
    if (alive.current) setPending(false);
  }, [refresh]);

  return { view: claudeInstallView({ status, watched: watched.current, refused }), pending, install };
}
