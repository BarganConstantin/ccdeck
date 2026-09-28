// Who has called this deck, and for how long anybody could have: lifted out of
// createEngine in lan-engine.mjs with the four records only these write — when
// each paired deck last spoke and from where, when another machine last got a
// connection through, and when the listener came up. Nothing here listens:
// serve (lan-serve.mjs) and the listener's onInbound report each call, and
// status() and the peer list read what they left.

/**
 * Did this connection come from a DIFFERENT computer?
 *
 * The question behind "can other decks reach this one": a socket accepted from
 * loopback, or from one of this machine's own addresses, is the second deck on
 * this computer talking to the first — which happens on every developer machine
 * and proves nothing at all about the network. Both spellings of loopback are
 * named because both arrive: `127.0.0.1` from a deck that dialled an address
 * and `::1` from one that dialled a name.
 *
 * Pure and separate from the engine so the case that matters — a connection
 * from somewhere else — can be tested without a second machine.
 */
export const anotherMachine = (from, mine = []) => {
  const at = String(from ?? "").replace(/^::ffff:/, "").trim();
  return !!at && at !== "127.0.0.1" && at !== "::1" && !mine.includes(at);
};

/**
 * `localAddresses` answers this machine's own addresses at the moment of
 * asking — see localAddresses in lan-engine.mjs — and `now` is the engine's
 * clock.
 */
export function createInbound({ now, localAddresses }) {
  /**
   * When each paired deck last SPOKE TO THIS ONE, keyed by fingerprint.
   *
   * The panel had no evidence at all about a deck it does not dial. A deck that
   * calls in has no beacon row here (if it had one it would be dialled), never
   * appears in `lastRound`, and its `lastSeen` was therefore undefined forever
   * — so the row was drawn as live on the strength of being paired, and a
   * Windows deck that had been closed for an hour still read `ready`. Reported
   * from a screenshot of exactly that.
   *
   * Every authenticated frame lands in `serve`, which is the one place that
   * knows a paired deck is on the other end of an open socket right now. That
   * is the evidence, and it is the same kind the beacon gives: a timestamp.
   */
  const spokeAt = new Map();
  /** And the address it spoke FROM, so a deck that only ever calls in can
   *  still be said to come over the tailnet or the local network — it has no
   *  address of its own here, and without this its row could not say which. */
  const spokeFrom = new Map();
  /**
   * When a connection from ANOTHER MACHINE last arrived on the sync listener.
   *
   * The one fact that settles "can other decks reach this one", and the only
   * one on the whole question that is measured rather than reasoned about: a
   * firewall's configuration is read through three different tools on three
   * platforms, one of which (`ufw`) refuses to show its rules to a process
   * that is not root. An accepted socket needs none of that — the packets got
   * in, whatever any rule file says.
   *
   * ANOTHER MACHINE, checked here and not in the socket: a connection from
   * loopback or from one of this machine's own addresses is the second deck on
   * this computer, which proves nothing about the network. The socket does not
   * hold that list; this does.
   */
  let inboundAt = null;

  /** When this deck's listener came up, or null while it is down.
   *
   *  THE OTHER HALF OF `inboundAt`. On its own, "nothing has ever connected in"
   *  says nothing: a deck that started four seconds ago has the same null as one
   *  that has been listening all afternoon while the network talked around it.
   *  What makes the silence evidence is how long it has gone on for, and that is
   *  a number only the engine holds. See silentInbound in lan-reach.mjs, which
   *  is the one verdict in this feature that works on a platform nothing can be
   *  asked about. */
  let listeningSince = null;

  return {
    /** A paired deck is talking to this one, now, over the socket `ctx` is
     *  serve's for — see spokeAt. */
    spoke(ctx) {
      spokeAt.set(ctx.peerFp, now());
      const from = ctx.peerAddr || String(ctx.sock?.remoteAddress ?? "").replace(/^::ffff:/, "");
      if (from) spokeFrom.set(ctx.peerFp, from);
    },
    /** When that deck last spoke, and from which address: undefined until it
     *  has. */
    spokeAt: fp => spokeAt.get(fp),
    spokeFrom: fp => spokeFrom.get(fp),
    /** A connection arrived on the listener from `from`, handshake or not —
     *  see inboundAt. */
    arrived(from) { if (anotherMachine(from, localAddresses())) inboundAt = now(); },
    inboundAt: () => inboundAt,
    /** The listener came up, or went down — see listeningSince. */
    listening() { listeningSince = now(); },
    closed() { listeningSince = null; },
    listeningSince: () => listeningSince,
  };
}
