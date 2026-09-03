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
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";

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
 * The locale every child of this module is parsed in.
 *
 * Not a preference — a correctness requirement. Every command spawned here has
 * its output read by a regex, and every one of those regexes reads a number
 * with a `.` in it. `ps` and `sysctl` honour LC_NUMERIC, so on a machine set to
 * de_DE, fr_FR, ru_RU or pt_BR — comma is the decimal separator for most of
 * Europe and Latin America — the same commands print:
 *
 *     ps      1   0,2  0,0 /sbin/launchd
 *     sysctl  total = 8192,00M  used = 7189,75M  free = 1002,25M
 *
 * and the parsers matched nothing at all. Not partially: `parsePsProcesses`
 * `continue`s on every row, so the process panel was permanently empty, and
 * `swapFromSysctl` returned null, so the macOS swap meter was permanently
 * blank. Silently, with nothing in the log, on a machine where everything else
 * worked.
 *
 * Forcing the locale rather than teaching the parsers to read a comma is the
 * fix that scales: it makes the OUTPUT invariant, which is what every parser
 * here was written against and what every parser added later will assume. The
 * comma tolerance below is defence in depth for the case where a sandbox strips
 * the environment, not the primary answer.
 *
 * Meaningless on Windows, where the branches are PowerShell piped through
 * ConvertTo-Json and already culture-invariant — and harmless there for the
 * same reason.
 */
const C_LOCALE = { LC_ALL: "C", LANG: "C" };

/** Run a command and resolve its stdout, or null. Never rejects, never inherits
 *  a shell, never inherits a locale, and is killed rather than allowed to hang
 *  the sampler. */
function run(file, args, timeoutMs = 2_000) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(file, args, { windowsHide: true, env: { ...process.env, ...C_LOCALE } }); }
    catch { return resolve(null); }
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, timeoutMs);
    child.stdout?.on("data", d => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", code => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
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

async function readAvailable(platform = process.platform) {
  const total = os.totalmem();

  if (platform === "linux") {
    try {
      const parsed = availableFromMeminfo(await readFile("/proc/meminfo", "utf8"));
      if (parsed != null) return parsed;
    } catch { /* fall through to freemem */ }
    return os.freemem();
  }

  if (platform === "darwin") {
    const out = await run("vm_stat", []);
    const parsed = out ? availableFromVmStat(out, total) : null;
    return parsed ?? os.freemem();
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
 * How far down each ranking the payload reaches.
 *
 * The panel draws eight rows and decides their order on the client (#739), so
 * whichever column it ranks by has to be rankable from the rows it was handed.
 * `ps` returns a CPU-sorted list, and cutting that at eight and then sorting
 * those eight by memory produced a table that was honest about its rows and
 * wrong about its question: the machine's heaviest memory consumer need never
 * have appeared in a CPU top eight at all. Same shape as #492 — a list that is
 * never empty, never errors, and is not the rows being asked for.
 *
 * So what goes over the wire is a candidate SET rather than a ranking.
 * pickCandidates takes this many by CPU and this many by memory and sends the
 * union, which makes the true top eight of either column present by
 * construction. Wide enough that drawing more rows later cannot quietly
 * re-break that, small enough that the whole thing stays a few kilobytes of
 * four-field rows, fetched only while the panel is open.
 */
const CANDIDATE_N = 40;

/**
 * The rows worth sending, given that the ordering happens on the client.
 *
 * A union of two rankings, deduplicated by object identity rather than by pid:
 * parseGetProcessJson falls back to pid 0 for a row whose `Id` did not parse,
 * more than one row can do that, and a pid-keyed set would drop real processes
 * in order to deduplicate a placeholder.
 *
 * An unknown CPU sorts last here, for the same reason the column prints a dash
 * rather than a zero — a Windows first reading has no percentage yet, and
 * unknown is not idle and is not busiest either. Such a row still reaches the
 * payload through the memory half, which is the reading that does exist on that
 * pass.
 */
export function pickCandidates(rows, limit = CANDIDATE_N) {
  const byCpu = [...rows].sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || b.mem - a.mem);
  const byMem = [...rows].sort((a, b) => b.mem - a.mem || (b.cpu ?? -1) - (a.cpu ?? -1));
  const out = byCpu.slice(0, limit);
  const seen = new Set(out);
  for (const r of byMem.slice(0, limit)) if (!seen.has(r)) out.push(r);
  return out;
}

/**
 * The `ps` argument list, which is not the same list on both Unixes.
 *
 * `-r` was shipped for both and means two different things. On BSD it sorts the
 * output by current CPU, which is the ordering the panel is built around. On
 * Linux procps it is *"restrict the selection to only running processes"* — a
 * filter on state `R`, applied in PID order. A Linux deck therefore listed
 * whatever happened to be on a CPU at the instant of the sample: usually one or
 * two rows on an idle machine, and never the busiest ones, since a process
 * pinning a core while blocked on I/O sits in `D` and one merely burning CPU
 * over time is normally caught in `S`. Nothing errored and nothing was empty,
 * which is why it survived two releases (#492).
 *
 * `--sort=-pcpu` is procps' own way to say what `-r` says on BSD. The column
 * order is deliberately identical on both so one parser reads both, and `comm`
 * stays last so a name containing a space survives intact.
 *
 * Keyed on linux rather than on darwin, because linux is the platform that is
 * wrong: `-r` sorts on every BSD, while `--sort` is a procps long option that
 * would make FreeBSD and OpenBSD exit non-zero. This way the only branch that
 * changes is the one that was broken.
 *
 * Pure and exported for the same reason the parsers are: the command
 * construction is the part that differs per platform, and a fixture cannot
 * prove which flags were passed to produce it.
 */
export function psArgs(platform = process.platform) {
  // procps: an explicit CPU sort, and `comm` in `-o` is what keeps argv — and
  // any prompt or token on it — out of the panel. Linux `comm` comes from
  // /proc/<pid>/comm and is capped at 15 characters.
  if (platform === "linux") return ["-eo", "pid,pcpu,pmem,comm", "--sort=-pcpu"];
  // BSD/macOS: `-c` prints the accounting name rather than the argument vector,
  // and `-r` sorts by current CPU.
  return ["-Aceo", "pid,pcpu,pmem,comm", "-r"];
}

/**
 * Rows out of `ps -o pid,pcpu,pmem,comm`, in that column order on both Unixes —
 * see psArgs for how each platform is asked for it.
 *
 * `pcpu` is a percentage of ONE core on both, so a multi-threaded process runs
 * past 100 and that is information rather than an error: 157 is one and a half
 * cores. cpuFromDeltas puts the Windows column on this same scale.
 *
 * There is no row limit in the query because neither `ps` has one and `run`
 * deliberately never inherits a shell, so there is no `| head` to pipe into.
 *
 * And there is none by default here either, which is a change: the loop used to
 * stop at eight, and stopping at eight is what made the memory ranking a lie
 * once the panel could ask for one (#739). Selection belongs to pickCandidates,
 * which cannot rank a column out of rows this function has already thrown away.
 * The cost is a regex over every line of `ps` — a few hundred on a busy
 * machine, once every four seconds and only while the panel is open — against a
 * string that has already been read and allocated. `limit` stays for callers
 * that do want a truncation, which is now only the tests.
 */
export function parsePsProcesses(text, limit = Infinity) {
  const lines = String(text ?? "").trim().split("\n");
  const out = [];
  for (const line of lines.slice(1)) {           // drop the header row
    // Both separators, for the reason swapFromSysctl gives: C_LOCALE is the
    // fix, and this is what keeps a stripped environment from emptying the
    // panel. `%CPU` and `%MEM` are percentages printed with %.1f, so a comma in
    // either can only be the decimal point.
    const m = /^\s*(\d+)\s+([\d.,]+)\s+([\d.,]+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const num = v => Number(v.replace(",", "."));
    out.push({ pid: Number(m[1]), cpu: num(m[2]), mem: num(m[3]), name: m[4] });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Rows out of `Get-Process`.
 *
 * NOT `Win32_PerfFormattedData_PerfProc_Process`, which is what this used and
 * which is not a class you may assume exists. It is published by perflib, and
 * perflib is deregistered often enough to matter — a corporate image, a bad
 * in-place upgrade, a half-run `lodctr`. On a machine reported from the field
 * the class was simply absent (`Get-CimInstance: Invalid class`), and `typeperf`
 * failed identically, which places the fault below WMI rather than in it. WMI
 * was only mirroring what perflib had stopped publishing.
 *
 * `Get-Process` reads through NtQuerySystemInformation instead, so it depends on
 * nothing that can be unregistered. The cost is that its `CPU` is total
 * processor SECONDS since the process started, not a rate — so a percentage has
 * to be derived from two readings, exactly the way the machine-wide figure is
 * already derived from two tick samples. Reliability is worth one extra poll:
 * an instant number from a class that may not exist is worth nothing at all.
 */
export function parseGetProcessJson(json, totalMem) {
  let rows;
  try { rows = typeof json === "string" ? JSON.parse(json) : json; }
  catch { return []; }
  if (!rows) return [];
  if (!Array.isArray(rows)) rows = [rows];
  return rows
    .filter(r => r && r.ProcessName)
    .map(r => ({
      pid: Number(r.Id) || 0,
      name: String(r.ProcessName),
      // Null rather than 0 when the process denies the read: a system process
      // we cannot query has an unknown CPU time, and calling that zero would
      // rank it as idle.
      cpuSec: typeof r.CPU === "number" ? r.CPU : null,
      mem: totalMem > 0
        ? Math.round((Number(r.WorkingSetPrivate) || 0) / totalMem * 1000) / 10
        : 0,
    }));
}

/**
 * Turn two `Get-Process` readings into a percentage per process.
 *
 * `prev` maps pid to the cpuSec of the previous reading. A pid absent from it —
 * a process that started since — has no delta and reports null rather than a
 * number invented from its whole lifetime, which would rank a freshly spawned
 * compiler as though it had been burning a core since boot.
 *
 * Per core, NOT per machine, because that is what the column beside it means:
 * `ps -o pcpu` is a percentage of one core on both Unixes and is reported
 * unmodified, so a row reading 157 there is a process using one and a half
 * cores. This used to divide by the core count and clamp to 100 on the reasoning
 * that Unix reported 0-100 — it does not, and never did, so the normalisation
 * corrected a scale that already matched and introduced the mismatch it was
 * written to prevent: on a 12-core machine six busy cores read 600 on macOS and
 * 50 on Windows (#493). One CPU-second burned per wall-second is 100 here, on
 * every platform.
 *
 * Core count is deliberately not a parameter any more. The aggregate meter's
 * 0-100 convention (see cpuPercent) is a different question with a different
 * answer, and the only way this drifts back is if a core count is in reach.
 */
export function cpuFromDeltas(rows, prev, elapsedMs, limit = Infinity) {
  const secs = elapsedMs / 1000;
  const out = rows.map(r => {
    const before = prev instanceof Map ? prev.get(r.pid) : undefined;
    let cpu = null;
    if (r.cpuSec != null && before != null && secs > 0) {
      const d = r.cpuSec - before;
      // A counter that went backwards means the pid was reused by a different
      // process; report nothing rather than a negative or a wild number.
      if (d >= 0) cpu = Math.round((d / secs) * 1000) / 10;
    }
    return { pid: r.pid, cpu, mem: r.mem, name: r.name };
  });
  // Until the second reading lands there is no CPU to sort on, so the list is
  // ordered by memory — which is a real answer to "what is this machine doing",
  // not a placeholder.
  const haveCpu = out.some(r => r.cpu != null);
  out.sort(haveCpu
    ? (a, b) => (b.cpu ?? -1) - (a.cpu ?? -1)
    : (a, b) => b.mem - a.mem);
  return out.slice(0, limit);
}

/** Previous Windows reading, so the next one can be a rate. Cleared with the
 *  rest of the sampler state. */
let prevProcCpu = null;
let prevProcAt = 0;

/** The run producing the next list, and the last one that finished. */
let procInFlight = null;
let procLast = null; // { at, procs }

/**
 * How old a finished reading may be and still answer a caller.
 *
 * Well under SystemMeter's PROC_POLL_MS of 4000, so the panel that this exists
 * for never once gets a cached list; long enough that a second tab, a second
 * browser, or anything else arriving between two of those polls is handed the
 * list the first tab is already looking at rather than starting its own child.
 */
const PROC_MIN_GAP_MS = 1_500;

/**
 * The process list, on demand only — never on the ambient timer, and never more
 * than one child at a time.
 *
 * #544: /api/system/processes is a GET with no cache, no dedupe and no
 * throttle, so the number of `powershell.exe Get-Process` children — about six
 * seconds each — was whatever the caller asked for. That is the cheap half of
 * the problem. The expensive half is that concurrent readers also overwrote
 * each other's baseline: cpuFromDeltas needs the PREVIOUS reading's cpuSec per
 * pid, prevProcCpu/prevProcAt are one shared pair, and two readers each stored
 * theirs over the other's, so the CPU column came back computed against a
 * baseline that belonged to somebody else's reading. That is a wrong number on
 * screen, not merely wasted work, and it needed no attacker at all: one
 * Get-Process takes longer than the panel's four-second poll, so a single tab
 * on Windows already overlapped itself.
 *
 * One in-flight run fixes both, because one reader means one baseline. Callers
 * that arrive while a run is going share its promise; callers that arrive just
 * after one finished are served that reading.
 */
export async function readProcesses(platform = process.platform) {
  const now = Date.now();
  if (procLast && now - procLast.at < PROC_MIN_GAP_MS) return procLast.procs;
  if (procInFlight) return procInFlight;
  // Only a real reading is remembered. Every failure inside readProcessesNow —
  // a spawn that never started, a non-zero exit, the timeout — resolves to an
  // empty array, and no machine has nothing running on it, so an empty list is
  // a failure by construction. Serving one for the next 1.5s would turn a
  // single hiccup into a blank panel that outlives it; the next caller retries
  // instead. The in-flight share still applies, so a burst arriving during a
  // failing read is one failing child, not a burst of them.
  procInFlight = readProcessesNow(platform)
    .then(procs => {
      if (procs.length) procLast = { at: Date.now(), procs };
      return procs;
    })
    .finally(() => { procInFlight = null; });
  return procInFlight;
}

async function readProcessesNow(platform) {
  if (platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-Process | Select-Object Id,ProcessName,CPU,@{n='WorkingSetPrivate';e={$_.PrivateMemorySize64}} | ConvertTo-Json -Compress",
    ], 6_000);
    if (!out) return [];
    const rows = parseGetProcessJson(out.trim(), os.totalmem());
    const now = Date.now();
    const result = pickCandidates(cpuFromDeltas(rows, prevProcCpu, now - prevProcAt));
    prevProcCpu = new Map(rows.filter(r => r.cpuSec != null).map(r => [r.pid, r.cpuSec]));
    prevProcAt = now;
    return result;
  }
  const out = await run("ps", psArgs(platform), 4_000);
  return out ? pickCandidates(parsePsProcesses(out)) : [];
}

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
//   Windows  MSAcpi_ThermalZoneTemperature in root/wmi, CurrentTemperature in
//            TENTHS OF A KELVIN. Published by the firmware and genuinely absent
//            on a large share of desktop boards — the same lesson
//            parseGetProcessJson learned about perflib, which is why absent is
//            ordinary here rather than an error.
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
      out.push({
        chip,
        label: await read(`${base}/${m[1]}_label`),
        celsius,
        // The hardware's own bands where it has them. `max` is where the chip
        // says it is unhappy and `crit` is where it says it will act.
        warnAt: celsiusFromMilli(await read(`${base}/${m[1]}_max`)) ?? WARN_C,
        critAt: celsiusFromMilli(await read(`${base}/${m[1]}_crit`)) ?? CRIT_C,
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
 * Windows thermal zones out of MSAcpi_ThermalZoneTemperature.
 *
 * CurrentTemperature is in tenths of a Kelvin, which is the single detail this
 * whole branch turns on: reading it as anything else gives a number that is
 * plausible-looking and wrong.
 *
 * The zone is labelled "Thermal zone" when there is one and by its own name
 * when there are several, because ACPI does not say which zone is the CPU and
 * this module does not guess. `TZ00` is not a friendly label; it is an honest
 * one, and it only appears on a machine that has more than one.
 */
export function tempFromMsAcpiJson(json) {
  let rows;
  try { rows = typeof json === "string" ? JSON.parse(json) : json; }
  catch { return []; }
  if (!rows) return [];
  if (!Array.isArray(rows)) rows = [rows];
  const found = [];
  for (const r of rows) {
    const k = Number(r?.CurrentTemperature);
    if (!Number.isFinite(k)) continue;
    const celsius = Math.round(k / 10 - 273.15);
    if (!plausible(celsius)) continue;
    const name = String(r?.InstanceName ?? "").split("\\").pop().replace(/_\d+$/, "");
    found.push({ label: name || "Thermal zone", celsius, warnAt: WARN_C, critAt: CRIT_C });
  }
  if (found.length === 1) found[0].label = "Thermal zone";
  return found.slice(0, 2);
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
    const celsius = [];
    const c = gpu ? gpuFromIoreg(gpu) : null;
    if (c != null) celsius.push({ label: "GPU", celsius: c, warnAt: WARN_C, critAt: CRIT_C });
    const throttle = therm ? throttleFromPmset(therm) : null;
    return celsius.length || throttle ? { celsius, throttle } : null;
  }

  if (platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object InstanceName,CurrentTemperature | ConvertTo-Json -Compress",
    ], 6_000);
    if (!out) return null;
    const celsius = tempFromMsAcpiJson(out.trim());
    return celsius.length ? { celsius, throttle: null } : null;
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
      label,
      unit: label === THROTTLE_LABEL ? "%" : "C",
      top: 100,
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
    // SystemMeter: a CPU at 90% is the machine doing the work you asked for. An
    // indicator that alarms during the normal case teaches you to stop reading
    // it.
    return [
      { label: "All cores", unit: "%", top: 100, warnAt: null, critAt: null, points: at("cpu:all") },
      { label: "Busiest core", unit: "%", top: 100, warnAt: null, critAt: null, points: at("cpu:busiest") },
    ].filter(s => s.points.length);
  }

  if (group === "memory") {
    const swapLabel = process.platform === "win32" ? "Commit" : "Swap";
    return [
      { label: "Physical", unit: "%", top: 100, warnAt: 90, critAt: 100, points: at("mem:physical") },
      { label: swapLabel, unit: "%", top: 100, warnAt: 90, critAt: 100, points: at("mem:swap") },
    ].filter(s => s.points.length);
  }

  if (group === "load") {
    // One series, not three. 1m, 5m and 15m are three views of one number —
    // the longer two are the short one smoothed — so charting the 1m over an
    // hour says everything the other two would, at the resolution they hide.
    const points = at("load:1m");
    if (!points.length) return [];
    return [{
      label: "Queued work",
      unit: "",
      top: loadTop(points, coreCount),
      // Where the queue exceeds the cores there are to run it, which is the one
      // number the section's own note already draws the line at.
      warnAt: coreCount,
      critAt: null,
      points,
    }];
  }

  return [];
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
    }
  } catch { thermalMisses++; }
  finally { thermalInFlight = false; }
}

async function sampleMemory() {
  if (memInFlight) return;
  memInFlight = true;
  try {
    const total = os.totalmem();
    const available = await readAvailable();
    memory = {
      total,
      available,
      usedPct: Math.max(0, Math.min(100, Math.round(((total - available) / total) * 1000) / 10)),
    };
    // Same 30s cadence as memory, and for the same reason: it moves in minutes
    // and costs a subprocess on two of the three platforms.
    swap = await readSwap();
    record("mem:physical", memory.usedPct);
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
  const load = os.loadavg();
  if (process.platform !== "win32" && load.some(n => n > 0)) record("load:1m", Math.round(load[0] * 100) / 100);
}

/**
 * Begin sampling. Idempotent, and both timers are unref'd so this can never be
 * the reason the process stays alive.
 */
export function startSystemMetrics() {
  if (cpuTimer) return;
  prevTicks = readTicks();          // baseline, so the first tick has a delta
  prevCoreTicks = readCoreTicks();
  sampleMemory();
  historySince = Date.now();
  sampleThermal();
  cpuTimer = setInterval(sampleCpu, CPU_INTERVAL_MS);
  memTimer = setInterval(sampleMemory, MEM_INTERVAL_MS);
  thermalTimer = setInterval(sampleThermal, THERMAL_INTERVAL_MS);
  cpuTimer.unref?.();
  memTimer.unref?.();
  thermalTimer.unref?.();
}

export function stopSystemMetrics() {
  if (cpuTimer) clearInterval(cpuTimer);
  if (memTimer) clearInterval(memTimer);
  if (thermalTimer) clearInterval(thermalTimer);
  cpuTimer = memTimer = thermalTimer = null;
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
  prevProcCpu = null;
  prevProcAt = 0;
  // The last list goes with the baseline it was computed against. A sampler
  // that stopped and started again must not answer the first caller with a
  // reading from before the stop.
  procLast = null;
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
  const load = os.loadavg();
  const hasLoad = process.platform !== "win32" && load.some(n => n > 0);
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
    thermal,
    uptimeSec: Math.round(os.uptime()),
    platform: process.platform,
    loadavg: hasLoad ? load.map(n => Math.round(n * 100) / 100) : null,
    intervalMs: CPU_INTERVAL_MS,
    sampledAt: Date.now(),
  };
}
