// The four columns the process modal grew, and the one thing they cost.
//
// The panel's list answers "what is eating this machine". It could not answer
// "which of these nine `Google Chrome Helper` rows is the headless Chrome I
// left running", because every one of them printed the same four fields, and
// the only distinguishing thing — the argument vector — was deliberately not
// read. `comm` was the whole of the name, on purpose: `args` carries prompts
// and tokens, and this deck serves its process list on a loopback port.
//
// WHAT WAS MEASURED BEFORE ANY OF THIS WAS WRITTEN, because two of the four
// columns people ask for cannot be had at all and one is not what it looks
// like. On this machine, unprivileged, repeated:
//
//   ps -Aceo …                              0.10s
//   ps -M -p <40 pids>                       0.15s   threads AND argv, one child
//   top -l 1 -stats th,ports                 4.25s   on an IDLE machine
//
// So: threads are cheap on every platform (procps has `nlwp`, BSD has the `-M`
// listing, Get-Process has Threads.Count). PORTS is a Mach concept that does
// not exist on Linux, is not what Windows calls a handle, and on macOS costs
// four seconds against a four-second poll — it is not a column here and the
// reason is this paragraph.
//
// And MEMORY IN BYTES IS NOT ACTIVITY MONITOR'S NUMBER. `ps` reports resident
// set size; the column macOS Activity Monitor draws is `phys_footprint`.
// Measured against `top`'s MEM on the same processes at the same instant:
// dotnet 37 MB against 534, rider 1300 against 3833, one Brave renderer 240
// against 153 — ratios from 0.02 to 1.57. RSS is what `ps` and Task Manager
// report and is the same measurement on all three platforms, so it is what
// ships, and the modal's footer says so rather than leaving a reader to
// discover it by comparing two windows.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs server module, no types
import {
  redactCommand, commandTail, elapsedSeconds,
  parsePsThreadsBsd, parsePsThreadsProcps, psDetailArgs, CMD_MAX,
} from "../../server/system-metrics.mjs";
import { sortProcs, nextSort, SORT_DEFAULT, type Proc, type Sort } from "../components/SystemMeter";
import { fmtBytes, fmtUptime } from "../components/ProcessListModal";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const server = read("../../server/system-metrics.mjs");
const route = read("../../server/index.mjs");
const meter = read("../components/SystemMeter.tsx");
const modal = read("../components/ProcessListModal.tsx");

describe("what the command column may carry", () => {
  it("takes the value off every flag that names a secret", () => {
    for (const flag of [
      "--token", "--api-key", "--apikey", "--password", "--passwd", "--secret",
      "--auth-token", "--bearer", "--session-id", "--private-key", "-Credential",
    ]) {
      const out = redactCommand(`run ${flag}=s3cr3tvalue --port 3000`);
      expect(out, `${flag}= kept its value`).not.toContain("s3cr3tvalue");
      expect(out, `${flag}= lost its own name`).toContain(flag);
      const spaced = redactCommand(`run ${flag} s3cr3tvalue --port 3000`);
      expect(spaced, `${flag} <value> kept its value`).not.toContain("s3cr3tvalue");
    }
  });

  it("takes the password out of a URL and leaves the address", () => {
    const out = redactCommand("psql postgres://admin:hunter2@db.internal:5432/prod");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("postgres://admin:");
    expect(out).toContain("@db.internal:5432/prod");
  });

  it("takes a token that has no flag in front of it", () => {
    // The shapes that are self-identifying, so an argv that simply names one
    // positionally is still caught.
    for (const secret of [
      "sk-abcdefghijklmnopqrstuvwx",
      "ghp_abcdefghijklmnopqrstuvwxyz01",
      "xoxb-1234567890-abcdefghijkl",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ]) {
      expect(redactCommand(`curl -H ${secret} https://api.example.com`), secret).not.toContain(secret);
    }
  });

  it("shortens the reader's own home to a tilde", () => {
    expect(redactCommand("ng serve --ssl-cert /Users/ada/certs/x.pem", "/Users/ada"))
      .toBe("ng serve --ssl-cert ~/certs/x.pem");
    // A home that is a prefix of an unrelated word is not a path segment.
    expect(redactCommand("run /Users/adamant/thing", "/Users/ada")).toContain("/Users/adamant/thing");
  });

  it("caps what goes on the wire, because one browser argv is 906 characters", () => {
    const long = "--flag=" + "x".repeat(2000);
    const out = redactCommand(long);
    expect(out.length).toBeLessThanOrEqual(CMD_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("is a filter and says so where a reader will see it", () => {
    // The one claim this must never make. A blocklist catches the shapes a
    // secret usually takes and cannot catch one that looks like a word, so the
    // footer says "a filter and not a guarantee" and this pins that it does.
    expect(modal).toMatch(/which is a filter and not a guarantee/);
    expect(server).toMatch(/THIS IS A BLOCKLIST AND A BLOCKLIST LEAKS/);
  });

  it("runs on the server, so a leaked value never reaches the wire at all", () => {
    // /api/system/processes answers anything that can reach the loopback port.
    // Redacting on the client would mean the token shipped and was then hidden.
    expect(server).toMatch(/redactCommand\(commandTail\(/);
    expect(modal).not.toMatch(/redactCommand/);
  });
});

describe("the executable comes off the front of the arguments", () => {
  it("cuts at the path segment that ends with the name, not the first match", () => {
    // A macOS bundle contains the name twice. `indexOf` left every browser row
    // reading `.app/Contents/MacOS/Google Chrome Helper --type=…`, having spent
    // the budget on the half of the path it was meant to remove.
    const argv = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/"
      + "Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process";
    expect(commandTail(argv, "Google Chrome Helper")).toBe("--type=gpu-process");
  });

  it("does not cut inside a longer word", () => {
    // `lastIndexOf` is wrong the other way round.
    expect(commandTail("node /srv/node_modules/.bin/vitest run", "node"))
      .toBe("/srv/node_modules/.bin/vitest run");
  });

  it("will not take a name that merely ENDS a longer word either", () => {
    // The other half of "a segment ends here", and the half the macOS bundle
    // case does not exercise: there the false match is rejected by what FOLLOWS
    // it. Here the name sits at the tail of a later argument, so only what
    // precedes it can say this is not the executable. Without that check the
    // cut lands mid-argv and the row loses the argument it was named for.
    expect(commandTail("/usr/bin/python3 latest_test --verbose", "test"))
      .toBe("latest_test --verbose");
    expect(commandTail("/opt/bin/runner subtask --once", "task")).toBe("subtask --once");
  });

  it("keeps the argument that identifies an interpreter's work", () => {
    expect(commandTail("/usr/local/bin/dotnet exec --runtimeconfig a.json", "dotnet"))
      .toBe("exec --runtimeconfig a.json");
    expect(commandTail("ng serve admin-portal --port 44440", "ng")).toBe("serve admin-portal --port 44440");
  });

  it("leaves a name it cannot find alone unless it looks like a path", () => {
    // A Linux `comm` is capped at 15 characters, so the name may genuinely not
    // be in argv. Dropping the first word of something already short would take
    // the only word there was.
    expect(commandTail("mycommand --flag", "truncated-name")).toBe("mycommand --flag");
    expect(commandTail("/opt/x/mycommand --flag", "truncated-name")).toBe("--flag");
  });

  it("says nothing for a process that is only a name", () => {
    expect(commandTail("(ccusage)", "(ccusage)")).toBe("");
    expect(commandTail("", "x")).toBe("");
  });
});

describe("how long it has been up", () => {
  it("reads every shape ps prints, and only those", () => {
    expect(elapsedSeconds("00:01")).toBe(1);
    expect(elapsedSeconds("40:24")).toBe(2424);
    expect(elapsedSeconds("12:49:43")).toBe(46183);
    expect(elapsedSeconds("3-04:05:06")).toBe(273906);
    // Not a reading, and null rather than 0: a process up for no time and a
    // process whose uptime could not be read are different facts.
    for (const junk of ["", "ELAPSED", "nope", "1:2:3:4"]) expect(elapsedSeconds(junk), junk).toBeNull();
  });

  it("prints one unit, because nobody reads this to the minute", () => {
    expect(fmtUptime(45)).toBe("45s");
    expect(fmtUptime(600)).toBe("10m");
    expect(fmtUptime(7200)).toBe("2h");
    expect(fmtUptime(3 * 86400 + 3600)).toBe("3d");
    expect(fmtUptime(undefined)).toBe("—");
  });
});

describe("memory, printed as the quantity it is", () => {
  it("carries three significant figures and a binary unit", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2517368 * 1024)).toBe("2.4 GB");
    expect(fmtBytes(725 * 1024 * 1024)).toBe("725 MB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
  });

  it("prints a dash for a reading that did not come back", () => {
    // Never a zero. A Windows process this session may not open has an unknown
    // working set, and "0 B" would be a claim about it.
    expect(fmtBytes(undefined)).toBe("—");
    expect(fmtBytes(NaN)).toBe("—");
  });
});

describe("the thread count, per platform, out of the call that also has argv", () => {
  it("counts the lines under a BSD listing and keeps the process line's argv", () => {
    const out = [
      "USER         PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND",
      "root         105   ??    0.0 S     4T   0:00.17   0:00.08 /usr/sbin/systemstats --daemon",
      "             105         0.2 S     4T   0:00.00   0:00.00 ",
      "             105         0.2 S     4T   0:00.00   0:00.00 ",
      "constantin  7885   ??    9.1 S    31T   1:02.03   9:10.11 /usr/local/bin/claude --print",
      "            7885         0.0 S     4T   0:00.00   0:00.00 ",
    ].join("\n");
    const map = parsePsThreadsBsd(out);
    expect(map.get(105)).toEqual({ threads: 2, cmd: "/usr/sbin/systemstats --daemon" });
    expect(map.get(7885)).toEqual({ threads: 1, cmd: "/usr/local/bin/claude --print" });
    // The header names a column, not a process.
    expect(map.has(NaN)).toBe(false);
    expect([...map.keys()]).toEqual([105, 7885]);
  });

  it("reads procps' own count, where it is a column", () => {
    const map = parsePsThreadsProcps([
      "    PID NLWP COMMAND",
      "   4821   17 node /srv/app.js --port 3000",
      "      1    1 /sbin/init",
    ].join("\n"));
    expect(map.get(4821)).toEqual({ threads: 17, cmd: "node /srv/app.js --port 3000" });
    expect(map.get(1)).toEqual({ threads: 1, cmd: "/sbin/init" });
  });

  it("asks each platform in its own spelling, scoped to the candidates", () => {
    // Whole-machine would be several hundred pids to answer a question about
    // forty, and this is the expensive half of the read.
    expect(psDetailArgs([7, 8, 9], "linux")).toEqual(["-o", "pid,nlwp,args", "-p", "7,8,9"]);
    expect(psDetailArgs([7, 8, 9], "darwin")).toEqual(["-M", "-p", "7,8,9"]);
    expect(psDetailArgs([7], "freebsd")).toEqual(psDetailArgs([7], "darwin"));
  });

  it("never reports zero threads, because every process has one", () => {
    // A pid named by the listing with no thread lines under it is a race with
    // an exit, and a `0` in that column would be a claim.
    expect(server).toMatch(/if \(d\.threads > 0\) p\.threads = d\.threads;/);
  });
});

describe("the second child is the modal's, not the panel's", () => {
  it("is gated on a query flag rather than always paid", () => {
    // Measured: 141ms and 7 KB without it, 251ms and 13 KB with. The panel
    // draws four columns and needs none of it, so on a deck whose modal is
    // never opened the argument vector is never read at all.
    expect(route).toMatch(/url\.searchParams\.get\("detail"\) === "1"/);
    expect(server).toMatch(/if \(detail\) await attachDetail\(procs, platform\);/);
    expect(meter).toMatch(/\/api\/system\/processes\$\{detail \? "\?detail=1" : ""\}/);
  });

  it("re-polls when the flag changes, or the modal opens onto four dashes", () => {
    expect(meter).toMatch(/\}, \[on, detail\]\);/);
    expect(meter).toMatch(/useProcesses\(true, allProcs\)/);
  });

  it("does not serve a detailed request from a plain cached reading", () => {
    // The other direction is fine: the panel is happy with a reading that has
    // more in it than it draws.
    expect(server).toMatch(/\(procLast\.detail \|\| !detail\)/);
    expect(server).toMatch(/\(procInFlightDetail \|\| !detail\)/);
  });

  it("keeps the list standing when only the second call fails", () => {
    // `ps -M` can lose a race with an exit or be refused outright, and neither
    // is a reason to blank a table whose CPU and memory columns are correct.
    const block = server.slice(server.indexOf("async function attachDetail"));
    expect(block.slice(0, block.indexOf("\n}"))).toMatch(/catch \{ return; \}/);
  });
});

describe("sorting the columns that can be absent", () => {
  const row = (p: Partial<Proc> & { pid: number }): Proc =>
    ({ cpu: 1, mem: 1, name: `p${p.pid}`, ...p });
  const order = (procs: Proc[], sort: Sort) => sortProcs(procs, sort).map(p => p.pid);

  it("puts a missing reading last whichever way the arrow points", () => {
    // The rule CPU has always had, extended to the three that can now be
    // absent: a row whose thread count did not come back is not a row with no
    // threads, and the cell prints a dash for it.
    const rows = [row({ pid: 1, threads: 4 }), row({ pid: 2 }), row({ pid: 3, threads: 9 })];
    expect(order(rows, { key: "threads", dir: "desc", rank: "cpu" })).toEqual([3, 1, 2]);
    expect(order(rows, { key: "threads", dir: "asc", rank: "cpu" })).toEqual([1, 3, 2]);
    const ups = [row({ pid: 1, uptimeSec: 10 }), row({ pid: 2 }), row({ pid: 3, uptimeSec: 99 })];
    expect(order(ups, { key: "uptime", dir: "desc", rank: "cpu" })).toEqual([3, 1, 2]);
    const users = [row({ pid: 1, user: "root" }), row({ pid: 2 }), row({ pid: 3, user: "ada" })];
    expect(order(users, { key: "user", dir: "asc", rank: "cpu" })).toEqual([3, 1, 2]);
  });

  it("ranks memory as memory whichever of its two readings asked", () => {
    // `rank` decides which candidates the panel draws, and the server sends a
    // union of a CPU ranking and a memory one. `rss` and `mem` are one quantity
    // read two ways, so the column that shows bytes stands on the same ranking
    // the percentage does; a column that merely orders rows leaves it alone.
    expect(nextSort(SORT_DEFAULT, "rss").rank).toBe("mem");
    expect(nextSort(SORT_DEFAULT, "threads").rank).toBe("cpu");
    expect(nextSort({ key: "mem", dir: "desc", rank: "mem" }, "user").rank).toBe("mem");
  });

  it("opens a name-shaped column A to Z and a quantity biggest first", () => {
    expect(nextSort(SORT_DEFAULT, "user").dir).toBe("asc");
    expect(nextSort(SORT_DEFAULT, "name").dir).toBe("asc");
    for (const key of ["rss", "threads", "uptime"] as const) {
      expect(nextSort(SORT_DEFAULT, key).dir, key).toBe("desc");
    }
  });

  it("sorts memory by the figure the cell prints", () => {
    // They order identically on the Unixes, where both come from RSS, and
    // differently on Windows, where the percentage is private bytes and the
    // column is the working set. Sorting by one and showing the other would be
    // right on two platforms out of three.
    expect(modal).toMatch(/<SortHead\s+col="rss"\s+label="memory"/);
    expect(modal).toMatch(/fmtBytes\(p\.rssBytes\)/);
  });
});
