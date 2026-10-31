// account.json: which ccdeck account this deck is connected to, as which
// device, and where its settings sync stands.
//
// THE DECK'S ALONE AND NEVER SERVED. Nothing here goes to a page whole: the
// routes answer a view built out of it (account-service.mjs accountView), with
// no token, no cipher and no device code in it. The token itself lives in the
// OS keychain where there is one (account-token-store.mjs); where there is
// not, it lives here, which is why this file is written the way prefs.json is —
// created 0600 on the create rather than chmod'ed after, staged through an
// O_EXCL temp file, fsynced, renamed into place with the Windows retry ladder,
// and the temp removed if anything fails. See deck-prefs.mjs `save` for the
// whole argument; this is the same discipline on a second secret.
//
// In the deck's own data folder (deck-home.mjs deckDataDir), so CCDECK_HOME
// moves it with everything else and two profiles of one machine are two
// devices.
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createTemp, renameWithRetry, stripBom } from "./atomic-write.mjs";
import { deckDataDir } from "./deck-home.mjs";
import { PRODUCT } from "./brand.mjs";

export const ACCOUNT_FILE = "account.json";
export const ACCOUNT_MODE = 0o600;
/** The shape version of account.json. */
export const ACCOUNT_V = 1;

export function accountPath(home = deckDataDir()) {
  return join(home, ACCOUNT_FILE);
}

const text = (v, max = 256) => (typeof v === "string" && v.length <= max ? v : "");
const nullableText = (v, max = 256) => (typeof v === "string" && v.length && v.length <= max ? v : null);
const TOKEN_STORAGES = new Set(["keychain", "dpapi", "secret-service", "file"]);

/** The device token's shape. Anything else is not a token this deck made. */
export const DEVICE_TOKEN = /^ccdd_[A-Za-z0-9_-]{20,128}$/;

/**
 * Whatever is on disk, coerced into the one shape the deck reads. A field that
 * is not what it should be reads as absent — a hand-edited or half-written
 * file must cost a reconnect, never a crash.
 */
export function normaliseAccount(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const tokenStorage = TOKEN_STORAGES.has(src.tokenStorage) ? src.tokenStorage : null;
  return {
    v: ACCOUNT_V,
    apiBase: text(src.apiBase, 200),
    // The console's origin, from the approval page the API sent: where this
    // device's page in Machines is.
    appBase: text(src.appBase, 200),
    accountId: text(src.accountId, 64),
    email: text(src.email, 256),
    deviceId: text(src.deviceId, 64),
    deviceName: text(src.deviceName, 128),
    connectedAt: text(src.connectedAt, 40),
    tokenStorage,
    // The token, for the file backend only; the DPAPI ciphertext for Windows.
    token: tokenStorage === "file" && typeof src.token === "string" && DEVICE_TOKEN.test(src.token) ? src.token : "",
    tokenCipher: tokenStorage === "dpapi" ? text(src.tokenCipher, 4096) : "",
    // Why this deck stopped being connected, when the API ended it.
    revokedAt: text(src.revokedAt, 40),
    revokedReason: nullableText(src.revokedReason, 32),
    // The account this deck was last connected to, kept after a disconnect so a
    // reconnect to the SAME account uploads and one to another never does.
    previousAccountId: text(src.previousAccountId, 64),
    sync: src.sync && typeof src.sync === "object" && !Array.isArray(src.sync) ? src.sync : null,
  };
}

/** A fresh, not-connected record. */
export function emptyAccount() {
  return normaliseAccount({});
}

/**
 * Read account.json. ENOENT is "never connected"; a file that will not parse
 * is said once and read as never connected too — the next write replaces it,
 * which costs a reconnect and nothing else (there is no LAN key in here to
 * lose, unlike prefs.json).
 */
export async function loadAccount(home = deckDataDir(), deps = {}) {
  const read = deps.readFile ?? readFile;
  const warn = deps.warn ?? console.error;
  let raw;
  try {
    raw = await read(accountPath(home), "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") warn(`${PRODUCT}: could not read ${ACCOUNT_FILE}: ${err?.code ?? "error"}`);
    return emptyAccount();
  }
  try {
    return normaliseAccount(JSON.parse(stripBom(raw)));
  } catch {
    warn(`${PRODUCT}: ${ACCOUNT_FILE} is not JSON; this deck starts disconnected`);
    return emptyAccount();
  }
}

let chain = Promise.resolve();

/** Write the whole record, behind every write already queued, atomically and
 *  at 0600 from the first byte. Answers what was written. */
export function saveAccount(record, home = deckDataDir(), deps = {}) {
  const job = () => writeRecord(normaliseAccount(record), home, deps);
  const started = chain.then(job, job);
  chain = started.then(() => {}, () => {});
  return started;
}

async function writeRecord(next, home, deps) {
  const mk = deps.mkdir ?? mkdir;
  const temp = deps.createTemp ?? createTemp;
  const setMode = deps.chmod ?? chmod;
  const mv = deps.rename ?? renameWithRetry;
  const drop = deps.unlink ?? unlink;
  const target = accountPath(home);
  await mk(home, { recursive: true, mode: 0o700 });
  const { tmp, handle } = await temp(target, { mode: ACCOUNT_MODE });
  let landed = false;
  try {
    try {
      await handle.writeFile(JSON.stringify(next, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await setMode(tmp, ACCOUNT_MODE);
    await mv(tmp, target);
    landed = true;
  } finally {
    // A temp left behind can hold the token in the clear.
    if (!landed) await drop(tmp).catch(() => {});
  }
  return next;
}
