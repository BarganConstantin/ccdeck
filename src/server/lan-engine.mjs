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
import { accountKey, currentFor, manifestFor, open, plan, seal, stillListed, transferChallenge } from "./lan-sync.mjs";
import { connectToPeer, createBeacon, createSyncServer, MAX_FRAME_BYTES } from "./lan-socket.mjs";
import { addTrusted, dropTrusted, identityFrom, mintInvite, pairable, readInvite, trustedPeer } from "./lan-sync.mjs";
import { openAbout, sealAbout } from "./lan-about.mjs";
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
 * The accounts a peer's manifest listed, as the panel may keep them.
 *
 * It arrived from another machine, so it is read rather than trusted: strings
 * where strings belong, a boolean for the verdict, and no more rows than a
 * manifest may carry. What is kept is only what the deck's dialog draws.
 */
/** One peer-supplied string as the panel may draw it: no control or format
 *  characters, whitespace collapsed, bounded. The rule cleanName applies to a
 *  deck's name and lan-about's `field` to a card, applied to the two strings
 *  that sit next to the fingerprint in the import dialog. */
function flatten(v, max) {
  if (typeof v !== "string") return "";
  const flat = v.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  return [...flat].slice(0, max).join("");
}

export function offered(list) {
  return (Array.isArray(list) ? list : [])
    .filter(a => a && typeof a.key === "string" && typeof a.email === "string")
    .slice(0, 50)
    // Character-filtered, not merely cut. These two are drawn beside the
    // fingerprint at the moment the operator picks which of a peer's logins to
    // import (LanPeerModal.tsx:497), and a bare slice let a format character
    // through — the same class cleanName strips from the name one frame over.
    .map(a => ({
      key: flatten(a.key, 320),
      email: flatten(a.email, 254),
      alive: a.alive === true,
    }))
    .filter(a => a.key && a.email);
}

/**
 * Which account a peer said it is on, as the panel may keep it: the key of one
 * of the accounts it listed in the same frame, that its owner is hiding it, or
 * that it is on one it does not share — and nothing for anything else. A key
 * that is not in its own list is dropped rather than drawn: a deck only ever
 * names an account it shares, and one that names another is saying something
 * this deck will not show.
 */
export function heardCurrent(raw, list) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.hidden === true) return { hidden: true };
  if (raw.other === true) return { other: true };
  if (typeof raw.key !== "string") return null;
  return list.some(a => a.key === raw.key) ? { key: raw.key } : null;
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
  /** This deck's own card — its version and its machine — handed to every
   *  paired deck and to nobody else. See lan-about.mjs. */
  about = null,
  /** Whether this deck seals every frame after the handshake with a deck that
   *  says it does too — see frameChannel in lan-sync.mjs. Nothing in the deck
   *  turns it off; the suite does, to play a deck from before #810, which is
   *  the only way to show that one still heals. */
  sealFrames = true,
  /** Whether this deck mixes a key pair made for each connection into that
   *  connection's key, with a deck that says it does too — see sessionKey in
   *  lan-sync.mjs. Nothing in the deck turns this off either; the suite does,
   *  to play a deck of #810's version, which seals and does not mix. It rides
   *  on `sealFrames`: with that off, this deck says neither. */
  ephemeral = true,
  /** Where the listener binds: every interface, which is what a peer dials,
   *  unless the suite says loopback — a test deck has no business being
   *  reachable from the office for the seconds it runs. */
  host,
} = {}) {
  let cfg = {
    enabled: false, name: defaultName(), secret: "", shared: [], trusted: [], port: 0,
    autoAsk: true, autoAccept: true, aliases: {},
    // Tell paired decks which shared account this one is on — see currentFor.
    shareActive: true,
  };
  let identity = null;
  let beacon = null;
  let server = null;
  let timer = null;
  /** This engine, for the helpers below `apply` that need to press its own
   *  accept — see askToAccept. Set on the first apply, which is the only thing
   *  that can start a round or a listener, so nothing reads it before it is
   *  there. */
  let engine = null;
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
  /** What each paired deck said about itself — version, operating system,
   *  architecture — keyed by fingerprint, most recent only. Filled from both
   *  directions: the manifest a deck answers with, and the question a deck that
   *  calls in asks. See lan-about.mjs. */
  const aboutBy = new Map();
  /** The accounts each paired deck offered in its last manifest, keyed by
   *  fingerprint. Kept APART from lastRound on purpose: a round that fails
   *  replaces that line, and the list a deck offered a minute ago is still the
   *  best answer to "what does it share" while it is unreachable. */
  const offersBy = new Map();
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
      // The one this deck is on — claude-swap's own answer, one at most.
      active: a.active === true,
    }));
  };

  /** This deck's card for one connection, as a frame field — or nothing, for a
   *  deck built without one. Spread into the frame, so a deck from before this
   *  existed receives exactly the frame it always did plus one key it never
   *  reads. */
  const cardFor = (key, toFp) => {
    const sealed = sealAbout(key, about, identity.fp, toFp);
    return sealed ? { about: sealed } : {};
  };

  /** Frames from a deck that finished the handshake AND that somebody here has
   *  accepted. Nothing reaches this before both, which is the whole point of
   *  where the two checks sit. `ctx.key` is this connection's key and no other
   *  connection's — see sessionKey. `ctx.send` seals whatever it is handed when
   *  both ends said they seal, so nothing below has to know which kind of deck
   *  asked — see frameChannel. */
  const serve = async (msg, ctx) => {
    // Before the verbs, and for every one of them: something that proved it
    // holds a key this deck accepted is talking, now.
    if (ctx?.peerFp) spokeAt.set(ctx.peerFp, now());
    try {
      if (msg.t === "manifest") {
        // THE CALLER'S CARD RIDES THE QUESTION, which is the only way a deck
        // that calls in ever says what it is: nothing here dials it, so nothing
        // here ever asks. A seal that does not open is a deck that said nothing.
        const card = openAbout(ctx.key, msg.about, ctx.peerFp, identity.fp);
        if (card) aboutBy.set(ctx.peerFp, { ...card, at: now() });
        // AND SO DOES ITS LIST, from a deck new enough to send one: what it
        // offers, and which of those it is on. Kept only when it came — an
        // older caller asks with its card alone, and a missing list is not an
        // empty one. This is the only way a deck nothing here dials is ever
        // known by what it offers.
        if (Array.isArray(msg.accounts)) {
          const list = offered(msg.accounts);
          offersBy.set(ctx.peerFp, { at: now(), accounts: list, current: heardCurrent(msg.current, list) });
        }
        const accounts = await localAccounts();
        return ctx.send({
          t: "manifest", accounts: manifestFor(accounts, cfg.shared),
          ...currentFor(accounts, cfg.shared, cfg.shareActive),
          ...cardFor(ctx.key, ctx.peerFp),
        });
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
    if (declined.has(entry.fp)) return;
    const had = pending.get(entry.fp);
    pending.set(entry.fp, { ...entry, at: had?.at ?? now(), lastAt: now() });
    if (cfg.autoAccept) { engine?.accept(entry.fp); return; }
    if (!had) onChange?.();
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
        sealFrames, ephemeral,
      });
      // A SECOND READER ON THE SAME SOCKET, AND IT HAS TO KEEP THE SAME CAP.
      //
      // lan-socket.mjs's header states the rule: "a peer that sends a megabyte
      // with no newline in it is not sending a large frame, it is sending
      // nothing at all, expensively... the buffer is ABANDONED rather than
      // grown past it." frameReader enforces it; this reader did not.
      //
      // The frameReader connectToPeer installed IS still attached and does hit
      // MAX_FRAME_BYTES — but it only sets its own flag and calls `fail`, which
      // short-circuits on `settled`, so nothing destroys the socket. This
      // buffer then grew unbounded for the full ROUND_MS at line rate. The
      // reject path also never removed the listener; only roundWith's
      // `finally { conn?.sock?.destroy(); }` stopped it.
      const ask = frame => new Promise((resolve, reject) => {
        const bell = setTimeout(() => reject(new Error("peer went quiet")), ROUND_MS);
        bell.unref?.();
        let buf = "";
        const give = (fn, arg) => {
          clearTimeout(bell);
          conn.sock.off("data", onData);
          fn(arg);
        };
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
        conn.sock.on("data", onData);
        // And out through its own writer, which seals whenever the reader opens.
        conn.send(frame);
      });

      // WHO IS ACTUALLY THERE. A typed address is a row that says `192.168.1.5:54340`
      // and nothing else until somebody answers it — and once one has, the deck
      // on the other end has told us what it calls itself. The row says that
      // from then on, because "Constantin-PC" is what the person who typed the
      // address was trying to reach.
      learned.set(`${peer.addr}:${peer.port}`, { fp: conn.peerFp, name: conn.peerName || "" });

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
      // — which index.mjs writes to prefs.json, and which is the whole inbound
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
        if (!peer.typed) {
          // The same row the listener's own `onPending` draws, from the other
          // direction: this deck dialled rather than being dialled, and the
          // handshake it just finished is the same evidence either way — a real
          // deck holding the key it announced. What is missing is the press,
          // and that is what this asks for.
          askToAccept({
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

      // Our card goes with the question and theirs comes back with the answer
      // — see lan-about.mjs for why it is here and nowhere earlier.
      // THE QUESTION CARRIES THIS DECK'S LIST TOO, and which of it this deck is
      // on — so the deck being asked knows both without dialling back, which a
      // deck with no address for this one never could. An older deck reads the
      // question's `t` and card and nothing else, so it answers as it always did.
      const mine = await localAccounts();
      const theirs = await ask({
        t: "manifest", accounts: manifestFor(mine, cfg.shared),
        ...currentFor(mine, cfg.shared, cfg.shareActive),
        ...cardFor(conn.key, conn.peerFp),
      });
      if (theirs?.t !== "manifest" || !Array.isArray(theirs.accounts)) throw new Error("no manifest");
      const card = openAbout(conn.key, theirs.about, conn.peerFp, identity.fp);
      if (card) aboutBy.set(conn.peerFp, { ...card, at: now() });
      const list = offered(theirs.accounts);
      offersBy.set(conn.peerFp, { at: now(), accounts: list, current: heardCurrent(theirs.current, list) });
      // Only accounts I have also ticked. Sharing is mutual by construction:
      // a peer cannot push an account at me that I never agreed to hold.
      // A HEAL NEEDS MY TICK; AN ADD DOES NOT, and the asymmetry is deliberate.
      // Healing replaces a slot I already have, so it is only reasonable for an
      // account I said I share. Adding is the case the owner asked for by name:
      // an account that appears among the decks I paired with appears on all of
      // them, which is the whole of "I do not want to paste blobs any more".
      // What can reach this is what a deck somebody here pressed accept on
      // chose to offer.
      // OVER `list`, NOT THE RAW ARRAY. `offered` above slices to 50 and type-
      // filters `key` and `email`; this line read `theirs.accounts` and got
      // neither. syncAction answers "add" for anything this deck lacks and an
      // add needs no tick, so a peer answering `manifest` with thousands of
      // rows produced thousands of steps — each a sequential `want`/`have`
      // round trip with its own 10s bell plus a claude-swap subprocess holding
      // the store lock, while the panel drew 50 and every other paired deck
      // waited behind it. `step.key` also reached transferChallenge and
      // importAccount untyped, which `offered`'s filter would have caught.
      const wanted = plan(mine, list)
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
        // A verdict rather than a boolean, because "refused" and "kept the
        // slot it already has" are different things to tell somebody and the
        // second one used to be reported as success. A bare `true` is still
        // accepted: the suite drives this with one.
        // The step goes down with the blob: the wiring has to know WHICH account
        // it is placing before it may treat a decline as an empty slot rather
        // than as a healthy one.
        const got = await importAccount(blob, step);
        const ok = got === true || got?.ok === true;
        done.push({ ...step, ok, why: ok ? null : (got?.why ?? "import failed") });
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
   *  exist before there has been one.
   *
   *  EVERY ROW SAYS WHERE IT CAME FROM, in `typed`, and the difference decides
   *  whether reaching it may pin a key sight unseen. A row somebody put in the
   *  address field — or pressed accept on, or joined by invite — is a person
   *  naming a machine. A row `autoAsk` added from a beacon is this deck
   *  answering a shout, which is not the same claim and must not read as one.
   *  See roundWith, where the difference is the whole of the trust rule. */
  const manual = new Map();
  /** What answered at a typed address, once something has. Keyed the same way
   *  `manual` is, because until a connection succeeds an address is all there
   *  is to key on. */
  const learned = new Map();

  const oneRound = async () => {
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
      // time anyway (the mutex in store-lock.mjs), and two peers healing the
      // same account at once would race for a slot number claude-swap assigns
      // as max+1 without a lock of its own.
      all.push(...await roundWith(peer));
    }
    roundAt = now();
    return all;
  };

  /**
   * Where every round waits its turn — the whole list, or one deck from its own
   * dialog — so that whichever is running is running alone. `round` and
   * `roundOne` are the only two ways in, and both come through here.
   *
   * A LINE RATHER THAN A FLAG, because the two ways in want different things
   * from what is already running and both have to end up behind it. A round
   * asked for during a check cannot join it — a check asks one deck, and a
   * round was asked to ask all of them — so it waits. A check asked for during
   * a round can often join it, and sometimes cannot. Both need somewhere to
   * stand that is after whatever is in flight, and this is it.
   *
   * The tail never rejects: `roundWith` reports a failure per peer instead of
   * throwing, and anything else is swallowed here rather than left to stop
   * every turn after it. The caller of the turn that threw still hears it.
   */
  let _turn = Promise.resolve();
  const inTurn = job => {
    const run = _turn.then(job);
    _turn = run.then(() => {}, () => {});
    return run;
  };

  /** The whole round in flight or waiting its turn, or null. See `round` below. */
  let _round = null;

  /**
   * One round at a time, and the one already running is the answer (#1040).
   *
   * The sequential loop above reasons about peers being dialled one after
   * another, which is a statement about the WHOLE round and was only ever true
   * of a round running alone. Two ways in, and they meet: a self-scheduling
   * timer (SYNC_MS, or ASKING_MS while somebody is waiting) and the "Sync now"
   * press, which calls this straight from the route. A press landing on the
   * timer's round gave two rounds walking the same peer list, each reading the
   * same slot as empty and each force-importing a credential over the other —
   * and the second one's blob wins for no reason anybody chose.
   *
   * JOINING rather than skipping, because the press has a reply to send: a
   * caller that got `[]` for "a round is already running" would report "nothing
   * to sync" about a round that was at that moment moving a credential. This is
   * the shape `codexScanOnce` and ccusage's `_inflight` already use.
   *
   * THERE WAS A THIRD WAY IN, and it did not come through here (#1132). The
   * `check now` in a deck's own dialog reaches `roundOne`, which called
   * `roundWith` straight — so a press landing on the timer's round dialled the
   * deck that round was already healing from, and the far side exported the
   * same login twice for one account that needed repairing once. Both now take
   * their turn in one line, above. A round joins only another whole round,
   * never a check: joining a check would answer "ask every deck" with one
   * deck's work and leave the rest waiting another minute.
   */
  const round = () => (_round ??= inTurn(oneRound).finally(() => { _round = null; }));

  return {
    async apply(next) {
      /** The engine itself, for the callbacks handed to the socket below: they
       *  outlive this call and `this` is not theirs to keep. */
      const self = this;
      engine = this;
      const was = cfg;
      cfg = { ...cfg, ...next };
      // TURNING IT ON ANSWERS WHAT IS ALREADY WAITING. A person who switches
      // this on with two rows sitting in the panel means those two as much as
      // the next one, and leaving them queued behind a setting called
      // "automatic" is the switch not doing what it says.
      if (!was.autoAccept && cfg.autoAccept) {
        for (const fp of [...pending.keys()]) this.accept(fp);
      }
      // The same for the other direction: switching `ask` on with four machines
      // already listed asks those four.
      if (!was.autoAsk && cfg.autoAsk) {
        for (const [fp, p] of [...strangers]) if (!declined.has(fp) && !p.pub) this.accept(fp, { byHand: false });
      }
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
        name: cfg.name, handlers: serve, onError, prefer: cfg.port, host, sealFrames, ephemeral,
        trusted: () => cfg.trusted,
        invite: () => (invite && invite.expiresAt > now() ? invite : null),
        // Somebody used the token. They are pinned, and the token is retired —
        // one that pairs twice is one worth stealing twice.
        onInviteUsed: entry => {
          const { list } = addTrusted(cfg.trusted, { fp: entry.fp, pub: entry.pub, name: entry.name, at: now() });
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
        // The same helper the outbound round uses, because a deck that called
        // in and a deck this one called have proved exactly the same thing —
        // see askToAccept.
        onPending: askToAccept,
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
          if (cfg.autoAsk && !had && !declined.has(entry.fp)) { self.accept(entry.fp, { byHand: false }); return; }
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
          const { list } = addTrusted(cfg.trusted, {
            fp: conn.peerFp, pub: conn.peerPub, name: conn.peerName || inv.name, at: now(),
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
    accept(fp, { byHand = true } = {}) {
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
        // `byHand` IS WHAT THE ROW WILL BE ALLOWED TO DO LATER. A press here is
        // a person naming a machine, so the row may be pinned on the round that
        // reaches it. `autoAsk` reaches this same line with byHand false — the
        // deck answering a shout — and the row it leaves may only ASK, which is
        // what the switch's own name says it does. See roundWith.
        this.addPeer(seen.addr, seen.port, { typed: byHand });
        strangers.delete(fp);
        onChange?.();
        return { fp, name: seen.name, addr: seen.addr, port: seen.port, dialled: true };
      }
      const { list, added } = addTrusted(cfg.trusted, { fp, pub: seen.pub, name: seen.name, at: now() });
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
    /**
     * One deck, now — the `check now` in that deck's own dialog.
     *
     * Found the way the list found it: heard on the network under its own
     * fingerprint, or dialled at an address whose answer was that fingerprint.
     * Null when it is neither, which is a deck that only calls in — nothing
     * here holds an address for it, so there is nobody to dial.
     *
     * `roundAt` is left alone: it says when EVERY paired deck was last asked,
     * and asking one of them does not make that true.
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
      const heard = [...beacon.peers.values()].find(p => p.fp === fp && stillListed(p, now()));
      const typed = [...manual.values()].find(p => learned.get(`${p.addr}:${p.port}`)?.fp === fp);
      const peer = heard ?? typed;
      if (!peer) return null;
      const had = lastRound.get(peer.fp);
      await _turn;
      const got = lastRound.get(peer.fp);
      if (got && got !== had) return got.done ?? [];
      // A deck switched off while the press waited is not dialled after all.
      return inTurn(() => (beacon ? roundWith(peer) : []));
    },
    /** Dial this address on every round from now on. Returns false for an
     *  address that is not one, rather than storing a row that can never
     *  connect and reports an error every minute forever. */
    addPeer(addr, port, { typed = true } = {}) {
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
        // This deck's own card, so the panel can read a peer's version against
        // it; and the names somebody here gave other decks, which the panel
        // and the request dialog draw in place of the ones those decks chose.
        about: about ?? null,
        aliases: { ...(cfg.aliases ?? {}) },
        // Whether this deck asks on its own, and whether a request that
        // arrives is answered here or answered for you.
        autoAsk: !!cfg.autoAsk,
        autoAccept: !!cfg.autoAccept,
        // Whether paired decks are told which shared account this one is on.
        shareActive: cfg.shareActive !== false,
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
          // WHAT THE DECK'S OWN DIALOG DRAWS, by identity: the card it sent,
          // the logins it offered last, and when somebody here said yes. All
          // three are keyed by the fingerprint that proved itself, so both
          // halves of a merged row read the same answer.
          const card = id => ({
            about: aboutBy.get(id) ?? null,
            offers: offersBy.get(id) ?? null,
            pairedAt: trustedPeer(cfg.trusted, id)?.at ?? null,
          });
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
              paired: true, waiting: true, last: lastRound.get(t.fp) ?? null,
              // What it is to be "here" for a deck nothing dials: it called,
              // and this is when. Undefined until it has, which is a row the
              // panel draws as unknown rather than as live.
              lastSeen: spokeAt.get(t.fp),
              // AND WHAT IT SAID WHEN IT CALLED — its card, its list, and which
              // of those it is on. The card was kept and never handed over, so
              // the dialog said "it runs an older version" about a deck that
              // had just told it exactly which version it runs.
              ...card(t.fp),
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
