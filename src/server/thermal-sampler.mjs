// The Machine panel's thermal section: the sampler that asks this machine
// whether it is getting hot, every ten seconds, and stops asking one that has
// never answered.
//
// Moved out of system-metrics.mjs unchanged. What is asked, and how each
// platform's answer is read, is thermal-metrics.mjs, which keeps no state; the
// minute ring the readings are recorded into is metrics-history.mjs.
// system-metrics.mjs starts and stops this section (startThermalTimer,
// stopThermal), draws the thermal chart with the bands of lastThermal, puts
// thermalSnapshot on /api/system, and re-exports sampleThermal and
// THROTTLE_LABEL, which is where the suite reaches them.
import { pointsOf, record } from "./metrics-history.mjs";
import { heldShare, readThermal } from "./thermal-metrics.mjs";

// ---------------------------------------------------------------------------
// Thermal: how often this machine is asked whether it is getting hot, and when
// one that has never answered stops being asked. What is asked, and why those
// sources on each platform, is thermal-metrics.mjs.

/** How often the thermal reading is refreshed. Heat moves on the scale of
 *  seconds, and the two platforms that cost a subprocess to ask cost 51ms
 *  (`ioreg`) and rather less (`pmset`), measured. Linux costs a file read. */
const THERMAL_INTERVAL_MS = 10_000;

/**
 * How many consecutive empty readings before this machine is left alone.
 *
 * The reason is Windows, where MSAcpi_ThermalZoneTemperature is absent on a
 * large share of desktops: without this, every one of those machines would pay
 * a `Get-CimInstance` child every ten seconds, forever, to render a section it
 * can never render. Three rather than one because a single failure can be a
 * hiccup — a timeout, a machine mid-wake — and giving up on a hiccup would lose
 * a reading the machine does have.
 *
 * Not persisted. A restart asks again, which is what should happen after the
 * user installs a driver or changes a firmware setting.
 */
const THERMAL_GIVE_UP = 3;

let thermal = null;
let thermalTimer = null;
let thermalInFlight = false;
/** Consecutive readings that came back with nothing. See THERMAL_GIVE_UP. */
let thermalMisses = 0;
/** Whether this machine has EVER answered. See sampleThermal. */
let thermalEverAnswered = false;

/**
 * The thermal reading, whose series are not known until the machine answers.
 *
 * Keyed by the row's own label rather than by position, because the rows are
 * not the same on every platform and a machine can start reporting a sensor it
 * was not reporting before — a GPU driver loads, a laptop is docked. A series
 * that appears late simply has no points before it appeared, which is the truth
 * and draws correctly.
 */
function recordThermal(reading, nowMs = Date.now()) {
  if (!reading) return;
  for (const r of reading.celsius ?? []) record(`thermal:${r.label}`, r.celsius, nowMs);
  // Stored as the share TAKEN AWAY, the same way the panel draws it, so the
  // chart and the row cannot disagree about which direction is bad.
  if (reading.throttle) {
    record(`thermal:${THROTTLE_LABEL}`, heldShare(reading.throttle), nowMs);
  }
}

/** The one thermal row that is not degrees. Named once so the recorder, the
 *  route and the panel cannot drift apart on the spelling. */
export const THROTTLE_LABEL = "Throttling";

/**
 * Whether this machine has been held back AT ALL since the deck started, and
 * when it last was.
 *
 * The row reports the current sample, and on a desktop that current sample is
 * `0%` essentially always — measured here: ninety seconds of AES-NI on twelve
 * cores never moved `CPU_Speed_Limit` off 100. Which is the truth, and which
 * reads as "this readout does not work" the second time somebody looks at it.
 * It was reported that way twice.
 *
 * So the note under the row gets to say the other thing. Nothing new is
 * sampled for it: the minute buckets already hold the peak of every minute, and
 * this is a scan of what is already there. A machine that has never been
 * throttled says so; one that was at lunchtime says when.
 */
function heldBackSoFar() {
  const key = `thermal:${THROTTLE_LABEL}`;
  let peak = 0;
  let lastMs = 0;
  for (const { t, v } of pointsOf(key)) {
    if (v <= 0) continue;
    if (v > peak) peak = v;
    lastMs = t;
  }
  return peak > 0 ? { peak, lastMs } : null;
}

/**
 * One reading at a time, and a machine that cannot answer is asked three times
 * rather than for the life of the process.
 *
 * `deps.read` is a seam rather than a convenience: the rule this function
 * exists for only fires on a machine that answers with nothing, and the machine
 * this was written on answers with something, so there is no other way to run
 * the branch that matters.
 */
export async function sampleThermal(deps = {}) {
  if (thermalInFlight) return;
  // Giving up is only ever for a machine that has NEVER answered — the Windows
  // desktop with no MSAcpi class, which would otherwise pay a PowerShell child
  // every ten seconds for the life of the process. A machine that answered once
  // has a sensor, and it keeps being asked however long the silence runs.
  if (!thermalEverAnswered && thermalMisses >= THERMAL_GIVE_UP) return;
  const read = deps.read ?? readThermal;
  thermalInFlight = true;
  try {
    // The last reading goes back in because Linux throttling is the difference
    // between its count and this one's. See readThermal.
    const next = await read(process.platform, thermal);
    if (next) { thermal = next; thermalMisses = 0; thermalEverAnswered = true; recordThermal(next); }
    else if (++thermalMisses >= THERMAL_GIVE_UP) {
      // DROP THE LAST READING. It used to be kept, and that is a number from
      // four minutes ago printed as though it were now — the one thing this
      // whole section refuses. A GPU driver unloads, a laptop is docked, a
      // sensor goes away: the honest answer is that the section stops being
      // drawn, not that it freezes.
      thermal = null;
      // But keep ASKING on a machine that has answered before. The cost
      // argument for giving up was only ever about a machine that can never
      // answer — a Windows desktop with no MSAcpi class paying a PowerShell
      // child every ten seconds forever. One that answered has a sensor, and a
      // silence is a gap rather than an absence.
      if (!thermalEverAnswered && thermalTimer) {
        clearInterval(thermalTimer);
        thermalTimer = null;
      }
      // The one machine where "nothing" is worth doing something about: an
      // Apple Silicon Mac has sensors and no way to read them, and the tool
      // that can is a 746 KB signed binary this deck can fetch. Started HERE
      // rather than at boot on purpose — the boot was just taught not to wait
      // for an install (#742) and nothing waits for this one either. One
      // attempt per process, and only after the give-up, so a machine that
      // does have a sensor never downloads anything. See macmon.mjs.
      if (!thermalEverAnswered && process.platform === "darwin") fetchMacmon(deps);
    }
  } catch { thermalMisses++; }
  finally { thermalInFlight = false; }
}

/**
 * Fetch macmon, then ask again — floating, on purpose.
 *
 * Not awaited by sampleThermal, which is itself not awaited by anything: this
 * is a download that may take a minute on a slow line, and the panel it serves
 * is optional. When it lands, the give-up above has already stopped the timer,
 * so the retry has to be made here rather than waited for.
 */
function fetchMacmon(deps = {}) {
  const boot = deps.bootstrap ?? (async () => (await import("./macmon.mjs")).bootstrapMacmon());
  Promise.resolve(boot()).then(r => {
    if (!r?.ok) return;
    // A sensor exists after all. Clear the give-up and let the timer run again,
    // which is what turns a downloaded binary into a section on screen without
    // the user restarting anything.
    thermalMisses = 0;
    if (!thermalTimer) {
      thermalTimer = setInterval(() => { sampleThermal(deps); }, THERMAL_INTERVAL_MS);
      // Unref'd like the one startThermalTimer creates: a poll for an optional
      // panel must not be the reason a process refuses to exit.
      thermalTimer.unref?.();
    }
    sampleThermal(deps);
  }).catch(() => {});
}

/** The last reading, or null while there is none — before the first answer,
 *  and once a silence has dropped it. The thermal chart's bands come from it
 *  (thermalSeries in system-metrics.mjs). */
export function lastThermal() {
  return thermal;
}

/** The thermal row /api/system answers: the last reading, with whether the
 *  machine has been held back since the deck started, or null without one —
 *  and null for a reading with nothing to draw, which is a Windows machine
 *  whose zones have not moved yet (readWindowsThermal). The panel draws a
 *  section for any object it is handed, and an empty one is not a reading. */
export function thermalSnapshot() {
  if (!thermal) return null;
  // The raw kernel count and the zones' first values are the sampler's, for
  // the next reading, and not readings: the route answers what the panel draws.
  const { throttleCount, zonesSeen, ...shown } = thermal;
  if (!shown.celsius?.length && !shown.throttle) return null;
  return { ...shown, heldBack: heldBackSoFar() };
}

/** The ten-second timer, made where startSystemMetrics in system-metrics.mjs
 *  makes the others and unref'd like them. Once a give-up has stopped it,
 *  fetchMacmon is what makes it again. */
export function startThermalTimer() {
  thermalTimer = setInterval(sampleThermal, THERMAL_INTERVAL_MS);
  thermalTimer.unref?.();
}

/** Stop the timer and forget the reading, the misses and whether this machine
 *  ever answered — this section's half of stopSystemMetrics in
 *  system-metrics.mjs, and there for the same reason (#798). */
export function stopThermal() {
  if (thermalTimer) clearInterval(thermalTimer);
  thermalTimer = null;
  thermal = null;
  thermalMisses = 0;
  thermalEverAnswered = false;
}
