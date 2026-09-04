// Why the Thermal section has never appeared on Windows, and what it reads now
// (#742).
//
// The section was not missing because Windows machines are silent. It was
// missing because the deck asked somewhere it is not allowed to look:
// MSAcpi_ThermalZoneTemperature lives in root\wmi, that namespace REQUIRES
// ADMINISTRATOR, and a deck never has it — v1 must never need admin rights. An
// ordinary terminal gets Access Denied, three times, and then the sampler gives
// up for the life of the process.
//
// `\Thermal Zone Information(*)\High Precision Temperature` is the same
// hardware read through a performance counter, which an ordinary user may read.
// Measured on a Windows 10 19045 box: the counter set is registered and the
// one-liner below runs clean in about a second.
//
// That box could not confirm a NUMBER, and this file does not pretend
// otherwise. It is a QEMU/SeaBIOS guest — Manufacturer "QEMU", Model "Standard
// PC (i440FX + PIIX, 1996)" — so it has no thermal hardware at all: the counter
// answers "The specified instance is not present" and MSAcpi answers "Not
// supported" even to an administrator, which is what an elevated probe there
// returned. What it did confirm is the shape: the command runs, prints `{}`,
// and this parser turns that into no rows and therefore no section.
//
// So the numbers below are fixtures, in the same spirit as the rest of this
// module's platform code: pure exported parsers, checked from a machine that is
// not the platform they are for.
import { describe, it, expect } from "vitest";

// @ts-expect-error — a plain .mjs module, no types
const { parseWinThermal, tempFromPerfCounterJson, tempFromMsAcpiJson, zoneLabel, WIN_THERMAL_PS } =
  await import("../../server/system-metrics.mjs");

/** 313.15 K = 40 °C, in the tenths of a Kelvin both sources report. */
const K10 = (c: number) => Math.round((c + 273.15) * 10);

describe("the command sent to PowerShell", () => {
  it("asks the counter before it asks WMI", () => {
    // The order is the whole point: one of these two needs administrator and
    // the other does not, and the deck has never had it.
    const counter = WIN_THERMAL_PS.indexOf("Get-Counter");
    const wmi = WIN_THERMAL_PS.indexOf("Get-CimInstance");
    expect(counter).toBeGreaterThan(-1);
    expect(wmi).toBeGreaterThan(-1);
    expect(counter).toBeLessThan(wmi);
  });

  it("asks for the high precision counter, which is the one in tenths", () => {
    expect(WIN_THERMAL_PS).toContain("\\Thermal Zone Information(*)\\High Precision Temperature");
  });

  it("serialises deep enough to keep the rows", () => {
    // ConvertTo-Json defaults to a depth of 2, and at that depth the inner
    // hashtables come out as the literal string "System.Collections.Hashtable"
    // — the parser would then see a list of nothing and report a machine with
    // no sensor as a machine with no sensor, which is the same answer for the
    // wrong reason.
    expect(WIN_THERMAL_PS).toContain("-Depth 4");
  });

  it("does not let either query's failure end the command", () => {
    // "No thermal zone on this machine" arrives as a throw from both, and it is
    // the ordinary answer on a desktop board and on every virtual machine.
    expect(WIN_THERMAL_PS).toContain("catch {}");
    expect(WIN_THERMAL_PS).toContain("-EA Stop");
  });
});

describe("what a machine with nothing to say produces", () => {
  it("reads the empty object the real box printed as no rows", () => {
    // Copied from a run on that Windows 10 guest, verbatim.
    expect(parseWinThermal("{}")).toEqual([]);
  });

  it("survives every other shape of nothing", () => {
    for (const junk of ["", "not json", "null", "[]", undefined, null]) {
      expect(parseWinThermal(junk as string)).toEqual([]);
    }
  });
});

describe("the counter's readings", () => {
  it("reads tenths of a Kelvin, which is the detail the whole branch turns on", () => {
    // 3131.5 tenths of a Kelvin is 40 °C. Read as anything else it is a number
    // that looks plausible and is wrong.
    const [row] = parseWinThermal(JSON.stringify({ perf: [{ i: "\\_tz.tz00", v: K10(40) }] }));
    expect(row.celsius).toBe(40);
    expect(row).toMatchObject({ warnAt: 75, critAt: 90 });
  });

  it("names one zone plainly and several by their own names", () => {
    // ACPI does not say which zone is the CPU, so this module does not guess.
    // `TZ00` is not a friendly label; it is an honest one, and it only appears
    // on a machine that has more than one.
    const one = parseWinThermal(JSON.stringify({ perf: [{ i: "\\_tz.tz00", v: K10(44) }] }));
    expect(one.map((r: any) => r.label)).toEqual(["Thermal zone"]);

    const two = parseWinThermal(JSON.stringify({
      perf: [{ i: "\\_tz.tz00", v: K10(44) }, { i: "\\_tz.tz01", v: K10(51) }],
    }));
    expect(two.map((r: any) => r.label)).toEqual(["TZ00", "TZ01"]);
  });

  it("stops at two rows, because the panel is 280px wide", () => {
    const many = parseWinThermal(JSON.stringify({
      perf: [0, 1, 2, 3, 4].map(n => ({ i: `\\_tz.tz0${n}`, v: K10(40 + n) })),
    }));
    expect(many).toHaveLength(2);
  });

  it("refuses a reading no machine produces", () => {
    // A zone that answers 0 K, or one that reports a number in some other unit,
    // is a reading this module must not draw. Same rule as everywhere else
    // here: never invent one.
    for (const v of [0, 1, 9999999, -100]) {
      expect(parseWinThermal(JSON.stringify({ perf: [{ i: "\\_tz.tz00", v }] }))).toEqual([]);
    }
  });
});

describe("MSAcpi, the second source", () => {
  it("is used only when the counter said nothing", () => {
    // Some boards publish a zone to ACPI and no counter, and a deck launched
    // from an elevated shell can read it.
    const both = parseWinThermal(JSON.stringify({
      perf: [{ i: "\\_tz.tz00", v: K10(40) }],
      acpi: [{ i: "ACPI\\ThermalZone\\TZ00_0", v: K10(70) }],
    }));
    expect(both.map((r: any) => r.celsius)).toEqual([40]);

    const acpiOnly = parseWinThermal(JSON.stringify({
      acpi: [{ i: "ACPI\\ThermalZone\\TZ00_0", v: K10(70) }],
    }));
    expect(acpiOnly.map((r: any) => r.celsius)).toEqual([70]);
  });

  it("still parses on its own, for the caller that has only its shape", () => {
    // tempFromMsAcpiJson keeps its own entry point and its own field names.
    expect(tempFromMsAcpiJson(JSON.stringify([
      { InstanceName: "ACPI\\ThermalZone\\TZ00_0", CurrentTemperature: K10(38) },
    ]))).toEqual([{ label: "Thermal zone", celsius: 38, warnAt: 75, critAt: 90 }]);
  });
});

describe("zoneLabel", () => {
  it("agrees between the two sources, which spell the same zone differently", () => {
    // The counter says `\_tz.tz00` and WMI says `ACPI\ThermalZone\TZ00_0`. A
    // panel that showed `tz00` beside a `TZ01` would be showing one machine as
    // two.
    expect(zoneLabel("\\_tz.tz00")).toBe("TZ00");
    expect(zoneLabel("ACPI\\ThermalZone\\TZ00_0")).toBe("TZ00");
  });

  it("falls back to a name rather than to an empty label", () => {
    for (const raw of ["", null, undefined, "\\", "."]) {
      expect(zoneLabel(raw as string)).toBe("Thermal zone");
    }
  });
});

describe("tempFromPerfCounterJson on its own", () => {
  it("takes a single object as readily as a list", () => {
    // ConvertTo-Json collapses a one-element array into an object unless the
    // array is forced, and the command forces it — but a parser that only
    // handled the list would fail the day somebody removed the `@()`.
    expect(tempFromPerfCounterJson({ i: "\\_tz.tz00", v: K10(42) }))
      .toEqual([{ label: "Thermal zone", celsius: 42, warnAt: 75, critAt: 90 }]);
  });
});
