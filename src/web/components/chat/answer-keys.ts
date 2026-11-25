// The keys a waiting question takes from anywhere in its Chat pane: the
// Decision card's digits and Esc (decision-keys.ts paneKeyEvent), and the
// question card's digits (ChatTurn.tsx AskCard). herdr's chat answers a prompt
// this way; so does Claude Code's own, where the prompt has the keys.
//
// WHERE A KEY COUNTS. Inside the card's pane (the stage section, or the chat
// when there is no stage), but not inside the card, which reads its own keys;
// not in the terminal; and not in a text field, except the reply box while it
// is empty. A word in the box is a message being written: its digits are text.
//
// NOT AT ONCE. A card that has just come is not answered by a key pressed in
// its first ARM_MS: that key was meant for whatever was there before.
//
// The listener is the pane's own, so it hears a key before the deck's
// shortcuts (window) and before React's handlers (the root): a key it answers
// goes no further.
import { useEffect, useRef, useState, type RefObject } from "react";

/** How long after a card comes before the pane's keys answer it. */
export const ARM_MS = 400;

/** The element a key was pressed on, as much of it as the rules read. */
export interface KeyTargetLike {
  tagName?: string;
  type?: string;
  value?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
  closest?(selector: string): unknown;
  matches?(selector: string): boolean;
}

const TEXT_INPUTS = new Set(["", "text", "search", "url", "tel", "email", "password", "number"]);

/** A control that takes typed text. */
export function isTextField(el: KeyTargetLike): boolean {
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return TEXT_INPUTS.has((el.type ?? "").toLowerCase());
  if (el.isContentEditable) return true;
  return (el.getAttribute?.("role") ?? "") === "textbox";
}

/** The reply box under the conversation. */
export const REPLY_BOX = ".chat-composer-draft";

/** Whether a key pressed on `target` is the pane's to give to `card`. */
export function paneKeyAllowed(target: KeyTargetLike | null | undefined, card: { contains?(node: unknown): boolean } | null): boolean {
  if (!target || typeof target.closest !== "function") return false;
  if (card?.contains?.(target)) return false;
  if (target.closest("[data-terminal-panel]")) return false;
  if (isTextField(target)) return target.matches?.(REPLY_BOX) === true && (target.value ?? "") === "";
  return true;
}

type Listening = Pick<HTMLElement, "addEventListener" | "removeEventListener" | "contains">;

/** The pane a card answers keys in. */
function paneOf(card: HTMLElement): Listening | null {
  return (card.closest?.(".ts-stage") ?? card.closest?.(".chat") ?? null) as Listening | null;
}

/**
 * Hands the keys pressed in `anchor`'s pane to `handle` while `on`, from
 * ARM_MS after it came on. `handle` says whether it took the key; a key taken
 * goes no further. Returns whether the focus is in that pane now, for the
 * status bar to name the card's keys only there.
 */
export function usePaneAnswerKeys(
  anchor: RefObject<HTMLElement | null>,
  on: boolean,
  handle: (event: KeyboardEvent) => boolean,
): boolean {
  const live = useRef(handle);
  live.current = handle;
  const [inPane, setInPane] = useState(false);
  useEffect(() => {
    const card = anchor.current;
    const pane = on && card ? paneOf(card) : null;
    if (!card || !pane) { setInPane(false); return; }
    const armedAt = Date.now() + ARM_MS;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
      if (Date.now() < armedAt) return;
      if (!paneKeyAllowed(event.target as KeyTargetLike | null, card)) return;
      if (!live.current(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onFocusIn = () => setInPane(true);
    const onFocusOut = (event: FocusEvent) => setInPane(pane.contains(event.relatedTarget as Node | null));
    pane.addEventListener("keydown", onKey);
    pane.addEventListener("focusin", onFocusIn);
    pane.addEventListener("focusout", onFocusOut as EventListener);
    setInPane(typeof document !== "undefined" && pane.contains(document.activeElement));
    return () => {
      pane.removeEventListener("keydown", onKey);
      pane.removeEventListener("focusin", onFocusIn);
      pane.removeEventListener("focusout", onFocusOut as EventListener);
    };
  }, [on, anchor]);
  return inPane && on;
}

/** Whether a question card's digits answer it: each question is one choice
 *  from a list. A card with a several-answers question is answered on the card. */
export function askTakesDigits(questions: readonly { options: readonly unknown[]; multi?: boolean }[]): boolean {
  return questions.length > 0 && questions.every(q => q.options.length > 0 && !q.multi);
}

/** The picks after digit `index` (from 0): it answers the first question with
 *  no answer yet. Null when every one has one, or that question has no such
 *  option. */
export function askDigitPicks(
  questions: readonly { options: readonly unknown[] }[],
  picks: readonly { options: number[]; text?: string }[],
  index: number,
): { options: number[]; text?: string }[] | null {
  const at = questions.findIndex((_, i) => {
    const pick = picks[i];
    return !pick || (pick.options.length === 0 && pick.text === undefined);
  });
  if (at < 0 || index < 0 || index >= questions[at].options.length) return null;
  return questions.map((_, i) => (i === at ? { options: [index] } : picks[i] ?? { options: [] }));
}
