// The invite this deck is offering right now, and what has happened to it:
// lifted out of createEngine in lan-engine.mjs, where it was one variable that
// seven places wrote and read. lan-invite.mjs says what an invite IS — minting
// one, reading one, the proofs that ride the handshake — and stays pure; this
// is the one this deck is holding out, from the press that makes it to the
// proof that spends it or the wrong ones that put it away.
import { MAX_WRONG_PROOFS } from "./lan-invite.mjs";

/**
 * `now` is the engine's clock; `onChange` and `onError` are the engine's own,
 * so the panel redraws and the log reads exactly as it did when this lived
 * inside it.
 */
export function createInviteOffer({ now, onChange, onError }) {
  /** The invite this deck is offering, or null. One at a time: a deck showing
   *  two tokens is a deck whose owner cannot say which one they sent. */
  let invite = null;

  return {
    /** Offer a freshly minted invite in place of whatever was on offer — see
     *  the engine's invite(), which mints it — with no wrong proofs yet. */
    put(made) {
      invite = { ...made, refused: 0 };
      onChange?.();
    },

    /** The invite a proof is checked against, or null once it has run out —
     *  what the listener asks on every handshake. */
    live: () => (invite && invite.expiresAt > now() ? invite : null),

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

    /** Somebody used it: it is spent. Nothing is redrawn here, because the
     *  pairing that spent it redraws once it is done. */
    retire() {
      invite = null;
    },

    /** Somebody presented a proof of the token that did not hold. Counted on
     *  the invite, written to the log with where it came from, and at
     *  MAX_WRONG_PROOFS the invite is put away (#1137) — the owner makes a new
     *  one, which is one press, and the old one stops being something anybody
     *  can keep working at. */
    wrongInvite(from) {
      if (!invite) return;
      const refused = (invite.refused ?? 0) + 1;
      invite = { ...invite, refused };
      const where = from?.addr || "an unknown address";
      onError?.("invite", new Error(`a proof of this deck's invite from ${where} did not hold (${refused} of ${MAX_WRONG_PROOFS})`));
      if (refused >= MAX_WRONG_PROOFS) {
        invite = null;
        onError?.("invite", new Error(`put the invite away after ${MAX_WRONG_PROOFS} proofs that did not hold; make a new one`));
      }
      onChange?.();
    },

    /** The token on offer for status(), with how many proofs of it have failed
     *  so far — the record beside the log's. Null when there is none, or it has
     *  run out. */
    row: () => (invite && invite.expiresAt > now()
      ? { token: invite.token, expiresAt: invite.expiresAt, refused: invite.refused ?? 0 }
      : null),
  };
}
