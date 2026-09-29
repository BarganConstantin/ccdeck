// The process list: which rows /api/system/processes answers with, and how each
// platform is asked for them.
//
// Moved out of system-metrics.mjs unchanged, because it is the one reading there
// that never rides the sampler's timers. It is read on demand only — while the
// process dialog is open — keeps its own one-child-at-a-time guard and its own
// CPU baseline (Windows since #544, Linux since #1769), and shares nothing with
// the ambient readings but the command runner. system-metrics.mjs re-exports
// readProcesses, which is where index.mjs asks for it, and its stopSystemMetrics
// calls resetProcessList so a reset still clears this list along with everything
// else.
import { readFile } from "node:fs/promises";
import os from "node:os";
import { run } from "./metrics-run.mjs";
// What of a command line may leave this module: see process-command.mjs.
import { CMD_MAX, commandTail, redactCommand } from "./process-command.mjs";

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
 * `--sort=-pcpu` is NOT procps' way to say what `-r` says on BSD, which is what
 * this comment used to claim. procps defines `%cpu` as CPU time over the
 * process's whole lifetime, so a process that idled for hours and is pinning a
 * core now reads a few percent, and one that was busy at start-up keeps its
 * figure long after it stopped (#1769). The sort stays because it costs `ps`
 * nothing and orders the text sensibly for anyone reading it, but the Linux
 * column is not this one any more: readProcessesNow replaces it with a rate
 * taken from /proc/<pid>/stat between two readings (linuxCpuSec). The column
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
  // count is fetched separately (attachDetail) rather than as an eighth column:
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
 * answered both in one go and takes 4.25s on an idle machine.
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

// The command column — argv without its executable, redacted and capped before
// it leaves this module (#807): process-command.mjs.
export { CMD_MAX, commandTail, redactCommand };

/**
 * Rows out of `ps -o pid,pcpu,pmem,comm`, in that column order on both Unixes —
 * see psArgs for how each platform is asked for it.
 *
 * `pcpu` is a percentage of ONE core on both, so a multi-threaded process runs
 * past 100 and that is information rather than an error: 157 is one and a half
 * cores. cpuFromDeltas puts the Windows and Linux columns on this same scale —
 * on Linux the figure parsed here is a lifetime average and is replaced before
 * it leaves this module (see psArgs).
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
      //
      // `typeof` rather than `Number.isFinite(Number(…))` on the uptime, and the
      // difference is the whole of that rule: `Number(null)` is 0, and 0 is
      // finite, so the projection's own `else{$null}` — the branch it takes for
      // every process whose StartTime this session may not read — arrived as an
      // uptime of ZERO SECONDS. Every protected process on the machine was
      // reported to the panel as having started this instant, which is the
      // reading the comment above says must never be invented. A genuine zero
      // is still kept: `[int]` of a sub-second TimeSpan is 0, and a process that
      // started this instant is a real answer when it is the real answer. Same
      // guard the CPU field two lines up already used, for the same reason.
      ...(Number.isFinite(Number(r.Threads)) && Number(r.Threads) > 0 ? { threads: Number(r.Threads) } : {}),
      ...(typeof r.StartedAt === "number" && Number.isFinite(r.StartedAt) ? { uptimeSec: r.StartedAt } : {}),
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
 * 0-100 convention (see cpuPercent in system-metrics.mjs) is a different
 * question with a different answer, and the only way this drifts back is if a core count is in reach.
 *
 * THE ROW IS CARRIED, NOT REBUILT, and that is the half this used to get wrong
 * (#954). It listed the four fields it knew about — pid, cpu, mem, name — so
 * `threads`, `uptimeSec` and `rssBytes` were silently dropped on their way
 * through, and this is the only step the Windows reading takes: readProcessesNow
 * returns straight out of the win32 branch, on the other side of the
 * `attachDetail` call that puts those three back on POSIX. Every Windows row
 * therefore reached the panel with three of its seven columns missing, always,
 * and the memory header — which sorts on `rssBytes` and treats `undefined` as a
 * missing reading — reordered nothing when clicked, because every row was
 * missing it. Invisible to anyone developing on macOS or Linux.
 *
 * `cpuSec` is the one field deliberately removed: it is the raw counter this
 * function exists to turn into a rate, the POSIX rows never carry one, and
 * shipping it would put two spellings of the same quantity on the wire.
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
    const { cpuSec: _raw, ...rest } = r;
    return { ...rest, cpu };
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

/**
 * Cumulative CPU seconds out of one `/proc/<pid>/stat` line, or null.
 *
 * utime and stime are fields 14 and 15, in USER_HZ ticks. The name in field 2
 * is the one field that can hold anything — spaces, parentheses — so the count
 * starts after the LAST `)` rather than at a split on spaces: `(tmux: server)`
 * would otherwise shift every field after it.
 *
 * USER_HZ is the kernel's fixed unit for these files, not the scheduler's tick
 * rate, and it is 100 on every architecture Node runs on; Node has no sysconf to
 * ask, and a `getconf CLK_TCK` child per poll to confirm a constant would cost
 * more than the reading it serves.
 */
const USER_HZ = 100;
export function cpuSecFromProcStat(text) {
  const s = String(text ?? "");
  const close = s.lastIndexOf(")");
  if (close < 0) return null;
  // Field 3 (the state) is the first after the name, so field N is at N - 3.
  const f = s.slice(close + 1).trim().split(/\s+/);
  const utime = Number(f[11]), stime = Number(f[12]);
  if (f.length < 13 || !Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return (utime + stime) / USER_HZ;
}

/**
 * The CPU seconds each Linux row has used so far, for cpuFromDeltas to turn
 * into a rate the way it already does for Windows (#1769).
 *
 * One file read per process, and no child: this is the same file `ps` itself
 * read a moment ago to print the lifetime figure, so the cost is a few hundred
 * small reads of a pseudo-filesystem once every four seconds, only while the
 * process dialog is open. Reads run together rather than one after another.
 *
 * A read that fails — the process exited between `ps` and here, or /proc hides
 * other users' processes — leaves `cpuSec` null, which cpuFromDeltas reports as
 * an unknown CPU rather than as an idle one. `deps.readFile` is the seam the
 * suite uses, so no test depends on the machine's real process table.
 */
async function linuxCpuSec(rows, deps = {}) {
  const file = deps.readFile ?? readFile;
  const secs = await Promise.all(rows.map(r =>
    Promise.resolve()
      .then(() => file(`/proc/${r.pid}/stat`, "utf8"))
      .then(cpuSecFromProcStat, () => null)));
  return rows.map((r, i) => {
    const { cpu: _lifetime, ...rest } = r;
    return { ...rest, cpuSec: secs[i] };
  });
}

/** The previous reading's CPU seconds per pid, on the two platforms whose
 *  column is a rate derived here (Windows and Linux), so the next reading can
 *  be one. Cleared with the rest of the sampler state — see resetProcessList. */
let prevProcCpu = null;
let prevProcAt = 0;

/** The run producing the next list, and the last one that finished. */
let procInFlight = null;
let procLast = null; // { at, read: { procs, total }, detail }
let procInFlightDetail = false;

/**
 * How old a finished reading may be and still answer a caller.
 *
 * Well under ProcessListModal's PROC_POLL_MS of 4000, so the dialog this exists
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
export async function readProcesses(platform = process.platform, detail = false, deps = {}) {
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
  procInFlight = readProcessesNow(platform, detail, deps)
    .then(read => {
      if (read.procs.length) procLast = { at: Date.now(), read, detail };
      return read;
    })
    .finally(() => { procInFlight = null; procInFlightDetail = false; });
  return procInFlight;
}

/**
 * What /api/system/processes answers for one reading.
 *
 * An empty reading is a failed one, by the rule readProcesses already keeps: no
 * machine has nothing running on it, and every failure inside the reader — a
 * spawn that never started, a non-zero exit, the deadline — resolves to an
 * empty list. It went out as `{ ok: true, procs: [] }`, which is a claim that
 * the machine was read and found empty, and the dialog believed it: one slow
 * `ps` swapped a working table for a sentence blaming the platform (#1770).
 * So a failure says it is one, and the dialog keeps what it was showing.
 */
export function processesReply(read) {
  if (!read?.procs?.length) return { ok: false, reason: "read_failed" };
  return { ok: true, ...read };
}

/**
 * The one-liner the Windows process list is read with.
 *
 * Threads and StartTime ride along on the call that was already being made —
 * `Get-Process` has both, so the two columns cost nothing here. `WorkingSet64`
 * joins `PrivateMemorySize64` rather than replacing it: the percentage has
 * always been computed from private bytes and moving it would change a number
 * that is on screen today, while the new column wants the resident figure Task
 * Manager itself shows.
 *
 * NOT `-IncludeUserName`: it requires an elevated session, and no part of this
 * deck may ask for one. The user column is simply absent on Windows, which is
 * the same rule the thermal section keeps.
 *
 * A named export for the reason WIN_THERMAL_PS is one, and #954 is why it
 * became one: three of the seven columns this projection is built to fill were
 * being dropped after it, and every assertion in the suite was made against a
 * payload somebody typed. A constant can be handed to the real powershell.exe
 * on the Windows leg of the matrix, which is the only place the claim "Windows
 * really does answer with these seven keys" can be measured rather than
 * reasoned about.
 */
export const WIN_PROCESS_PS =
  "Get-Process | Select-Object Id,ProcessName,CPU,@{n='Threads';e={$_.Threads.Count}},@{n='StartedAt';e={if($_.StartTime){[int]((Get-Date)-$_.StartTime).TotalSeconds}else{$null}}},@{n='WorkingSet';e={$_.WorkingSet64}},@{n='WorkingSetPrivate';e={$_.PrivateMemorySize64}} | ConvertTo-Json -Compress";

async function readProcessesNow(platform, detail = false, deps = {}) {
  if (platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", WIN_PROCESS_PS,
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
  let all = parsePsProcesses(out);
  if (platform === "linux") {
    // procps' %cpu is a lifetime average (see psArgs), so the Linux column is
    // derived here from two readings of the kernel's own counters, exactly as
    // the Windows one is from two Get-Process readings: null on the first,
    // then the share of one core used since the one before.
    const rows = await linuxCpuSec(all, deps);
    const now = Date.now();
    all = cpuFromDeltas(rows, prevProcCpu, now - prevProcAt);
    prevProcCpu = new Map(rows.filter(r => r.cpuSec != null).map(r => [r.pid, r.cpuSec]));
    prevProcAt = now;
  }
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

/**
 * Forget the CPU baseline and the last list, for stopSystemMetrics.
 *
 * The last list goes with the baseline it was computed against. A sampler that
 * stopped and started again must not answer the first caller with a reading
 * from before the stop.
 */
export function resetProcessList() {
  prevProcCpu = null;
  prevProcAt = 0;
  procLast = null;
}
