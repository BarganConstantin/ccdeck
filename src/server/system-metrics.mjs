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
 * The locale every child of this module runs in — and only the part of it that
 * had to be forced.
 *
 * Not a preference. Every command spawned here has its output read by a regex
 * and every one of those regexes reads a number with a `.` in it. `ps` and
 * `sysctl` honour LC_NUMERIC, so on a machine set to de_DE, fr_FR, ru_RU or
 * pt_BR — comma is the decimal separator for most of Europe and Latin America —
 * the same commands print:
 *
 *     ps      1   0,2  0,0 /sbin/launchd
 *     sysctl  total = 8192,00M  used = 7189,75M  free = 1002,25M
 *
 * and the parsers matched nothing at all. Not partially: `parsePsProcesses`
 * `continue`s on every row, so the process panel was permanently empty, and
 * `swapFromSysctl` returned null, so the macOS swap meter was permanently
 * blank. Silently, on a machine where everything else worked.
 *
 * THIS USED TO FORCE THE WHOLE LOCALE, and forcing the whole locale also forces
 * the CHARACTER SET. Under `LC_ALL=C`, `ps` escapes every byte it cannot render
 * as ASCII, so an application named in Cyrillic came back as
 *
 *     M-PM-/M-PM-=M-PM-4M-PM-5M-PM-:M-QM^A M-PM^\M-QM^CM-PM-7M-QM^KM-PM-:M-PM-0
 *
 * where the name is `Яндекс Музыка`. The panel truncates at 164px so it read as
 * noise; the process list added in #738 has room for all ninety-one characters
 * of it, which is how it was found. Every reader with a non-Latin application
 * on their machine was being shown that.
 *
 * So only the numeric is forced now, and the character set is inherited. All
 * four measured on this machine:
 *
 *     LC_ALL=C                        name mangled,  0.7
 *     LC_ALL="" LC_NUMERIC=C          Яндекс Музыка, 0.7
 *     LANG=de_DE + our override       Яндекс Музыка, 0.7   ← the comma case
 *     LC_ALL=de_DE + our empty LC_ALL                0.7   ← a hostile env
 *
 * The empty `LC_ALL` is doing real work in the last of those: POSIX ignores an
 * empty LC_ALL, so clearing it is what stops a user's own LC_ALL from
 * outranking the LC_NUMERIC below. Setting LC_NUMERIC alone would not survive
 * it.
 *
 * A reader whose own locale is C still sees the escaped form — but so does
 * their terminal, so that is their machine being consistent rather than this
 * module choosing for them.
 *
 * Meaningless on Windows, where the branches are PowerShell piped through
 * ConvertTo-Json and already culture-invariant — and harmless there for the
 * same reason. The comma tolerance in the parsers stays as defence in depth for
 * a sandbox that strips the environment, not as the primary answer.
 */
const C_LOCALE = { LC_ALL: "", LC_NUMERIC: "C" };

/** Run a command and resolve its stdout, or null. Never rejects, never inherits
 *  a shell, never inherits a locale, and is killed rather than allowed to hang
 *  the sampler. */
function run(file, args, timeoutMs = 2_000) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(file, args, {
        windowsHide: true,
        env: { ...process.env, ...C_LOCALE },
        // stderr is PIPED AND NEVER READ, which is a deadlock waiting for a
        // chatty child: a pipe nobody drains fills at 64 KB and the writer
        // blocks there until this function's own deadline kills it. Nothing
        // here has ever looked at it — `run` resolves on stdout or null — so
        // the honest arrangement is not to open it.
        stdio: ["ignore", "pipe", "ignore"],
      });
    }
    catch { return resolve(null); }
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, timeoutMs);
    // DECODE THE STREAM, NOT EACH CHUNK. `out += d` on a Buffer calls toString()
    // per chunk, and a chunk boundary falls wherever the pipe happened to break
    // — measured on `ps` output as three chunks of 8192/8192/5718 — so a
    // multi-byte character split across two of them became two replacement
    // characters. An application called `Яндекс Музыка` in the process list
    // rendered as `Ян��екс Музыка`. setEncoding carries the partial sequence
    // across the boundary, which is the whole reason it exists.
    child.stdout?.setEncoding?.("utf8");
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
  // SEVEN FIELDS, THE SAME SEVEN ON BOTH, and `args` last because it is the one
  // that contains spaces. `etime` is `[[DD-]HH:]MM:SS` on both and `rss` is
  // kibibytes on both, so one parser still reads both — which is why the thread
  // count is fetched separately (readThreads) rather than as an eighth column:
  // procps spells it `nlwp` and BSD has no keyword for it at all, and one
  // divergent column would have cost the shared parser this list is built on.
  //
  // `args` REPLACES `comm`, which is a change with a cost, and redactCommand is
  // the payment. `comm` was chosen so that argv — and any token on it — could
  // not reach the panel; that made every `node`, `dotnet` and `python` on the
  // machine indistinguishable from every other one, which is most of what a
  // reader opens this list to tell apart. The argument vector is redacted and
  // capped before it leaves this module, and the short name is derived from
  // argv[0] rather than asked for a second time.
  if (platform === "linux") return ["-eo", "pid,pcpu,pmem,rss,etime,user:24,comm", "--sort=-pcpu"];
  // BSD/macOS: `-c` prints the accounting name rather than the argument vector,
  // and `-r` sorts by current CPU.
  return ["-Aceo", "pid,pcpu,pmem,rss,etime,user,comm", "-r"];
}

/**
 * The second call: how many threads each candidate has, and what it was
 * actually launched with.
 *
 * Two facts, one child, and it has to be a second call for two separate
 * reasons. The thread count has no shared spelling — procps says `nlwp` and BSD
 * has no keyword for it at all, only the `-M` listing — so an eighth column
 * would have cost the single parser psArgs is built around. And `args` cannot
 * sit beside `comm`: only one field in an `-o` list may contain spaces, because
 * only the last one is unambiguous.
 *
 * Scoped to the candidate pids rather than to the machine, which is what makes
 * it cheap: measured here, `ps -M -p` over forty pids is 0.15s against 0.10s
 * for the whole-machine call it follows. `top -stats th,ports` would have
 * answered both in one go and takes 4.25s on an idle machine — see readThreads'
 * note on why ports is not a column at all.
 */
export function psDetailArgs(pids, platform = process.platform) {
  const list = pids.join(",");
  // procps: `nlwp` is free here, and `args` is last as ever.
  if (platform === "linux") return ["-o", "pid,nlwp,args", "-p", list];
  // BSD: `-M` lists each process followed by one line per thread, and the
  // process line carries the untruncated argument vector. Counting the lines is
  // the thread count; the process line is the argv. One child, both answers.
  return ["-M", "-p", list];
}

/**
 * `ps -M` output: a process line, then one line per thread, per pid.
 *
 * The two kinds are told apart by column one. A process line begins with the
 * owning user and a thread line begins with spaces — `ps` leaves USER, TT and
 * COMMAND blank on a thread because a thread has none of its own. So the count
 * is "lines mentioning this pid, less the one that named it", and the argv is
 * whatever the named line ended with.
 *
 * A kernel thread and an exiting process print a bracketed command
 * (`[kworker/0:1]`, `(ccusage)`); that is `ps` reporting a state and it is left
 * exactly as it came.
 */
export function parsePsThreadsBsd(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    // USER PID TT %CPU STAT PRI STIME UTIME COMMAND — eight fixed fields, and
    // COMMAND is everything after them.
    const proc = /^(\S+)\s+(\d+)\s+\S+\s+[\d.,]+\s+\S+\s+\S+\s+\S+\s+\S+\s*(.*)$/.exec(line);
    if (proc) {
      if (proc[1] === "USER") continue;            // the header
      const pid = Number(proc[2]);
      const row = out.get(pid) ?? { threads: 0, cmd: "" };
      row.cmd = proc[3].trim();
      out.set(pid, row);
      continue;
    }
    const thread = /^\s+(\d+)\s/.exec(line);
    if (!thread) continue;
    const pid = Number(thread[1]);
    const row = out.get(pid) ?? { threads: 0, cmd: "" };
    row.threads += 1;
    out.set(pid, row);
  }
  return out;
}

/** `ps -o pid,nlwp,args` output, which is two numbers and then the rest. */
export function parsePsThreadsProcps(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!m) continue;
    out.set(Number(m[1]), { threads: Number(m[2]), cmd: m[3].trim() });
  }
  return out;
}

/**
 * The pieces of a `ps` ELAPSED field, which is `[[DD-]HH:]MM:SS` on both Unixes.
 *
 * Returns seconds, or null for anything that is not that shape — a header line
 * that slipped through, a locale doing something unexpected. Null prints as a
 * dash rather than as "0s", because a process that has been up for no time and
 * a process whose uptime could not be read are different facts.
 */
export function elapsedSeconds(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const [, d, h, min, sec] = m;
  return (Number(d ?? 0) * 86400) + (Number(h ?? 0) * 3600) + (Number(min) * 60) + Number(sec);
}

/**
 * An argument vector with the parts that must not be looked at taken out, and
 * the parts nobody reads cut off.
 *
 * THIS IS A BLOCKLIST AND A BLOCKLIST LEAKS. It is written down here rather
 * than implied, because the alternative — `comm`, which is what this replaced —
 * leaked nothing and told the reader nothing either. What it removes is the
 * shapes a secret actually takes on a command line; what it cannot remove is a
 * secret that looks like an ordinary word, and no rule here pretends otherwise.
 *
 * The cap is the other half, and it is not a nicety. Measured on this machine:
 * one Chrome helper's argv is 906 characters of `--field-trial-handle`,
 * base64 `--gpu-preferences` and shared-memory handles. Forty of those is 36 KB
 * on the wire every four seconds to render a column nobody can read. What
 * identifies a process is its first few arguments — `ng serve admin-portal
 * --port 44440` — and that is what fits.
 */
export const CMD_MAX = 180;

const SECRET_FLAG =
  /(-{1,2}[\w.-]*(?:token|password|passwd|secret|api[-_]?key|apikey|auth|credential|bearer|cookie|session[-_]?id|private[-_]?key)[\w.-]*)(=|\s+)(\S+)/gi;
// The shapes that are a secret on their own, with no flag in front of them.
const BARE_SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;
// user:password@host, in any URL. The password goes; the rest is a location.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi;

export function redactCommand(argv, home = "") {
  let s = String(argv ?? "").trim();
  if (!s) return "";
  s = s.replace(SECRET_FLAG, (_, flag, sep, value) => `${flag}${sep === "=" ? "=" : " "}\u2022\u2022\u2022`);
  s = s.replace(URL_CREDENTIALS, "$1:\u2022\u2022\u2022@");
  s = s.replace(BARE_SECRET, "\u2022\u2022\u2022");
  // `~` last, so a home path inside a redacted value is already gone. Only a
  // whole path segment, so a user called `con` cannot rewrite the middle of an
  // unrelated word.
  if (home && home.length > 1) s = s.split(home + "/").join("~/").split(home + " ").join("~ ");
  if (s.length > CMD_MAX) s = s.slice(0, CMD_MAX - 1).trimEnd() + "\u2026";
  return s;
}

/**
 * The ARGUMENTS, with the executable that carries them taken off the front.
 *
 * The name column already says `Google Chrome Helper`; repeating
 * `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome
 * Framework.framework/Versions/152.0.7977.76/Helpers/Google Chrome
 * Helper.app/Contents/MacOS/Google Chrome Helper` beside it spends the entire
 * 180-character budget on a path the reader can already see the end of, and
 * cuts off `--type=renderer`, which is the part that says WHICH helper this is.
 *
 * argv[0] cannot be found by splitting on whitespace — on macOS the executable
 * path routinely contains spaces, and `/Applications/Google Chrome.app/…` would
 * be cut at "Google". The name from the first `ps` call is what resolves it:
 * argv begins with a path whose last segment IS that name.
 *
 * "Last segment" is the whole of the rule, and the first version of this got it
 * wrong in a way only the render showed. A plain `indexOf` cuts at the FIRST
 * occurrence, and a macOS bundle contains the name twice — `…/Helpers/Google
 * Chrome Helper.app/Contents/MacOS/Google Chrome Helper` — so every browser row
 * read `.app/Contents/MacOS/Google Chrome Helper --type=gpu-process`, having
 * spent the budget on the half of the path it was supposed to remove. A plain
 * `lastIndexOf` is wrong the other way: `node /srv/node_modules/x` would cut
 * inside `node_modules`.
 *
 * So: the first occurrence that a path segment actually ends at — preceded by a
 * separator or nothing, followed by whitespace or nothing. `node /srv/app.js
 * --port 3000` leaves `/srv/app.js --port 3000`; `/usr/local/bin/dotnet exec
 * --runtimeconfig …` leaves `exec --runtimeconfig …`, which is what identifies
 * it.
 *
 * When the name is not in argv at all — a process that rewrote argv[0], or a
 * `comm` that Linux truncated at 15 characters — the first whitespace token
 * goes only if it looks like a path, because dropping the first word of
 * something already short would take the only word there was.
 */
export function commandTail(argv, name) {
  const s = String(argv ?? "").trim();
  if (!s) return "";
  const n = String(name ?? "").trim();
  if (n) {
    for (let at = s.indexOf(n); at >= 0; at = s.indexOf(n, at + 1)) {
      const before = at === 0 ? "" : s[at - 1];
      const after = s[at + n.length] ?? "";
      if ((before === "" || before === "/" || before === "\\" || /\s/.test(before))
        && (after === "" || /\s/.test(after))) {
        return s.slice(at + n.length).trim();
      }
    }
  }
  const first = s.split(/\s+/)[0] ?? "";
  return first.includes("/") ? s.slice(first.length).trim() : s;
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
    //
    // Seven fields, and only the last of them may contain a space — which is
    // why `comm` is last and why `args` is not here at all (psDetailArgs).
    // `rss` is an integer of kibibytes, `etime` and `user` cannot contain
    // whitespace, so the shape stays unambiguous with three more columns in it.
    const m = /^\s*(\d+)\s+([\d.,]+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const num = v => Number(v.replace(",", "."));
    out.push({
      pid: Number(m[1]),
      cpu: num(m[2]),
      mem: num(m[3]),
      // RSS IS NOT WHAT ACTIVITY MONITOR CALLS MEMORY, and on macOS it is not
      // close. Measured here against `top`'s MEM on the same processes at the
      // same moment: `dotnet` 37 MB against 534, `rider` 1300 against 3833,
      // one Brave renderer 240 against 153 — ratios from 0.02 to 1.57. The
      // column Activity Monitor draws is `phys_footprint`, which no
      // unprivileged one-shot command reports; `top -stats mem` has it and
      // takes 4.25 seconds on an idle machine, against 0.10 for this call.
      // So the figure is resident set size, the panel says so, and it is the
      // same measurement on all three platforms rather than a different one
      // per OS. On Linux and Windows it is also the figure their own tools
      // show.
      rssBytes: Number(m[4]) * 1024,
      uptimeSec: elapsedSeconds(m[5]),
      user: m[6],
      name: m[7],
    });
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
      // The same three optional fields the POSIX branch attaches, so one client
      // shape covers both. Absent rather than zero when the value did not come
      // back: `StartTime` throws for a process this session may not open, and
      // `Threads.Count` is undefined on a row that failed to project.
      ...(Number.isFinite(Number(r.Threads)) && Number(r.Threads) > 0 ? { threads: Number(r.Threads) } : {}),
      ...(Number.isFinite(Number(r.StartedAt)) ? { uptimeSec: Number(r.StartedAt) } : {}),
      rssBytes: Number(r.WorkingSet) || 0,
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
let procLast = null; // { at, read: { procs, total }, detail }
let procInFlightDetail = false;

/**
 * How old a finished reading may be and still answer a caller.
 *
 * Well under MachinePanel's PROC_POLL_MS of 4000, so the panel that this exists
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
export async function readProcesses(platform = process.platform, detail = false) {
  const now = Date.now();
  // A cached reading serves a caller that wants LESS than it holds, never one
  // that wants more: the panel is happy with a detailed reading, and the modal
  // opening onto a plain one would show four empty columns for up to a poll.
  if (procLast && now - procLast.at < PROC_MIN_GAP_MS && (procLast.detail || !detail)) return procLast.read;
  if (procInFlight && (procInFlightDetail || !detail)) return procInFlight;
  // Only a real reading is remembered. Every failure inside readProcessesNow —
  // a spawn that never started, a non-zero exit, the timeout — resolves to an
  // empty array, and no machine has nothing running on it, so an empty list is
  // a failure by construction. Serving one for the next 1.5s would turn a
  // single hiccup into a blank panel that outlives it; the next caller retries
  // instead. The in-flight share still applies, so a burst arriving during a
  // failing read is one failing child, not a burst of them.
  procInFlightDetail = detail;
  procInFlight = readProcessesNow(platform, detail)
    .then(read => {
      if (read.procs.length) procLast = { at: Date.now(), read, detail };
      return read;
    })
    .finally(() => { procInFlight = null; procInFlightDetail = false; });
  return procInFlight;
}

async function readProcessesNow(platform, detail = false) {
  if (platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      // Threads and StartTime ride along on the call that was already being
      // made — `Get-Process` has both, so the two columns cost nothing here.
      // `WorkingSet64` joins `PrivateMemorySize64` rather than replacing it:
      // the percentage has always been computed from private bytes and moving
      // it would change a number that is on screen today, while the new column
      // wants the resident figure Task Manager itself shows.
      // NOT `-IncludeUserName`: it requires an elevated session, and no part
      // of this deck may ask for one. The user column is simply absent on
      // Windows, which is the same rule the thermal section keeps.
      "Get-Process | Select-Object Id,ProcessName,CPU,@{n='Threads';e={$_.Threads.Count}},@{n='StartedAt';e={if($_.StartTime){[int]((Get-Date)-$_.StartTime).TotalSeconds}else{$null}}},@{n='WorkingSet';e={$_.WorkingSet64}},@{n='WorkingSetPrivate';e={$_.PrivateMemorySize64}} | ConvertTo-Json -Compress",
    ], 6_000);
    // The same shape the POSIX branch below returns, and not a bare array: the
    // caller reads `read.procs.length` to decide whether this was a real
    // reading, so an array meant a TypeError rather than an empty list. Every
    // Windows failure — a non-zero exit, a spawn that never started, the 6s
    // deadline this module's own comment says the runtime sits right on —
    // therefore answered `/api/system/processes` with a 500 and a logged stack,
    // every four seconds for as long as the machine panel was open.
    if (!out) return { procs: [], total: 0 };
    const rows = parseGetProcessJson(out.trim(), os.totalmem());
    const now = Date.now();
    const ranked = cpuFromDeltas(rows, prevProcCpu, now - prevProcAt);
    prevProcCpu = new Map(rows.filter(r => r.cpuSec != null).map(r => [r.pid, r.cpuSec]));
    prevProcAt = now;
    return { procs: pickCandidates(ranked), total: ranked.length };
  }
  const out = await run("ps", psArgs(platform), 4_000);
  if (!out) return { procs: [], total: 0 };
  const all = parsePsProcesses(out);
  const procs = pickCandidates(all);
  if (detail) await attachDetail(procs, platform);
  return { procs, total: all.length };
}

/**
 * Fill in threads and the command tail, for the candidates and no further.
 *
 * AFTER pickCandidates, deliberately: this is a per-pid listing, and asking it
 * about every process on the machine would be several hundred pids to answer a
 * question about forty. The candidates are what any surface can draw, so they
 * are what gets the second child.
 *
 * A failure here is not a failure of the reading. `ps -M` can lose a race with
 * a process that exited between the two calls, a hardened environment can
 * refuse it, and neither is a reason to blank a list whose CPU and memory
 * columns are already correct. The fields are simply absent, and the columns
 * that read them print a dash — the same rule the rest of this module keeps:
 * an unknown is never rendered as a zero.
 */
async function attachDetail(procs, platform) {
  if (!procs.length) return;
  const pids = procs.map(p => p.pid).filter(n => Number.isInteger(n) && n > 0);
  if (!pids.length) return;
  let out;
  try { out = await run("ps", psDetailArgs(pids, platform), 4_000); }
  catch { return; }
  if (!out) return;
  const detail = platform === "linux" ? parsePsThreadsProcps(out) : parsePsThreadsBsd(out);
  const home = os.homedir?.() ?? "";
  for (const p of procs) {
    const d = detail.get(p.pid);
    if (!d) continue;
    // Zero threads is not a reading. Every process has at least one, so a zero
    // here means the listing named the pid and gave no thread lines for it —
    // a race with an exit — and a `0` in that column would be a claim.
    if (d.threads > 0) p.threads = d.threads;
    // REDACTED BEFORE IT LEAVES THIS MODULE, not on the way to the screen.
    // /api/system/processes is served to anything that can reach the loopback
    // port, and a token that only the client hides is a token that shipped.
    const cmd = redactCommand(commandTail(d.cmd, p.name), home);
    if (cmd) p.cmd = cmd;
  }
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

  return [];
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
    thermal: thermal ? { ...thermal, heldBack: heldBackSoFar() } : null,
    uptimeSec: Math.round(os.uptime()),
    platform: process.platform,
    loadavg: hasLoad ? load.map(n => Math.round(n * 100) / 100) : null,
    intervalMs: CPU_INTERVAL_MS,
    sampledAt: Date.now(),
  };
}
