// Which of this deck's accounts another deck is working on right now (#2192).
//
// ONE LOGIN, LIVE IN ONE PLACE. A Claude refresh token is good for one renewal:
// the copy that renews it first gets a new one, and every other copy of that
// login is refused with invalid_grant from then on. Claude Code answers that by
// wiping the stored login, and every session on that machine stops with "Login
// expired · Please run /login". Two machines that hold one copied login hold one
// expiry too, so both reach for the renewal within minutes of each other and
// the slower one loses — which is what the owner measured: three of seven
// interruptions in a month landed on the 8-hour renewal with nothing on that
// machine renewing in between.
//
// Local network already says which account each paired deck is on (`current`
// in its manifest — see currentFor in lan-copies.mjs), so this needs nothing new
// on the wire: it reads what the status already holds. It is the one rule the
// row's warning, the notification and the auto-switch tick all ask, so the three
// cannot disagree about which deck is on what. The page reads it through
// lan-elsewhere.d.mts; the server through the door at the bottom, which
// lan-deck.mjs connects to its engine.
//
// Pure apart from that door. No sockets, no timers, no filesystem.

/**
 * How recent a deck's word has to be for "it is on this account right now".
 *
 * A paired deck says which account it is on in every manifest, and a manifest
 * crosses at least once a minute each way — this deck's round asks it, and its
 * round carries one in. Five minutes is five rounds: a dropped round or two does
 * not take the warning down and put it back, which would read as two incidents,
 * and a deck that was switched off stops counting soon after. Past it, what the
 * deck said is its last word rather than its current one.
 */
export const ELSEWHERE_FRESH_MS = 5 * 60_000;

/** An address that is this machine: loopback, or one of its own. A second deck
 *  on this machine shares its Claude login rather than copying it, so it is not
 *  another place the login is live. */
function onThisMachine(addr, mine) {
  if (typeof addr !== "string" || !addr) return false;
  if (addr === "::1" || addr === "localhost" || addr.startsWith("127.")) return true;
  return Array.isArray(mine) && mine.includes(addr);
}

/**
 * The paired decks that said, within `freshMs`, that they are working on one of
 * the accounts they share — keyed by account, one row per deck.
 *
 * ONLY WHAT A DECK SAID, AND ONLY RECENTLY. A deck names the account it is on
 * only when it shares that account and its owner left "Show paired decks which
 * of these this deck is using" on; `hidden`, `other`, nothing at all (a deck
 * older than 3.22.15 never says) and a word older than `freshMs` all prove
 * nothing, and none of them is drawn as a deck on an account. A deck that is
 * not paired any more is not counted either: what it said was said to a deck
 * that no longer listens.
 *
 * `status` is the engine's status() — or the page's copy of it, the same shape.
 */
export function decksByAccount(status, now, freshMs = ELSEWHERE_FRESH_MS) {
  const out = new Map();
  if (!status?.enabled) return out;
  const seen = new Set();
  for (const p of Array.isArray(status.peers) ? status.peers : []) {
    if (!p || p.paired !== true) continue;
    const said = p.offers;
    const key = said?.current && typeof said.current.key === "string" ? said.current.key : "";
    if (!key || typeof said.at !== "number" || !Number.isFinite(said.at)) continue;
    // Within the window, and not from the future: a clock that ran ahead is not
    // a promise about the next five minutes.
    if (now - said.at > freshMs || said.at - now > freshMs) continue;
    if (onThisMachine(p.addr, status.addrs)) continue;
    // One deck reached two ways is merged into one row by the engine already;
    // the same deck under the same key twice would still be one deck.
    const id = `${key}|${p.peerFp ?? p.fp}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.set(key, [...(out.get(key) ?? []), p]);
  }
  return out;
}

/** A deck as a sentence names it: the name somebody here gave it, else its own. */
export function deckName(p, aliases) {
  const id = p?.peerFp ?? p?.fp;
  const given = aliases && typeof aliases === "object" && typeof aliases[id] === "string" ? aliases[id].trim() : "";
  const own = typeof p?.name === "string" ? p.name.trim() : "";
  return given || own || "another deck";
}

/** The same answer as names: account key to the decks on it, each named once
 *  and in order, so one machine reached under two keys is one name. */
export function namesByAccount(status, now, freshMs = ELSEWHERE_FRESH_MS) {
  const out = new Map();
  for (const [key, rows] of decksByAccount(status, now, freshMs)) {
    const names = [...new Set(rows.map(p => deckName(p, status?.aliases)))].sort((a, b) => a.localeCompare(b));
    out.set(key, names);
  }
  return out;
}

/** "iMac", "iMac and PC", "iMac, Mac and PC". */
export function deckList(names) {
  if (names.length <= 1) return names[0] ?? "another deck";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ── the door ────────────────────────────────────────────────────────────────
//
// The tick and the notifier need the engine's status, and the engine lives in
// lan-deck.mjs, which imports far more than either of them should. So
// lan-deck.mjs hands its status() in here as it loads, and they ask here. Until
// it does — a test that runs the tick on its own — the answer is that no deck is
// on anything, which is what a deck with Local network off would say too.

let _status = null;

/** lan-deck.mjs's, once, as it loads. */
export function connectLanStatus(status) {
  _status = typeof status === "function" ? status : null;
}

/** namesByAccount over the engine's status as it is now. Never throws: a
 *  status that could not be read is a deck that knows of nobody. */
export function elsewhereNow(now = Date.now()) {
  try {
    return _status ? namesByAccount(_status(), now) : new Map();
  } catch {
    return new Map();
  }
}
