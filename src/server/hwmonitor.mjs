// Windows' temperature, when something else on the machine already has it.
//
// #747. On a modern Intel laptop Windows publishes no CPU temperature that an
// ordinary process may read. Measured on a physical Windows 11 machine, both
// elevated and not: the firmware declares zero ACPI thermal zones, MSAcpi
// answers "Not supported" even to an administrator, Win32_TemperatureProbe is a
// stub whose every field reads 32768, and the one source that DOES have the
// numbers — Intel Dynamic Tuning's `EsifDeviceInformation` — is Access denied
// without admin. That is the state of Windows, not a gap in this deck: there is
// no standard user-mode API for it, which is why every tool that shows one
// installs a kernel driver.
//
// LibreHardwareMonitor is such a tool. It installs that driver, reads the
// registers directly, and — if its web server is switched on — publishes
// everything as plain HTTP on localhost. Reading THAT needs no privileges at
// all.
//
// SO THIS IS A READ, NEVER A REQUEST. The deck does not install
// LibreHardwareMonitor, does not ask anybody to, and does not mention it: a
// user must do nothing but install ccdeck. If the tool happens to be running —
// and on the machines where this matters it often is, because the person who
// wants a temperature has already gone and got one — the deck uses it. If not,
// the section is not drawn, exactly as before.
import { readTemps } from "./lhm-parse.mjs";

/** LibreHardwareMonitor's default, and Open Hardware Monitor's before it. Not
 *  probed across a range: a scan of somebody's loopback ports is not a thing to
 *  do unasked, and a user who moved the port can say so. */
export const LHM_URL = "http://127.0.0.1:8085/data.json";

/** Short. A refused connection returns at once; this bounds the case where
 *  something else holds the port open and never answers. */
const TIMEOUT_MS = 1_500;

export function lhmUrl(env = process.env) {
  const port = Number(env.AGENTS_DECK_LHM_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536
    ? `http://127.0.0.1:${port}/data.json`
    : LHM_URL;
}

/**
 * CPU and GPU degrees from a running LibreHardwareMonitor, or nothing.
 *
 * Never throws: nothing listening is the ordinary answer, and it arrives as a
 * rejected fetch.
 */
export async function readHwMonitorTemps({ env = process.env, fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(lhmUrl(env), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return {};
    return readTemps(await res.json());
  } catch {
    return {};
  }
}
