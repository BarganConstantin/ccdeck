import { useEffect, useState } from "react";
import type { RadarSnapshot } from "./traffic-radar";

export function useTrafficRadar() {
  const [snapshot, setSnapshot] = useState<RadarSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const visible = () => document.visibilityState !== "hidden";
    const stop = () => {
      clearTimeout(timer);
      controller?.abort();
      controller = null;
    };
    const load = async () => {
      if (!alive || !visible() || controller) return;
      const request = new AbortController();
      controller = request;
      try {
        const response = await fetch("/api/system/traffic-radar", { signal: request.signal });
        if (!response.ok) throw new Error("radar_unavailable");
        const data: RadarSnapshot = await response.json();
        if (!data.ok) throw new Error("radar_unavailable");
        if (alive && !request.signal.aborted) { setSnapshot(data); setFailed(false); }
      } catch {
        if (alive && !request.signal.aborted) setFailed(true);
      } finally {
        if (controller === request) controller = null;
        if (alive && !request.signal.aborted && visible()) timer = setTimeout(load, 5_000);
      }
    };
    const visibility = () => {
      stop();
      if (document.visibilityState !== "hidden") void load();
    };
    void load();
    document.addEventListener("visibilitychange", visibility);
    return () => { alive = false; stop(); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  return { snapshot, failed };
}
