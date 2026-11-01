import type { CaptureSnapshot } from "./use-telemetry-capture";
import { t as translateNow, type TFunction } from "./i18n";

/** Capture readiness is separate from traffic visibility and payload decoding. */
export function radarMonitorState(capture: CaptureSnapshot | null, failed = false, t: TFunction = translateNow) {
  const enabled = !!capture && (capture.featureEnabled ?? capture.enabled ?? ["awaiting", "receiving", "capturing"].includes(capture.state));
  const active = capture?.sources?.filter(source => source.active).length ?? 0;
  const permission = /permission/i.test(capture?.setupError ?? "") || !!capture?.sources?.some(source => /permission/i.test(source.error ?? ""));
  // No capture tool yet: tcpdump on Linux, Wireshark with Npcap on Windows.
  const install = /^Install /.test(capture?.setupError ?? "");
  const decoded = capture?.events.length ?? 0;
  const observed = capture?.observations?.length ?? 0;
  const traffic = !!capture?.bytes || observed > 0 || decoded > 0;
  let title = t("radar.monitor.stopped");
  let tone: "neutral" | "ok" | "attention" | "error" = "neutral";
  if (failed) { title = t("radar.monitor.lost"); tone = "error"; }
  else if (!capture) title = t("radar.monitor.reading");
  else if (enabled && permission) { title = t("radar.monitor.permission"); tone = "attention"; }
  else if (enabled && install) { title = t("radar.monitor.setup"); tone = "attention"; }
  else if (capture.automatic && enabled && !capture.sources?.length && capture.state !== "error") title = t("radar.monitor.waiting");
  else if (capture.state === "error") { title = t("radar.monitor.error"); tone = "error"; }
  else if (enabled && active > 0 && active < (capture.sources?.length ?? 0)) { title = t("radar.monitor.some"); tone = "attention"; }
  else if (enabled && permission) { title = t("radar.monitor.permission"); tone = "attention"; }
  else if (enabled && capture.state === "interrupted") { title = t("radar.monitor.reconnecting"); tone = "attention"; }
  else if (enabled && (active || (!capture.managed && ["receiving", "capturing"].includes(capture.state)))) {
    title = t("radar.monitor.listening"); tone = "ok";
  } else if (enabled) title = capture.managed ? t("radar.monitor.starting") : t("radar.monitor.activation");
  return { enabled, active, permission, install, decoded, observed, traffic, title, tone };
}
