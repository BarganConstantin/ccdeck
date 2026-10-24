// How full each quota window was when it reset: the first half of "is my plan
// the right size?". A window is held open while readings of it arrive and
// closed, with the last of them, once its reset passes — or earlier, when a
// reading shows a new window already running (a saved reset spent, a counter
// flushed). Fed only by readings the deck already has: the signed-in account's
// published quota and claude-swap's store for every account (quota-close-watch.mjs).
import { readFile, stat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deckDataDir } from "./deck-home.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";

export const CLOSE_LIMITS = Object.freeze({ open: 128, closed: 4000, days: 400, bytes: 2 * 1024 * 1024 });
const finite = n => typeof n === "number" && Number.isFinite(n);
const providers = new Set(["claude", "codex"]);
const accountKey = /^[a-f0-9]{64}$/;

/** Two readings of one window may disagree on its reset: `claude /usage` prints
 *  it to the hour, the usage endpoint to the second. The next window cannot
 *  reset sooner than a whole window later, so a quarter of one (at most six
 *  hours) still tells the same window from the next. */
export const sameReset = (windowSec, a, b) => Math.abs(a - b) <= Math.min(windowSec / 4, 6 * 3600);

const validWindow = w => typeof w?.id === "string" && w.id.length <= 100 && finite(w.pct) && w.pct >= 0
  && finite(w.resetAt) && finite(w.windowSec) && w.windowSec >= 60 && w.windowSec <= 40 * 86400;

function entryOf(raw, now) {
  if (!providers.has(raw?.provider) || !accountKey.test(raw.account ?? "") || !validWindow(raw)
      || typeof raw.label !== "string" || !finite(raw.peak) || !finite(raw.t) || !finite(raw.first)
      || !Number.isInteger(raw.n) || raw.n < 1 || raw.t > now + 60_000 || raw.first > raw.t) return null;
  return {
    provider: raw.provider, account: raw.account, id: raw.id, label: raw.label.slice(0, 100),
    windowSec: raw.windowSec, resetAt: raw.resetAt, pct: Math.min(100, raw.pct), peak: Math.min(100, Math.max(raw.peak, raw.pct)),
    t: raw.t, first: raw.first, n: raw.n,
    ...(typeof raw.plan === "string" && raw.plan && raw.plan.length <= 40 && { plan: raw.plan }),
    ...(raw.asked === true && { asked: true }),
    ...(raw.ended === "reset" || raw.ended === "early" ? { ended: raw.ended } : {}),
  };
}

function prune(state, now) {
  const floor = now / 1000 - CLOSE_LIMITS.days * 86400;
  state.closed = state.closed.filter(c => c.resetAt >= floor)
    .sort((a, b) => b.resetAt - a.resetAt).slice(0, CLOSE_LIMITS.closed);
  state.open = state.open.sort((a, b) => b.t - a.t).slice(0, CLOSE_LIMITS.open);
}

export function normalizeCloses(raw, now) {
  const state = { open: [], closed: [] };
  if (raw?.v !== 1) return state;
  for (const e of Array.isArray(raw.open) ? raw.open.slice(0, CLOSE_LIMITS.open) : []) {
    const entry = entryOf(e, now);
    if (entry) { delete entry.ended; state.open.push(entry); }
  }
  for (const e of Array.isArray(raw.closed) ? raw.closed.slice(0, CLOSE_LIMITS.closed) : []) {
    const entry = entryOf(e, now);
    if (entry?.ended) state.closed.push(entry);
  }
  prune(state, now);
  return state;
}

export function createQuotaCloses({ load = async () => null, save = async () => {}, now = Date.now } = {}) {
  let state = { open: [], closed: [] }, loading = null, storageOk = true, dirty = false;
  let queue = Promise.resolve();
  const ready = () => loading ??= (async () => {
    try { state = normalizeCloses(await load(), now()); }
    catch { storageOk = false; }
  })();
  const close = (entry, ended) => {
    state.open = state.open.filter(e => e !== entry);
    delete entry.asked;
    state.closed.push({ ...entry, ended });
    dirty = true;
  };
  const sweep = () => {
    const at = now();
    for (const entry of [...state.open]) if (entry.resetAt * 1000 <= at) close(entry, "reset");
  };
  const flush = async () => {
    prune(state, now());
    if (!dirty) return;
    dirty = false;
    try { await save({ v: 1, open: state.open, closed: state.closed }); storageOk = true; }
    catch { storageOk = false; } // the record cannot fail a quota read
  };
  const run = fn => (queue = queue.then(async () => { await ready(); await fn(); await flush(); }).catch(() => { storageOk = false; }));
  return {
    /** Readings of an account's windows, taken at `fetchedAt` (ms). */
    observe(provider, account, windows, fetchedAt, { plan } = {}) {
      return run(() => {
        if (!providers.has(provider) || !accountKey.test(account ?? "") || !finite(fetchedAt) || fetchedAt > now() + 60_000) return;
        sweep();
        for (const w of Array.isArray(windows) ? windows : []) {
          if (!validWindow(w) || fetchedAt >= w.resetAt * 1000 || fetchedAt < (w.resetAt - w.windowSec) * 1000 - 120_000) continue;
          const pct = Math.min(100, w.pct);
          const same = e => e.provider === provider && e.account === account && e.id === w.id && e.windowSec === w.windowSec;
          // A reading that arrives after its window closed — claude-swap's store
          // is read on a timer — still improves the close if it is the later one.
          const done = state.closed.find(e => same(e) && sameReset(w.windowSec, e.resetAt, w.resetAt));
          if (done) {
            if (fetchedAt > done.t) { done.pct = pct; done.t = fetchedAt; done.n++; done.peak = Math.max(done.peak, pct); dirty = true; }
            continue;
          }
          const lane = state.open.filter(same);
          const entry = lane.find(e => sameReset(w.windowSec, e.resetAt, w.resetAt));
          if (!entry && lane.some(e => e.resetAt > w.resetAt)) continue; // a late reading of a window already left
          // A newer window running before the old one's reset ended it early.
          for (const old of lane) if (old !== entry && old.resetAt < w.resetAt && old.t < fetchedAt) close(old, fetchedAt < old.resetAt * 1000 ? "early" : "reset");
          if (!entry) {
            state.open.push({ provider, account, id: w.id, label: String(w.label ?? w.id).slice(0, 100), windowSec: w.windowSec,
              resetAt: w.resetAt, pct, peak: pct, t: fetchedAt, first: fetchedAt, n: 1, ...(plan && { plan }) });
            dirty = true;
            continue;
          }
          // Readings reach here from two sources, not always in order: an older
          // one still counts toward the peak and the first sight, never the last.
          entry.peak = Math.max(entry.peak, pct);
          entry.first = Math.min(entry.first, fetchedAt);
          if (fetchedAt > entry.t) { entry.pct = pct; entry.t = fetchedAt; entry.n++; entry.resetAt = w.resetAt; }
          if (plan) entry.plan = plan;
          dirty = true;
        }
        sweep();
      });
    },
    /** The plan an account is on now, written onto its open windows. */
    plan(provider, account, plan) {
      return run(() => {
        if (typeof plan !== "string" || !plan || plan.length > 40) return;
        for (const e of state.open) if (e.provider === provider && e.account === account && e.plan !== plan) { e.plan = plan; dirty = true; }
      });
    },
    /** Closes every window whose reset has passed. */
    sweep() { return run(sweep); },
    /** The open weekly windows that reset within `withinMs` and were last read
     *  more than `staleMs` ago — each handed out once, for one fresh reading
     *  before its reset. */
    async closingReads({ withinMs = 45 * 60_000, staleMs = 60 * 60_000 } = {}) {
      const due = [];
      await run(() => {
        const at = now();
        for (const e of state.open) {
          if (e.windowSec < 86400 || e.asked || e.resetAt * 1000 <= at || e.resetAt * 1000 - at > withinMs || at - e.t < staleMs) continue;
          e.asked = true; dirty = true;
          due.push({ provider: e.provider, account: e.account, id: e.id, resetAt: e.resetAt });
        }
      });
      return due;
    },
    async report(provider, account) {
      await run(sweep);
      const strip = ({ provider: _p, account: _a, asked: _asked, ...e }) => e;
      return { ok: true, storageOk, account,
        closed: state.closed.filter(e => e.provider === provider && e.account === account).map(strip),
        open: state.open.filter(e => e.provider === provider && e.account === account).map(strip) };
    },
  };
}

let closes = null;
export function startQuotaCloses() {
  if (closes) return closes;
  const file = join(deckDataDir(), "quota-closes.json");
  closes = createQuotaCloses({
    load: async () => {
      try {
        if ((await stat(file)).size > CLOSE_LIMITS.bytes) throw new Error("Closes exceed capacity");
        return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
      } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
    },
    save: async raw => { await mkdir(dirname(file), { recursive: true }); await writeFileAtomic(file, JSON.stringify(raw)); },
  });
  return closes;
}
export const quotaCloses = () => closes;
export function noteQuotaCloses(provider, account, windows, fetchedAt, extra) {
  if (closes && account) void closes.observe(provider, account, windows, fetchedAt, extra);
}
export async function quotaClosesReport(provider, account) {
  return closes ? closes.report(provider, account) : { ok: true, storageOk: true, account, closed: [], open: [] };
}
