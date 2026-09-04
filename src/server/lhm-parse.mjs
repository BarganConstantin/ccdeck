// Reading LibreHardwareMonitor's sensor tree, out of the shape its own source
// produces rather than out of an example.
//
// `GenerateJsonForNode` in HttpServer.cs builds every node as
//
//   { id, Text, Min, Value, Max }
//
// and a SENSOR node adds
//
//   SensorId : "/intelcpu/0/temperature/0"     the stable identifier
//   Type     : "Temperature"                    the SensorType enum, as text
//   Value    : "52.0 °C"                        formatted for a human
//   RawValue : 52.0                             the number, unformatted
//
// Two of those decide this file.
//
// RAWVALUE, NEVER VALUE. `Value` is formatted with the machine's culture, so on
// a German or Russian Windows it reads "52,0 °C" — a comma — and every naive
// parse of it either throws away the decimal or produces 520. `RawValue` is the
// number itself. This is the same trap the deck already hit once with `ps`
// output and fixed with LC_NUMERIC.
//
// AND RAWVALUE CAN BE THE STRING "NaN". The server serialises with
// JsonNumberHandling.AllowNamedFloatingPointLiterals, which writes a NaN as a
// quoted "NaN" rather than failing — so a sensor that has not read yet arrives
// as text where a number is expected. `Number("NaN")` is NaN and is rejected
// below, which is the right answer, but it is rejected on purpose rather than
// by luck.
//
// TYPE, NEVER THE NAME. `Type` comes from an enum and is the same word on every
// machine in every language; the `Text` beside it is a display name that
// differs between vendors and driver versions.

/** A plausible temperature. The same floor the rest of the thermal code uses:
 *  0 is a sensor that has not read, and nothing above this is a temperature. */
const plausible = (c) => Number.isFinite(c) && c > 0 && c < 150;

/**
 * Every temperature sensor in the tree, flattened.
 *
 * Exported for its own test, and because "what did that machine actually
 * publish" is the question anybody debugging this will have first.
 */
export function flattenSensors(root) {
  const out = [];
  const walk = (n, depth) => {
    // The tree is four or five deep in practice — root, computer, hardware,
    // type, sensor. The bound is against a cycle, which JSON cannot contain but
    // a hand-written fixture can.
    if (!n || typeof n !== "object" || depth > 12) return;
    if (n.Type === "Temperature") {
      out.push({
        id: String(n.SensorId ?? ""),
        name: String(n.Text ?? ""),
        celsius: Number(n.RawValue),
      });
    }
    if (Array.isArray(n.Children)) for (const c of n.Children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

/**
 * Which sensor is the CPU, and which is the GPU.
 *
 * Chosen by SensorId rather than by name. The identifier is built from the
 * hardware type — `/intelcpu/0/…`, `/amdcpu/0/…`, `/gpu-nvidia/0/…` — and is
 * the same on every machine, while `Text` is a display name that reads "CPU
 * Package" on one driver and "Core (Tctl/Tdie)" on another.
 *
 * The HOTTEST of a hardware's sensors is taken, not the first. A CPU publishes
 * a package reading and one per core; the package is usually the highest and is
 * what a person means by "the CPU temperature", and where a vendor publishes no
 * package the hottest core is the honest stand-in. Taking the first would
 * report core #1 while core #6 is thermal-throttling.
 */
export function readTemps(root) {
  const sensors = flattenSensors(root).filter(s => plausible(s.celsius));
  const hottest = (re) => {
    const mine = sensors.filter(s => re.test(s.id));
    if (!mine.length) return null;
    return Math.round(Math.max(...mine.map(s => s.celsius)));
  };
  const out = {};
  const cpu = hottest(/^\/(intel|amd)cpu\//i);
  const gpu = hottest(/^\/gpu-/i);
  if (cpu != null) out.cpu = cpu;
  if (gpu != null) out.gpu = gpu;
  return out;
}
