// The decks waiting on somebody here: the ones that asked, the ones only heard,
// and the ones somebody told no — and when each is answered for the owner by a
// switch rather than a press. Lifted out of createEngine in lan-engine.mjs with
// the three lists only these read and write. What an answer DOES — pinning a
// key, or putting an address on the dial list — stays the engine's accept;
// this decides who is on which list and when that accept is pressed.

import { pairable } from "./lan-sync.mjs";

/**
 * The two permissions that answer for one route.
 *
 * READ OFF WHICHEVER SETTINGS ARE ASKED ABOUT, because two places ask. A beacon
 * or a request asks of the settings in force; `apply` asks of the settings
 * before a write and after it, to tell which switch the write turned on. The
 * second used to spell the same conditions out again as its own pair, and a
 * switch read one way here and another way there would answer a request in
 * one place and leave it waiting in the other.
 */
export const asksOn = (cfg, via) => cfg.pairingMode !== "invite" && (via === "tailscale" ? !!cfg.tailscale && cfg.tailscaleAsk !== false : !!cfg.autoAsk);
export const saysYesOn = (cfg, via) => cfg.pairingMode !== "invite" && (via === "tailscale" ? !!cfg.tailscale && cfg.tailscaleAccept !== false : !!cfg.autoAccept);

/**
 * `settings` answers the engine's settings in force at the moment of asking,
 * and `engineNow` the engine itself, whose accept is what a switch presses.
 * `routeTo` says whether an address is a tailnet one and whose, `wasUnpaired`
 * whether somebody here unpaired a fingerprint, and `localAddresses` this
 * machine's own addresses. `now` and `onChange` are the engine's own.
 */
export function createRequests({ now, settings, routeTo, wasUnpaired, engineNow, onChange, localAddresses }) {
  /**
   * Decks that finished a handshake and that nobody here has accepted yet, and
   * decks merely heard shouting on the network. Two lists because they are two
   * different claims: a pending deck proved it holds the key it announced, a
   * heard one only said so. Both are rows with an accept on them; only the
   * first is evidence.
   *
   * In memory rather than on disk. A request that is a day old is not a request
   * any more, and a list of them that survives restarts is a list nobody reads.
   */
  const pending = new Map();
  const strangers = new Map();
  /**
   * Decks somebody here said no to.
   *
   * WITHOUT THIS, DECLINING DID NOTHING THAT LASTED. A deck that asks is a deck
   * that keeps asking — it dials on its own timer, and every dial that finds no
   * pin here becomes a fresh request. So `dismiss` took a row off a list that
   * the next minute put back, and on the other machine the refusal was
   * indistinguishable from a deck that had not been answered yet: both are the
   * same `pending` refusal on the wire, and both drew "waiting for the other
   * deck to accept this one" forever.
   *
   * A name kept here is therefore two answers at once. This deck stops asking
   * its owner, and the deck that asked is TOLD — see refuse("declined") in
   * lan-socket.mjs, which is the only way the far end can ever learn that the
   * answer was no rather than not yet.
   *
   * In memory, like the two lists above, and reversible: `allow` takes a name
   * out and the requests come back. Nothing about it is written down, because a
   * refusal that outlives the process is a decision nobody can find to undo.
   */
  const declined = new Map();

  /**
   * A real deck nobody here has accepted: draw it as a row with an accept on it.
   *
   * ONE HELPER FOR BOTH DIRECTIONS, because the evidence is the same either
   * way. A deck that DIALLED this one finishes a handshake at the listener and
   * arrives through `onPending`; a deck this one dialled finishes the same
   * handshake in roundWith. Both have proved they hold the key they announced,
   * and neither has been agreed to. Before #969 only the first raised a
   * request and the second silently pinned itself.
   *
   * SAY YES FOR SOMEBODY WHO SAID TO. `autoAccept` is the accept button and
   * nothing else: the same pin, from the same key the handshake just proved.
   * Nothing about the wire changes — an inbound connection is still refused,
   * because trust is read fresh per connection, and the caller comes back a few
   * seconds later.
   *
   * A deck already told no does not become a row again. On the inbound path
   * lan-socket refuses it before this is ever called; on the outbound one there
   * is nothing before this, so the check lives here.
   */
  const askToAccept = entry => {
    const cfg = settings();
    if (cfg.pairingMode === "invite" || declined.has(entry.fp)) return;
    const had = pending.get(entry.fp);
    // WHICH SWITCH ANSWERS depends on where the deck is. A request from the
    // tailnet is answered by the Tailscale pair, and only for a machine on this
    // person's own Tailscale account; anything else on the tailnet waits for a
    // press whatever either switch says. See routeOf.
    const route = routeTo(entry.addr);
    const via = route ? "tailscale" : "lan";
    const own = !!route?.own;
    pending.set(entry.fp, { ...entry, via, own, at: had?.at ?? now(), lastAt: now() });
    if (!wasUnpaired(entry.fp) && saysYesOn(cfg, via) && (via === "lan" || own)) {
      engineNow()?.accept(entry.fp, { byHand: false });
      return;
    }
    if (!had) onChange?.();
  };

  /** A deck the beacon heard that nobody here has accepted: a row somebody
   *  can accept, and — when the ask switch for its route is on — asked. */
  const heardStranger = entry => {
    const cfg = settings();
    const had = strangers.get(entry.fp);
    // KEYED BY MACHINE WHEN IT SAYS WHICH ONE IT IS. A computer that took
    // a fresh key — a second deck sharing one config directory does, by
    // design — used to leave its old key in this map for a day, and every
    // one of them drew a row offering to pair with the same machine.
    if (entry.host) for (const [fp, p] of strangers) if (p.host === entry.host && fp !== entry.fp) strangers.delete(fp);
    const own = entry.via === "tailscale" && !!routeTo(entry.addr)?.own;
    strangers.set(entry.fp, { ...entry, own });
    // ASK IT, which is what the `ask` verb on its row does and nothing
    // more: the address goes on the dial list and the next round sends a
    // request that somebody over there still has to answer. A beacon
    // carries a fingerprint and no key, so nothing is pinned here — see
    // accept, which is deliberate about the difference.
    //
    // Only a deck that is NEW is asked, or a beacon every thirty seconds
    // would be thirty seconds of asking; and never one this deck's owner
    // already turned away.
    // Never `byHand`: a beacon is a shout from an address nobody here
    // named, and the row it leaves may ask rather than pin.
    // Over the tailnet only a machine on this person's own account is
    // asked unprompted; any other is a row for somebody to decide on.
    const mayAsk = asksOn(cfg, entry.via) && (entry.via !== "tailscale" || own);
    if (mayAsk && !had && !declined.has(entry.fp) && !wasUnpaired(entry.fp)) { engineNow().accept(entry.fp, { byHand: false }); return; }
    // Only a deck that is new to us is news. A beacon every thirty
    // seconds from one already on the list is not a reason to redraw.
    if (!had) onChange?.();
  };

  /**
   * What a settings write does to the decks already waiting, given the
   * settings before it — the engine's apply calls this with them, after the
   * write is in force.
   */
  const switched = was => {
    // A request made before invite-only was enabled must not survive the
    // switch and become an automatic approval when automatic mode returns.
    // A fresh handshake after that switch may request pairing again.
    if (was.pairingMode !== "invite" && settings().pairingMode === "invite" && pending.size) {
      pending.clear();
      onChange?.();
    }
    // TURNING IT ON ANSWERS WHAT IS ALREADY WAITING. A person who switches
    // this on with two rows sitting in the panel means those two as much as
    // the next one, and leaving them queued behind a setting called
    // "automatic" is the switch not doing what it says.
    //
    // PER ROUTE, because each pair of switches answers for its own: turning
    // the local one on does not answer a tailnet request, and turning the
    // Tailscale one on answers only the owner's own machines.
    const turnedOn = (f, via) => !f(was, via) && f(settings(), via);
    const mayAnswer = p => (p.via === "tailscale" ? turnedOn(saysYesOn, "tailscale") && p.own : turnedOn(saysYesOn, "lan"));
    for (const [fp, p] of [...pending]) if (!wasUnpaired(fp) && mayAnswer(p)) engineNow().accept(fp, { byHand: false });
    // The same for the other direction: switching `ask` on with four machines
    // already listed asks those four.
    const mayAsk = p => (p.via === "tailscale" ? turnedOn(asksOn, "tailscale") && p.own : turnedOn(asksOn, "lan"));
    for (const [fp, p] of [...strangers]) if (!declined.has(fp) && !wasUnpaired(fp) && !p.pub && mayAsk(p)) engineNow().accept(fp, { byHand: false });
    // OFF MEANS THE TAILNET GOES QUIET HERE: nobody heard over it is offered,
    // and the engine's tailnet poll stops the reads. Decks already paired stay
    // paired.
    if (was.tailscale && !settings().tailscale) {
      for (const [fp, p] of [...strangers]) if (p.via === "tailscale") strangers.delete(fp);
    }
  };

  /** The heard decks status() offers to pair with — see its `strangers`. */
  const strangerRows = () => {
    // A deck that was told no is not somebody to offer pairing with. It
    // has its own row, with the one control that undoes the decision.
    const heard = [...strangers.values()].filter(p => !declined.has(p.fp));
    // pairable() collapses the rest by machine — see hostId. A computer
    // that has run the deck a few times holds a key per run, and every
    // one of them was a row of its own on everybody else's panel.
    const { shown, more } = pairable(heard, now(), { mine: localAddresses() });
    return shown.map(p => ({
      fp: p.fp, name: p.name, addr: p.addr, port: p.port, at: p.at, more,
      via: p.via ?? "lan", own: !!p.own,
    }));
  };

  return {
    askToAccept,
    heardStranger,
    switched,
    /** Whether somebody here told this deck no — asked before a request is
     *  drawn, on both paths. */
    isDeclined: fp => declined.has(fp),
    /** The row a deck is waiting on: its request when it asked, its beacon
     *  when it was only heard, or null. */
    seen: fp => (pending.get(fp) ?? null) ?? (strangers.get(fp) ?? null),
    /** It was answered: off both lists. */
    drop(fp) {
      pending.delete(fp);
      strangers.delete(fp);
    },
    /** A heard deck was asked: its address is on the dial list now, and its
     *  row comes back as a request once the round reaches it. */
    dropHeard(fp) {
      strangers.delete(fp);
    },
    /** Say no, and stop being asked. The deck is dropped from both lists; if it
     *  connects again it is a new request, because refusing is not a block. */
    dismiss(fp) {
      // Whatever the row said, kept — the panel draws a declined deck by name
      // and address, and after the delete below there is nowhere else to read
      // them from.
      const was = pending.get(fp) ?? strangers.get(fp) ?? null;
      const had = pending.delete(fp) || strangers.delete(fp);
      if (had) {
        declined.set(fp, {
          fp,
          name: was?.name ?? fp,
          addr: was?.addr ?? "",
          port: was?.port ?? 0,
          at: now(),
        });
        onChange?.();
      }
      return had;
    },
    /** Change your mind. The name comes off the declined list and the next time
     *  that deck dials, it is a request again — which it will, on its own, so
     *  there is nothing else to press. */
    allow(fp) {
      const had = declined.delete(fp);
      if (had) onChange?.();
      return had;
    },
    /** The rows status() draws for each list. */
    pendingRows: () => [...pending.values()].map(p => ({ fp: p.fp, name: p.name, addr: p.addr, at: p.at, via: p.via ?? "lan", own: !!p.own })),
    strangerRows,
    declinedRows: () => [...declined.values()].map(p => ({ fp: p.fp, name: p.name, addr: p.addr, at: p.at })),
  };
}
