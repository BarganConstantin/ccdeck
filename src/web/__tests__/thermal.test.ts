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
  celsiusFromMilli, gpuFromIoreg, pickThermalRows, readHwmon, readThermal,
  readThermalZones, sampleThermal, stopSystemMetrics, tempFromMsAcpiJson, throttleFromPmset,
} from "../../server/system-metrics.mjs";
import { thermalTone, throttleRow } from "../components/SystemMeter";

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

describe("the Windows reading, whose unit is the whole branch", () => {
  it("converts tenths of a Kelvin, which nothing else in this file uses", () => {
    // 3032 tenths of a Kelvin is 30.05°C. Reading it as anything else gives a
    // number that looks plausible and is wrong.
    const json = '[{"InstanceName":"ACPI\\\\ThermalZone\\\\TZ00_0","CurrentTemperature":3032}]';
    expect(tempFromMsAcpiJson(json)).toEqual([{ label: "Thermal zone", celsius: 30, warnAt: 75, critAt: 90 }]);
  });

  it("names a zone only when there is more than one to tell apart", () => {
    // ACPI does not say which zone is the CPU, and this module does not guess.
    // `TZ01` is not a friendly label; it is an honest one, and it only appears
    // on a machine that has something to disambiguate.
    const json = JSON.stringify([
      { InstanceName: "ACPI\\ThermalZone\\TZ00_0", CurrentTemperature: 3132 },
      { InstanceName: "ACPI\\ThermalZone\\TZ01_0", CurrentTemperature: 3232 },
    ]);
    expect(tempFromMsAcpiJson(json).map(r => r.label)).toEqual(["TZ00", "TZ01"]);
  });

  it("takes a lone object, which is what ConvertTo-Json gives for one row", () => {
    // The same shape trap parseGetProcessJson documents: PowerShell emits an
    // object rather than a one-element array.
    expect(tempFromMsAcpiJson({ InstanceName: "ACPI\\ThermalZone\\TZ00_0", CurrentTemperature: 3132 }))
      .toHaveLength(1);
  });

  it("returns nothing rather than throwing when the class is not there", () => {
    // Genuinely absent on a large share of desktop boards — the same lesson
    // parseGetProcessJson learned about perflib. Absent is ordinary here.
    expect(tempFromMsAcpiJson("")).toEqual([]);
    expect(tempFromMsAcpiJson("Get-CimInstance: Invalid namespace")).toEqual([]);
    expect(tempFromMsAcpiJson(null)).toEqual([]);
    expect(tempFromMsAcpiJson([{ InstanceName: "x", CurrentTemperature: null }])).toEqual([]);
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
      expect(r.critAt).toBeGreaterThan(r.warnAt - 1);
    }
    if (t.throttle) {
      expect(t.throttle.speedLimit).toBeGreaterThanOrEqual(0);
      expect(t.throttle.speedLimit).toBeLessThanOrEqual(100);
    }
    // Null is the answer for "nothing to say". An object with nothing in it is
    // what would draw an empty section.
    expect(t.celsius.length > 0 || t.throttle != null).toBe(true);
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
    expect(throttleRow(100).pct).toBe(0);
    expect(throttleRow(62).pct).toBe(38);
  });

  it("reads zero rather than 'none', so a healthy machine looks measured", () => {
    // Reported from the panel: `none` read as though the check had not run.
    // It is the only token in this panel that is a word where a number goes,
    // and 0% sits on the same scale as the 9% that appears under load.
    expect(throttleRow(100)).toMatchObject({ value: "0%", tone: "calm", note: "running at full speed" });
  });

  it("says what is happening and what it costs, when it is happening", () => {
    const held = throttleRow(62);
    expect(held.value).toBe("38%");
    expect(held.note).toBe("CPU held to 62% of full speed to cool down");
  });

  it("colours any throttling at all, and reddens a third of the clock", () => {
    // Being throttled means the machine is slower than the one you think you
    // are running on, which is worth a colour however slight.
    expect(throttleRow(99).tone).toBe("warn");
    expect(throttleRow(70).tone).toBe("hot");
  });

  it("cannot be pushed outside the track by a reading it did not expect", () => {
    expect(throttleRow(0).pct).toBe(100);
    expect(throttleRow(140).pct).toBe(0);
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
