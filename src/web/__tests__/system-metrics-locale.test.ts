// The decimal separator, and the two readouts a whole continent never saw.
//
// `ps` and `sysctl` honour LC_NUMERIC. On a machine set to de_DE, fr_FR, ru_RU
// or pt_BR — comma is the decimal separator for most of Europe and Latin
// America — the same commands this module parses print:
//
//     ps      1   0,2  0,0 /sbin/launchd
//     sysctl  total = 8192,00M  used = 7189,75M  free = 1002,25M
//
// Both parsers required a `.`, so neither matched anything at all. Not
// partially: parsePsProcesses `continue`s on every row, so the process panel was
// permanently empty, and swapFromSysctl returned null, so the macOS swap meter
// was permanently blank. No error, nothing in the log, on a machine where every
// other part of the deck worked.
//
// Reproduced before the fix, on the machine this was written on:
//
//     $ LC_ALL=de_DE.UTF-8 ps -eo pid,pcpu,pmem,comm | head -2
//       PID  %CPU %MEM COMM
//         1   0,2  0,0 /sbin/launchd
//     $ LC_ALL=de_DE.UTF-8 sysctl -n vm.swapusage
//     total = 8192,00M  used = 7189,75M  free = 1002,25M  (encrypted)
//
// CI never saw it because runners run in the C locale, and every fixture in
// system-metrics.test.ts uses a dot. There is no skipIf hiding this — the case
// simply was not written.
//
// Two halves are tested here, and the order matters. Forcing the child's locale
// is the fix: it makes the output invariant, which is what every parser here was
// written against and what every parser added later will assume. Accepting a
// comma is defence in depth for a stripped environment, and is only safe because
// both fields are printed with printf's %f, which never groups thousands — so a
// comma in either can only be the decimal point.
import { describe, it, expect, vi, afterEach } from "vitest";

const { spawns } = vi.hoisted(() => ({ spawns: [] as { file: string; opts: Record<string, unknown> }[] }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (file: string, _args: string[], opts: Record<string, unknown>) => {
      spawns.push({ file, opts });
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.kill = () => {};
      // Answer on the next tick with something the parser accepts, so the
      // promise settles and the assertion is about the spawn rather than about
      // whatever this machine's ps would have said.
      queueMicrotask(() => {
        child.stdout.emit("data", "  PID  %CPU %MEM COMM\n    1   0.2  0.0 launchd\n");
        child.emit("close", 0);
      });
      return child;
    },
  };
});

// @ts-expect-error — plain .mjs server module, no types
import { parsePsProcesses, readProcesses, stopSystemMetrics, swapFromSysctl } from "../../server/system-metrics.mjs";

// The reading goes with the recorded spawns. Since #544 readProcesses holds the
// last list it produced for PROC_MIN_GAP_MS and answers anyone who arrives
// inside that window from it rather than starting a second child — which is the
// point of it, and which means a case here that wants its own spawn has to say
// that the previous reading is finished with. stopSystemMetrics is the module's
// own reset and drops it along with the CPU baseline.
afterEach(() => { spawns.length = 0; stopSystemMetrics(); });

describe("the locale the sampler's children run in", () => {
  it("forces the number format, whatever the deck itself was started with", async () => {
    await readProcesses("linux");
    expect(spawns).toHaveLength(1);
    const env = spawns[0].opts.env as Record<string, string>;
    expect(env.LC_NUMERIC).toBe("C");
  });

  it("clears LC_ALL, because a user's own LC_ALL would outrank LC_NUMERIC", async () => {
    // POSIX ignores an empty LC_ALL, so this is what makes the override hold on
    // a machine where the reader set LC_ALL=de_DE themselves. Measured: with
    // LC_ALL left alone, `ps -o pcpu` still printed 0,4.
    await readProcesses("linux");
    const env = spawns[0].opts.env as Record<string, string>;
    expect(env.LC_ALL).toBe("");
  });

  it("leaves the CHARACTER SET alone, so a non-Latin name survives", async () => {
    // It used to force the whole locale, and `LC_ALL=C` makes ps escape every
    // byte it cannot render as ASCII: `Яндекс Музыка` came back as
    // `M-PM-/M-PM-=M-PM-4M-PM-5...`, ninety-one characters of noise. The panel
    // truncated it into invisibility; the process list has room for all of it.
    await readProcesses("linux");
    const env = spawns[0].opts.env as Record<string, string>;
    expect(env.LANG, "LANG is inherited, not overridden").toBe(process.env.LANG);
    expect(env.LC_CTYPE).toBe(process.env.LC_CTYPE);
  });

  it("keeps the rest of the environment, because PATH is how ps is found", async () => {
    // A child handed a bare `{ LC_ALL: "C" }` has no PATH, and `ps` is not an
    // absolute path here. Overriding the locale must not amount to emptying the
    // environment.
    await readProcesses("linux");
    const env = spawns[0].opts.env as Record<string, string>;
    expect(env.PATH ?? env.Path).toBeTruthy();
  });
});

describe("the parsers, if the environment is stripped anyway", () => {
  it("reads ps rows whose percentages use a comma", () => {
    const text = [
      "  PID  %CPU %MEM COMM",
      "    1   0,2  0,0 /sbin/launchd",
      "69696  84,5  0,4 Brave Browser Helper",
    ].join("\n");
    expect(parsePsProcesses(text)).toEqual([
      { pid: 1, cpu: 0.2, mem: 0, name: "/sbin/launchd" },
      { pid: 69696, cpu: 84.5, mem: 0.4, name: "Brave Browser Helper" },
    ]);
  });

  it("reads a comma sysctl line as the same swap a dot one reports", () => {
    const comma = swapFromSysctl("total = 8192,00M  used = 7189,75M  free = 1002,25M  (encrypted)");
    const dot = swapFromSysctl("total = 8192.00M  used = 7189.75M  free = 1002.25M  (encrypted)");
    expect(comma).toEqual(dot);
    expect(comma.total).toBe(8192 * 1024 ** 2);
  });

  it("still refuses a field that is not a number at all", () => {
    // The tolerance is one separator, not a licence to parse anything.
    expect(swapFromSysctl("total = eightK  used = 1.00M")).toBeNull();
    expect(parsePsProcesses("  PID  %CPU %MEM COMM\n    x   0,2  0,0 launchd")).toEqual([]);
  });
});
