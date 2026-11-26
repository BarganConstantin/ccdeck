// Where the turns of one read of a conversation stand against another's.
// Pure, and outside components/chat/ so the transcript's hook can use it too
// (the screens' chunk is reached only through use-screens.ts).
//
// ONE OBJECT PER THING SAID. Every read of the transcript hands every turn back
// as a new object, the ones that did not change included. `turnInterner` gives
// a turn the object it had last time whenever it says the same, so "the same
// turn" is the same object, and a run of them is the same run.
//
// WHERE A TURN IS. The host's live window slides once the conversation outgrows
// it: a new turn at the end pushes the first one out, the count stays, and
// every index moves by one. `alignTurns` finds the last turns of the earlier
// read in the new one, which says how many went from the front (or came in
// front, when older ones were loaded) and how many arrived at the end.
import type { ChatTurn } from "./components/chat/chat-model";

/** The turns of each read, each one the object it was before when it says the same. */
export function turnInterner(): (turns: readonly ChatTurn[]) => ChatTurn[] {
  // A turn's words, once read: a turn kept from one read to the next (an older
  // page) is never written out twice.
  const keys = new WeakMap<ChatTurn, string>();
  let held = new Map<string, ChatTurn>();
  return turns => {
    const next = new Map<string, ChatTurn>();
    const out = turns.map(turn => {
      let key = keys.get(turn);
      if (key === undefined) {
        key = JSON.stringify(turn);
        keys.set(turn, key);
      }
      const same = next.get(key) ?? held.get(key) ?? turn;
      next.set(key, same);
      return same;
    });
    held = next;
    return out;
  };
}

/** Two runs of turns are the same run: as many, each the same object. */
export function sameTurns(a: readonly ChatTurn[], b: readonly ChatTurn[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** How the turns read now stand against the turns read before. */
export interface TurnsMoved {
  /** Turns gone from the front: the window slid. Negative when turns came in front (older ones loaded). */
  dropped: number;
  /** Turns new at the end. */
  arrived: number;
}

/** How far back from the end of the earlier read a turn is looked for: the
 *  last turn changes in place (a call finishes, a question is answered), and
 *  so may the one before it. */
const LOOK_BACK = 3;

/** Where the earlier read's last turns are in the new one; null when they are
 *  not there at all (another conversation, a file replaced, nothing before). A
 *  turn is found from the end, and with the turn before it when both reads have
 *  one, so a call made twice running is not taken for the earlier one. */
export function alignTurns(prev: readonly ChatTurn[], next: readonly ChatTurn[]): TurnsMoved | null {
  if (!prev.length || !next.length) return null;
  for (let back = 0; back < LOOK_BACK && back < prev.length; back++) {
    const at = prev.length - 1 - back;
    const turn = prev[at];
    for (let j = next.length - 1; j >= 0; j--) {
      if (next[j] !== turn) continue;
      if (at > 0 && j > 0 && next[j - 1] !== prev[at - 1]) continue;
      return { dropped: at - j, arrived: Math.max(0, next.length - j - (prev.length - at)) };
    }
  }
  return null;
}
