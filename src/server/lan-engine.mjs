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
import { fingerprint, groupKey, groupName } from "./lan-sync.mjs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";

/** How often a deck asks its peers what they have. A minute is far more often
 *  than a login dies, and it is what makes the panel's list feel live rather
 *  than something that updates when you press a button. */
export const SYNC_MS = 60_000;

/** How long one peer round may take before it is abandoned. A manifest is one
 *  round trip on a local network; anything past this is a peer that is not
 *  going to answer, and holding the attempt open would stall the next round. */
export const ROUND_MS = 10_000;


/**
 * The name everybody knows this deck by.
 *
 * PERSISTED, and the first version was not. It regenerated on every start, on
 * the argument that a stored key is one more secret to protect — and that
 * argument was about the wrong thing, because this is not a key. Nothing is
 * signed with it and nothing is decrypted with it; the group passphrase is what
 * authenticates, and this is only an identifier, broadcast in the clear in
 * every beacon. There is nothing here to steal.
 *
 * What regenerating it cost was measured rather than guessed: on a machine
 * where decks had been restarted a few times, every peer's list held a row per
 * restart — dozens of them, each reporting ECONNREFUSED every minute against a
 * port nothing has listened on for an hour. Remembered forever and never
 * recognised again is the worst of both, and a stable id is the whole fix.
 */
export function newIdentity(stored) {
  if (typeof stored === "string" && /^[0-9a-f]{12}$/.test(stored)) {
    return { fp: stored.replace(/(.{3})(?=.)/g, "$1-"), id: stored };
  }
  const { publicKey } = generateKeyPairSync("x25519");
  const raw = publicKey.export({ type: "spki", format: "der" });
  const fp = fingerprint(raw);
  return { fp, id: fp.replace(/-/g, "") };
}

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
  onChange, onError, onIdentity, onPort, now = Date.now,
} = {}) {
  let cfg = { enabled: false, name: defaultName(), passphrase: "", shared: [], deckId: "", port: 0 };
  let identity = null;
  let beacon = null;
  let server = null;
  let timer = null;
  let key = null;
  /** What the last round did, for the panel. Not a log: one line per peer, most
   *  recent only, because "what happened" is a question about now. */
  const lastRound = new Map();

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

  /** Frames from a peer that has proved the passphrase. Nothing reaches this
   *  before that, which is the whole point of where the check sits. */
  const serve = async (msg, ctx) => {
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
        const want = transferChallenge(key, {
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
        return ctx.send({ t: "have", key: msg.key, sealed: seal(key, blob, aad) });
      }
    } catch (err) {
      onError?.("serve", err);
      ctx.send({ t: "no", why: "error" });
    }
  };

  /** Ask one peer what it has, and heal whatever it can heal. */
  const roundWith = async peer => {
    let conn = null;
    try {
      conn = await connectToPeer({ host: peer.addr, port: peer.port, fp: identity.fp, key, timeoutMs: ROUND_MS });
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

      const theirs = await ask({ t: "manifest" });
      if (theirs?.t !== "manifest" || !Array.isArray(theirs.accounts)) throw new Error("no manifest");
      const mine = await localAccounts();
      // Only accounts I have also ticked. Sharing is mutual by construction:
      // a peer cannot push an account at me that I never agreed to hold.
      // A HEAL NEEDS MY TICK; AN ADD DOES NOT, and the asymmetry is deliberate.
      // Healing replaces a slot I already have, so it is only reasonable for an
      // account I said I share. Adding is the case the owner asked for by name:
      // an account that appears in the group appears everywhere in it, which is
      // the whole of "I do not want to paste blobs any more". The group is
      // passphrase-gated, so what can reach this is what somebody I trusted
      // with that passphrase chose to offer.
      const wanted = plan(mine, theirs.accounts)
        .filter(step => step.action === "add" || cfg.shared.includes(step.key));
      const done = [];
      for (const step of wanted) {
        const nonce = randomBytes(12).toString("hex");
        const reply = await ask({
          t: "want", key: step.key, nonce,
          proof: transferChallenge(key, {
            nonce, accountKey: step.key, fromFp: identity.fp, toFp: conn.peerFp,
          }),
        });
        if (reply?.t !== "have" || !reply.sealed) { done.push({ ...step, ok: false, why: reply?.why ?? "refused" }); continue; }
        const blob = open(key, reply.sealed, `${conn.peerFp}->${identity.fp}|${step.key}`);
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
   *  discovery and perfectly reachable by address. The passphrase remains the
   *  only gate, so an address is not a way in — it is a way to be dialled.
   *
   *  Keyed by `host:port` rather than by fingerprint, because a fingerprint is
   *  what a deck says about itself after the handshake and this list has to
   *  exist before there has been one. */
  const manual = new Map();

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
    return all;
  };

  return {
    async apply(next) {
      const was = cfg;
      cfg = { ...cfg, ...next };
      const restart = !was.enabled !== !cfg.enabled
        || was.passphrase !== cfg.passphrase
        || was.name !== cfg.name
        || was.deckId !== cfg.deckId;
      if (!restart) return;
      this.stop();
      if (!cfg.enabled || !cfg.passphrase) return;
      key = groupKey(cfg.passphrase);
      identity = newIdentity(cfg.deckId);
      // Hand the caller an id to keep when there was none, so the next start is
      // the same deck rather than a new row in everybody's list.
      if (identity.id !== cfg.deckId) onIdentity?.(identity.id);
      // The port last used, so an address somebody typed on the other machine
      // still works after this deck restarts. createSyncServer falls through to
      // an OS-chosen one when it is taken, and the caller stores whatever came
      // back — so the pin drifts to a free port rather than failing.
      server = createSyncServer({
        fp: identity.fp, name: cfg.name, key, handlers: serve, onError,
        prefer: cfg.port,
      });
      const port = await server.start();
      if (port !== cfg.port) onPort?.(port);
      beacon = createBeacon({
        port, name: cfg.name, fp: identity.fp, key,
        onPeer: () => onChange?.(),
        // Take a new name and keep it. Two decks with one id are invisible to
        // each other forever otherwise, and the second one to notice moving is
        // enough — whichever notices first, moves.
        onIdClash: () => {
          const fresh = newIdentity();
          onIdentity?.(fresh.id);
          onError?.("id-clash", new Error("another deck was using this one's id; taking a new one"));
        },
        onError, now,
      });
      await beacon.start();
      timer = setInterval(() => { void round(); }, SYNC_MS);
      timer.unref?.();
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
        name: cfg.name,
        fp: identity?.fp ?? null,
        // The three words every deck in this group computes for itself. Null
        // until there is a passphrase, because there is no group before one.
        group: key ? groupName(key) : null,
        // The address and port a person on another subnet types into the other
        // deck's field. Null when this machine has no ordinary one, which the
        // panel says rather than printing a placeholder.
        port: server?.port() ?? null,
        addrs: beacon ? localAddresses() : [],
        shared: [...cfg.shared],
        // The rule is stillListed's, in lan-sync.mjs, where it can be tested.
        peers: beacon ? [...beacon.peers.values(), ...manual.values()]
          .filter(p => stillListed(p, now()))
          .map(p => ({ ...p, last: lastRound.get(p.fp) ?? null })) : [],
      };
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      beacon?.stop();
      server?.stop();
      beacon = null;
      server = null;
      key = null;
    },
  };
}
