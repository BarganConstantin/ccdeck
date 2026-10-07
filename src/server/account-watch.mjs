// The account notifier this process runs: where its records live, what reads
// quota for it while no page does, and the doors the rest of the server reaches
// it through.
//
// The decisions are account-notify.mjs's. This file is the wiring around them,
// kept light on purpose: event-pipeline.mjs connects it as the server module
// loads, and the auto-switch loop reports every tick to it, so everything heavy
// it uses — the two quota modules and the accounts store — is reached by
// `import()` and only when a reading is wanted. Those three are pinned with the
// rest (pinned-build.mjs).
//
// NOTHING HERE MAY COST A POLL OR A TICK. Every door returns at once and does
// its work on a promise that is caught; a notification that cannot be raised,
// a record that cannot be written and a store that cannot be read all end as
// a line on stderr at most.
import { readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  claudeAccountKey, claudeWindows, codexAccountKey, codexWindows, createAccountNotifier,
} from "./account-notify.mjs";
import { deckDataDir } from "./deck-home.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the records are kept: beside prefs.json, in the deck's own data. */
export function recordsPath(home = deckDataDir()) {
  return join(home, "account-notify.json");
}

/**
 * How often quota is read for the notifier while it wants readings.
 *
 * Only while the threshold or the reset switch is on — both start off — and
 * every read goes through the same caches and floors as the Usage panel's, so
 * with a page open this adds nothing and with none it costs half of what an
 * open page does.
 */
export const WATCH_MS = 2 * 60_000;

let _deps = null;
let _notifier = null;
let _autoOn = false;
let _timer = null;
let _watching = null;

/**
 * Hand the notifier its OS call, its product name and its switches. Called
 * once, as the server module loads; until it is, every door below is a no-op —
 * which is what keeps a test that drives the auto-switch loop on its own from
 * writing records or raising anything.
 */
export function connectAccountNotify({ notify, settings, product, onError }) {
  _deps = { notify, settings, product, onError };
}

function notifier() {
  if (_notifier || !_deps) return _notifier;
  const path = recordsPath();
  _notifier = createAccountNotifier({
    notify: _deps.notify,
    settings: _deps.settings,
    product: _deps.product,
    onError: _deps.onError,
    load: async () => {
      try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
    },
    save: async records => {
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, `${JSON.stringify(records)}\n`);
    },
  });
  _notifier.autoSwitch(_autoOn);
  return _notifier;
}

/** The deck's auto-switch loop was switched on or off (cswap-auto-loop.mjs). */
export function noteAutoSwitch(enabled) {
  _autoOn = enabled === true;
  try { _notifier?.autoSwitch(_autoOn); } catch { /* never the loop's problem */ }
}

/**
 * A finished tick of the deck's own auto-switch loop. The only way a swap
 * notification is raised: a switch somebody pressed never comes through here.
 * After a switch, claude-swap's roster is read for the two accounts' names and
 * keys — the store, which the deck already reads, rather than anything more out
 * of the tick's own output.
 */
export function noteAutoTick(result) {
  const n = notifier();
  if (!n || !result) return Promise.resolve();
  return (result.switched ? storeAccounts() : Promise.resolve(null))
    .then(accounts => n.tick(result, accounts))
    .catch(() => {});
}

/** claude-swap's roster, number → `{ email, organizationUuid, alias }`, or null. */
async function storeAccounts() {
  try {
    const { backupRoot } = await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href);
    const seq = JSON.parse(await readFile(join(backupRoot(), "sequence.json"), "utf8"));
    return seq?.accounts && typeof seq.accounts === "object" ? seq.accounts : null;
  } catch {
    return null;
  }
}

/** What the deck calls a Claude account: its alias in claude-swap, else its
 *  address. */
function claudeName(account, accounts) {
  const entry = Object.values(accounts ?? {}).find(a =>
    typeof a?.email === "string" && a.email.toLowerCase() === account.email.toLowerCase()
    && a.organizationUuid === account.organizationUuid);
  const alias = typeof entry?.alias === "string" ? entry.alias.trim() : "";
  return alias || account.email;
}

async function observeClaude(n) {
  const quota = await import(pathToFileURL(join(PKG_ROOT, "src/server/quota.mjs")).href);
  const reading = await quota.fetchClaudeQuota();
  const who = quota.quotaAccount(reading);
  const key = who ? claudeAccountKey(who.email, who.organizationUuid) : null;
  if (!key) return;
  await n.observe("claude", { key, name: claudeName(who, await storeAccounts()) }, claudeWindows(reading));
}

async function observeCodex(n) {
  const quota = await import(pathToFileURL(join(PKG_ROOT, "src/server/codex-quota.mjs")).href);
  const reading = await quota.fetchCodexQuota();
  const who = quota.codexQuotaAccount(reading);
  const key = who ? codexAccountKey(who.accountId, who.email) : null;
  if (!key) return;
  await n.observe("codex", { key, name: who.email || null }, codexWindows(reading));
}

/**
 * One look at the live accounts' quota, when a switch wants it. One at a time:
 * a Claude read can take a while, and the next interval joins it rather than
 * stacking a second behind it.
 */
export function watchOnce(providers) {
  if (_watching) return _watching;
  const s = _deps?.settings?.();
  const n = notifier();
  if (!n || !s || (!s.quota && !s.reset)) return Promise.resolve();
  const { claude = true, codex = true } = providers?.() ?? {};
  _watching = (async () => {
    // A failed read is the quota modules' to report, and the Usage panel says
    // it; here it only means there is nothing to compare this time.
    if (claude) await observeClaude(n).catch(() => {});
    if (codex) await observeCodex(n).catch(() => {});
  })().finally(() => { _watching = null; });
  return _watching;
}

/**
 * Start reading quota on a timer, from startServer once the port is bound —
 * never at import, because a launcher imports the server module only to ask
 * whether a deck is already up. Unref'd like every other timer the deck keeps.
 */
export function startAccountWatch({ providers } = {}) {
  if (_timer) return;
  _timer = setInterval(() => { watchOnce(providers).catch(() => {}); }, WATCH_MS);
  _timer.unref?.();
  const first = setTimeout(() => { watchOnce(providers).catch(() => {}); }, 15_000);
  first.unref?.();
}
