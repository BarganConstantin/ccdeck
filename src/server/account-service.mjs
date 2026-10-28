// The account, as one running thing: account.json, the device token, the
// connect flow, the status publisher, the settings sync and the session
// counts, wired together — and the one answer every /api/account route and
// every `event: account` frame gives (`view`).
//
// LOADED ONLY WHEN THE ACCOUNT IS ON. index.mjs imports this through
// ccdeck-account-routes.mjs with a dynamic import() the first time a route is
// asked, or at boot when the account is on; with the flag off nothing here is
// ever evaluated (account-flag-off.test.ts).
//
// WHAT NEVER LEAVES THIS PROCESS: the device token, its DPAPI ciphertext and
// the device code. The view carries where the token is kept and nothing about
// it; the token is redacted out of every event (token-redact.mjs) and every
// report (reports.mjs scrub); no log line here names it.
//
// FEEDBACK CONVERSATIONS go through the named methods at the end — a list, a
// thread, a new one, a reply, read — so the page never holds the token and
// the routes never build an API path. Nothing of a conversation is kept here:
// each is fetched when the page asks. What is kept is the account's summary,
// `{ unread, latestAt }`, which every status frame's answer carries and the
// view hands the page, in memory only, for the Feedback button's dot. A
// conversation started here carries the deck's version and system and never
// the reports' fingerprint or a contact: the account is the way back.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountApiBase } from "./account-flag.mjs";
import { createAccountClient, FEEDBACK_READ_MAX } from "./account-client.mjs";
import { cleanDeviceName, createConnectFlow, deckToken, defaultDeviceName } from "./account-connect.mjs";
import { createStatusPublisher, feedbackSummary, FINAL_401 } from "./account-status.mjs";
import { DEVICE_TOKEN, emptyAccount, loadAccount, normaliseAccount, saveAccount } from "./account-store.mjs";
import { createSync, initialSync, normaliseSync } from "./account-sync.mjs";
import { createTokenStore } from "./account-token-store.mjs";
import { inApp } from "./app-host.mjs";
import { PRODUCT } from "./brand.mjs";
import { deckDataDir } from "./deck-home.mjs";
import { isGitCheckout } from "./install-layout.mjs";
import { RUNNING_VERSION } from "./running-version.mjs";
import { createSessionCounts } from "./session-counts.mjs";
import { upstreamForm } from "./feedback-form.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** How often a token the keychain would not hand over is asked for again. */
export const LOCKED_RETRY_MS = 60_000;
const iso = ms => new Date(ms).toISOString();

/** The deck as the API is told about it: four tokens, nothing personal. */
export function deckFacts({ env = process.env, platform = process.platform, arch = process.arch, version = RUNNING_VERSION, checkout = isGitCheckout(PKG_ROOT) } = {}) {
  return {
    version: deckToken(version, 32),
    os: deckToken(platform, 16),
    arch: deckToken(arch, 16),
    channel: inApp(env) ? "desktop" : checkout ? "checkout" : "npm",
  };
}

/** The API's paths for the account's feedback conversations (design 3.3). */
const THREADS = "/v1/device/feedback/threads";
const threadPath = id => `${THREADS}/${encodeURIComponent(id)}`;
/** The two daily limits a 429 names, as opposed to the request policy's. */
const FEEDBACK_LIMITS = new Set(["too_many_conversations", "too_many_replies"]);

/** A 400's field errors as the page may show them: text under field names. */
function fieldErrors(body) {
  const errors = body?.errors;
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) return {};
  const out = {};
  for (const [field, messages] of Object.entries(errors)) {
    if (Array.isArray(messages)) out[field] = messages.filter(m => typeof m === "string");
  }
  return out;
}

/** Whether two summaries say the same thing (either may be null). */
const sameSummary = (a, b) => (a === null || b === null ? a === b : a.unread === b.unread && a.latestAt === b.latestAt);

/** Where a machine's page in the console is, from the approval page's origin:
 *  the API hands that out (PublicAccounts:AppBaseUrl), so a development API
 *  points at its own console. */
function consoleUrl(appBase, deviceId) {
  return appBase && deviceId ? `${appBase}/machines/${encodeURIComponent(deviceId)}` : null;
}

/**
 * The service. Everything outside it is passed in, with the product's own as
 * defaults; the suite hands it the fake API's address through `env`, a token
 * store that never touches a real keychain, the ring and the tap of a deck it
 * builds, and a clock.
 */
export function createAccountService({
  env = process.env,
  home = deckDataDir(),
  prefs = () => ({}),
  request = null,
  tokenStore = null,
  tokenStoreOptions = {},
  broadcast = () => {},
  reading = () => ({ cpu: { unknown: "unavailable" }, memory: { unknown: "unavailable" } }),
  ring = () => [],
  connectTap = () => {},
  capture = () => true,
  registerShutdown = () => () => {},
  setRedactions = () => {},
  facts = deckFacts({ env }),
  now = Date.now,
  random = Math.random,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = t => clearTimeout(t),
  log = msg => console.error(`${PRODUCT}: ${msg}`),
  /** Whether the account is still on (account-flag.mjs accountOn), asked by
   *  the client before every request. */
  enabled = () => true,
} = {}) {
  const tokens = tokenStore ?? createTokenStore({ env, home, ...tokenStoreOptions });
  const clients = new Map();
  const counts = createSessionCounts({ capture });

  let record = emptyAccount();
  let token = null;
  let tokenProblem = null;      // "keychain-locked" | "token-missing"
  let lockTimer = null;
  let flow = null;
  let publisher = null;
  let sync = null;
  let unregisterShutdown = null;
  let started = false;
  let announced = false;
  /** The account's feedback summary from the last answer that carried one:
   *  null before the first frame, and whenever not connected. */
  let feedback = null;

  function clientFor(apiBase) {
    let c = clients.get(apiBase);
    if (!c) {
      c = createAccountClient({ apiBase, version: facts.version, request, now, enabled });
      clients.set(apiBase, c);
    }
    return c;
  }

  /** Every change, as one frame: several in one turn are one broadcast. */
  function announce() {
    if (announced) return;
    announced = true;
    queueMicrotask(() => {
      announced = false;
      try { broadcast(view()); } catch { /* a page that went away */ }
    });
  }

  const suggestedName = () => cleanDeviceName(prefs()?.lan?.name ?? "", "") || defaultDeviceName();

  function state() {
    if (flow?.state().connecting) return "connecting";
    if (record.deviceId && tokenProblem === "token-missing") return "error";
    if (record.deviceId) return "connected";
    if (record.revokedAt) return "revoked";
    return "disconnected";
  }

  /** What /api/account answers and `event: account` carries. */
  function view() {
    const st = state();
    const connected = st === "connected";
    const flowState = flow?.state() ?? null;
    return {
      enabled: true,
      vetoed: false,
      state: st,
      connect: flowState?.connect ?? null,
      account: record.email && (connected || st === "revoked" || st === "error") ? { email: record.email } : null,
      device: record.deviceId
        ? { id: record.deviceId, name: record.deviceName, consoleUrl: consoleUrl(record.appBase, record.deviceId) }
        : null,
      suggestedName: suggestedName(),
      // Where the token is, or where a new one would go.
      tokenStorage: record.deviceId ? record.tokenStorage : tokens.backend(),
      status: connected ? (publisher?.status() ?? null) : null,
      sync: connected && sync ? sync.view() : null,
      revokedReason: st === "revoked" ? record.revokedReason : null,
      problem: tokenProblem && record.deviceId ? tokenProblem : (flowState?.problem ?? null),
      feedback: connected ? feedback : null,
    };
  }

  /** A summary from a frame's answer or a read's: kept, and said, only when it
   *  is one and says something new. A malformed one changes nothing; none at
   *  all (an API from before conversations) is no summary. */
  function noteFeedback(raw) {
    const next = raw == null ? null : feedbackSummary(raw);
    if (raw != null && !next) return;
    if (sameSummary(next, feedback)) return;
    feedback = next;
    announce();
  }

  /** Change the record and write it. The change lands in memory at once, so
   *  two writers in flight — a sync save and a token rotation — each build on
   *  the other's change instead of writing over it; the file writes are queued
   *  in the same order (account-store.mjs saveAccount). */
  function persist(mutate) {
    record = normaliseAccount(mutate(record));
    return saveAccount(record, home);
  }

  function setToken(next, also = []) {
    token = next;
    setRedactions([next, ...also].filter(Boolean));
  }

  /** Revocation, account deletion, a token the API no longer knows: the deck
   *  forgets the device, keeps who it was connected to, and says so. */
  async function ended(reason) {
    if (!record.deviceId) return;
    halt();
    const was = record;
    await tokens.remove(was).catch(() => {});
    setToken(null);
    await persist(() => ({
      ...emptyAccount(),
      email: was.email,
      deviceName: was.deviceName,
      previousAccountId: was.accountId || was.previousAccountId,
      revokedAt: iso(now()),
      revokedReason: reason ?? "device_revoked",
    })).catch(err => log(`could not write account.json: ${err?.code ?? "error"}`));
    announce();
  }

  /** Stop everything that talks to the API, and keep nothing running. */
  function halt() {
    publisher?.stop();
    publisher = null;
    sync = null;
    feedback = null;
    unregisterShutdown?.();
    unregisterShutdown = null;
    if (lockTimer) clearTimer(lockTimer);
    lockTimer = null;
  }

  async function rotate() {
    const client = clientFor(record.apiBase);
    const res = await client.post("/v1/device/token/rotate", undefined, { token });
    if (res.status === 401 && FINAL_401.has(res.error)) return ended(res.error);
    const next = res.ok ? res.body?.accessToken : null;
    if (typeof next !== "string" || !DEVICE_TOKEN.test(next)) return;
    // Persisted BEFORE it is used. Both tokens stay valid until the first
    // request made with the new one, so a write that fails here costs nothing:
    // the old token goes on working and the next rotation request tries again.
    setRedactions([token, next]);
    let kept;
    try {
      kept = await tokens.save(next);
      await persist(r => ({ ...r, tokenStorage: kept.tokenStorage, token: kept.token ?? "", tokenCipher: kept.tokenCipher ?? "" }));
    } catch {
      setRedactions([token]);
      return;
    }
    setToken(next);
  }

  /** The device is connected and its token is in hand: start talking. */
  function begin() {
    tokenProblem = null;
    const client = clientFor(record.apiBase);
    sync = createSync({
      client,
      token: () => token,
      state: normaliseSync(record.sync) ?? initialSync({ accountId: record.accountId, previousAccountId: record.previousAccountId, settings: null }),
      persist: st => persist(r => ({ ...r, sync: st })),
      onChange: announce,
      onUnauthorized: reason => { void ended(reason); },
      now,
    });
    publisher = createStatusPublisher({
      client,
      token: () => token,
      rotate,
      reading,
      counts: at => counts.reading(at),
      binding: () => sync?.binding() ?? null,
      deck: facts,
      onControl: settings => sync?.onControl(settings),
      onFeedback: noteFeedback,
      onRevoked: reason => { void ended(reason); },
      onChange: announce,
      now,
      random,
      setTimer,
      clearTimer,
      log,
    });
    publisher.start();
    unregisterShutdown = registerShutdown(() => publisher?.sendStopping());
    announce();
  }

  /** Read the token for a device account.json names; retry a locked keychain. */
  async function unlock() {
    if (!record.deviceId) return;
    const got = await tokens.load(record);
    if (got.ok) {
      setToken(got.token);
      begin();
      void sync?.pull().catch(() => {});
      return;
    }
    tokenProblem = got.reason === "locked" ? "keychain-locked" : "token-missing";
    if (tokenProblem === "keychain-locked") {
      lockTimer = setTimer(() => { lockTimer = null; void unlock(); }, LOCKED_RETRY_MS);
    }
    announce();
  }

  async function start() {
    if (started) return;
    started = true;
    // The counts first and in one turn: the tap and the ring's snapshot are
    // taken together, so no event is missed between them or counted twice.
    connectTap((raw, at) => counts.note(raw, at));
    counts.seed(ring());
    counts.markReady();
    record = await loadAccount(home);
    await unlock();
  }

  /** The token is here: keep it, write account.json, and start. */
  /** The code each flow was handed, kept past the approval that clears it:
   *  the approval page's origin is where this device's console page is. */
  const codes = new WeakMap();
  const codeOf = f => codes.get(f) ?? null;

  async function approved(tok, name, apiBase, code) {
    const appBase = (() => {
      try { return new URL(code?.verificationUri ?? "").origin; } catch { return ""; }
    })();
    const kept = await tokens.save(tok.accessToken);
    const previousAccountId = record.previousAccountId || record.accountId || "";
    halt();
    // Written first, and only then made this deck's record: from the moment
    // /api/account answers "connected" the sync and the publisher are running,
    // so a page that reports its settings at once is never told the deck is
    // not connected.
    const next = normaliseAccount({
      ...emptyAccount(),
      apiBase,
      appBase,
      accountId: tok.account.id,
      email: tok.account.email,
      deviceId: tok.deviceId,
      deviceName: cleanDeviceName(tok.name, name),
      connectedAt: iso(now()),
      tokenStorage: kept.tokenStorage,
      token: kept.token ?? "",
      tokenCipher: kept.tokenCipher ?? "",
      previousAccountId,
      sync: initialSync({ accountId: tok.account.id, previousAccountId, settings: tok.settings }),
    });
    await saveAccount(next, home);
    record = next;
    setToken(tok.accessToken);
    begin();
    await sync?.pull().catch(() => {});
  }

  /**
   * One feedback call, made with this deck's token, and its answer as the
   * local routes give it (design 4.4): `{ ok: true, status, body }` with the
   * API's body, or `{ ok: false, reason, … }`. A final 401 ends the device, as
   * a frame's does; a device that ended while the call was out is `revoked`.
   */
  async function feedbackCall(run) {
    const device = record.deviceId;
    if (!device || !token) return { ok: false, reason: "not_connected" };
    const res = await run(clientFor(record.apiBase), token);
    if (res.status === 401 && FINAL_401.has(res.error)) {
      if (record.deviceId === device) await ended(res.error);
      return { ok: false, reason: "revoked" };
    }
    if (record.deviceId !== device) return { ok: false, reason: "revoked" };
    if (res.ok) {
      const body = res.body;
      return body && typeof body === "object" && !Array.isArray(body) ? { ok: true, status: res.status, body } : { ok: false, reason: "unavailable" };
    }
    if (res.status === 400) return { ok: false, reason: "invalid", errors: fieldErrors(res.body) };
    if (res.status === 404 && res.error === "thread_not_found") return { ok: false, reason: "not_found" };
    if (res.status === 413) return { ok: false, reason: "too_large" };
    if (res.status === 429) {
      const out = { ok: false, reason: "too_many" };
      const limited = FEEDBACK_LIMITS.has(res.error);
      if (limited && Number.isInteger(res.body?.limit)) out.limit = res.body.limit;
      if (limited && Number.isInteger(res.body?.retryAfterSec)) out.retryAfterSec = res.body.retryAfterSec;
      else if (res.retryAfterMs) out.retryAfterSec = Math.ceil(res.retryAfterMs / 1000);
      return out;
    }
    // A network failure, a 5xx, the API with accounts switched off (any other
    // 404), a 401 a proxy wrote: nothing the person can put right but wait.
    return { ok: false, reason: "unavailable" };
  }

  return {
    start,
    view,
    /** Start connecting under `name` (cleaned; the suggestion when empty).
     *  Answers once the API has handed out a code or refused; the approval
     *  arrives later, as an `event: account`. */
    async connect(name) {
      if (record.deviceId && tokenProblem !== "token-missing") return view();
      const apiBase = accountApiBase(env, log);
      const clean = cleanDeviceName(typeof name === "string" ? name : "", "") || suggestedName();
      flow?.cancel();
      // A device that lost its token connects again as a new device.
      if (record.deviceId) {
        halt();
        record = { ...emptyAccount(), previousAccountId: record.accountId || record.previousAccountId };
        tokenProblem = null;
      }
      const current = createConnectFlow({
        client: clientFor(apiBase),
        facts,
        onApproved: tok => approved(tok, clean, apiBase, codeOf(current)),
        onChange: announce,
        now,
        setTimer,
        clearTimer,
      });
      flow = current;
      await current.start(clean);
      codes.set(current, current.state().connect);
      return view();
    },
    async cancelConnect() {
      flow?.cancel();
      return view();
    },
    async disconnect() {
      flow?.cancel();
      if (!record.deviceId) return view();
      const was = record;
      const client = clientFor(was.apiBase);
      // Tell the API first, while the token still works: the console then
      // shows the machine gone at once. Best effort — offline, the grant stays
      // until somebody removes it there or it expires unused.
      if (token) await client.del("/v1/device", { token, timeout: 3_000 }).catch(() => null);
      halt();
      await tokens.remove(was).catch(() => {});
      setToken(null);
      tokenProblem = null;
      await persist(() => ({
        ...emptyAccount(),
        deviceName: was.deviceName,
        previousAccountId: was.accountId || was.previousAccountId,
      })).catch(err => log(`could not write account.json: ${err?.code ?? "error"}`));
      announce();
      return view();
    },
    async reportUi(body) {
      if (!sync) return null;
      await sync.reportUi(body?.values, body?.reason === "initial" ? "initial" : "user");
      return sync.view();
    },
    async applied(body) {
      if (!sync) return null;
      await sync.applied(body?.revision, body?.skipped);
      return sync.view();
    },
    async preview() {
      return sync ? sync.preview() : null;
    },
    async setMode(body) {
      if (!sync) return null;
      const out = await sync.setMode(body);
      return { ...out, sync: sync?.view() ?? null };
    },
    async resolve(body) {
      if (!sync) return null;
      await sync.resolve(body?.action);
      return sync.view();
    },
    async upload(body) {
      if (!sync) return null;
      if (body?.upload !== true) return sync.view();
      await sync.upload(body?.values);
      return sync.view();
    },
    /** The account's conversations, latest activity first; `before` is the
     *  list's own cursor. */
    feedbackThreads({ before } = {}) {
      const query = before ? `&before=${encodeURIComponent(before)}` : "";
      return feedbackCall((client, tok) => client.get(`${THREADS}?limit=50${query}`, { token: tok, maxBody: FEEDBACK_READ_MAX }));
    },
    /** One conversation's latest page, or the page before item `before`. */
    feedbackThread(id, { before } = {}) {
      const query = Number.isInteger(before) ? `?before=${before}` : "";
      return feedbackCall((client, tok) => client.get(`${threadPath(id)}${query}`, { token: tok, maxBody: FEEDBACK_READ_MAX }));
    },
    /** A new conversation: the dialog's kind, title and message, this deck's
     *  version and system, and the images as feedback-form.mjs read them —
     *  JSON without images, the form with them. Never a contact, never the
     *  reports' fingerprint. */
    feedbackCreate({ fields = {}, images = [] } = {}) {
      const kept = { kind: fields.kind, title: fields.title, body: fields.body };
      const deck = { appVersion: facts.version, platform: `${facts.os}-${facts.arch}` };
      return feedbackCall((client, tok) => (images.length > 0
        ? client.postForm(THREADS, upstreamForm({ fields: kept, images }, deck), { token: tok })
        : client.post(THREADS, { ...kept, ...deck }, { token: tok })));
    },
    feedbackReply(id, body) {
      return feedbackCall((client, tok) => client.post(`${threadPath(id)}/replies`, { body }, { token: tok }));
    },
    /** Everything up to `seq` seen; the answer is the account's summary after
     *  it, which clears the dot at once rather than at the next frame. */
    async feedbackRead(id, seq) {
      const out = await feedbackCall((client, tok) => client.post(`${threadPath(id)}/read`, { seq }, { token: tok }));
      if (out.ok) noteFeedback(out.body);
      return out;
    },
    noteFeedback,
    /** For the suite and the shutdown path. */
    publisher: () => publisher,
    sync: () => sync,
    counts,
    stop() {
      flow?.cancel();
      halt();
      for (const c of clients.values()) c.close();
      clients.clear();
      connectTap(null);
    },
  };
}
