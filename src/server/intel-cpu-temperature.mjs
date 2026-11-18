// Optional Intel SMC reader. macOS's built-in powermetrics needs root; this
// installed command reads the CPU proximity sensor without elevation.
// The executable is separate software, not bundled or downloaded by ccdeck.
import { existsSync } from "node:fs";
import { run } from "./exec.mjs";

export const INTEL_CPU_TEMP_CANDIDATES = [
  "/usr/local/bin/osx-cpu-temp",
  "/opt/homebrew/bin/osx-cpu-temp",
];

export function cpuFromIntelSmc(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*°C\s*$/.exec(String(text ?? ""));
  if (!match) return null;
  const c = Number(match[1]);
  return Number.isFinite(c) && c > 0 && c < 130 ? Math.round(c) : null;
}

export async function readIntelCpuTemp(deps = {}) {
  if ((deps.platform ?? process.platform) !== "darwin" || (deps.arch ?? process.arch) !== "x64") return null;
  const exists = deps.exists ?? existsSync;
  const binary = INTEL_CPU_TEMP_CANDIDATES.find(p => exists(p));
  if (!binary) return null;
  const result = await (deps.run ?? run)(binary, ["-c"], { timeout: 2000, maxBuffer: 1024 });
  return result.ok ? cpuFromIntelSmc(result.stdout) : null;
}
