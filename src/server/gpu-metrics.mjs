// Optional NVIDIA readings. Device discovery and numbers come from the driver;
// this module never changes its settings or installs a tool.
import { run } from "./metrics-run.mjs";

const QUERY = ["uuid", "name", "utilization.gpu", "memory.used", "memory.total", "temperature.gpu", "power.draw"];
const MIB = 1024 ** 2;

function number(text, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value <= max ? value : null;
}

// NVIDIA CSV may quote a product name. Reject malformed records rather than
// shifting columns and interpreting memory as temperature.
function columns(line) {
  const cells = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(cell => cell.trim());
  if (cells.length !== QUERY.length || cells.some(cell =>
    cell.includes('"') && !/^"(?:[^"]|"")*"$/.test(cell))) return null;
  return cells.map(cell => cell.startsWith('"')
    ? cell.slice(1, -1).replace(/""/g, '"') : cell);
}

export function parseNvidiaReadings(output) {
  if (typeof output !== "string") return [];
  const devices = new Map();
  for (const line of output.trim().split(/\r?\n/)) {
    const cells = columns(line.trim());
    if (!cells) continue;
    const [id, name, utilization, used, total, temperature, power] = cells;
    if (!/^GPU-[\w-]+$/.test(id) || !name || /[\x00-\x1f]/.test(name)) continue;
    const memoryTotal = number(total, Number.MAX_SAFE_INTEGER / MIB);
    const memoryUsed = number(used, Number.MAX_SAFE_INTEGER / MIB);
    devices.set(id, {
      id, name,
      utilization: number(utilization, 100),
      memoryTotal: memoryTotal > 0 ? memoryTotal * MIB : null,
      memoryUsed: memoryUsed != null && (memoryTotal == null || memoryUsed <= memoryTotal)
        ? memoryUsed * MIB : null,
      temperature: number(temperature, 200),
      power: number(power),
    });
  }
  return [...devices.values()];
}

export function createGpuMetrics({ platform = process.platform, read = () => run(
  "nvidia-smi", [`--query-gpu=${QUERY.join(",")}`, "--format=csv,noheader,nounits"], 2_000,
) } = {}) {
  let current = null;
  function stop() {
    if (current) clearTimeout(current.timer);
    current = null;
  }
  function start() {
    if (current || !["linux", "win32"].includes(platform)) return;
    const state = { timer: null, devices: [] };
    current = state;
    const poll = async () => {
      let devices = [];
      try { devices = parseNvidiaReadings(await read()); } catch { /* optional driver */ }
      if (current !== state) return;
      state.devices = devices;
      state.timer = setTimeout(poll, devices.length ? 5_000 : 60_000);
      state.timer.unref?.();
    };
    void poll();
  }
  return {
    start, stop,
    snapshot: () => current?.devices.map(device => ({ ...device })) ?? [],
  };
}

const gpu = createGpuMetrics();
export const startGpuMetrics = gpu.start;
export const stopGpuMetrics = gpu.stop;
export const gpuSnapshot = gpu.snapshot;
