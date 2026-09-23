// The redaction that runs between the second `ps` and the wire, driven rather
// than read (#1171).
//
// `/api/system/processes?detail=1` answers anything that can reach the loopback
// port, and what it adds over the plain reading is the argument vector of every
// process on the machine — which is where API keys, database passwords and
// session tokens live. `attachDetail` is the one place that vector is cleaned,
// and until this file it had never executed in the suite at all: every
// assertion about it was a `toMatch` on the source, and `redactCommand`,
// `commandTail` and the two thread parsers were tested as pure functions with
// nothing joining them up. A rewrite that kept the pinned line and assigned
// `d.cmd` instead of the redacted value would have shipped green, and what it
// ships is other people's secrets.
//
// `ps` IS MOCKED, both calls of it, because this has to make the same claim on
// a runner as on the machine it was written on: the fixtures are a macOS `ps`
// listing and a `ps -M` listing in the shape the parser tests already use, and
// a real `ps` here would be asserting something about whatever the runner
// happened to be doing.
import { describe, it, expect, vi, afterEach } from "vitest";

/** What each spawn answers, in order, and what was asked. One entry per call,
 *  so the case says which child is which rather than the mock guessing. */
const { spawns, replies } = vi.hoisted(() => ({
  spawns: [] as { file: string; args: string[] }[],
  replies: [] as { out: string; code: number }[],
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (file: string, args: string[]) => {
      spawns.push({ file, args });
      const reply = replies.shift() ?? { out: "", code: 1 };
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        if (reply.out) child.stdout.emit("data", reply.out);
        child.emit("close", reply.code);
      });
      return child;
    },
  };
});

// @ts-expect-error — plain .mjs server module, no types
import { readProcesses, stopSystemMetrics } from "../../server/system-metrics.mjs";

interface Proc { pid: number; name: string; cpu: number; mem: number; threads?: number; cmd?: string }

/** One busy process, in the seven columns `psArgs` asks for. */
const LIST = [
  "  PID  %CPU %MEM    RSS     ELAPSED USER             COMM",
  " 4242  12.5  3.1  204800       05:00 constantin       node",
].join("\n");

/** The same pid in a `ps -M` listing: the process line carries argv, and every
 *  line under it is one thread. The argv is a real-shaped command line with
 *  three separate secrets in it — a flag with `=`, a flag with a space, and a
 *  password inside a URL — because those are three different rules in
 *  `redactCommand` and a regression usually loses one of them. */
const SECRET_ARGV = "node /srv/x.js --api-key sk-ant-api03-SECRET --password hunter2 https://u:pw@h/";
const detailListing = (threads: number) => [
  "USER         PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND",
  `constantin  4242   ??   12.5 S    31T   1:02.03   9:10.11 ${SECRET_ARGV}`,
  ...Array.from({ length: threads }, () => "            4242         0.0 S     4T   0:00.00   0:00.00 "),
].join("\n");

const answer = (...rs: { out: string; code: number }[]) => { replies.length = 0; replies.push(...rs); };
const ok = (out: string) => ({ out, code: 0 });
const failed = { out: "", code: 1 };

// The reading is held for PROC_MIN_GAP_MS and the CPU baseline outlives it, so
// each case says the previous one is finished with. Same reset the locale suite
// uses, and the module's own.
afterEach(() => { spawns.length = 0; replies.length = 0; stopSystemMetrics(); });

describe("the argument vector, on its way out of this module", () => {
  it("is cleaned on the server, so a token never reaches the wire at all", async () => {
    answer(ok(LIST), ok(detailListing(3)));
    const { procs } = await readProcesses("darwin", true) as { procs: Proc[] };

    // Two children, the second scoped to the candidate the first found.
    expect(spawns.map(s => s.file)).toEqual(["ps", "ps"]);
    expect(spawns[1].args).toEqual(["-M", "-p", "4242"]);

    const p = procs.find(x => x.pid === 4242)!;
    expect(p.threads, "the thread count from the second call did not land").toBe(3);
    // The executable comes off the front — the row already says `node` — and
    // every secret on what is left is gone.
    expect(p.cmd).toContain("/srv/x.js");
    for (const secret of ["sk-ant-api03-SECRET", "hunter2", "u:pw@"]) {
      expect(p.cmd, `${secret} was served to anything on the loopback port`).not.toContain(secret);
    }
    // The FLAGS survive, because the column is there to tell nine identical
    // `node` rows apart and a line of nothing but `***` tells none of them.
    expect(p.cmd).toContain("--api-key");
    expect(p.cmd).toContain("--password");
  });

  it("keeps the list standing when only the second call fails", async () => {
    // `ps -M` loses a race with a process that exited between the two calls, and
    // a hardened environment refuses it outright. Neither is a reason to blank a
    // table whose CPU and memory columns are already correct — and the columns
    // that did not come back print a dash, never a zero.
    answer(ok(LIST), failed);
    const { procs } = await readProcesses("darwin", true) as { procs: Proc[] };
    const p = procs.find(x => x.pid === 4242)!;
    expect(p).toMatchObject({ cpu: 12.5, mem: 3.1 });
    expect(p.threads).toBeUndefined();
    expect(p.cmd).toBeUndefined();
  });

  it("reports no thread count rather than zero for a pid the listing named and did not describe", async () => {
    // Every process has at least one thread, so a zero is not a reading — it is
    // the listing having raced an exit — and a `0` in that column is a claim.
    answer(ok(LIST), ok(detailListing(0)));
    const { procs } = await readProcesses("darwin", true) as { procs: Proc[] };
    const p = procs.find(x => x.pid === 4242)!;
    expect(p.threads).toBeUndefined();
    // The command tail still arrives: the two facts come from one call and one
    // missing half must not take the other with it.
    expect(p.cmd).toContain("/srv/x.js");
  });

  it("does not serve a detail request from the plain reading it is holding", async () => {
    // The panel's cheap poll and the modal's detailed one share one cache. The
    // other direction is fine — a reading with more in it than the caller draws
    // — but answering the modal from a plain one leaves four columns empty for
    // up to a poll, with nothing on screen to say why.
    answer(ok(LIST));
    await readProcesses("darwin");
    expect(spawns).toHaveLength(1);

    // Immediately after, well inside the 1.5s the reading is held for.
    answer(ok(LIST), ok(detailListing(3)));
    const { procs } = await readProcesses("darwin", true) as { procs: Proc[] };
    expect(spawns.map(s => s.args[0]), "the detail call was served from the plain cache")
      .toEqual(["-Aceo", "-Aceo", "-M"]);
    expect(procs.find(x => x.pid === 4242)!.threads).toBe(3);
  });
});
