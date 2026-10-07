// Three notifications about the accounts the deck is on, and the rules for when
// each is said.
//
//   SWAP       the deck's own auto-switch tick moved the live Claude account.
//              Said once per switch, with the reason the tick itself carries,
//              and never for a switch somebody pressed: those do not come
//              through a tick at all.
//   THRESHOLD  a quota window of the account a provider is LIVE on reached 90%,
//              and once more at 100%.
//   RESET      a window of the live account that had reached 90% is new again.
//
// SPARSE BY CONSTRUCTION. Each window is a record keyed by provider, account
// and window, holding the reset instant it is about and the levels already said
// for it. A poll that finds the same state finds the levels said and says
// nothing; a new reset instant is a new window, and only then can the levels be
// said again. The records are written to disk (account-watch.mjs), so a restart
// reads them back rather than meeting every window as news, and an account's
// records are found only under its own key, so nothing one account said can
// silence or repeat anything about another.
//
// ONE CROSSING, ONE NOTIFICATION. The crossing that makes the auto-switch move
// the account is the swap's to tell — "Switched to … · … reached 90%" — so a
// threshold notice for the live Claude account is HELD while the loop is on and
// the swap switch is on, until the next tick says what it did: a switch away
// from that account drops it, anything else lets it go. A crossing the deck
// never saw because the tick saw it first is written down from the tick, so the
// account does not announce it later when it is live again.
//
// Pure apart from the factory at the bottom, whose clock, disk and OS call are
// injected — the shape block-notify.mjs uses, for the reason it gives: what the
// suite cannot run is what drifts.

/** The levels a window is announced at, lowest first. */
export const LEVELS = Object.freeze([90, 100]);

/** At or above this a window counts as high, which is what makes its reset
 *  worth saying. */
export const HIGH = LEVELS[0];

/**
 * How far two readings of one window may disagree about its reset instant and
 * still be the same window.
 *
 * The three Claude sources print it differently — the store and the API to the
 * second, `claude --print /usage` to the minute — and a source can change
 * between two polls. A real reset moves the instant by most of a window (five
 * hours or seven days), so ten minutes cannot confuse the two.
 */
export const EPOCH_SLACK_SEC = 10 * 60;

/**
 * For a window with no reset instant — Claude's per-model weekly windows carry
 * none — how far its reading has to fall below the highest one seen before it
 * is taken to have reset. Usage inside one window only climbs, so a fall this
 * large is a new window and not a wobble.
 */
export const RESET_DROP = 25;

/** How long after a window ended its reset is still news. A deck that was not
 *  running when a window reset two days ago has nothing timely to say about
 *  it. */
export const RESET_NEWS_MS = 6 * 60 * 60 * 1000;

/**
 * The longest a threshold notice waits for a tick to say whether it switched.
 *
 * claude-swap ticks once a minute and holds off for five after a switch by
 * default, so this covers a cooldown and the tick after it; a slower interval
 * than that lets the notice go rather than holding it forever.
 */
export const HOLD_MS = 6 * 60 * 1000;

/** A record nobody has read for this long is dropped, so the file stays the
 *  size of the windows that are still in play. */
export const RECORD_KEEP_MS = 35 * 24 * 60 * 60 * 1000;

/** Longest account name in a notification. */
export const NAME_MAX = 48;

const WIN_5H_SEC = 5 * 3600;
const WIN_7D_SEC = 7 * 24 * 3600;

const PROVIDER_NAMES = Object.freeze({ claude: "Claude", codex: "Codex" });

/** `text` in at most `max` characters, with an ellipsis when something was
 *  cut. */
function cut(text, max) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text;
}

/** A Claude account's key: claude-swap's two halves, the address without case.
 *  Null for half an identity, which cannot be told apart from another. */
export function claudeAccountKey(email, org) {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  const o = typeof org === "string" ? org.trim() : "";
  return e && o ? `${e}@@${o}` : null;
}

/** A Codex account's key: the ChatGPT account id and the address, so one
 *  address in two workspaces is two accounts. Null when neither is known. */
export function codexAccountKey(accountId, email) {
  const id = typeof accountId === "string" ? accountId.trim() : "";
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  return id || e ? `${id}|${e}` : null;
}

/**
 * The windows a Claude reading reports, as records can be kept for them.
 *
 * A stale reading is left out: it is numbers already held, re-served while a
 * fresh read is not possible, and has nothing new to say. The 5-hour entry is
 * left out when it is a copy of the 7-day one, which is what the mapping
 * publishes for an account that reports no 5-hour window.
 */
export function claudeWindows(r) {
  if (!r || r.ok !== true || r.stale) return [];
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const out = [];
  const h5 = num(r.session5hPct), d7 = num(r.week7dPct);
  const copied = h5 != null && h5 === d7 && num(r.session5hResetAt) != null && r.session5hResetAt === r.week7dResetAt;
  if (h5 != null && !copied) {
    out.push({ id: "five_hour", name: "5-hour", pct: h5, epoch: num(r.session5hResetAt), windowSec: num(r.session5hWindowSec) ?? WIN_5H_SEC });
  }
  if (d7 != null) {
    out.push({ id: "seven_day", name: "7-day", pct: d7, epoch: num(r.week7dResetAt), windowSec: num(r.week7dWindowSec) ?? WIN_7D_SEC });
  }
  if (num(r.weekSonnetPct) != null) out.push({ id: "seven_day_sonnet", name: "Sonnet 7-day", pct: r.weekSonnetPct, epoch: null, windowSec: WIN_7D_SEC });
  if (num(r.weekOpusPct) != null) out.push({ id: "seven_day_opus", name: "Opus 7-day", pct: r.weekOpusPct, epoch: null, windowSec: WIN_7D_SEC });
  return out;
}

/** "5-hour window" → "5-hour"; "Codex Spark · 7-day window" → "Codex Spark · 7-day". */
function codexName(label) {
  const text = typeof label === "string" && label.trim() ? label.trim() : "Rate limit";
  return text.replace(/\s+window$/i, "");
}

/** The windows a Codex reading reports — the main lanes and the extra limit
 *  families — as records can be kept for them. */
export function codexWindows(r) {
  if (!r || r.ok !== true || r.stale) return [];
  const lanes = [...(Array.isArray(r.windows) ? r.windows : []), ...(Array.isArray(r.extraWindows) ? r.extraWindows : [])];
  return lanes
    .filter(w => w && typeof w.id === "string" && typeof w.pct === "number" && Number.isFinite(w.pct))
    .map(w => ({
      id: w.id,
      name: codexName(w.label),
      pct: w.pct,
      epoch: typeof w.resetAt === "number" && Number.isFinite(w.resetAt) ? w.resetAt : null,
      windowSec: typeof w.windowSec === "number" && w.windowSec > 0 ? w.windowSec : null,
    }));
}

/**
 * Which Claude window a label in the tick's `windowsPct` names: "5h", "7d", then
 * the scoped models by name. Null for one this deck keeps no record of.
 */
export function claudeWindowOfLabel(label) {
  if (label === "5h") return { id: "five_hour", name: "5-hour", windowSec: WIN_5H_SEC };
  if (label === "7d") return { id: "seven_day", name: "7-day", windowSec: WIN_7D_SEC };
  if (/sonnet/i.test(label)) return { id: "seven_day_sonnet", name: "Sonnet 7-day", windowSec: WIN_7D_SEC };
  if (/opus/i.test(label)) return { id: "seven_day_opus", name: "Opus 7-day", windowSec: WIN_7D_SEC };
  return null;
}

/**
 * How a reading of a window stands to the record held for it.
 *
 *   "new"    no record: the first time this window of this account is seen.
 *   "same"   the window the record is about.
 *   "newer"  a window that started after it — the old one reset.
 *   "older"  a reading of a window the record has already moved past.
 */
export function relate(prev, w) {
  if (!prev) return "new";
  if (prev.epoch != null && w.epoch != null) {
    if (w.epoch > prev.epoch + EPOCH_SLACK_SEC) return "newer";
    if (w.epoch < prev.epoch - EPOCH_SLACK_SEC) return "older";
    return "same";
  }
  // A record the tick wrote knew when it was written and nothing else: the
  // window open at that moment is the one it is about.
  if (prev.epoch == null && prev.carriedAt != null && w.epoch != null && w.windowSec) {
    return w.epoch - w.windowSec > prev.carriedAt / 1000 + EPOCH_SLACK_SEC ? "newer" : "same";
  }
  return w.pct <= prev.peak - RESET_DROP ? "newer" : "same";
}

/** Whether the end of the window a record describes is recent enough to be
 *  news: its reset instant when it has one, else the last time it was read. */
function resetIsNews(prev, now) {
  const endedAt = prev.epoch != null ? prev.epoch * 1000 : prev.seenAt;
  return typeof endedAt === "number" && now - endedAt <= RESET_NEWS_MS;
}

/**
 * One reading of one window against its record.
 *
 * Returns the record after it, the levels newly reached in it (said by nobody
 * yet), whether the window reset into this one while it was high, and whether
 * anything worth keeping on disk changed. A reading of a window whose reset
 * instant has already passed is about a window that is over, and changes
 * nothing.
 */
export function stepWindow(prev, w, now) {
  const quiet = { next: prev, reached: [], reset: false, changed: false };
  if (w.epoch != null && w.epoch * 1000 <= now) return quiet;
  const rel = relate(prev, w);
  if (rel === "older") return quiet;
  let next;
  let reset = false;
  if (rel === "same") {
    next = {
      ...prev,
      epoch: prev.epoch ?? w.epoch ?? null,
      windowSec: prev.windowSec ?? w.windowSec ?? null,
      peak: Math.max(prev.peak, w.pct),
      seenAt: now,
    };
  } else {
    reset = rel === "newer" && prev.peak >= HIGH && resetIsNews(prev, now);
    next = { epoch: w.epoch ?? null, windowSec: w.windowSec ?? null, peak: w.pct, said: [], seenAt: now };
  }
  const reached = LEVELS.filter(level => w.pct >= level && !next.said.includes(level));
  const changed = rel !== "same" || next.epoch !== prev.epoch || (prev.peak < HIGH && next.peak >= HIGH);
  return { next, reached, reset, changed };
}

/** "2h 14m", "45m", "3d 4h", "under a minute": how far `sec` is from `now`. */
export function inDuration(sec, now) {
  const mins = Math.floor((sec * 1000 - now) / 60_000);
  if (mins < 1) return "under a minute";
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** A percentage the way the panel prints a threshold: whole when it is whole. */
function pctLabel(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** Whose notification it is, in the provider's name and the account's. */
function whoFor(provider, accountName) {
  const p = PROVIDER_NAMES[provider] ?? provider;
  return accountName ? `${p} · ${cut(accountName, NAME_MAX)}` : p;
}

/** "Claude · work@x.com", "5-hour usage reached 90% · resets in 2h 14m". */
export function thresholdNotice({ provider, accountName, window, level, now }) {
  const resets = window.epoch != null && window.epoch * 1000 > now ? ` · resets in ${inDuration(window.epoch, now)}` : "";
  return { who: whoFor(provider, accountName), body: `${window.name} usage reached ${level}%${resets}` };
}

/** "Claude · work@x.com", "5-hour window available again". */
export function resetNotice({ provider, accountName, window }) {
  return { who: whoFor(provider, accountName), body: `${window.name} window available again` };
}

/** The title the OS helper shows, which has no app name above it. */
export const SWAP_WHO = "Claude auto-switch";

/**
 * What the switch away from `from` was about, from the tick's own poll: the
 * share of its quota it had used, or null when the poll does not say.
 *
 * claude-swap reports headroom per account number; an older shape gave one
 * number for the active account alone, and that is `from` only when the poll
 * says so.
 */
export function usedBefore(result, fromNumber) {
  const h = result?.headroom;
  let room = null;
  if (typeof h === "number") {
    if (String(result?.active?.number) === String(fromNumber)) room = h;
  } else if (h && typeof h === "object") {
    room = h[String(fromNumber)];
  }
  return typeof room === "number" && Number.isFinite(room) ? 100 - room : null;
}

/**
 * "Switched to work@x.com · personal@x.com reached 90%".
 *
 * The reason is stated only when the tick carries it: the account it left had
 * used at least the threshold the policy ran with. A switch for any other
 * reason — the account's usage could not be read, or a strategy that moves
 * below the threshold — says where it went and from where, and nothing about
 * why.
 */
export function swapNotice({ toName, fromName, used, threshold }) {
  const to = toName ? cut(toName, NAME_MAX) : "another account";
  if (!fromName) return { who: SWAP_WHO, body: `Switched to ${to}` };
  const from = cut(fromName, NAME_MAX);
  if (used != null && used >= 100) return { who: SWAP_WHO, body: `Switched to ${to} · ${from} reached 100%` };
  if (used != null && typeof threshold === "number" && used >= threshold) {
    return { who: SWAP_WHO, body: `Switched to ${to} · ${from} reached ${pctLabel(threshold)}%` };
  }
  return { who: SWAP_WHO, body: `Switched to ${to} from ${from}` };
}

/** The records, as read back from disk: anything that is not one is dropped,
 *  and so is one nobody has read for RECORD_KEEP_MS. */
export function normaliseRecords(raw, now) {
  const src = raw && typeof raw === "object" && raw.windows && typeof raw.windows === "object" ? raw.windows : {};
  const out = {};
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
  for (const [key, r] of Object.entries(src)) {
    if (!r || typeof r !== "object" || typeof key !== "string") continue;
    const seenAt = num(r.seenAt);
    if (seenAt == null || now - seenAt > RECORD_KEEP_MS) continue;
    const peak = num(r.peak);
    if (peak == null) continue;
    const said = Array.isArray(r.said) ? LEVELS.filter(l => r.said.includes(l)) : [];
    const rec = { epoch: num(r.epoch), windowSec: num(r.windowSec), peak, said, seenAt };
    if (num(r.carriedAt) != null) rec.carriedAt = r.carriedAt;
    out[key] = rec;
  }
  return { windows: out };
}

/** A timer that never holds the process open. */
function laterUnref(fn, ms) {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

/**
 * The stateful half: the records, the held notices, and the call out.
 *
 *   notify(title, body, meta)  the OS call — injected, never awaited by a poll
 *                              or a tick, and its failure goes to `onError`
 *   settings()                 `{ swap, quota, reset }`, asked per decision, so
 *                              a switch pressed mid-run takes effect at once
 *   load() / save(records)     the disk, both best effort
 *   now, later                 the clock and the hold timer, for the suite
 *
 * Every entry point catches its own failures: a notification that cannot be
 * said must never cost the poll that found it or the tick that switched.
 */
export function createAccountNotifier({
  notify, settings, product = "ccdeck", now = Date.now, load = async () => null, save = async () => {},
  onError, later = laterUnref, holdMs = HOLD_MS,
}) {
  let records = { windows: {} };
  const ready = Promise.resolve()
    .then(load)
    .then(raw => { records = normaliseRecords(raw, now()); })
    .catch(err => onError?.(err));
  /** Whether the deck's auto-switch loop is on, and the threshold its last tick
   *  ran with — together, whether a tick may yet carry a crossing. */
  let autoOn = false;
  let policy = null;
  /** Threshold notices held for a tick, by record key. */
  const held = new Map();
  let holdTimer = null;
  let saving = Promise.resolve();

  const persist = () => {
    const snapshot = JSON.parse(JSON.stringify(records));
    saving = saving.then(() => save(snapshot)).catch(err => onError?.(err));
    return saving;
  };

  const say = ({ who, body }) => {
    try {
      Promise.resolve(notify(`${who} — ${product}`, body, { who, chime: null, silent: true })).catch(err => onError?.(err));
    } catch (err) {
      onError?.(err);
    }
  };

  const keyOf = (provider, accountKey, windowId) => `${provider}|${accountKey}|${windowId}`;

  /** Write `levels` down as said for the window a held notice was about, if the
   *  record is still about that window. */
  const markSaid = (entry, levels) => {
    const rec = records.windows[entry.key];
    if (!rec || relate(rec, entry.window) !== "same") return;
    rec.said = LEVELS.filter(l => rec.said.includes(l) || levels.includes(l));
  };

  const sayThreshold = entry => {
    markSaid(entry, entry.levels);
    if (settings().quota) {
      say(thresholdNotice({
        provider: entry.provider, accountName: entry.accountName, window: entry.window,
        level: Math.max(...entry.levels), now: now(),
      }));
    }
  };

  const release = entries => {
    if (entries.length === 0) return;
    for (const entry of entries) { held.delete(entry.key); sayThreshold(entry); }
    persist();
  };

  const armHold = () => {
    if (holdTimer || held.size === 0) return;
    const due = Math.min(...[...held.values()].map(e => e.at + holdMs));
    holdTimer = later(() => {
      holdTimer = null;
      const at = now();
      release([...held.values()].filter(e => e.at + holdMs <= at));
      armHold();
    }, Math.max(0, due - now()));
  };

  /** Should a threshold notice for this window wait for the next tick? */
  const holdFor = (provider, level) =>
    provider === "claude" && autoOn && settings().swap && (policy == null || level >= policy);

  async function observe(provider, account, windows) {
    try {
      await ready;
      if (!account?.key || !Array.isArray(windows)) return;
      const at = now();
      let changed = false;
      for (const w of windows) {
        const key = keyOf(provider, account.key, w.id);
        const step = stepWindow(records.windows[key], w, at);
        if (step.next === records.windows[key] && !step.changed && step.reached.length === 0 && !step.reset) continue;
        records.windows[key] = step.next;
        changed ||= step.changed;
        if (step.reset) {
          held.delete(key);
          if (settings().reset) say(resetNotice({ provider, accountName: account.name, window: w }));
        }
        if (step.reached.length === 0) continue;
        const entry = { key, provider, accountKey: account.key, accountName: account.name, window: w, levels: step.reached, at };
        const top = Math.max(...step.reached);
        if (settings().quota && holdFor(provider, top)) {
          const before = held.get(key);
          held.set(key, before ? { ...entry, levels: LEVELS.filter(l => before.levels.includes(l) || step.reached.includes(l)), at: before.at } : entry);
          continue;
        }
        held.delete(key);
        sayThreshold(entry);
        changed = true;
      }
      armHold();
      if (changed) await persist();
    } catch (err) {
      onError?.(err);
    }
  }

  /**
   * One finished tick of the deck's auto-switch loop.
   *
   * `accounts` is claude-swap's roster as sequence.json has it — number to
   * `{ email, organizationUuid, alias }` — read after the tick, for the names
   * and the keys of the two accounts a switch moved between.
   */
  async function tick(result, accounts) {
    try {
      await ready;
      if (!result || typeof result !== "object") return;
      if (typeof result.threshold === "number" && Number.isFinite(result.threshold)) policy = result.threshold;
      if (!result.switched) {
        // A cooldown is the one answer that says a switch is still coming.
        if (result.event === "no-switch" && result.reason === "cooldown") return;
        release([...held.values()]);
        return;
      }
      const at = now();
      const s = settings();
      const from = accountOfRef(result.from, accounts);
      const to = accountOfRef(result.to, accounts);
      // What the swap carries. Held notices for the account it left, and every
      // level the tick's poll saw that account at, are its crossing: said by
      // the swap when that switch is on, and said as what they are when not.
      // Only the live account's notices are ever held, and the live account
      // is the one a switch leaves — so when the store could not name it, every
      // held Claude notice is still that account's.
      const carried = [...held.values()].filter(e => e.provider === "claude" && (!from?.key || e.accountKey === from.key));
      for (const entry of carried) {
        held.delete(entry.key);
        if (s.swap) markSaid(entry, entry.levels); else sayThreshold(entry);
      }
      if (from?.key) carryFromPoll(result, from, at, !s.swap);
      release([...held.values()]);
      if (s.swap) {
        say(swapNotice({
          toName: to?.name ?? null, fromName: from?.name ?? null,
          used: usedBefore(result, result.from?.number), threshold: result.threshold,
        }));
      }
      await persist();
    } catch (err) {
      onError?.(err);
    }
  }

  /** The levels the tick's poll saw the account it left at, written into that
   *  account's records — and said as threshold notices when no swap will. */
  function carryFromPoll(result, from, at, sayThem) {
    const pcts = result.windows && typeof result.windows === "object" ? result.windows[String(from.number)] : null;
    if (!pcts || typeof pcts !== "object") return;
    for (const [label, pct] of Object.entries(pcts)) {
      const win = claudeWindowOfLabel(label);
      if (!win || typeof pct !== "number" || !Number.isFinite(pct)) continue;
      const levels = LEVELS.filter(l => pct >= l);
      if (levels.length === 0) continue;
      const key = keyOf("claude", from.key, win.id);
      let rec = records.windows[key];
      if (!rec || (rec.epoch != null && rec.epoch * 1000 <= at)) {
        rec = { epoch: null, windowSec: win.windowSec, peak: pct, said: [], seenAt: at, carriedAt: at };
        records.windows[key] = rec;
      }
      const fresh = levels.filter(l => !rec.said.includes(l));
      rec.peak = Math.max(rec.peak, pct);
      rec.said = LEVELS.filter(l => rec.said.includes(l) || levels.includes(l));
      if (sayThem && fresh.length > 0 && settings().quota) {
        say(thresholdNotice({
          provider: "claude", accountName: from.name, window: { ...win, epoch: rec.epoch }, level: Math.max(...fresh), now: at,
        }));
      }
    }
  }

  return {
    ready,
    observe,
    tick,
    /** The loop was switched on or off. Off, nothing will carry what is held. */
    autoSwitch(on) {
      autoOn = on === true;
      if (!autoOn) release([...held.values()]);
    },
    /** For the suite: the records as they stand, and what is held. */
    records: () => records,
    held: () => [...held.values()],
    settled: () => saving,
  };
}

/**
 * One side of a switch, as the deck names it: claude-swap's alias for that
 * slot, else the address the tick gave, else the slot's own — and the key its
 * records are under, when the store and the tick agree on who that slot is.
 */
export function accountOfRef(ref, accounts) {
  if (!ref || typeof ref !== "object") return null;
  const number = ref.number;
  const entry = accounts && typeof accounts === "object" ? accounts[String(number)] : null;
  const tickEmail = typeof ref.email === "string" ? ref.email.trim() : "";
  const storeEmail = typeof entry?.email === "string" ? entry.email.trim() : "";
  const agrees = entry && (!tickEmail || tickEmail.toLowerCase() === storeEmail.toLowerCase());
  const key = agrees ? claudeAccountKey(storeEmail, entry.organizationUuid) : null;
  const alias = agrees && typeof entry.alias === "string" && entry.alias.trim() ? entry.alias.trim() : "";
  const name = alias || tickEmail || storeEmail || (number != null ? `account ${number}` : "");
  return { number, key, name: name || null };
}
