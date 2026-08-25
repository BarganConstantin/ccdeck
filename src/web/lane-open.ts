// Which rows have their model lanes open was remembered by slot number, and a
// slot number is not a name for an account.
//
// account-move.ts opens with the rule this file exists to finish: everything
// the accounts panel remembers about a row is keyed by slot, `cswap move` into
// an occupied slot is a SWAP, and after one every stored number names the OTHER
// account. That file relocates the four things the manage block holds. The set
// of expanded rows was not one of them and was only ever written by its own
// toggle, so after a swap the disclosure stayed on the number: the account the
// user had opened came back collapsed, and a row belonging to somebody else
// stood expanded with `aria-expanded="true"` on a control nobody pressed,
// reporting per-model quota for an account that was never asked about (#542).
//
// Adding a fifth field to ManageState would have fixed the swap and nothing
// else, because it is the only case that goes through a move. Two others do
// not. A removed account leaves its number in the set forever — the panel has
// no other way to forget it — and claude-swap reuses slots: the server says so
// where it guards its own usage rows, "a removed account leaves its row behind
// and slots get reused". So whoever lands on that number next opens
// pre-expanded, from a press aimed at an account that is gone.
//
// The answer is to stop naming rows by where they are standing. An expanded row
// is remembered by WHO is in it, which is a fact no move can change, and the
// set is filtered against the roster on every load so a name nobody answers to
// is dropped rather than left waiting for its slot to be reused.
//
// Identity is email plus organization, which is the same pair claude-swap
// itself matches a usage row to an account by (claude-accounts.mjs: `row.email
// === acct.email && (row.organizationUuid ?? "") === (acct.organizationUuid ??
// "")`). The panel is shipped the organization NAME rather than its uuid, so
// that is what it can use; the pair still separates one address signed into two
// organizations, which is the case the uuid is there for.
//
// This is a pure function in its own file for the reason account-move.ts gives
// for the same move: the suite runs on plain node with no DOM, the panel cannot
// be rendered, and a rule that only exists inside JSX is a rule nothing can
// check.

/** The parts of an account row this file needs to tell it from the others. */
export interface LaneOwner {
  /** The cswap slot the account is standing in right now — the thing that
   *  changes hands, kept only as the last resort below. */
  num: number;
  email?: string | null;
  /** The organization name, as `claude-accounts.mjs` ships it. */
  org?: string | null;
}

/** Separates the two halves of an identity key. No address contains a NUL, so
 *  no email + org pair can be spelled to collide with a different one. */
const SEP = "\u0000";

/**
 * The name an expanded row is remembered by.
 *
 * Email and organization when there is an email, because that pair survives
 * every move, every swap and every renumbering — it is the account, not its
 * position.
 *
 * The slot when there is not. claude-swap can hold a row it has never resolved
 * an address for, and for those there is genuinely nothing stable to follow, so
 * they keep the old behaviour rather than all collapsing onto one shared empty
 * key — which would be worse than the bug, opening every unidentified row at
 * once. The `slot:` prefix keeps such a key from ever equalling an identity, so
 * a row that gains its address later is simply a row that was never opened.
 */
export function laneKey(a: LaneOwner): string {
  const email = typeof a.email === "string" ? a.email.trim() : "";
  if (!email) return `slot:${a.num}`;
  const org = typeof a.org === "string" ? a.org.trim() : "";
  return `acct:${email}${SEP}${org}`;
}

/** The expanded set after the disclosure on this row is pressed. */
export function toggleLane(open: string[], a: LaneOwner): string[] {
  const key = laneKey(a);
  return open.includes(key) ? open.filter(k => k !== key) : [...open, key];
}

/**
 * The expanded set after a fresh roster arrives: only rows somebody is still in.
 *
 * An account that was removed while expanded would otherwise sit in this set
 * for as long as the panel is mounted, waiting to reopen itself the moment the
 * user signs that address back in. Dropping it here means the state lasts
 * exactly as long as the account does.
 *
 * A roster that is missing — a failed poll, a store that could not be read —
 * is not evidence that anybody left, so it changes nothing. The panel polls
 * every fifteen seconds and the array itself is returned unchanged when nothing
 * was dropped, so the common case is a state update React discards rather than
 * a re-render every poll.
 */
export function knownLanes(open: string[], roster: readonly LaneOwner[] | null | undefined): string[] {
  if (!Array.isArray(roster)) return open;
  const live = new Set(roster.map(laneKey));
  const kept = open.filter(k => live.has(k));
  return kept.length === open.length ? open : kept;
}
