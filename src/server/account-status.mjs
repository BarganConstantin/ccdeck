// The status frame: what this deck tells its account about the machine it runs
// on, every fifteen seconds, while it is connected (design 3.4).
//
// THE FRAME IS AN ALLOWLIST BY CONSTRUCTION. buildFrame copies named fields
// out of named readings and nothing else, so a field added to a reading
// upstream cannot ride along by accident; account-status.test.ts holds the
// serialized key set to the contract fixture's. What is in it: the deck's
// version, OS, architecture and channel; CPU busy share and core count; memory
// used share and total; how many sessions are running and how many are waiting
// on their human; which settings revision this machine has applied. What is
// NOT, and never will be without a new schema: load average (the owner's
// decision), thermals, the hostname, paths, accounts, quota, session names.
//
// A METRIC THAT CANNOT BE TOLD IS UNKNOWN, NEVER ZERO. Before the CPU has two
// samples it is `{ unknown: "warming-up" }`; the counts are `starting` until the
// ring has been read and `no-capture` with nothing feeding the deck. The same
// refusal system-metrics.mjs makes for the Machine panel.
//
// THE SCHEDULE: the first frame about three seconds after start (the CPU needs
// two samples), then whatever the last answer's `nextInSec` said — 15 by
// default — with two seconds of jitter either way, so a fleet started together
// does not beat together. A network failure or a 5xx backs off 15, 30, 60, 120,
// then 300 seconds, ±20%; a Retry-After is honoured; a success resets it all.
//
// WHAT AN ANSWER CAN SAY BACK (the control channel):
//   200  next interval, the bound profile's settings revision (a newer one is
//        pulled), and `rotateToken` — rotated, and the new token persisted,
//        BEFORE it is used
//   400  this frame is wrong: dropped, said once, the schedule carries on
//   401  device_revoked / invalid_token / account_gone: final. Stop, and let
//        the service forget the token
//   409  stale_sequence / stale_boot: dropped; twice in a row, a new boot id
//   413  dropped, said once
//   429  wait as asked
//
// A CLEAN STOP SAYS SO. `sendStopping` is the last frame, `state: "stopping"`,
// with a 1.5 second ceiling, so the console can say "ccdeck stopped" at once
// instead of waiting 90 seconds for the frames to go stale.
import { randomUUID } from "node:crypto";
import { PRODUCT } from "./brand.mjs";

export const FIRST_FRAME_MS = 3_000;
export const DEFAULT_EVERY_SEC = 15;
export const JITTER_MS = 2_000;
export const BACKOFF_SEC = Object.freeze([15, 30, 60, 120, 300]);
export const BACKOFF_SPREAD = 0.2;
export const STOPPING_TIMEOUT_MS = 1_500;
/** Errors on which a 401 is final, not a proxy being awkward. */
export const FINAL_401 = new Set(["device_revoked", "invalid_token", "account_gone"]);

const iso = ms => new Date(ms).toISOString();

/** A metric reading as the frame carries it: the named fields, or the reason
 *  it cannot be told. `fields` maps frame keys to reading keys. */
function metric(reading, fields) {
  if (!reading || typeof reading !== "object") return { unknown: "unavailable" };
  if (typeof reading.unknown === "string") return { unknown: reading.unknown };
  const out = {};
  for (const [to, from] of fields) out[to] = reading[from];
  out.sampledAt = iso(reading.sampledAt);
  return out;
}

/**
 * One frame, built from named fields only. `cpu`, `memory` and `agents` are
 * the readings machineReading and the session counts answer; `settings` is the
 * binding the sync reports, or null before there is one.
 */
export function buildFrame({ bootId, seq, observedAt, state, deck, cpu, memory, agents, settings }) {
  const frame = {
    v: 1,
    bootId,
    seq,
    observedAt: iso(observedAt),
    state: state === "stopping" ? "stopping" : "running",
    deck: { version: deck.version, os: deck.os, arch: deck.arch, channel: deck.channel },
    cpu: metric(cpu, [["pct", "pct"], ["cores", "cores"]]),
    memory: metric(memory, [["usedPct", "usedPct"], ["totalMb", "totalMb"]]),
    agents: metric(agents, [["running", "running"], ["waiting", "waiting"]]),
  };
  // The binding as soon as there is one; `appliedRevision` is null until a tab
  // has applied something, which the API takes (status-frame.stopping.json).
  if (settings && typeof settings.profileId === "string") {
    frame.settings = {
      profileId: settings.profileId,
      appliedRevision: Number.isInteger(settings.appliedRevision) ? settings.appliedRevision : null,
    };
  }
  return frame;
}

/**
 * The publisher. Every dependency is passed in so the suite can drive it on a
 * fake clock against the fake API:
 *
 *   client          account-client.mjs
 *   token()         the device token in use now
 *   rotate()        rotate the token: ask, persist, swap — the service's
 *   reading()       machineReading() — { cpu, memory }
 *   counts(now)     the session counts' reading
 *   binding()       { profileId, appliedRevision } or null — the sync's
 *   onControl(s)    a 200's `settings`, and the moment to retry what is pending
 *   onRevoked(err)  a final 401
 *   onChange()      status() would answer something new
 */
export function createStatusPublisher({
  client,
  token,
  rotate = async () => {},
  reading,
  counts,
  binding = () => null,
  deck,
  onControl = () => {},
  onRevoked = () => {},
  onChange = () => {},
  now = Date.now,
  random = Math.random,
  newBootId = randomUUID,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = t => clearTimeout(t),
  log = msg => console.error(`${PRODUCT}: ${msg}`),
}) {
  let bootId = newBootId();
  let seq = 0;
  let everySec = DEFAULT_EVERY_SEC;
  let failures = 0;
  let staleInARow = 0;
  let timer = null;
  let running = false;
  let stopped = false;
  let inFlight = null;
  let lastSentAt = null;
  let lastResult = null;   // "ok" | "offline" | "rejected"
  let nextAt = null;
  const said = new Set();

  const sayOnce = (kind, msg) => { if (!said.has(kind)) { said.add(kind); log(msg); } };

  function schedule(ms) {
    if (!running) return;
    if (timer) clearTimer(timer);
    nextAt = now() + ms;
    timer = setTimer(() => { timer = null; void tick(); }, ms);
    onChange();
  }

  const jittered = () => everySec * 1000 + (random() * 2 - 1) * JITTER_MS;
  const backoff = () => {
    const step = BACKOFF_SEC[Math.min(failures - 1, BACKOFF_SEC.length - 1)] * 1000;
    return step * (1 + (random() * 2 - 1) * BACKOFF_SPREAD);
  };

  function frameNow(state) {
    seq += 1;
    const at = now();
    const r = reading() ?? {};
    return buildFrame({
      bootId, seq, observedAt: at, state, deck,
      cpu: r.cpu, memory: r.memory, agents: counts(at), settings: binding(),
    });
  }

  async function send(frame, timeout) {
    return client.post("/v1/device/status", frame, { token: token(), timeout });
  }

  async function tick() {
    if (!running || stopped) return;
    const res = await (inFlight = send(frameNow("running")));
    inFlight = null;
    if (!running || stopped) return;
    lastSentAt = now();

    if (res.ok) {
      failures = 0;
      staleInARow = 0;
      lastResult = "ok";
      const body = res.body ?? {};
      if (Number.isInteger(body.nextInSec) && body.nextInSec >= 5 && body.nextInSec <= 300) everySec = body.nextInSec;
      if (body.rotateToken === true) {
        try { await rotate(); } catch { /* the old token stays good until the new one is used */ }
      }
      try { await onControl(body.settings ?? null); } catch { /* the sync says its own failures */ }
      return schedule(jittered());
    }
    if (res.status === 401 && FINAL_401.has(res.error)) {
      lastResult = "rejected";
      stop();
      return onRevoked(res.error);
    }
    if (res.status === 429 || (res.status === 503 && res.retryAfterMs)) {
      lastResult = "offline";
      failures = Math.max(failures, 1);
      return schedule(res.retryAfterMs ?? backoff());
    }
    if (res.network || res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 404) {
      // 404 is the API with accounts switched off again, or a tunnel being
      // moved; 401/403 without a final error, a proxy. None is final.
      failures += 1;
      lastResult = "offline";
      return schedule(res.retryAfterMs ?? backoff());
    }
    if (res.status === 409) {
      lastResult = "rejected";
      staleInARow += 1;
      if (staleInARow >= 2) {
        // The API has a newer epoch for this boot than this process — a clock
        // or a sequence that went backwards. A new boot id starts clean.
        bootId = newBootId();
        seq = 0;
        staleInARow = 0;
      }
      return schedule(jittered());
    }
    // 400, 413 and anything else the API wrote about the frame itself.
    lastResult = "rejected";
    sayOnce(`status-${res.status}-${res.error ?? ""}`, `the account refused a status frame (${res.status}${res.error ? ` ${res.error}` : ""})`);
    return schedule(jittered());
  }

  function start(delayMs = FIRST_FRAME_MS) {
    if (running || stopped) return;
    running = true;
    schedule(delayMs);
  }

  function stop() {
    running = false;
    if (timer) clearTimer(timer);
    timer = null;
    nextAt = null;
    onChange();
  }

  /** The last frame, for a clean shutdown. Best effort and bounded: resolves
   *  whatever happens, within STOPPING_TIMEOUT_MS of the request. */
  async function sendStopping() {
    if (stopped) return;
    const wasRunning = running;
    stopped = true;
    stop();
    if (!wasRunning || !token()) return;
    try {
      await send(frameNow("stopping"), STOPPING_TIMEOUT_MS);
    } catch { /* leaving anyway */ }
  }

  return {
    start,
    stop,
    sendStopping,
    /** For the suite: send the next frame now. */
    tickNow: () => tick(),
    status: () => (lastSentAt == null && nextAt == null ? null : {
      lastSentAt: lastSentAt == null ? null : iso(lastSentAt),
      lastResult,
      nextAt: nextAt == null ? null : iso(nextAt),
      everySec,
    }),
    /** For the suite. */
    bootId: () => bootId,
    seq: () => seq,
  };
}
