// Machine-wide CPU and memory, sampled on our own timer so every open tab reads
// the same numbers.
//
// WHY THE SERVER SAMPLES INSTEAD OF ANSWERING ON DEMAND. CPU utilisation is not
// a value you can read; it is a ratio between two readings. `os.cpus()` returns
// cumulative tick counters, so a percentage only exists relative to a previous
// sample. If the sample were taken when a request arrived, two browser tabs
// polling half a second apart would compute their deltas from different
// baselines and print different percentages for the same machine. One timer in
// one process is the only arrangement where that cannot happen — and it is what
// lets `/api/system` hand back a real 60-second history rather than whatever a
// single tab has managed to collect since it was opened.
//
// WHY THIS NEVER TOUCHES pushEvent. Every event that goes through the deck's
// stream is persisted to events.jsonl and held in the 2000-entry ring buffer. A
// three-second sampler would put 1200 entries an hour into both, evicting real
// tool calls from the replay a reconnecting tab receives, and making an ambient
// readout the loudest producer in the application. So this is a plain poll
// endpoint, exactly like /api/quota and /api/codex-usage already are.
import { lookup } from "node:dns/promises";
import { access, readdir, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { hasClaudeInstalled } from "./claude-dir.mjs";
import { run } from "./metrics-run.mjs";
import { readProcesses, resetProcessList } from "./process-list.mjs";
import {
  classifyRoute, parseNetstatE, parseNetstatIbn, parseProcNetDev, rateBetween,
  routeIfaceDarwin, routeIfaceLinux, routeLabel, tailscaleExitFromStatus,
} from "./network-metrics.mjs";

/** CPU is the metric with spikes, so it is sampled often enough to catch one. */
const CPU_INTERVAL_MS = 3_000;
/** Memory moves on the scale of minutes. Sampling it at the CPU cadence would
 *  print the same number twenty times and, on macOS, cost a subprocess to do
 *  it — see readMemory. */
const MEM_INTERVAL_MS = 30_000;
/** 20 samples x 3s = the 60 seconds the sparkline draws. */
const HISTORY = 20;

let cpuTimer = null;
let memTimer = null;
let prevTicks = null;
let prevCoreTicks = null;
let cores = null;
let swap = null;
/** Newest last. Seeded empty; the first tick produces no percentage because a
 *  delta needs two readings. */
const cpuHistory = [];
let memory = null;
let memInFlight = false;
let thermal = null;
let thermalTimer = null;
let thermalInFlight = false;
/** Consecutive readings that came back with nothing. See THERMAL_GIVE_UP. */
let thermalMisses = 0;
/** Whether this machine has EVER answered. See sampleThermal. */
let thermalEverAnswered = false;
/** Minute buckets, oldest first, for every section that keeps a history.
 *  See HISTORY_MINUTES. */
const history = [];
/** When sampling started, so a modal can say what "since" means. */
let historySince = 0;

/** Total and idle jiffies across every core, as one pair. */
function readTicks() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === "idle") idle += ms;
    }
  }
  return { idle, total };
}

/** The same pair, per core, in `os.cpus()` order. */
function readCoreTicks() {
  return os.cpus().map(cpu => {
    let idle = 0;
    let total = 0;
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === "idle") idle += ms;
    }
    return { idle, total };
  });
}

/**
 * Busy percentage per core since the previous reading.
 *
 * The aggregate figure the topbar draws hides the shape of the load, and the
 * shape is what tells a saturated machine from a machine running one hot
 * single-threaded job. Same delta arithmetic as `cpuPercent`, one row per core,
 * and the same refusal to invent a number before there are two readings.
 */
function corePercents() {
  const now = readCoreTicks();
  const prev = prevCoreTicks;
  prevCoreTicks = now;
  if (!prev || prev.length !== now.length) return null;
  return now.map((c, i) => {
    const dTotal = c.total - prev[i].total;
    const dIdle = c.idle - prev[i].idle;
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1000) / 10));
  });
}

/**
 * Busy percentage across all cores since the previous reading, 0-100.
 *
 * Aggregate rather than per-core, and normalised rather than macOS's
 * 0-to-cores*100 convention, because it has to mean the same thing on all three
 * platforms and because a bar needs an end. The cost is that it saturates: a
 * machine at load 12 and a machine at load 18 both read 100. `loadavg` is what
 * carries that difference, which is why it rides along below on the platforms
 * that report it.
 */
function cpuPercent() {
  const now = readTicks();
  if (!prevTicks) { prevTicks = now; return null; }
  const dTotal = now.total - prevTicks.total;
  const dIdle = now.idle - prevTicks.idle;
  prevTicks = now;
  // A tick counter that did not move says nothing; it does not say "idle".
  if (dTotal <= 0) return null;
  const pct = (1 - dIdle / dTotal) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

/**
 * Bytes of memory a new process could actually get, per platform.
 *
 * `os.freemem()` is the obvious call and it is the wrong one on two of the three
 * platforms, because "free" and "available" are different questions. Pages
 * holding cached files or inactive anonymous memory are not free, but the kernel
 * will hand them over the moment something asks. Reporting them as used is what
 * makes the naive `(total - free) / total` read 99.5% on an idle 32 GB Mac — a
 * number that would send the reader straight to Activity Monitor, which is the
 * one outcome this readout exists to prevent.
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
 * Available bytes out of `vm_stat` output, or null when it does not parse.
 *
 * Everything the kernel can hand over without swapping: genuinely free pages,
 * read-ahead it can drop, inactive anonymous pages, and purgeable caches. This
 * is the number `os.freemem()` is missing — it reports only the first of the
 * four, which is why the naive formula reads ~99% on an idle 32 GB Mac.
 */
export function availableFromVmStat(text, total) {
  const out = String(text ?? "");
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1]) || 4096;
  const pages = name => {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(out);
    return m ? Number(m[1]) : 0;
  };
  const reclaimable = pages("free") + pages("speculative")
    + pages("inactive") + pages("purgeable");
  if (reclaimable <= 0) return null;
  const avail = reclaimable * pageSize;
  return total != null && avail > total ? null : avail;
}

/**
 * How much memory is really available, or NULL when this machine could not be
 * asked.
 *
 * `os.freemem()` USED TO BE THE FALLBACK ON BOTH REAL PLATFORMS, and it is the
 * one number this function exists to avoid (#789). The header above says why:
 * counting only genuinely free pages makes the naive `(total - free) / total`
 * read 99.5% on an idle 32 GB Mac — "a number that would send the reader
 * straight to Activity Monitor, which is the one outcome this readout exists to
 * prevent". So a failed measurement produced exactly the reading the module was
 * written to suppress.
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
async function readAvailable(platform = process.platform) {
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

async function readSwap(platform = process.platform) {
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

/**
 * The process list, which lives in process-list.mjs: it is read on demand
 * rather than on a timer here, and index.mjs asks this module for it.
 */
export { readProcesses };

// ---------------------------------------------------------------------------
// Thermal: is this machine getting hot, and is it being held back for it.
//
// The section the load average cannot answer. A saturated machine that is cool
// is a machine doing work; a saturated machine that is thermally limited is one
// where the next agent you launch makes everything slower, and `67.27 82.98
// 74.19` reads identically in both cases.
//
// THREE PLATFORMS ANSWER THREE DIFFERENT QUESTIONS, and on one of them the
// honest answer is not a temperature at all. Everything below was measured on
// the machines available rather than taken from documentation, and the negative
// results are recorded here because they are the reason the shape is what it
// is:
//
//   Linux    /sys/class/hwmon/hwmon*/temp*_input, millidegrees Celsius, with
//            the chip in `name` and the sensor in `temp*_label`. A plain file
//            read, exactly like /proc/meminfo — no subprocess, and the chip
//            publishes its own `temp*_max` and `temp*_crit`, so the warning
//            bands are the hardware's rather than ones invented here.
//            /sys/class/thermal/thermal_zone*/ is the coarser fallback.
//
//   macOS    No CPU degrees without root, verified: `powermetrics --samplers
//            smc` answers "powermetrics must be invoked as the superuser", and
//            `ioreg -c AppleSMC -r -d 1` publishes no temperature key at all to
//            an unprivileged process. Asking a dashboard for a password every
//            ten seconds is not an option, and this deck does not ship a
//            kernel driver.
//
//            But the GPU driver does publish one, and nothing said so: the
//            accelerator's PerformanceStatistics carries "Temperature(C)"
//            beside its clock, its activity and its power. Read live on an
//            Intel Mac with an AMD card — 60, 60, 61 over four seconds, from
//            `ioreg -r -k PerformanceStatistics` in 51ms. Apple Silicon's
//            AGXAccelerator publishes the same dictionary WITHOUT that key, so
//            there the parser finds nothing and no row is drawn, which is the
//            correct outcome rather than a special case.
//
//            And `pmset -g therm` is unprivileged, instant, and present on
//            both architectures. What it reports is not heat but the
//            consequence of heat: CPU_Speed_Limit, the share of the CPU's speed
//            the thermal manager is currently allowing. That is arguably the
//            more useful of the two readings — a temperature is a number you
//            have to interpret, a speed limit is the thing you were trying to
//            interpret it into.
//
//            `sysctl machdep.xcpm.cpu_thermal_level` is deliberately unused. It
//            is live (33, then 42, then 41 over three seconds) but it is
//            Intel-only and an undocumented scale, and printing it as though it
//            were degrees would be exactly the lie this module refuses.
//
//   Windows  The performance counter `\Thermal Zone Information(*)\High
//            Precision Temperature`, in TENTHS OF A KELVIN, read through
//            Get-Counter.
//
//            It is read through a counter rather than through WMI for one
//            reason, and it is the reason this section never worked on Windows
//            for anybody: MSAcpi_ThermalZoneTemperature lives in root\wmi and
//            that namespace REQUIRES ADMINISTRATOR. A deck started from an
//            ordinary terminal — which is every deck, since v1 must never need
//            admin rights — got Access Denied, three times, and then gave up
//            for the life of the process. The section was not missing because
//            the hardware was silent; it was missing because we were asking
//            somewhere we were not allowed to look.
//
//            MSAcpi is still asked, second, because a deck that IS elevated can
//            read it and because the two do not always agree — some boards
//            publish a zone to ACPI and no counter.
//
//            Genuinely absent on a large share of machines either way: a
//            desktop board with no zone, and every virtual machine, which has
//            no thermal hardware to report. Measured on a QEMU/SeaBIOS guest:
//            the counter set is registered and answers "The specified instance
//            is not present", and MSAcpi answers "Not supported" even to an
//            administrator. Absent is ordinary here rather than an error.
//
//            THE COUNTER PATH IS LOCALISED. `Thermal Zone Information` is the
//            English name and a German or French Windows publishes its own, so
//            this reaches the counter on an English install and falls through
//            to MSAcpi elsewhere. Translating it means resolving a numeric
//            index through the registry, which is a change with no way to be
//            tested from here — see #747.
//
// NEVER INVENT A READING. No sensor means no row, and no rows at all means the
// section is not rendered: not 0°C, not a dash, not a grey empty bar. Same rule
// that keeps `cpu` null until two samples exist.

/** How often the thermal reading is refreshed. Heat moves on the scale of
 *  seconds, and the two platforms that cost a subprocess to ask cost 51ms
 *  (`ioreg`) and rather less (`pmset`), measured. Linux costs a file read. */
const THERMAL_INTERVAL_MS = 10_000;

/**
 * How many consecutive empty readings before this machine is left alone.
 *
 * The reason is Windows, where MSAcpi_ThermalZoneTemperature is absent on a
 * large share of desktops: without this, every one of those machines would pay
 * a `Get-CimInstance` child every ten seconds, forever, to render a section it
 * can never render. Three rather than one because a single failure can be a
 * hiccup — a timeout, a machine mid-wake — and giving up on a hiccup would lose
 * a reading the machine does have.
 *
 * Not persisted. A restart asks again, which is what should happen after the
 * user installs a driver or changes a firmware setting.
 */
const THERMAL_GIVE_UP = 3;

/** Bands used where the hardware publishes none of its own. Linux sensors
 *  carry `temp*_max` and `temp*_crit` and those win: a laptop package sensor
 *  and an NVMe drive do not share a comfortable range, and one scale for both
 *  would be a number this module made up. */
const WARN_C = 75;
const CRIT_C = 90;

/**
 * How much history the panel keeps, and why it is bucketed by minute.
 *
 * Each section answers "what is it now"; the chart behind it answers "what did
 * it do while that build was running", which is a different question and the
 * reason a section opens one at all. 1440 minutes is a day, which covers "since
 * the deck started" for every session anybody actually has.
 *
 * A bucket holds the MAXIMUM of its minute, never the mean, and that choice is
 * the same one for every series here. A machine that touched 94°C for twenty
 * seconds and sat at 60 for the rest of the minute averages to 66 and reads as
 * calm; a load average that spiked to 114 between two quiet stretches averages
 * away entirely. The spike is what somebody opens a chart to find.
 *
 * Kept out of systemSnapshot deliberately. That endpoint is polled every three
 * seconds by a topbar meter that draws none of this; a day of buckets on every
 * one of those responses would be the largest thing the deck sends, for charts
 * that are usually closed. It has its own route, like the process list.
 */
const HISTORY_MINUTES = 1440;
const BUCKET_MS = 60_000;

/** A reading that is not a temperature is not a misparse to be shown anyway.
 *  Silicon does not run below freezing or above 130°C, and both ends of that
 *  have been produced by reading the right file with the wrong unit. */
const plausible = c => Number.isFinite(c) && c > 0 && c < 130;

/**
 * Millidegrees Celsius out of a hwmon `temp*_input`, or null.
 *
 * The kernel writes an integer; the divide is the whole conversion. Exported
 * and pure for the reason every parser here is: a Linux answer has to be
 * checkable from a Mac.
 */
export function celsiusFromMilli(text) {
  const n = Number(String(text ?? "").trim());
  const c = Math.round(n / 1000);
  return plausible(c) ? c : null;
}

/**
 * Which of a machine's sensors the panel names, out of every sensor found.
 *
 * A real machine publishes a lot of them: the package, one per core, the NVMe
 * drive, the wireless card, the chipset. Two rows is what the panel has room
 * for and two rows is what somebody watching a build wants, so this picks the
 * CPU and the GPU by the chip that published them and leaves the rest alone.
 *
 * Preference inside a chip matters as much as the chip does. coretemp exposes
 * `Package id 0` beside `Core 0`..`Core N`, and the package is the reading
 * — a single core's number is noisier and lower than the die it sits on.
 * k10temp exposes `Tctl` and, on parts that have it, `Tdie`: Tctl is Tdie plus
 * a vendor offset that exists for fan control, so Tdie is the temperature and
 * Tctl is the fallback. amdgpu's `edge` is the die edge and `junction` is the
 * hotspot; edge is what every other tool calls the GPU temperature.
 *
 * Where a chip publishes nothing recognisable, the hottest of its sensors is
 * taken, because the question is "is it getting hot" and the hottest sensor is
 * the one that answers it.
 */
const CPU_CHIPS = ["coretemp", "k10temp", "zenpower", "cpu_thermal", "soc_thermal"];
const GPU_CHIPS = ["amdgpu", "nouveau", "i915", "xe", "radeon"];

export function pickThermalRows(sensors) {
  const hottest = rows => rows.reduce((a, b) => (b.celsius > a.celsius ? b : a));
  const pick = (chips, prefer, label) => {
    const mine = (sensors ?? []).filter(s => chips.includes(s.chip) && plausible(s.celsius));
    if (!mine.length) return null;
    for (const re of prefer) {
      const hit = mine.find(s => re.test(s.label ?? ""));
      if (hit) return { ...hit, label };
    }
    return { ...hottest(mine), label };
  };
  return [
    pick(CPU_CHIPS, [/^package id/i, /^tdie$/i, /^tctl$/i], "CPU"),
    pick(GPU_CHIPS, [/^edge$/i, /^junction$/i], "GPU"),
  ].filter(Boolean);
}

/**
 * Every temperature sensor under /sys/class/hwmon, with the chip that owns it
 * and the bands that chip publishes for it.
 *
 * `root` is a parameter so this can be pointed at a tree on disk. There is no
 * Linux machine here and no container runtime, so the alternative would be a
 * directory walk nobody has ever run — and a walk is exactly the kind of code
 * that a fixture of its OUTPUT cannot check, because the walk is the part that
 * is wrong.
 */
export async function readHwmon(root = "/sys/class/hwmon", deps = {}) {
  const dir = deps.readdir ?? readdir;
  const file = deps.readFile ?? readFile;
  const read = async path => { try { return String(await file(path, "utf8")).trim(); } catch { return null; } };
  let chips;
  try { chips = await dir(root); } catch { return []; }
  const out = [];
  for (const hwmon of chips) {
    const base = `${root}/${hwmon}`;
    const chip = (await read(`${base}/name`)) ?? hwmon;
    let entries;
    try { entries = await dir(base); } catch { continue; }
    for (const entry of entries) {
      const m = /^(temp\d+)_input$/.exec(entry);
      if (!m) continue;
      const celsius = celsiusFromMilli(await read(`${base}/${entry}`));
      if (celsius == null) continue;
      const chipMax = celsiusFromMilli(await read(`${base}/${m[1]}_max`));
      const chipCrit = celsiusFromMilli(await read(`${base}/${m[1]}_crit`));
      out.push({
        chip,
        label: await read(`${base}/${m[1]}_label`),
        celsius,
        // The hardware's own bands where it has them. `max` is where the chip
        // says it is unhappy and `crit` is where it says it will act.
        //
        // `max` ONLY WHEN IT IS BELOW `crit`, because on Intel coretemp the two
        // files carry the same number. Measured on a live machine:
        //
        //   coretemp  temp1_input 88000  temp1_max 100000  temp1_crit 100000
        //   nvme      temp1_input 45850  temp1_max  84850  temp1_crit  85850
        //
        // The nvme row is a real band and works. The coretemp row is not: with
        // max === crit the amber band is zero degrees wide, so thermalTone goes
        // from calm straight to hot at 100C — a number a CPU reaches only as it
        // shuts the machine down. A CPU at 89C was painted the same grey as one
        // at 45C, on the one row anybody reads, and the 75/90 fallback that
        // would have said so was discarded precisely BECAUSE the chip published
        // its own. A chip that publishes one usable threshold is telling us
        // where it will act, not where to start worrying.
        warnAt: chipMax != null && chipCrit != null && chipMax >= chipCrit
          ? Math.min(WARN_C, Math.round(chipCrit * 0.9))
          : chipMax ?? WARN_C,
        critAt: chipCrit ?? CRIT_C,
      });
    }
  }
  return out;
}

/**
 * The coarser Linux fallback, for a machine whose sensors have no hwmon driver.
 *
 * One row, and it is labelled with the zone's own `type` rather than "CPU",
 * because a thermal zone is not a claim about what was measured. `acpitz` is
 * the motherboard's idea of ambient on a lot of hardware and calling that the
 * CPU would be the same lie in a different place.
 */
const ZONE_ORDER = ["x86_pkg_temp", "cpu-thermal", "cpu_thermal", "soc_thermal"];

export async function readThermalZones(root = "/sys/class/thermal", deps = {}) {
  const dir = deps.readdir ?? readdir;
  const file = deps.readFile ?? readFile;
  const read = async path => { try { return String(await file(path, "utf8")).trim(); } catch { return null; } };
  let zones;
  try { zones = (await dir(root)).filter(n => /^thermal_zone\d+$/.test(n)); } catch { return []; }
  const found = [];
  for (const zone of zones) {
    const celsius = celsiusFromMilli(await read(`${root}/${zone}/temp`));
    if (celsius == null) continue;
    found.push({ label: (await read(`${root}/${zone}/type`)) ?? zone, celsius, warnAt: WARN_C, critAt: CRIT_C });
  }
  if (!found.length) return [];
  const known = found.find(z => ZONE_ORDER.includes(z.label));
  return [known ?? found.reduce((a, b) => (b.celsius > a.celsius ? b : a))];
}

/**
 * GPU degrees out of `ioreg -r -k PerformanceStatistics`.
 *
 * The macOS reading nothing documented: the accelerator publishes
 * "Temperature(C)" in the same dictionary as its clock and its power. The
 * maximum across accelerators, because a machine with two cards is asking
 * whether it is getting hot, and the hotter card is the answer.
 */
export function gpuFromIoreg(text) {
  let best = null;
  for (const m of String(text ?? "").matchAll(/"Temperature\(C\)"\s*=\s*(-?\d+)/g)) {
    const c = Number(m[1]);
    if (plausible(c) && (best == null || c > best)) best = c;
  }
  return best;
}

/**
 * The share of the CPU's speed the thermal manager is allowing, out of
 * `pmset -g therm`, or null when this Mac has never recorded one.
 *
 * `CPU_Scheduler_Limit` sits beside it and is deliberately not read: it limits
 * scheduling rather than clock, so folding the two into one percentage would
 * produce a number that is neither. If scheduler throttling turns out to matter
 * it is a second row, not a redefinition of this one.
 */
export function throttleFromPmset(text) {
  const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(String(text ?? ""));
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return { speedLimit: pct };
}


/**
 * Windows thermal zones out of the `Thermal Zone Information` counter set.
 *
 * `High Precision Temperature` is in TENTHS OF A KELVIN, which is the single
 * detail this branch turns on — the same unit MSAcpi uses below, and reading it
 * as anything else gives a number that is plausible-looking and wrong.
 *
 * This is the source that works WITHOUT ADMINISTRATOR, which is the whole point
 * of it: root\wmi needs elevation and a deck never has it. See the note at the
 * top of this section.
 *
 * Shape is `[{ i: instanceName, v: cookedValue }]` — the projection the
 * PowerShell one-liner makes, so this parser never has to know what a
 * CounterSample looks like.
 */
export const WIN_THERMAL_PS = [
  "$r = [ordered]@{}",
  // Get-Counter, not Get-CimInstance: this is the half that works unelevated.
  "try { $r.perf = @((Get-Counter -Counter '\\Thermal Zone Information(*)\\High Precision Temperature' -EA Stop).CounterSamples | ForEach-Object { @{ i = $_.InstanceName; v = $_.CookedValue } }) } catch {}",
  // THE SAME COUNTER UNDER THE NAME THIS WINDOWS CALLS IT.
  //
  // Performance-counter set and counter names are LOCALIZED. That is why PDH
  // ships `PdhAddEnglishCounter` beside `PdhAddCounter` at all, and
  // `Get-Counter -Counter` takes a localized path: hand it the English one on a
  // German, French, Japanese or Russian Windows and it answers "The specified
  // object was not found on the computer." `-EA Stop` plus `catch {}` turns
  // that into silence, so the line above falls straight through to MSAcpi —
  // which this module's own header says needs elevation a deck never has — and
  // then to LibreHardwareMonitor, which is only there if the user installed it.
  // A machine with real ACPI thermal zones and a non-English display language
  // therefore drew no Thermal section at all, indistinguishable from the
  // modern-Intel-laptop case the section is written to tolerate.
  //
  // This is the class #552 fixed one module over: exec.mjs spends two screens
  // on "Windows ships cmd.exe in every language it ships in, and these
  // sentences are translated with it", and the C_LOCALE block in
  // metrics-run.mjs is there for the same reason.
  //
  // Perflib is the documented map between the two spellings. `…\Perflib\009`
  // holds a REG_MULTI_SZ of alternating index and ENGLISH name; the parallel
  // `…\Perflib\CurrentLanguage` holds index and LOCAL name. Look the two
  // English names up to get their indices, read the local names at the same
  // indices, and build the path out of those.
  //
  // SECOND, NOT FIRST, and that is what makes it safe to add: an English
  // Windows never reaches this line, because `$r.perf` is already filled. It
  // can only turn a machine that was reporting nothing into one that reports
  // something.
  //
  // NOT ONE DOUBLE QUOTE, for the reason the whole of this string has none: it
  // travels as a single `-Command` argument on a Windows command line. The
  // counter path is concatenated rather than interpolated so that no quoting
  // form beyond the single quote is needed anywhere in it.
  //
  // REASONED, NOT REPRODUCED. The localization of counter names is documented
  // Microsoft behaviour and the Perflib layout is documented with it, but no
  // localized Windows was available to run this against, and CI's runners are
  // English — so what CI proves about this line is that it parses and runs
  // clean on a real Windows, not that it resolves a German counter name.
  "if (-not $r.perf) { try { "
    + "$en = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Perflib\\009' -EA Stop).Counter; "
    + "$lo = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Perflib\\CurrentLanguage' -EA Stop).Counter; "
    + "$byIndex = @{}; for ($i = 1; $i -lt $lo.Count; $i += 2) { $byIndex[$lo[$i-1]] = $lo[$i] }; "
    + "$set = $null; $ctr = $null; "
    + "for ($i = 1; $i -lt $en.Count; $i += 2) { "
    + "if ($en[$i] -eq 'Thermal Zone Information') { $set = $byIndex[$en[$i-1]] } "
    + "elseif ($en[$i] -eq 'High Precision Temperature') { $ctr = $byIndex[$en[$i-1]] } }; "
    + "if ($set -and $ctr) { $r.perf = @((Get-Counter -Counter ('\\' + $set + '(*)\\' + $ctr) -EA Stop).CounterSamples "
    + "| ForEach-Object { @{ i = $_.InstanceName; v = $_.CookedValue } }) } "
    + "} catch {} }",
  "if (-not $r.perf) { try { $r.acpi = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -EA Stop | ForEach-Object { @{ i = $_.InstanceName; v = $_.CurrentTemperature } }) } catch {} }",
  // Depth matters: the default of 2 turns the inner hashtables into the string
  // "System.Collections.Hashtable" and this parser would see nothing at all.
  "$r | ConvertTo-Json -Compress -Depth 4",
].join("; ");

/**
 * Whichever of the two Windows sources answered, as thermal rows.
 *
 * The shape is `{ perf: [...] }` or `{ acpi: [...] }` or `{}` — the PowerShell
 * above only ever fills one, and fills neither on the machines where there is
 * nothing to fill it with. Both lists carry the same two fields and the same
 * unit, so the only thing that differs is which key they arrived under.
 */
export function parseWinThermal(json) {
  let r;
  try { r = typeof json === "string" ? JSON.parse(json) : json; }
  catch { return []; }
  if (!r || typeof r !== "object") return [];
  const perf = tempFromPerfCounterJson(r.perf ?? []);
  if (perf.length) return perf;
  return tempFromPerfCounterJson(
    // MSAcpi's projection uses the same two keys, so the one parser reads both.
    Array.isArray(r.acpi) ? r.acpi : (r.acpi ? [r.acpi] : []),
  );
}

export function tempFromPerfCounterJson(json) {
  let rows;
  try { rows = typeof json === "string" ? JSON.parse(json) : json; }
  catch { return []; }
  if (!rows) return [];
  if (!Array.isArray(rows)) rows = [rows];
  const found = [];
  for (const r of rows) {
    const tenths = Number(r?.v);
    if (!Number.isFinite(tenths)) continue;
    const celsius = Math.round(tenths / 10 - 273.15);
    if (!plausible(celsius)) continue;
    found.push({ label: zoneLabel(r?.i), celsius, warnAt: WARN_C, critAt: CRIT_C });
  }
  if (found.length === 1) found[0].label = "Thermal zone";
  return found.slice(0, 2);
}

/**
 * A thermal zone's name, out of whatever spelling the source used.
 *
 * The counter names its instances `\_tz.tz00` and WMI names the same zone
 * `ACPI\ThermalZone\TZ00_0`, so the tail after the last separator is the only
 * part the two agree on. Upper-cased because the counter lower-cases it and a
 * panel that showed `tz00` beside a `TZ01` from the other source would be
 * showing one machine as two.
 */
export function zoneLabel(raw) {
  const tail = String(raw ?? "").split(/[\\.]/).pop() ?? "";
  const name = tail.replace(/_\d+$/, "").toUpperCase();
  return name || "Thermal zone";
}


/**
 * The macOS rows, from whatever the three sources answered.
 *
 * Pure, and exported, for the reason sampleThermal's `deps.read` is: the branch
 * that matters only fires on a machine that answers with nothing, and the
 * machine this was written on answers with something. There is no other way to
 * run it.
 *
 * The ordering rule is the whole content. ioreg's GPU degrees and pmset's
 * throttle are what macOS itself gives up, and they win — they cost one cheap
 * subprocess each and they are the same numbers this deck has always shown.
 * macmon is consulted only when both were silent, and then its CPU row comes
 * first, because on the machine that reaches here the CPU is the reading
 * somebody opened the panel for.
 */
export function darwinThermal({ gpuC = null, throttle = null, macmon = {} } = {}) {
  const celsius = [];
  if (gpuC != null) celsius.push({ label: "GPU", celsius: gpuC, warnAt: WARN_C, critAt: CRIT_C });
  else {
    if (macmon.cpu != null) celsius.push({ label: "CPU", celsius: macmon.cpu, warnAt: WARN_C, critAt: CRIT_C });
    if (macmon.gpu != null) celsius.push({ label: "GPU", celsius: macmon.gpu, warnAt: WARN_C, critAt: CRIT_C });
  }
  return celsius.length || throttle ? { celsius, throttle } : null;
}

/**
 * What /api/system carries, or null when this machine says nothing at all.
 *
 * Two fields rather than one list, because they are two different readings and
 * collapsing them would let a throttle percentage be drawn under a °C heading
 * — the thing the label rule exists to prevent. `swapLabel` earned that rule
 * once already.
 */
export async function readThermal(platform = process.platform) {
  if (platform === "linux") {
    const sensors = await readHwmon();
    const celsius = pickThermalRows(sensors);
    const rows = celsius.length ? celsius : await readThermalZones();
    return rows.length ? { celsius: rows, throttle: null } : null;
  }

  if (platform === "darwin") {
    // Scoped by key rather than dumped whole: `ioreg -l` is 217KB and just
    // under two seconds on this machine, `-r -k PerformanceStatistics` is 83KB
    // and 51ms for the same number.
    const [gpu, therm] = await Promise.all([
      run("ioreg", ["-r", "-k", "PerformanceStatistics", "-w", "0"], 3_000),
      run("pmset", ["-g", "therm"]),
    ]);
    const gpuC = gpu ? gpuFromIoreg(gpu) : null;
    const throttle = therm ? throttleFromPmset(therm) : null;

    // Nothing from either is every Apple Silicon Mac, and only those: the AGX
    // driver does not publish the key ioreg reads, and pmset records no speed
    // limit on M-series. Asking macmon is the only thing left, and it is asked
    // ONLY here — an Intel Mac answers above and never spawns it. See
    // macmon.mjs for why a tool the user installed is the whole of the answer.
    const macmon = gpuC == null && !throttle
      ? await (await import("./macmon.mjs")).readMacmonTemps()
      : {};

    return darwinThermal({ gpuC, throttle, macmon });
  }

  if (platform === "win32") {
    // One child for both sources rather than two, because the cost here is the
    // PowerShell start and not the queries: the counter is tried first because
    // it needs no administrator, and MSAcpi only when the counter said nothing.
    // Both are wrapped in their own try — "no thermal zone on this machine" is
    // the ordinary answer and arrives as a throw from either.
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", WIN_THERMAL_PS,
    ], 6_000);
    const answer = out ? parseWinThermal(out.trim()) : [];
    if (answer.length) return { celsius: answer, throttle: null };

    // Windows itself had nothing, which on a modern Intel laptop is every time:
    // the firmware declares no ACPI thermal zone and the sensors sit behind
    // Intel DTT, which an ordinary process may not read. If something on this
    // machine has already gone and got them — LibreHardwareMonitor, with its
    // web server on — they are a plain HTTP read away. Never installed, never
    // asked for. See hwmonitor.mjs.
    const { readHwMonitorTemps } = await import("./hwmonitor.mjs");
    const t = await readHwMonitorTemps();
    const rows = [];
    if (t.cpu != null) rows.push({ label: "CPU", celsius: t.cpu, warnAt: WARN_C, critAt: CRIT_C });
    if (t.gpu != null) rows.push({ label: "GPU", celsius: t.gpu, warnAt: WARN_C, critAt: CRIT_C });
    return rows.length ? { celsius: rows, throttle: null } : null;
  }

  return null;
}

/**
 * Fold one reading into the minute it belongs to, under a namespaced key.
 *
 * Keys are namespaced by section (`thermal:GPU`, `cpu:all`, `mem:swap`) rather
 * than kept in four rings, because they all share one clock: a bucket is a
 * minute of this machine, and every series that has something to say about that
 * minute says it in the same place. The sections sample at different rates —
 * CPU every three seconds, thermal every ten, memory every thirty — and folding
 * by maximum makes that difference invisible to the reader, which is what it
 * should be.
 */
function record(key, value, nowMs = Date.now()) {
  if (!Number.isFinite(value)) return;
  const minute = Math.floor(nowMs / BUCKET_MS);
  let last = history[history.length - 1];
  if (!last || last.m !== minute) {
    last = { m: minute, v: {} };
    history.push(last);
    while (history.length > HISTORY_MINUTES) history.shift();
  }
  const prev = last.v[key];
  last.v[key] = prev == null ? value : Math.max(prev, value);
}

/**
 * The thermal reading, whose series are not known until the machine answers.
 *
 * Keyed by the row's own label rather than by position, because the rows are
 * not the same on every platform and a machine can start reporting a sensor it
 * was not reporting before — a GPU driver loads, a laptop is docked. A series
 * that appears late simply has no points before it appeared, which is the truth
 * and draws correctly.
 */
function recordThermal(reading, nowMs = Date.now()) {
  if (!reading) return;
  for (const r of reading.celsius ?? []) record(`thermal:${r.label}`, r.celsius, nowMs);
  // Stored as the share TAKEN AWAY, the same way the panel draws it, so the
  // chart and the row cannot disagree about which direction is bad.
  if (reading.throttle) {
    record(`thermal:${THROTTLE_LABEL}`, Math.max(0, 100 - reading.throttle.speedLimit), nowMs);
  }
}

/** The one thermal row that is not degrees. Named once so the recorder, the
 *  route and the panel cannot drift apart on the spelling. */
export const THROTTLE_LABEL = "Throttling";

/**
 * The scale a series is drawn against.
 *
 * Fixed at 100 wherever the PANEL draws the same number against a 0-100 track,
 * because two pictures of one reading that disagree about how alarming it is
 * would be worse than either alone. Load average is the exception and gets a
 * fitted top: it is genuinely unbounded — measured at 114 on a twelve-core
 * machine — and the section that shows it draws no track at all, so there is no
 * competing picture for a fitted scale to contradict. Rounded up to something a
 * person would choose, and floored at one and a half times the core count so a
 * quiet machine is not drawn as a dramatic climb.
 */
function loadTop(points, coreCount) {
  const peak = points.reduce((a, p) => Math.max(a, p.v), 0);
  const floor = Math.max(4, Math.ceil(coreCount * 1.5));
  const want = Math.max(floor, peak * 1.15);
  const step = want <= 20 ? 5 : want <= 100 ? 10 : 50;
  return Math.ceil(want / step) * step;
}

/**
 * What each section's chart is made of.
 *
 * One entry per series, each carrying its own unit, its own bands and its own
 * scale, because a percentage, a temperature and a queue depth share nothing —
 * drawing them against one axis would invite a reading of one shape against
 * another that means nothing.
 */
function seriesFor(group) {
  const at = key => history.filter(b => b.v[key] != null)
    // Timestamps rather than indices: a bucket only exists for a minute that was
    // sampled, so a gap — the machine asleep, the process paused — stays a gap
    // rather than becoming a straight line across it.
    .map(b => ({ t: b.m * BUCKET_MS, v: b.v[key] }));
  const coreCount = os.cpus().length;

  if (group === "thermal") {
    const bands = new Map((thermal?.celsius ?? []).map(r => [r.label, r]));
    const labels = [];
    for (const b of history) {
      for (const k of Object.keys(b.v)) {
        if (!k.startsWith("thermal:")) continue;
        const label = k.slice("thermal:".length);
        if (!labels.includes(label)) labels.push(label);
      }
    }
    return labels.map(label => ({
      // The stable name of this reading, which the display label is not: `Swap`
      // is `Commit` on Windows, and anything joining on what the eye sees
      // breaks on the one platform nobody re-reads this on. It is the key the
      // ring is already recorded under, published rather than invented.
      key: `thermal:${label}`,
      label,
      unit: label === THROTTLE_LABEL ? "%" : "C",
      top: 100,
      // Throttling is the one reading here whose normal value is zero, so it
      // is the one that does not need a full-height box to be read. Said by the
      // series rather than inferred from "has no bands", which was the first
      // rule and was wrong: CPU has no bands DELIBERATELY and uses the whole
      // scale, so it was getting the short box for a reason that is not true
      // of it.
      restsAtZero: label === THROTTLE_LABEL,
      warnAt: label === THROTTLE_LABEL ? null : (bands.get(label)?.warnAt ?? WARN_C),
      critAt: label === THROTTLE_LABEL ? null : (bands.get(label)?.critAt ?? CRIT_C),
      points: at(`thermal:${label}`),
    }));
  }

  if (group === "cores") {
    // Not one line per core: twelve lines in a 620px dialog is a picture nobody
    // can read. These two answer what the columns cannot answer over time —
    // "all cores" at 20 with "busiest" at 100 is ONE core pinned, which is a
    // different machine from twelve at 20.
    //
    // No bands, deliberately, and the reason is written at the top of
    // MachinePanel: a CPU at 90% is the machine doing the work you asked for. An
    // indicator that alarms during the normal case teaches you to stop reading
    // it.
    return [
      { key: "cpu:all", label: "All cores", unit: "%", top: 100, warnAt: null, critAt: null, points: at("cpu:all"), restsAtZero: false },
      { key: "cpu:busiest", label: "Busiest core", unit: "%", top: 100, warnAt: null, critAt: null, points: at("cpu:busiest"), restsAtZero: false },
    ].filter(s => s.points.length);
  }

  if (group === "memory") {
    const swapLabel = process.platform === "win32" ? "Commit" : "Swap";
    return [
      // One band, not two. A `critAt` of 100 draws a rule along the top of a
      // chart whose scale ends at 100 — it is the ceiling, drawn again in red,
      // and it says nothing the edge did not.
      { key: "mem:physical", label: "Physical", unit: "%", top: 100, warnAt: 90, critAt: null, restsAtZero: false, points: at("mem:physical") },
      { key: "mem:swap", label: swapLabel, unit: "%", top: 100, warnAt: 90, critAt: null, restsAtZero: false, points: at("mem:swap") },
    ].filter(s => s.points.length);
  }

  if (group === "load") {
    // One series, not three. 1m, 5m and 15m are three views of one number —
    // the longer two are the short one smoothed — so charting the 1m over an
    // hour says everything the other two would, at the resolution they hide.
    const points = at("load:1m");
    if (!points.length) return [];
    return [{
      key: "load:1m",
      label: "Queued work",
      unit: "",
      top: loadTop(points, coreCount),
      // Where the queue exceeds the cores there are to run it, which is the one
      // number the section's own note already draws the line at.
      warnAt: coreCount,
      critAt: null,
      restsAtZero: false,
      points,
    }];
  }

  if (group === "network") {
    // Download and upload are two charts, not two lines on one: upload is
    // usually a hundredth of download, and on a shared scale it is a line along
    // the floor. Each gets a top fitted to its own peak. No bands: there is no
    // throughput that is too much, only more than usual, and a threshold here
    // would be a number this module made up.
    const down = at("net:down");
    const up = at("net:up");
    const api = at("net:api");
    const series = [
      // Floors of 100 KB/s and 100 ms, so a quiet line is drawn as quiet.
      { key: "net:down", label: "Download", unit: "B/s", top: niceTop(down, 100_000), warnAt: null, critAt: null, restsAtZero: false, points: down },
      { key: "net:up", label: "Upload", unit: "B/s", top: niceTop(up, 100_000), warnAt: null, critAt: null, restsAtZero: false, points: up },
      { key: "net:api", label: "Claude API latency", unit: "ms", top: niceTop(api, 100), warnAt: null, critAt: null, restsAtZero: false, points: api },
    ].filter(s => s.points.length);
    // The path the traffic took, as marks on the last chart — the question the
    // section exists for is "was it the VPN", and a line that jumps where a
    // mark sits answers it without a legend.
    const since = history.length ? history[0].m * BUCKET_MS : 0;
    const changes = routeLog.filter(c => c.t >= since).map(c => ({ t: c.t, label: c.label, from: c.from }));
    if (series.length && changes.length) series[series.length - 1].changes = changes;
    return series;
  }

  return [];
}

/** A scale top a person would choose — 1, 2 or 5 times a power of ten — just
 *  above the peak, and never below `floor`, so an idle line is not drawn as a
 *  dramatic climb. */
function niceTop(points, floor) {
  const peak = points.reduce((a, p) => Math.max(a, p.v), 0);
  const want = Math.max(floor, peak * 1.15);
  const pow = 10 ** Math.floor(Math.log10(want));
  for (const m of [1, 2, 5, 10]) if (m * pow >= want) return m * pow;
  return want;
}

/**
 * Whether this machine has been held back AT ALL since the deck started, and
 * when it last was.
 *
 * The row reports the current sample, and on a desktop that current sample is
 * `0%` essentially always — measured here: ninety seconds of AES-NI on twelve
 * cores never moved `CPU_Speed_Limit` off 100. Which is the truth, and which
 * reads as "this readout does not work" the second time somebody looks at it.
 * It was reported that way twice.
 *
 * So the note under the row gets to say the other thing. Nothing new is
 * sampled for it: the minute buckets already hold the peak of every minute, and
 * this is a scan of what is already there. A machine that has never been
 * throttled says so; one that was at lunchtime says when.
 */
function heldBackSoFar() {
  const key = `thermal:${THROTTLE_LABEL}`;
  let peak = 0;
  let lastMs = 0;
  for (const b of history) {
    const v = b.v[key];
    if (v == null || v <= 0) continue;
    if (v > peak) peak = v;
    lastMs = b.m * BUCKET_MS;
  }
  return peak > 0 ? { peak, lastMs } : null;
}

/** What /api/system/history answers, for one section. */
export function historySnapshot(group) {
  return { ok: true, sinceMs: historySince, stepMs: BUCKET_MS, series: seriesFor(group) };
}

/**
 * One reading at a time, and a machine that cannot answer is asked three times
 * rather than for the life of the process.
 *
 * `deps.read` is a seam rather than a convenience: the rule this function
 * exists for only fires on a machine that answers with nothing, and the machine
 * this was written on answers with something, so there is no other way to run
 * the branch that matters.
 */
export async function sampleThermal(deps = {}) {
  if (thermalInFlight) return;
  // Giving up is only ever for a machine that has NEVER answered — the Windows
  // desktop with no MSAcpi class, which would otherwise pay a PowerShell child
  // every ten seconds for the life of the process. A machine that answered once
  // has a sensor, and it keeps being asked however long the silence runs.
  if (!thermalEverAnswered && thermalMisses >= THERMAL_GIVE_UP) return;
  const read = deps.read ?? readThermal;
  thermalInFlight = true;
  try {
    const next = await read();
    if (next) { thermal = next; thermalMisses = 0; thermalEverAnswered = true; recordThermal(next); }
    else if (++thermalMisses >= THERMAL_GIVE_UP) {
      // DROP THE LAST READING. It used to be kept, and that is a number from
      // four minutes ago printed as though it were now — the one thing this
      // whole section refuses. A GPU driver unloads, a laptop is docked, a
      // sensor goes away: the honest answer is that the section stops being
      // drawn, not that it freezes.
      thermal = null;
      // But keep ASKING on a machine that has answered before. The cost
      // argument for giving up was only ever about a machine that can never
      // answer — a Windows desktop with no MSAcpi class paying a PowerShell
      // child every ten seconds forever. One that answered has a sensor, and a
      // silence is a gap rather than an absence.
      if (!thermalEverAnswered && thermalTimer) {
        clearInterval(thermalTimer);
        thermalTimer = null;
      }
      // The one machine where "nothing" is worth doing something about: an
      // Apple Silicon Mac has sensors and no way to read them, and the tool
      // that can is a 746 KB signed binary this deck can fetch. Started HERE
      // rather than at boot on purpose — the boot was just taught not to wait
      // for an install (#742) and nothing waits for this one either. One
      // attempt per process, and only after the give-up, so a machine that
      // does have a sensor never downloads anything. See macmon.mjs.
      if (!thermalEverAnswered && process.platform === "darwin") fetchMacmon(deps);
    }
  } catch { thermalMisses++; }
  finally { thermalInFlight = false; }
}

/**
 * Fetch macmon, then ask again — floating, on purpose.
 *
 * Not awaited by sampleThermal, which is itself not awaited by anything: this
 * is a download that may take a minute on a slow line, and the panel it serves
 * is optional. When it lands, the give-up above has already stopped the timer,
 * so the retry has to be made here rather than waited for.
 */
function fetchMacmon(deps = {}) {
  const boot = deps.bootstrap ?? (async () => (await import("./macmon.mjs")).bootstrapMacmon());
  Promise.resolve(boot()).then(r => {
    if (!r?.ok) return;
    // A sensor exists after all. Clear the give-up and let the timer run again,
    // which is what turns a downloaded binary into a section on screen without
    // the user restarting anything.
    thermalMisses = 0;
    if (!thermalTimer) {
      thermalTimer = setInterval(() => { sampleThermal(deps); }, THERMAL_INTERVAL_MS);
      // Unref'd like the one startSystemMetrics creates: a poll for an optional
      // panel must not be the reason a process refuses to exit.
      thermalTimer.unref?.();
    }
    sampleThermal(deps);
  }).catch(() => {});
}

async function sampleMemory() {
  if (memInFlight) return;
  memInFlight = true;
  try {
    const total = os.totalmem();
    const available = await readAvailable();
    // A poll that could not measure leaves the last reading standing and puts
    // nothing in the history (#789). Recording a guess here is worse than
    // recording nothing twice over: the meter would go red for 30 seconds, and
    // the bucket's Math.max would keep that peak on the chart for a day.
    // Swap below is a separate measurement and is still taken.
    if (available != null) {
      memory = {
        total,
        available,
        usedPct: Math.max(0, Math.min(100, Math.round(((total - available) / total) * 1000) / 10)),
      };
      record("mem:physical", memory.usedPct);
    }
    // Same 30s cadence as memory, and for the same reason: it moves in minutes
    // and costs a subprocess on two of the three platforms.
    swap = await readSwap();
    if (swap && swap.total > 0) record("mem:swap", Math.round((swap.used / swap.total) * 1000) / 10);
  } catch { /* keep the previous reading rather than blanking the meter */ }
  finally { memInFlight = false; }
}

function sampleCpu() {
  const per = corePercents();
  const pct = cpuPercent();
  if (pct == null) return;
  cores = per;
  cpuHistory.push(pct);
  while (cpuHistory.length > HISTORY) cpuHistory.shift();
  record("cpu:all", pct);
  if (per?.length) record("cpu:busiest", Math.max(...per));
  // Free — os.loadavg() reads a kernel value, no syscall worth the name — so it
  // rides the CPU tick rather than earning a timer. Windows returns [0,0,0],
  // which is not a reading and is not recorded as one.
  //
  // THE PLATFORM TEST IS THE WHOLE TEST. It used to be joined by
  // `load.some(n => n > 0)`, which reads as belt and braces and is not: Node
  // documents `os.loadavg()` as always [0,0,0] on Windows, so the platform test
  // alone already excludes every non-reading — and the extra clause could only
  // ever reject a reading that was REAL. `/proc/loadavg` on a genuinely quiet
  // Linux box says `0.00 0.00 0.00`, so "Queued work" recorded no points at all
  // for every quiet minute, and after the machine woke the chart read as though
  // the deck had been switched off through them.
  const load = os.loadavg();
  if (process.platform !== "win32") record("load:1m", Math.round(load[0] * 100) / 100);
}

// ── the network ────────────────────────────────────────────────────────────
//
// Three readings, taken at two very different costs (network-metrics.mjs says
// why these three). THROUGHPUT is two counters the kernel already keeps, so it
// rides its own five-second timer for the life of the process like CPU does,
// and its history is as complete as every other section's. LATENCY and ROUTE
// leave the machine or spawn a process, so they are taken only while somebody
// is looking: the panel is the only thing that polls /api/system, and a probe
// runs only within NET_ASKED_MS of that poll. A deck left open in a background
// tab all day makes no connection it was not asked for — the rule Claude FM's
// probe already follows ("makes no request until a page asks for one").

/** Counters on Linux are a file read; on macOS and Windows one short command.
 *  Five seconds is often enough to catch a burst and rare enough that the
 *  command costs nothing anybody could measure. */
const NET_INTERVAL_MS = 5_000;
/** How often the far end is asked, while the panel is open. */
const NET_PROBE_MS = 30_000;
/** How recently a poll must have come for the probe to run at all. */
const NET_ASKED_MS = 20_000;
/** A probe older than this is from before the panel was last closed, and is
 *  not reported as the present. */
const NET_STALE_MS = NET_PROBE_MS * 2 + 5_000;
/** What "how far is Claude" is measured against: the host every request Claude
 *  Code makes goes to, and the one quota.mjs already reads from. */
const API_HOST = "api.anthropic.com";
const API_PORT = 443;
const CONNECT_TIMEOUT_MS = 4_000;
/** Where the route is asked for when there is no API address to ask about. A
 *  routing-table lookup sends no packet, so this contacts nobody. */
const ROUTE_FALLBACK = "1.1.1.1";
/** Route changes kept for the history's markers. A path changes a handful of
 *  times a day; forty is several days of it. */
const ROUTE_LOG = 40;

let netTimer = null;
let netInFlight = false;
let prevNet = null;
let netRate = null;
let physical = null;
let physicalAt = 0;
let probeTimer = null;
/** Whether this process may reach out at all. Off unless the server says so:
 *  the suite starts this module in dozens of cases, and none of them should
 *  open a connection to Anthropic or spawn `ip` and `tailscale` to do it. */
let probeEnabled = false;
let probeInFlight = false;
let probeAt = 0;
let askedAt = 0;
/** Undefined until measured, null when the host could not be reached. */
let apiMs;
let route = null;
const routeLog = [];

/** Interfaces that are hardware, by the one test the kernel offers: a
 *  `device` link under /sys/class/net. Rechecked each minute, because a dock or
 *  a phone tethered over USB is a new wire. */
async function physicalInterfaces(root = "/sys/class/net") {
  try {
    const names = await readdir(root);
    const real = await Promise.all(names.map(n => access(`${root}/${n}/device`).then(() => n, () => null)));
    return new Set(real.filter(Boolean));
  } catch { return null; }
}

async function readNetCounters(platform = process.platform) {
  if (platform === "linux") {
    if (!physical || Date.now() - physicalAt > 60_000) {
      physical = await physicalInterfaces();
      physicalAt = Date.now();
    }
    try {
      const include = physical?.size ? name => physical.has(name) : name => name !== "lo";
      return parseProcNetDev(await readFile("/proc/net/dev", "utf8"), include);
    } catch { return null; }
  }
  if (platform === "darwin") return parseNetstatIbn(await run("netstat", ["-ibn"]));
  if (platform === "win32") return parseNetstatE(await run("netstat", ["-e"]));
  return null;
}

async function sampleNetwork() {
  if (netInFlight) return;
  netInFlight = true;
  try {
    const counters = await readNetCounters();
    if (!counters) return;
    const next = { rx: counters.rx, tx: counters.tx, at: Date.now() };
    const rate = rateBetween(prevNet, next);
    prevNet = next;
    if (!rate) return;
    netRate = rate;
    record("net:down", rate.down);
    record("net:up", rate.up);
  } finally { netInFlight = false; }
}

/** Milliseconds for a TCP handshake with `address`, or null. The connection
 *  is closed the moment it opens: nothing is sent, so this is a round trip and
 *  nothing else — no TLS, no request, nothing the far end has to answer. */
function connectMs(address, port = API_PORT, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise(resolve => {
    const t0 = performance.now();
    let done = false;
    const socket = net.connect({ host: address, port });
    const finish = ms => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ms);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once("connect", () => finish(Math.round(performance.now() - t0)));
    socket.once("error", () => finish(null));
  });
}

/** Which way traffic to `address` leaves, and — for a Tailscale exit node —
 *  through which machine and whether through a relay. */
async function readRoute(address, platform, runner) {
  let iface = null;
  if (platform === "linux") iface = routeIfaceLinux(await runner("ip", ["-o", "route", "get", address]));
  else if (platform === "darwin") iface = routeIfaceDarwin(await runner("route", ["-n", "get", address]));
  const kind = classifyRoute(iface);
  if (!kind || kind.kind === "direct") return kind;
  // Tailscale on a Mac is a utun like every other VPN there, so the question is
  // asked of any tunnel rather than only of one named tailscale0. A machine
  // without the CLI answers null and keeps the generic label.
  const exit = tailscaleExitFromStatus(await runner("tailscale", ["status", "--json"], 3_000));
  if (exit) return { kind: "tailscale-exit", iface, ...exit };
  return kind;
}

/**
 * One probe: how far the API is and which way the traffic to it goes.
 *
 * Guarded twice, because a GET can start it (see systemSnapshot) and a read's
 * cost must have a ceiling (#544): never two at once, and never more often than
 * half the probe interval however many tabs poll. `deps` is the seam the tests
 * use — nothing else here can be made to answer "unreachable" on demand.
 */
export async function probeNetwork(deps = {}) {
  const now = deps.now ?? Date.now;
  if (!probeEnabled && !deps.force) return;
  if (probeInFlight || now() - probeAt < NET_PROBE_MS / 2) return;
  if (!deps.force && now() - askedAt > NET_ASKED_MS) return;
  probeInFlight = true;
  probeAt = now();
  try {
    const platform = deps.platform ?? process.platform;
    const runner = deps.run ?? run;
    const measureApi = (deps.hasClaude ?? hasClaudeInstalled)();
    let address = null;
    if (measureApi) {
      try { address = (await (deps.lookup ?? lookup)(API_HOST)).address; } catch { address = null; }
      apiMs = address ? await (deps.connect ?? connectMs)(address) : null;
      if (apiMs != null) record("net:api", apiMs);
    }
    const next = await readRoute(address ?? ROUTE_FALLBACK, platform, runner);
    if (next) {
      const label = routeLabel(next);
      const prev = routeLog[routeLog.length - 1]?.label ?? null;
      if (prev !== label) {
        // `from` null is the first route this process saw — the state when it
        // started looking, not a change, and the chart draws no mark for it.
        routeLog.push({ t: now(), label, from: prev });
        while (routeLog.length > ROUTE_LOG) routeLog.shift();
      }
    }
    route = next;
  } finally { probeInFlight = false; }
}

/** What the panel shows for the network, or null before anything is known. */
function networkSnapshot(nowMs = Date.now()) {
  const fresh = nowMs - probeAt <= NET_STALE_MS;
  const api = fresh && apiMs !== undefined ? { host: API_HOST, ms: apiMs } : null;
  // `to` says what the route was asked about: the API itself when Claude Code
  // is here, the open internet otherwise — a split tunnel can send one and not
  // the other, and the panel should not claim more than was measured.
  const via = fresh && route && route.kind !== "direct"
    ? { ...route, label: routeLabel(route), to: apiMs !== undefined ? "claude" : "internet" }
    : null;
  if (!netRate && !api && !via) return null;
  return { down: netRate?.down ?? null, up: netRate?.up ?? null, api, route: via };
}

/**
 * Begin sampling. Idempotent, and every timer is unref'd so this can never be
 * the reason the process stays alive.
 *
 * `probe` is the network section's permission to leave the machine — latency to
 * the API and the route there. The server passes it; nothing else should.
 */
export function startSystemMetrics({ probe = false } = {}) {
  if (cpuTimer) return;
  probeEnabled = probe;
  prevTicks = readTicks();          // baseline, so the first tick has a delta
  prevCoreTicks = readCoreTicks();
  sampleMemory();
  historySince = Date.now();
  sampleThermal();
  sampleNetwork();
  cpuTimer = setInterval(sampleCpu, CPU_INTERVAL_MS);
  memTimer = setInterval(sampleMemory, MEM_INTERVAL_MS);
  thermalTimer = setInterval(sampleThermal, THERMAL_INTERVAL_MS);
  netTimer = setInterval(sampleNetwork, NET_INTERVAL_MS);
  if (probeEnabled) probeTimer = setInterval(() => { probeNetwork(); }, NET_PROBE_MS);
  cpuTimer.unref?.();
  memTimer.unref?.();
  thermalTimer.unref?.();
  netTimer.unref?.();
  probeTimer?.unref?.();
}

/**
 * Stop the three timers and reset every reading this module holds.
 *
 * THE SUITE'S, AND SAID PLAINLY (#798). Production starts the loop once at boot
 * and never stops it — the process ending is what stops it — so an audit
 * grepping for callers finds none, and the honest answer is not to delete this
 * but to name what it is for. It is a RESET as much as a stop: `history`,
 * `thermal`, the CPU baselines and the miss counters all go back to their
 * initial values, which is exactly what a case needs between two runs of
 * `startSystemMetrics` in one process, and what nothing else in this module
 * offers. Deleting it would leave the suite leaking intervals into the values
 * the next case reads.
 *
 * That is also why it is safe as a test-only export where the four removed in
 * #798 were not: there is no shipped counterpart for it to drift away from. The
 * state it clears IS the state every other assertion here reads.
 */
export function stopSystemMetrics() {
  if (cpuTimer) clearInterval(cpuTimer);
  if (memTimer) clearInterval(memTimer);
  if (thermalTimer) clearInterval(thermalTimer);
  if (netTimer) clearInterval(netTimer);
  if (probeTimer) clearInterval(probeTimer);
  cpuTimer = memTimer = thermalTimer = netTimer = probeTimer = null;
  probeEnabled = false;
  prevNet = null;
  netRate = null;
  physical = null;
  physicalAt = 0;
  probeAt = 0;
  askedAt = 0;
  apiMs = undefined;
  route = null;
  routeLog.length = 0;
  thermal = null;
  thermalMisses = 0;
  thermalEverAnswered = false;
  history.length = 0;
  historySince = 0;
  prevTicks = null;
  prevCoreTicks = null;
  cpuHistory.length = 0;
  memory = null;
  cores = null;
  swap = null;
  // The process list's Windows baseline and its last list, which go together.
  resetProcessList();
}

/**
 * What /api/system answers.
 *
 * `cpu` is null until two samples exist — the meter draws its track and no fill
 * rather than printing a zero it has not measured. `loadavg` is omitted on
 * Windows, where the API returns [0, 0, 0]: three zeros are not a reading, and
 * showing them as one would be the same lie in a different place.
 */
export function systemSnapshot() {
  const cpu = cpuHistory.length ? cpuHistory[cpuHistory.length - 1] : null;
  // The panel is the only poller, so a poll is the signal somebody is looking.
  // The first one after the panel was closed asks at once rather than waiting
  // out the probe timer, so the latency is on screen by the second poll; the
  // guards inside probeNetwork are what keep a busy poller from paying twice.
  const idle = Date.now() - askedAt > NET_ASKED_MS;
  askedAt = Date.now();
  if (idle && probeEnabled) void probeNetwork();
  const load = os.loadavg();
  // Platform alone, for the reason spelled out beside the `load:1m` record in
  // sampleCpu: Node's own contract makes the platform test sufficient, and the
  // `load.some(n => n > 0)` that used to join it here rejected nothing except a
  // real reading of zero. MachinePanel gates the whole section on `{loadavg &&
  // …}`, so an idle Linux box had the section disappear from under it.
  const hasLoad = process.platform !== "win32";
  return {
    ok: true,
    cpu,
    cpuHistory: [...cpuHistory],
    cores: os.cpus().length,
    memory,
    swap,
    perCore: cores,
    // Null on a machine that publishes nothing, and the panel draws no section
    // at all for it rather than an empty one.
    thermal: thermal ? { ...thermal, heldBack: heldBackSoFar() } : null,
    uptimeSec: Math.round(os.uptime()),
    platform: process.platform,
    loadavg: hasLoad ? load.map(n => Math.round(n * 100) / 100) : null,
    network: networkSnapshot(),
    intervalMs: CPU_INTERVAL_MS,
    sampledAt: Date.now(),
  };
}
