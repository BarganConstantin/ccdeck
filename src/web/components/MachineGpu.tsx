import React from "react";
import { fmtBytes } from "../byte-format";
import type { GpuReading } from "../machine-snapshot";
import { Row } from "./MachineReadout";

function Reading({ label, value, pct }: { label: string; value: string; pct?: number }) {
  if (pct != null) return <Row label={label} value={<b>{value}</b>} pct={pct} />;
  return <div className="sd-row"><div className="sd-row-head">
    <span className="sd-row-label">{label}</span>
    <span className="sd-row-val">{value}</span>
  </div></div>;
}

export default function MachineGpu({ devices }: { devices: GpuReading[] }) {
  return <>{devices.map((gpu, index) => {
    const used = gpu.memoryUsed;
    const total = gpu.memoryTotal;
    const memory = used != null && total != null ? `${fmtBytes(used)} of ${fmtBytes(total)}`
      : used != null ? `${fmtBytes(used)} used` : total != null ? `${fmtBytes(total)} total · used unavailable` : "Unavailable";
    return <section className="sd-section" aria-label={`GPU ${index + 1}: ${gpu.name}`} key={gpu.id}>
      <h3 className="sd-sub sd-gpu-name">GPU {index + 1} · {gpu.name}</h3>
      <Reading label="Utilization" value={gpu.utilization == null ? "Unavailable" : `${gpu.utilization}%`} pct={gpu.utilization ?? undefined} />
      <Reading label="Video memory" value={memory} pct={used != null && total != null && total > 0 ? used / total * 100 : undefined} />
      <Reading label="Temperature" value={gpu.temperature == null ? "Unavailable" : `${gpu.temperature} °C`} />
      <Reading label="Power" value={gpu.power == null ? "Unavailable" : `${gpu.power.toFixed(1)} W`} />
    </section>;
  })}</>;
}
