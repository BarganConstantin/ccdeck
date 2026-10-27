import { afterEach, describe, expect, it, vi } from "vitest";
import { createGpuMetrics, parseNvidiaReadings } from "../../server/gpu-metrics.mjs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import MachineGpu from "../components/MachineGpu";

const row = 'GPU-test-1, NVIDIA Test Device, 75, 1024, 8192, 61, 125.50';
afterEach(() => vi.useRealTimers());

describe("NVIDIA driver readings", () => {
  it("keeps distinct devices and converts MiB to bytes", () => {
    const devices = parseNvidiaReadings(`${row}\r\nGPU-test-2, "Test, dual", 0, 0, 4096, 0, 0`);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ utilization: 75, memoryUsed: 1024 ** 3, memoryTotal: 8 * 1024 ** 3, power: 125.5 });
    expect(devices[1]).toMatchObject({ name: "Test, dual", utilization: 0, memoryUsed: 0, temperature: 0, power: 0 });
  });
  it("rejects invalid records and represents unsupported or invalid numbers as missing", () => {
    expect(parseNvidiaReadings(null)).toEqual([]);
    expect(parseNvidiaReadings("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")).toEqual([]);
    expect(parseNvidiaReadings('GPU-x, "unterminated, 10, 1, 2, 3, 4')).toEqual([]);
    expect(parseNvidiaReadings('GPU-x, Test, 101, 9000, 8192, N/A, [Not Supported]')[0]).toMatchObject({
      utilization: null, memoryUsed: null, temperature: null, power: null,
    });
    expect(parseNvidiaReadings('GPU-x, Test, -1, NaN, 0, Infinity, 1w')[0]).toMatchObject({
      utilization: null, memoryUsed: null, memoryTotal: null, temperature: null, power: null,
    });
  });
  it("hides absent devices and never draws an unsupported reading as zero", () => {
    expect(renderToStaticMarkup(React.createElement(MachineGpu, { devices: [] }))).toBe("");
    const devices = parseNvidiaReadings('GPU-x, Test, N/A, N/A, N/A, N/A, N/A');
    const html = renderToStaticMarkup(React.createElement(MachineGpu, { devices }));
    expect(html.match(/Unavailable/g)).toHaveLength(4);
    expect(html).not.toContain('sd-track');
    expect(html).toContain('GPU 1: Test');
  });
});

describe("GPU sampling lifecycle", () => {
  it("clears a failed sample and rediscovers devices after the backoff", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(null).mockResolvedValue(row);
    const gpu = createGpuMetrics({ platform: "linux", read });
    gpu.start();
    gpu.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(gpu.snapshot()).toHaveLength(1);
    const snapshot = gpu.snapshot();
    snapshot[0].name = "changed";
    expect(gpu.snapshot()[0].name).toBe("NVIDIA Test Device");
    await vi.advanceTimersByTimeAsync(5000);
    expect(gpu.snapshot()).toEqual([]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(gpu.snapshot()).toHaveLength(1);
    gpu.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(gpu.snapshot()).toEqual([]);
  });
  it("ignores stopped work even if a new collector has started, and never overlaps scheduled reads", async () => {
    vi.useFakeTimers();
    let finishOld!: (value: string) => void;
    let finishNew!: (value: string) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    const gpu = createGpuMetrics({ platform: "win32", read });
    gpu.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    gpu.stop();
    gpu.start();
    finishOld(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(gpu.snapshot()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    finishNew(row.replace('GPU-test-1', 'GPU-new'));
    await vi.advanceTimersByTimeAsync(0);
    expect(gpu.snapshot()[0].id).toBe('GPU-new');
    expect(vi.getTimerCount()).toBe(1);
    gpu.stop();
  });
  it("handles a rejected probe and avoids probing unsupported platforms", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new Error("driver unavailable"));
    const mac = createGpuMetrics({ platform: "darwin", read });
    mac.start();
    expect(read).not.toHaveBeenCalled();
    const gpu = createGpuMetrics({ platform: "linux", read });
    gpu.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(gpu.snapshot()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    gpu.stop();
  });
});
