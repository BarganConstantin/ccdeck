// The thing that actually heals an account: the beacon, the listener and
// claude-swap, wired together.
//
// The two files under this one hold everything that can be reasoned about
// without a network — lan-sync.mjs decides, lan-socket.mjs carries — and what
// is left here is the part that has to touch the store. It is deliberately the
// smallest of the three.
//
// WHAT ONE ROUND LOOKS LIKE, from a deck whose copy of an account has died:
//
//   1. it hears a beacon from a deck with the same group tag
//   2. it dials that deck's sync port and both sides prove the passphrase
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
import { accountKey, manifestFor, open, plan, seal, stillListed, transferChallenge } from "./lan-sync.mjs";
import { connectToPeer, createBeacon, createSyncServer, sendFrame } from "./lan-socket.mjs";
import { addTrusted, dropTrusted, identityFrom, mintInvite, pairable, readInvite, trustedPeer } from "./lan-sync.mjs";
import { randomBytes } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";

/** How often a deck asks its peers what they have. A minute is far more often
 *  than a login dies, and it is what makes the panel's list feel live rather
 *  than something that updates when you press a button. */
export const SYNC_MS = 60_000;

/**
 * How long to wait before dialling again while somebody is deciding.
 *
 * A minute is right for the steady state — two decks whose logins all work have
 * nothing to say to each other — and it is far too long for the one moment
 * anybody is watching: the seconds after somebody presses accept on the other
 * machine. Reported as "it should work by itself", from a panel that had been
 * correct for up to fifty-nine more seconds than the person in front of it.
 *
 * So the loop tightens while a request is outstanding and relaxes the moment it
 * is answered — either way. A refusal is an answer, and a deck that said no is
 * not asked every eight seconds.
 */
export const ASKING_MS = 8_000;

/** How long one peer round may take before it is abandoned. A manifest is one
 *  round trip on a local network; anything past this is a peer that is not
 *  going to answer, and holding the attempt open would stall the next round. */
export const ROUND_MS = 10_000;


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

/**
 * One deck's LAN sync, from settings to a healed account.
 *
 * `deps` is every side effect: reading accounts, exporting one, importing one.
 * Injected rather than imported so a test can run a whole round — two engines,
 * two fake stores, one real socket pair — without claude-swap on the machine.
 */
export function createEngine({
  readAccounts, exportAccount, importAccount,
  onChange, onError, onIdentity, onPort, onTrust, onDial, now = Date.now,
  /**
   * The UDP socket the beacon shouts through, injectable for the same reason
   * lan-socket exposes it — and for one more that only showed up in use.
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
} = {}) {
  let cfg = { enabled: false, name: defaultName(), secret: "", shared: [], trusted: [], port: 0 };
  let identity = null;
  let beacon = null;
  let server = null;
  let timer = null;
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
  /** The invite this deck is offering, or null. One at a time: a deck showing
   *  two tokens is a deck whose owner cannot say which one they sent. */
  let invite = null;
  /** What the last round did, for the panel. Not a log: one line per peer, most
   *  recent only, because "what happened" is a question about now. */
  const lastRound = new Map();
  /** When the last round FINISHED, whatever it did or failed to do. The panel's
   *  `↻` fires one on demand and the loop fires one on its own; a reader who
   *  pressed it wants to know it happened, and a reader who did not wants to
   *  know the list is not a photograph of an hour ago. */
  let roundAt = null;
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

  /** This deck's accounts in the shape the rules want. Read through the same
   *  function the panel uses, so a row can never be alive here and dead there. */
  const localAccounts = async () => {
    const got = await readAccounts();
    return (got?.accounts ?? []).map(a => ({
      key: accountKey(a.email, a.orgUuid),
      email: a.email,
      alive: a.alive === true,
      num: a.num,
    }));
  };

  /** Frames from a deck that finished the handshake AND that somebody here has
   *  accepted. Nothing reaches this before both, which is the whole point of
   *  where the two checks sit. `ctx.key` is this connection's key and no other
   *  connection's — see sessionKey. */
  const serve = async (msg, ctx) => {
    // Before the verbs, and for every one of them: something that proved it
    // holds a key this deck accepted is talking, now.
    if (ctx?.peerFp) spokeAt.set(ctx.peerFp, now());
    try {
      if (msg.t === "manifest") {
        const accounts = await localAccounts();
        return ctx.send({ t: "manifest", accounts: manifestFor(accounts, cfg.shared) });
      }
      if (msg.t === "want") {
        // A SECOND PROOF, for the one operation that moves a credential. The
        // session says who connected; this says they are asking for this
        // account, now. A long-lived connection authenticated an hour ago is
        // not a statement about now.
        const want = transferChallenge(ctx.key, {
          nonce: msg.nonce, accountKey: msg.key, fromFp: ctx.peerFp, toFp: identity.fp,
        });
        if (typeof msg.proof !== "string" || msg.proof !== want) {
          return ctx.send({ t: "no", why: "proof" });
        }
        // Only what the user ticked, checked again here rather than trusted
        // from the manifest we sent: the list can change between the two, and
        // the answer that matters is the one at the moment of sending.
        if (!cfg.shared.includes(msg.key)) return ctx.send({ t: "no", why: "not shared" });
        const accounts = await localAccounts();
        const mine = accounts.find(a => a.key === msg.key);
        if (!mine || !mine.alive) return ctx.send({ t: "no", why: "not mine to give" });
        const blob = await exportAccount(mine.num);
        if (!blob) return ctx.send({ t: "no", why: "export failed" });
        const aad = `${identity.fp}->${ctx.peerFp}|${msg.key}`;
        return ctx.send({ t: "have", key: msg.key, sealed: seal(ctx.key, blob, aad) });
      }
    } catch (err) {
      onError?.("serve", err);
      ctx.send({ t: "no", why: "error" });
    }
  };

  /**
   * Is anybody on the other end still deciding?
   *
   * The exact sentence lan-socket.mjs sends for "a real deck, not yet
   * accepted", which is the one state where dialling again in a few seconds
   * does something a minute later would not.
   */
  const waitingOnSomebody = () =>
    [...lastRound.values()].some(r => r?.error === "waiting for the other deck to accept this one");

  /** Ask one peer what it has, and heal whatever it can heal. */
  const roundWith = async peer => {
    let conn = null;
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
      });
      const ask = frame => new Promise((resolve, reject) => {
        const bell = setTimeout(() => reject(new Error("peer went quiet")), ROUND_MS);
        bell.unref?.();
        let buf = "";
        const onData = chunk => {
          buf += chunk;
          const i = buf.indexOf("\n");
          if (i === -1) return;
          clearTimeout(bell);
          conn.sock.off("data", onData);
          try { resolve(JSON.parse(buf.slice(0, i))); } catch { reject(new Error("bad reply")); }
        };
        conn.sock.on("data", onData);
        sendFrame(conn.sock, frame);
      });

      // TRUST ON FIRST USE, AND ONLY FOR AN ADDRESS SOMEBODY TYPED. Reaching a
      // deck we have no pin for means the person at this keyboard put its
      // address in the field, which is the same decision the accept button is
      // on the other side. Pinning it here is what makes the two lists agree —
      // without it this deck would dial a peer every minute and still show it
      // as nobody, and its own listener would refuse the same deck calling
      // back.
      //
      // A deck we DO have a pin for was checked before this line: connectToPeer
      // was given expectPub and refuses a different key at that address.
      // WHO IS ACTUALLY THERE. A typed address is a row that says `192.168.1.5:54340`
      // and nothing else until somebody answers it — and once one has, the deck
      // on the other end has told us what it calls itself. The row says that
      // from then on, because "Constantin-PC" is what the person who typed the
      // address was trying to reach.
      learned.set(`${peer.addr}:${peer.port}`, { fp: conn.peerFp, name: conn.peerName || "" });

      if (!trustedPeer(cfg.trusted, conn.peerFp)) {
        const { list, added } = addTrusted(cfg.trusted, {
          fp: conn.peerFp, pub: conn.peerPub, name: conn.peerName,
        });
        if (added) { cfg = { ...cfg, trusted: list }; onTrust?.(list); }
      }

      const theirs = await ask({ t: "manifest" });
      if (theirs?.t !== "manifest" || !Array.isArray(theirs.accounts)) throw new Error("no manifest");
      const mine = await localAccounts();
      // Only accounts I have also ticked. Sharing is mutual by construction:
      // a peer cannot push an account at me that I never agreed to hold.
      // A HEAL NEEDS MY TICK; AN ADD DOES NOT, and the asymmetry is deliberate.
      // Healing replaces a slot I already have, so it is only reasonable for an
      // account I said I share. Adding is the case the owner asked for by name:
      // an account that appears among the decks I paired with appears on all of
      // them, which is the whole of "I do not want to paste blobs any more".
      // What can reach this is what a deck somebody here pressed accept on
      // chose to offer.
      const wanted = plan(mine, theirs.accounts)
        .filter(step => step.action === "add" || cfg.shared.includes(step.key));
      const done = [];
      for (const step of wanted) {
        const nonce = randomBytes(12).toString("hex");
        const reply = await ask({
          t: "want", key: step.key, nonce,
          proof: transferChallenge(conn.key, {
            nonce, accountKey: step.key, fromFp: identity.fp, toFp: conn.peerFp,
          }),
        });
        if (reply?.t !== "have" || !reply.sealed) { done.push({ ...step, ok: false, why: reply?.why ?? "refused" }); continue; }
        const blob = open(conn.key, reply.sealed, `${conn.peerFp}->${identity.fp}|${step.key}`);
        if (!blob) { done.push({ ...step, ok: false, why: "could not open" }); continue; }
        const ok = await importAccount(blob);
        done.push({ ...step, ok: !!ok, why: ok ? null : "import failed" });
      }
      lastRound.set(peer.fp, { at: now(), name: peer.name, offered: theirs.accounts.length, done });
      if (done.length) onChange?.();
      return done;
    } catch (err) {
      lastRound.set(peer.fp, { at: now(), name: peer.name, error: err.message });
      return [];
    } finally {
      conn?.sock?.destroy();
    }
  };

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
   *  exist before there has been one. */
  const manual = new Map();
  /** What answered at a typed address, once something has. Keyed the same way
   *  `manual` is, because until a connection succeeds an address is all there
   *  is to key on. */
  const learned = new Map();

  const round = async () => {
    if (!beacon) return [];
    const all = [];
    // Heard first, typed second, and a typed one is skipped when the beacon
    // already found that address: otherwise a deck that is both would be dialled
    // twice a round and its work counted twice.
    // The same rule the list uses. A deck that has been silent for a day is not
    // dialled once a minute forever on the chance it comes back.
    const heard = [...beacon.peers.values()].filter(p => stillListed(p, now()));
    const seen = new Set(heard.map(p => `${p.addr}:${p.port}`));
    for (const peer of [...heard, ...[...manual.values()].filter(p => !seen.has(`${p.addr}:${p.port}`))]) {
      // Sequential rather than parallel. The store takes one mutation at a
      // time anyway (cswap-admin's lock), and two peers healing the same
      // account at once would race for a slot number claude-swap assigns as
      // max+1 without a lock of its own.
      all.push(...await roundWith(peer));
    }
    roundAt = now();
    return all;
  };

  return {
    async apply(next) {
      const was = cfg;
      cfg = { ...cfg, ...next };
      const restart = !was.enabled !== !cfg.enabled
        || was.secret !== cfg.secret
        || was.name !== cfg.name;
      if (!restart) return;
      this.stop();
      if (!cfg.enabled) return;
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
      server = createSyncServer({
        fp: identity.fp, pub: identity.pub, secret: identity.secret,
        name: cfg.name, handlers: serve, onError, prefer: cfg.port,
        trusted: () => cfg.trusted,
        invite: () => (invite && invite.expiresAt > now() ? invite : null),
        // Somebody used the token. They are pinned, and the token is retired —
        // one that pairs twice is one worth stealing twice.
        onInviteUsed: entry => {
          const { list } = addTrusted(cfg.trusted, { fp: entry.fp, pub: entry.pub, name: entry.name });
          cfg = { ...cfg, trusted: list };
          invite = null;
          // AND DIAL IT BACK, KEPT. Accepting made it welcome and left this
          // deck with no way to reach it: an inbound connection puts nothing in
          // the dial list. Without this the pairing is mutual in the trusted
          // list and one-way in fact — and `addPeer` alone lives in memory, so
          // it would be one-way again after the next restart.
          if (entry.addr && entry.port) {
            this.addPeer(entry.addr, entry.port);
            onDial?.(`${entry.addr}:${entry.port}`);
            // AND SAY WHO IS THERE, NOW. `learned` is what joins a dialled row
            // to a heard one, and it was only ever filled by a round that
            // succeeded — so between accepting a deck and the next round, one
            // machine appeared as two rows. We already know the answer here:
            // the handshake that just finished said so.
            learned.set(`${entry.addr}:${entry.port}`, { fp: entry.fp, name: entry.name || "" });
          }
          onTrust?.(list);
          onChange?.();
        },
        // Asked before the request is drawn, so a deck that was told no is
        // told no again rather than becoming a row somebody has to answer
        // twice. The socket sends the reason; this only knows the name.
        declined: fp => declined.has(fp),
        onPending: entry => {
          const had = pending.get(entry.fp);
          pending.set(entry.fp, { ...entry, at: had?.at ?? now(), lastAt: now() });
          if (!had) onChange?.();
        },
      });
      let port;
      try {
        port = await server.start();
      } catch (err) {
        // Kept, so the panel can say it. Rethrown, because the caller's own
        // catch is what leaves the engine stopped rather than half-started.
        stalled = err?.message ?? String(err);
        throw err;
      }
      stalled = null;
      if (port !== cfg.port) onPort?.(port);
      beacon = createBeacon({
        port, name: cfg.name, fp: identity.fp,
        trusted: () => cfg.trusted,
        onPeer: () => onChange?.(),
        onStranger: entry => {
          const had = strangers.get(entry.fp);
          // KEYED BY MACHINE WHEN IT SAYS WHICH ONE IT IS. A computer that took
          // a fresh key — a second deck sharing one config directory does, by
          // design — used to leave its old key in this map for a day, and every
          // one of them drew a row offering to pair with the same machine.
          if (entry.host) for (const [fp, p] of strangers) if (p.host === entry.host && fp !== entry.fp) strangers.delete(fp);
          strangers.set(entry.fp, entry);
          // Only a deck that is new to us is news. A beacon every thirty
          // seconds from one already on the list is not a reason to redraw.
          if (!had) onChange?.();
        },
        // Take a new key and keep it. Two decks with one identity are invisible
        // to each other forever otherwise, and the second one to notice moving
        // is enough — whichever notices first, moves.
        onIdClash: () => {
          const fresh = identityFrom("");
          onIdentity?.(fresh.secret);
          onError?.("id-clash", new Error("another deck was using this one's key; taking a new one"));
        },
        onError, now,
        ...(createSocket ? { createSocket } : {}),
      });
      await beacon.start();
      // A self-scheduling loop rather than one interval, because the gap
      // between rounds is not one number: see ASKING_MS.
      const tick = async () => {
        try { await round(); } catch { /* a round reports itself, per peer */ }
        if (!beacon) return;
        timer = setTimeout(() => { void tick(); }, waitingOnSomebody() ? ASKING_MS : SYNC_MS);
        timer.unref?.();
      };
      timer = setTimeout(() => { void tick(); }, SYNC_MS);
      timer.unref?.();
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
      invite = made;
      onChange?.();
      return { token: made.token, expiresAt: made.expiresAt, addrs };
    },

    /** What this deck is offering right now, for the panel to draw. Null once
     *  it has run out, so a token nobody can use is not shown as if they could. */
    offering() {
      if (!invite || invite.expiresAt <= now()) return null;
      return { token: invite.token, expiresAt: invite.expiresAt };
    },

    /** Put it away without using it. */
    withdraw() {
      const had = !!invite;
      invite = null;
      if (had) onChange?.();
      return had;
    },

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
      const tried = [];
      for (const at of inv.addrs) {
        let conn = null;
        try {
          conn = await connectToPeer({
            host: at.addr, port: at.port, timeoutMs: ROUND_MS,
            fp: identity.fp, pub: identity.pub, secret: identity.secret,
            name: cfg.name, myPort: server.port(), code: inv.code,
          });
          const { list } = addTrusted(cfg.trusted, {
            fp: conn.peerFp, pub: conn.peerPub, name: conn.peerName || inv.name,
          });
          cfg = { ...cfg, trusted: list };
          this.addPeer(at.addr, at.port);
          onDial?.(`${at.addr}:${at.port}`);
          learned.set(`${at.addr}:${at.port}`, { fp: conn.peerFp, name: conn.peerName || inv.name });
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
    accept(fp) {
      const asked = pending.get(fp) ?? null;
      const heard = strangers.get(fp) ?? null;
      const seen = asked ?? heard;
      if (!seen) return null;
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
        this.addPeer(seen.addr, seen.port);
        strangers.delete(fp);
        onChange?.();
        return { fp, name: seen.name, addr: seen.addr, port: seen.port, dialled: true };
      }
      const { list, added } = addTrusted(cfg.trusted, { fp, pub: seen.pub, name: seen.name });
      cfg = { ...cfg, trusted: list };
      pending.delete(fp);
      strangers.delete(fp);
      onTrust?.(list);
      onChange?.();
      // AND DIAL IT BACK. Accepting a deck that called us made it welcome and
      // left this one with no way to reach it: the peer list is what this deck
      // dials, and an inbound connection puts nothing in it. So the pairing was
      // mutual in the trusted list and one-way in fact — if the other machine
      // stopped calling, nothing here would ever call it. The hello carries the
      // port it listens on for exactly this.
      const back = seen.addr && seen.port && this.addPeer(seen.addr, seen.port)
        ? (learned.set(`${seen.addr}:${seen.port}`, { fp, name: seen.name || "" }),
           { addr: seen.addr, port: seen.port })
        : null;
      return added ? { fp, name: seen.name, addr: seen.addr, port: seen.port ?? null, dialBack: back } : null;
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
    /** Unpair. It stops what has not happened yet and takes back nothing that
     *  has — the same sentence the panel says about a shared login. */
    unpair(fp) {
      const list = dropTrusted(cfg.trusted, fp);
      if (list.length === cfg.trusted.length) return false;
      cfg = { ...cfg, trusted: list };
      onTrust?.(list);
      onChange?.();
      return true;
    },
    round,
    /** Dial this address on every round from now on. Returns false for an
     *  address that is not one, rather than storing a row that can never
     *  connect and reports an error every minute forever. */
    addPeer(addr, port) {
      const p = Number(port);
      if (typeof addr !== "string" || !addr.trim() || !Number.isInteger(p) || p < 1 || p > 65_535) return false;
      const host = addr.trim();
      manual.set(`${host}:${p}`, { fp: `manual:${host}:${p}`, name: host, addr: host, port: p, manual: true });
      return true;
    },
    removePeer(addr, port) { return manual.delete(`${String(addr).trim()}:${Number(port)}`); },
    /** Replace the typed list wholesale, which is what a settings write means.
     *  Adding one at a time would leave a removed address still being dialled
     *  every minute until the next restart — the row would vanish from the
     *  panel while the socket kept opening, which is the worst of both. */
    setPeers(entries) {
      manual.clear();
      for (const entry of Array.isArray(entries) ? entries : []) {
        const at = String(entry).lastIndexOf(":");
        if (at > 0) this.addPeer(String(entry).slice(0, at), Number(String(entry).slice(at + 1)));
      }
      return manual.size;
    },
    status() {
      return {
        enabled: !!cfg.enabled,
        running: !!beacon,
        // Said only while it is true, and it is only ever true of a deck that
        // is switched on and has no listener.
        stalled: cfg.enabled && !beacon ? stalled : null,
        // When every paired deck was last asked. Null until the first round,
        // which on a deck that has just started is the honest answer.
        checkedAt: roundAt,
        name: cfg.name,
        fp: identity?.fp ?? null,
        // The address and port a person on another subnet types into the other
        // deck's field. Null when this machine has no ordinary one, which the
        // panel says rather than printing a placeholder.
        port: server?.port() ?? null,
        addrs: beacon ? localAddresses() : [],
        shared: [...cfg.shared],
        // The token this deck is offering, if any. Drawn as the one thing to do
        // when nobody is paired yet, and put away once somebody is.
        invite: invite && invite.expiresAt > now()
          ? { token: invite.token, expiresAt: invite.expiresAt }
          : null,
        // Decks somebody accepted, decks that asked and have not been answered,
        // and decks merely heard. Three lists because they are three different
        // things a person does something different about.
        trusted: cfg.trusted.map(t => ({ fp: t.fp, name: t.name })),
        pending: [...pending.values()].map(p => ({ fp: p.fp, name: p.name, addr: p.addr, at: p.at })),
        // Only the ones somebody could actually pair with right now, one row
        // per machine, newest first — see pairable, which is where the rule
        // that keeps this from becoming a wall of ghosts lives.
        strangers: (() => {
          // A deck that was told no is not somebody to offer pairing with. It
          // has its own row, with the one control that undoes the decision.
          const heard = [...strangers.values()].filter(p => !declined.has(p.fp));
          // pairable() collapses the rest by machine — see hostId. A computer
          // that has run the deck a few times holds a key per run, and every
          // one of them was a row of its own on everybody else's panel.
          const { shown, more } = pairable(heard, now(), { mine: localAddresses() });
          return shown.map(p => ({ fp: p.fp, name: p.name, addr: p.addr, port: p.port, at: p.at, more }));
        })(),
        // Said no to, by somebody at this keyboard. Listed rather than merely
        // silenced, because a refusal nobody can see is a refusal nobody can
        // take back.
        declined: [...declined.values()].map(p => ({ fp: p.fp, name: p.name, addr: p.addr, at: p.at })),
        peers: beacon ? (() => {
          // ONE DECK, ONE ROW, and it takes work because a deck can arrive here
          // twice by two different routes: heard on the network, and dialled at
          // an address somebody typed or that an invite carried. Both are the
          // same machine and neither knows it — the beacon row is keyed by the
          // fingerprint it announced, the typed row by `host:port`, and until a
          // connection succeeds nothing joins them.
          //
          // What joins them is `learned`: the fingerprint that actually
          // answered at that address. So every row is given the identity it is
          // really about, and rows that turn out to share one are merged — the
          // heard half brings liveness, the dialled half brings the last round.
          const rows = [];
          const byId = new Map();
          const put = row => {
            const had = byId.get(row.id);
            if (!had) { byId.set(row.id, row); rows.push(row); return; }
            // Keep what each half is the authority on.
            had.lastSeen = had.lastSeen ?? row.lastSeen;
            had.last = had.last ?? row.last;
            had.manual = had.manual || row.manual;
            had.met = had.met || row.met;
            if (row.name && !had.name) had.name = row.name;
          };
          for (const p of [...beacon.peers.values(), ...manual.values()]) {
            if (!stillListed(p, now())) continue;
            const met = p.manual ? learned.get(`${p.addr}:${p.port}`) : null;
            const id = met?.fp ?? p.fp;
            put({
              ...p,
              id,
              // The fingerprint an unpair has to name. A typed row's own `fp` is
              // a placeholder built from its address and matches nothing.
              peerFp: p.manual ? met?.fp ?? null : p.fp,
              name: met?.name || p.name,
              met: !!met,
              paired: !!trustedPeer(cfg.trusted, id),
              last: lastRound.get(p.fp) ?? null,
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
              paired: true, waiting: true, last: lastRound.get(t.fp) ?? null,
              // What it is to be "here" for a deck nothing dials: it called,
              // and this is when. Undefined until it has, which is a row the
              // panel draws as unknown rather than as live.
              lastSeen: spokeAt.get(t.fp),
            });
          }
          return rows;
        })() : [],
      };
    },
    stop() {
      if (timer) clearTimeout(timer);
      // A deliberate stop is not a fault, and the next start says its own.
      if (!cfg.enabled) stalled = null;
      timer = null;
      beacon?.stop();
      server?.stop();
      beacon = null;
      server = null;
    },
  };
}
