// The Machine panel's network section: the sampler that reads the counters,
// times the connection to Claude and notes which way the traffic to it goes.
//
// Moved out of system-metrics.mjs unchanged. How each platform's answer is
// parsed is network-metrics.mjs, which stays pure, and the minute ring these
// readings are recorded into is metrics-history.mjs. system-metrics.mjs starts
// and stops this section (startNetworkTimers, stopNetwork), tells it when the
// panel polls (notePanelPoll), puts networkSnapshot on /api/system and
// routeChangesSince on the network chart, and re-exports probeNetwork, which is
// where the suite reaches it.
import { lookup } from "node:dns/promises";
import { access, readdir, readFile } from "node:fs/promises";
import net from "node:net";
import { hasClaudeInstalled } from "./claude-dir.mjs";
import { record } from "./metrics-history.mjs";
import { run } from "./metrics-run.mjs";
import {
  classifyRoute, parseNetstatE, parseNetstatIbn, parseProcNetDev, rateBetween,
  routeIfaceDarwin, routeIfaceLinux, routeLabel, tailscaleExitFromStatus,
} from "./network-metrics.mjs";
import { cliEnv, tailscaleCandidates } from "./tailscale.mjs";

// ── the network ────────────────────────────────────────────────────────────
//
// Three readings, taken at two very different costs (network-metrics.mjs says
// why these three). THROUGHPUT is two counters the kernel already keeps, so it
// rides its own five-second timer for the life of the process like CPU does,
// and its history is as complete as every other section's. LATENCY and ROUTE
// leave the machine or spawn a process, so they are taken only while somebody
// is looking: the panel is the only thing that polls /api/system, and a probe
// runs only within NET_ASKED_MS of that poll. A deck left open in a background
// tab all day makes no connection it was not asked for — the rule Claude FM's
// probe already follows ("makes no request until a page asks for one").

/** Counters on Linux are a file read; on macOS and Windows one short command.
 *  Five seconds is often enough to catch a burst and rare enough that the
 *  command costs nothing anybody could measure. */
const NET_INTERVAL_MS = 5_000;
/** How often the far end is asked, while the panel is open. */
const NET_PROBE_MS = 30_000;
/** How recently a poll must have come for the probe to run at all. */
const NET_ASKED_MS = 20_000;
/** A probe older than this is from before the panel was last closed, and is
 *  not reported as the present. */
const NET_STALE_MS = NET_PROBE_MS * 2 + 5_000;
/** What "how far is Claude" is measured against: the host every request Claude
 *  Code makes goes to, and the one quota.mjs already reads from. */
const API_HOST = "api.anthropic.com";
const API_PORT = 443;
const CONNECT_TIMEOUT_MS = 4_000;
/** Where the route is asked for when there is no API address to ask about. A
 *  routing-table lookup sends no packet, so this contacts nobody. */
const ROUTE_FALLBACK = "1.1.1.1";
/** Route changes kept for the history's markers. A path changes a handful of
 *  times a day; forty is several days of it. */
const ROUTE_LOG = 40;

let netTimer = null;
let netInFlight = false;
let prevNet = null;
let netRate = null;
let physical = null;
let physicalAt = 0;
let probeTimer = null;
/** Whether this process may reach out at all. Off unless the server says so:
 *  the suite starts this module in dozens of cases, and none of them should
 *  open a connection to Anthropic or spawn `ip` and `tailscale` to do it. */
let probeEnabled = false;
let probeInFlight = false;
let probeAt = 0;
let askedAt = 0;
/** Undefined until measured, null when the host could not be reached. */
let apiMs;
let route = null;
const routeLog = [];

/** Interfaces that are hardware, by the one test the kernel offers: a
 *  `device` link under /sys/class/net. Rechecked each minute, because a dock or
 *  a phone tethered over USB is a new wire. */
async function physicalInterfaces(root = "/sys/class/net") {
  try {
    const names = await readdir(root);
    const real = await Promise.all(names.map(n => access(`${root}/${n}/device`).then(() => n, () => null)));
    return new Set(real.filter(Boolean));
  } catch { return null; }
}

async function readNetCounters(platform = process.platform) {
  if (platform === "linux") {
    if (!physical || Date.now() - physicalAt > 60_000) {
      physical = await physicalInterfaces();
      physicalAt = Date.now();
    }
    try {
      const include = physical?.size ? name => physical.has(name) : name => name !== "lo";
      return parseProcNetDev(await readFile("/proc/net/dev", "utf8"), include);
    } catch { return null; }
  }
  if (platform === "darwin") return parseNetstatIbn(await run("netstat", ["-ibn"]));
  if (platform === "win32") return parseNetstatE(await run("netstat", ["-e"]));
  return null;
}

export async function sampleNetwork() {
  if (netInFlight) return;
  netInFlight = true;
  try {
    const counters = await readNetCounters();
    if (!counters) return;
    const next = { rx: counters.rx, tx: counters.tx, at: Date.now() };
    const rate = rateBetween(prevNet, next);
    prevNet = next;
    if (!rate) return;
    netRate = rate;
    record("net:down", rate.down);
    record("net:up", rate.up);
  } finally { netInFlight = false; }
}

/** Milliseconds for a TCP handshake with `address`, or null. The connection
 *  is closed the moment it opens: nothing is sent, so this is a round trip and
 *  nothing else — no TLS, no request, nothing the far end has to answer. */
function connectMs(address, port = API_PORT, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise(resolve => {
    const t0 = performance.now();
    let done = false;
    const socket = net.connect({ host: address, port });
    const finish = ms => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ms);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once("connect", () => finish(Math.round(performance.now() - t0)));
    socket.once("error", () => finish(null));
  });
}

/** `tailscale status --json` as an object, or null for anything that is not
 *  one: nothing on stdout, the macOS GUI's message, a version warning. */
function statusDocument(out) {
  if (typeof out !== "string") return null;
  try {
    const doc = JSON.parse(out);
    return doc && typeof doc === "object" ? doc : null;
  } catch { return null; }
}

/** Which way traffic to `address` leaves, and — for a Tailscale exit node —
 *  through which machine and whether through a relay. */
async function readRoute(address, platform, runner) {
  let iface = null;
  if (platform === "linux") iface = routeIfaceLinux(await runner("ip", ["-o", "route", "get", address]));
  else if (platform === "darwin") iface = routeIfaceDarwin(await runner("route", ["-n", "get", address]));
  const kind = classifyRoute(iface);
  if (!kind || kind.kind === "direct") return kind;
  // Tailscale on a Mac is a utun like every other VPN there, so the question is
  // asked of any tunnel rather than only of one named tailscale0. A machine
  // without the CLI answers null and keeps the generic label.
  //
  // WHERE THE CLI IS AND HOW IT IS RUN are tailscale.mjs's answers, not PATH's
  // (#1772). This asked a bare `tailscale`, and the Mac app keeps its CLI in
  // the bundle and puts nothing on PATH unless its owner pressed "Install CLI"
  // — and a deck started at login has launchd's PATH anyway. The bundle binary
  // is also the GUI, which without cliEnv() prints a message and exits 0. So
  // the candidates are tried in the LAN code's order, as a CLI, and the first
  // one that answers with a status document is the one that is installed.
  for (const file of tailscaleCandidates(platform)) {
    const doc = statusDocument(await runner(file, ["status", "--json"], 3_000, cliEnv()));
    if (!doc) continue;
    const exit = tailscaleExitFromStatus(doc);
    return exit ? { kind: "tailscale-exit", iface, ...exit } : kind;
  }
  return kind;
}

/**
 * One probe: how far the API is and which way the traffic to it goes.
 *
 * Guarded twice, because a GET can start it (see notePanelPoll) and a read's
 * cost must have a ceiling (#544): never two at once, and never more often than
 * half the probe interval however many tabs poll. `deps` is the seam the tests
 * use — nothing else here can be made to answer "unreachable" on demand.
 */
export async function probeNetwork(deps = {}) {
  const now = deps.now ?? Date.now;
  if (!probeEnabled && !deps.force) return;
  if (probeInFlight || now() - probeAt < NET_PROBE_MS / 2) return;
  if (!deps.force && now() - askedAt > NET_ASKED_MS) return;
  probeInFlight = true;
  probeAt = now();
  try {
    const platform = deps.platform ?? process.platform;
    const runner = deps.run ?? run;
    const measureApi = (deps.hasClaude ?? hasClaudeInstalled)();
    let address = null;
    if (measureApi) {
      try { address = (await (deps.lookup ?? lookup)(API_HOST)).address; } catch { address = null; }
      apiMs = address ? await (deps.connect ?? connectMs)(address) : null;
      if (apiMs != null) record("net:api", apiMs);
    }
    const next = await readRoute(address ?? ROUTE_FALLBACK, platform, runner);
    if (next) {
      const label = routeLabel(next);
      const prev = routeLog[routeLog.length - 1]?.label ?? null;
      if (prev !== label) {
        // `from` null is the first route this process saw — the state when it
        // started looking, not a change, and the chart draws no mark for it.
        routeLog.push({ t: now(), label, from: prev });
        while (routeLog.length > ROUTE_LOG) routeLog.shift();
      }
    }
    route = next;
  } finally { probeInFlight = false; }
}

/** What the panel shows for the network, or null before anything is known. */
export function networkSnapshot(nowMs = Date.now()) {
  const fresh = nowMs - probeAt <= NET_STALE_MS;
  const api = fresh && apiMs !== undefined ? { host: API_HOST, ms: apiMs } : null;
  // `to` says what the route was asked about: the API itself when Claude Code
  // is here, the open internet otherwise — a split tunnel can send one and not
  // the other, and the panel should not claim more than was measured.
  const via = fresh && route && route.kind !== "direct"
    ? { ...route, label: routeLabel(route), to: apiMs !== undefined ? "claude" : "internet" }
    : null;
  if (!netRate && !api && !via) return null;
  return { down: netRate?.down ?? null, up: netRate?.up ?? null, api, route: via };
}

/** The route changes the history still covers, as the chart marks them. */
export function routeChangesSince(since) {
  return routeLog.filter(c => c.t >= since).map(c => ({ t: c.t, label: c.label, from: c.from }));
}

/**
 * A poll of /api/system, which is how this section knows somebody is looking.
 *
 * The panel is the only poller, so a poll is the signal somebody is looking.
 * The first one after the panel was closed asks at once rather than waiting
 * out the probe timer, so the latency is on screen by the second poll; the
 * guards inside probeNetwork are what keep a busy poller from paying twice.
 */
export function notePanelPoll() {
  const idle = Date.now() - askedAt > NET_ASKED_MS;
  askedAt = Date.now();
  if (idle && probeEnabled) void probeNetwork();
}

/** The section's two timers: the counters for the life of the process, and the
 *  probe only when `probe` — the server's permission to leave the machine —
 *  says it may. See startSystemMetrics in system-metrics.mjs. */
export function startNetworkTimers(probe) {
  probeEnabled = probe;
  netTimer = setInterval(sampleNetwork, NET_INTERVAL_MS);
  if (probeEnabled) probeTimer = setInterval(() => { probeNetwork(); }, NET_PROBE_MS);
  netTimer.unref?.();
  probeTimer?.unref?.();
}

/** Stop both timers and forget every reading this section holds — its half of
 *  stopSystemMetrics in system-metrics.mjs, and there for the same reason
 *  (#798). */
export function stopNetwork() {
  if (netTimer) clearInterval(netTimer);
  if (probeTimer) clearInterval(probeTimer);
  netTimer = probeTimer = null;
  probeEnabled = false;
  prevNet = null;
  netRate = null;
  physical = null;
  physicalAt = 0;
  probeAt = 0;
  askedAt = 0;
  apiMs = undefined;
  route = null;
  routeLog.length = 0;
}
