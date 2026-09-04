// Windows' temperature, when something else on the machine already has it
// (#747).
//
// Measured on a physical Windows 11 laptop, both elevated and not: the firmware
// declares zero ACPI thermal zones, MSAcpi answers "Not supported" even to an
// administrator, Win32_TemperatureProbe reads 32768 in every field, and the one
// source that HAS the numbers — Intel Dynamic Tuning's EsifDeviceInformation —
// is Access denied without admin. There is no standard user-mode Windows API
// for CPU temperature, which is why every tool that shows one installs a kernel
// driver.
//
// LibreHardwareMonitor is such a tool, and when its web server is on it
// publishes everything as plain HTTP on localhost — which needs no privileges
// to read. This is a READ, never a request: the deck does not install it, does
// not ask for it, and does not mention it. A user installs ccdeck and nothing
// else. If the tool happens to be running, its numbers are used; if not, the
// section is not drawn, exactly as before.
//
// The shape below is not from an example. It is what `GenerateJsonForNode` in
// LibreHardwareMonitor's own HttpServer.cs emits.
import { describe, it, expect } from "vitest";

// @ts-expect-error — plain .mjs modules, no types
const { flattenSensors, readTemps } = await import("../../server/lhm-parse.mjs");
// @ts-expect-error — ditto
const { readHwMonitorTemps, lhmUrl, LHM_URL } = await import("../../server/hwmonitor.mjs");

/** A tree in the shape the server really builds: root → computer → hardware →
 *  type → sensor, with the sensor node carrying SensorId, Type, Value and
 *  RawValue. */
const TREE = {
  id: 0, Text: "Sensor", Value: "Value", Children: [{
    id: 1, Text: "DESKTOP-F7F9RUQ", Children: [
      {
        id: 2, Text: "Intel Core i5-9300H", HardwareId: "/intelcpu/0", Children: [{
          id: 3, Text: "Temperatures", Children: [
            // Deliberately culture-formatted with a comma, which is what a
            // German or Russian Windows really sends.
            { id: 4, Text: "CPU Core #1", SensorId: "/intelcpu/0/temperature/0", Type: "Temperature", Value: "45,0 °C", RawValue: 45.0 },
            { id: 5, Text: "CPU Core #4", SensorId: "/intelcpu/0/temperature/3", Type: "Temperature", Value: "69,0 °C", RawValue: 69.0 },
            { id: 6, Text: "CPU Package", SensorId: "/intelcpu/0/temperature/4", Type: "Temperature", Value: "52,0 °C", RawValue: 52.0 },
          ],
        }, {
          id: 7, Text: "Clocks", Children: [
            { id: 8, Text: "Bus Speed", SensorId: "/intelcpu/0/clock/0", Type: "Clock", RawValue: 99.8 },
          ],
        }],
      },
      {
        id: 9, Text: "NVIDIA GeForce GTX 1650", HardwareId: "/gpu-nvidia/0", Children: [{
          id: 10, Text: "Temperatures", Children: [
            { id: 11, Text: "GPU Core", SensorId: "/gpu-nvidia/0/temperature/0", Type: "Temperature", RawValue: 41.0 },
            // The server serialises with AllowNamedFloatingPointLiterals, so a
            // sensor that has not read arrives as the STRING "NaN".
            { id: 12, Text: "GPU Hot Spot", SensorId: "/gpu-nvidia/0/temperature/2", Type: "Temperature", RawValue: "NaN" },
          ],
        }],
      },
    ],
  }],
};

describe("reading the sensor tree", () => {
  it("finds every temperature and nothing else", () => {
    const found = flattenSensors(TREE);
    expect(found.map((s: any) => s.name)).toEqual([
      "CPU Core #1", "CPU Core #4", "CPU Package", "GPU Core", "GPU Hot Spot",
    ]);
    // The Clock sensor is not a temperature. `Type` comes from an enum and is
    // the same word on every machine; the name beside it is a display string
    // that differs between vendors and driver versions.
    expect(found.map((s: any) => s.name)).not.toContain("Bus Speed");
  });

  it("takes RawValue and never the formatted string", () => {
    // `Value` is written with the machine's culture — "52,0 °C" on a German or
    // Russian Windows — and every naive parse of it either loses the decimal or
    // produces 520. This deck has hit that exact trap once before, with `ps`
    // output, and fixed it with LC_NUMERIC.
    const pkg = flattenSensors(TREE).find((s: any) => s.name === "CPU Package");
    expect(pkg.celsius).toBe(52);
  });

  it("drops a sensor that has not read, which arrives as the string NaN", () => {
    expect(readTemps(TREE)).not.toHaveProperty("hotspot");
    const hot = flattenSensors(TREE).find((s: any) => s.name === "GPU Hot Spot");
    expect(Number.isFinite(hot.celsius)).toBe(false);
  });
});

describe("choosing which sensor is the CPU", () => {
  it("picks by identifier, not by display name", () => {
    // `/intelcpu/0/…` and `/gpu-nvidia/0/…` are built from the hardware type
    // and are the same everywhere. "CPU Package" reads "Core (Tctl/Tdie)" on
    // AMD and something else again on the next driver.
    expect(readTemps(TREE)).toEqual({ cpu: 69, gpu: 41 });
  });

  it("takes the hottest of a hardware's sensors, not the first", () => {
    // A CPU publishes a package reading and one per core. Reporting core #1
    // while core #6 is throttling would be the panel showing the calmest number
    // it could find — and every bar in this panel fills with the PROBLEM.
    const only = readTemps(TREE);
    expect(only.cpu).toBe(69);
    expect(only.cpu).not.toBe(45);
    expect(only.cpu).not.toBe(52);
  });

  it("knows AMD as well as Intel", () => {
    const amd = { Children: [{ Children: [{
      SensorId: "/amdcpu/0/temperature/0", Type: "Temperature", Text: "Core (Tctl/Tdie)", RawValue: 61.5,
    }] }] };
    expect(readTemps(amd)).toEqual({ cpu: 62 });
  });

  it("reports a CPU with no GPU, and a GPU with no CPU", () => {
    const cpuOnly = { Children: [{ SensorId: "/intelcpu/0/temperature/0", Type: "Temperature", RawValue: 50 }] };
    expect(readTemps(cpuOnly)).toEqual({ cpu: 50 });
    const gpuOnly = { Children: [{ SensorId: "/gpu-amd/0/temperature/0", Type: "Temperature", RawValue: 44 }] };
    expect(readTemps(gpuOnly)).toEqual({ gpu: 44 });
  });

  it("refuses a reading no sensor produces", () => {
    for (const v of [0, -20, 200, "NaN", null, undefined, "warm"]) {
      const t = { Children: [{ SensorId: "/intelcpu/0/temperature/0", Type: "Temperature", RawValue: v }] };
      expect(readTemps(t)).toEqual({});
    }
  });

  it("answers nothing for every shape that is not a tree", () => {
    for (const junk of [null, undefined, {}, [], "text", 42]) {
      expect(readTemps(junk as never)).toEqual({});
    }
  });

  it("does not hang on a tree that points at itself", () => {
    // JSON cannot contain a cycle, but a hand-written fixture can, and a walk
    // with no bound would be an unkillable poll every ten seconds.
    const loop: Record<string, unknown> = { Text: "loop" };
    loop.Children = [loop];
    expect(() => readTemps(loop as never)).not.toThrow();
  });
});

describe("asking the local server", () => {
  it("asks LibreHardwareMonitor's own default port", () => {
    expect(LHM_URL).toBe("http://127.0.0.1:8085/data.json");
    // 127.0.0.1 rather than localhost: on a machine where localhost resolves to
    // ::1 first, the v4-only listener is a connection refused and a wasted
    // round trip.
    expect(lhmUrl({})).toContain("127.0.0.1");
  });

  it("takes a port from the environment for somebody who moved it", () => {
    expect(lhmUrl({ AGENTS_DECK_LHM_PORT: "9000" })).toBe("http://127.0.0.1:9000/data.json");
    for (const bad of ["0", "-1", "70000", "eight", ""]) {
      expect(lhmUrl({ AGENTS_DECK_LHM_PORT: bad })).toBe(LHM_URL);
    }
  });

  it("reads the tree when something answers", async () => {
    const fetchFn = async () => ({ ok: true, json: async () => TREE }) as never;
    expect(await readHwMonitorTemps({ env: {}, fetchFn })).toEqual({ cpu: 69, gpu: 41 });
  });

  it("answers nothing when nothing is listening, which is the ordinary case", async () => {
    // Not an error and not a warning: most machines are not running a hardware
    // monitor, and the deck must never suggest they should.
    const refused = async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
    expect(await readHwMonitorTemps({ env: {}, fetchFn: refused as never })).toEqual({});
  });

  it("answers nothing when something else holds that port", async () => {
    const notLhm = async () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } }) as never;
    expect(await readHwMonitorTemps({ env: {}, fetchFn: notLhm as never })).toEqual({});
    const http404 = async () => ({ ok: false, status: 404 }) as never;
    expect(await readHwMonitorTemps({ env: {}, fetchFn: http404 as never })).toEqual({});
  });
});
