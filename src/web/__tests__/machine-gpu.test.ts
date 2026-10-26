import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GpuSection from "../components/MachineGpu";
import type { Gpu } from "../machine-snapshot";

const gpu: Gpu = {
  index: 0, name: "NVIDIA GeForce RTX 5080", utilization: 55,
  memoryUsedMiB: 5515, memoryTotalMiB: 16303, temperatureC: 57, powerW: 192.88,
};
const draw = (gpus: Gpu[] | null | undefined) => renderToStaticMarkup(React.createElement(GpuSection, { gpus }));

describe("machine GPU readings", () => {
  it("renders measured values and converts MiB consistently with the memory panel", () => {
    const html = draw([gpu]);
    for (const text of [gpu.name, "55%", "5.4 GB", "15.9 GB", "57", "°C", "192.9", "W"])
      expect(html).toContain(text);
    expect(html).toContain("scaleX(0.55)");
    expect(html).not.toContain("show history");
  });

  it("keeps multiple GPUs distinct and escapes device names", () => {
    const html = draw([gpu, { ...gpu, index: 1, name: '<GPU & "test">' }]);
    expect(html).toContain("GPU 1");
    expect(html).toContain("&lt;GPU &amp; &quot;test&quot;&gt;");
    expect(html).not.toContain('<GPU & "test">');
  });

  it("does not invent zero readings when a sensor or command is unavailable", () => {
    const html = draw([{ ...gpu, utilization: null, memoryUsedMiB: null, temperatureC: null, powerW: null }]);
    expect(html).toContain("Utilization unavailable");
    expect(html).toContain("VRAM unavailable");
    expect(html).not.toContain("scaleX");
    expect(html).not.toContain("NaN");
    expect(draw(null)).toBe("");
    expect(draw([])).toBe("");
    expect(draw(undefined)).toBe("");
  });

  it("keeps idle utilization at zero and warns when VRAM is nearly full", () => {
    const html = draw([{ ...gpu, utilization: 0, memoryUsedMiB: 16000 }]);
    expect(html).toContain("scaleX(0)");
    expect(html).toContain('class="sd-fill warn"');
    expect(draw([{ ...gpu, utilization: 100 }])).not.toContain('class="sd-fill warn"');
    expect(draw([{ ...gpu, memoryTotalMiB: 0 }])).toContain("VRAM unavailable");
  });
});
