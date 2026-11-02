import React from "react";
import { fmtBytes } from "../byte-format";
import { currentLanguage, useT } from "../i18n";
import { rich } from "../insights-rich";
import type { GpuReading } from "../machine-snapshot";
import { PlainRow, Row } from "./MachineReadout";

function Reading({ label, value, pct }: { label: string; value: string; pct?: number }) {
  if (pct != null) return <Row label={label} value={value} pct={pct} />;
  return <PlainRow label={label} value={value} />;
}

export default function MachineGpu({ devices }: { devices: GpuReading[] }) {
  const t = useT();
  return <>{devices.map((gpu, index) => {
    const used = gpu.memoryUsed;
    const total = gpu.memoryTotal;
    const memory = used != null && total != null ? t("insights.machine.of", { used: fmtBytes(used), total: fmtBytes(total) })
      : used != null ? t("insights.machine.gpuUsed", { n: fmtBytes(used) }) : total != null ? t("insights.machine.gpuTotal", { n: fmtBytes(total) }) : t("insights.machine.unavailable");
    return <section className="sd-section sd-gpu" aria-label={t("insights.machine.gpuAria", { n: index + 1, name: gpu.name })} key={gpu.id}>
      <h3 className="sd-gpu-name">{t("insights.machine.gpuName", { n: index + 1, name: gpu.name })}</h3>
      <Reading label={t("insights.machine.utilization")} value={gpu.utilization == null ? t("insights.machine.unavailable") : `${gpu.utilization}%`} pct={gpu.utilization ?? undefined} />
      <Reading label={t("insights.machine.vram")} value={memory} pct={used != null && total != null && total > 0 ? used / total * 100 : undefined} />
      <Reading label={t("insights.machine.temperature")} value={gpu.temperature == null ? t("insights.machine.unavailable") : `${gpu.temperature} °C`} />
      <Reading label={t("insights.machine.power")} value={gpu.power == null ? t("insights.machine.unavailable") : `${gpu.power.toLocaleString(currentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} W`} />
    </section>;
  })}</>;
}
