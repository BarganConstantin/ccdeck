// Is this machine getting hot, and is it being held back for it (#738).
//
// The four sections above this one in the panel answer "how much work" and "who
// is doing it". They cannot tell a saturated machine that is cool — one doing
// the work you asked for — from one that is thermally limited, where the next
// agent you launch makes everything slower. A load average of 67 reads the same
// in both.
//
// THREE PLATFORMS ANSWER THREE DIFFERENT QUESTIONS, so almost all of this file
// is per-platform parsing, and every parser here is checkable from a machine
// that is not the platform it is about. That is not a nicety: there is no Linux
// box here and no container runtime, so the alternative to a fixture is a regex
// nobody has ever run.
//
// The two things a fixture cannot check are checked another way. The directory
// WALK is exercised against a real tree written to disk, because a fixture of a
// walk's output cannot catch a walk that looks in the wrong place. And the
// live reader is called on whatever machine the suite is running on, ungated,
// so all three CI legs prove their own branch does not throw and does not
// invent a reading.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  celsiusFromMilli, gpuFromIoreg, heldShare as serverHeldShare, pickThermalRows, readHwmon, readThermal,
  parseWinThermal, readThermalZones, readThrottleTime, throttleFromPmset, throttleFromTime,
} from "../../server/thermal-metrics.mjs";
import { sampleThermal, stopSystemMetrics } from "../../server/system-metrics.mjs";
import { thermalSnapshot } from "../../server/thermal-sampler.mjs";
import { heldShare } from "../machine-live";
import { thermalTone, throttleRow } from "../machine-readings";

describe("millidegrees, which is the unit every Linux sensor speaks", () => {
  it("reads a package sensor", () => {
    expect(celsiusFromMilli("61000\n")).toBe(61);
  });

  it("refuses a reading that is not a temperature", () => {
    // Both ends of this have been produced by reading the right file with the
    // wrong unit, and both look plausible enough to print.
    expect(celsiusFromMilli("0")).toBeNull();
    expect(celsiusFromMilli("61000000")).toBeNull();
    expect(celsiusFromMilli("-40000")).toBeNull();
    expect(celsiusFromMilli("")).toBeNull();
    expect(celsiusFromMilli(null)).toBeNull();
  });
});

describe("which of a machine's sensors the panel names", () => {
  // What a real desktop publishes: a package, four cores, an SSD and a radio.
  const sensors = [
    { chip: "coretemp", label: "Core 0", celsius: 52, warnAt: 100, critAt: 100 },
    { chip: "coretemp", label: "Package id 0", celsius: 58, warnAt: 84, critAt: 100 },
    { chip: "coretemp", label: "Core 3", celsius: 71, warnAt: 100, critAt: 100 },
    { chip: "nvme", label: "Composite", celsius: 44, warnAt: 75, critAt: 90 },
    { chip: "iwlwifi_1", label: null, celsius: 39, warnAt: 75, critAt: 90 },
    { chip: "amdgpu", label: "junction", celsius: 74, warnAt: 90, critAt: 100 },
    { chip: "amdgpu", label: "edge", celsius: 61, warnAt: 90, critAt: 100 },
  ];

  it("takes the package rather than the hottest core", () => {
    // A single core's number is noisier and lower than the die it sits on, and
    // `Core 3` at 71 would have won a plain maximum.
    const [cpu] = pickThermalRows(sensors);
    expect([cpu.label, cpu.celsius]).toEqual(["CPU", 58]);
  });

  it("takes the GPU's edge rather than its hotspot", () => {
    // `junction` is the hotspot and reads higher; `edge` is what every other
    // tool on the machine calls the GPU temperature, so it is what a reader
    // will compare this against.
    const gpu = pickThermalRows(sensors)[1];
    expect([gpu.label, gpu.celsius]).toEqual(["GPU", 61]);
  });

  it("leaves the drive and the radio alone", () => {
    // They are real sensors and they are not what this section is about. Two
    // rows is what the panel has room for and what somebody watching a build
    // wants.
    expect(pickThermalRows(sensors)).toHaveLength(2);
  });

  it("prefers Tdie over Tctl on AMD, because Tctl is an offset", () => {
    // Tctl is Tdie plus a vendor offset that exists for fan control. It is not
    // the die temperature and printing it as one overstates by up to 27°C on
    // some parts.
    const [cpu] = pickThermalRows([
      { chip: "k10temp", label: "Tctl", celsius: 72, warnAt: 95, critAt: 100 },
      { chip: "k10temp", label: "Tdie", celsius: 55, warnAt: 95, critAt: 100 },
    ]);
    expect(cpu.celsius).toBe(55);
  });

  it("falls back to Tctl when the part publishes no Tdie", () => {
    const [cpu] = pickThermalRows([{ chip: "k10temp", label: "Tctl", celsius: 61, warnAt: 95, critAt: 100 }]);
    expect(cpu.celsius).toBe(61);
  });

  it("takes the hottest when a chip labels nothing it recognises", () => {
    // The question is "is it getting hot", so the hottest sensor of the chip
    // that owns the CPU is the honest answer to it.
    const [cpu] = pickThermalRows([
      { chip: "coretemp", label: null, celsius: 40, warnAt: 100, critAt: 100 },
      { chip: "coretemp", label: null, celsius: 66, warnAt: 100, critAt: 100 },
    ]);
    expect(cpu.celsius).toBe(66);
  });

  it("names nothing when nothing it knows about published a reading", () => {
    expect(pickThermalRows([{ chip: "nvme", label: "Composite", celsius: 44, warnAt: 75, critAt: 90 }])).toEqual([]);
    expect(pickThermalRows([])).toEqual([]);
    expect(pickThermalRows(undefined)).toEqual([]);
  });
});

describe("the Linux walk, against a real tree on disk", () => {
  // The walk is the half a fixture of its output cannot check: a walk that
  // looks in the wrong place produces the same empty array as a machine with
  // no sensors.
  const build = async () => {
    const root = await mkdtemp(join(tmpdir(), "hwmon-"));
    const chip = async (dir: string, name: string, files: Record<string, string>) => {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, "name"), `${name}\n`);
      for (const [f, v] of Object.entries(files)) await writeFile(join(root, dir, f), v);
    };
    await chip("hwmon0", "acpitz", { temp1_input: "27800\n" });
    await chip("hwmon2", "coretemp", {
      temp1_input: "58000\n", temp1_label: "Package id 0\n", temp1_max: "84000\n", temp1_crit: "100000\n",
      temp2_input: "52000\n", temp2_label: "Core 0\n",
    });
    await chip("hwmon3", "amdgpu", { temp1_input: "61000\n", temp1_label: "edge\n", temp1_crit: "100000\n" });
    // What an Intel package sensor actually publishes: max and crit are the
    // same number. Read off a live machine, not invented.
    await chip("hwmon4", "coretemp", {
      temp1_input: "88000\n", temp1_label: "Package id 1\n",
      temp1_max: "100000\n", temp1_crit: "100000\n",
    });
    return root;
  };

  it("finds every sensor, with the chip that published it", async () => {
    const root = await build();
    try {
      const found = await readHwmon(root);
      expect(found.map(s => `${s.chip}:${s.label ?? "-"}:${s.celsius}`).sort()).toEqual([
        "acpitz:-:28",
        "amdgpu:edge:61",
        "coretemp:Core 0:52",
        "coretemp:Package id 0:58",
        "coretemp:Package id 1:88",
      ]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("takes the chip's own warning bands where it publishes them", async () => {
    // A laptop package sensor and an NVMe drive do not share a comfortable
    // range, so one scale for both would be a threshold this app invented.
    const root = await build();
    try {
      const pkg = (await readHwmon(root)).find(s => s.label === "Package id 0")!;
      expect([pkg.warnAt, pkg.critAt]).toEqual([84, 100]);
      const core = (await readHwmon(root)).find(s => s.label === "Core 0")!;
      expect([core.warnAt, core.critAt], "the fallback bands").toEqual([75, 90]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a chip band that is not a band, which is every Intel coretemp", async () => {
    // Intel coretemp publishes temp*_max === temp*_crit. Taken literally that
    // is a zero-degree amber band: thermalTone goes calm -> hot at 100C, a
    // number a CPU reaches only as it shuts the machine down, so a package at
    // 88C drew the same grey as one at 45C. The 75/90 fallback that would have
    // said something useful was discarded precisely BECAUSE the chip published
    // its own numbers.
    const root = await build();
    try {
      const pkg = (await readHwmon(root)).find(s => s.label === "Package id 1")!;
      expect(pkg.celsius).toBe(88);
      expect(pkg.critAt, "crit is still the chip's own").toBe(100);
      expect(pkg.warnAt, "warn falls back rather than sitting on crit").toBe(75);
      expect(thermalTone(pkg.celsius, pkg.warnAt, pkg.critAt)).toBe("warn");
      // And a band that IS a band is still preferred over the fallback.
      const usable = (await readHwmon(root)).find(s => s.label === "Package id 0")!;
      expect([usable.warnAt, usable.critAt]).toEqual([84, 100]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the warn band under a chip whose crit is lower than our default", async () => {
    // A drive that acts at 70C must not be given a 75C warn line it can never
    // cross — the fallback is a ceiling, not a constant.
    const root = await mkdtemp(join(tmpdir(), "hwmon-low-"));
    try {
      await mkdir(join(root, "hwmon0"), { recursive: true });
      await writeFile(join(root, "hwmon0", "name"), "nvme\n");
      await writeFile(join(root, "hwmon0", "temp1_input"), "50000\n");
      await writeFile(join(root, "hwmon0", "temp1_max"), "70000\n");
      await writeFile(join(root, "hwmon0", "temp1_crit"), "70000\n");
      const [row] = await readHwmon(root);
      expect(row.critAt).toBe(70);
      expect(row.warnAt).toBe(63);
      expect(row.warnAt).toBeLessThan(row.critAt);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("says nothing rather than throwing when the tree is not there", async () => {
    // Every non-Linux machine, and a Linux kernel with no hwmon drivers.
    expect(await readHwmon(join(tmpdir(), "no-such-hwmon-tree"))).toEqual([]);
  });

  it("skips a sensor whose file cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "hwmon-"));
    try {
      await mkdir(join(root, "hwmon0"));
      await writeFile(join(root, "hwmon0", "name"), "coretemp\n");
      await writeFile(join(root, "hwmon0", "temp1_input"), "not a number\n");
      await writeFile(join(root, "hwmon0", "temp2_input"), "49000\n");
      expect((await readHwmon(root)).map(s => s.celsius)).toEqual([49]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("the thermal-zone fallback, for a machine with no hwmon driver", () => {
  const build = async (zones: Array<[string, string]>) => {
    const root = await mkdtemp(join(tmpdir(), "thermal-"));
    for (const [i, [type, milli]] of zones.entries()) {
      await mkdir(join(root, `thermal_zone${i}`), { recursive: true });
      await writeFile(join(root, `thermal_zone${i}`, "type"), `${type}\n`);
      await writeFile(join(root, `thermal_zone${i}`, "temp"), `${milli}\n`);
    }
    return root;
  };

  it("labels the row with the zone's own type, never with CPU", async () => {
    // A thermal zone is not a claim about what was measured. `acpitz` is the
    // motherboard's idea of ambient on a lot of hardware, and calling that the
    // CPU would be the same lie in a different place.
    const root = await build([["acpitz", "42000"]]);
    try {
      expect(await readThermalZones(root)).toEqual([{ label: "acpitz", celsius: 42, warnAt: 75, critAt: 90 }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("prefers a zone that names the package over a hotter unknown one", async () => {
    const root = await build([["acpitz", "77000"], ["x86_pkg_temp", "51000"]]);
    try {
      expect((await readThermalZones(root))[0].label).toBe("x86_pkg_temp");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("draws one row, not one per zone", async () => {
    const root = await build([["acpitz", "40000"], ["iwlwifi", "38000"], ["pch", "44000"]]);
    try {
      expect(await readThermalZones(root)).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("says nothing when the tree is absent", async () => {
    expect(await readThermalZones(join(tmpdir(), "no-such-thermal-tree"))).toEqual([]);
  });
});

describe("the Linux throttle count, against a real tree on disk", () => {
  // Linux answered `throttle: null` unconditionally until this, so the row was
  // never drawn there — on a machine whose kernel had logged 59 hours of
  // package throttling in 17 days. The walk is checked against a tree on disk
  // for the reason the hwmon walk is: a walk that looks in the wrong place
  // returns the same null as a machine that counts nothing.
  const build = async (cpus: Record<string, { pkg?: string; ms?: string }>, extra: string[] = []) => {
    const root = await mkdtemp(join(tmpdir(), "cpu-"));
    for (const [cpu, { pkg, ms }] of Object.entries(cpus)) {
      await mkdir(join(root, cpu, "topology"), { recursive: true });
      if (pkg != null) await writeFile(join(root, cpu, "topology", "physical_package_id"), `${pkg}\n`);
      if (ms != null) {
        await mkdir(join(root, cpu, "thermal_throttle"), { recursive: true });
        await writeFile(join(root, cpu, "thermal_throttle", "package_throttle_total_time_ms"), `${ms}\n`);
      }
    }
    // The siblings every real /sys/devices/system/cpu carries, which are not CPUs.
    for (const d of ["cpufreq", "cpuidle", ...extra]) await mkdir(join(root, d), { recursive: true });
    return root;
  };

  it("takes each package's count from the CPU that saw the most of it", async () => {
    // Every CPU carries its own copy of the package's count, and the copies
    // differ by the events each saw late. Read off a live i5-12600H.
    const root = await build({
      cpu0: { pkg: "0", ms: "212885052" },
      cpu15: { pkg: "0", ms: "212885101" },
      cpu16: { pkg: "1", ms: "500" },
    });
    try {
      expect(await readThrottleTime(root)).toEqual({ "0": 212885101, "1": 500 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("skips a CPU without the counter rather than reading it as zero", async () => {
    // An offline CPU loses its thermal_throttle directory. Zero would be a
    // count, and the next difference would be its whole lifetime.
    const root = await build({ cpu0: { pkg: "0", ms: "1000" }, cpu1: { pkg: "0" } });
    try {
      expect(await readThrottleTime(root)).toEqual({ "0": 1000 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("says nothing on a machine that does not count it — AMD, a VM", async () => {
    const root = await build({ cpu0: { pkg: "0" }, cpu1: { pkg: "0" } });
    try {
      expect(await readThrottleTime(root)).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
    expect(await readThrottleTime(join(tmpdir(), "no-such-cpu-tree"))).toBeNull();
  });
});

describe("the share of time the Linux kernel held the clock down", () => {
  const at = (atMs: number, held: Record<string, number>) => ({ atMs, held });

  it("is the count's growth over the time between two reads", () => {
    // Measured: 5752ms of package throttling in 10095ms of wall time.
    expect(throttleFromTime(at(0, { "0": 212885052 }), at(10_095, { "0": 212890804 })))
      .toEqual({ timeHeld: 57 });
  });

  it("is a share of time, never dressed up as a speed limit", () => {
    // The kernel says how long, not how far. `speedLimit: 43` would be a speed
    // nobody measured.
    const t = throttleFromTime(at(0, { "0": 0 }), at(10_000, { "0": 5_700 }))!;
    expect(t).not.toHaveProperty("speedLimit");
    expect(t.timeHeld).toBe(57);
  });

  it("needs two counts, so the first reading after a start has none", () => {
    expect(throttleFromTime(null, at(10_000, { "0": 5 }))).toBeNull();
    expect(throttleFromTime(at(10_000, { "0": 5 }), null)).toBeNull();
  });

  it("refuses a gap of no time rather than dividing by it", () => {
    expect(throttleFromTime(at(5_000, { "0": 1 }), at(5_000, { "0": 9 }))).toBeNull();
    expect(throttleFromTime(at(5_000, { "0": 1 }), at(4_000, { "0": 9 }))).toBeNull();
  });

  it("reads a few milliseconds as 1%, not as the zero that means 'never'", () => {
    expect(throttleFromTime(at(0, { "0": 100 }), at(10_000, { "0": 103 }))).toEqual({ timeHeld: 1 });
    expect(throttleFromTime(at(0, { "0": 100 }), at(10_000, { "0": 100 }))).toEqual({ timeHeld: 0 });
  });

  it("cannot go below zero when a CPU went offline, nor past 100 when a long event lands whole", () => {
    expect(throttleFromTime(at(0, { "0": 900 }), at(10_000, { "0": 400 }))).toEqual({ timeHeld: 0 });
    expect(throttleFromTime(at(0, { "0": 0 }), at(10_000, { "0": 14_000 }))).toEqual({ timeHeld: 100 });
  });

  it("answers for the worst package, and only for packages it has seen twice", () => {
    expect(throttleFromTime(at(0, { "0": 0, "1": 0 }), at(10_000, { "0": 1_000, "1": 4_000 })))
      .toEqual({ timeHeld: 40 });
    expect(throttleFromTime(at(0, { "0": 0 }), at(10_000, { "0": 1_000, "1": 9_000 })))
      .toEqual({ timeHeld: 10 });
    expect(throttleFromTime(at(0, { "1": 0 }), at(10_000, { "0": 1_000 }))).toBeNull();
  });

  it("is the same share on the server and in the client, for both measures", () => {
    // The server records it, the strip computes it live: two places, one number.
    for (const t of [{ timeHeld: 57 }, { timeHeld: 0 }, { speedLimit: 62 }, { speedLimit: 100 }]) {
      expect(heldShare(t)).toBe(serverHeldShare(t));
    }
    expect(heldShare({ timeHeld: 57 })).toBe(57);
    expect(heldShare({ speedLimit: 62 })).toBe(38);
  });
});

describe("the macOS GPU reading, which nothing documented", () => {
  // Trimmed from a real `ioreg -r -k PerformanceStatistics` on an Intel Mac
  // with an AMD card. The key sits in the same dictionary as the clock, the
  // activity and the power.
  const IOREG = `"PerformanceStatistics" = {"Core Clock(MHz)"=48,"GPU Activity(%)"=2,"Fan Speed(RPM)"=0,"Temperature(C)"=57,"Total Power(W)"=15}`;

  it("reads the temperature out of the accelerator's statistics", () => {
    expect(gpuFromIoreg(IOREG)).toBe(57);
  });

  it("takes the hotter of two cards", () => {
    // A machine with two GPUs is asking whether it is getting hot, and the
    // hotter card is the answer.
    expect(gpuFromIoreg(`${IOREG}\n"PerformanceStatistics" = {"Temperature(C)"=71}`)).toBe(71);
  });

  it("finds nothing on Apple Silicon, where the key is simply absent", () => {
    // AGXAccelerator publishes the same dictionary WITHOUT this key. No row is
    // drawn, which is the correct outcome rather than a special case.
    expect(gpuFromIoreg(`"PerformanceStatistics" = {"Device Utilization %"=7,"inUseSysMemoryBytes"=181989376}`)).toBeNull();
    expect(gpuFromIoreg("")).toBeNull();
    expect(gpuFromIoreg(null)).toBeNull();
  });

  it("refuses a value that is not a temperature", () => {
    expect(gpuFromIoreg(`"Temperature(C)"=0`)).toBeNull();
    expect(gpuFromIoreg(`"Temperature(C)"=-1`)).toBeNull();
    expect(gpuFromIoreg(`"Temperature(C)"=999`)).toBeNull();
  });
});

describe("the macOS throttle reading, which is the consequence rather than the cause", () => {
  // Real output from `pmset -g therm` on this machine.
  const PMSET = `Note: No thermal warning level has been recorded
Note: No performance warning level has been recorded
2026-09-03 10:53:47 +0300 CPU Power notify
\tCPU_Scheduler_Limit \t= 100
\tCPU_Available_CPUs \t= 12
\tCPU_Speed_Limit \t= 100
`;

  it("reads the speed limit", () => {
    expect(throttleFromPmset(PMSET)).toEqual({ speedLimit: 100 });
  });

  it("reads a machine that is actually being held back", () => {
    expect(throttleFromPmset(PMSET.replace("CPU_Speed_Limit \t= 100", "CPU_Speed_Limit \t= 62")))
      .toEqual({ speedLimit: 62 });
  });

  it("does not mistake the scheduler limit for the speed limit", () => {
    // They sit one line apart and mean different things: one limits the clock,
    // the other limits scheduling. A regex that matched either would report a
    // number that is neither.
    const scheduler = PMSET.replace("CPU_Scheduler_Limit \t= 100", "CPU_Scheduler_Limit \t= 50");
    expect(throttleFromPmset(scheduler)).toEqual({ speedLimit: 100 });
  });

  it("says nothing on a Mac that has never recorded one", () => {
    expect(throttleFromPmset("Note: No thermal warning level has been recorded\n")).toBeNull();
    expect(throttleFromPmset("")).toBeNull();
    expect(throttleFromPmset(null)).toBeNull();
  });

  it("refuses a percentage outside the range it is defined on", () => {
    expect(throttleFromPmset("CPU_Speed_Limit = 240")).toBeNull();
  });
});

/** The MSAcpi rows as the deck's own PowerShell projects them: `{i, v}`, the
 *  same two keys the performance counter uses, which is why one parser reads
 *  both and the dedicated MSAcpi parser is gone. `parseWinThermal` is the live
 *  entry point, and it prefers `perf` — so a case about the ACPI fallback has
 *  to send `perf` empty, exactly as the script does. */
const acpi = (rows: unknown) => parseWinThermal({ perf: [], acpi: rows });

describe("the Windows reading, whose unit is the whole branch", () => {
  it("converts tenths of a Kelvin, which nothing else in this file uses", () => {
    // 3032 tenths of a Kelvin is 30.05°C. Reading it as anything else gives a
    // number that looks plausible and is wrong.
    expect(acpi([{ i: "ACPI\\ThermalZone\\TZ00_0", v: 3032 }]))
      .toEqual([{ label: "Thermal zone", celsius: 30, warnAt: 75, critAt: 90 }]);
  });

  it("names a zone only when there is more than one to tell apart", () => {
    // ACPI does not say which zone is the CPU, and this module does not guess.
    // `TZ01` is not a friendly label; it is an honest one, and it only appears
    // on a machine that has something to disambiguate.
    expect(acpi([
      { i: "ACPI\\ThermalZone\\TZ00_0", v: 3132 },
      { i: "ACPI\\ThermalZone\\TZ01_0", v: 3232 },
    ]).map(r => r.label)).toEqual(["TZ00", "TZ01"]);
  });

  it("takes a lone object, which is what ConvertTo-Json gives for one row", () => {
    // The same shape trap parseGetProcessJson documents: PowerShell emits an
    // object rather than a one-element array.
    expect(acpi({ i: "ACPI\\ThermalZone\\TZ00_0", v: 3132 })).toHaveLength(1);
  });

  it("returns nothing rather than throwing when the class is not there", () => {
    // Genuinely absent on a large share of desktop boards — the same lesson
    // parseGetProcessJson learned about perflib. Absent is ordinary here.
    expect(parseWinThermal("")).toEqual([]);
    expect(parseWinThermal("Get-CimInstance: Invalid namespace")).toEqual([]);
    expect(parseWinThermal(null)).toEqual([]);
    expect(acpi([{ i: "x", v: null }])).toEqual([]);
  });
});

describe("the live reader, on whichever machine is running this", () => {
  // Ungated on purpose, so all three CI legs exercise their OWN branch on a
  // real machine. It cannot assert a number — a runner may publish no sensor at
  // all, and that is a legitimate answer — but it can assert the two things
  // that have to hold everywhere: it does not throw, and it never invents a
  // reading.
  it("answers with a well-formed reading or with nothing", async () => {
    const t = await readThermal();
    // Printed on purpose, and only when there IS something.
    //
    // What that turned up is worth writing down, because it is the honest
    // limit of what this matrix can prove. All three GitHub runners answer
    // NULL — checked by running the same reporter flags locally, where the
    // line does print, so the silence in CI is the readings and not the
    // capture. They are cloud VMs: ubuntu publishes no hwmon CPU or GPU chip,
    // windows has no MSAcpi_ThermalZoneTemperature (its 750ms in the suite is
    // PowerShell failing fast), and macos has no accelerator publishing
    // Temperature(C) and no CPU Power block in `pmset -g therm`.
    //
    // So the matrix proves the EMPTY path on three real operating systems —
    // no throw, no invented reading, no section drawn — which is the failure
    // that would otherwise reach a user on a platform nobody here can run. It
    // does not prove the populated path on Linux or Windows, and no machine
    // available to this repo can. That half rests on the fixtures above, on
    // the walk being exercised against a real tree, and on this line printing
    // for the first contributor who runs the suite on hardware with sensors.
    if (t) console.log(`[thermal] ${process.platform}: ${JSON.stringify(t)}`);
    if (t === null) return;
    expect(Array.isArray(t.celsius)).toBe(true);
    for (const r of t.celsius) {
      expect(typeof r.label).toBe("string");
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.celsius, `${r.label} is not a temperature`).toBeGreaterThan(0);
      expect(r.celsius).toBeLessThan(130);
      // STRICTLY greater. This read `> warnAt - 1` — i.e. `>=` — and equality
      // is exactly the shape that has no amber band at all, which is how a
      // coretemp row reporting max === crit went unnoticed.
      expect(r.critAt, `${r.label} has a zero-width warn band`).toBeGreaterThan(r.warnAt);
    }
    if (t.throttle) {
      const pct = "timeHeld" in t.throttle ? t.throttle.timeHeld : t.throttle.speedLimit;
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
    // Null is the answer for "nothing to say". An object with nothing in it is
    // what would draw an empty section.
    expect(t.celsius.length > 0 || t.throttle != null).toBe(true);
  });

  it("answers a throttle on the second read where the kernel counts one", async () => {
    // Linux's throttle is a difference, so it needs the read before it. On a
    // machine that counts nothing — every CI runner — there is still nothing,
    // and that is the answer.
    const first = await readThermal();
    const second = await readThermal(process.platform, first);
    if (second?.throttle) console.log(`[thermal] ${process.platform} throttle: ${JSON.stringify(second.throttle)}`);
    if (process.platform !== "linux" || !first?.throttleCount) return;
    expect(second!.throttle).toHaveProperty("timeHeld");
    expect(second!.throttle.timeHeld).toBeGreaterThanOrEqual(0);
    expect(second!.throttle.timeHeld).toBeLessThanOrEqual(100);
  });

  it("gives an unknown platform nothing rather than guessing", async () => {
    expect(await readThermal("sunos")).toBeNull();
  });
});

describe("how a reading is drawn", () => {
  it("uses the sensor's own bands, not one scale for every source", () => {
    // 84 is where an Intel package says it is unhappy; 90 would have called
    // the same reading calm.
    expect(thermalTone(86, 84, 100)).toBe("warn");
    expect(thermalTone(86, 95, 105)).toBe("calm");
    expect(thermalTone(101, 84, 100)).toBe("hot");
  });

  it("fills the bar with the problem, never with the health", () => {
    // `pmset` reports the speed still ALLOWED, and drawing that directly would
    // put a full bar meaning "all is well" under a memory bar where a full bar
    // means "nearly out". Two opposite conventions in one panel is a panel that
    // has to be read twice.
    expect(throttleRow({ speedLimit: 100 }).pct).toBe(0);
    expect(throttleRow({ speedLimit: 62 }).pct).toBe(38);
  });

  it("reads zero rather than 'none', so a healthy machine looks measured", () => {
    // Reported from the panel: `none` read as though the check had not run.
    // It is the only token in this panel that is a word where a number goes,
    // and 0% sits on the same scale as the 9% that appears under load.
    expect(throttleRow({ speedLimit: 100 })).toMatchObject({ value: "0%", tone: "calm" });
  });

  it("says outright that it has never happened, on a machine where it has not", () => {
    // The second half of the same report, arriving twice: a row that only ever
    // says 0% reads as a readout that does not work. Measured on the machine it
    // was reported from — ninety seconds of AES-NI on twelve cores never moved
    // CPU_Speed_Limit off 100 — so 0% is the truth there, forever, and the note
    // is what tells a reader that the check ran and found nothing rather than
    // that it found nothing to run.
    expect(throttleRow({ speedLimit: 100 }).note).toBe("running at full speed, and never held back");
  });

  it("says when it last happened, once it has", () => {
    // The history already holds the peak of every minute; nothing new is
    // sampled for this. It turns "0%" from a number you distrust into one you
    // can place.
    const now = 1_800_000_000_000;
    expect(throttleRow({ speedLimit: 100 }, { peak: 9, lastMs: now - 25 * 60_000 }, now).note)
      .toBe("at full speed · held to 91% 25 minutes ago");
  });

  it("still leads with what is happening NOW when something is", () => {
    // The past never displaces the present: a machine being throttled right now
    // says so, whatever it did at lunchtime.
    const now = 1_800_000_000_000;
    expect(throttleRow({ speedLimit: 91 }, { peak: 40, lastMs: now - 60_000 }, now).note)
      .toBe("CPU held to 91% of full speed to cool down");
  });

  it("rounds the age to something the buckets can support", () => {
    // Minute buckets, so "42 seconds ago" would be a precision the reading does
    // not have. The question is "recently or this morning".
    const now = 1_800_000_000_000;
    const at = (agoMin: number) => throttleRow({ speedLimit: 100 }, { peak: 5, lastMs: now - agoMin * 60_000 }, now).note;
    expect(at(0)).toContain("just now");
    expect(at(1)).toContain("just now");
    expect(at(59)).toContain("59 minutes ago");
    expect(at(60)).toContain("an hour ago");
    expect(at(200)).toContain("3 hours ago");
  });

  it("says what is happening and what it costs, when it is happening", () => {
    const held = throttleRow({ speedLimit: 62 });
    expect(held.value).toBe("38%");
    expect(held.note).toBe("CPU held to 62% of full speed to cool down");
  });

  it("colours any throttling at all, and reddens a third of the clock", () => {
    // Being throttled means the machine is slower than the one you think you
    // are running on, which is worth a colour however slight.
    expect(throttleRow({ speedLimit: 99 }).tone).toBe("warn");
    expect(throttleRow({ speedLimit: 70 }).tone).toBe("hot");
  });

  it("cannot be pushed outside the track by a reading it did not expect", () => {
    expect(throttleRow({ speedLimit: 0 }).pct).toBe(100);
    expect(throttleRow({ speedLimit: 140 }).pct).toBe(0);
  });

  it("says a Linux share of time as time, never as a speed", () => {
    // 57% of the time held down is not "held to 43% of full speed": how far the
    // clock was held is not in the kernel's file.
    const row = throttleRow({ timeHeld: 57 });
    expect(row).toMatchObject({ pct: 57, value: "57%", tone: "hot" });
    expect(row.note).toBe("CPU throttled 57% of the time to cool down");
    expect(row.note).not.toContain("speed");
    expect(throttleRow({ timeHeld: 4 }).tone).toBe("warn");
  });

  it("says when Linux last throttled, in the same words", () => {
    const now = 1_800_000_000_000;
    expect(throttleRow({ timeHeld: 0 }, { peak: 57, lastMs: now - 25 * 60_000 }, now).note)
      .toBe("at full speed · 57% throttled 25 minutes ago");
    expect(throttleRow({ timeHeld: 0 }).note).toBe("running at full speed, and never held back");
  });
});

describe("a machine that cannot answer is not asked forever", () => {
  // The reason is Windows: MSAcpi_ThermalZoneTemperature is absent on a large
  // share of desktop boards, and without this rule every one of those machines
  // pays a `Get-CimInstance` child every ten seconds, for the life of the
  // process, to render a section it can never render.
  //
  // Driven through an injected reader because the branch only fires on a
  // machine that answers with nothing, and the machine this was written on
  // answers with something.
  it("gives up after three consecutive empty readings, not after one", async () => {
    // One failure can be a hiccup — a timeout, a machine mid-wake — and giving
    // up on a hiccup would lose a reading the machine does have.
    stopSystemMetrics();
    let asked = 0;
    const read = async () => { asked++; return null; };
    for (let i = 0; i < 6; i++) await sampleThermal({ read });
    expect(asked).toBe(3);
  });

  it("forgets the misses when a reading finally lands", async () => {
    stopSystemMetrics();
    let n = 0;
    // Two empties, then an answer, then two more empties: still asking.
    const read = async () => (++n === 3 ? { celsius: [], throttle: { speedLimit: 100 } } : null);
    for (let i = 0; i < 5; i++) await sampleThermal({ read });
    expect(n).toBe(5);
  });

  it("counts a reader that threw as a miss rather than retrying forever", async () => {
    stopSystemMetrics();
    let asked = 0;
    const read = async () => { asked++; throw new Error("no such namespace"); };
    for (let i = 0; i < 6; i++) await sampleThermal({ read });
    expect(asked).toBe(3);
  });

  it("hands the last reading back, which is what a Linux throttle is a difference from", async () => {
    stopSystemMetrics();
    const seen: unknown[] = [];
    const first = { celsius: [], throttle: null, throttleCount: { atMs: 0, held: { "0": 0 } } };
    const read = async (_platform: string, since: unknown) => { seen.push(since); return first; };
    await sampleThermal({ read });
    await sampleThermal({ read });
    expect(seen).toEqual([null, first]);
  });

  it("keeps the kernel's raw count off the route the panel reads", async () => {
    stopSystemMetrics();
    await sampleThermal({ read: async () => ({
      celsius: [{ label: "CPU", celsius: 90, warnAt: 75, critAt: 100 }],
      throttle: { timeHeld: 57 },
      throttleCount: { atMs: 10_000, held: { "0": 5_700 } },
    }) });
    const shown = thermalSnapshot()!;
    expect(shown.throttle).toEqual({ timeHeld: 57 });
    expect(shown).not.toHaveProperty("throttleCount");
    expect(shown.heldBack?.peak).toBe(57);
  });

  it("asks again after a restart, which is what should happen after a driver is installed", async () => {
    stopSystemMetrics();
    let asked = 0;
    const read = async () => { asked++; return null; };
    for (let i = 0; i < 4; i++) await sampleThermal({ read });
    expect(asked).toBe(3);
    stopSystemMetrics();
    await sampleThermal({ read });
    expect(asked).toBe(4);
  });
});
