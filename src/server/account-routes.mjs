// The HTTP face of the Claude accounts surface: the roster, the switch, sign-in
// and the store's admin verbs, auto-switch, and the per-account Projects report.
//
// These lived in src/server/index.mjs, on either side of the self-update pin,
// and they are the thinnest layer in the deck: each one reads a query or a
// body, hands it to claude-accounts.mjs, cswap-admin.mjs, cswap-auto.mjs or the
// project rollup, and answers with what came back. Every one of those modules
// is still imported lazily and by the same package-root URL PINNED_MODULES
// loads, so moving the routes here puts no import on the path to a listening
// socket and takes none out of the pin.
//
// Five things are exported beyond the handlers. Four because index.mjs reaches
// for them: wireStaleCopyRepair, which startServer runs to hand the roster its
// stale-copy repair, wireAccountOrigins, which hands it and the sign-in flow
// where accounts came from (#1893), cswapAutoModule, which it uses to start
// auto-switch, and getProjectRollup, which it starts at boot. The fifth is
// CHECKS_IMPORTS, which lan-deck.mjs reads because a LAN round checks the
// imports it lands the same way the paste box does.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readBody, send } from "./http-io.mjs";
// Where the deck keeps which accounts it signed in (#1893): prefs.json, through
// the one in-memory copy and its queued writer. Both are already on the boot
// path, which the lazily imported modules below are kept off.
import { heldPrefs } from "./prefs-state.mjs";
import { PRODUCT } from "./brand.mjs";
import {
  incidentsFrom, normaliseOrigins, withDismissed, withRecovered, withSignIn, withoutOrigin,
} from "./account-origins.mjs";

// Resolved the way pinned-build.mjs resolves it, from a file in the same
// directory, so every lazy import below is the URL the pin has already evaluated.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Whether every import is followed by checkImports, which only asks on a Mac.
// When it does, the import skips its own detached collection — see importAccount.
export const CHECKS_IMPORTS = process.platform === "darwin";

export async function handleClaudeAccounts(req, res) {
  const { fetchClaudeAccounts } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  send(res, 200, await fetchClaudeAccounts({ force }));
}

export async function handleClaudeAccountSwitch(req, res) {
  const { switchClaudeAccount, invalidateClaudeAccountsCache } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href
  );
  const body = await readBody(req, res).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });

  const result = await switchClaudeAccount(parsed.account);
  // The active account just moved; the next poll should see it immediately
  // rather than serving the pre-switch roster for another few seconds.
  invalidateClaudeAccountsCache();
  // The 5h/7d percentages moved with it — they are read for whichever account is
  // active — and only this side knows: /api/quota is polled by the usage panel,
  // which has no idea the accounts panel just switched and so never sends
  // ?refresh=1. Without this the two panels sit on one screen disagreeing about
  // the same account for a full poll cycle, and the stale one is the one the
  // user just acted on. Only on a switch that took: a refused one left the
  // account where it was, and throwing away a reading we paid for costs a real
  // answer to fix nothing.
  if (result.ok) {
    const { invalidateQuotaCache } = await import(
      pathToFileURL(join(PKG_ROOT, "src/server/quota.mjs")).href
    );
    invalidateQuotaCache();
    // Note who became active, and when, for the account-projects report. Best
    // effort — a failed log write must never fail the switch — so it is not
    // awaited into the response.
    import(pathToFileURL(join(PKG_ROOT, "src/server/swap-log.mjs")).href)
      .then(({ recordSwap }) => recordSwap(parsed.account, "manual"))
      .catch(() => {});
  }
  send(res, result.ok ? 200 : 400, result);
}

// The account-projects rollup, started once and shared. Its timer is unref'd
// inside start(), so holding the instance here never keeps the process alive.
let _projectRollup = null;
export function getProjectRollup() {
  if (!_projectRollup) {
    _projectRollup = import(pathToFileURL(join(PKG_ROOT, "src/server/account-projects.mjs")).href)
      .then(m => { const r = m.createProjectRollup(); r.start().catch(() => {}); return r; });
  }
  return _projectRollup;
}

/**
 * The "Projects" report for one account: how many tokens it spent per project
 * over a window. The server tallies only tokens (per model); the web side
 * prices them with its own table, so cost never lives in two places. `num` is
 * the account's slot, resolved to its `(email, org)` key here; `days` is 1, 7,
 * 30, or 0 for all tracked.
 */
export async function handleAccountProjects(req, res) {
  const url = new URL(req.url, "http://localhost");
  const num = Number(url.searchParams.get("num"));
  const d = Number(url.searchParams.get("days"));
  const days = d === 1 ? 1 : d === 30 ? 30 : d === 0 ? 0 : 7;
  if (!Number.isInteger(num) || num <= 0) return send(res, 400, { ok: false, reason: "bad_account" });
  const { identityForSlot } = await import(pathToFileURL(join(PKG_ROOT, "src/server/swap-log.mjs")).href);
  const id = await identityForSlot(num);
  if (!id) return send(res, 400, { ok: false, reason: "bad_account" });
  const { accountKey } = await import(pathToFileURL(join(PKG_ROOT, "src/server/lan-sync.mjs")).href);
  const rollup = await getProjectRollup();
  const report = await rollup.report(accountKey(id.email, id.orgUuid), days);
  send(res, 200, { ok: true, ...report });
}

function cswapAdminModule() {
  return import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-admin.mjs")).href);
}

/**
 * Hand cswap-admin's autoRecapture to the roster read, so a `stale-copy` row
 * carries its own repair rather than a button — see repairStaleCopyWith.
 *
 * startServer calls this once per boot on a deck that watches Claude Code, and
 * does not wait for it. It lived in startServer itself and moved here, beside
 * cswapAdminModule and the package root it imports the pair by; the body is
 * unchanged.
 */
export function wireStaleCopyRepair() {
  // THIS WIRING IS WHERE AN IMPORT CYCLE SHOWED UP AS A SILENT NO-OP, and it
  // is the cycle that has been fixed rather than this line — see
  // claude-identity.mjs.
  //
  // claude-accounts.mjs used to take `currentIdentity` from cswap-admin.mjs
  // while cswap-admin.mjs took `backupRoot`, `invalidateClaudeAccountsCache`
  // and `verdictNow` back, which was the only static import cycle in
  // src/server. Two dynamic imports entering a cycle concurrently are each
  // handed the other module's HALF-BUILT namespace rather than waiting for
  // it, and a half-built namespace has no exports on it at all: measured on
  // CI, both came back with zero keys, so `accounts.repairStaleCopyWith` was
  // a TypeError in a promise nothing awaits. The repair was never wired and
  // nothing said so — every test passed, and the run exited 1 on an unhandled
  // rejection alone.
  //
  // Several importers reach this pair within a few ticks at boot —
  // startServer's `cswapAutoModule()` imports claude-accounts.mjs too, and
  // `startServer` can be called again before this has settled — so it was a
  // timing defect that any change to those import lists could trip, and
  // sequencing one call site was never going to be enough.
  //
  // Asked for one at a time anyway, which is now belt as well as braces: with
  // no cycle left, a concurrent pair would simply wait for each other.
  // boot-module-graph.test.ts asserts the braces — that src/server has no
  // import cycles at all — rather than trying to police call sites.
  void (async () => {
    let accounts, admin;
    // An import that genuinely fails stays tolerated, exactly as the
    // `() => {}` this replaced tolerated it: the wiring is best-effort. A
    // namespace that arrives WITHOUT the function is a different thing and
    // must stay loud, because that is the failure described above.
    try {
      accounts = await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href);
      admin = await cswapAdminModule();
    } catch { return; }
    accounts.repairStaleCopyWith(admin.autoRecapture);
  })();
}

/**
 * Hand the roster and the sign-in flow what the deck remembers about where its
 * accounts came from (#1893), so a completed `+ → Sign in` is recorded, a
 * removal forgets it, and each roster row can say whether it is an incident to
 * ask its owner about.
 *
 * Run beside wireStaleCopyRepair and for its reasons: best-effort, imported one
 * module at a time, and never at import, so no test reading a fixture store can
 * reach the user's own prefs.json.
 */
export function wireAccountOrigins() {
  void (async () => {
    let accounts, admin;
    try {
      accounts = await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href);
      admin = await cswapAdminModule();
    } catch { return; }
    accounts.accountOriginsWith({
      entries: () => normaliseOrigins(heldPrefs.current()?.accounts),
      // Told on a read, and a read happens every few seconds: only a put-off
      // that is really still there is written away, so a recovered account
      // costs one write rather than one per poll.
      recovered: keys => {
        const held = normaliseOrigins(heldPrefs.current()?.accounts);
        if (!keys.some(k => held[k]?.dismissed != null)) return;
        heldPrefs.update(withRecovered(keys)).catch(err => noteOriginFailure(err));
      },
    });
    admin.accountOriginsWith({
      signedIn: ({ email, org, added }) => heldPrefs.update(withSignIn({ email, org, added, now: Date.now() })),
      removed: ({ email, org }) => heldPrefs.update(withoutOrigin({ email, org })),
    });
  })();
}

/** A settings file the deck cannot write costs a remembered "Not now", which
 *  the next read asks about again — said in the log and nowhere else. */
function noteOriginFailure(err) {
  console.error(`${PRODUCT}: could not update where an account came from:`, err?.message ?? err);
}

/**
 * "Not now" on the accounts the re-sign-in prompt named (#1893).
 *
 * Each incident is `{ key, since }` as the roster row sent it. Written to the
 * account's entry, so the prompt stays down for that incident across a reload,
 * another tab and a restart, and comes back only for a new one. The roster is
 * forgotten after, so the next read already carries `dismissed`.
 */
async function dismissReauth(raw) {
  const incidents = incidentsFrom(raw);
  if (!incidents.length) return { ok: false, reason: "bad_request" };
  try {
    await heldPrefs.update(withDismissed(incidents));
  } catch (err) {
    noteOriginFailure(err);
    return { ok: false, reason: "prefs_unwritable" };
  }
  const { invalidateClaudeAccountsCache } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href
  );
  invalidateClaudeAccountsCache();
  return { ok: true };
}

// Reading the login's progress. The browser polls this while its dialog is
// open, the same way the upgrade notice polls /api/version.
export async function handleAccountLoginState(_req, res) {
  const { loginState } = await cswapAdminModule();
  send(res, 200, { ok: true, ...loginState() });
}

/**
 * Everything that changes the account store, behind one verb switch — the shape
 * handleCswapAutoAction already uses.
 *
 * The sign-in code is the one field here that is a credential. It is read out
 * of the body, handed straight to the child's stdin, and never logged, echoed
 * back, or written anywhere — which is also why this is a POST body and not a
 * query parameter.
 */
export async function handleClaudeAccountAdmin(req, res) {
  const admin = await cswapAdminModule();
  const body = await readBody(req, res).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });

  let result;
  switch (parsed.action) {
    case "login":        result = await admin.startLogin({ email: parsed.email }); break;
    case "login-code":   result = await admin.submitLoginCode(parsed.code); break;
    case "login-cancel": result = await admin.cancelLogin(); break;
    // `accounts` is a chosen set, `account` the single row's own button. Both
    // go to shareAccounts, which treats one account as a bundle of one so the
    // two entry points cannot drift into two envelope shapes.
    case "share":        result = await admin.shareAccounts(parsed.accounts ?? parsed.account); break;
    // `only` names one account inside the pasted bundle, and is the only way
    // `force` is honoured at all - see importAccount for why the pair is
    // required rather than the flag alone.
    case "import": {
      const out = await admin.importAccount(parsed.blob, {
        force: parsed.force === true,
        only: parsed.only ?? null,
        collect: !CHECKS_IMPORTS,
      });
      // Checked the way a LAN round's arrivals are (#1244): `cswap import`
      // exiting 0 on a Mac is not proof this process can read what it wrote.
      result = out?.ok ? { ...out, results: await admin.checkImportResults(out.results) } : out;
      break;
    }
    case "remove":       result = await admin.removeAccount(parsed.account); break;
    // #721. Re-captures the active slot's credentials in place; see
    // recaptureActive for why this is not a login and cannot become one.
    case "recapture":    result = await admin.recaptureActive(); break;
    case "alias":        result = await admin.setAlias(parsed.account, parsed.alias); break;
    case "move":         result = await admin.moveAccount(parsed.account, parsed.slot); break;
    // #1893. Touches prefs.json, never the store: "Not now" on a re-sign-in
    // prompt, remembered for that incident.
    case "reauth-later": result = await dismissReauth(parsed.incidents); break;
    default: return send(res, 400, { ok: false, reason: "unknown_action" });
  }
  send(res, result.ok ? 200 : 400, result);
}

export function cswapAutoModule() {
  return import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-auto.mjs")).href);
}

export async function handleCswapAuto(req, res) {
  const { autoStatus } = await cswapAutoModule();
  send(res, 200, await autoStatus());
}

/**
 * One POST for every auto-switch control, keyed by `action`. Each one can move
 * the user's live Claude account or change when it moves, so nothing here is
 * reachable by GET.
 */
export async function handleCswapAutoAction(req, res) {
  const mod = await cswapAutoModule();
  const body = await readBody(req, res).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });

  let result;
  switch (parsed.action) {
    case "enable":
      result = await mod.setAutoEnabled(parsed.enabled === true);
      break;
    case "setting":
      result = await mod.setCswapConfig(String(parsed.key ?? ""), parsed.value);
      break;
    case "account":
      result = await mod.setAccountEnabled(parsed.account, parsed.enabled === true);
      break;
    default:
      return send(res, 400, { ok: false, reason: "unknown_action" });
  }
  send(res, result.ok ? 200 : 400, result);
}
