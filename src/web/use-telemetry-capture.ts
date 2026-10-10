import { useEffect, useRef, useState } from "react";
import { pressAccepted } from "./panel-press";

export interface CapturedExport {
  id: number; at: number; observedAt: number; signal: "logs" | "metrics" | "traces";
  sessionIds?: string[]; destination: string; bytes: number; count: number; name: string; content: string[];
  outcome: "unconfirmed" | "accepted" | "partial" | "rejected" | "unknown" | "reset";
  response: { at: number; grpcStatus: string | null; rejected: string | null; message: string | null } | null;
}
export interface CaptureSnapshot {
  ok: boolean; managed?: boolean; enabled?: boolean; platform?: string; backend?: "tcpdump" | "dumpcap"; shell?: "Terminal" | "PowerShell"; sessionId: string | null; state: "idle" | "awaiting" | "receiving" | "capturing" | "stopped" | "expired" | "interrupted" | "error";
  destination: string | null; interface: string | null; startedAt: number | null; expiresAt: number | null;
  observations?: { id: number; at: number; destination: string; source: string; reason: string }[];
  retention?: { windowMs: number; maxExports: number; payloadBudgetBytes: number; evictedExports: number };
  sources?: { destination: string; interface: string; active: boolean; bytes: number; error?: string | null }[];
  lastInputAt: number | null; bytes: number; issues: Record<string, number>; events: CapturedExport[];
}
export type CaptureAction = "prepare" | "stop" | "clear";
export function useTelemetryCapture() {
  const [capture, setCapture] = useState<CaptureSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [command, setCommand] = useState("");
  const [commands, setCommands] = useState<{ destination: string; command: string }[]>([]);
  const [commandSession, setCommandSession] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<CaptureAction | null>(null);
  const inflight = useRef<CaptureAction | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const visible = () => document.visibilityState !== "hidden";
    const stop = () => { clearTimeout(timer); controller?.abort(); controller = null; };
    const load = async () => {
      if (!alive || !visible() || controller) return;
      if (inflight.current) { timer = setTimeout(load, 1000); return; }
      const observedRevision = revision.current;
      const request = new AbortController(); controller = request;
      try {
        const response = await fetch("/api/system/traffic-radar/capture", { signal: request.signal });
        if (!response.ok) throw new Error();
        const data: CaptureSnapshot = await response.json();
        if (alive && !request.signal.aborted && observedRevision === revision.current) {
          setCapture(data); setFailed(false);
        }
      } catch { if (alive && !request.signal.aborted && observedRevision === revision.current) setFailed(true); }
      finally {
        if (controller === request) controller = null;
        if (alive && !request.signal.aborted && visible()) timer = setTimeout(load, 1000);
      }
    };
    const visibility = () => { stop(); if (document.visibilityState !== "hidden") void load(); };
    void load(); document.addEventListener("visibilitychange", visibility);
    return () => { alive = false; stop(); actionRequest.current?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const action = async (kind: CaptureAction, destination?: string | string[]) => {
    if (!pressAccepted(inflight.current)) return;
    revision.current++;
    inflight.current = kind;
    setPendingAction(kind); setBusy(true); setError("");
    const request = new AbortController(); actionRequest.current = request;
    const timeout = setTimeout(() => request.abort(), 20_000);
    try {
      const response = await fetch(`/api/system/traffic-radar/capture/${kind}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destination }), signal: request.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Capture action failed. Please retry.");
      if (kind === "prepare") { setCommand(data.command); setCommands(data.commands ?? [{ destination: String(destination), command: data.command }]); setCommandSession(data.sessionId); }
      if (kind === "stop") { setCommand(""); setCommands([]); }
      const fresh = await fetch("/api/system/traffic-radar/capture", { signal: request.signal });
      if (fresh.ok) { setCapture(await fresh.json()); setFailed(false); }
    } catch (value) { setError(value instanceof Error ? value.message : "Capture action failed. Please retry."); }
    finally { clearTimeout(timeout); actionRequest.current = null; inflight.current = null; setPendingAction(null); setBusy(false); }
  };
  return { capture, failed, busy, pendingAction, error, commands: capture?.sessionId === commandSession ? commands : [], command: capture?.sessionId === commandSession ? command : "", action };
}
