import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchClaudeAccounts, invalidateClaudeAccountsCache, slotNumber } from "./claude-accounts.mjs";
import { invalidateQuotaCache } from "./quota.mjs";
import { withStoreLock } from "./store-lock.mjs";
import { run } from "./exec.mjs";
import { cswapBin } from "./cswap-install.mjs";
import { renameWithRetry } from "./atomic-write.mjs";
import { currentActiveSlot } from "./swap-log.mjs";

const PATH = join(homedir(), ".agents-deck", "preferred-account.json");
let configured = false;

async function readState() {
  try { return JSON.parse(await readFile(PATH, "utf8")); } catch { return null; }
}

async function writeState(state) {
  await mkdir(join(homedir(), ".agents-deck"), { recursive: true });
  const temporary = `${PATH}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state));
  await renameWithRetry(temporary, PATH);
}

export async function preferredAccount() {
  const state = await readState();
  return state && typeof state.email === "string"
    && (state.resetAt === null || Number.isFinite(state.resetAt)) ? state : null;
}

export async function loadPreferredAccount() {
  configured = Boolean(await preferredAccount());
}

export function preferredAccountConfigured() {
  return configured;
}

export async function setPreferredAccount(accountNum) {
  return withStoreLock(() => setPreferredAccountLocked(accountNum));
}

async function setPreferredAccountLocked(accountNum) {
  if (accountNum === null) {
    await writeState(null);
    configured = false;
    return { ok: true };
  }
  const num = slotNumber(accountNum);
  if (num == null) return { ok: false, reason: "bad_account" };
  const roster = await fetchClaudeAccounts({ force: true });
  const account = roster.accounts?.find(a => a.num === num);
  const fiveHour = account?.lanes?.find(l => l.id === "five_hour");
  if (!account?.email || !fiveHour) return { ok: false, reason: "no_five_hour_window" };
  if (account.disabled || account.alive === false) return { ok: false, reason: "account_unavailable" };
  await writeState({ email: account.email, orgUuid: account.orgUuid ?? null,
    resetAt: fiveHour.resetAt, awaitingWindow: fiveHour.resetAt == null,
    idleDelivered: fiveHour.resetAt == null && account.active });
  configured = true;
  return { ok: true };
}

export function windowResetObserved(state, account) {
  const fiveHour = account.lanes.find(l => l.id === "five_hour");
  if (!fiveHour || state.awaitingWindow || state.resetAt == null) return false;
  if (fiveHour.resetAt != null) return fiveHour.resetAt > state.resetAt;
  return fiveHour.pct === 0 && account.fetchedAt > state.resetAt * 1000;
}

export function shouldReturnToPreferred(state, account, threshold) {
  if (!state || !account || account.active || account.disabled || account.alive === false || account.stale) return false;
  if (account.email !== state.email || (account.orgUuid ?? null) !== state.orgUuid) return false;
  if (!Number.isFinite(threshold)) return false;
  return windowResetObserved(state, account) && account.lanes.every(l => l.pct < threshold);
}

export function idlePreferredAvailable(state, account, threshold) {
  if (!state?.awaitingWindow || state.idleDelivered || !account || account.active
    || account.disabled || account.alive === false || account.stale) return false;
  if (account.email !== state.email || (account.orgUuid ?? null) !== state.orgUuid) return false;
  if (!Number.isFinite(threshold)) return false;
  const fiveHour = account.lanes.find(l => l.id === "five_hour");
  return fiveHour?.pct === 0 && fiveHour.resetAt == null
    && account.lanes.every(l => l.pct < threshold);
}

async function switchToPreferred(account, roster, nextState, canSwitch) {
  const previous = roster.accounts.find(a => a.active);
  if (!await canSwitch()) return null;
  await run(await cswapBin(), ["switch", String(account.num)], { timeout: 30_000 });
  if (await currentActiveSlot() !== account.num) return null;
  invalidateClaudeAccountsCache();
  invalidateQuotaCache();
  await writeState(nextState);
  return { from: previous ? { number: previous.num, email: previous.email } : null,
    to: { number: account.num, email: account.email } };
}

/** Called only while the auto tick holds the store mutex. */
export async function returnToPreferred(threshold, canSwitch = () => true) {
  const state = await preferredAccount();
  if (!state) return null;
  const roster = await fetchClaudeAccounts({ force: true });
  if (!roster.ok) return null;
  const account = roster.accounts?.find(a => a.email === state.email && (a.orgUuid ?? null) === state.orgUuid);
  if (!account) return null;
  const fiveHour = account.lanes.find(l => l.id === "five_hour");
  if (!fiveHour) return null;
  if (state.awaitingWindow) {
    if (fiveHour.resetAt != null) {
      await writeState({ ...state, resetAt: fiveHour.resetAt, awaitingWindow: false, idleDelivered: false });
      return null;
    }
    if (state.idleDelivered || fiveHour.pct !== 0) return null;
    if (account.active) {
      await writeState({ ...state, idleDelivered: true });
      return null;
    }
    if (!idlePreferredAvailable(state, account, threshold)) return null;
    return switchToPreferred(account, roster, { ...state, idleDelivered: true }, canSwitch);
  }
  if (!windowResetObserved(state, account)) return null;
  const nextState = { ...state, resetAt: fiveHour.resetAt, awaitingWindow: fiveHour.resetAt == null,
    idleDelivered: fiveHour.resetAt == null };
  if (account.active) {
    await writeState(nextState);
    return null;
  }
  if (!shouldReturnToPreferred(state, account, threshold)) return null;
  return switchToPreferred(account, roster, nextState, canSwitch);
}
