// The thing that actually heals an account: the beacon, the listener and
// claude-swap, wired together.
//
// The files under this one hold everything that can be reasoned about without
// a network — lan-sync.mjs and lan-invite.mjs decide, lan-beacon.mjs and
// lan-socket.mjs carry — and what is left here is the part that has to touch
// the store. The engine's own state lives beside it, each piece behind named
// operations createEngine calls: the decks waiting on somebody here and when a
// switch answers them (lan-requests.mjs), the addresses it dials and what
// answered at each (lan-dials.mjs), what a manifest says and what is kept of
// one heard (lan-manifest.mjs), the store's rows in the rules' shape
// (lan-accounts.mjs), the line every round waits in (lan-turns.mjs), the
// clock that asks for the next one (lan-round-timer.mjs) and what the last one
// did (lan-round-record.mjs), who has called this deck (lan-inbound.mjs), the
// invite on offer (lan-invite-offer.mjs), when the tailnet is read
// (lan-tailnet-poll.mjs), and what a deck that cannot hear says
// (lan-hearing.mjs). What it answers a paired deck that asks lives in
// lan-serve.mjs; the asking — a round, and joining on an invite — is here.
//
// WHAT ONE ROUND LOOKS LIKE, from a deck whose copy of an account has died:
//
//   1. it hears a beacon from a deck somebody here has accepted
//   2. it dials that deck's sync port and each side proves the key the other
//      pinned for it
//   3. it asks for a manifest: which accounts, and does each one work THERE
//   4. `plan()` says "heal a@@1" — mine is quarantined, theirs is alive
//   5. it asks for that one account, with a fresh proof naming it
//   6. the peer runs `cswap export - --account N`, seals it, sends it
//   7. it opens the envelope and runs `cswap import -`
//
// Steps 6 and 7 are the only ones that touch a credential, and neither of them
// reads one: claude-swap does the reading and the writing, this passes an
// opaque blob between two of its commands. That is the same division the manual
// share already uses, which is why this needed no new credential handling at
// all.
//
// NOTHING HAPPENS ON A SCHEDULE THAT MOVES A CREDENTIAL. The manifest round is
// periodic and carries no credential; the transfer happens when a plan has
// something in it, which is when an account is actually broken. A deck whose
// accounts all work talks to its peers every minute and never asks for
// anything.
import {
  addTrusted, ANNOUNCE_MS, credentialAad, dropTrusted, identityFrom, open, peerWhy, plan, PRESENT_MS,
  stillListed, transferChallenge, trustedPeer,
} from "./lan-sync.mjs";
import { mintInvite, readInvite } from "./lan-invite.mjs";
import { createInviteOffer } from "./lan-invite-offer.mjs";
import { syncAccounts } from "./lan-accounts.mjs";
import { createBeacon } from "./lan-beacon.mjs";
import { connectToPeer, createSyncServer, MAX_FRAME_BYTES } from "./lan-socket.mjs";
import { createTurns } from "./lan-turns.mjs";
import { ASKING_MS, createRoundTimer, SYNC_MS } from "./lan-round-timer.mjs";
import { createRoundRecord } from "./lan-round-record.mjs";
import { beaconTargets, routeOf, IDLE_MS as TAILNET_IDLE_MS } from "./tailscale.mjs";
import { createTailnetPoll } from "./lan-tailnet-poll.mjs";
import { createHearing } from "./lan-hearing.mjs";
import { anotherMachine, createInbound } from "./lan-inbound.mjs";
import { createServe } from "./lan-serve.mjs";
import { createDials, MAX_AUTO_PEERS } from "./lan-dials.mjs";
import { createManifests } from "./lan-manifest.mjs";
import { asksOn, createRequests, saysYesOn } from "./lan-requests.mjs";
import { randomBytes } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";

/** How often a deck asks its peers what they have, and how soon it asks again
 *  while somebody is deciding — see lan-round-timer.mjs, which keeps the
 *  clock that picks between them. */
export { ASKING_MS, SYNC_MS };

/** How long to wait before trying the discovery port again while another
 *  program holds it. The beacon's own interval: a port that frees up is picked
 *  up about when the next beacon would have gone out anyway. */
export const BIND_RETRY_MS = 30_000;

/** How long one peer round may take before it is abandoned. A manifest is one
 *  round trip on a local network; anything past this is a peer that is not
 *  going to answer, and holding the attempt open would stall the next round. */
const ROUND_MS = 10_000;

/** The most addresses `autoAsk` may put on the dial list on its own — see
 *  lan-dials.mjs, which keeps the list and the cap. */
export { MAX_AUTO_PEERS };

/**
 * The most pairings the accept switch may make on its own (#1737).
 *
 * It had no limit, and a pin is a line in prefs.json and a deck every round
 * dials: one host handshaking with a fresh key each time made sixty of them in
 * well under a second. Only pins a SWITCH made count (`auto`, see addTrusted);
 * a person's accepts are theirs, as a person's typed addresses are.
 *
 * THE SAME NUMBER AS MAX_AUTO_PEERS, because every pin the switch makes brings
 * a dial-back row out of that budget, so a pin past it is a deck this one
 * mostly could not dial back anyway. Thirty-two machines is also well past one
 * person's own fleet, which is who the switch is for.
 */
export const MAX_AUTO_PINS = MAX_AUTO_PEERS;

/** What this machine calls itself when the user has not said. The hostname,
 *  because that is the word they already use for this machine everywhere else. */
export function defaultName() {
  return hostname().replace(/\.local$/i, "") || "this machine";
}

/**
 * EVERY address another deck might dial, for the panel to print.
 *
 * It returned the first one, and that was wrong the first time somebody
 * checked: on this machine the first is 192.168.1.82 and the deck it needs to
 * reach is on Tailscale at 100.67.32.58, so the panel would have offered an
 * address that peer cannot route to and left them to work out why.
 *
 * WHICH ONE IS RIGHT DEPENDS ON WHERE THE PEER IS, which this side cannot
 * answer — a VPN, a second NIC, a container bridge, all real and all at once.
 * So it offers them all and the person picks: they are the only one who knows
 * how the other machine sees this one, and a list of two is a smaller ask than
 * a wrong answer.
 *
 * `internal` is node's word for loopback, and a link-local 169.254 address is a
 * machine whose DHCP failed — reachable by nobody worth telling about.
 */
export function localAddresses(faces = networkInterfaces()) {
  const out = [];
  for (const list of Object.values(faces ?? {})) {
    for (const n of list ?? []) {
      if (n.internal) continue;
      if (n.family !== "IPv4" && n.family !== 4) continue;
      if (typeof n.address !== "string" || n.address.startsWith("169.254.")) continue;
      if (!out.includes(n.address)) out.push(n.address);
    }
  }
  return out;
}

/** Did this connection come from a different computer — see lan-inbound.mjs,
 *  where the record it decides is kept. */
export { anotherMachine };

/**
 * Whether an account this round just placed is ticked for sharing here (#1188).
 *
 * ONLY AN ADD: a healed slot was already here, so whether it is ticked is
 * already somebody's decision — ticked, there is nothing to add; unticked,
 * possibly on purpose, and an account healed after somebody unticked it must
 * not be ticked again behind them.
 *
 * ONLY FROM THE LOCAL NETWORK: the reasoning for the default is that the login
 * came from the group and the group therefore has it, and a tailnet can reach
 * further than one person's own machines. Sharing there stays a decision
 * somebody makes rather than one an arrival makes for them.
 *
 * AND ONLY FROM A DECK SOMEBODY HERE CHOSE. "The group has it" is true of a
 * group a person put together; a deck the accept switch paired (`pin.auto`,
 * see addTrusted) is one nobody here chose, and what arrives from it is not
 * passed on in this deck's name.
 */
export function ticksOnArrival(step, via, pin = null) {
  return !!step?.key && step.action === "add" && via !== "tailscale" && pin?.auto !== true;
}

/** The two permissions that answer for one route — see lan-requests.mjs,
 *  where the requests they answer are kept. */
export { asksOn, saysYesOn };

/**
 * One question to a deck over a connection connectToPeer opened, and the one
 * frame that answers it: read off the socket, opened through the connection's
 * own reader, and refused as a sentence when the socket closes, fails, runs
 * past the frame cap or goes quiet for ROUND_MS.
 */
function askOver(conn, frame) {
  // A SECOND READER ON THE SAME SOCKET, AND IT HAS TO KEEP THE SAME CAP.
  //
  // lan-lines.mjs states the rule, on frameReader and MAX_FRAME_BYTES: "a
  // peer that sends a megabyte with no newline in it is not sending a large
  // frame, it is sending nothing at all, expensively... the buffer is
  // ABANDONED rather than grown past it." frameReader enforces it; this
  // reader did not.
  //
  // The frameReader connectToPeer installed IS still attached and does hit
  // MAX_FRAME_BYTES — but it only sets its own flag and calls `fail`, which
  // short-circuits on `settled`, so nothing destroys the socket. This
  // buffer then grew unbounded for the full ROUND_MS at line rate. The
  // reject path also never removed the listener; only roundWith's
  // `finally { conn?.sock?.destroy(); }` stopped it.
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const give = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(bell);
      conn.sock.off("data", onData);
      conn.sock.off("close", onClose);
      conn.sock.off("error", onError);
      fn(arg);
    };
    const onClose = () => give(reject, new Error("peer closed the connection"));
    // The errno rides along in the sentence, because faultText reads it
    // there: ECONNRESET is "it hung up" on the row, and a bare "peer
    // connection failed" was the one fault the panel could only repeat.
    const onError = err => give(reject, new Error(`peer connection failed${err?.code ? ` (${err.code})` : ""}`));
    const onData = chunk => {
      buf += chunk;
      if (buf.length > MAX_FRAME_BYTES) {
        conn.sock.destroy();
        return give(reject, new Error("frame too large"));
      }
      const i = buf.indexOf("\n");
      if (i === -1) return;
      let parsed;
      try { parsed = JSON.parse(buf.slice(0, i)); } catch { return give(reject, new Error("bad reply")); }
      // THROUGH THE CONNECTION'S OWN READER, and on a sealed connection
      // that is the only way in. A reply that does not open is not a reply
      // with something wrong in it; it is a connection that stopped being
      // the one the handshake proved — altered, replayed, or plain where
      // both ends agreed to seal — so the round ends here instead of
      // reading it as it stands. See frameChannel.
      const got = conn.read(parsed);
      if (conn.sealed && !got) {
        conn.sock.destroy();
        return give(reject, new Error("a reply from that deck did not open"));
      }
      give(resolve, got);
    };
    const bell = setTimeout(() => give(reject, new Error("peer went quiet")), ROUND_MS);
    bell.unref?.();
    conn.sock.on("data", onData);
    conn.sock.on("close", onClose);
    conn.sock.on("error", onError);
    // And out through its own writer, which seals whenever the reader opens.
    // A dead socket cannot throw here — sendFrame swallows a failed write,
    // and `close`/`error` above are what report it. What CAN throw is the
    // seal running out of counter, which is this deck's limit and not a
    // network drop, so it is rejected under its own name.
    if (conn.sock.destroyed) return onClose();
    try { conn.send(frame); } catch (err) { give(reject, err); }
  });
}

/**
 * One deck's LAN sync, from settings to a healed account.
 *
 * `deps` is every side effect: reading accounts, exporting one, importing one.
 * Injected rather than imported so a test can run a whole round — two engines,
 * two fake stores, one real socket pair — without claude-swap on the machine.
 */
export function createEngine({
  readAccounts, exportAccount, importAccount, checkArrivals, liveLogin,
  onChange, onError, onIdentity, onPort, onTrust, onUnpaired, onDial, onShared, now = Date.now,
  /**
   * The UDP socket the beacon shouts through, injectable for the same reason
   * lan-beacon exposes it — and for one more that only showed up in use.
   *
   * The suite runs whole engines over real sockets, which is right: a handshake
   * between two of them is the thing being tested and a mock would only check
   * that the mock agrees with the code it was written from. But `createBeacon`
   * defaulted to a real dgram socket, so `npm test` BROADCAST on whatever
   * network the machine was on — and the fake decks it announces turned up in
   * a real panel, on a real screen, in a list of decks somebody could pair
   * with. Nothing secret leaves, and it is still a test shouting at an office.
   */
  createSocket,
  /** This deck's own card — its version and its machine — handed to every
   *  paired deck and to nobody else. See lan-about.mjs. */
  about = null,
  /** Whether this deck seals every frame after the handshake with a deck that
   *  says it does too — see frameChannel in lan-wire.mjs. Nothing in the deck
   *  turns it off; the suite does, to play a deck from before #810, which is
   *  the only way to show that one still heals. */
  sealFrames = true,
  /** Whether this deck mixes a key pair made for each connection into that
   *  connection's key, with a deck that says it does too — see sessionKey in
   *  lan-wire.mjs. Nothing in the deck turns this off either; the suite does,
   *  to play a deck of #810's version, which seals and does not mix. It rides
   *  on `sealFrames`: with that off, this deck says neither. */
  ephemeral = true,
  /** Where the listener binds: every interface, which is what a peer dials,
   *  unless the suite says loopback — a test deck has no business being
   *  reachable from the office for the seconds it runs. */
  host,
  /**
   * The Tailscale reader — see createTailnet in tailscale.mjs — or nothing,
   * which is a deck that knows only the local network. Injected because the
   * real one spawns the CLI, and the suite's engines have no tailnet.
   */
  tailnet = null,
  /** How long a deck that cannot hear waits to try the port again. A
   *  parameter so the suite does not wait thirty seconds to see it. */
  bindRetryMs = BIND_RETRY_MS,
  /** Which program holds the discovery port, when it is taken — see
   *  port-holder.mjs — so the panel can name it. Nothing asks without one. */
  portHolder = null,
  /** Where the machine would send each broadcast, so none leaves through a
   *  tunnel — see route-via.mjs. Absent, every broadcast goes. */
  routes = null,
} = {}) {
  let cfg = {
    // `onward`: which of `shared` an arrival ticked rather than a person — see
    // sharedWith in lan-sync.mjs.
    enabled: false, name: defaultName(), secret: "", shared: [], onward: [], trusted: [], unpaired: [], port: 0,
    autoAsk: true, autoAccept: true, pairingMode: "automatic", aliases: {},
    // Tell paired decks which shared account this one is on — see currentFor.
    shareActive: true,
    // DISCOVERY OVER TAILSCALE, off until somebody turns it on, and its own
    // pair of permissions. They are separate from the two above because the
    // tailnet is a different audience: the local switches answer for whoever
    // is on this network, these only ever for machines signed in to this
    // person's own Tailscale account — see routeOf.
    tailscale: false, tailscaleAsk: true, tailscaleAccept: true,
  };
  // Bumped by every stop, a restart included: anything started before it
  // belongs to a listener that is gone.
  let generation = 0;
  // What a round checks instead, so a round stopped by switching LAN off
  // cannot resume when it is switched back on. A restart for a new name or
  // key revokes nothing — the peer is still paired and LAN still on — so a
  // transfer in flight lands and is shared onward as usual.
  let session = 0;
  let identity = null;
  let beacon = null;
  let server = null;
  /** This engine, for the helpers below `apply` that need to press its own
   *  accept or add its own peer — the requests (see lan-requests.mjs, which
   *  reach it through engineNow), and the callbacks apply hands the listener
   *  and the beacon. Set on the first apply, which is the only
   *  thing that can start a round or a listener, so nothing reads it before it
   *  is there. */
  let engine = null;
  /** The invite this deck is offering, from the press that makes it to the
   *  proof that spends it — see lan-invite-offer.mjs. */
  const offer = createInviteOffer({ now, onChange, onError });
  /** What the last round did with each deck, when the whole round last
   *  finished, and whether anybody it asked is still deciding — see
   *  lan-round-record.mjs. */
  const lastRound = createRoundRecord({ now });
  /**
   * Why this deck is not listening, when it is switched on and is not.
   *
   * A second deck on one machine takes the first one's port and the bind fails;
   * the switch stays on, the beacon never starts, and the panel drew
   * `starting…` for as long as the process lived. A state that cannot resolve
   * and does not say why is the worst thing an instrument can show — the reader
   * waits, and waiting is the one thing that never fixes it.
   *
   * Only the failures that stop the service reach this. A round that could not
   * reach one peer is that peer's row, not the deck's.
   */
  let stalled = null;
  /** Who has called this deck — when each paired deck last spoke and from
   *  where, when another machine last got through, and since when the
   *  listener has been up — see lan-inbound.mjs. */
  const inbound = createInbound({ now, localAddresses });
  /** The addresses this deck dials that the beacon did not hand it, and what
   *  answered at each — see lan-dials.mjs, where every row says whether a
   *  person named it, which is the whole of roundWith's trust rule. */
  const dials = createDials();
  /** Whether this deck can hear other decks announce, who is holding the
   *  discovery port while it cannot, and the sentence the panel says about
   *  it — see lan-hearing.mjs. */
  const hearing = createHearing({ beaconNow: () => beacon, portHolder, onChange });

  /** Whether an address is a tailnet one, and whose. Null is the local network
   *  — and always is on a deck with no Tailscale reader. */
  const routeTo = addr => routeOf(tailnet?.snapshot?.() ?? null, addr);
  /** The same answer by the name a row carries: "tailscale" for a tailnet
   *  address, "lan" for every other. */
  const viaAt = addr => (routeTo(addr) ? "tailscale" : "lan");

  /** A pairing somebody explicitly removed. Unlike `declined` in
   * lan-requests.mjs, this survives a restart because the old dial row
   * survives too; forgetting the decision would let that row silently
   * recreate the pairing on the next round. */
  const wasUnpaired = fp => Array.isArray(cfg.unpaired) && cfg.unpaired.includes(fp);
  const markUnpaired = (fp, value) => {
    const before = Array.isArray(cfg.unpaired) ? cfg.unpaired : [];
    const next = value
      ? (before.includes(fp) ? before : [...before, fp])
      : before.filter(x => x !== fp);
    if (next.length === before.length && next.every((x, i) => x === before[i])) return false;
    cfg = { ...cfg, unpaired: next };
    onUnpaired?.(next);
    return true;
  };

  /** The decks waiting on somebody here — asked, heard, or told no — and when
   *  a switch answers one for the owner by pressing this engine's accept. See
   *  lan-requests.mjs. */
  const requests = createRequests({
    now, settings: () => cfg, routeTo, wasUnpaired, engineNow: () => engine, onChange, localAddresses,
  });

  /**
   * Pin a deck somebody here chose — pressed accept on, handed an invite to,
   * or joined on an invite of its own — and take back any earlier unpair of
   * it, because choosing it again is the undo. The list, and whether the pin
   * is new.
   *
   * Or one the accept switch chose for them, which `auto` says and the pin
   * keeps — see addTrusted, and roundWith for what such a deck may not do.
   */
  const pin = ({ fp, pub, name }, { auto = false } = {}) => {
    const { list, added } = addTrusted(cfg.trusted, { fp, pub, name, at: now(), ...(auto ? { auto: true } : {}) });
    cfg = { ...cfg, trusted: list };
    markUnpaired(fp, false);
    return { list, added };
  };

  /** Reading the tailnet on a timer while the switch is on, announcing at
   *  once when it is turned on — see lan-tailnet-poll.mjs. */
  const tailPoll = createTailnetPoll({
    tailnet, beaconNow: () => beacon, wanted: () => cfg.enabled && cfg.tailscale,
  });

  /** This deck's accounts in the shape the rules want — see lan-accounts.mjs.
   *  Read through the same function the panel uses, so a row can never be alive
   *  here and dead there. */
  const localAccounts = async () => syncAccounts(await readAccounts());

  /** This deck's side of the manifest exchange: the frame it sends, what it
   *  keeps of the one it hears — a paired deck's card and the logins it offers,
   *  kept apart from lastRound — and what a row reads of that — see
   *  lan-manifest.mjs. */
  const { manifestFrame, keepManifest, heardOf } = createManifests({
    about, now, myFp: () => identity.fp, settings: () => cfg,
  });

  /**
   * WHERE EACH PAIRED DECK LAST ANSWERED: the address and port of the last
   * round whose handshake with it completed against its pin, by fingerprint.
   *
   * A beacon carries a fingerprint and a port, and nothing binds either to the
   * address it came from — so for a paired deck it may say where to try FIRST
   * and nothing more. It used to be the whole answer: the heard row took the
   * beacon's address, was dialled for a day, and a typed row for the same deck
   * was skipped as dialled already. A deck reached by typed address, which is
   * the usual reason to type one, sends no beacon that would ever correct it.
   * This is what a round falls back to when a heard address fails, and what
   * lets a heard address that did answer stay dialled after its beacons stop.
   */
  const lastGood = new Map();
  const answeredThere = p => {
    const g = lastGood.get(p.fp);
    return !!g && g.addr === p.addr && g.port === p.port;
  };
  /** Whether a round dials this heard row: listed, and either answered at that
   *  address or still being announced there. One that never answered is
   *  dialled for as long as a deck stays present (PRESENT_MS), not a day. */
  const dialsHeard = p => stillListed(p, now()) && (answeredThere(p) || now() - p.lastSeen < PRESENT_MS);

  /** Does this deck already hold an address it dials for `fp`? A beacon row it
   *  still dials, or a typed/learned row that answered as that deck. When
   *  neither is true, the only way it ever reaches that deck is if the deck
   *  keeps calling — and a called deck is never pulled from. */
  const dialsAlready = fp => {
    if (beacon && [...beacon.peers.values()].some(p => p.fp === fp && dialsHeard(p))) return true;
    return dials.answersAs(fp);
  };

  /**
   * A PAIRED DECK THAT CALLS IN, AND NOTHING HERE DIALS IT.
   *
   * Accounts move only toward the deck that dials — roundWith pulls, serve only
   * answers — so a deck this one holds no address for can offer everything and
   * this one takes nothing. It is the exact state a deck falls into when it
   * cannot hear beacons (a firewall, or Tailscale holding the discovery port):
   * every peer becomes one that only calls, and no account ever arrives.
   *
   * The call itself is the address. The peer connected FROM somewhere and said
   * in its hello which port it LISTENS on, and that pair is dialable. Adding it
   * makes the next round reach the caller and pull — the same dial-back that
   * accepting a deck and joining by invite already do, extended to a peer that
   * simply calls. In memory, unlike those two: a settings write clears it and
   * the next call re-adds it, and nothing here writes a caller's address to
   * disk.
   */
  const learnCaller = ctx => {
    const fp = ctx?.peerFp;
    const at = ctx?.peerAddr;
    const port = ctx?.peerPort;
    if (!fp || !at || !port || !engine) return;
    if (!trustedPeer(cfg.trusted, fp)) return;
    if (dialsAlready(fp)) return;
    // As a row the deck ADDED ITSELF, not one a person typed: capped like every
    // other automatic row, and — through its trial — taken away again if the
    // address turns out not to answer. The caller is already trusted, so the
    // round dials and pulls without a press; `typed` decides only the cap and
    // the undo, never the trust. See roundWith.
    if (engine.addPeer(at, port, { typed: false })) {
      dials.trial(`${at}:${port}`, { fp, name: trustedPeer(cfg.trusted, fp)?.name || "" });
      onChange?.();
    }
  };

  /** What this deck answers a paired deck that asks — its list, or one login
   *  sealed for it — and the checks that decide whether it answers at all.
   *  See lan-serve.mjs. */
  const { serve } = createServe({
    settings: () => cfg, serverNow: () => server, myFp: () => identity.fp,
    inbound, learnCaller, keepManifest, manifestFrame, localAccounts, liveLogin, exportAccount, onError,
  });

  /**
   * Dial a deck just paired with from now on, and keep the address: in the
   * dial list, and through onDial in prefs, so a restart does not make the
   * pairing one-way again.
   *
   * AND SAY WHO IS THERE, NOW. What the dial list learned at an address is
   * what joins a dialled row to a heard one (see `learned` in lan-dials.mjs),
   * and it was only ever filled by a round that succeeded — so
   * between accepting a deck and the next round, one machine appeared as two
   * rows. We already know the answer here: the handshake that just finished
   * said so.
   */
  const keepDialling = (addr, port, met) => {
    engine.addPeer(addr, port);
    onDial?.(`${addr}:${port}`);
    dials.meet(`${addr}:${port}`, met);
  };

  /** Somebody used the token. It is retired — one that pairs twice is one
   *  worth stealing twice — and they are pinned.
   *
   *  RETIRED FIRST, so nothing that goes wrong in the pairing after it can
   *  leave a spent token live (#1137). The listener calls this for every
   *  proof that holds, a deck it already had included; pinning one of those
   *  again changes nothing but its name, and dialling it back is what joining
   *  does on the other end too. */
  const inviteUsed = entry => {
    offer.retire();
    const { list } = pin(entry);
    // AND DIAL IT BACK, KEPT. Accepting made it welcome and left this
    // deck with no way to reach it: an inbound connection puts nothing in
    // the dial list. Without this the pairing is mutual in the trusted
    // list and one-way in fact — and `addPeer` alone lives in memory, so
    // it would be one-way again after the next restart.
    if (entry.addr && entry.port) keepDialling(entry.addr, entry.port, { fp: entry.fp, name: entry.name || "" });
    onTrust?.(list);
    onChange?.();
  };

  /** The identity a key check is running for, or has already moved away from,
   *  and when the last one started — see idClash. */
  let clashFor = null;
  let clashAt = -Infinity;

  /**
   * Another deck may be using this one's key. When it is, take a new key and
   * keep it. Two decks with one identity are invisible to each other forever
   * otherwise, and the second one to notice moving is enough — whichever
   * notices first, moves.
   *
   * THE BEACON SAYS WHERE TO LOOK, NOT THAT IT IS SO. This deck's fingerprint
   * is in every beacon it sends, so a beacon wearing it is no evidence that
   * anybody else holds the key — and a new key is a stranger to every deck
   * paired with this one, which an invite-only pairing does not recover from
   * without a new invite. What only another holder of the key can do is finish
   * a handshake against this deck's own pin, so the deck dials the address the
   * beacon named and moves only if that handshake completes. Saying it is not
   * asking to pair, so a deck from before its listener answered this is simply
   * not a copy here — and it moves on its own when it hears this deck.
   *
   * NOT ITS OWN LISTENER, which holds the key too and would answer the same
   * way: the challenge on that connection says which one answered.
   *
   * ONE CHECK AT A TIME, AT MOST ONE PER BEACON INTERVAL, AND NONE ONCE IT HAS
   * MOVED. What arrives decides how often this dials, never how much; a real
   * copy announces every ANNOUNCE_MS, so it is looked at by its next beacon at
   * the latest; and after the new key is handed over nothing more is checked
   * until the deck restarts on it.
   */
  const idClash = async ({ addr, port } = {}) => {
    const mine = identity;
    if (!mine || !server || typeof addr !== "string" || !addr || !port) return;
    if (clashFor === mine || now() - clashAt < ANNOUNCE_MS) return;
    clashFor = mine;
    clashAt = now();
    const startedIn = generation;
    let copy = false;
    let conn = null;
    try {
      conn = await connectToPeer({
        host: addr, port, fp: mine.fp, pub: mine.pub, secret: mine.secret, name: cfg.name,
        myPort: server?.port() ?? null, expectPub: mine.pub, ask: false, sealFrames, ephemeral,
      });
      copy = conn.peerFp === mine.fp && startedIn === generation && !server?.issued(conn.peerChallenge);
    } catch { /* nothing there holds this key */ } finally {
      conn?.sock?.destroy();
    }
    if (!copy || startedIn !== generation || identity !== mine) {
      if (clashFor === mine) clashFor = null;
      return;
    }
    const fresh = identityFrom("");
    onIdentity?.(fresh.secret);
    onError?.("id-clash", new Error("another deck was using this one's key; taking a new one"));
  };
  /** How this deck reached that peer. A beacon row says so; a typed address is
   *  read from the routing table. The round and the peer list both ask this. */
  const viaOf = peer => peer.via ?? viaAt(peer.addr);

  /** Checks the logins a round brought, once, and records any reason one is
   *  unusable here on its row. An unanswered check is not a failure. */
  const markArrivals = async done => {
    const arrived = done.filter(d => d.ok);
    if (!arrived.length || !checkArrivals) return;
    let found = null;
    try { found = await checkArrivals(arrived); } catch { /* unasked is not a failure of the round */ }
    arrived.forEach((d, i) => { if (typeof found?.[i] === "string") d.why = found[i]; });
  };

  /** Ask one peer what it has, and heal whatever it can heal. `reached` is
   *  told the deck's fingerprint once the handshake with it has held. */
  const roundWith = async (peer, reached = null) => {
    let conn = null;
    const startedIn = session;
    // Out here, so a round that dies after some logins arrived still reports
    // them — see the catch below.
    const done = [];
    try {
      conn = await connectToPeer({
        host: peer.addr, port: peer.port, timeoutMs: ROUND_MS,
        fp: identity.fp, pub: identity.pub, secret: identity.secret, name: cfg.name,
        // Where this deck listens, so the far side can reach back after it
        // accepts rather than only being reachable.
        myPort: server?.port() ?? null,
        // The key pinned when this deck was accepted, so a second machine
        // answering at that address is refused rather than talked to.
        expectPub: trustedPeer(cfg.trusted, peer.fp)?.pub ?? null,
        // Invite-only still dials the rows it has — an invite-paired deck is one
        // of them — but tells the far end it is not asking, so a row that turns
        // out to be a stranger is refused there instead of becoming a request.
        ask: cfg.pairingMode !== "invite",
        sealFrames, ephemeral,
      });
      const ask = frame => askOver(conn, frame);

      // THIS DECK'S OWN KEY, ANSWERING — its own listener at an address
      // somebody typed, or another machine holding a copy of the key, which a
      // listener now answers (see idClash). Neither is a deck to pin, ask or
      // take anything from, and a pin of this deck's own key would be one
      // every handler here then trusted.
      if (conn.peerFp === identity.fp) throw new Error("that address answers with this deck's own key");

      // WHO IS ACTUALLY THERE. A typed address is a row that says `192.168.1.5:54340`
      // and nothing else until somebody answers it — and once one has, the deck
      // on the other end has told us what it calls itself. The row says that
      // from then on, because "Constantin-PC" is what the person who typed the
      // address was trying to reach.
      //
      // A DIAL-BACK THAT ANSWERED IS AN ORDINARY PEER NOW. It was on trial only
      // until it proved the deck can reach it; from here it is dialled like any
      // other and is no longer a candidate for the undo below. See learnCaller.
      dials.answered(`${peer.addr}:${peer.port}`, { fp: conn.peerFp, name: conn.peerName || "" });

      // TRUST ON FIRST USE, AND ONLY FOR AN ADDRESS SOMEBODY NAMED. Reaching a
      // deck we have no pin for used to mean the person at this keyboard put
      // its address in the field, which is the same decision the accept button
      // is on the other side. Pinning it here is what makes the two lists agree
      // — without it this deck would dial a peer every minute and still show it
      // as nobody, and its own listener would refuse the same deck calling back.
      //
      // THE PREMISE WAS NOT CHECKED, AND `autoAsk` BREAKS IT — which is #969,
      // and it is a chain rather than one mistake. A beacon authenticates
      // nothing, by construction: it carries a fingerprint and a port and
      // nothing binds either to the address it came from. `autoAsk` ships on,
      // and it answered every new fingerprint by putting that address on the
      // dial list. The next round reached it, arrived here with no pin, and
      // read "no pin" as "somebody typed this". Nobody typed anything. One
      // unsolicited packet, zero presses, and the far end was in `cfg.trusted`
      // — which lan-deck.mjs writes to prefs.json, and which is the whole inbound
      // gate — so from then on it could authenticate to `serve` and ask for
      // every account the owner had ticked. Reproduced end to end before this
      // line changed.
      //
      // So the row has to say where it came from, and only a row a person
      // named may be pinned unseen. A row the deck added itself raises the
      // request instead — which is all `autoAsk` ever promised: it is the ASK
      // switch, and the accept switch is the other one.
      //
      // A deck we DO have a pin for was checked before this line: connectToPeer
      // was given expectPub and refuses a different key at that address.
      if (!trustedPeer(cfg.trusted, conn.peerFp)) {
        // Said as this deck's own setting, not as a fault: the row the panel
        // draws for it is a state the owner chose (see WIRE_ANSWERS).
        if (cfg.pairingMode === "invite") throw new Error("this deck pairs only by invite");
        if (!peer.typed || wasUnpaired(conn.peerFp)) {
          // The same row the listener's own `onPending` draws, from the other
          // direction: this deck dialled rather than being dialled, and the
          // handshake it just finished is the same evidence either way — a real
          // deck holding the key it announced. What is missing is the press,
          // and that is what this asks for.
          requests.askToAccept({
            fp: conn.peerFp, pub: conn.peerPub, name: conn.peerName,
            addr: peer.addr, port: peer.port,
          });
          throw new Error("waiting for somebody here to accept that deck");
        }
        const { list, added } = addTrusted(cfg.trusted, {
          fp: conn.peerFp, pub: conn.peerPub, name: conn.peerName, at: now(),
        });
        if (added) { cfg = { ...cfg, trusted: list }; onTrust?.(list); }
      }

      // A PAIRED DECK, ANSWERING HERE against its pin — which is what makes
      // this address one to fall back to, and a heard one worth dialling after
      // its beacons stop. See lastGood.
      lastGood.set(conn.peerFp, { addr: peer.addr, port: peer.port, via: viaOf(peer) });
      reached?.(conn.peerFp);

      // Our card goes with the question and theirs comes back with the answer
      // — see lan-about.mjs for why it is here and nowhere earlier.
      // THE QUESTION CARRIES THIS DECK'S LIST TOO, and which of it this deck is
      // on — so the deck being asked knows both without dialling back, which a
      // deck with no address for this one never could. An older deck reads the
      // question's `t` and card and nothing else, so it answers as it always did.
      const stillPaired = () => session === startedIn && cfg.enabled
        && trustedPeer(cfg.trusted, conn.peerFp)?.pub === conn.peerPub;
      if (!stillPaired()) throw new Error("peer no longer paired");
      const mine = await localAccounts();
      // The owner can revoke trust or disable sync while the store is read.
      // Never send this deck's account identities on that old connection.
      if (!stillPaired()) throw new Error("peer no longer paired");
      const theirs = await ask(manifestFrame(mine, conn.key, conn.peerFp));
      // A response from a round that was stopped or unpaired is stale even
      // when the peer had already sent it before the setting changed.
      if (!stillPaired()) throw new Error("peer no longer paired");
      if (theirs?.t !== "manifest" || !Array.isArray(theirs.accounts)) throw new Error("no manifest");
      const list = keepManifest(conn.key, theirs, conn.peerFp);
      // FROM A DECK SOMEBODY HERE CHOSE, NEITHER AN ADD NOR A HEAL NEEDS MY
      // TICK. Adding is the case the owner asked for by name: an account that
      // appears among the decks I paired with appears on all of them, which is
      // the whole of "I do not want to paste blobs any more". What can reach
      // this is what a deck somebody here pressed accept on chose to offer.
      //
      // A heal used to need the tick, on the reasoning that it replaces a slot
      // I already have. It replaces only one claude-swap has quarantined, with
      // the same account's working copy, through the same plain import an add
      // uses — strictly less than an add does. And the tick is the owner's
      // answer to "offer this account" (LanSetupModal), not to "repair it":
      // gating the repair on it left a login dead here for as long as nobody
      // ticked it, while deleting the dead slot turned the same transfer into
      // an add that went straight through. So people deleted accounts to fix
      // them. A copy dies on its own, too — claude-swap's refresh rotates the
      // token, and every other deck holding the old one gets invalid_grant —
      // so this is the ordinary case between one person's machines, not an
      // edge.
      //
      // WHICH IS ONLY TRUE OF A DECK SOMEBODY CHOSE. The accept switch presses
      // accept for the owner, so "somebody here pressed accept" is not a
      // premise about a deck it paired: nobody here chose that deck, and the
      // logins this store holds would be whatever it decided to offer. What a
      // deck the switch paired offers comes in — added or healed — only for an
      // account ticked here, and a person's own press or invite takes the mark
      // off its pin (see addTrusted).
      // OVER `list`, NOT THE RAW ARRAY. `offered`, which keepManifest runs the
      // list through above (see lan-manifest.mjs), slices to 50 and type-
      // filters `key` and `email`; this line read `theirs.accounts` and got
      // neither. syncAction answers "add" for anything this deck lacks and an
      // add needs no tick, so a peer answering `manifest` with thousands of
      // rows produced thousands of steps — each a sequential `want`/`have`
      // round trip with its own 10s bell plus a claude-swap subprocess holding
      // the store lock, while the panel drew 50 and every other paired deck
      // waited behind it. `step.key` also reached transferChallenge and
      // importAccount untyped, which `offered`'s filter would have caught.
      const chosen = () => trustedPeer(cfg.trusted, conn.peerFp)?.auto !== true;
      const takes = step => chosen() || cfg.shared.includes(step.key);
      const wanted = plan(mine, list).filter(takes);
      // TWO CHECKS, BECAUSE THEY END DIFFERENT THINGS. Losing the session —
      // LAN switched off, the peer unpaired (`stillPaired`, above) — ends the
      // round. From a deck the switch paired, an account unticked mid-round
      // ends only that step: the next one may still be ticked, and the skipped
      // row says why rather than vanishing.
      const stillWanted = takes;
      /** One login, asked for and opened: a `want` carrying its own proof that
       *  names the account (see transferChallenge), and the `have` opened under
       *  the additional data it was sealed with. The login, or why there is
       *  none — the peer's refusal as this deck records it, or a seal that did
       *  not open. */
      const wantLogin = async step => {
        const nonce = randomBytes(12).toString("hex");
        const reply = await ask({
          t: "want", key: step.key, nonce,
          proof: transferChallenge(conn.key, {
            nonce, accountKey: step.key, fromFp: identity.fp, toFp: conn.peerFp,
          }),
        });
        if (reply?.t !== "have" || !reply.sealed) return { why: peerWhy(reply?.why) };
        const blob = open(conn.key, reply.sealed, credentialAad(conn.peerFp, identity.fp, step.key));
        return blob ? { blob } : { why: "could not open" };
      };
      let cut = false;
      for (const step of wanted) {
        if (!stillPaired()) { cut = true; break; }
        if (!stillWanted(step)) { done.push({ ...step, ok: false, why: "not shared" }); continue; }
        const { blob, why } = await wantLogin(step);
        if (!blob) { done.push({ ...step, ok: false, why }); continue; }
        // Unpairing, disabling LAN, or unticking a heal while export was in
        // progress takes effect before the received credential touches disk.
        if (!stillPaired()) { cut = true; break; }
        if (!stillWanted(step)) { done.push({ ...step, ok: false, why: "not shared" }); continue; }
        // A verdict rather than a boolean, because "refused" and "kept the
        // slot it already has" are different things to tell somebody and the
        // second one used to be reported as success. A bare `true` is still
        // accepted: the suite drives this with one. `ok` here means the login
        // LANDED; whether this deck can then use it is checked after the loop
        // and rides on the same row as a warning.
        // The step goes down with the blob: the wiring has to know WHICH account
        // it is placing before it may treat a decline as an empty slot rather
        // than as a healthy one.
        let got;
        try { got = await importAccount(blob, step); }
        catch {
          // One local store failure must not erase earlier arrivals or stop
          // independent logins from being received. Store diagnostics can
          // contain credential material, so only a fixed verdict leaves here.
          done.push({ ...step, ok: false, why: "import failed" });
          continue;
        }
        const ok = got === true || got?.ok === true;
        // AN ACCOUNT THAT ARRIVED HERE IS SHARED ONWARD (#1188). People forget
        // to tick it, and a group where one machine can heal the others and the
        // others can heal nobody is the shape that costs them: the second
        // machine to lose the same login has to go back to the first, which may
        // be asleep or on another network. Nothing new is exposed — the login
        // came FROM the group, so the group has it.
        //
        // ONLY AN ADD, and only from the local network. A heal already needed
        // the tick to happen at all (the filter above), so there is nothing to
        // add for one; and a tailnet reaches further than the person's own
        // machines, which is a decision they make for themselves rather than
        // one an arrival makes for them.
        // The store can finish an import after the owner disabled LAN or
        // revoked this peer. Keep the imported slot, but do not turn it into
        // a newly shared credential on behalf of an obsolete transfer.
        if (ok && stillPaired() && ticksOnArrival(step, viaOf(peer), trustedPeer(cfg.trusted, conn.peerFp))) {
          // MARKED AS THIS ARRIVAL'S TICK, here and in what onShared keeps, so
          // it is offered to the decks somebody here chose and not to one the
          // accept switch paired — see sharedWith. Only while nobody has
          // ticked the account already: a person's tick stays a person's.
          if (!cfg.shared.includes(step.key) && !cfg.onward?.includes(step.key)) {
            cfg = { ...cfg, onward: [...(cfg.onward ?? []), step.key] };
          }
          try { await onShared?.(step.key); }
          catch { /* the account is here; the tick is retried the next time one arrives */ }
        }
        done.push({ ...step, ok, why: ok ? null : (got?.why ?? "import failed") });
      }
      // A ROUND FROM A SESSION THAT ENDED SAYS NOTHING. LAN was switched off
      // under it, and possibly on again: a cut-short list is not "all logins
      // fine", and it is not this session's to report.
      if (session !== startedIn) return done;
      // Unpaired mid-round: said as such, not as the short list that reads
      // "all logins fine".
      if (cut) throw new Error("peer no longer paired");
      // WHAT ARRIVED, CHECKED ONCE, AFTER THE LAST QUESTION. An import that
      // exited cleanly can still have left a login this process cannot read (a
      // Mac's Keychain, from SSH or a LaunchAgent). Such a row stays `ok` — it
      // DID arrive, and was ticked onward above — and carries the reason as a
      // warning. After the loop because the check is a usage collection that
      // can outlast the peer's thirty-second idle timer, and one ask covers
      // every login the round brought.
      await markArrivals(done);
      lastRound.keep(peer.fp, { at: now(), name: peer.name, offered: list.length, done });
      if (done.length) onChange?.();
      return done;
    } catch (err) {
      // Nor does its failure: "peer no longer paired" from a round that LAN
      // being switched off ended is about the old session, and would stand on
      // a row that is paired and fine until the next round replaced it.
      if (session !== startedIn) return [];
      // A round cut short still reports what arrived, so the logins it did
      // bring are checked the same way a finished round's are.
      await markArrivals(done);
      if (session !== startedIn) return [];
      lastRound.keep(peer.fp, { at: now(), name: peer.name, error: err.message, done });
      if (done.length) onChange?.();
      // A DIAL-BACK THAT NEVER ANSWERED IS TAKEN AWAY AGAIN. The address came
      // from a paired deck's inbound call, and this round was the test of
      // whether the call can be returned. It could not — a strict NAT, a
      // one-way path — so the row is removed rather than left to fail every
      // minute, and the peer goes back to "calls in". Its next call tries once
      // more. A row that answered has already left its trial above.
      const at = `${peer.addr}:${peer.port}`;
      if (dials.failed(at)) {
        lastRound.drop(peer.fp);
        onChange?.();
      }
      return done;
    } finally {
      conn?.sock?.destroy();
    }
  };

  const oneRound = async () => {
    if (!beacon) return [];
    const startedIn = session;
    const all = [];
    // Heard first, typed second, and a typed one is skipped when this round
    // already dialled that address: otherwise a deck that is both would be
    // dialled twice a round and its work counted twice.
    // The same rule the list uses. A deck that has been silent for a day is not
    // dialled once a minute forever on the chance it comes back — and one that
    // never answered at the address it announced, not past PRESENT_MS (see
    // dialsHeard).
    //
    // A deck heard over the tailnet is dialled only while that switch is on, and
    // so is a row the deck added itself from a tailnet beacon. An address a
    // person typed is theirs whatever the switch says — pairing by a typed
    // 100.x address worked before any of this.
    const heard = [...beacon.peers.values()]
      .filter(p => dialsHeard(p) && (cfg.tailscale || p.via !== "tailscale"));
    /** Every address this round has dialled, and every paired deck it reached
     *  by any of them. */
    const tried = new Set();
    const reached = new Set();
    const dial = async peer => {
      tried.add(`${peer.addr}:${peer.port}`);
      all.push(...await roundWith(peer, fp => reached.add(fp)));
    };
    // Sequential rather than parallel. The store takes one mutation at a
    // time anyway (the mutex in store-lock.mjs), and two peers healing the
    // same account at once would race for a slot number claude-swap assigns
    // as max+1 without a lock of its own.
    //
    // And given up when LAN is switched off under it: the rest of the list
    // belongs to no session, and dialling it only delays the next round.
    for (const peer of heard) {
      if (session !== startedIn) return all;
      await dial(peer);
      // A HEARD ADDRESS THAT DID NOT ANSWER, for a deck that answered somewhere
      // else before: that address, in the same round. A beacon says where a
      // deck moved and cannot say it truly — see lastGood. One on the dial list
      // is tried below with the rest of the list; one heard over the tailnet
      // waits for that switch, as its beacon would.
      const back = reached.has(peer.fp) ? null : lastGood.get(peer.fp);
      if (!back || (back.via === "tailscale" && !cfg.tailscale)) continue;
      const at = `${back.addr}:${back.port}`;
      if (tried.has(at) || dials.rows().some(r => `${r.addr}:${r.port}` === at)) continue;
      if (session !== startedIn) return all;
      await dial({ fp: peer.fp, name: peer.name, addr: back.addr, port: back.port, via: back.via });
    }
    // AND ONE DIAL PER DECK, not one per address. A row asked from a tailnet
    // beacon keeps that address after the same deck is heard on the local
    // network, and both used to be dialled every round — two handshakes, and
    // two lines of work for one machine. `dials.metAt` says which deck a row
    // reached; when this round already reached that deck, by the heard route
    // or any other, the row is skipped. When it did not, the row is the next
    // way to it and is dialled — a heard address alone never stands in for it.
    const typed = dials.rows().filter(p => {
      const at = `${p.addr}:${p.port}`;
      if (tried.has(at) || reached.has(dials.metAt(at)?.fp)) return false;
      return cfg.tailscale || p.typed || !routeTo(p.addr);
    });
    for (const peer of typed) {
      if (session !== startedIn) return all;
      await dial(peer);
    }
    if (session !== startedIn) return all;
    lastRound.finished();
    return all;
  };

  /** The line every round waits in, whole or one deck — see lan-turns.mjs,
   *  which is why a round asked for while another runs joins it (#1040) and a
   *  check waits behind it (#1132). */
  const turns = createTurns();
  const round = () => turns.round(session, oneRound);
  /** When the next round runs: a minute at rest, seconds while a deck this one
   *  dialled is deciding — see lan-round-timer.mjs. */
  const roundTimer = createRoundTimer({ round, waiting: lastRound.waitingOnSomebody });

  /** What status() says about Tailscale, for a deck that has a reader: whether
   *  the machine has it at all, and what it can see. */
  const tailnetStatus = () => {
    const t = tailnet.snapshot?.() ?? null;
    return {
      found: !!tailnet.found?.(),
      state: t?.state ?? null,
      running: !!t?.running,
      on: !!cfg.tailscale,
      ask: cfg.tailscaleAsk !== false,
      accept: cfg.tailscaleAccept !== false,
      login: t?.self?.login ?? null,
      addr: t?.self?.ips?.[0] ?? null,
      exitNode: !!t?.exitNode,
      // The owner's machines a beacon goes to right now.
      devices: beaconTargets(t).length,
    };
  };

  /** Every deck this one dials or is paired with, one row each — see
   *  status()'s `peers`. Asked only while the beacon is up. */
  const deckRows = () => {
    // ONE DECK, ONE ROW, and it takes work because a deck can arrive here
    // twice by two different routes: heard on the network, and dialled at
    // an address somebody typed or that an invite carried. Both are the
    // same machine and neither knows it — the beacon row is keyed by the
    // fingerprint it announced, the typed row by `host:port`, and until a
    // connection succeeds nothing joins them.
    //
    // What joins them is `dials.metAt`: the fingerprint that actually
    // answered at that address. So every row is given the identity it is
    // really about, and rows that turn out to share one are merged — the
    // heard half brings liveness, the dialled half brings the last round.
    const rows = [];
    const byId = new Map();
    /** Of two records of asking one deck, the one written last. */
    const later = (x, y) => (!x ? y : !y ? x : (y.at ?? 0) >= (x.at ?? 0) ? y : x);
    const put = row => {
      const had = byId.get(row.id);
      if (!had) { byId.set(row.id, row); rows.push(row); return; }
      // Keep what each half is the authority on — and the LATER ask of the
      // two, which is how the deck is now: a round that could not reach it by
      // its heard address and reached it by the typed one wrote both.
      had.lastSeen = had.lastSeen ?? row.lastSeen;
      had.last = later(had.last, row.last);
      had.manual = had.manual || row.manual;
      had.met = had.met || row.met;
      if (row.name && !had.name) had.name = row.name;
    };
    // WHAT THE DECK'S OWN DIALOG DRAWS, by identity: the card it sent,
    // the logins it offered last, and when somebody here said yes. All
    // three are keyed by the fingerprint that proved itself, so both
    // halves of a merged row read the same answer.
    const card = id => ({
      ...heardOf(id),
      pairedAt: trustedPeer(cfg.trusted, id)?.at ?? null,
      // And whether a switch said that yes rather than a person, which is
      // what the dialog needs to say which logins will not arrive from it.
      ...(trustedPeer(cfg.trusted, id)?.auto ? { autoPaired: true } : {}),
    });
    for (const p of [...beacon.peers.values(), ...dials.rows()]) {
      if (!stillListed(p, now())) continue;
      const met = p.manual ? dials.metAt(`${p.addr}:${p.port}`) : null;
      const id = met?.fp ?? p.fp;
      put({
        ...p,
        id,
        // How it is reached. A heard row says which route its last beacon
        // took; a typed one is read from its address.
        via: viaOf(p),
        // The fingerprint an unpair has to name. A typed row's own `fp` is
        // a placeholder built from its address and matches nothing.
        peerFp: p.manual ? met?.fp ?? null : p.fp,
        name: met?.name || p.name,
        met: !!met,
        paired: !!trustedPeer(cfg.trusted, id),
        last: lastRound.of(p.fp) ?? null,
        ...card(id),
      });
    }
    // A DECK WE ARE PAIRED WITH AND DO NOT DIAL. It called us, we accepted
    // it, and nothing here has its address — which used to mean the panel
    // listed failing addresses under "paired decks" and left out the one
    // deck that actually was.
    for (const t of cfg.trusted) {
      if (byId.has(t.fp)) continue;
      put({
        id: t.fp, fp: t.fp, peerFp: t.fp, name: t.name || t.fp, addr: "", port: 0,
        paired: true, waiting: true, last: lastRound.of(t.fp) ?? null,
        // What it is to be "here" for a deck nothing dials: it called,
        // and this is when. Undefined until it has, which is a row the
        // panel draws as unknown rather than as live.
        lastSeen: inbound.spokeAt(t.fp),
        // Which way it called, once it has.
        ...(inbound.spokeFrom(t.fp) ? { via: viaAt(inbound.spokeFrom(t.fp)) } : {}),
        // AND WHAT IT SAID WHEN IT CALLED — its card, its list, and which
        // of those it is on. The card was kept and never handed over, so
        // the dialog said "it runs an older version" about a deck that
        // had just told it exactly which version it runs.
        ...card(t.fp),
      });
    }
    return rows;
  };

  return {
    async apply(next) {
      engine = this;
      const was = cfg;
      cfg = { ...cfg, ...next };
      // What the write does to the decks already waiting — invite-only clears
      // the requests, a switch turned on answers them, the tailnet switch off
      // forgets who was heard over it. See switched in lan-requests.mjs.
      requests.switched(was);
      const restart = !was.enabled !== !cfg.enabled
        || was.secret !== cfg.secret
        || was.name !== cfg.name;
      if (!restart) { tailPoll.sync(); return; }
      this.stop(cfg.enabled);
      if (!cfg.enabled) return;
      const startedIn = generation;
      identity = identityFrom(cfg.secret);
      // Hand the caller a key to keep when there was none, so the next start is
      // the same deck rather than a stranger to everybody who paired with it.
      if (identity.secret !== cfg.secret) {
        cfg = { ...cfg, secret: identity.secret };
        onIdentity?.(identity.secret);
      }
      // The port last used, so an address somebody typed on the other machine
      // still works after this deck restarts. createSyncServer falls through to
      // an OS-chosen one when it is taken, and the caller stores whatever came
      // back — so the pin drifts to a free port rather than failing.
      const startingServer = createSyncServer({
        fp: identity.fp, pub: identity.pub, secret: identity.secret,
        name: cfg.name, handlers: serve, onError, prefer: cfg.port, host, sealFrames, ephemeral,
        // See inboundAt in lan-inbound.mjs. Every connection passes here,
        // including one that goes on to fail the handshake — a stranger who
        // cannot prove anything has still proved the path.
        onInbound: inbound.arrived,
        trusted: () => cfg.trusted,
        invite: offer.live,
        onInviteUsed: inviteUsed,
        onWrongInvite: offer.wrongInvite,
        // Asked before the request is drawn, so a deck that was told no is
        // told no again rather than becoming a row somebody has to answer
        // twice. The socket sends the reason; this only knows the name.
        declined: requests.isDeclined,
        // Read on every handshake rather than captured, so switching the mode
        // takes effect on the next caller without restarting the listener.
        inviteOnly: () => cfg.pairingMode === "invite",
        // The same helper the outbound round uses, because a deck that called
        // in and a deck this one called have proved exactly the same thing —
        // see askToAccept in lan-requests.mjs.
        onPending: requests.askToAccept,
      });
      server = startingServer;
      let port;
      try {
        port = await startingServer.start();
      } catch (err) {
        if (startedIn !== generation || server !== startingServer || !cfg.enabled) return;
        // Kept, so the panel can say it. Rethrown, because the caller's own
        // catch is what leaves the engine stopped rather than half-started.
        stalled = err?.message ?? String(err);
        throw err;
      }
      // An immediately cancelled start must not resurrect its listener or
      // beacon after stop(), or overwrite a newer start's server.
      if (startedIn !== generation || server !== startingServer || !cfg.enabled || port == null) return;
      stalled = null;
      // From here the socket is accepting, so this is the moment the silence
      // starts being about the network rather than about a deck still starting.
      inbound.listening();
      // AND THE NEXT RESTART PREFERS IT (#1740). The port is the engine's own
      // field, as the key is: prefs hands it over once per boot (see
      // lanApplyFields), so without this every later restart in the process
      // preferred the boot's value — 0 on a first run, which is a fresh random
      // port for each rename or off-and-on, and the old busy port after one
      // that moved — and addresses saved on other decks stopped answering.
      if (port !== cfg.port) {
        cfg = { ...cfg, port };
        onPort?.(port);
      }
      const startingBeacon = createBeacon({
        port, name: cfg.name, fp: identity.fp,
        trusted: () => cfg.trusted,
        // The owner's own machines on the tailnet, while the switch is on.
        unicast: () => (cfg.tailscale ? beaconTargets(tailnet?.snapshot?.() ?? null) : []),
        routeFor: addr => (!routeTo(addr) ? "lan" : cfg.tailscale ? "tailscale" : null),
        onPeer: () => onChange?.(),
        // HEARING, AS OPPOSED TO RUNNING. A deck whose discovery port another
        // program holds keeps everything else — the listener, the rounds, its
        // own beacon — and says in the panel who has the port. Asked once per
        // spell, behind the sentence that does not need the name.
        rebindMs: bindRetryMs,
        routes,
        onHearing: hearing.hearingChanged,
        onStranger: requests.heardStranger,
        onIdClash: idClash,
        onError, now,
        ...(createSocket ? { createSocket } : {}),
      });
      beacon = startingBeacon;
      await startingBeacon.start();
      if (startedIn !== generation || beacon !== startingBeacon || !cfg.enabled) return;
      // One read of the tailnet whatever the switch says, so a packet from a
      // tailnet address is told apart from a local one from the first minute.
      void tailnet?.freshen?.(TAILNET_IDLE_MS);
      tailPoll.sync();
      // The first round a minute from now, and one after each that finishes,
      // for as long as this start stands — see lan-round-timer.mjs.
      roundTimer.start(() => startedIn !== generation || beacon !== startingBeacon || !cfg.enabled);
    },
    /**
     * Make an invite: every address this deck has, its port, its name, and a
     * code, in one piece of text somebody sends however they already talk.
     *
     * EVERY ADDRESS, and that is the whole reason this exists. A person cannot
     * know which of their machine's addresses the other machine can route to —
     * a VPN, a second card, another subnet, all real and all at once — and
     * neither can this deck. The one machine that can find out is the one doing
     * the reaching, so it gets the list and tries it.
     */
    invite() {
      if (!server || !beacon) return null;
      const port = server.port();
      if (port == null) return null;
      const addrs = localAddresses().map(a => `${a}:${port}`);
      const made = mintInvite({ addrs, name: cfg.name, now: now() });
      if (!made) return null;
      offer.put(made);
      return { token: made.token, expiresAt: made.expiresAt, addrs };
    },

    /** What this deck is offering right now, and putting it away unused —
     *  see lan-invite-offer.mjs. */
    offering: offer.offering,
    withdraw: offer.withdraw,

    /**
     * Join on somebody else's invite: try every address it carries until one
     * answers, and pair with whatever does.
     *
     * IN ORDER, AND STOPPING AT THE FIRST, because the addresses are the same
     * deck seen from different networks — reaching it twice would pair one deck
     * as two. The failures are collected rather than thrown away: when none of
     * them worked, which ones were tried and what each said is the only thing
     * the reader can act on.
     */
    async join(token) {
      const inv = readInvite(token, now());
      if (!inv) return { ok: false, reason: "not_an_invite" };
      if (inv.expired) return { ok: false, reason: "expired" };
      if (!identity || !server) return { ok: false, reason: "not_running" };
      const startedIn = generation;
      const stillJoining = () => generation === startedIn && cfg.enabled && !!server;
      const tried = [];
      for (const at of inv.addrs) {
        if (!stillJoining()) return { ok: false, reason: "not_running", tried };
        let conn = null;
        try {
          conn = await connectToPeer({
            host: at.addr, port: at.port, timeoutMs: ROUND_MS,
            fp: identity.fp, pub: identity.pub, secret: identity.secret,
            name: cfg.name, myPort: server.port(), code: inv.code,
            // MAKE IT PROVE IT HOLDS THE CODE. Without this the loop pinned
            // whatever answered first, and the addresses in a token are only as
            // trustworthy as the network they name: `localAddresses` keeps
            // RFC1918, so a container bridge address or a lease that has since
            // moved to somebody else's machine is an ordinary thing to find in
            // one. Stopping at the first that ANSWERS is right; stopping at the
            // first that answers CORRECTLY is what it was supposed to mean.
            inviteProvesBack: inv.provesBack,
            sealFrames, ephemeral,
          });
          // The handshake can complete after LAN was switched off (or the
          // identity was restarted). Never persist a pin from that old join.
          if (!stillJoining()) return { ok: false, reason: "not_running", tried };
          const { list } = pin({ fp: conn.peerFp, pub: conn.peerPub, name: conn.peerName || inv.name });
          keepDialling(at.addr, at.port, { fp: conn.peerFp, name: conn.peerName || inv.name });
          onTrust?.(list);
          onChange?.();
          return {
            ok: true,
            peer: { fp: conn.peerFp, name: conn.peerName || inv.name, addr: at.addr, port: at.port },
            tried,
          };
        } catch (err) {
          tried.push({ addr: `${at.addr}:${at.port}`, why: err.message });
        } finally {
          conn?.sock?.destroy();
        }
      }
      return { ok: false, reason: "unreachable", tried };
    },

    /**
     * Accept a deck, which is the only thing that lets anything move.
     *
     * It takes the fingerprint AND the key that was seen with it, from the
     * pending or heard list — never from whatever is at an address now, because
     * the point of pinning is that the thing answering later has to be the same
     * thing. A fingerprint nobody has actually met is refused rather than
     * trusted on a name somebody typed.
     */
    accept(fp, { byHand = true } = {}) {
      const seen = requests.seen(fp);
      if (!seen || cfg.pairingMode === "invite") return null;
      if (wasUnpaired(fp) && !byHand) return null;
      // TWO KINDS OF ROW, AND THEY ARE NOT THE SAME CLAIM.
      //
      // A deck that ASKED finished a handshake, so it held the private half of
      // the key it announced and that key can be pinned right here. A deck we
      // merely HEARD has only shouted: a beacon carries a fingerprint and no
      // key, and pinning a fingerprint with no key to check it against later is
      // worse than not pinning at all — it looks like a pairing and is not one.
      //
      // So accepting a heard deck starts a conversation rather than ending one:
      // its address goes on the dial list, the next round reaches it and pins
      // whatever answers, and its owner gets the same request to accept. Which
      // is the same two presses, in the other order.
      if (!seen.pub) {
        if (!seen.addr || !seen.port) return null;
        markUnpaired(fp, false);
        // `byHand` IS WHAT THE ROW WILL BE ALLOWED TO DO LATER. A press here is
        // a person naming a machine, so the row may be pinned on the round that
        // reaches it. `autoAsk` reaches this same line with byHand false — the
        // deck answering a shout — and the row it leaves may only ASK, which is
        // what the switch's own name says it does. See roundWith.
        this.addPeer(seen.addr, seen.port, { typed: byHand });
        requests.dropHeard(fp);
        onChange?.();
        return { fp, name: seen.name, addr: seen.addr, port: seen.port, dialled: true };
      }
      // THE SWITCH HAS A BUDGET OF ITS OWN (#1737) — see MAX_AUTO_PINS.
      //
      // REFUSED RATHER THAN MAKING ROOM, which is the opposite of the dial
      // list's choice and for a reason. Evicting a dial row the deck added
      // undoes nothing anybody chose; evicting a pin is an unpair nobody asked
      // for, of a deck that may be one of the owner's own machines — and which
      // pins ever finished a round is known only in memory, so after a restart
      // there is no telling. Past the cap the switch simply stops pressing,
      // and the request waits in the panel for a person, as it would with the
      // switch off.
      const bySwitch = cfg.trusted.filter(t => t?.auto === true).length;
      if (!byHand && !trustedPeer(cfg.trusted, fp) && bySwitch >= MAX_AUTO_PINS) return null;
      const { list, added } = pin({ fp, pub: seen.pub, name: seen.name }, { auto: !byHand });
      requests.drop(fp);
      onTrust?.(list);
      onChange?.();
      // AND DIAL IT BACK. Accepting a deck that called us made it welcome and
      // left this one with no way to reach it: the peer list is what this deck
      // dials, and an inbound connection puts nothing in it. So the pairing was
      // mutual in the trusted list and one-way in fact — if the other machine
      // stopped calling, nothing here would ever call it. The hello carries the
      // port it listens on for exactly this. AND KEPT, through onDial, as an
      // invite's is (#1643): `addPeer` alone lives in memory, and the next
      // settings write or restart made the pairing one-way again.
      //
      // ONLY A PERSON'S ACCEPT IS KEPT, OR COUNTED AS TYPED (#1737). The row
      // the switch leaves is one the deck added itself, the way a beacon's is:
      // capped by MAX_AUTO_PEERS, in memory only, and never written into prefs
      // as an address somebody named — the port in a hello is whatever the
      // caller claimed. After a restart such a deck is reached as any paired
      // deck is: by its beacon, or by calling in (see learnCaller).
      const back = seen.addr && seen.port && this.addPeer(seen.addr, seen.port, { typed: byHand })
        ? (dials.meet(`${seen.addr}:${seen.port}`, { fp, name: seen.name || "" }),
           byHand && onDial?.(`${seen.addr}:${seen.port}`),
           { addr: seen.addr, port: seen.port })
        : null;
      return added ? { fp, name: seen.name, addr: seen.addr, port: seen.port ?? null, dialBack: back } : null;
    },
    /** Say no and stop being asked, and change your mind — see dismiss and
     *  allow in lan-requests.mjs. */
    dismiss: requests.dismiss,
    allow: requests.allow,
    /** Unpair. It stops what has not happened yet and takes back nothing that
     *  has — the same sentence the panel says about a shared login. */
    unpair(fp) {
      const list = dropTrusted(cfg.trusted, fp);
      if (list.length === cfg.trusted.length) return false;
      cfg = { ...cfg, trusted: list };
      lastGood.delete(fp);
      markUnpaired(fp, true);
      onTrust?.(list);
      onChange?.();
      return true;
    },
    round,
    /**
     * One deck, now — the `check now` in that deck's own dialog.
     *
     * Found the way the list found it: heard on the network under its own
     * fingerprint, or dialled at an address whose answer was that fingerprint.
     * Null when it is neither, which is a deck that only calls in — nothing
     * here holds an address for it, so there is nobody to dial.
     *
     * `roundAt` (see lan-round-record.mjs) is left alone: it says when EVERY
     * paired deck was last asked, and asking one of them does not make that
     * true.
     *
     * IN TURN, LIKE EVERY ROUND (#1132). This called `roundWith` straight, past
     * the guard `round` keeps, and a press during the timer's round dialled the
     * deck that round was mid-way through healing from: the far side exported
     * `[5, 5]` and this side imported twice. fillEmptySlot's verdict inside the
     * lock limited what the second write could do on the forced path; it did
     * not stop the dial, the export, or a second write behind one verdict.
     *
     * WHAT IS ALREADY RUNNING IS THE ANSWER, WHEN IT HAS ONE. The press waits
     * for everything ahead of it, and if an ask of this deck finished in that
     * time — the round was dialling it when the press landed, or reached it
     * after — that ask was the check, and its result is returned instead of
     * asking again. A second ask would be a second dial for nothing, and it
     * would also be WORSE for the person who pressed. The dialog does not read
     * this list: it redraws from `lastRound`, where a login that moved says
     * "arrived last round". An ask after a heal finds that login healthy —
     * importAccount drops the accounts cache, so the next read is claude-swap's
     * — moves nothing, and writes that over the record. The lane repaired from
     * this very deck a moment ago would stop saying so, in answer to the press
     * that asked about it.
     *
     * AND ONLY THEN. When nothing that ran asked this deck after the press — the
     * round had been past it already, or never had it on its list, as with a
     * deck first heard mid-round — joining would be a check that checked
     * nothing. So it asks this deck itself, in its turn, behind whatever was
     * ahead of it and never beside it. Told apart by the record, not the clock:
     * every ask writes a new one, so the same object before and after means
     * nothing here asked this deck since the press. Keyed by the ROW, because
     * that is what roundWith writes under, and a typed row's `fp` is the
     * placeholder built from its address rather than the fingerprint asked for.
     */
    async roundOne(fp) {
      if (!beacon || typeof fp !== "string" || !fp) return null;
      const heard = [...beacon.peers.values()].find(p => p.fp === fp && dialsHeard(p));
      const typed = dials.rowAnswering(fp);
      const peer = heard ?? typed;
      if (!peer) return null;
      const had = lastRound.of(peer.fp);
      await turns.ahead();
      const got = lastRound.of(peer.fp);
      if (got && got !== had) return got.done ?? [];
      // A deck switched off while the press waited is not dialled after all.
      return turns.inTurn(() => (beacon ? roundWith(peer) : []));
    },
    /** Dial this address on every round from now on; false for an address
     *  that is not one. The list, its cap and why a typed row outranks one the
     *  deck added are lan-dials.mjs's. */
    addPeer(addr, port, { typed = true } = {}) { return dials.add(addr, port, { typed }); },
    removePeer(addr, port) { return dials.remove(addr, port); },
    /** Replace the typed list wholesale, which is what a settings write means
     *  — see replace in lan-dials.mjs. */
    setPeers(entries) { return dials.replace(entries); },
    status() {
      return {
        enabled: !!cfg.enabled,
        running: !!beacon,
        // Said only while it is true, and it is only ever true of a deck that
        // is switched on and has no listener.
        stalled: cfg.enabled && !beacon ? stalled : null,
        // Running, and unable to hear other decks announce — see deafLine in
        // lan-hearing.mjs.
        deaf: hearing.deafLine(),
        // Every local broadcast held back, because this machine sends its
        // local network through a tunnel — see leavesByTunnel.
        lanTunneled: !!beacon?.tunneled?.(),
        // When every paired deck was last asked. Null until the first round,
        // which on a deck that has just started is the honest answer.
        checkedAt: lastRound.checkedAt(),
        name: cfg.name,
        // This deck's own card, so the panel can read a peer's version against
        // it; and the names somebody here gave other decks, which the panel
        // and the request dialog draw in place of the ones those decks chose.
        about: about ?? null,
        aliases: { ...(cfg.aliases ?? {}) },
        // Whether this deck asks on its own, and whether a request that
        // arrives is answered here or answered for you.
        autoAsk: !!cfg.autoAsk,
        autoAccept: !!cfg.autoAccept,
        pairingMode: cfg.pairingMode === "invite" ? "invite" : "automatic",
        // Whether paired decks are told which shared account this one is on.
        shareActive: cfg.shareActive !== false,
        // Discovery over Tailscale: whether this machine has it at all, which
        // decides whether the dialog shows the switch, and what it can see.
        tailscale: tailnet ? tailnetStatus() : null,
        fp: identity?.fp ?? null,
        // The address and port a person on another subnet types into the other
        // deck's field. Null when this machine has no ordinary one, which the
        // panel says rather than printing a placeholder.
        port: server?.port() ?? null,
        // When another machine last got a connection through to this one. Null
        // on a deck nobody has dialled yet, which is not the same as blocked
        // and is drawn as neither — see inboundAt in lan-inbound.mjs and
        // lan-reach.mjs.
        inboundAt: inbound.inboundAt(),
        // How long that null has been true for — see listeningSince there.
        listeningSince: inbound.listeningSince(),
        addrs: beacon ? localAddresses() : [],
        shared: [...cfg.shared],
        // The token this deck is offering, if any. Drawn as the one thing to do
        // when nobody is paired yet, and put away once somebody is. With how
        // many proofs of it have failed so far — the record beside the log's,
        // see wrongInvite in lan-invite-offer.mjs.
        invite: offer.row(),
        // Decks somebody accepted, decks that asked and have not been answered,
        // and decks merely heard. Three lists because they are three different
        // things a person does something different about.
        trusted: cfg.trusted.map(t => ({ fp: t.fp, name: t.name })),
        pending: requests.pendingRows(),
        // Only the ones somebody could actually pair with right now, one row
        // per machine, newest first — see pairable, which is where the rule
        // that keeps this from becoming a wall of ghosts lives.
        strangers: requests.strangerRows(),
        // Said no to, by somebody at this keyboard. Listed rather than merely
        // silenced, because a refusal nobody can see is a refusal nobody can
        // take back.
        declined: requests.declinedRows(),
        peers: beacon ? deckRows() : [],
      };
    },
    stop(restarting = false) {
      generation++;
      if (!restarting) session++;
      roundTimer.stop();
      tailPoll.stop();
      hearing.forget();
      // A deliberate stop is not a fault, and the next start says its own.
      if (!cfg.enabled) stalled = null;
      beacon?.stop();
      server?.stop();
      beacon = null;
      server = null;
      // Nothing is listening, so nothing is being silent AT anybody. Leaving
      // this set would have the next start measure its quiet from the last one.
      inbound.closed();
    },
  };
}
