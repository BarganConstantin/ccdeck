import { useEffect, useRef, useState } from "react";
import { pressAccepted } from "./panel-press";
import { t } from "./i18n";
import { serverText } from "./radar-server-text";
import { OwnError, ownMessage } from "./own-error";

export interface CapturedExport {
  id: number; at: number; observedAt: number; signal: "logs" | "metrics" | "traces";
  sessionIds?: string[]; destination: string; bytes: number; count: number; name: string; content: string[];
  outcome: "unconfirmed" | "accepted" | "partial" | "rejected" | "unknown" | "reset";
  response: { at: number; grpcStatus: string | null; rejected: string | null; message: string | null } | null;
}
export interface CaptureSnapshot {
  ok: boolean; automatic?: boolean; featureEnabled?: boolean; setupError?: string | null; managed?: boolean; enabled?: boolean; platform?: string; backend?: "tcpdump" | "dumpcap"; shell?: "Terminal" | "PowerShell"; sessionId: string | null; state: "idle" | "awaiting" | "receiving" | "capturing" | "stopped" | "expired" | "interrupted" | "error";
  destination: string | null; interface: string | null; startedAt: number | null; expiresAt: number | null;
  observations?: { id: number; at: number; destination: string; source: string; reason: string }[];
  retention?: { windowMs: number; maxExports: number; payloadBudgetBytes: number; evictedExports: number };
  sources?: { destination: string; interface: string; active: boolean; bytes: number; error?: string | null }[];
  lastInputAt: number | null; bytes: number; issues: Record<string, number>; events: CapturedExport[];
}
export type CaptureAction = "clear" | "permission";
/** What asking for capture permission came to (traffic-radar-permission.mjs):
 *  `command` is what to run in a terminal where no password prompt could open. */
export interface PermissionResult { outcome: "granted" | "cancelled" | "unavailable" | "failed"; message?: string; command?: string }
export function useTelemetryCapture() {
  const [capture, setCapture] = useState<CaptureSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [permission, setPermission] = useState<PermissionResult | null>(null);
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
  const action = async (kind: CaptureAction) => {
    if (!pressAccepted(inflight.current)) return;
    revision.current++;
    inflight.current = kind;
    setPendingAction(kind); setBusy(true); setError("");
    if (kind === "permission") setPermission(null);
    const request = new AbortController(); actionRequest.current = request;
    // Asking for permission waits on a person typing their password.
    const timeout = setTimeout(() => request.abort(), kind === "permission" ? 300_000 : 20_000);
    try {
      const response = await fetch(`/api/system/traffic-radar/capture/${kind}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: request.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new OwnError(serverText(data.error) || t("radar.srv.captureActionFailed"));
      if (kind === "permission") setPermission(data);
      const fresh = await fetch("/api/system/traffic-radar/capture", { signal: request.signal });
      if (fresh.ok) { setCapture(await fresh.json()); setFailed(false); }
    } catch (value) { setError(ownMessage(value, t("radar.srv.captureActionFailed"))); }
    finally { clearTimeout(timeout); actionRequest.current = null; inflight.current = null; setPendingAction(null); setBusy(false); }
  };
  return { capture, failed, busy, pendingAction, error, permission, action };
}
