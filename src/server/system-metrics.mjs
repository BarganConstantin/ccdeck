// Machine-wide CPU and memory, sampled on our own timer so every open tab reads
// the same numbers.
//
// WHY THE SERVER SAMPLES INSTEAD OF ANSWERING ON DEMAND. CPU utilisation is not
// a value you can read; it is a ratio between two readings. `os.cpus()` returns
// cumulative tick counters, so a percentage only exists relative to a previous
// sample. If the sample were taken when a request arrived, two browser tabs
// polling half a second apart would compute their deltas from different
// baselines and print different percentages for the same machine. One timer in
// one process is the only arrangement where that cannot happen — and it is what
// lets `/api/system` hand back a real 60-second history rather than whatever a
// single tab has managed to collect since it was opened.
//
// WHY THIS NEVER TOUCHES pushEvent. Every event that goes through the deck's
// stream is persisted to events.jsonl and held in the 2000-entry ring buffer. A
// three-second sampler would put 1200 entries an hour into both, evicting real
// tool calls from the replay a reconnecting tab receives, and making an ambient
// readout the loudest producer in the application. So this is a plain poll
// endpoint, exactly like /api/quota and /api/codex-usage already are.
import os from "node:os";
import { loadReading } from "./load-average.mjs";
import { BUCKET_MS, labelsUnder, oldestBucketMs, pointsOf, record, resetHistory } from "./metrics-history.mjs";
import { readAvailable, readSwap } from "./memory-metrics.mjs";
import {
  networkSnapshot, notePanelPoll, probeNetwork, routeChangesSince, sampleNetwork,
  startNetworkTimers, stopNetwork,
} from "./network-sampler.mjs";
import { readProcesses, resetProcessList } from "./process-list.mjs";
import { CRIT_C, readThermal, WARN_C } from "./thermal-metrics.mjs";

/** CPU is the metric with spikes, so it is sampled often enough to catch one. */
const CPU_INTERVAL_MS = 3_000;
/** Memory moves on the scale of minutes. Sampling it at the CPU cadence would
 *  print the same number twenty times and, on macOS, cost a subprocess to do
 *  it — see readAvailable in memory-metrics.mjs. */
const MEM_INTERVAL_MS = 30_000;
/** 20 samples x 3s = the 60 seconds the sparkline draws. */
const HISTORY = 20;

let cpuTimer = null;
let memTimer = null;
let prevTicks = null;
let prevCoreTicks = null;
let cores = null;
let swap = null;
/** Newest last. Seeded empty; the first tick produces no percentage because a
 *  delta needs two readings. */
const cpuHistory = [];
let memory = null;
let memInFlight = false;
let thermal = null;
let thermalTimer = null;
let thermalInFlight = false;
/** Consecutive readings that came back with nothing. See THERMAL_GIVE_UP. */
let thermalMisses = 0;
/** Whether this machine has EVER answered. See sampleThermal. */
let thermalEverAnswered = false;
/** When sampling started, so a modal can say what "since" means. */
let historySince = 0;

/** Total and idle jiffies for one entry of `os.cpus()`. */
function ticksOf(cpu) {
  let idle = 0;
  let total = 0;
  for (const [kind, ms] of Object.entries(cpu.times)) {
    total += ms;
    if (kind === "idle") idle += ms;
  }
  return { idle, total };
}

/**
 * Total and idle jiffies across every core, as one pair.
 *
 * Summed core by core rather than field by field, and that is the same
 * number: the counters are integer milliseconds, and a machine's total is
 * nowhere near 2^53, where adding them in another order could round.
 */
function readTicks() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = ticksOf(cpu);
    idle += t.idle;
    total += t.total;
  }
  return { idle, total };
}

/** The same pair, per core, in `os.cpus()` order. */
function readCoreTicks() {
  return os.cpus().map(ticksOf);
}

/**
 * Busy percentage per core since the previous reading.
 *
 * The aggregate figure the topbar draws hides the shape of the load, and the
 * shape is what tells a saturated machine from a machine running one hot
 * single-threaded job. Same delta arithmetic as `cpuPercent`, one row per core,
 * and the same refusal to invent a number before there are two readings.
 */
function corePercents() {
  const now = readCoreTicks();
  const prev = prevCoreTicks;
  prevCoreTicks = now;
  if (!prev || prev.length !== now.length) return null;
  return now.map((c, i) => {
    const dTotal = c.total - prev[i].total;
    const dIdle = c.idle - prev[i].idle;
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1000) / 10));
  });
}

/**
 * Busy percentage across all cores since the previous reading, 0-100.
 *
 * Aggregate rather than per-core, and normalised rather than macOS's
 * 0-to-cores*100 convention, because it has to mean the same thing on all three
 * platforms and because a bar needs an end. The cost is that it saturates: a
 * machine at load 12 and a machine at load 18 both read 100. `loadavg` is what
 * carries that difference, which is why it rides along below on the platforms
 * that report it.
 */
function cpuPercent() {
  const now = readTicks();
  if (!prevTicks) { prevTicks = now; return null; }
  const dTotal = now.total - prevTicks.total;
  const dIdle = now.idle - prevTicks.idle;
  prevTicks = now;
  // A tick counter that did not move says nothing; it does not say "idle".
  if (dTotal <= 0) return null;
  const pct = (1 - dIdle / dTotal) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

/**
 * The process list, which lives in process-list.mjs: it is read on demand
 * rather than on a timer here, and index.mjs asks this module for it.
 */
export { readProcesses };

/**
 * The network probe, which lives in network-sampler.mjs with the rest of that
 * section: re-exported because this module is where the suite reaches it.
 */
export { probeNetwork };

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
    record(`thermal:${THROTTLE_LABEL}`, Math.max(0, 100 - reading.throttle.speedLimit), nowMs);
  }
}

/** The one thermal row that is not degrees. Named once so the recorder, the
 *  route and the panel cannot drift apart on the spelling. */
export const THROTTLE_LABEL = "Throttling";

/**
 * The scale a series is drawn against.
 *
 * Fixed at 100 wherever the PANEL draws the same number against a 0-100 track,
 * because two pictures of one reading that disagree about how alarming it is
 * would be worse than either alone. Load average is the exception and gets a
 * fitted top: it is genuinely unbounded — measured at 114 on a twelve-core
 * machine — and the section that shows it draws no track at all, so there is no
 * competing picture for a fitted scale to contradict. Rounded up to something a
 * person would choose, and floored at one and a half times the core count so a
 * quiet machine is not drawn as a dramatic climb.
 */
function loadTop(points, coreCount) {
  const peak = points.reduce((a, p) => Math.max(a, p.v), 0);
  const floor = Math.max(4, Math.ceil(coreCount * 1.5));
  const want = Math.max(floor, peak * 1.15);
  const step = want <= 20 ? 5 : want <= 100 ? 10 : 50;
  return Math.ceil(want / step) * step;
}

/**
 * What each section's chart is made of.
 *
 * One entry per series, each carrying its own unit, its own bands and its own
 * scale, because a percentage, a temperature and a queue depth share nothing —
 * drawing them against one axis would invite a reading of one shape against
 * another that means nothing.
 */
function seriesFor(group) {
  const at = pointsOf;
  const coreCount = os.cpus().length;

  if (group === "thermal") return thermalSeries(at);
  if (group === "cores") return coreSeries(at);
  if (group === "memory") return memorySeries(at);
  if (group === "load") return loadSeries(at, coreCount);
  if (group === "network") return networkSeries(at);
  return [];
}

/** The thermal chart: a series per sensor the ring holds points for, in the
 *  order each first appeared — throttling among them, where it is recorded. */
function thermalSeries(at) {
  const bands = new Map((lastThermal()?.celsius ?? []).map(r => [r.label, r]));
  const labels = labelsUnder("thermal:");
  return labels.map(label => ({
    // The stable name of this reading, which the display label is not: `Swap`
    // is `Commit` on Windows, and anything joining on what the eye sees
    // breaks on the one platform nobody re-reads this on. It is the key the
    // ring is already recorded under, published rather than invented.
    key: `thermal:${label}`,
    label,
    unit: label === THROTTLE_LABEL ? "%" : "C",
    top: 100,
    // Throttling is the one reading here whose normal value is zero, so it
    // is the one that does not need a full-height box to be read. Said by the
    // series rather than inferred from "has no bands", which was the first
    // rule and was wrong: CPU has no bands DELIBERATELY and uses the whole
    // scale, so it was getting the short box for a reason that is not true
    // of it.
    restsAtZero: label === THROTTLE_LABEL,
    warnAt: label === THROTTLE_LABEL ? null : (bands.get(label)?.warnAt ?? WARN_C),
    critAt: label === THROTTLE_LABEL ? null : (bands.get(label)?.critAt ?? CRIT_C),
    points: at(`thermal:${label}`),
  }));
}

/** The cores chart: the whole machine, and its busiest core. */
function coreSeries(at) {
  // Not one line per core: twelve lines in a 620px dialog is a picture nobody
  // can read. These two answer what the columns cannot answer over time —
  // "all cores" at 20 with "busiest" at 100 is ONE core pinned, which is a
  // different machine from twelve at 20.
  //
  // No bands, deliberately, and the reason is written at the top of
  // MachinePanel: a CPU at 90% is the machine doing the work you asked for. An
  // indicator that alarms during the normal case teaches you to stop reading
  // it.
  return [
    { key: "cpu:all", label: "All cores", unit: "%", top: 100, warnAt: null, critAt: null, points: at("cpu:all"), restsAtZero: false },
    { key: "cpu:busiest", label: "Busiest core", unit: "%", top: 100, warnAt: null, critAt: null, points: at("cpu:busiest"), restsAtZero: false },
  ].filter(s => s.points.length);
}

/** The memory chart: physical memory, and swap — commit, on Windows. */
function memorySeries(at) {
  const swapLabel = process.platform === "win32" ? "Commit" : "Swap";
  return [
    // One band, not two. A `critAt` of 100 draws a rule along the top of a
    // chart whose scale ends at 100 — it is the ceiling, drawn again in red,
    // and it says nothing the edge did not.
    { key: "mem:physical", label: "Physical", unit: "%", top: 100, warnAt: 90, critAt: null, restsAtZero: false, points: at("mem:physical") },
    { key: "mem:swap", label: swapLabel, unit: "%", top: 100, warnAt: 90, critAt: null, restsAtZero: false, points: at("mem:swap") },
  ].filter(s => s.points.length);
}

/** The load chart: the one-minute load average, against the core count. */
function loadSeries(at, coreCount) {
  // One series, not three. 1m, 5m and 15m are three views of one number —
  // the longer two are the short one smoothed — so charting the 1m over an
  // hour says everything the other two would, at the resolution they hide.
  const points = at("load:1m");
  if (!points.length) return [];
  return [{
    key: "load:1m",
    label: "Queued work",
    unit: "",
    top: loadTop(points, coreCount),
    // Where the queue exceeds the cores there are to run it, which is the one
    // number the section's own note already draws the line at.
    warnAt: coreCount,
    critAt: null,
    restsAtZero: false,
    points,
  }];
}

/** The network charts: download, upload and API latency, with each route
 *  change marked on the last of them. */
function networkSeries(at) {
  // Download and upload are two charts, not two lines on one: upload is
  // usually a hundredth of download, and on a shared scale it is a line along
  // the floor. Each gets a top fitted to its own peak. No bands: there is no
  // throughput that is too much, only more than usual, and a threshold here
  // would be a number this module made up.
  const down = at("net:down");
  const up = at("net:up");
  const api = at("net:api");
  const series = [
    // Floors of 100 KB/s and 100 ms, so a quiet line is drawn as quiet.
    { key: "net:down", label: "Download", unit: "B/s", top: niceTop(down, 100_000), warnAt: null, critAt: null, restsAtZero: false, points: down },
    { key: "net:up", label: "Upload", unit: "B/s", top: niceTop(up, 100_000), warnAt: null, critAt: null, restsAtZero: false, points: up },
    { key: "net:api", label: "Claude API latency", unit: "ms", top: niceTop(api, 100), warnAt: null, critAt: null, restsAtZero: false, points: api },
  ].filter(s => s.points.length);
  // The path the traffic took, as marks on the last chart — the question the
  // section exists for is "was it the VPN", and a line that jumps where a
  // mark sits answers it without a legend.
  const changes = routeChangesSince(oldestBucketMs());
  if (series.length && changes.length) series[series.length - 1].changes = changes;
  return series;
}

/** A scale top a person would choose — 1, 2 or 5 times a power of ten — just
 *  above the peak, and never below `floor`, so an idle line is not drawn as a
 *  dramatic climb. */
function niceTop(points, floor) {
  const peak = points.reduce((a, p) => Math.max(a, p.v), 0);
  const want = Math.max(floor, peak * 1.15);
  const pow = 10 ** Math.floor(Math.log10(want));
  for (const m of [1, 2, 5, 10]) if (m * pow >= want) return m * pow;
  return want;
}

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

/** What /api/system/history answers, for one section. */
export function historySnapshot(group) {
  return { ok: true, sinceMs: historySince, stepMs: BUCKET_MS, series: seriesFor(group) };
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
    const next = await read();
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
 *  and once a silence has dropped it. The thermal chart's bands come from it. */
function lastThermal() {
  return thermal;
}

/** The thermal row /api/system answers: the last reading, with whether the
 *  machine has been held back since the deck started, or null without one. */
function thermalSnapshot() {
  return thermal ? { ...thermal, heldBack: heldBackSoFar() } : null;
}

/** The ten-second timer, made where startSystemMetrics makes the others and
 *  unref'd like them. Once a give-up has stopped it, fetchMacmon is what makes
 *  it again. */
function startThermalTimer() {
  thermalTimer = setInterval(sampleThermal, THERMAL_INTERVAL_MS);
  thermalTimer.unref?.();
}

/** Stop the timer and forget the reading, the misses and whether this machine
 *  ever answered — this section's half of stopSystemMetrics, and there for the
 *  same reason (#798). */
function stopThermal() {
  if (thermalTimer) clearInterval(thermalTimer);
  thermalTimer = null;
  thermal = null;
  thermalMisses = 0;
  thermalEverAnswered = false;
}

async function sampleMemory() {
  if (memInFlight) return;
  memInFlight = true;
  try {
    const total = os.totalmem();
    const available = await readAvailable();
    // A poll that could not measure leaves the last reading standing and puts
    // nothing in the history (#789). Recording a guess here is worse than
    // recording nothing twice over: the meter would go red for 30 seconds, and
    // the bucket's Math.max would keep that peak on the chart for a day.
    // Swap below is a separate measurement and is still taken.
    if (available != null) {
      memory = {
        total,
        available,
        usedPct: Math.max(0, Math.min(100, Math.round(((total - available) / total) * 1000) / 10)),
      };
      record("mem:physical", memory.usedPct);
    }
    // Same 30s cadence as memory, and for the same reason: it moves in minutes
    // and costs a subprocess on two of the three platforms.
    swap = await readSwap();
    if (swap && swap.total > 0) record("mem:swap", Math.round((swap.used / swap.total) * 1000) / 10);
  } catch { /* keep the previous reading rather than blanking the meter */ }
  finally { memInFlight = false; }
}

function sampleCpu() {
  const per = corePercents();
  const pct = cpuPercent();
  if (pct == null) return;
  cores = per;
  cpuHistory.push(pct);
  while (cpuHistory.length > HISTORY) cpuHistory.shift();
  record("cpu:all", pct);
  if (per?.length) record("cpu:busiest", Math.max(...per));
  // Free, so it rides the CPU tick rather than earning a timer — and null on
  // Windows, which publishes no load average. loadReading holds the rule and
  // the #1028 story behind it; the snapshot's `loadavg` asks the same function.
  const load = loadReading();
  if (load) record("load:1m", load[0]);
}

/**
 * Begin sampling. Idempotent, and every timer is unref'd so this can never be
 * the reason the process stays alive.
 *
 * `probe` is the network section's permission to leave the machine — latency to
 * the API and the route there. The server passes it; nothing else should.
 */
export function startSystemMetrics({ probe = false } = {}) {
  if (cpuTimer) return;
  prevTicks = readTicks();          // baseline, so the first tick has a delta
  prevCoreTicks = readCoreTicks();
  sampleMemory();
  historySince = Date.now();
  sampleThermal();
  sampleNetwork();
  cpuTimer = setInterval(sampleCpu, CPU_INTERVAL_MS);
  memTimer = setInterval(sampleMemory, MEM_INTERVAL_MS);
  startThermalTimer();
  startNetworkTimers(probe);
  cpuTimer.unref?.();
  memTimer.unref?.();
}

/**
 * Stop the three timers and reset every reading this module holds.
 *
 * THE SUITE'S, AND SAID PLAINLY (#798). Production starts the loop once at boot
 * and never stops it — the process ending is what stops it — so an audit
 * grepping for callers finds none, and the honest answer is not to delete this
 * but to name what it is for. It is a RESET as much as a stop: `history`,
 * `thermal`, the CPU baselines and the miss counters all go back to their
 * initial values, which is exactly what a case needs between two runs of
 * `startSystemMetrics` in one process, and what nothing else in this module
 * offers. Deleting it would leave the suite leaking intervals into the values
 * the next case reads.
 *
 * That is also why it is safe as a test-only export where the four removed in
 * #798 were not: there is no shipped counterpart for it to drift away from. The
 * state it clears IS the state every other assertion here reads.
 */
export function stopSystemMetrics() {
  if (cpuTimer) clearInterval(cpuTimer);
  if (memTimer) clearInterval(memTimer);
  cpuTimer = memTimer = null;
  stopThermal();
  stopNetwork();
  resetHistory();
  historySince = 0;
  prevTicks = null;
  prevCoreTicks = null;
  cpuHistory.length = 0;
  memory = null;
  cores = null;
  swap = null;
  // The process list's Windows baseline and its last list, which go together.
  resetProcessList();
}

/**
 * What /api/system answers.
 *
 * `cpu` is null until two samples exist — the meter draws its track and no fill
 * rather than printing a zero it has not measured. `loadavg` is omitted on
 * Windows, where the API returns [0, 0, 0]: three zeros are not a reading, and
 * showing them as one would be the same lie in a different place.
 */
export function systemSnapshot() {
  const cpu = cpuHistory.length ? cpuHistory[cpuHistory.length - 1] : null;
  notePanelPoll();
  return {
    ok: true,
    cpu,
    cpuHistory: [...cpuHistory],
    cores: os.cpus().length,
    memory,
    swap,
    perCore: cores,
    // Null on a machine that publishes nothing, and the panel draws no section
    // at all for it rather than an empty one.
    thermal: thermalSnapshot(),
    uptimeSec: Math.round(os.uptime()),
    platform: process.platform,
    // The rule the `load:1m` record in sampleCpu asks too — see loadReading.
    loadavg: loadReading(),
    network: networkSnapshot(),
    intervalMs: CPU_INTERVAL_MS,
    sampledAt: Date.now(),
  };
}
