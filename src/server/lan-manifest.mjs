// This deck's side of the manifest exchange: the frame it sends — the accounts
// it shares, which of them it is on, and its card — and what it keeps of the
// frame it hears back. Lifted out of createEngine in lan-engine.mjs with the
// two maps only these fill, so saying and hearing sit in one file as they sat
// side by side in the engine. The rules for the lists themselves are
// lan-sync.mjs's, and the card's are lan-about.mjs's.
import { currentFor, heardCurrent, manifestFor, offered } from "./lan-sync.mjs";
import { openAbout, sealAbout } from "./lan-about.mjs";

/**
 * `about` is this deck's own card, or null for a deck built without one. `now`
 * is the engine's clock. `myFp` answers this deck's fingerprint as it is at
 * the moment of asking — a restart for a new key changes it — and `settings`
 * the settings in force, of which a manifest reads `shared` and `shareActive`.
 */
export function createManifests({ about, now, myFp, settings }) {
  /** What each paired deck said about itself — version, operating system,
   *  architecture — keyed by fingerprint, most recent only. Filled from both
   *  directions: the manifest a deck answers with, and the question a deck that
   *  calls in asks. See lan-about.mjs. */
  const aboutBy = new Map();
  /** The accounts each paired deck offered in its last manifest, keyed by
   *  fingerprint. Kept APART from the engine's lastRound on purpose: a round
   *  that fails replaces that line, and the list a deck offered a minute ago is
   *  still the best answer to "what does it share" while it is unreachable. */
  const offersBy = new Map();

  /** This deck's card for one connection, as a frame field — or nothing, for a
   *  deck built without one. Spread into the frame, so a deck from before this
   *  existed receives exactly the frame it always did plus one key it never
   *  reads. */
  const cardFor = (key, toFp) => {
    const sealed = sealAbout(key, about, myFp(), toFp);
    return sealed ? { about: sealed } : {};
  };

  /** This deck's manifest for the deck on the other end of `key`: the accounts
   *  it shares, which of them it is on, and its card. One frame whichever way
   *  it travels — the question a round asks, and the answer `serve` gives. */
  const manifestFrame = (accounts, key, toFp) => {
    const cfg = settings();
    return {
      t: "manifest", accounts: manifestFor(accounts, cfg.shared),
      ...currentFor(accounts, cfg.shared, cfg.shareActive),
      ...cardFor(key, toFp),
    };
  };

  /**
   * What a paired deck's manifest said about it, kept for the panel — the
   * question a deck that calls in asks as much as the answer a dialled one
   * gives. Its card, when the seal opens; and the accounts it offers with the
   * one it is on, kept only when a list came — an older caller asks with its
   * card alone, and a missing list is not an empty one. Returns that list, or
   * null for a frame that carried none.
   */
  const keepManifest = (key, frame, fromFp) => {
    const card = openAbout(key, frame.about, fromFp, myFp());
    if (card) aboutBy.set(fromFp, { ...card, at: now() });
    if (!Array.isArray(frame.accounts)) return null;
    const list = offered(frame.accounts);
    offersBy.set(fromFp, { at: now(), accounts: list, current: heardCurrent(frame.current, list) });
    return list;
  };

  /** What the deck proven as `fp` last said, for its row: its card and the
   *  logins it offered, each null until it has said one. */
  const heardOf = fp => ({
    about: aboutBy.get(fp) ?? null,
    offers: offersBy.get(fp) ?? null,
  });

  return { manifestFrame, keepManifest, heardOf };
}
