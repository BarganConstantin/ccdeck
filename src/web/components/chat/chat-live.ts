// What keeps Chat light while it lives: the conversation read again every
// second or so, a clock under it, the composer typed into above it, and none
// of that redraws a turn that did not change. Pure; ChatView holds the state.
//
// A BLOCK IS THE SAME when its turns are the same objects (the turns kept as
// the objects they were, chat-turn-align.ts), a waiting question is answered
// the same way, and every other prop is the same: the memo of chat-blocks.ts.
import type { ChatAsk, ChatTurn } from "./chat-model";
import { sameTurns } from "../../chat-turn-align";

/** Every field the same (a question's way of being answered: what blocks it, which turn, how it sends). */
function sameFields(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  return keys.every(key => Object.hasOwn(y, key) && Object.is(x[key], y[key]));
}

/** The memo's test for a block of the conversation: its turns the same objects,
 *  a waiting question answered the same way, and every other prop the same.
 *  Props it does not know are compared as they are, so a prop added later
 *  redraws the block when it changes rather than being missed. */
export function sameBlockProps(prev: object, next: object): boolean {
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === "turns") {
      if (!Array.isArray(a.turns) || !Array.isArray(b.turns) || !sameTurns(a.turns as ChatTurn[], b.turns as ChatTurn[])) return false;
    } else if (key === "ask") {
      if (!sameFields(a.ask as ChatAsk | undefined, b.ask as ChatAsk | undefined)) return false;
    } else if (key === "time") {
      // An answer's time is worked out anew whenever a line arrives: the same when its fields are.
      if (!sameFields(a.time as object | undefined, b.time as object | undefined)) return false;
    } else if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}
