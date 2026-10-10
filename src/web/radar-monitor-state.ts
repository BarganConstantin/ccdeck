import type { CaptureSnapshot } from "./use-telemetry-capture";

/** Capture readiness is separate from traffic visibility and payload decoding. */
export function radarMonitorState(capture: CaptureSnapshot | null, failed = false) {
  const enabled = !!capture && (capture.enabled ?? ["awaiting", "receiving", "capturing"].includes(capture.state));
  const active = capture?.sources?.filter(source => source.active).length ?? 0;
  const permission = !!capture?.sources?.some(source => /permission/i.test(source.error ?? ""));
  const decoded = capture?.events.length ?? 0;
  const observed = capture?.observations?.length ?? 0;
  const traffic = !!capture?.bytes || observed > 0 || decoded > 0;
  let title = "Monitoring stopped";
  let tone: "neutral" | "ok" | "attention" | "error" = "neutral";
  if (failed) { title = "Monitor connection lost"; tone = "error"; }
  else if (!capture) title = "Reading monitor…";
  else if (capture.state === "error") { title = "Capture error"; tone = "error"; }
  else if (enabled && active > 0 && active < (capture.sources?.length ?? 0)) { title = "Listening to some destinations"; tone = "attention"; }
  else if (enabled && permission) { title = "Capture permission needed"; tone = "attention"; }
  else if (enabled && capture.state === "interrupted") { title = "Reconnecting capture…"; tone = "attention"; }
  else if (enabled && (active || (!capture.managed && ["receiving", "capturing"].includes(capture.state)))) {
    title = "Listening for telemetry"; tone = "ok";
  } else if (enabled) title = capture.managed ? "Starting monitoring…" : "Activation needed";
  return { enabled, active, permission, decoded, observed, traffic, title, tone };
}
