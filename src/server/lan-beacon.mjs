// The shouting half of the sockets: the UDP beacon that tells the network this
// deck is here, and hears every other deck that says the same. lan-socket.mjs
// is the other half — the listener that answers and the dialler that calls —
// and, as there, every decision this makes lives in lan-sync.mjs.
//
// A DECK HEARS ITSELF. Measured, not assumed: a broadcast to 255.255.255.255
// comes back to every socket on the sending machine bound to that port, from
// the machine's own LAN address rather than from loopback. That is what makes
// two decks on one machine find each other — which is how this gets tested at
// all — and it is why self-recognition is by fingerprint rather than by
// address.
import dgram from "node:dgram";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { looksLikeTunnel } from "./route-via.mjs";
import {
  beaconPayload, beaconVerdict, hostId, notePeer, readBeacon,
  ANNOUNCE_MS, MAX_BEACON_BYTES,
} from "./lan-sync.mjs";

/** An IPv4 dotted quad as four numbers, or null for anything that is not one. */
function quad(text) {
  const parts = String(text ?? "").split(".");
  if (parts.length !== 4) return null;
  const out = parts.map(p => Number(p));
  return out.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? out : null;
}

/**
 * The address that reaches every host on one interface's own subnet.
 *
 * `address | ~netmask`, which is the definition. Null for a /32, because a
 * point-to-point link — a VPN tunnel, `utun` on macOS — has a directed
 * broadcast equal to its own address, and sending a beacon to ourselves down a
 * tunnel is a packet nobody wanted.
 */
export function directedBroadcast(address, netmask) {
  const a = quad(address);
  const m = quad(netmask);
  if (!a || !m) return null;
  if (m.every(o => o === 255)) return null;
  return a.map((o, i) => o | (~m[i] & 255)).join(".");
}

/**
 * Where a beacon has to go to be heard on this machine's networks.
 *
 * The limited broadcast first, because it is the one that works where a router
 * or an access point filters the directed form, and because it is what every
 * deck before this version sent — a machine that was fine stays fine. Then one
 * per interface, which is what a multi-homed host actually needs: see announce.
 *
 * Loopback and IPv6 are skipped. A deck on `lo0` can only hear itself, and this
 * protocol is IPv4 broadcast by construction — there is no such thing as an
 * IPv6 broadcast address.
 */
export function broadcastTargets(ifaces) {
  return broadcastPlan(ifaces).map(p => p.to);
}

/**
 * The same targets, each with the interface whose subnet it is — null for the
 * limited broadcast, which is nobody's. What lets a beacon be held back when
 * the machine would send it out by some OTHER interface: see leavesByTunnel.
 */
export function broadcastPlan(ifaces) {
  const out = [{ to: "255.255.255.255", iface: null }];
  for (const [name, list] of Object.entries(ifaces ?? {})) {
    for (const ni of list ?? []) {
      if (!ni || ni.internal) continue;
      // Node 18 reports `family` as the string "IPv4"; older shapes used 4.
      if (ni.family !== "IPv4" && ni.family !== 4) continue;
      const to = directedBroadcast(ni.address, ni.netmask);
      if (to && !out.some(p => p.to === to)) out.push({ to, iface: name });
    }
  }
  return out;
}

/**
 * Would this broadcast leave the local network?
 *
 * A directed broadcast belongs to the interface whose subnet it is, so the
 * machine sending it out by any other one means something rerouted the local
 * network — a VPN, or a Tailscale exit node without local network access —
 * and the beacon would come out on the far end of the tunnel. The limited
 * broadcast belongs to none, so it is held back only when it would go into
 * something that is plainly a tunnel. Unknown answers nothing: send.
 */
export function leavesByTunnel(target, via, isTunnel) {
  if (!via) return false;
  if (target.iface) return via !== target.iface;
  return isTunnel(via);
}

/** The one fixed port in the feature. Out of the deck's HTTP range (4317-4400)
 *  so a beacon can never be mistaken for a deck's own traffic, and unassigned:
 *  45317 reads as "4317, elsewhere", which is what a person tracing this in a
 *  firewall log needs it to say. */
export const DISCOVERY_PORT = 45_317;

/** The shortest gap between two "I am here too" replies to a stranger. Long
 *  enough that a burst of decks starting together cannot make a storm, short
 *  enough that starting two decks by hand feels instant. */
const REPLY_COOLDOWN_MS = 2_000;

/**
 * The shouting half.
 *
 * `reuseAddr` is not a convenience: without it a second deck on the same
 * machine cannot bind the discovery port at all, and two decks on one machine
 * is both a real setup and the only way this gets tested here.
 *
 * Errors are reported, never thrown. A machine with no route, a firewall that
 * refuses the bind, an interface that comes and goes with a VPN — none of them
 * is a reason for the deck to fall over, and all of them are reasons for the
 * panel to be able to say what happened.
 */
export function createBeacon({
  port, name, fp, onPeer, onStranger, onError, onIdClash, now = Date.now,
  /** The decks somebody has accepted, read fresh each packet so an accept takes
   *  effect immediately rather than at the next restart. */
  trusted = () => [],
  // Injected so the suite can drive this with a socket it controls. CI runners
  // are not a network: GitHub's have no broadcast domain worth the name, and a
  // test that quietly skipped there would be a test that stopped testing
  // without saying so. The REAL socket is exercised by hand, two decks on one
  // machine, which works because a broadcast comes back to its own host.
  createSocket = opts => dgram.createSocket(opts),
  // Injected for the same reason, and read PER ANNOUNCE rather than once: a
  // laptop that joins a network, or brings a VPN up, grows an interface without
  // restarting the deck, and a list captured at start would announce to the
  // addresses it had at breakfast.
  ifaces = () => networkInterfaces(),
  /**
   * Addresses to send the beacon to one by one, beside the broadcast — the
   * owner's machines on Tailscale, whose tunnel carries no broadcast at all.
   * Read per announce like `ifaces`, because the tailnet list is re-read while
   * the deck runs and a machine that just came online belongs in the next one.
   */
  unicast = () => [],
  /**
   * Which way a packet from this address came: "lan", "tailscale", or null for
   * one to ignore entirely. Null is what a tailnet packet gets while this
   * deck's Tailscale switch is off — the sockets hear it either way, because
   * they bind every interface, and off has to mean the deck does not act on it.
   */
  routeFor = () => "lan",
  /** How long to wait before trying the discovery port again while another
   *  program holds it, and who to tell when hearing stops or comes back. */
  rebindMs = 30_000,
  onHearing,
  /**
   * Where the machine would send each broadcast — see createRouteCheck in
   * route-via.mjs. Absent, every broadcast goes, as before; the suite's
   * beacons have none.
   */
  routes = null,
} = {}) {
  // Randomised per process. Two beacons from one fingerprint with different
  // instance ids mean the deck restarted between them, which is the signal to
  // drop any session held for it rather than resume into a process that is gone.
  const instance = randomBytes(8).toString("hex");
  /** Which computer this is, as opposed to which process or which key. Derived
   *  once per beacon rather than per packet: it cannot change while a process
   *  is running, and hashing a hostname thirty seconds apart forever is work
   *  nobody asked for. See hostId. */
  const host = hostId();
  const peers = new Map();
  let sock = null;
  /**
   * The socket beacons LEAVE by, on a port of its own. See start.
   *
   * Null until it is bound, and whenever it could not be — the listening
   * socket then sends as it always did, because a beacon from the wrong port is
   * still a beacon and none at all is a deck nobody finds.
   */
  let out = null;
  let timer = null;
  /**
   * Whether this deck can HEAR — whether it holds the discovery port.
   *
   * SEPARATE FROM RUNNING, because a deck that cannot bind 45317 is still most
   * of a deck. It announces from its own socket, so every other deck still
   * finds it, asks it and dials it; what it has lost is hearing them announce.
   * Stopping the whole feature over that — which is what this did — took a
   * working sync away from somebody whose Tailscale exit node happened to be
   * holding the port. It keeps trying for the port instead, and takes it back
   * the moment it is free.
   */
  let hearing = false;
  let deafError = null;
  /** Whether the last announce held back every broadcast because the local
   *  network goes through a tunnel here — see leavesByTunnel. */
  let tunneled = false;
  let told = null;
  let rebind = null;
  let stopped = true;
  // Socket binds finish asynchronously. A stopped start must not attach its
  // late socket to a subsequent start or leave an outbound socket open.
  let startGeneration = 0;
  /** When this deck last answered a deck it had not heard, so answering cannot
   *  become a storm, and which decks it has already answered — without the
   *  second, a deck that is never accepted is answered again on every packet
   *  for as long as both are running. */
  let repliedAt = 0;
  const answered = new Set();

  const payload = () => Buffer.from(JSON.stringify(beaconPayload({ name, fp, port, instance, host })));

  const announce = (also = []) => {
    if (!sock && !out) return;
    const announcedIn = startGeneration;
    // EVERY BROADCAST ADDRESS THIS MACHINE HAS, not one.
    //
    // This used to send only to 255.255.255.255, on the argument that the
    // limited broadcast "needs nothing" while a subnet-directed one needs the
    // netmask of whichever interface the packet leaves by. The argument is
    // sound and the machine disagreed with it. Measured on a Mac with Wi-Fi and
    // a VPN tunnel up, from a bare node process with no deck involved:
    //
    //   send to 255.255.255.255  ->  EHOSTUNREACH
    //   send to 192.168.1.255    ->  sent ok
    //
    // On a multi-homed host the limited broadcast has no single interface to
    // leave by, and macOS refuses it rather than choosing. The deck went on
    // announcing into nothing for as long as that machine was up: it could still
    // HEAR colleagues, because receiving is per-port and not per-address, so the
    // symptom was one-sided and looked like everybody else's problem.
    //
    // So the limited form stays — it is the one that works where a directed
    // broadcast is filtered, and it is what Syncthing sends — and every
    // interface's own directed broadcast goes out beside it. A duplicate packet
    // costs one datagram; a missing one costs the whole feature.
    const plan = broadcastPlan(ifaces());
    // Asked behind the send, and read from what was last answered: the first
    // beacon after a start goes as it always did, and the ones after it know.
    void routes?.want?.(plan.map(p => p.to));
    const kept = routes ? plan.filter(p => !leavesByTunnel(p, routes.via(p.to), looksLikeTunnel)) : plan;
    tunneled = kept.length === 0;
    const targets = kept.map(p => p.to);
    const from = out ?? sock;
    let left = targets.length;
    const failed = [];
    for (const to of targets) {
      from.send(payload(), DISCOVERY_PORT, to, err => {
        // A send may finish after this socket has closed and a new LAN
        // session has started. Its result says nothing about the new session.
        if (stopped || announcedIn !== startGeneration) return;
        if (err) failed.push(`${to} (${err.code ?? err.message})`);
        // REPORTED ONLY WHEN EVERY ONE FAILED. One address being unreachable is
        // the ordinary state of a machine with a VPN up, and a panel that said
        // so every thirty seconds would be crying wolf about a working deck.
        // No address working at all is a deck nobody can discover, which is
        // exactly what the panel is for.
        if (--left === 0 && failed.length === targets.length) {
          onError?.("announce", new Error(`no broadcast address worked — ${failed.join(", ")}`));
        }
      });
    }
    // AND ONE PACKET PER TAILNET MACHINE. Not part of the verdict above: a node
    // that has gone to sleep since the list was read is the ordinary state of a
    // laptop, and it says nothing about whether this deck can be discovered.
    let direct = [];
    try { direct = [...(unicast() ?? []), ...also]; } catch { direct = [...also]; }
    for (const to of new Set(direct)) {
      if (typeof to !== "string" || !to || targets.includes(to)) continue;
      from.send(payload(), DISCOVERY_PORT, to, () => {});
    }
  };

  const onMessage = (msg, rinfo) => {
    // A queued UDP callback can run after close(). It belongs to the stopped
    // discovery session and must not repopulate peers or invite strangers.
    if (stopped) return;
    // Everything about whether to care lives in lan-sync.mjs. This hands it
    // the bytes and the address and does what it is told.
    if (msg.length > MAX_BEACON_BYTES) return;
    let via = "lan";
    try { via = routeFor(rinfo.address); } catch { via = "lan"; }
    if (!via) return;
    const beacon = readBeacon(msg);
    const verdict = beaconVerdict(beacon, { selfFp: fp, selfInstance: instance, selfHost: host, trusted: trusted() });
    // ANSWER A DECK WE HAVE NEVER HEARD, once, WHOEVER IT IS — and that last
    // part is the change. It used to answer only a deck already in the group,
    // which was fine when a group existed. Now the first thing a new deck has
    // to become is a row on somebody's screen, and it cannot become one if
    // this deck never tells it that it exists.
    //
    // Measured on two real decks before any of this: deck 1 saw deck 2 the
    // instant it started and deck 2 saw nobody, because deck 1's own
    // immediate announce went out before deck 2 was listening. Thirty seconds
    // of an empty list is how a working feature reads as broken.
    //
    // At most once every few seconds, because the obvious version is a shout
    // storm: two decks answering each other's answers forever. A new pair
    // converges in two extra packets.
    const newToUs = beacon && verdict !== "self" && verdict !== "id-clash" && verdict !== "unreadable"
      && !peers.has(beacon.fp) && !answered.has(beacon.fp);
    if (newToUs && now() - repliedAt > REPLY_COOLDOWN_MS) {
      repliedAt = now();
      answered.add(beacon.fp);
      // A deck that reached this one over the tailnet is answered there too:
      // a broadcast never gets back down its tunnel.
      announce(via === "tailscale" ? [rinfo.address] : []);
    }
    if (verdict !== "peer") {
      // Another deck may be using this one's key — see beaconVerdict. Reported
      // with where the beacon says that deck listens, rather than acted on
      // here: this file carries packets, and finding out whether anything
      // there holds the key, and choosing a new identity if it does, belong to
      // whoever stores it.
      if (verdict === "id-clash") onIdClash?.({ addr: rinfo.address, port: beacon.port });
      // A DECK NOBODY HAS ACCEPTED. It is not refused and not silently
      // dropped: it is a name and an address on the same network, which is a
      // row somebody can accept. Nothing is asked of it and nothing is
      // offered to it until they do.
      if (verdict === "stranger") {
        onStranger?.({
          fp: beacon.fp, name: beacon.name, addr: rinfo.address, port: beacon.port,
          // Carried through so the list can show one row per machine rather
          // than one per key that machine has ever held.
          host: beacon.host, at: now(), via,
        });
      }
      return;
    }
    const noted = notePeer(peers, beacon, rinfo.address, now(), via);
    if (noted.changed || noted.restarted) onPeer?.(noted);
  };

  /** Tell whoever asked, once per change rather than once per try. */
  const tell = now => {
    if (told === now) return;
    told = now;
    onHearing?.(now);
  };

  /** One try at the discovery port: the listening socket, or the error that
   *  kept it. A bind that fails never calls back; it arrives as an error. */
  const listen = (startedIn) => new Promise(resolve => {
    let s;
    try { s = createSocket({ type: "udp4", reuseAddr: true }); } catch (err) { resolve({ err }); return; }
    let bound = false;
    s.on("error", err => {
      if (bound) {
        if (!stopped && startedIn === startGeneration) onError?.("socket", err);
        return;
      }
      try { s.close(); } catch { /* never opened */ }
      resolve({ err });
    });
    // close() can leave a message callback queued. After restart, stopped is
    // false again, so the socket's own generation must also be checked.
    s.on("message", (msg, rinfo) => {
      if (startedIn !== startGeneration) return;
      onMessage(msg, rinfo);
    });
    s.bind(DISCOVERY_PORT, "0.0.0.0", () => {
      bound = true;
      try { s.setBroadcast(true); } catch (err) { onError?.("broadcast", err); }
      resolve({ sock: s });
    });
  });

  const tryListen = async (startedIn) => {
    if (stopped || startedIn !== startGeneration) return;
    const got = await listen(startedIn);
    if (stopped || startedIn !== startGeneration) { try { got.sock?.close(); } catch { /* gone */ } return; }
    if (got.sock) {
      sock = got.sock;
      hearing = true;
      deafError = null;
      tell(true);
      return;
    }
    hearing = false;
    deafError = got.err;
    tell(false);
    rebind = setTimeout(() => { rebind = null; void tryListen(startedIn); }, rebindMs);
    rebind.unref?.();
  };

  /**
   * The socket beacons leave by, bound to whatever port the OS gives it.
   *
   * SENT FROM A PORT OF ITS OWN, NOT FROM 45317. Nothing that hears a beacon
   * reads the port it came from — the reply goes to 45317 whatever the source
   * — and sending from the discovery port gave that port away. Measured on a
   * Mac that is a Tailscale exit node: a deck elsewhere on the tailnet routed a
   * beacon through it, and Tailscale's forwarder binds its end of every UDP
   * flow to the CLIENT's source port (netstack.go, forwardUDP), idling it out
   * after two minutes. A beacon every thirty seconds never idles, so the Mac's
   * own deck could never bind 45317 again. From an ephemeral port, the
   * forwarder takes an ephemeral port.
   */
  const openOut = () => new Promise(resolve => {
    let o;
    try { o = createSocket({ type: "udp4" }); } catch { resolve(null); return; }
    let opened = false;
    o.on("error", err => {
      if (opened) { onError?.("socket", err); return; }
      opened = true;
      try { o.close(); } catch { /* never opened */ }
      resolve(null);
    });
    o.bind(0, "0.0.0.0", () => {
      if (opened) return;
      opened = true;
      try { o.setBroadcast(true); } catch (err) { onError?.("broadcast", err); }
      resolve(o);
    });
  });

  const start = async () => {
    const startedIn = ++startGeneration;
    stopped = false;
    told = null;
    await tryListen(startedIn);
    if (stopped || startedIn !== startGeneration) return;
    const opened = await openOut();
    if (stopped || startedIn !== startGeneration) {
      try { opened?.close(); } catch { /* already closed */ }
      return;
    }
    out = opened;
    // Immediately, not on the next tick. Syncthing's rule: a deck that just
    // came up should appear now rather than up to thirty seconds later, which
    // is the difference between "it works" and "it seems broken" for anybody
    // who starts two decks and watches.
    announce();
    timer = setInterval(announce, ANNOUNCE_MS);
    timer.unref?.();
  };

  return {
    start,
    announce,
    peers,
    /** Whether this deck holds the discovery port, and why not when it does
     *  not. */
    hearing: () => hearing,
    deafError: () => deafError,
    tunneled: () => tunneled,
    stop() {
      stopped = true;
      startGeneration++;
      if (timer) clearInterval(timer);
      timer = null;
      if (rebind) clearTimeout(rebind);
      rebind = null;
      hearing = false;
      try { sock?.close(); } catch { /* already closed */ }
      sock = null;
      try { out?.close(); } catch { /* already closed */ }
      out = null;
    },
  };
}
