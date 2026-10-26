import React from "react";
import type { Gpu } from "../machine-snapshot";
import { fmtBytes } from "../byte-format";
import { Row } from "./MachineReadout";

export default function GpuSection({ gpus }: { gpus: Gpu[] | null | undefined }) {
  if (!gpus?.length) return null;
  return <>{gpus.map(gpu => {
    const hasMemory = gpu.memoryUsedMiB != null && gpu.memoryTotalMiB != null && gpu.memoryTotalMiB > 0;
    const memoryPct = hasMemory ? gpu.memoryUsedMiB! / gpu.memoryTotalMiB! * 100 : 0;
    return (
      <div key={gpu.index} className="sd-section" role="group" aria-label={`GPU ${gpu.index}: ${gpu.name}`}>
        <h3 className="sd-h">GPU {gpu.index}</h3>
        <div className="sd-row"><div className="sd-note">{gpu.name}</div></div>
        {gpu.utilization != null ? (
          <Row label="Utilization" value={<b>{gpu.utilization}%</b>} pct={gpu.utilization} />
        ) : <div className="sd-note">Utilization unavailable</div>}
        {hasMemory ? (
          <Row label="VRAM" pct={memoryPct} tone={memoryPct >= 90 ? "warn" : "calm"}
            value={<><b>{fmtBytes(gpu.memoryUsedMiB! * 1024 ** 2)}</b> of {fmtBytes(gpu.memoryTotalMiB! * 1024 ** 2)}</>} />
        ) : <div className="sd-note">VRAM unavailable</div>}
        <div className="sd-row">
          <div className="sd-row-head">
            <span className="sd-row-label">Temperature</span>
            <span className="sd-row-val">{gpu.temperatureC == null ? "Unavailable" : <><b>{gpu.temperatureC}</b> °C</>}</span>
          </div>
          <div className="sd-row-head">
            <span className="sd-row-label">Power</span>
            <span className="sd-row-val">{gpu.powerW == null ? "Unavailable" : <><b>{gpu.powerW.toFixed(1)}</b> W</>}</span>
          </div>
        </div>
      </div>
    );
  })}</>;
}
