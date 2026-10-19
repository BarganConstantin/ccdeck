import { useEffect, useState } from "react";

type RadarSettings = { enabled: boolean | null; busy: boolean; error: string };
let snapshot: RadarSettings = { enabled: null, busy: false, error: "" };
const subscribers = new Set<(value: RadarSettings) => void>();
let poll: ReturnType<typeof setInterval> | null = null;
let request: AbortController | null = null;
let reading = false, revision = 0;
const publish = (patch: Partial<RadarSettings>) => { snapshot = { ...snapshot, ...patch }; subscribers.forEach(listener => listener(snapshot)); };

export async function refreshRadarSettings() {
  if (reading || snapshot.busy) return;
  reading = true;
  const observedRevision = revision, controller = new AbortController(); request = controller;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
  try {
    const res = await fetch("/api/system/traffic-radar/settings", { signal: controller.signal });
    const data = await res.json();
    if (!res.ok || !data.ok || typeof data.enabled !== "boolean") throw new Error();
    if (observedRevision === revision && !controller.signal.aborted) publish({ enabled: data.enabled, error: "" });
  } catch { if (observedRevision === revision && (timedOut || !controller.signal.aborted)) publish({ error: "Could not read Radar settings. Try again." }); }
  finally { clearTimeout(timeout); reading = false; if (request === controller) request = null; }
}
export async function setRadarEnabled(enabled: boolean) {
  if (snapshot.busy) return;
  revision++; request?.abort(); publish({ busy: true, error: "" });
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch("/api/system/traffic-radar/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }), signal: controller.signal });
    const data = await res.json();
    if (!res.ok || !data.ok || typeof data.enabled !== "boolean") throw new Error();
    publish({ enabled: data.enabled });
  } catch { publish({ error: "Could not save Radar settings. Try again." }); }
  finally { clearTimeout(timeout); publish({ busy: false }); }
}
export function useRadarSettings() {
  const [value, setValue] = useState(snapshot);
  useEffect(() => {
    subscribers.add(setValue); setValue(snapshot);
    if (!poll) { void refreshRadarSettings(); poll = setInterval(() => void refreshRadarSettings(), 10000); }
    return () => { subscribers.delete(setValue); if (!subscribers.size) { if (poll) clearInterval(poll); poll = null; request?.abort(); } };
  }, []);
  return value;
}
