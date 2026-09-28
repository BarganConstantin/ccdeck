// The thermal section's sources: where each platform's degrees and its
// throttle come from, and the parsers that read them.
//
// Moved out of system-metrics.mjs unchanged. The sampler there decides how often
// the machine is asked and when one that has never answered stops being asked
// (sampleThermal). This file is the asking: readThermal answers once per call,
// per platform, and nothing here keeps state between two calls. WARN_C and
// CRIT_C are exported because the history's thermal series fall back to them.
import { readdir, readFile } from "node:fs/promises";
import { run } from "./metrics-run.mjs";

// ---------------------------------------------------------------------------
// Thermal: is this machine getting hot, and is it being held back for it.
//
// The section the load average cannot answer. A saturated machine that is cool
// is a machine doing work; a saturated machine that is thermally limited is one
// where the next agent you launch makes everything slower, and `67.27 82.98
// 74.19` reads identically in both cases.
//
// THREE PLATFORMS ANSWER THREE DIFFERENT QUESTIONS, and on one of them the
// honest answer is not a temperature at all. Everything below was measured on
// the machines available rather than taken from documentation, and the negative
// results are recorded here because they are the reason the shape is what it
// is:
//
//   Linux    /sys/class/hwmon/hwmon*/temp*_input, millidegrees Celsius, with
//            the chip in `name` and the sensor in `temp*_label`. A plain file
//            read, exactly like /proc/meminfo — no subprocess, and the chip
//            publishes its own `temp*_max` and `temp*_crit`, so the warning
//            bands are the hardware's rather than ones invented here.
//            /sys/class/thermal/thermal_zone*/ is the coarser fallback.
//
//   macOS    No CPU degrees without root, verified: `powermetrics --samplers
//            smc` answers "powermetrics must be invoked as the superuser", and
//            `ioreg -c AppleSMC -r -d 1` publishes no temperature key at all to
//            an unprivileged process. Asking a dashboard for a password every
//            ten seconds is not an option, and this deck does not ship a
//            kernel driver.
//
//            But the GPU driver does publish one, and nothing said so: the
//            accelerator's PerformanceStatistics carries "Temperature(C)"
//            beside its clock, its activity and its power. Read live on an
//            Intel Mac with an AMD card — 60, 60, 61 over four seconds, from
//            `ioreg -r -k PerformanceStatistics` in 51ms. Apple Silicon's
//            AGXAccelerator publishes the same dictionary WITHOUT that key, so
//            there the parser finds nothing and no row is drawn, which is the
//            correct outcome rather than a special case.
//
//            And `pmset -g therm` is unprivileged, instant, and present on
//            both architectures. What it reports is not heat but the
//            consequence of heat: CPU_Speed_Limit, the share of the CPU's speed
//            the thermal manager is currently allowing. That is arguably the
//            more useful of the two readings — a temperature is a number you
//            have to interpret, a speed limit is the thing you were trying to
//            interpret it into.
//
//            `sysctl machdep.xcpm.cpu_thermal_level` is deliberately unused. It
//            is live (33, then 42, then 41 over three seconds) but it is
//            Intel-only and an undocumented scale, and printing it as though it
//            were degrees would be exactly the lie this module refuses.
//
//            ON APPLE SILICON ioreg and pmset both come back empty, and the
//            degrees come from macmon instead: the sensors sit behind a HID
//            sensor hub that only native code reaches without root. It is
//            asked only when those two were silent, so an Intel Mac never pays
//            for it, and the deck fetches its release binary itself — see
//            macmon.mjs.
//
//   Windows  The performance counter `\Thermal Zone Information(*)\High
//            Precision Temperature`, in TENTHS OF A KELVIN, read through
//            Get-Counter.
//
//            It is read through a counter rather than through WMI for one
//            reason, and it is the reason this section never worked on Windows
//            for anybody: MSAcpi_ThermalZoneTemperature lives in root\wmi and
//            that namespace REQUIRES ADMINISTRATOR. A deck started from an
//            ordinary terminal — which is every deck, since v1 must never need
//            admin rights — got Access Denied, three times, and then gave up
//            for the life of the process. The section was not missing because
//            the hardware was silent; it was missing because we were asking
//            somewhere we were not allowed to look.
//
//            MSAcpi is still asked, second, because a deck that IS elevated can
//            read it and because the two do not always agree — some boards
//            publish a zone to ACPI and no counter.
//
//            Genuinely absent on a large share of machines either way: a
//            desktop board with no zone, and every virtual machine, which has
//            no thermal hardware to report. Measured on a QEMU/SeaBIOS guest:
//            the counter set is registered and answers "The specified instance
//            is not present", and MSAcpi answers "Not supported" even to an
//            administrator. Absent is ordinary here rather than an error.
//
//            THE COUNTER PATH IS LOCALISED. `Thermal Zone Information` is the
//            English name and a German or French Windows publishes its own, so
//            when the English path answers nothing the local spelling is
//            resolved through Perflib's index tables (WIN_THERMAL_PS below).
//            Reasoned from the documented layout, not yet run on a localised
//            Windows.
//
//            A MODERN INTEL LAPTOP declares no zone at all: Intel DTT manages
//            its sensors and publishes them only to an administrator. There the
//            degrees come from LibreHardwareMonitor's local web server when the
//            user already runs it — see hwmonitor.mjs.
//
// NEVER INVENT A READING. No sensor means no row, and no rows at all means the
// section is not rendered: not 0°C, not a dash, not a grey empty bar. Same rule
// that keeps `cpu` null until two samples exist.

/** Bands used where the hardware publishes none of its own. Linux sensors
 *  carry `temp*_max` and `temp*_crit` and those win: a laptop package sensor
 *  and an NVMe drive do not share a comfortable range, and one scale for both
 *  would be a number this module made up. */
export const WARN_C = 75;
export const CRIT_C = 90;

/** A reading that is not a temperature is not a misparse to be shown anyway.
 *  Silicon does not run below freezing or above 130°C, and both ends of that
 *  have been produced by reading the right file with the wrong unit. */
const plausible = c => Number.isFinite(c) && c > 0 && c < 130;

/**
 * Millidegrees Celsius out of a hwmon `temp*_input`, or null.
 *
 * The kernel writes an integer; the divide is the whole conversion. Exported
 * and pure for the reason every parser here is: a Linux answer has to be
 * checkable from a Mac.
 */
export function celsiusFromMilli(text) {
  const n = Number(String(text ?? "").trim());
  const c = Math.round(n / 1000);
  return plausible(c) ? c : null;
}

/**
 * Which of a machine's sensors the panel names, out of every sensor found.
 *
 * A real machine publishes a lot of them: the package, one per core, the NVMe
 * drive, the wireless card, the chipset. Two rows is what the panel has room
 * for and two rows is what somebody watching a build wants, so this picks the
 * CPU and the GPU by the chip that published them and leaves the rest alone.
 *
 * Preference inside a chip matters as much as the chip does. coretemp exposes
 * `Package id 0` beside `Core 0`..`Core N`, and the package is the reading
 * — a single core's number is noisier and lower than the die it sits on.
 * k10temp exposes `Tctl` and, on parts that have it, `Tdie`: Tctl is Tdie plus
 * a vendor offset that exists for fan control, so Tdie is the temperature and
 * Tctl is the fallback. amdgpu's `edge` is the die edge and `junction` is the
 * hotspot; edge is what every other tool calls the GPU temperature.
 *
 * Where a chip publishes nothing recognisable, the hottest of its sensors is
 * taken, because the question is "is it getting hot" and the hottest sensor is
 * the one that answers it.
 */
const CPU_CHIPS = ["coretemp", "k10temp", "zenpower", "cpu_thermal", "soc_thermal"];
const GPU_CHIPS = ["amdgpu", "nouveau", "i915", "xe", "radeon"];

export function pickThermalRows(sensors) {
  const hottest = rows => rows.reduce((a, b) => (b.celsius > a.celsius ? b : a));
  const pick = (chips, prefer, label) => {
    const mine = (sensors ?? []).filter(s => chips.includes(s.chip) && plausible(s.celsius));
    if (!mine.length) return null;
    for (const re of prefer) {
      const hit = mine.find(s => re.test(s.label ?? ""));
      if (hit) return { ...hit, label };
    }
    return { ...hottest(mine), label };
  };
  return [
    pick(CPU_CHIPS, [/^package id/i, /^tdie$/i, /^tctl$/i], "CPU"),
    pick(GPU_CHIPS, [/^edge$/i, /^junction$/i], "GPU"),
  ].filter(Boolean);
}

/**
 * Every temperature sensor under /sys/class/hwmon, with the chip that owns it
 * and the bands that chip publishes for it.
 *
 * `root` is a parameter so this can be pointed at a tree on disk. There is no
 * Linux machine here and no container runtime, so the alternative would be a
 * directory walk nobody has ever run — and a walk is exactly the kind of code
 * that a fixture of its OUTPUT cannot check, because the walk is the part that
 * is wrong.
 */
export async function readHwmon(root = "/sys/class/hwmon", deps = {}) {
  const dir = deps.readdir ?? readdir;
  const file = deps.readFile ?? readFile;
  const read = async path => { try { return String(await file(path, "utf8")).trim(); } catch { return null; } };
  let chips;
  try { chips = await dir(root); } catch { return []; }
  const out = [];
  for (const hwmon of chips) {
    const base = `${root}/${hwmon}`;
    const chip = (await read(`${base}/name`)) ?? hwmon;
    let entries;
    try { entries = await dir(base); } catch { continue; }
    for (const entry of entries) {
      const m = /^(temp\d+)_input$/.exec(entry);
      if (!m) continue;
      const celsius = celsiusFromMilli(await read(`${base}/${entry}`));
      if (celsius == null) continue;
      const chipMax = celsiusFromMilli(await read(`${base}/${m[1]}_max`));
      const chipCrit = celsiusFromMilli(await read(`${base}/${m[1]}_crit`));
      out.push({
        chip,
        label: await read(`${base}/${m[1]}_label`),
        celsius,
        // The hardware's own bands where it has them. `max` is where the chip
        // says it is unhappy and `crit` is where it says it will act.
        //
        // `max` ONLY WHEN IT IS BELOW `crit`, because on Intel coretemp the two
        // files carry the same number. Measured on a live machine:
        //
        //   coretemp  temp1_input 88000  temp1_max 100000  temp1_crit 100000
        //   nvme      temp1_input 45850  temp1_max  84850  temp1_crit  85850
        //
        // The nvme row is a real band and works. The coretemp row is not: with
        // max === crit the amber band is zero degrees wide, so thermalTone goes
        // from calm straight to hot at 100C — a number a CPU reaches only as it
        // shuts the machine down. A CPU at 89C was painted the same grey as one
        // at 45C, on the one row anybody reads, and the 75/90 fallback that
        // would have said so was discarded precisely BECAUSE the chip published
        // its own. A chip that publishes one usable threshold is telling us
        // where it will act, not where to start worrying.
        warnAt: chipMax != null && chipCrit != null && chipMax >= chipCrit
          ? Math.min(WARN_C, Math.round(chipCrit * 0.9))
          : chipMax ?? WARN_C,
        critAt: chipCrit ?? CRIT_C,
      });
    }
  }
  return out;
}

/**
 * The coarser Linux fallback, for a machine whose sensors have no hwmon driver.
 *
 * One row, and it is labelled with the zone's own `type` rather than "CPU",
 * because a thermal zone is not a claim about what was measured. `acpitz` is
 * the motherboard's idea of ambient on a lot of hardware and calling that the
 * CPU would be the same lie in a different place.
 */
const ZONE_ORDER = ["x86_pkg_temp", "cpu-thermal", "cpu_thermal", "soc_thermal"];

export async function readThermalZones(root = "/sys/class/thermal", deps = {}) {
  const dir = deps.readdir ?? readdir;
  const file = deps.readFile ?? readFile;
  const read = async path => { try { return String(await file(path, "utf8")).trim(); } catch { return null; } };
  let zones;
  try { zones = (await dir(root)).filter(n => /^thermal_zone\d+$/.test(n)); } catch { return []; }
  const found = [];
  for (const zone of zones) {
    const celsius = celsiusFromMilli(await read(`${root}/${zone}/temp`));
    if (celsius == null) continue;
    found.push({ label: (await read(`${root}/${zone}/type`)) ?? zone, celsius, warnAt: WARN_C, critAt: CRIT_C });
  }
  if (!found.length) return [];
  const known = found.find(z => ZONE_ORDER.includes(z.label));
  return [known ?? found.reduce((a, b) => (b.celsius > a.celsius ? b : a))];
}

/**
 * GPU degrees out of `ioreg -r -k PerformanceStatistics`.
 *
 * The macOS reading nothing documented: the accelerator publishes
 * "Temperature(C)" in the same dictionary as its clock and its power. The
 * maximum across accelerators, because a machine with two cards is asking
 * whether it is getting hot, and the hotter card is the answer.
 */
export function gpuFromIoreg(text) {
  let best = null;
  for (const m of String(text ?? "").matchAll(/"Temperature\(C\)"\s*=\s*(-?\d+)/g)) {
    const c = Number(m[1]);
    if (plausible(c) && (best == null || c > best)) best = c;
  }
  return best;
}

/**
 * The share of the CPU's speed the thermal manager is allowing, out of
 * `pmset -g therm`, or null when this Mac has never recorded one.
 *
 * `CPU_Scheduler_Limit` sits beside it and is deliberately not read: it limits
 * scheduling rather than clock, so folding the two into one percentage would
 * produce a number that is neither. If scheduler throttling turns out to matter
 * it is a second row, not a redefinition of this one.
 */
export function throttleFromPmset(text) {
  const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(String(text ?? ""));
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return { speedLimit: pct };
}


/**
 * Windows thermal zones out of the `Thermal Zone Information` counter set.
 *
 * `High Precision Temperature` is in TENTHS OF A KELVIN, which is the single
 * detail this branch turns on — the same unit MSAcpi uses below, and reading it
 * as anything else gives a number that is plausible-looking and wrong.
 *
 * This is the source that works WITHOUT ADMINISTRATOR, which is the whole point
 * of it: root\wmi needs elevation and a deck never has it. See the note at the
 * top of this section.
 *
 * Shape is `[{ i: instanceName, v: cookedValue }]` — the projection the
 * PowerShell one-liner makes, so this parser never has to know what a
 * CounterSample looks like.
 */
export const WIN_THERMAL_PS = [
  "$r = [ordered]@{}",
  // Get-Counter, not Get-CimInstance: this is the half that works unelevated.
  "try { $r.perf = @((Get-Counter -Counter '\\Thermal Zone Information(*)\\High Precision Temperature' -EA Stop).CounterSamples | ForEach-Object { @{ i = $_.InstanceName; v = $_.CookedValue } }) } catch {}",
  // THE SAME COUNTER UNDER THE NAME THIS WINDOWS CALLS IT.
  //
  // Performance-counter set and counter names are LOCALIZED. That is why PDH
  // ships `PdhAddEnglishCounter` beside `PdhAddCounter` at all, and
  // `Get-Counter -Counter` takes a localized path: hand it the English one on a
  // German, French, Japanese or Russian Windows and it answers "The specified
  // object was not found on the computer." `-EA Stop` plus `catch {}` turns
  // that into silence, so the line above falls straight through to MSAcpi —
  // which this module's own header says needs elevation a deck never has — and
  // then to LibreHardwareMonitor, which is only there if the user installed it.
  // A machine with real ACPI thermal zones and a non-English display language
  // therefore drew no Thermal section at all, indistinguishable from the
  // modern-Intel-laptop case the section is written to tolerate.
  //
  // This is the class #552 fixed one module over: exec.mjs spends two screens
  // on "Windows ships cmd.exe in every language it ships in, and these
  // sentences are translated with it", and the C_LOCALE block in
  // metrics-run.mjs is there for the same reason.
  //
  // Perflib is the documented map between the two spellings. `…\Perflib\009`
  // holds a REG_MULTI_SZ of alternating index and ENGLISH name; the parallel
  // `…\Perflib\CurrentLanguage` holds index and LOCAL name. Look the two
  // English names up to get their indices, read the local names at the same
  // indices, and build the path out of those.
  //
  // SECOND, NOT FIRST, and that is what makes it safe to add: an English
  // Windows never reaches this line, because `$r.perf` is already filled. It
  // can only turn a machine that was reporting nothing into one that reports
  // something.
  //
  // NOT ONE DOUBLE QUOTE, for the reason the whole of this string has none: it
  // travels as a single `-Command` argument on a Windows command line. The
  // counter path is concatenated rather than interpolated so that no quoting
  // form beyond the single quote is needed anywhere in it.
  //
  // REASONED, NOT REPRODUCED. The localization of counter names is documented
  // Microsoft behaviour and the Perflib layout is documented with it, but no
  // localized Windows was available to run this against, and CI's runners are
  // English — so what CI proves about this line is that it parses and runs
  // clean on a real Windows, not that it resolves a German counter name.
  "if (-not $r.perf) { try { "
    + "$en = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Perflib\\009' -EA Stop).Counter; "
    + "$lo = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Perflib\\CurrentLanguage' -EA Stop).Counter; "
    + "$byIndex = @{}; for ($i = 1; $i -lt $lo.Count; $i += 2) { $byIndex[$lo[$i-1]] = $lo[$i] }; "
    + "$set = $null; $ctr = $null; "
    + "for ($i = 1; $i -lt $en.Count; $i += 2) { "
    + "if ($en[$i] -eq 'Thermal Zone Information') { $set = $byIndex[$en[$i-1]] } "
    + "elseif ($en[$i] -eq 'High Precision Temperature') { $ctr = $byIndex[$en[$i-1]] } }; "
    + "if ($set -and $ctr) { $r.perf = @((Get-Counter -Counter ('\\' + $set + '(*)\\' + $ctr) -EA Stop).CounterSamples "
    + "| ForEach-Object { @{ i = $_.InstanceName; v = $_.CookedValue } }) } "
    + "} catch {} }",
  "if (-not $r.perf) { try { $r.acpi = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -EA Stop | ForEach-Object { @{ i = $_.InstanceName; v = $_.CurrentTemperature } }) } catch {} }",
  // Depth matters: the default of 2 turns the inner hashtables into the string
  // "System.Collections.Hashtable" and this parser would see nothing at all.
  "$r | ConvertTo-Json -Compress -Depth 4",
].join("; ");

/**
 * Whichever of the two Windows sources answered, as thermal rows.
 *
 * The shape is `{ perf: [...] }` or `{ acpi: [...] }` or `{}` — the PowerShell
 * above only ever fills one, and fills neither on the machines where there is
 * nothing to fill it with. Both lists carry the same two fields and the same
 * unit, so the only thing that differs is which key they arrived under.
 */
export function parseWinThermal(json) {
  let r;
  try { r = typeof json === "string" ? JSON.parse(json) : json; }
  catch { return []; }
  if (!r || typeof r !== "object") return [];
  const perf = tempFromPerfCounterJson(r.perf ?? []);
  if (perf.length) return perf;
  return tempFromPerfCounterJson(
    // MSAcpi's projection uses the same two keys, so the one parser reads both.
    Array.isArray(r.acpi) ? r.acpi : (r.acpi ? [r.acpi] : []),
  );
}

export function tempFromPerfCounterJson(json) {
  let rows;
  try { rows = typeof json === "string" ? JSON.parse(json) : json; }
  catch { return []; }
  if (!rows) return [];
  if (!Array.isArray(rows)) rows = [rows];
  const found = [];
  for (const r of rows) {
    const tenths = Number(r?.v);
    if (!Number.isFinite(tenths)) continue;
    const celsius = Math.round(tenths / 10 - 273.15);
    if (!plausible(celsius)) continue;
    found.push({ label: zoneLabel(r?.i), celsius, warnAt: WARN_C, critAt: CRIT_C });
  }
  if (found.length === 1) found[0].label = "Thermal zone";
  return found.slice(0, 2);
}

/**
 * A thermal zone's name, out of whatever spelling the source used.
 *
 * The counter names its instances `\_tz.tz00` and WMI names the same zone
 * `ACPI\ThermalZone\TZ00_0`, so the tail after the last separator is the only
 * part the two agree on. Upper-cased because the counter lower-cases it and a
 * panel that showed `tz00` beside a `TZ01` from the other source would be
 * showing one machine as two.
 */
export function zoneLabel(raw) {
  const tail = String(raw ?? "").split(/[\\.]/).pop() ?? "";
  const name = tail.replace(/_\d+$/, "").toUpperCase();
  return name || "Thermal zone";
}


/**
 * The macOS rows, from whatever the three sources answered.
 *
 * Pure, and exported, for the reason sampleThermal's `deps.read` is: the branch
 * that matters only fires on a machine that answers with nothing, and the
 * machine this was written on answers with something. There is no other way to
 * run it.
 *
 * The ordering rule is the whole content. ioreg's GPU degrees and pmset's
 * throttle are what macOS itself gives up, and they win — they cost one cheap
 * subprocess each and they are the same numbers this deck has always shown.
 * macmon is consulted only when both were silent, and then its CPU row comes
 * first, because on the machine that reaches here the CPU is the reading
 * somebody opened the panel for.
 */
export function darwinThermal({ gpuC = null, throttle = null, macmon = {} } = {}) {
  const celsius = [];
  if (gpuC != null) celsius.push({ label: "GPU", celsius: gpuC, warnAt: WARN_C, critAt: CRIT_C });
  else {
    if (macmon.cpu != null) celsius.push({ label: "CPU", celsius: macmon.cpu, warnAt: WARN_C, critAt: CRIT_C });
    if (macmon.gpu != null) celsius.push({ label: "GPU", celsius: macmon.gpu, warnAt: WARN_C, critAt: CRIT_C });
  }
  return celsius.length || throttle ? { celsius, throttle } : null;
}

/**
 * What /api/system carries, or null when this machine says nothing at all.
 *
 * Two fields rather than one list, because they are two different readings and
 * collapsing them would let a throttle percentage be drawn under a °C heading
 * — the thing the label rule exists to prevent. `swapLabel` earned that rule
 * once already.
 */
export async function readThermal(platform = process.platform) {
  if (platform === "linux") {
    const sensors = await readHwmon();
    const celsius = pickThermalRows(sensors);
    const rows = celsius.length ? celsius : await readThermalZones();
    return rows.length ? { celsius: rows, throttle: null } : null;
  }

  if (platform === "darwin") {
    // Scoped by key rather than dumped whole: `ioreg -l` is 217KB and just
    // under two seconds on this machine, `-r -k PerformanceStatistics` is 83KB
    // and 51ms for the same number.
    const [gpu, therm] = await Promise.all([
      run("ioreg", ["-r", "-k", "PerformanceStatistics", "-w", "0"], 3_000),
      run("pmset", ["-g", "therm"]),
    ]);
    const gpuC = gpu ? gpuFromIoreg(gpu) : null;
    const throttle = therm ? throttleFromPmset(therm) : null;

    // Nothing from either is every Apple Silicon Mac, and only those: the AGX
    // driver does not publish the key ioreg reads, and pmset records no speed
    // limit on M-series. Asking macmon is the only thing left, and it is asked
    // ONLY here — an Intel Mac answers above and never spawns it. See
    // macmon.mjs for why a tool the user installed is the whole of the answer.
    const macmon = gpuC == null && !throttle
      ? await (await import("./macmon.mjs")).readMacmonTemps()
      : {};

    return darwinThermal({ gpuC, throttle, macmon });
  }

  if (platform === "win32") {
    // One child for both sources rather than two, because the cost here is the
    // PowerShell start and not the queries: the counter is tried first because
    // it needs no administrator, and MSAcpi only when the counter said nothing.
    // Both are wrapped in their own try — "no thermal zone on this machine" is
    // the ordinary answer and arrives as a throw from either.
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", WIN_THERMAL_PS,
    ], 6_000);
    const answer = out ? parseWinThermal(out.trim()) : [];
    if (answer.length) return { celsius: answer, throttle: null };

    // Windows itself had nothing, which on a modern Intel laptop is every time:
    // the firmware declares no ACPI thermal zone and the sensors sit behind
    // Intel DTT, which an ordinary process may not read. If something on this
    // machine has already gone and got them — LibreHardwareMonitor, with its
    // web server on — they are a plain HTTP read away. Never installed, never
    // asked for. See hwmonitor.mjs.
    const { readHwMonitorTemps } = await import("./hwmonitor.mjs");
    const t = await readHwMonitorTemps();
    const rows = [];
    if (t.cpu != null) rows.push({ label: "CPU", celsius: t.cpu, warnAt: WARN_C, critAt: CRIT_C });
    if (t.gpu != null) rows.push({ label: "GPU", celsius: t.gpu, warnAt: WARN_C, critAt: CRIT_C });
    return rows.length ? { celsius: rows, throttle: null } : null;
  }

  return null;
}
