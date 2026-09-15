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
import { execFileSync } from "node:child_process";

// @ts-expect-error — a plain .mjs module, no types
const { parseWinThermal, tempFromPerfCounterJson, zoneLabel, WIN_THERMAL_PS } =
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

// A Windows that does not call the counter what this command calls it (#1028).
//
// Performance-counter set and counter names are LOCALIZED — that is the entire
// reason PDH ships `PdhAddEnglishCounter` beside `PdhAddCounter`. `Get-Counter
// -Counter` takes a LOCALIZED path, so the English one above answers "The
// specified object was not found on the computer." on a German, French,
// Japanese or Russian Windows. `-EA Stop` plus `catch {}` makes that silent,
// and the chain then falls to MSAcpi — which this module's own header says
// needs an elevation a deck never has — and then to LibreHardwareMonitor, which
// is only installed if the user installed it. A localized machine with real
// ACPI zones therefore drew no Thermal section at all, indistinguishable from
// the modern-Intel-laptop case the section is written to tolerate.
//
// The measurement behind the file header — "a Windows 10 19045 box" — was made
// on an ENGLISH one, and the case beside it pins the English string, so nothing
// here could have seen this.
//
// REASONED, NOT REPRODUCED, and said plainly because it matters which of the
// two this is. The localization of counter names and the Perflib index tables
// are documented Microsoft behaviour; no localized Windows was available, and
// CI's runners are English, so neither this suite nor the matrix can show a
// German counter name being resolved. What the last case here DOES measure is
// the thing that could actually regress for everyone: that the whole command,
// with the new block in it, parses and runs clean on a real Windows.
describe("the counter under the name this Windows calls it", () => {
  it("tries English first, then the local name, then the elevated source", () => {
    // The order is the whole of the safety argument for adding the middle one.
    // An English Windows fills `$r.perf` on the first attempt and never reaches
    // the second, so the block cannot take anything away from the machines the
    // command already worked on — it can only turn a machine that was reporting
    // nothing into one that reports something.
    const english = WIN_THERMAL_PS.indexOf("'\\Thermal Zone Information(*)\\High Precision Temperature'");
    const perflib = WIN_THERMAL_PS.indexOf("Perflib");
    const wmi = WIN_THERMAL_PS.indexOf("Get-CimInstance");

    expect(english).toBeGreaterThan(-1);
    expect(perflib).toBeGreaterThan(-1);
    expect(english).toBeLessThan(perflib);
    expect(perflib).toBeLessThan(wmi);
  });

  it("only runs the lookup when the English attempt produced nothing", () => {
    // `$r.perf` is what the first attempt fills. The guard in front of the
    // Perflib block has to be the same one the WMI attempt uses, or the second
    // query runs on every 30-second sample on every English machine as well.
    const block = WIN_THERMAL_PS.slice(WIN_THERMAL_PS.indexOf("Perflib") - 200, WIN_THERMAL_PS.indexOf("Perflib"));
    expect(block).toContain("if (-not $r.perf)");
  });

  it("reads both halves of the index table, since one alone names nothing", () => {
    // `…\Perflib\009` maps index -> ENGLISH name and `…\Perflib\CurrentLanguage`
    // maps the same index -> the local name. Either on its own is useless: the
    // English table is where the two names being looked for can be recognised,
    // and the local table is the only place the string Get-Counter will accept
    // exists.
    expect(WIN_THERMAL_PS).toContain("Perflib\\009");
    expect(WIN_THERMAL_PS).toContain("Perflib\\CurrentLanguage");
    expect(WIN_THERMAL_PS).toContain("'Thermal Zone Information'");
    expect(WIN_THERMAL_PS).toContain("'High Precision Temperature'");
  });

  it("carries no double quote, because the whole command is one argv entry", () => {
    // This string is handed to `powershell.exe -Command` as a single argument,
    // and PowerShell documents that a string `-Command` must be the LAST
    // parameter because everything after it is appended to the command TEXT.
    // browser-react.mjs records what that cost the first time. A script with no
    // embedded double quote has nothing in it for Node's Windows command-line
    // construction to have to escape, which is why the counter path is
    // concatenated from single-quoted pieces rather than interpolated into a
    // double-quoted one.
    expect(WIN_THERMAL_PS).not.toContain('"');
  });

  it("parses and runs clean on a real Windows, where there is one", () => {
    // WHERE THE MEASUREMENT HAPPENS, and the reason this case is here at all.
    // PowerShell parses the ENTIRE `-Command` string before it executes any of
    // it, so a syntax error anywhere in the block added above would not degrade
    // the thermal reading on a localized Windows — it would destroy it on every
    // Windows, English ones included, and the `catch {}` around the individual
    // queries would not save it. Nobody in this repo can run PowerShell to
    // check that by hand; the windows-latest leg can, on every push.
    //
    // Un-gated on purpose: the other two legs assert the one property they can
    // and say which authority answered, so a leg that silently stopped reaching
    // PowerShell shows up as a failure rather than as a green skip.
    if (process.platform !== "win32") {
      expect(WIN_THERMAL_PS.startsWith("$r = [ordered]@{}")).toBe(true);
      return;
    }
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", WIN_THERMAL_PS,
    ], { encoding: "utf8", maxBuffer: 4 << 20, timeout: 60_000 });

    // `{}` is the honest answer from a machine with no thermal hardware, which
    // is what a cloud runner is — so what is asserted is that the command
    // completed and printed something this module's own parser can read, not
    // that a temperature came back.
    const text = out.trim();
    expect(text.length).toBeGreaterThan(0);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(Array.isArray(parseWinThermal(text))).toBe(true);
  }, 90_000);
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

  it("reads the ACPI rows through the one parser, since they carry the same two keys", () => {
    // There used to be a second parser here, `tempFromMsAcpiJson`, with its own
    // entry point and the raw WMI field names. The PowerShell projects those
    // rows to `{i, v}` before they ever reach JavaScript — the same shape the
    // performance counter uses — so the second parser had no caller, and this
    // case asserted that a dead entry point still worked.
    expect(parseWinThermal({ perf: [], acpi: [{ i: "ACPI\\ThermalZone\\TZ00_0", v: K10(38) }] }))
      .toEqual([{ label: "Thermal zone", celsius: 38, warnAt: 75, critAt: 90 }]);
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
