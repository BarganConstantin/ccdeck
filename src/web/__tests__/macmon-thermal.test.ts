// Degrees on Apple Silicon, from a tool the user already has (#747).
//
// There is no command shipped with macOS that prints a CPU or GPU temperature
// on an M-series Mac. `powermetrics` needs root. `pmset -g therm` records
// nothing there and answers "No CPU power status has been recorded", which is
// why the throttle row is missing too. The AGX driver does not publish the
// `"Temperature(C)"` that ioreg reads on Intel GPUs. The SMC keys changed with
// M1 and are inconsistent between models sharing one chip — an M1 Mac mini uses
// different FourCCs from an M1 MacBook Pro — so there is nothing to hard-code.
//
// The sensors ARE reachable without root, through a HID sensor hub, which is a
// private C API. Every tool that reads them is native code, and this package
// has zero runtime dependencies. So the deck asks a tool the user installed,
// the same way it already asks `cswap` about accounts and `ccusage` about
// spend. `macmon` is in homebrew-core, runs without sudo, covers M1 through M5,
// and prints JSON.
//
// Written on an Intel Mac, which is the machine that can never reach this code
// — ioreg answers there. So the reader is driven against a real fake binary on
// disk, and the ordering rule is a pure function.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain .mjs modules, no types
const { tempsFromMacmonJson, readMacmonTemps, macmonBin, resetMacmonBin, MACMON_ARGS } =
  await import("../../server/macmon.mjs");
// @ts-expect-error — ditto
const { darwinThermal } = await import("../../server/system-metrics.mjs");

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-macmon-"));
afterAll(() => { rmTempDir(DIR); });
beforeEach(() => { resetMacmonBin(); });

/** A macmon that is really on disk and really runs, so the spawn, the argv and
 *  the parse are all exercised rather than described. */
function fakeMacmon(name: string, body: string): string {
  const p = join(DIR, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("reading one sample", () => {
  it("takes the two fields macmon's own struct declares", () => {
    // Read off TempMetrics upstream rather than guessed from an example: a
    // field renamed there should read as "no sensor", never as zero.
    expect(tempsFromMacmonJson('{"temp":{"cpu_temp_avg":47.3,"gpu_temp_avg":36.2}}'))
      .toEqual({ cpu: 47, gpu: 36 });
  });

  it("drops a zero, which is the absence of a reading wearing a number", () => {
    // macmon defaults both fields to 0.0 and fills what it read, so a machine
    // that answered for the CPU and not the GPU arrives exactly like this.
    expect(tempsFromMacmonJson('{"temp":{"cpu_temp_avg":47.3,"gpu_temp_avg":0}}'))
      .toEqual({ cpu: 47 });
    expect(tempsFromMacmonJson('{"temp":{"cpu_temp_avg":0,"gpu_temp_avg":0}}')).toEqual({});
  });

  it("answers nothing for every shape that is not a sample", () => {
    for (const junk of ['{"temp":{"cpu":47}}', "{}", "null", "[]", "not json", "", undefined]) {
      expect(tempsFromMacmonJson(junk as string)).toEqual({});
    }
  });

  it("refuses a number no sensor produces", () => {
    for (const v of [-5, 0, 150, 1e9]) {
      expect(tempsFromMacmonJson(JSON.stringify({ temp: { cpu_temp_avg: v } }))).toEqual({});
    }
  });
});

describe("asking the binary", () => {
  it("asks for one sample and a short window", async () => {
    // `-i` is the sampling window and its default is a full second. A poll
    // every ten seconds must not cost one.
    expect(MACMON_ARGS).toEqual(["pipe", "-s", "1", "-i", "200"]);
  });

  it("runs it and reads what it printed", async () => {
    const bin = fakeMacmon("macmon-ok", `echo '{"temp":{"cpu_temp_avg":51.8,"gpu_temp_avg":44.1}}'`);
    expect(await readMacmonTemps({ candidates: [bin], exists: (p: string) => p === bin, probe: async (b: string) => b === bin }))
      .toEqual({ cpu: 52, gpu: 44 });
  });

  it("finds the JSON even if something spoke first", async () => {
    const bin = fakeMacmon("macmon-noisy", `echo 'warming up'\necho '{"temp":{"cpu_temp_avg":40}}'`);
    expect(await readMacmonTemps({ candidates: [bin], exists: (p: string) => p === bin, probe: async (b: string) => b === bin }))
      .toEqual({ cpu: 40 });
  });

  it("answers nothing when the binary fails rather than letting it throw", async () => {
    const bin = fakeMacmon("macmon-bad", "exit 3");
    expect(await readMacmonTemps({ candidates: [bin], exists: (p: string) => p === bin, probe: async (b: string) => b === bin }))
      .toEqual({});
  });

  it("spawns nothing at all on a machine that has no macmon", async () => {
    let probes = 0;
    const deps = { candidates: [], exists: () => false, probe: async () => { probes++; return false; } };
    expect(await readMacmonTemps(deps)).toEqual({});
    const afterFirst = probes;
    // And not again. A "looked, not there" answer is remembered, or every
    // Apple Silicon Mac without macmon pays a lookup every ten seconds forever.
    expect(await readMacmonTemps(deps)).toEqual({});
    expect(probes).toBe(afterFirst);
    expect(await macmonBin(deps)).toBeNull();
  });

  it("remembers the one it found, too", async () => {
    const bin = fakeMacmon("macmon-memo", `echo '{"temp":{"cpu_temp_avg":33}}'`);
    let probes = 0;
    const deps = {
      candidates: [bin],
      exists: (p: string) => p === bin,
      probe: async (b: string) => { probes++; return b === bin; },
    };
    expect(await macmonBin(deps)).toBe(bin);
    const afterFirst = probes;
    expect(await macmonBin(deps)).toBe(bin);
    expect(probes).toBe(afterFirst);
  });
});

describe("which source wins on macOS", () => {
  it("keeps ioreg and pmset when macOS answered, and never shows macmon's numbers over them", () => {
    // The Intel path, unchanged. These are the same numbers this deck has
    // always shown and they cost one cheap subprocess each.
    expect(darwinThermal({ gpuC: 59, throttle: { speedLimit: 100 }, macmon: { cpu: 99, gpu: 99 } }))
      .toEqual({
        celsius: [{ label: "GPU", celsius: 59, warnAt: 75, critAt: 90 }],
        throttle: { speedLimit: 100 },
      });
  });

  it("uses macmon only when both were silent, CPU first", () => {
    // On the machine that reaches here the CPU is the reading somebody opened
    // the panel for, and the panel draws rows in the order given.
    expect(darwinThermal({ macmon: { cpu: 47, gpu: 36 } })).toEqual({
      celsius: [
        { label: "CPU", celsius: 47, warnAt: 75, critAt: 90 },
        { label: "GPU", celsius: 36, warnAt: 75, critAt: 90 },
      ],
      throttle: null,
    });
  });

  it("renders no section at all when nothing answered", () => {
    // An Apple Silicon Mac without macmon, which is the default. Not 0 °C, not
    // a dash, not an empty bar — the rule the whole module is built on.
    expect(darwinThermal({})).toBeNull();
    expect(darwinThermal({ macmon: {} })).toBeNull();
  });

  it("still shows a throttle row on its own, with no degrees anywhere", () => {
    // An Intel Mac whose GPU key is missing but whose pmset answers.
    expect(darwinThermal({ throttle: { speedLimit: 70 } }))
      .toEqual({ celsius: [], throttle: { speedLimit: 70 } });
  });
});
