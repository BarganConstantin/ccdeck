// The addresses this deck dials that the beacon did not hand it — typed in,
// pressed accept on, joined by invite, asked from a beacon, or learned from a
// paired deck that called in — and what answered at each: lifted out of
// createEngine in lan-engine.mjs with the three collections only they used.
// Nothing here dials; a round in the engine walks rows() and reports back
// through answered() and failed().

/**
 * The most addresses `autoAsk` may put on the dial list on its own.
 *
 * Measured, because the shape of it is not the obvious one: the dial list is
 * keyed `host:port`, not by fingerprint, so five hundred beacons from one
 * address on one port make one row. Five hundred beacons from one address on
 * five hundred PORTS make five hundred rows, and a round dials them one at a
 * time with a ROUND_MS bell on each — so a list that size is eighty minutes of
 * round, and the decks somebody actually paired with sit at the end of it
 * waiting their turn. The ceiling on that without this number is 65,535 rows
 * from a single host.
 *
 * It bounds only what the deck added BY ITSELF. Addresses a person typed are
 * not capped: a list of those is somebody's own decision and the deck is in no
 * position to tell them they have too many machines.
 */
export const MAX_AUTO_PEERS = 32;

export function createDials() {
  /** Peers the user typed in, which the beacon will never find.
   *
   *  Broadcast dies at the first router and is dropped by a switch that
   *  filters it, so a deck across a VPN or on another subnet is unreachable by
   *  discovery and perfectly reachable by address. Typing one is a decision to
   *  trust whatever answers there the first time, and to pin it: an address is
   *  a way to reach a deck, and the accept on the other machine is what lets
   *  anything move.
   *
   *  Keyed by `host:port` rather than by fingerprint, because a fingerprint is
   *  what a deck says about itself after the handshake and this list has to
   *  exist before there has been one.
   *
   *  EVERY ROW SAYS WHERE IT CAME FROM, in `typed`, and the difference decides
   *  whether reaching it may pin a key sight unseen. A row somebody put in the
   *  address field — or pressed accept on, or joined by invite — is a person
   *  naming a machine. A row `autoAsk` added from a beacon is this deck
   *  answering a shout, which is not the same claim and must not read as one.
   *  See roundWith in lan-engine.mjs, where the difference is the whole of the
   *  trust rule. */
  const manual = new Map();
  /** What answered at a typed address, once something has. Keyed the same way
   *  `manual` is, because until a connection succeeds an address is all there
   *  is to key on. */
  const learned = new Map();
  /** Addresses this deck added because a paired deck called in from them and
   *  nothing here dialled it — see learnCaller in lan-engine.mjs. Kept until a
   *  round proves the address answers: one that does is an ordinary dialled
   *  peer from then on and leaves this set; one that does not is a caller this
   *  deck cannot reach back (a strict NAT, a one-way path), and its row is
   *  taken away again so it reverts to "calls in" rather than failing every
   *  round. A person naming the address ends its trial too, and so does a
   *  settings write that takes its row away (#1674). */
  const calledBack = new Set();

  /** Dial this address on every round from now on. Returns false for an
   *  address that is not one, rather than storing a row that can never
   *  connect and reports an error every minute forever. */
  const add = (addr, port, { typed = true } = {}) => {
    const p = Number(port);
    if (typeof addr !== "string" || !addr.trim() || !Number.isInteger(p) || p < 1 || p > 65_535) return false;
    const host = addr.trim();
    const at = `${host}:${p}`;
    // MAKING ROOM RATHER THAN REFUSING, and only among rows the deck added
    // itself. A hard refusal at the cap would let whoever got there first
    // keep the whole budget, so a real deck starting later would never be
    // asked — which turns a cap meant to protect the round into a way to
    // silence it. Evicted first is the oldest auto row that has never
    // answered: `learned` holds an entry only for an address that completed a
    // handshake, so a row with no entry there has cost a round and returned
    // nothing. When every auto row has answered, the new one waits.
    if (!typed && !manual.has(at)) {
      const auto = [...manual.entries()].filter(([, v]) => !v.typed);
      if (auto.length >= MAX_AUTO_PEERS) {
        const stale = auto.find(([k]) => !learned.has(k));
        if (!stale) return false;
        manual.delete(stale[0]);
        learned.delete(stale[0]);
      }
    }
    // A row somebody typed outranks one the deck added: the same address
    // arriving by hand after a beacon put it there is a person vouching for
    // it, and nothing about that should be undone by the next beacon.
    const was = manual.get(at);
    manual.set(at, {
      fp: `manual:${at}`, name: host, addr: host, port: p, manual: true,
      typed: typed || was?.typed === true,
    });
    // AND A PERSON NAMING IT ENDS ITS TRIAL (#1674). A dial-back is taken away
    // when a round cannot reach it, and a row somebody typed is not the deck's
    // to take away: it stays, failing, and says why.
    if (typed) calledBack.delete(at);
    return true;
  };

  return {
    add,
    remove(addr, port) { return manual.delete(`${String(addr).trim()}:${Number(port)}`); },
    /** Replace the typed list wholesale, which is what a settings write means.
     *  Adding one at a time would leave a removed address still being dialled
     *  every minute until the next restart — the row would vanish from the
     *  panel while the socket kept opening, which is the worst of both. The
     *  size of the list it leaves. */
    replace(entries) {
      manual.clear();
      // The trials go with the rows they were for (#1674). One left behind
      // outlived its row, and the next round that failed at that address took
      // away whatever was dialled there by then.
      calledBack.clear();
      for (const entry of Array.isArray(entries) ? entries : []) {
        const at = String(entry).lastIndexOf(":");
        if (at > 0) add(String(entry).slice(0, at), Number(String(entry).slice(at + 1)));
      }
      return manual.size;
    },

    /** Every row on the list, oldest first. */
    rows: () => [...manual.values()],
    /** What answered at `host:port`, once something has. */
    metAt: at => learned.get(at),
    /** Say what answered at `host:port` — a handshake that just finished said
     *  so, before any round has. */
    meet(at, met) { learned.set(at, met); },
    /** Whether a row on the list answered as `fp` — one of the two ways this
     *  deck already dials a deck; the other is a beacon it still hears. */
    answersAs(fp) {
      for (const [at, met] of learned) if (met?.fp === fp && manual.has(at)) return true;
      return false;
    },
    /** The row whose answer was `fp`, or undefined. */
    rowAnswering: fp => [...manual.values()].find(p => learned.get(`${p.addr}:${p.port}`)?.fp === fp),

    /** A row put on for a paired deck that called in from it, on trial until a
     *  round proves the address answers — see calledBack.
     *
     *  NEVER A ROW SOMEBODY TYPED (#1741). learnCaller asks for a trial
     *  whenever `add` says yes, and `add` says yes for an address already on
     *  the list and keeps a typed row typed — so a deck calling in from the
     *  exact address somebody typed, before a round here had reached it, put
     *  that row on trial and the next failed round took it away. It is not
     *  the deck's to take away (#1674); who called from there is still worth
     *  knowing, so the row reads as that deck. */
    trial(at, met) {
      learned.set(at, met);
      if (manual.get(at)?.typed) return;
      calledBack.add(at);
    },
    /** A round reached `host:port` and `met` is who answered there. A
     *  dial-back that answered is an ordinary row from now on. */
    answered(at, met) {
      learned.set(at, met);
      calledBack.delete(at);
    },
    /** A round did not reach `host:port`. A dial-back on trial is taken away
     *  again, and true says one was; any other row stays and fails again. */
    failed(at) {
      if (!calledBack.has(at)) return false;
      calledBack.delete(at);
      manual.delete(at);
      learned.delete(at);
      return true;
    },
  };
}
