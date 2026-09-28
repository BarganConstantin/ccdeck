// This deck's LAN sync: the one engine, built at import and told the settings;
// what prefs is and is not entitled to tell it; and the probe that asks whether
// other decks can reach this one.
//
// These lived in src/server/index.mjs, between the presence route and the LAN
// routes, and they could not leave while the settings they read were a `let`
// in that file that six of the engine's callbacks wrote back. prefs-state.mjs
// holds those settings now, so the callbacks write through it from here. The
// reach probe came with the engine because the two lean on each other: onPort
// forgets the verdict, and the verdict is measured off lanEngine.status().
//
// Still built at import, and at the same moment: index.mjs imports this
// statically, and neither the engine nor the tailnet reader opens anything
// until applyLanPrefs says so — which startServer does only from a listen that
// succeeded. The panel's routes, in lan-routes.mjs, drive the engine from
// here; the settings route and startServer, in index.mjs, import applyLanPrefs,
// forgetReach and resetLanLoaded.
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { PRODUCT } from "./brand.mjs";
import { lanEnabled, withManualEntry, withShared } from "./deck-prefs.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { createEngine, defaultName } from "./lan-engine.mjs";
import { createTailnet } from "./tailscale.mjs";
import { portHolder } from "./port-holder.mjs";
import { createRouteCheck } from "./route-via.mjs";
import { DISCOVERY_PORT } from "./lan-socket.mjs";
import { aboutThisDeck } from "./lan-about.mjs";
import { MAC_FW, PROBE_PS, UFW_CONF, UFW_DEFAULTS, isActive, localAliases, reachability, readMacProbe, readProbe, readUfw, silentInbound } from "./lan-reach.mjs";
import { run } from "./exec.mjs";
// A LAN round checks the imports it lands the way the paste box does.
import { CHECKS_IMPORTS } from "./account-routes.mjs";
import { RUNNING_VERSION } from "./running-version.mjs";

// ── LAN sync ────────────────────────────────────────────────────────────────
//
// The engine is built once and told the settings; it opens and closes its own
// sockets as those change. Nothing here touches a credential — see
// lan-engine.mjs, which passes an opaque blob between two claude-swap commands.
/** This machine's view of its tailnet, read through the Tailscale CLI — see
 *  tailscale.mjs. Built whatever the switch says: the dialog asks it whether
 *  Tailscale is here at all before anybody can turn discovery on. */
export const tailnet = createTailnet();

const ACTIVE_VERDICT_FIRST_RETRY_MS = 60_000;
const ACTIVE_VERDICT_MAX_RETRY_MS = 30 * 60_000;
const LIVE_LOGIN_TIMEOUT_MS = 5_000;
let activeVerdictRetryMs = ACTIVE_VERDICT_FIRST_RETRY_MS;
let activeVerdictNextAt = 0;
// A claude-swap that never reports a verdict for the active slot would
// otherwise cost a usage collection every minute for as long as LAN is on.
function refreshActiveVerdict() {
  if (Date.now() < activeVerdictNextAt) return;
  activeVerdictNextAt = Date.now() + activeVerdictRetryMs;
  activeVerdictRetryMs = Math.min(activeVerdictRetryMs * 2, ACTIVE_VERDICT_MAX_RETRY_MS);
  void import("./claude-accounts.mjs")
    .then(({ verdictsNow, invalidateClaudeAccountsCache }) =>
      verdictsNow().then(got => { if (got) invalidateClaudeAccountsCache(); }))
    .catch(() => {});
}
function activeVerdictArrived() {
  activeVerdictRetryMs = ACTIVE_VERDICT_FIRST_RETRY_MS;
  activeVerdictNextAt = 0;
}

export const lanEngine = createEngine({
  tailnet,
  // Who holds the discovery port when it is taken, so the panel can say.
  portHolder: () => portHolder(DISCOVERY_PORT),
  // Where each broadcast would leave by, so none goes into a VPN tunnel.
  routes: createRouteCheck(),
  // This deck's version and machine, for the decks it is paired with and
  // nobody else. RUNNING_VERSION rather than a fresh read, for the reason it
  // is read at import: it is what this process actually runs.
  about: aboutThisDeck({ version: RUNNING_VERSION }),
  readAccounts: async () => {
    const { fetchClaudeAccounts } = await import("./claude-accounts.mjs");
    const got = await fetchClaudeAccounts();
    // A login this Mac's Keychain will not open from the deck's session. The
    // engine refuses to export it with a fixed code rather than spawning an
    // export that can only fail. Mac only: claude-swap's `keychain_unavailable`
    // elsewhere is an unreadable .enc file, and the sentence the peer prints
    // talks about a Keychain.
    if (!got || !Array.isArray(got.accounts)) return got;
    // The active slot is withheld from peers until it has a fresh verdict — see
    // cachedExportReadable — so ask for one now rather than waiting on the
    // collector's own schedule.
    if (got.accounts.some(a => a.active === true && a.collector == null)) refreshActiveVerdict();
    else activeVerdictArrived();
    const { markUnreadable } = await import("./cswap-admin.mjs");
    return { ...got, accounts: markUnreadable(got.accounts) };
  },
  // Bounded well inside a round, since a want waits on it.
  liveLogin: async () => {
    const { currentIdentity } = await import("./cswap-admin.mjs");
    const late = new Promise(resolve => setTimeout(resolve, LIVE_LOGIN_TIMEOUT_MS, null).unref?.());
    return Promise.race([currentIdentity().catch(() => null), late]);
  },
  exportAccount: async (num, expectedKey) => {
    const { accountKey } = await import("./lan-sync.mjs");
    const { shareAccounts, unwrapShare } = await import("./cswap-admin.mjs");
    // Do not collect live verdicts here. A LAN want has a ten-second round
    // budget, while a verdict collection may wait up to ninety seconds (or
    // queue behind another one). The want handler already re-reads this deck's
    // cached account state immediately before export and refuses known
    // unreadable/dead copies. The share itself is therefore the only bounded
    // operation left on the hot path.
    //
    // Without the explanation, which would outlast the asking peer's patience;
    // see shareAccounts.
    const out = await shareAccounts([String(num)], { explain: false });
    // The blob or nothing. WHY it failed is never carried out of here: the
    // engine decides what a peer is told from this deck's state — see
    // `readable` in readAccounts below.
    if (!out?.ok) return null;
    const opened = unwrapShare(out.blob);
    if (!opened.ok) return null;
    let accounts;
    try { accounts = JSON.parse(opened.payload)?.accounts; } catch { return null; }
    if (!Array.isArray(accounts) || accounts.length !== 1) return null;
    // Slot numbers are local. Verify the payload identity after export so a
    // moved/reused slot can never satisfy a want for another account.
    return accountKey(accounts[0]?.email, accounts[0]?.organizationUuid) === expectedKey ? out.blob : null;
  },
  // The logins a round just imported, checked once after it — see checkImports.
  checkArrivals: async steps => {
    const { checkImports } = await import("./cswap-admin.mjs");
    return checkImports(steps.map(step => {
      const [email, org] = String(step?.key ?? "").split("@@");
      return { email, org: org ?? "" };
    }));
  },
  importAccount: async (blob, step) => {
    const { importAccount, fillEmptySlot, landed } = await import("./cswap-admin.mjs");
    const [want, wantOrg] = String(step?.key ?? "").split("@@");
    // NO `force`, ever, and this is the line where that promise is kept. A
    // plain import adds an account that is missing and replaces exactly one
    // claude-swap has quarantined; it SKIPS one that is present and healthy.
    // So a peer cannot overwrite a working credential of this deck's even by
    // lying about its own, because the flag that would allow it is not passed.
    //
    // NARROWED TO THE ONE ACCOUNT ASKED FOR, for the same reason the forced
    // import below is, and this line did not have it. The seal's AAD is
    // `${peerFp}->${identity.fp}|${step.key}` — it binds the ENVELOPE to the
    // key that was requested and says nothing about the contents, and a share
    // payload is `{ accounts: [...] }`, a bundle rather than one credential.
    // So a peer asked for A could seal, under A's AAD, a bundle carrying A
    // plus B, C and D it never listed in its manifest, and every one of them
    // landed: `syncAction` answers "add" for anything this deck lacks, and an
    // add does not need the owner's tick. The panel drew A and the store
    // gained four. `only` narrows without implying `force` — `overwrite` is
    // `force === true && narrowing` — so the promise above survives word for
    // word, and a bundle that does not carry what was asked for is refused
    // rather than unpacked.
    const out = await importAccount(blob, { only: { email: want, org: wantOrg ?? "" }, collect: !CHECKS_IMPORTS });
    if (!out?.ok) return { ok: false, why: out?.reason ?? "import refused" };
    // A SKIP IS NOT A HEAL, and reading `ok` alone said it was. `cswap import`
    // exits ZERO when it declines an account it already holds, so a round that
    // changed nothing was counted as a successful repair and the panel said the
    // account had been fixed. Whoever read that then waited for numbers that
    // were never going to move.
    //
    // `landed`, NOT `added`: `added` counts new slots only, and a plain import
    // that replaces a quarantined slot is `healed` — the one repair this path
    // exists for. Reading `added` reported every such heal as a failure and
    // then sent it on to fillEmptySlot, which declined it. A slot that stayed
    // `present` is the decline.
    //
    // The decline is narrow and documented on claude-swap's side: a plain
    // import replaces a slot only when its usage row is quarantined as
    // refresh-token-dead, and is "never triggered by the live store's
    // `no credentials` state". So an account whose login expired heals over the
    // network, and one that has NO stored login does not — which is a true
    // sentence the panel can now print instead of a false one.
    if (landed(out.results)) return { ok: true };

    // THE DECLINE, AND WHY IT MATTERS WHICH ONE IT IS.
    //
    // `cswap import` without --force declines for two opposite reasons and says
    // the same thing about both: the slot is present and HEALTHY, which is the
    // promise above working exactly as intended — or the slot is EMPTY, which
    // is the one case pairing exists for and the one a plain import will never
    // touch. claude-swap is explicit about the second: a plain import replaces
    // a slot "iff its usage row is quarantined as refresh-token-dead", and is
    // "never triggered by the live store's `no credentials` state".
    //
    // So `login expired` healed over the network and `no stored login` did not,
    // and the account somebody most needed repaired was the one the feature
    // could not repair.
    //
    // FILLING AN EMPTY SLOT, WHICH IS NOT OVERWRITING A WORKING ONE — and the
    // promise above survives word for word. A peer cannot reach it: the verdict
    // comes from THIS machine's claude-swap, about THIS machine's store, and
    // nothing a peer sends can make a slot report that it holds nothing.
    //
    // THE VERDICT AND THE WRITE ARE ONE CRITICAL SECTION, which is why this is
    // one call and not the pair it used to be (#1040).
    //
    // The verdict was already being asked for fresh rather than read from the
    // ten-minute cache, under a comment naming the exact reason: "somebody who
    // signed in two minutes ago still reads as `no_credentials` there, and
    // acting on that would replace the login they had just created". That
    // sentence is kept, and the read that served it moved rather than went —
    // see fillEmptySlot, which opens with it.
    //
    // Freshness alone only SHORTENED the window. The asking happened out here
    // while the writing took the store mutex inside importAccount, so the two
    // were never one critical section: `registerSignedIn` holds that mutex for
    // `cswap add` (60 s), `cswap list` (60 s) and `restoreActive`'s `cswap
    // switch` (30 s), and a forced import queued behind one still acted on a
    // verdict taken before any of it began. fillEmptySlot re-reads the verdict
    // as its first statement INSIDE the lock, so the promise holds by
    // construction rather than by how long the queue happened to be.
    return fillEmptySlot(blob, { email: want, org: wantOrg ?? "", collect: !CHECKS_IMPORTS });
  },
  // The deck's own long-term key, kept so a restart is the same deck rather
  // than a stranger to everybody who has paired with it. Written once, on the
  // first start that has none. It IS a secret — prefs.json is 0600 for this.
  // The port it actually got, kept so an address typed on the other machine
  // still reaches this deck after it restarts. Written only when it differs
  // from what is stored, so a normal start writes nothing.
  onPort: async port => {
    try { await heldPrefs.write({ lan: { port } }); }
    catch { /* the address field still works this session; next start re-pins */ }
    // The Linux fix lines name this number, so a verdict taken before the
    // listener had one is missing half of them — see forgetReach.
    forgetReach();
  },
  // An account arrived from a paired deck, and this deck now offers it too
  // (#1188). Written before the engine hears it, so a restart between the two
  // leaves the tick on disk rather than only in the running engine's copy.
  onShared: async key => {
    try {
      const before = heldPrefs.current();
      const after = await heldPrefs.update(withShared(key));
      if (after?.lan?.shared === before?.lan?.shared) return;   // it was already ticked
      await lanEngine.apply({ shared: after.lan.shared });
    } catch (err) {
      console.error(`${PRODUCT}: lan sync could not share the account it just received:`, err?.message ?? err);
    }
  },
  // A deck was accepted or unpaired. Written straight through, because the
  // trusted list is the whole of who this deck will talk to and a list that
  // only existed in memory would drop every pairing on restart.
  onTrust: async trusted => {
    try { await heldPrefs.write({ lan: { trusted } }); }
    catch (err) { console.error(`${PRODUCT}: lan sync could not save the pairing:`, err?.message ?? err); }
  },
  // An explicit unpair must outlive the process too. Manual dial rows are kept
  // deliberately, so without this marker the next successful round could pin
  // the same fingerprint again without another press.
  onUnpaired: async unpaired => {
    try { await heldPrefs.write({ lan: { unpaired } }); }
    catch (err) { console.error(`${PRODUCT}: lan sync could not save the unpair decision:`, err?.message ?? err); }
  },
  // An address this deck must keep dialling: the far end of a pairing that
  // happened over an invite. Kept in prefs, because setPeers replaces the dial
  // list wholesale on every settings write and a row that lives only in memory
  // is a pairing that goes one-way at the next restart.
  onDial: async entry => {
    try {
      // COMPUTED INSIDE THE JOB, out of what the write is about to read, rather
      // than out of `heldPrefs.current()` — which is an in-memory copy refreshed
      // only when a previous write resolves, not "the one on disk". `writePrefs`
      // merges field by field and cannot merge two writes of one field: the
      // patch here is the WHOLE array, so a stale one wins. Pressing accept on a
      // heard deck at the moment an invite round fires this dropped the dialled
      // address out of `lan.manual`, which is the failure the comment above
      // describes.
      const next = await heldPrefs.update(withManualEntry(entry));
      // AND RECONCILE THE ENGINE'S DIAL LIST with what was just written. The
      // disk is now right, but `setPeers` replaces the list wholesale from the
      // held prefs on every settings write — so a write that raced this one, and
      // whose copy predates it, would still take the address away.
      lanEngine.setPeers(next.lan.manual);
    } catch { /* dialled this session; the next round re-adds it */ }
  },
  onIdentity: async secret => {
    try {
      await heldPrefs.write({ lan: { secret } });
      // AND PUT IT TO WORK. Writing it alone was not enough: a clash was
      // detected, a new id was stored, and both decks kept broadcasting the old
      // one — so they stayed invisible to each other with a correct file on
      // disk. `apply` restarts only when the id it is holding differs from the
      // one it is given, so this settles after one pass rather than looping.
      //
      // The key is handed over HERE rather than read back off the held prefs,
      // because `applyLanPrefs` no longer round-trips the fields the engine
      // authors — see what it does and does not pass. This is the one caller
      // that legitimately changes one of them, and it is holding the new value.
      await applyLanPrefs({ secret });
    } catch { /* the next start picks it up; a shared id is the cost until then */ }
  },
  onError: (what, err) => {
    // Reported, never thrown. A machine with no route, a firewall that refuses
    // the bind, an interface that comes and goes with a VPN — none of them is a
    // reason for the deck to fall over.
    if (what !== "other-group") console.error(`${PRODUCT}: lan sync (${what}):`, err?.message ?? err);
  },
});

/**
 * What prefs is entitled to tell the LAN engine, and what it is not.
 *
 * FOUR FIELDS ARE THE ENGINE'S OWN AND ARE LOADED ONCE. `trusted`, `unpaired`,
 * `secret` and `port` are written BY the engine, through `onTrust`,
 * `onUnpaired`, `onIdentity` and `onPort` — prefs is where they are kept between runs, not where they are
 * decided. Handing them back on every settings write round-trips the engine's
 * live state through a module-level copy of a file, and that copy is stale for
 * as long as one of those writes is queued.
 *
 * WHAT THAT COST, reproduced with two real engines and a real handshake: press
 * accept on deck B, and `lanEngine.accept` adds it to `cfg.trusted`
 * synchronously and queues `onTrust`. In the same second another tab flips
 * notifications; that handler's `writePrefs` is queued BEHIND `onTrust`'s, but
 * its `applyLanPrefs` runs on the prefs that write kept — merged from a disk read
 * taken before `onTrust` wrote. `apply` does `cfg = { ...cfg, ...next }`, so the
 * whole array is replaced:
 *
 *     B trusted after accept                : old-deck-fp, 6ef-127-19e-79e
 *     B trusted after a plain settings write: old-deck-fp
 *
 * `GET /api/lan` reads `lanEngine.status()`, so the panel then shows B unpaired
 * while prefs.json says paired, and B's calls are refused. The next `onTrust`
 * from any source writes `cfg.trusted` back to disk without B, making it
 * permanent.
 *
 * So `load` is true exactly once per boot, where reading them off the file IS
 * the right answer, and false thereafter. The one caller that legitimately
 * changes one of them afterwards passes it in directly — see `onIdentity`.
 *
 * Exported because it is the rule rather than the plumbing, and the plumbing
 * around it is a module-level engine no test can reach.
 */
export function lanApplyFields(prefs, { load = false, env = process.env } = {}) {
  const lan = prefs?.lan ?? {};
  const page = {
    // The file's answer unless the machine said no: AGENTS_DECK_NO_LAN=1 is
    // how a launch script — or this repo's own test suite — keeps a deck off
    // the network now that the default is on.
    enabled: lanEnabled(prefs, env),
    name: lan.name || defaultName(),
    shared: Array.isArray(lan.shared) ? lan.shared : [],
    autoAsk: lan.autoAsk !== false,
    autoAccept: lan.autoAccept !== false,
    pairingMode: lan.pairingMode === "invite" ? "invite" : "automatic",
    // Whether paired decks are told which shared account this one is on.
    shareActive: lan.shareActive !== false,
    // Discovery over Tailscale, off unless somebody turned it on, and the two
    // permissions that answer for the owner's own machines there.
    tailscale: lan.tailscale === true,
    tailscaleAsk: lan.tailscaleAsk !== false,
    tailscaleAccept: lan.tailscaleAccept !== false,
    // Names somebody here gave other decks. The engine only hands them to
    // the page, so a change never restarts anything.
    aliases: lan.aliases && typeof lan.aliases === "object" ? lan.aliases : {},
  };
  if (!load) return page;
  return {
    ...page,
    secret: lan.secret || "",
    trusted: Array.isArray(lan.trusted) ? lan.trusted : [],
    unpaired: Array.isArray(lan.unpaired) ? lan.unpaired : [],
    port: lan.port || 0,
  };
}

/** Whether the engine has already been handed the fields it authors.
 *  Reset by `startServer`, through resetLanLoaded, because a boot is what
 *  reads them off the file. */
let _lanLoaded = false;

/** The next applyLanPrefs hands the engine the fields it authors, off the file
 *  — which is what a boot is. startServer's call, and nobody else's. */
export function resetLanLoaded() { _lanLoaded = false; }

/** Push whatever is in prefs at the engine. Called at boot and after every
 *  write, so there is one source of truth and it is the file — for the fields
 *  the file is the source of truth FOR. See `lanApplyFields`.
 *
 *  `also` is for a caller holding a value the engine itself just produced and
 *  that has to take effect now; nothing else may name one of the three. */
export async function applyLanPrefs(also = null) {
  const prefs = heldPrefs.current();
  const lan = prefs?.lan ?? {};
  const load = !_lanLoaded;
  _lanLoaded = true;
  try {
    await lanEngine.apply({ ...lanApplyFields(prefs, { load }), ...(also ?? {}) });
    // Wholesale, so removing an address in the panel really stops it being
    // dialled rather than only taking the row away.
    lanEngine.setPeers(lan.manual);
  } catch (err) {
    console.error(`${PRODUCT}: lan sync could not start:`, err?.message ?? err);
  }
}

// ── can other decks reach this one ──────────────────────────────────────────
//
// NEVER IN THE REQUEST. The panel polls `GET /api/lan`, and the probe is a
// PowerShell start-up — the better part of a second on a warm machine and
// worse on a cold one. So the route answers with whatever the last probe said
// and starts the next one behind it. The first poll after a deck starts
// carries no verdict, which is correct rather than merely tolerable: at that
// point the deck has not been listening long enough for an empty list to mean
// anything either.
//
// STALE IS THE RIGHT DEFAULT HERE. What this measures — a network's category, a
// firewall rule — changes when somebody changes it, which is a thing they do
// while looking at the instructions this produced. Five minutes is far tighter
// than that, and the panel's own reload picks up the change on the next poll.
let reachSaid = null;
let reachAt = 0;
let reachBusy = false;
const REACH_MS = 5 * 60_000;

/**
 * What Linux can be asked without root: whether a firewall is running, and what
 * it does with an inbound packet no rule matched.
 *
 * Three reads, none of them privileged. `systemctl is-active` answers anybody;
 * both ufw files are 0644. The rules themselves are root-only on every one of
 * these tools, which is why the verdict leans on the measurement instead — see
 * the linux block in lan-reach.mjs.
 */
async function probeLinux() {
  const [conf, defaults, ufwUnit, fwUnit] = await Promise.all([
    readFile(UFW_CONF, "utf8").catch(() => null),
    readFile(UFW_DEFAULTS, "utf8").catch(() => null),
    run("systemctl", ["is-active", "ufw"], { timeout: 5_000 }).catch(() => null),
    run("systemctl", ["is-active", "firewalld"], { timeout: 5_000 }).catch(() => null),
  ]);
  const ufw = readUfw(conf, defaults);
  return {
    // ON means both: the config says yes and the unit is running. A machine
    // where somebody ran `ufw disable` keeps ENABLED=no in the file, and one
    // where the unit was masked keeps ENABLED=yes in it — neither is blocking
    // anything, and claiming otherwise sends a person to fix what is not broken.
    ufw: { ...ufw, enabled: ufw.enabled && isActive(ufwUnit?.stdout) },
    firewalld: isActive(fwUnit?.stdout),
    syncPort: lanEngine.status().port,
  };
}

/**
 * Forget what the last probe said, so the next poll measures rather than
 * answering out of the five-minute cache.
 *
 * TWO MOMENTS EARN IT, and both are moments where the held answer is about a
 * machine in a different state from the one being asked about.
 *
 * A SWITCH-ON is the one somebody is watching. The panel starts polling every
 * five seconds the instant it goes on, and without this the first several
 * minutes of that are a verdict taken while the sockets were down — which is
 * the exact question they turned it on to have answered. Five minutes is the
 * right staleness for a firewall nobody is touching and the wrong one for the
 * press that starts the feature.
 *
 * THE SYNC PORT LANDING changes what the answer CONTAINS on Linux: the fix
 * lines name a TCP port (see linuxFixSteps), and a verdict taken before the
 * listener had one offers the discovery line alone — half an answer, pinned for
 * five minutes, on the machine that most needs the other half.
 */
export function forgetReach() { reachAt = 0; }

/**
 * What the macOS application firewall says about this deck.
 *
 * Three reads, none of them privileged — measured on macOS 26.6, where all of
 * them answer an ordinary user with exit 0 and no password. See the macos block
 * in lan-reach.mjs for why this platform can be asked the exact question about
 * its own binary while Linux has to reason from a default policy.
 *
 * A call that fails comes back as an empty string rather than as a throw, which
 * readMacProbe turns into a null field and macReach turns into silence: a Mac
 * that will not answer is a Mac this says nothing about.
 */
async function probeMac() {
  const ask = args => run(MAC_FW, args, { timeout: 5_000 }).then(r => (r?.ok ? r.stdout : "")).catch(() => "");
  const [globalState, blockAll, app] = await Promise.all([
    ask(["--getglobalstate"]),
    ask(["--getblockall"]),
    // The binary the LISTENER runs as, which is this process's own executable —
    // the application firewall's rules are about a program, never about a port.
    ask(["--getappblocked", process.execPath]),
  ]);
  return readMacProbe({ global: globalState, blockAll, app });
}

/** How recently a beacon has to have arrived to count as a machine this deck
 *  can hear. Three announce intervals, which is the same window the panel calls
 *  `now` — one dropped broadcast must not retract the claim. */
const HEARD_MS = 90_000;

/**
 * The verdict for a machine no probe could speak about — see silentInbound.
 *
 * BOTH LISTS ARE COUNTED. `strangers` is already one row per machine, and a
 * deck LEAVES it for `peers` the moment somebody pairs with it — so counting
 * strangers alone would make a deck that has paired with everything it can hear
 * look like a deck that hears nobody, which is the one state this must not
 * confuse with being blocked.
 */
function measuredReach() {
  const st = lanEngine.status();
  const at = Date.now();
  const fresh = p => typeof p?.lastSeen === "number" && at - p.lastSeen < HEARD_MS;
  const heard = (st.strangers?.length ?? 0) + (st.peers ?? []).filter(fresh).length;
  return silentInbound({ heard, listeningSince: st.listeningSince, inbound: st.inboundAt, now: at });
}

export function refreshReach() {
  if (reachBusy) return;
  if (reachAt && Date.now() - reachAt < REACH_MS) return;
  reachBusy = true;
  if (process.platform === "linux") {
    probeLinux().then(linux => {
      // A read of the real configuration beats an inference from silence, so
      // the measurement only speaks where the probe had no opinion at all.
      reachSaid = reachability({ platform: "linux", linux, inbound: lanEngine.status().inboundAt })
        ?? measuredReach();
    }).catch(() => {
      reachSaid = measuredReach();
    }).finally(() => {
      reachAt = Date.now();
      reachBusy = false;
    });
    return;
  }
  if (process.platform === "darwin") {
    probeMac().then(mac => {
      reachSaid = reachability({
        platform: "darwin",
        mac,
        // The same path the probe asked about, so the lines somebody pastes name
        // the binary the verdict was taken on.
        exePath: process.execPath,
        inbound: lanEngine.status().inboundAt,
      }) ?? measuredReach();
    }).catch(() => {
      reachSaid = measuredReach();
    }).finally(() => {
      reachAt = Date.now();
      reachBusy = false;
    });
    return;
  }
  // EVERY OTHER PLATFORM, which used to return before reaching any of this and
  // therefore said nothing forever. FreeBSD, an unrecognised Linux, anything
  // node runs on: no probe to run, and the measurement needs none.
  if (process.platform !== "win32") {
    reachSaid = measuredReach();
    reachAt = Date.now();
    reachBusy = false;
    return;
  }
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROBE_PS], {
    // The program path goes through the environment rather than into the
    // script, so a path with a quote in it cannot close the string it sits in.
    env: { ...process.env, CCDECK_EXE: process.execPath },
    timeout: 25_000,
  }).then(r => {
    reachSaid = reachability({
      platform: process.platform,
      probe: r?.ok ? readProbe(r.stdout) : null,
      aliases: localAliases(networkInterfaces()),
      exePath: process.execPath,
      inbound: lanEngine.status().inboundAt,
    }) ?? measuredReach();
  }).catch(() => {
    // A probe that did not run is exactly the machine silentInbound was written
    // for: nothing can be asked, so what is left is what was measured. It is
    // never an error the panel shows — nobody asked for it.
    reachSaid = measuredReach();
  }).finally(() => {
    reachAt = Date.now();
    reachBusy = false;
  });
}

/** What the last probe said, for the route to answer with: null until one has
 *  finished. Read, never waited on — see the top of this section. */
export function lastReach() { return reachSaid; }
