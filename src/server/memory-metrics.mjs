// The memory section's sources: how much memory a new process could really get,
// and how much swap — commit charge, on Windows — is in use.
//
// Moved out of system-metrics.mjs unchanged. The sampler there decides when to
// ask — every MEM_INTERVAL_MS, never on the CPU tick — and what a reading that
// failed does to the meter and to the history (sampleMemory, #789). This file
// only answers: readAvailable and readSwap return a reading or null per call,
// and keep nothing between calls.
import { readFile } from "node:fs/promises";
import os from "node:os";
import { run } from "./metrics-run.mjs";

/**
 * Bytes of memory a new process could actually get, per platform.
 *
 * Linux and macOS distinguish available memory from pages that are free right
 * now. Cached files can be reclaimed, but inactive anonymous pages still
 * belong to applications and can require compression or swap.
 *
 *   linux   /proc/meminfo MemAvailable — the kernel's own answer, a file read
 *   win32   os.freemem() already reports available physical memory
 *   darwin  vm_stat, because nothing in Node exposes the page classes
 *
 * Only darwin costs a subprocess, and only at MEM_INTERVAL_MS.
 */
/**
 * Available bytes out of `/proc/meminfo` text, or null when the field is absent.
 *
 * Pure and exported for the same reason codexHome() takes a platform: a Linux
 * answer has to be checkable from a Mac, and the only alternative is trusting
 * that a regex nobody has run is right.
 */
export function availableFromMeminfo(text) {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(text ?? ""));
  return m ? Number(m[1]) * 1024 : null;
}

/**
 * Physical memory outside the macOS Memory Used figure. Count anonymous
 * application pages after subtracting purgeable memory, wired pages and the
 * physical pages occupied by the compressor.
 */
export function availableFromVmStat(text, total) {
  const out = String(text ?? "");
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  const pages = field => Number(new RegExp(`^${field}:[ \t]+(\\d+)\\.?[ \t]*\\r?$`, "m").exec(out)?.[1]);
  const anonymous = pages("Anonymous pages");
  const purgeable = pages("Pages purgeable");
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  if (![total, pageSize, anonymous, purgeable, wired, compressed].every(Number.isSafeInteger)
    || total <= 0 || pageSize <= 0 || purgeable > anonymous) return null;
  const used = (anonymous - purgeable + wired + compressed) * pageSize;
  return used <= total ? total - used : null;
}

/**
 * How much memory is really available, or NULL when this machine could not be
 * asked.
 *
 * On Linux and macOS a failed measurement must not fall back to free pages
 * alone (#789). That would count all cached memory as used and could report
 * 99% usage on an idle machine.
 *
 * And it did not merely flicker. `record` folds into the minute bucket by
 * MAXIMUM, so one failed poll painted a red 99% peak on the memory chart that
 * survived every good sample for the next twenty-four hours. The failure is
 * ordinary: `run` resolves null on a spawn error (EAGAIN/EMFILE under fork
 * pressure — a deck watching many agents is exactly that), on a non-zero exit,
 * and on its own 2s deadline. 2,880 chances a day.
 *
 * Null instead, and the caller keeps the previous reading and records nothing.
 * A gap in the chart is honest; a 99% peak is not.
 *
 * The last branch still answers `freemem()` because on Windows there is no
 * better source to have failed — it is the measurement, not a substitute for
 * one.
 */
export async function readAvailable(platform = process.platform) {
  const total = os.totalmem();

  if (platform === "linux") {
    try {
      const parsed = availableFromMeminfo(await readFile("/proc/meminfo", "utf8"));
      if (parsed != null) return parsed;
    } catch { /* unreadable /proc — say so rather than guessing */ }
    return null;
  }

  if (platform === "darwin") {
    const out = await run("vm_stat", []);
    return (out ? availableFromVmStat(out, total) : null) ?? null;
  }

  return os.freemem();
}

/**
 * Swap out of macOS `sysctl -n vm.swapusage`, which prints
 * `total = 14336.00M  used = 12876.00M  free = 1460.00M  (encrypted)`.
 *
 * Swap is the reading a percentage cannot give you. A machine at "64% memory
 * used" that is quietly paging 12 GB to disk is not the same machine as one at
 * 64% with an empty swap file, and the difference is the one you can feel.
 */
export function swapFromSysctl(text) {
  const unit = s => {
    // `,` as well as `.`: C_LOCALE should mean this never arrives, and a parser
    // that fails closed on a whole continent's default is not a thing to leave
    // resting on one environment variable. Safe to accept both here because
    // sysctl formats with printf's %f, which never groups thousands — so a
    // comma in this field can only ever be the decimal point.
    const m = /^([\d.,]+)([KMG])?$/i.exec(s);
    if (!m) return null;
    const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] || "M").toLowerCase()] ?? 1;
    return Math.round(Number(m[1].replace(",", ".")) * mult);
  };
  const total = unit(/total\s*=\s*(\S+)/i.exec(String(text ?? ""))?.[1] ?? "");
  const used = unit(/used\s*=\s*(\S+)/i.exec(String(text ?? ""))?.[1] ?? "");
  if (total == null || used == null) return null;
  return { total, used };
}

/** Swap out of `/proc/meminfo`, where it is two fields rather than one line. */
export function swapFromMeminfo(text) {
  const s = String(text ?? "");
  const total = /^SwapTotal:\s+(\d+)\s*kB/m.exec(s);
  const free = /^SwapFree:\s+(\d+)\s*kB/m.exec(s);
  if (!total || !free) return null;
  const t = Number(total[1]) * 1024;
  return { total: t, used: Math.max(0, t - Number(free[1]) * 1024) };
}

/**
 * Windows has no swap file in the Unix sense; the comparable pressure signal is
 * commit charge, which `Win32_OperatingSystem` reports as total and free
 * virtual memory in KB. Labelled "commit" in the UI rather than "swap", because
 * calling it swap would be borrowing a word for a different mechanism.
 */
export function swapFromWmicJson(json) {
  try {
    const o = typeof json === "string" ? JSON.parse(json) : json;
    const total = Number(o?.TotalVirtualMemorySize) * 1024;
    const free = Number(o?.FreeVirtualMemory) * 1024;
    if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
    return { total, used: Math.max(0, total - free) };
  } catch { return null; }
}

export async function readSwap(platform = process.platform) {
  if (platform === "darwin") {
    const out = await run("sysctl", ["-n", "vm.swapusage"]);
    return out ? swapFromSysctl(out) : null;
  }
  if (platform === "linux") {
    try { return swapFromMeminfo(await readFile("/proc/meminfo", "utf8")); }
    catch { return null; }
  }
  if (platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVirtualMemorySize,FreeVirtualMemory | ConvertTo-Json -Compress",
    ], 4_000);
    return out ? swapFromWmicJson(out.trim()) : null;
  }
  return null;
}
