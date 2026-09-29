// The Linux CPU column was a lifetime average (#1769).
//
// procps defines `%cpu` as the CPU time a process has used divided by the time
// it has existed. The list sorted and chose its candidates by that number, so a
// process that idled for two hours and has been spinning a core for the last
// ten seconds read about 2% and did not reach the top, while a compiler that
// was busy at start-up and has been idle since kept its 60%. macOS asks `ps -r`,
// whose figure is current, and Windows derives a rate from two readings; Linux
// was the one platform answering a different question.
//
// The column is now what it is on Windows: the share of one core used since the
// previous reading, taken from the cumulative ticks in /proc/<pid>/stat, and
// null on the first reading. PLAIN NODE, no DOM, and no real process table:
// `ps` is a fake child and /proc is a fixture handed in through `deps.readFile`,
// so nothing here depends on what the machine running the suite is doing.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.kill = () => {};
      // What procps prints for `-eo pid,pcpu,…` today: sorted by a figure that
      // is the whole lifetime's average. esbuild was busy at start-up; node
      // idled for two hours and is pinning a core now.
      queueMicrotask(() => {
        child.stdout.emit("data",
          "    PID %CPU %MEM    RSS     ELAPSED USER                     COMMAND\n" +
          "   1300 60.0  0.4 102400       00:10 dev                      esbuild\n" +
          "   4242  2.0  0.5 204800    02:00:00 dev                      node\n" +
          "      1  0.1  0.1  12288  3-00:00:00 root                     systemd\n");
        child.emit("close", 0);
      });
      return child;
    },
  };
});

// @ts-expect-error — plain .mjs server module, no types
import { readProcesses, stopSystemMetrics } from "../../server/system-metrics.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { cpuSecFromProcStat } from "../../server/process-list.mjs";

/** utime and stime, in USER_HZ ticks, per pid — the two counters the column
 *  is differenced from. */
const ticks = new Map<number, [number, number]>();

/** /proc/<pid>/stat as the kernel writes it: pid, the name in parentheses,
 *  then the state and the numeric fields, utime and stime at 14 and 15. */
const stat = (pid: number, comm: string) => {
  const [u, s] = ticks.get(pid)!;
  return `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194560 812 0 0 0 ${u} ${s} 0 0 20 0 11 0 1234567 1073741824 51200 18446744073709551615`;
};

const COMM: Record<number, string> = { 1300: "esbuild", 4242: "node", 1: "systemd" };
const read: string[] = [];
const deps = {
  readFile: async (path: string) => {
    read.push(path);
    const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)?.[1]);
    if (!ticks.has(pid)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return stat(pid, COMM[pid]);
  },
};

type Row = { pid: number; cpu: number | null };
const byPid = (procs: Row[]) => Object.fromEntries(procs.map(p => [p.pid, p.cpu]));

afterEach(() => { stopSystemMetrics(); vi.restoreAllMocks(); read.length = 0; ticks.clear(); });

describe("the Linux CPU column", () => {
  it("is the share of a core used since the last reading, not over the whole lifetime", async () => {
    const t0 = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    ticks.set(1300, [600, 0]).set(4242, [50_000, 1_000]).set(1, [90, 10]);
    const first = await readProcesses("linux", false, deps) as { procs: Row[] };

    // No previous reading, so no rate — the Windows rule: a dash, never a
    // figure invented from the process's lifetime.
    expect(first.procs.map(p => p.cpu)).toEqual([null, null, null]);
    expect(read.sort()).toEqual(["/proc/1/stat", "/proc/1300/stat", "/proc/4242/stat"]);

    // Four seconds later, past the cache window. node burned 400 ticks — four
    // CPU-seconds at USER_HZ 100 — and the other two burned nothing.
    clock.mockReturnValue(t0 + 4_000);
    ticks.set(4242, [50_300, 1_100]);
    const second = await readProcesses("linux", false, deps) as { procs: Row[] };

    expect(byPid(second.procs)).toEqual({ 4242: 100, 1300: 0, 1: 0 });
    // And it is ranked by that: the busiest process right now comes first.
    expect(second.procs[0].pid).toBe(4242);
  });

  it("leaves a row it could not read unknown rather than idle", async () => {
    // A process that exited between `ps` and the read of its stat file has no
    // second counter. Unknown sorts last and prints a dash; zero would call it
    // idle, which nothing measured.
    const t0 = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    ticks.set(1300, [600, 0]).set(4242, [50_000, 1_000]).set(1, [90, 10]);
    await readProcesses("linux", false, deps);
    clock.mockReturnValue(t0 + 4_000);
    ticks.delete(1300);
    ticks.set(4242, [50_200, 1_000]);
    const second = await readProcesses("linux", false, deps) as { procs: Row[] };
    expect(byPid(second.procs)).toEqual({ 4242: 50, 1300: null, 1: 0 });
  });
});

describe("reading /proc/<pid>/stat", () => {
  it("counts from after the name, which may hold spaces and parentheses", () => {
    // The name is the one field that can contain anything, so the fields are
    // counted from the LAST `)`. utime + stime is 250 ticks, 2.5 seconds.
    const text = "777 (tmux: server) (x)) S 1 777 777 0 -1 4194560 10 0 0 0 200 50 0 0 20 0 1 0 99 1 1 1";
    expect(cpuSecFromProcStat(text)).toBe(2.5);
  });

  it("answers null for anything that is not a stat line", () => {
    expect(cpuSecFromProcStat("")).toBeNull();
    expect(cpuSecFromProcStat(null)).toBeNull();
    expect(cpuSecFromProcStat("777 (truncated) S 1 2")).toBeNull();
  });
});
