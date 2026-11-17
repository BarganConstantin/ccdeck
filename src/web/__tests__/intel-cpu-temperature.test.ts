import { describe, expect, it, vi } from "vitest";
import { cpuFromIntelSmc, readIntelCpuTemp } from "../../server/intel-cpu-temperature.mjs";
import { darwinThermal } from "../../server/thermal-metrics.mjs";

describe("Intel SMC CPU temperature", () => {
  it("reads Celsius only, rejecting absent sensors, errors and non-temperatures", () => {
    expect(cpuFromIntelSmc("69.9°C\n")).toBe(70);
    for (const bad of ["0.0°C", "nan°C", "-2°C", "130°C", "158°F", "Error: no SMC found", "69.9", "69°C\n70°C", ""]) {
      expect(cpuFromIntelSmc(bad), bad).toBeNull();
    }
  });
  it("finds an installed reader outside the GUI PATH and asks for Celsius explicitly", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "69.9°C\n" }));
    expect(await readIntelCpuTemp({ platform: "darwin", arch: "x64", exists: (p: string) => p === "/usr/local/bin/osx-cpu-temp", run })).toBe(70);
    expect(run).toHaveBeenCalledWith("/usr/local/bin/osx-cpu-temp", ["-c"], { timeout: 2000, maxBuffer: 1024 });
  });
  it("does not launch a missing reader or run on other platforms or architectures", async () => {
    const run = vi.fn();
    for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"], ["darwin", "x64"]]) {
      expect(await readIntelCpuTemp({ platform, arch, exists: () => false, run })).toBeNull();
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("treats failed reads as unavailable", async () => {
    expect(await readIntelCpuTemp({ platform: "darwin", arch: "x64", exists: () => true,
      run: async () => ({ ok: false, stdout: "69.9°C" }) })).toBeNull();
  });
  it("adds CPU alongside a working GPU and throttling reading", () => {
    expect(darwinThermal({ cpuC: 70, gpuC: 67, throttle: { speedLimit: 100 } })).toEqual({
      celsius: [
        { label: "CPU", celsius: 70, warnAt: 75, critAt: 90 },
        { label: "GPU", celsius: 67, warnAt: 75, critAt: 90 },
      ], throttle: { speedLimit: 100 },
    });
  });
});
