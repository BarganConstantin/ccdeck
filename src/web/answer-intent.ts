// An answer chosen away from the prompt it answers: on an alert card, or on a
// system notification's button. One intent, held here until the pane that
// shows its session in Chat can press it through the prompt's own card.
//
// NOTHING IS SENT FROM HERE. An intent is a wish, not a key. It is pressed only
// by the card that answers the prompt (the Decision card's choose path, or the
// question card's Send), which re-reads the screen before any key goes, and
// only when that card's row at the intent's place carries the same words. A
// prompt that changed between the alert and the card is left to the reader.
//
// FIVE RULES, each pinned in answer-intent.test.ts:
//  1. One intent per session, the newest; a second press replaces the first.
//  2. Single use: `take` hands it out once.
//  3. It expires (INTENT_TTL_MS), and it is dropped when its session stops
//     waiting, or waits on another prompt (`since` moved).
//  4. A locked row (the session's rules or mode: "don't ask again", always
//     allow, auto-accept, clear context) is never answered from here, whatever
//     the card says about it.
//  5. The words must match: the row at the intent's index, normalised, or for
//     a "No" given without an index, the one row that starts with it.
import { useSyncExternalStore } from "react";

/** How long an intent waits for its card. */
export const INTENT_TTL_MS = 2 * 60 * 1000;
/** Between the card showing the matching row and the press: the screen settles
 *  and a reader who is looking sees the row before it is chosen. */
export const INTENT_ARM_MS = 400;
/** How long a pane showing the session in Chat waits for its card before it
 *  gives the intent up and leaves the prompt to the reader. */
export const INTENT_LAND_MS = 10_000;

/** What the alert answers: a permission prompt, or a question's option. */
export type IntentKind = "permission" | "question";

export interface AnswerIntent {
  /** Unique per intent: a pane presses each one at most once. */
  id: number;
  sessionId: string;
  kind: IntentKind;
  /** The words of the row chosen, as the alert showed them. */
  choiceLabel: string;
  /** The row's place, from 0; null for a row found by its words alone (Deny). */
  choiceIndex: number | null;
  /** The block's `since` the alert was raised for: another block is another prompt. */
  since?: number;
  /** What the alert said the call was ("npm test"): a card naming another call
   *  is another prompt. */
  detail?: string;
  createdAt: number;
  expiresAt: number;
}

/** A row of the card the intent is matched against. */
export interface IntentRow {
  label: string;
  /** Changes the session's rules or mode: only in the terminal. */
  locked?: boolean;
  /** Takes words: never from an alert. */
  free?: boolean;
}

/** Why an intent was not pressed. */
export type IntentMiss = "expired" | "changed" | "locked";

export type IntentMatch = { ok: true; index: number } | { ok: false; reason: IntentMiss };

/** Words that change the session's rules or mode, refused even on a row the
 *  card did not lock: the alert's promise is "this once", and nothing else. */
const RULE_WORDS = /don['’]t ask again|always allow|allow all|auto-accept|clear context|bypass|ultraplan/i;

/** A row's words as compared: one space, no case, no key hint like "(esc)". */
export function normLabel(label: string): string {
  return label.normalize("NFKC").replace(/\s*\((?:esc|shift\+tab|tab|enter)\)\s*$/i, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

/** Whether a row may never be answered from an alert. */
export function lockedRow(row: IntentRow): boolean {
  return row.locked === true || row.free === true || RULE_WORDS.test(row.label);
}

/** A call's words as compared: one space, the first 60 characters. */
const callWords = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 60);

/** Whether the alert's call and the card's call can be the same one: either
 *  is unknown, or one begins with the other (the board keeps a one-line
 *  preview, the transcript the first 120 characters). */
export function sameCall(alerted: string | undefined, carded: string | undefined): boolean {
  const a = callWords(alerted ?? "");
  const b = callWords(carded ?? "");
  if (!a || !b) return true;
  return a.startsWith(b) || b.startsWith(a);
}

/** How much of the alert's call the screen must show: its start, spaces
 *  aside, since the screen wraps a long command where it likes. */
const SCREEN_CALL_CHARS = 24;

/** Whether the terminal's screen shows the call the alert named. Not asked
 *  (`screen` undefined), it is not in the way; unreadable (null), it is. The
 *  screen is what "Yes" answers, and the transcript can trail it. */
export function screenShowsCall(screen: string | null | undefined, call: string | undefined): boolean {
  if (!call || screen === undefined) return true;
  if (screen === null) return false;
  const want = call.replace(/\s+/g, "").slice(0, SCREEN_CALL_CHARS);
  return !want || screen.replace(/\s+/g, "").includes(want);
}

/** Does `intent` still name a row of `rows`, the card now on screen for its
 *  session (whose call is `call`, when the card names one, and whose terminal
 *  shows `screen`, when it was read)? The row's index when it does, why not
 *  when it does not. */
export function matchIntent(intent: AnswerIntent, rows: readonly IntentRow[], now: number, call?: string, screen?: string | null): IntentMatch {
  if (now >= intent.expiresAt) return { ok: false, reason: "expired" };
  if (!sameCall(intent.detail, call)) return { ok: false, reason: "changed" };
  if (!screenShowsCall(screen, intent.detail)) return { ok: false, reason: "changed" };
  const want = normLabel(intent.choiceLabel);
  if (!want) return { ok: false, reason: "changed" };
  if (intent.choiceIndex !== null) {
    const row = rows[intent.choiceIndex];
    if (!row || normLabel(row.label) !== want) return { ok: false, reason: "changed" };
    return lockedRow(row) ? { ok: false, reason: "locked" } : { ok: true, index: intent.choiceIndex };
  }
  // By its words alone: exactly one row, the same words or the same words and
  // a clause after a comma ("No" is "No, and tell Claude what to do differently").
  const found: number[] = [];
  rows.forEach((row, i) => {
    const words = normLabel(row.label);
    if (words === want || words.startsWith(`${want},`)) found.push(i);
  });
  if (found.length !== 1) return { ok: false, reason: "changed" };
  return lockedRow(rows[found[0]]) ? { ok: false, reason: "locked" } : { ok: true, index: found[0] };
}

/** What a waiting session looks like to the store: its id and its block's start. */
export interface WaitingMark { id: string; since: number }

export interface IntentInput {
  sessionId: string;
  kind: IntentKind;
  choiceLabel: string;
  choiceIndex: number | null;
  since?: number;
  detail?: string;
}

/** What became of an intent, said once by the alert stack. */
export interface IntentOutcome {
  sessionId: string;
  /** Sent through the card, or left for the reader and why. */
  kind: "answered" | IntentMiss | "timeout";
  at: number;
}

export interface IntentStore {
  /** Holds a new intent for its session, replacing any before it. */
  put(input: IntentInput, now?: number): AnswerIntent;
  /** The live intent for a session, without taking it. */
  peek(sessionId: string, now?: number): AnswerIntent | null;
  /** Hands the intent out once: a second take of the same id is null. */
  take(id: number): AnswerIntent | null;
  /** Forgets a session's intent. */
  drop(sessionId: string): void;
  /** Forgets every intent whose session no longer waits, waits on another
   *  block, or has run out of time. */
  prune(waiting: readonly WaitingMark[], now?: number): void;
  /** What became of the last intents, newest last. */
  outcomes(): readonly IntentOutcome[];
  report(outcome: IntentOutcome): void;
  subscribe(listener: () => void): () => void;
  /** Changes whenever anything above does. */
  version(): number;
}

/** How many outcomes are kept for the stack to say. */
const MAX_OUTCOMES = 4;

export function createIntentStore(clock: () => number = Date.now): IntentStore {
  const held = new Map<string, AnswerIntent>();
  const listeners = new Set<() => void>();
  let said: IntentOutcome[] = [];
  let nextId = 1;
  let v = 0;
  const changed = () => { v++; for (const l of [...listeners]) l(); };
  const live = (intent: AnswerIntent | undefined, now: number) => (intent && now < intent.expiresAt ? intent : null);
  return {
    put(input, now = clock()) {
      const intent: AnswerIntent = {
        id: nextId++, sessionId: input.sessionId, kind: input.kind,
        choiceLabel: input.choiceLabel, choiceIndex: input.choiceIndex,
        ...(input.since !== undefined ? { since: input.since } : null),
        ...(input.detail ? { detail: input.detail } : null),
        createdAt: now, expiresAt: now + INTENT_TTL_MS,
      };
      held.set(input.sessionId, intent);
      changed();
      return intent;
    },
    peek(sessionId, now = clock()) {
      return live(held.get(sessionId), now);
    },
    take(id) {
      for (const [sessionId, intent] of held) {
        if (intent.id !== id) continue;
        held.delete(sessionId);
        changed();
        return intent;
      }
      return null;
    },
    drop(sessionId) {
      if (held.delete(sessionId)) changed();
    },
    prune(waiting, now = clock()) {
      const since = new Map(waiting.map(w => [w.id, w.since]));
      let any = false;
      for (const [sessionId, intent] of held) {
        const block = since.get(sessionId);
        const gone = block === undefined || (intent.since !== undefined && intent.since !== block) || now >= intent.expiresAt;
        if (gone) { held.delete(sessionId); any = true; }
      }
      if (any) changed();
    },
    outcomes: () => said,
    report(outcome) {
      said = [...said, outcome].slice(-MAX_OUTCOMES);
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    version: () => v,
  };
}

/** The deck's one store. */
export const answerIntents = createIntentStore();

/** Re-renders when the store changes; returns its version. */
export function useIntentVersion(store: IntentStore = answerIntents): number {
  return useSyncExternalStore(store.subscribe, store.version, store.version);
}
