// The deck's own step in an auto-switch tick, taken before claude-swap's
// engine: the home account and "soonest weekly reset" rules
// (account-choice.mjs), carried out, and what they need remembered between
// ticks.
//
// NOTHING SET, NOTHING DONE. With the next account left on "most room" and no
// home, a tick never reads anything here beyond this file and goes straight to
// the engine — the behaviour every deck had before these rules existed.
//
// WHAT IS REMEMBERED, per machine, in auto-choice.json beside prefs.json:
//
//   next        "room" | "weekly"
//   home        { key, email, orgUuid } or null — an identity, never a slot:
//               slots are reused and differ between machines (lan-copies.mjs)
//   manual      the account in use was picked by hand: the panel's Switch, the
//               terminal, anything that was not a tick. The moves nobody needs
//               leave it alone until it fills.
//   goHome      a home was just set, so the next tick may take the user there
//   lastActive  the account the last tick left the user on, which is how a
//               switch made by hand is told from one a tick made
//   lastMoveAt  when a tick last moved the account, for the cooldowns
//
// The ticks run one at a time under the store mutex; the panel's two writes
// do not, so every write here goes through one chain.
import { readFile, readdir, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deckDataDir } from "./deck-home.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { backupRoot, fetchClaudeAccounts, slotNumber, switchClaudeAccount } from "./claude-accounts.mjs";
import { readCswapConfig } from "./cswap-auto-readers.mjs";
import { accountKey } from "./lan-copies.mjs";
import { isProcessAlive } from "./deck-probe.mjs";
import { chooseAccount, countedModels, NEXT_CHOICES } from "./account-choice.mjs";

/** Where the choice is kept: beside prefs.json, in the deck's own data. */
export function choicePath(home = deckDataDir()) {
  return join(home, "auto-choice.json");
}

const text = v => (typeof v === "string" && v ? v : null);

/** Whatever is on disk, as a whole and known-shaped choice. */
export function normaliseChoice(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const home = src.home && typeof src.home === "object" && text(src.home.email)
    ? { key: accountKey(src.home.email, src.home.orgUuid), email: src.home.email, orgUuid: text(src.home.orgUuid) }
    : null;
  return {
    next: NEXT_CHOICES.includes(src.next) ? src.next : "room",
    home,
    manual: src.manual === true,
    goHome: home != null && src.goHome === true,
    lastActive: text(src.lastActive),
    lastMoveAt: Number.isFinite(src.lastMoveAt) ? src.lastMoveAt : 0,
  };
}

// The choice as last read or written. This process is the file's only writer,
// so after the first read a tick asks memory, not the disk — which is what
// keeps a deck with nothing set paying nothing per tick.
let _held = null;

async function readChoice() {
  if (_held) return _held;
  try { _held = normaliseChoice(JSON.parse(await readFile(choicePath(), "utf8"))); } catch { _held = normaliseChoice(null); }
  return _held;
}

let _writes = Promise.resolve();
/** Read, change and write the choice, one change at a time. A change that
 *  changes nothing writes nothing: most ticks only confirm where they are. */
function updateChoice(change) {
  const done = _writes.then(async () => {
    const before = await readChoice();
    const next = normaliseChoice(change(before));
    if (JSON.stringify(next) === JSON.stringify(before)) return before;
    const path = choicePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(next)}\n`);
    _held = next;
    return next;
  });
  _writes = done.catch(() => {});
  return done;
}

/** What the panel draws: the strategy, and whose row carries the home mark. */
export async function choiceStatus() {
  const c = await readChoice();
  return { next: c.next, home: c.home ? { email: c.home.email, orgUuid: c.home.orgUuid } : null };
}

/** "room" or "weekly". Choosing is a decision about the account in use too,
 *  so a pick made by hand no longer holds the new rule back. */
export async function setNextChoice(value) {
  if (!NEXT_CHOICES.includes(value)) return { ok: false, reason: "bad_value" };
  await updateChoice(c => ({ ...c, next: value, manual: false, lastActive: null }));
  return { ok: true };
}

/**
 * Make the account in slot `accountNum` the home, or clear it with null.
 * Setting one is asking to be taken there: the next tick does, once the
 * account is usable, even from an account picked by hand.
 */
export async function setHomeAccount(accountNum) {
  if (accountNum === null) {
    await updateChoice(c => ({ ...c, home: null, goHome: false }));
    return { ok: true };
  }
  const num = slotNumber(accountNum);
  if (num == null) return { ok: false, reason: "bad_account" };
  const roster = await fetchClaudeAccounts();
  const row = roster?.ok ? roster.accounts?.find(a => a.num === num) : null;
  if (!row?.email) return { ok: false, reason: "bad_account" };
  await updateChoice(c => ({ ...c, home: { email: row.email, orgUuid: row.orgUuid ?? null }, goHome: true, manual: false }));
  return { ok: true };
}

/** Auto-switch was just turned on: whatever happened while it was off is not
 *  a pick to protect, so the next tick starts from the account in use. */
export function forgetPicksByHand() {
  return updateChoice(c => ({ ...c, manual: false, lastActive: null })).catch(() => {});
}

/**
 * What claude-swap's engine keeps in autoswitch_state.json that a move here
 * has to respect: when it last switched, in ms or 0 — a move the deck makes
 * does not start the engine's cooldown, so this one keeps both — and the
 * accounts it has quarantined, by key.
 *
 * A quarantine is the slot's, with the email it held: the engine drops one
 * whose slot now holds somebody else, so it is only this account's while the
 * emails agree. One the engine would drop for a fresh login it drops on its
 * next run, which every tick that does not move here is.
 */
async function engineState(accounts) {
  let state = null;
  try { state = JSON.parse(await readFile(join(backupRoot(), "autoswitch_state.json"), "utf8")); } catch {}
  const at = Number(state?.lastSwitchAt);
  const held = state?.quarantine && typeof state.quarantine === "object" ? state.quarantine : {};
  const sameEmail = (x, y) => typeof x === "string" && typeof y === "string" && x.trim().toLowerCase() === y.trim().toLowerCase();
  return {
    lastSwitchAt: Number.isFinite(at) && at > 0 ? at * 1000 : 0,
    quarantined: new Set(accounts.filter(a => sameEmail(held[String(a.num)]?.email, a.email)).map(a => a.key)),
  };
}

/** The accounts paired decks have recently said they are working on.
 *  One login live on two machines races for every renewal (README, "One login
 *  live in one place"), so a tick never moves onto one of them. The LAN table
 *  retains old manifests for display after a peer goes quiet; those are not
 *  current reservations. Use the authenticated manifest's receipt time, not a
 *  beacon or a failed round, which cannot confirm the account still in use. */
async function accountsOnOtherDecks(now) {
  try {
    const [{ lanEngine }, { PRESENT_MS }] = await Promise.all([
      import("./lan-deck.mjs"), import("./lan-sync.mjs"),
    ]);
    const peers = lanEngine.status()?.peers ?? [];
    return new Set(peers
      .filter(p => p?.paired === true && Number.isFinite(p.offers?.at) && p.offers.at > 0 && now - p.offers.at < PRESENT_MS)
      .map(p => p.offers.current?.key).filter(k => typeof k === "string"));
  } catch {
    return new Set();
  }
}

/** The name claude-swap gives an account's `cswap run` profile after its
 *  slot number: the email, NFC, with anything but ASCII letters, digits and
 *  `._-` turned into `_` (claude_swap/session.py, slugify_email). */
export function sessionSlug(email) {
  return [...String(email ?? "").normalize("NFC")].map(ch => (/^[A-Za-z0-9._-]$/.test(ch) ? ch : "_")).join("");
}

/**
 * The accounts a `cswap run` session is working on, by key. Such a session
 * runs Claude Code on the account's own copy of the login; the engine never
 * activates one of them, because two copies of one login race for every
 * renewal. `cswap switch`, which is what a move here runs, only warns — so
 * the deck asks the same question first.
 *
 * Claude Code leaves one record per running instance in the profile's
 * `sessions/<pid>.json`; one counts while its process is running. A pid used
 * again by something else reads as live too, which only leaves that move to
 * the engine.
 */
async function accountsInCswapRun(accounts) {
  const live = new Set();
  for (const a of accounts) {
    if (a.num == null || !a.email) continue;
    const dir = join(backupRoot(), "sessions", `${a.num}-${sessionSlug(a.email)}`, "sessions");
    let names = [];
    try { names = (await readdir(dir)).filter(n => /^\d+\.json$/.test(n)); } catch { continue; }
    for (const name of names) {
      let pid = null;
      try { pid = Number(JSON.parse(await readFile(join(dir, name), "utf8"))?.pid); } catch {}
      if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) { live.add(a.key); break; }
    }
  }
  return live;
}

const numberOr = (v, fallback) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : fallback;
};

/** One side of a move, in the shape claude-swap's own `switch` event has. */
const refOf = a => (a ? { number: a.num, email: a.email ?? null } : null);

/**
 * Ask the two rules, and move when they say so. Under the store mutex, from
 * the tick (cswap-auto-loop.mjs).
 *
 * Returns `{ result, accounts }`: `result` is a tick in the shape summarise
 * gives the engine's — so the caches, the swap log and the notification treat
 * the move as any other — or null for "run the engine"; `accounts` is the
 * roster it decided on, which noteEngineTick needs to name where the engine
 * went, and null when nothing is set.
 */
export async function chooseBeforeEngine({ now = Date.now() } = {}) {
  const choice = await readChoice();
  if (choice.next === "room" && !choice.home) return { result: null, accounts: null };
  const roster = await fetchClaudeAccounts();
  if (!roster?.ok || !Array.isArray(roster.accounts)) return { result: null, accounts: null };
  const accounts = roster.accounts.map(a => ({ ...a, key: accountKey(a.email, a.orgUuid) }));
  const active = accounts.find(a => a.active) ?? null;

  const byHand = active != null && choice.lastActive != null && choice.lastActive !== active.key;
  const manual = choice.manual || byHand;
  const goHome = choice.goHome && active?.key !== choice.home?.key;
  // WHAT THIS TICK LEARNED, WRITTEN OVER WHAT IS THERE NOW. The panel's writes
  // do not wait for the store lock, so "Set as home" or a new rule can land
  // while the awaits below run. `manual` and `goHome` were worked out from the
  // choice as it was read, so they are only written back over that same
  // choice — over a newer one they would undo what the person just set.
  // Every write replaces the held object, which is what tells the two apart.
  const keep = c => (c === choice
    ? { ...c, manual, goHome, lastActive: active?.key ?? c.lastActive }
    : { ...c, lastActive: active?.key ?? c.lastActive });

  const cfg = (await readCswapConfig()) ?? {};
  const threshold = numberOr(cfg["autoswitch.threshold"]?.value, 90);
  const models = countedModels(cfg["autoswitch.model"]?.value);
  const engine = await engineState(accounts);
  const pick = chooseAccount({
    accounts,
    choice: { next: choice.next, home: choice.home?.key ?? null, manual, goHome },
    threshold,
    models,
    busy: new Set([...await accountsOnOtherDecks(now), ...await accountsInCswapRun(accounts)]),
    quarantined: engine.quarantined,
    sinceMove: now - Math.max(choice.lastMoveAt, engine.lastSwitchAt),
    cooldownMs: numberOr(cfg["autoswitch.cooldownSeconds"]?.value, 300) * 1000,
    optional: (cfg["autoswitch.strategy"]?.value ?? "best") === "best",
    now,
  });
  if (!pick) {
    await updateChoice(keep);
    return { result: null, accounts };
  }
  const moved = await switchClaudeAccount(pick.to.num);
  if (!moved.ok) {
    await updateChoice(keep);
    return { result: null, accounts };
  }
  // The move happened, so where it left the user and when are true whatever
  // was set meanwhile; a home still to be gone to is the current choice's.
  await updateChoice(c => ({
    ...c, manual: false, goHome: (c === choice ? goHome : c.goHome) && pick.to.key !== c.home?.key,
    lastActive: pick.to.key, lastMoveAt: now,
  }));
  return {
    result: {
      ok: true,
      event: "switch",
      switched: true,
      trigger: pick.trigger,
      reason: null,
      detail: null,
      from: refOf(active),
      to: refOf(pick.to),
      active: refOf(active),
      threshold,
      // What the notification reads, in the shape claude-swap's poll gives:
      // room per account, and the windows of each by label.
      headroom: Object.fromEntries(accounts.map(a => [String(a.num), a.headroom ?? null])),
      windows: Object.fromEntries(accounts.map(a => [String(a.num),
        Object.fromEntries((a.lanes ?? []).map(l => [l.label, l.pct]))])),
      resetAt: pick.resetAt ?? null,
    },
    accounts,
  };
}

/** The engine switched in a tick this step had looked at: the account it left
 *  the user on is the tick's pick, not one made by hand. */
export async function noteEngineTick(result, accounts) {
  if (!accounts || !result?.switched) return;
  const to = accounts.find(a => String(a.num) === String(result.to?.number));
  await updateChoice(c => ({ ...c, manual: false, lastActive: to?.key ?? null, lastMoveAt: Date.now() }));
}
