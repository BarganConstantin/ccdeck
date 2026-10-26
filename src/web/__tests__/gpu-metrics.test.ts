import { afterEach, describe, expect, it, vi } from "vitest";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../server/metrics-run.mjs", () => ({ run }));

import { gpuSnapshot, parseNvidiaSmi, startGpuTimer, stopGpu } from "../../server/gpu-metrics.mjs";
import { startSystemMetrics, stopSystemMetrics, systemSnapshot } from "../../server/system-metrics.mjs";

const SAMPLE = `0, NVIDIA GeForce RTX 5080, 37, 4096, 16303, 58, 182.50
1, NVIDIA T4, N/A, 0, 15360, N/A, N/A`;

afterEach(() => {
  stopSystemMetrics();
  stopGpu();
  vi.useRealTimers();
  run.mockReset();
});

describe("NVIDIA GPU metrics", () => {
  it("parses multiple GPUs, quoted names, unknown values and invalid numbers", () => {
    expect(parseNvidiaSmi(`${SAMPLE}
2, "NVIDIA, Test GPU", 101, -1, 10, -1, Infinity
bad,row
3, "unterminated, 8, 2, 10, 40, 30`)).toEqual([
      { index: 0, name: "NVIDIA GeForce RTX 5080", utilization: 37, memoryUsedMiB: 4096, memoryTotalMiB: 16303, temperatureC: 58, powerW: 182.5 },
      { index: 1, name: "NVIDIA T4", utilization: null, memoryUsedMiB: 0, memoryTotalMiB: 15360, temperatureC: null, powerW: null },
      { index: 2, name: "NVIDIA, Test GPU", utilization: null, memoryUsedMiB: null, memoryTotalMiB: 10, temperatureC: null, powerW: null },
    ]);
    expect(parseNvidiaSmi("not a GPU row")).toBeNull();
  });

  it("queries immediately at the CPU cadence with the shared runner and timeout", async () => {
    vi.useFakeTimers();
    run.mockResolvedValue(SAMPLE);
    startGpuTimer();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledWith("nvidia-smi", [
      "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
      "--format=csv,noheader,nounits",
    ], 2_000);
    expect(gpuSnapshot()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops probing after three empty reads on an unsupported machine", async () => {
    vi.useFakeTimers();
    run.mockResolvedValue(null);
    startGpuTimer();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(12_000);
    startGpuTimer();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(gpuSnapshot()).toBeNull();
  });

  it("clears a failed current sample and recovers on a later read", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(SAMPLE).mockResolvedValueOnce(null).mockResolvedValueOnce(SAMPLE);
    startGpuTimer();
    await vi.advanceTimersByTimeAsync(0);
    expect(gpuSnapshot()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(gpuSnapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(gpuSnapshot()).toHaveLength(2);
  });

  it("does not overlap reads or let an old request overwrite after stop and restart", async () => {
    vi.useFakeTimers();
    let finishOld!: (value: string | null) => void;
    run.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    startGpuTimer();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run).toHaveBeenCalledOnce();

    stopGpu();
    run.mockResolvedValueOnce("0, New GPU, 9, 10, 100, 44, 20");
    startGpuTimer();
    await vi.advanceTimersByTimeAsync(0);
    expect(gpuSnapshot()?.[0].name).toBe("New GPU");
    finishOld("0, Stale GPU, 99, 99, 100, 99, 99");
    await Promise.resolve();
    expect(gpuSnapshot()?.[0].name).toBe("New GPU");
  });

  it("is wired through systemSnapshot and reset with system metrics", async () => {
    vi.useFakeTimers();
    run.mockResolvedValue(SAMPLE);
    startSystemMetrics();
    await vi.advanceTimersByTimeAsync(0);
    expect(systemSnapshot().gpus).toEqual(parseNvidiaSmi(SAMPLE));
    stopSystemMetrics();
    expect(systemSnapshot().gpus).toBeNull();
  });
});
