// What this deck answers a paired deck that asks — the list of logins it
// offers, or one of them sealed for the asker — lifted out of createEngine in
// lan-engine.mjs. The asking is the engine's round; this is the other end of
// the same two questions, with the checks that decide whether either is
// answered at all. It keeps nothing of its own: every check reads the
// engine's settings, listener and key at the moment it is made, because any
// of them can change while the store is read.
import { credentialAad, IN_USE, mayGiveInUse, seal, sharedWith, slotFor, transferChallenge, trustedPeer } from "./lan-sync.mjs";
import { liveLoginIs } from "./account-health.mjs";
import { isCodexKey } from "./lan-codex.mjs";

/**
 * `settings`, `serverNow` and `myFp` answer the engine's settings in force,
 * its listener (null while it is down) and this deck's fingerprint, each at
 * the moment of asking. `inbound` keeps who called (see lan-inbound.mjs), and
 * `learnCaller` is the engine's dial-back for a paired deck nothing here
 * dials. `keepManifest` and `manifestFrame` are lan-manifest.mjs's,
 * `localAccounts` reads the store in the rules' shape, and `liveLogin`,
 * `exportAccount` and `onError` are the engine's own. `localCodex` and
 * `exportCodex` are the same two for Codex logins, or null on a deck without
 * them — see lan-codex.mjs.
 */
export function createServe({
  settings, serverNow, myFp, inbound, learnCaller, keepManifest, manifestFrame, localAccounts, liveLogin, exportAccount,
  localCodex = null, exportCodex = null, onError,
}) {
  /** Frames from a deck that finished the handshake AND that somebody here has
   *  accepted. Nothing reaches this before both, which is the whole point of
   *  where the two checks sit. `ctx.key` is this connection's key and no other
   *  connection's — see sessionKey. `ctx.send` seals whatever it is handed when
   *  both ends said they seal, so nothing below has to know which kind of deck
   *  asked — see frameChannel. */
  const serve = async (msg, ctx) => {
    // Authentication happened at connection setup; a previously trusted deck
    // may have been unpaired while this socket remained open.
    const mayAnswer = () => settings().enabled && !!serverNow() && !!trustedPeer(settings().trusted, ctx?.peerFp);
    if (!mayAnswer()) return ctx.send({ t: "no", why: "not paired" });
    // Before the verbs, and for every one of them: something that proved it
    // holds a key this deck accepted is talking, now.
    if (ctx?.peerFp) {
      inbound.spoke(ctx);
      learnCaller(ctx);
    }
    try {
      if (msg.t === "manifest") {
        // THE CALLER'S CARD RIDES THE QUESTION, which is the only way a deck
        // that calls in ever says what it is: nothing here dials it, so nothing
        // here ever asks. A seal that does not open is a deck that said nothing.
        // AND SO DOES ITS LIST, from a deck new enough to send one: what it
        // offers, and which of those it is on. This is the only way a deck
        // nothing here dials is ever known by what it offers.
        keepManifest(ctx.key, msg, ctx.peerFp);
        const accounts = await localAccounts();
        const codexAccounts = localCodex ? await localCodex() : null;
        // Reading the store can take long enough for the owner to unpair this
        // deck. Do not disclose account identities or the active account from
        // a manifest assembled before that decision.
        if (!mayAnswer()) return ctx.send({ t: "no", why: "not paired" });
        return ctx.send(manifestFrame(accounts, ctx.key, ctx.peerFp, codexAccounts));
      }
      if (msg.t === "want") {
        // A listener may have authenticated this socket before its owner
        // unpaired the caller or switched sharing off. Recheck at the moment
        // a credential is requested and again after every asynchronous read.
        // What this deck offers THAT deck, which for one the accept switch
        // paired is less than everything ticked — see sharedWith.
        const maySend = () => settings().enabled && !!serverNow() && !!trustedPeer(settings().trusted, ctx.peerFp)
          && sharedWith(settings(), ctx.peerFp).includes(msg.key);
        // ONE ORDER, WHATEVER IS ASKED FOR: the proof, then the store, then
        // whether that deck may have it (#2192). While its owner hides which
        // account this deck is on, the login it is on is refused "not shared",
        // as one not ticked is; refused before the proof and before the store,
        // an unticked one answered a bad proof differently and sooner, which
        // told the two apart.
        // A SECOND PROOF, for the one operation that moves a credential. The
        // session says who connected; this says they are asking for this
        // account, now. A long-lived connection authenticated an hour ago is
        // not a statement about now.
        const want = transferChallenge(ctx.key, {
          nonce: msg.nonce, accountKey: msg.key, fromFp: ctx.peerFp, toFp: myFp(),
        });
        if (typeof msg.proof !== "string" || msg.proof !== want) {
          return ctx.send({ t: "no", why: "proof" });
        }
        // A CODEX LOGIN takes every step below in the same order, from its own
        // store: the tick, the slot, the one this deck is on, readable, alive.
        // Only the CLI check is Claude's, since it asks claude-swap who is
        // signed in. A deck without Codex has none to give.
        const codexWant = isCodexKey(msg.key);
        if (codexWant && !(localCodex && exportCodex)) return ctx.send({ t: "no", why: "not mine to give" });
        // Only what the user ticked, checked again here rather than trusted
        // from the manifest we sent: the list can change between the two, and
        // the answer that matters is the one at the moment of sending.
        const accounts = codexWant ? await localCodex() : await localAccounts();
        if (!maySend()) return ctx.send({ t: "no", why: "not shared" });
        // The slot manifestFor told the peer about, by the same rule: with two
        // slots for one identity, an expired one listed first must not hide a
        // live one behind it.
        const mine = slotFor(accounts, msg.key);
        if (!mine) return ctx.send({ t: "no", why: "not mine to give" });
        // NOT THE LOGIN THIS DECK IS ON, unless its owner said so (#2192). The
        // manifest already marked it not to be asked for, and a peer older than
        // that mark asks anyway; this is the answer that does not depend on the
        // asker's version, read off the same store read as everything below.
        // While its owner hides which account this deck is on, the manifest
        // leaves that login out, and the refusal is the one an unticked login
        // gets: "in use" would name it.
        if (!mayGiveInUse(accounts, msg.key, settings().sendInUse)) {
          return ctx.send({ t: "no", why: settings().shareActive === false ? "not shared" : IN_USE });
        }
        // A LOGIN THIS DECK CANNOT READ IS SAID SO, from state rather than from
        // a failed export: no subprocess, and nothing the CLI printed. The
        // asking deck prints it under the account, so the person learns which
        // machine to unlock instead of reading "export failed".
        if (!mine.readable) return ctx.send({ t: "no", why: mine.unreadableWhy });
        if (!mine.alive) return ctx.send({ t: "no", why: "not mine to give" });
        // The active slot exports the live CLI login, and its verdict can
        // predate a `/login` as somebody else, so ask the CLI who it is now.
        if (!codexWant && mine.active && liveLogin && !liveLoginIs(await liveLogin(), mine.email, mine.org)) {
          return ctx.send({ t: "no", why: "export failed" });
        }
        if (!maySend()) return ctx.send({ t: "no", why: "not shared" });
        let blob;
        try { blob = codexWant ? await exportCodex(mine.num, msg.key) : await exportAccount(mine.num, msg.key); }
        catch (err) {
          if (codexWant && err?.code === 'windows_permissions_required') return ctx.send({ t: 'no', why: 'windows_permissions_required' });
          throw err;
        }
        if (!maySend()) return ctx.send({ t: "no", why: "not shared" });
        // A Mac's failed export refreshes the verdict behind `readable` in the
        // background, so when the Keychain was why, the next ask is answered by
        // the line above.
        if (!blob) return ctx.send({ t: "no", why: "export failed" });
        const aad = credentialAad(myFp(), ctx.peerFp, msg.key);
        return ctx.send({ t: "have", key: msg.key, sealed: seal(ctx.key, blob, aad) });
      }
    } catch (err) {
      onError?.("serve", err);
      ctx.send({ t: "no", why: "error" });
    }
  };

  return { serve };
}
