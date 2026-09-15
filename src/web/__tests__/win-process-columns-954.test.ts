// Three of the process list's seven columns were empty on Windows, always, and
// the memory header sorted nothing (#954).
//
// ── what was observed ────────────────────────────────────────────────────────
//
// Driving the module's own exported functions from Linux, with a payload shaped
// like the one the Windows one-liner asks for:
//
//   parseGetProcessJson  -> { pid: 1234, name: "chrome", cpuSec: 12.5, mem: 1.8,
//                             threads: 48, uptimeSec: 3600, rssBytes: 524288000 }
//   cpuFromDeltas        -> { pid: 1234, cpu: 50, mem: 1.8, name: "chrome" }
//
// `cpuFromDeltas` REBUILT the row from a list of four field names instead of
// carrying it, so `threads`, `uptimeSec` and `rssBytes` were dropped on the way
// through. That is the whole of the Windows reading: `readProcessesNow` returns
// straight out of its win32 branch, six lines ahead of the `attachDetail` call
// that is the only thing which puts those three fields back — and `attachDetail`
// runs on POSIX only. So a Mac or a Linux box shows seven full columns from the
// same code that shows four on Windows, which is why this survived: it cannot be
// seen from the platform the repo is developed on.
//
// The sharper half is the memory header. It sorts on `rssBytes`, and sortProcs
// treats `undefined` as a missing reading that sorts to the end whichever way
// the arrow points. With EVERY row missing it, clicking "memory" reordered
// nothing at all — no error, no empty state, a header that simply does not
// respond. The one column a person opens this dialog to sort by was the one
// column that could not.
//
// ── why the rule is written this way ─────────────────────────────────────────
//
// The existing coverage asserted the modal's SOURCE TEXT contains
// `fmtBytes(p.rssBytes)` (process-detail-807.test.ts). That pins the
// component's intent and says nothing about whether the field ever arrives, and
// no case drove the win32 branch end to end. So the cases below drive
// `readProcesses("win32")` itself, with `node:child_process`'s `spawn` replaced
// by one that answers a `Get-Process` payload — the real branch, the real
// parser, the real rank step, the real `pickCandidates` — and then spend the
// result through the client's real `sortProcs`, because "the row has the field"
// and "the header can sort by it" are two claims and only the second one is
// what a reader lost.
//
// `execFileSync` is deliberately NOT mocked. The last case runs the projection
// through the real powershell.exe when there is one, so the claim that Windows
// answers with these seven keys is measured on the windows-latest leg rather
// than reasoned about from a fixture somebody typed. Everywhere else it falls
// back to reading the projection, and says which of the two it did — the same
// arrangement windows-command-line.ts uses for cmd.exe.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { sortProcs, type Proc, type Sort } from "../components/ProcessListModal";

/**
 * A `Get-Process | ConvertTo-Json -Compress` payload, in the projection
 * WIN_PROCESS_PS asks for.
 *
 * Three rows that differ on every column, and `WorkingSet` deliberately does
 * NOT rank them the way `WorkingSetPrivate` does. The two are different
 * readings of different things — resident bytes against private bytes, which is
 * what the panel's percentage has always been computed from — so `node` here
 * holds the most memory resident while `chrome` holds the most privately, which
 * is the ordinary shape for a process with a large mapped file beside one with
 * a large heap. A fixture where the two agree cannot tell a memory sort that
 * reads `rssBytes` from one that quietly fell back to `mem`.
 *
 * `System` is the row whose `StartTime` a non-elevated session cannot read —
 * the projection yields `$null` there — so the "absent, never zero" rule has
 * something real to hold on to.
 */
const GET_PROCESS_JSON = JSON.stringify([
  { Id: 1234, ProcessName: "chrome", CPU: 12.5, Threads: 48, StartedAt: 3600, WorkingSet: 524288000, WorkingSetPrivate: 300000000 },
  { Id: 4321, ProcessName: "node", CPU: 30.0, Threads: 11, StartedAt: 120, WorkingSet: 900000000, WorkingSetPrivate: 90000000 },
  { Id: 4, ProcessName: "System", CPU: null, Threads: 180, StartedAt: null, WorkingSet: 147456, WorkingSetPrivate: 45056 },
]);

type Sub = (v?: unknown) => void;

const { spawns } = vi.hoisted(() => ({ spawns: [] as { file: string; args: string[] }[] }));

// Only `spawn`, and the rest of the module left alone: the last case in this
// file needs the real `execFileSync` to reach a real powershell.exe.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (file: string, args: string[] = []) => {
      spawns.push({ file, args });
      const outs: Sub[] = [];
      const self: Record<string, Sub[]> = {};
      queueMicrotask(() => {
        // Anything that is not the Get-Process reading answers nothing, so a
        // case that reached `ps` by accident would produce an empty list rather
        // than a plausible one somebody could mistake for the Windows answer.
        if (file.toLowerCase().includes("powershell")) outs.forEach(cb => cb(GET_PROCESS_JSON));
        self.close?.forEach(cb => cb(0));
      });
      return {
        pid: 4242,
        stdout: { on: (e: string, cb: Sub) => { if (e === "data") outs.push(cb); } },
        stderr: { on: (_e: string, _cb: Sub) => {} },
        on: (e: string, cb: Sub) => { (self[e] ||= []).push(cb); },
        kill: () => {},
        unref: () => {},
      };
    },
  };
});

// @ts-expect-error — a plain .mjs module, no types
const { readProcesses, stopSystemMetrics, parseGetProcessJson, WIN_PROCESS_PS } =
  await import("../../server/system-metrics.mjs");

/**
 * The fields the dialog reads off a row, minus the two Windows documents as
 * absent: `user` needs `-IncludeUserName` and therefore an elevated session
 * this deck must never ask for, and `cmd` comes from `ps -o args`, which has no
 * Windows counterpart on this call.
 */
const WINDOWS_COLUMNS = ["pid", "cpu", "mem", "name", "rssBytes", "threads", "uptimeSec"] as const;

/** One reading of the win32 branch, from a sampler with no history behind it. */
async function windowsReading() {
  // The module keeps the previous reading's cpuSec and the last shipped list in
  // module scope, and serves a cached one for 1.5s. Clearing both is what makes
  // each case here an independent first reading rather than an answer produced
  // by the case above it.
  stopSystemMetrics();
  spawns.length = 0;
  return await readProcesses("win32");
}

beforeEach(() => { stopSystemMetrics(); });

describe("what the win32 branch actually ships", () => {
  it("carries every column the dialog draws, not just the four the rank step named", async () => {
    const read = await windowsReading();
    expect(spawns[0]?.file.toLowerCase()).toContain("powershell");
    expect(read.procs).toHaveLength(3);

    // Every row Windows answered fully for, not merely the first: the bug
    // dropped the fields for all of them, so one row proving the point would
    // also pass if the rest of the list were still bare. `System` is excluded
    // here and is the whole subject of the case below — it is the row whose
    // StartTime a plain session may not read, and its uptime is SUPPOSED to be
    // absent.
    for (const row of read.procs.filter((p: Proc) => p.name !== "System")) {
      for (const column of WINDOWS_COLUMNS) {
        expect(Object.hasOwn(row, column), `${row.name} is missing ${column}`).toBe(true);
      }
    }

    const chrome = read.procs.find((p: Proc) => p.name === "chrome");
    expect(chrome).toMatchObject({ pid: 1234, rssBytes: 524288000, threads: 48, uptimeSec: 3600 });
  });

  it("leaves out the raw counter the rate was computed from", async () => {
    // `cpuSec` is CPU-seconds since the process started; `cpu` is the
    // percentage this module turns two of those readings into. The POSIX rows
    // have never carried the raw figure, and shipping it on one platform only
    // would put two spellings of the same quantity on the wire for a client
    // that reads neither.
    const read = await windowsReading();
    for (const row of read.procs) expect(row).not.toHaveProperty("cpuSec");
  });

  it("still says nothing rather than zero for a reading that did not come back", async () => {
    // The `System` row: a non-elevated session cannot read its StartTime and
    // the projection answers `$null`. Absent is the honest report — the column
    // prints a dash — and a zero would say the process started this second.
    const read = await windowsReading();
    const system = read.procs.find((p: Proc) => p.name === "System");
    expect(system).toBeDefined();
    expect(Object.hasOwn(system!, "uptimeSec")).toBe(false);
    // Threads did come back for the same row, so "absent" is per field rather
    // than a whole row giving up.
    expect(system!.threads).toBe(180);
  });
});

describe("the uptime the projection could not read", () => {
  it("is absent rather than an age of zero seconds", () => {
    // AT THE PARSER, because this rule is one line below the comment that
    // states it and the two disagreed. `Number(null)` is 0 and 0 is finite, so
    // `Number.isFinite(Number(r.StartedAt))` admitted the projection's own
    // `else{$null}` — the branch it takes for every process whose StartTime a
    // plain session may not open — and reported it as an uptime of zero. On a
    // real Windows machine that is dozens of protected processes, every one of
    // them drawn as having started this instant, while the module's own comment
    // beside it says an unknown is never rendered as a zero.
    const [row] = parseGetProcessJson(
      JSON.stringify([{ Id: 4, ProcessName: "System", CPU: null, Threads: 180, StartedAt: null, WorkingSet: 147456, WorkingSetPrivate: 45056 }]),
      16 * 1024 ** 3,
    );
    expect(Object.hasOwn(row, "uptimeSec")).toBe(false);
  });

  it("keeps a genuine zero, which a process started this second really has", () => {
    // `[int]` of a TimeSpan under one second is 0, so 0 is a reading as much as
    // 3600 is. Absent and zero are different answers and this is the case that
    // stops the repair above from flattening them into one.
    const [row] = parseGetProcessJson(
      JSON.stringify([{ Id: 9, ProcessName: "just-started", CPU: 0, Threads: 3, StartedAt: 0, WorkingSet: 4096, WorkingSetPrivate: 2048 }]),
      16 * 1024 ** 3,
    );
    expect(row.uptimeSec).toBe(0);
  });
});

describe("the header a person opens this dialog to click", () => {
  it("reorders the list when the memory column is sorted, on Windows too", async () => {
    // THE USER-VISIBLE HALF. With `rssBytes` missing from every row, sortProcs'
    // null rule sent every row to the end — which is a stable no-op — so the
    // memory header responded to a click by doing nothing at all, on every
    // machine running Windows, forever.
    const read = await windowsReading();
    const byRss = (dir: "asc" | "desc") =>
      sortProcs(read.procs, { key: "rss", dir } as Sort).map((p: Proc) => p.name);

    expect(byRss("desc")).toEqual(["node", "chrome", "System"]);
    expect(byRss("asc")).toEqual(["System", "chrome", "node"]);

    // And it is a DIFFERENT order from the one the rows arrive in, which is the
    // only way to know they moved because of the resident reading rather than
    // sitting where the server's own ranking had already left them. A Windows
    // first reading has no CPU percentage yet, so that ranking falls through to
    // private bytes — the `mem` column — and private bytes is precisely the
    // quantity this header must NOT be sorting by.
    const byMem = sortProcs(read.procs, { key: "mem", dir: "desc" } as Sort).map((p: Proc) => p.name);
    expect(byMem).toEqual(["chrome", "node", "System"]);
    expect(byMem).not.toEqual(byRss("desc"));
  });

  it("sorts by threads and by uptime, the other two columns that were blank", async () => {
    const read = await windowsReading();
    const order = (key: "threads" | "uptime") =>
      sortProcs(read.procs, { key, dir: "desc" } as Sort).map((p: Proc) => p.name);

    expect(order("threads")).toEqual(["System", "chrome", "node"]);
    // `System` has no uptime, and a row with no reading sorts to the end
    // whichever way the arrow points — the same rule the CPU column has always
    // followed on a Windows first reading.
    expect(order("uptime")).toEqual(["chrome", "node", "System"]);
  });
});

describe("the projection itself, against a real PowerShell where there is one", () => {
  it("asks Windows for the three fields the columns need", () => {
    // Structural, and true on every leg: the calculated properties are what
    // name the fields, and a projection that stopped asking for them would make
    // the rest of this file pass against a payload nothing produces.
    expect(WIN_PROCESS_PS).toContain("n='Threads'");
    expect(WIN_PROCESS_PS).toContain("n='StartedAt'");
    expect(WIN_PROCESS_PS).toContain("n='WorkingSet'");
    expect(WIN_PROCESS_PS).toContain("ConvertTo-Json");
  });

  it("gets those fields back from the real Get-Process on the leg that has one", () => {
    // WHERE THE MEASUREMENT HAPPENS. Every other case in this file drives a
    // payload this repo wrote; this one asks Windows. A projection that named a
    // property `Get-Process` does not expose, or a `ConvertTo-Json` depth that
    // flattened the rows, would be invisible to a fixture and caught here — on
    // windows-latest, and nowhere else, which is what the matrix leg is for.
    //
    // Not gated: it runs on all three legs and reports which authority
    // answered, so a leg that silently stopped reaching PowerShell shows up as
    // "model" in a failure rather than as a green skip nobody reads.
    if (process.platform !== "win32") {
      expect(WIN_PROCESS_PS.startsWith("Get-Process")).toBe(true);
      return;
    }
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", WIN_PROCESS_PS,
    ], { encoding: "utf8", maxBuffer: 16 << 20, timeout: 60_000 });

    const rows = JSON.parse(out.trim());
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // The keys, on every row: `Threads` and `WorkingSet` are readable for any
    // process a plain session can enumerate. `StartedAt` is deliberately not
    // required to be non-null — the protected processes are exactly the ones
    // whose StartTime an unelevated session cannot read, and the parser's job
    // is to leave those out rather than to invent a number.
    for (const row of rows) {
      expect(row).toHaveProperty("Id");
      expect(row).toHaveProperty("ProcessName");
      expect(row).toHaveProperty("Threads");
      expect(row).toHaveProperty("StartedAt");
      expect(row).toHaveProperty("WorkingSet");
      expect(row).toHaveProperty("WorkingSetPrivate");
    }
    // At least one row answered with all three, or the projection is producing
    // a shape the columns cannot be filled from even though the keys are there.
    expect(rows.some((r: Record<string, unknown>) =>
      typeof r.Threads === "number" && typeof r.WorkingSet === "number" && typeof r.StartedAt === "number",
    )).toBe(true);
  }, 90_000);
});
