// WORDS ON THE STRIPES. A glyph alone did not say which door it was: the same
// dial stood for three of them, and the toolbox, the sparkle and the eye
// explained nothing. So a new profile sees each door's word beside its glyph,
// both stripes 156 wide (tokens.css --edge-words-w); "Hide words" at the left
// stripe's foot folds both back to 40 and icons, and » brings the words back.
// One choice per browser, in localStorage.
//
// Under 1100px the board needs the room: the stripes are icons whatever the
// choice, which is kept for a wider window, and the switch is not drawn.
//
// A profile that an earlier version already drew as icons keeps them: whether
// a profile is new is read once, at boot (main.tsx), from what an earlier load
// left behind, before pruneStaleState stamps the schema key on the way past,
// and the answer is stored, so every later load reads the same one.
import { useSyncExternalStore } from "react";
import { localStore, readStored, SCHEMA_KEY, writeStored } from "./storage";

export const STRIPE_WORDS_KEY = "agent-dag.stripeWords";

/** Keys only an earlier load writes: one of them stored says the profile is
 *  not new. The same rule the first-run panels follow. */
export const EARLIER_LOAD_KEYS = [SCHEMA_KEY, "agent-dag.detailOpen", "agent-dag.sessionListOpen"] as const;

/** Where the stripes have the room for their words. */
export const STRIPE_WORDS_QUERY = "(min-width: 1100px)";

/** A stripe's width with icons and with words: tokens.css --edge-w and
 *  --edge-words-w. */
export const STRIPE_W = { icons: 40, words: 156 } as const;

type Store = Pick<Storage, "getItem" | "setItem">;

/**
 * Settles, once per profile and before anything else writes the store, what a
 * profile with no choice of its own sees: an earlier load's profile, icons; a
 * new one, words. Stored either way, so the second load of a new profile is not
 * taken for an old one. Returns whether it stored. A store that refuses costs
 * nothing but this: the words show.
 */
export function settleStripeWords(store: Store | null = localStore()): boolean {
  if (!store) return false;
  try {
    if (store.getItem(STRIPE_WORDS_KEY) !== null) return false;
    const earlier = EARLIER_LOAD_KEYS.some(key => store.getItem(key) !== null);
    store.setItem(STRIPE_WORDS_KEY, earlier ? "off" : "on");
    return true;
  } catch { return false; }
}

/** This tab's choice, only where the store refused to keep it. */
let chosen: boolean | null = null;
const listeners = new Set<() => void>();

/** The choice: words, unless this browser hid them. */
export function stripeWordsShown(): boolean {
  return chosen ?? readStored(STRIPE_WORDS_KEY) !== "off";
}

/** Whether the window has the room for words. A browser that cannot say is
 *  taken at its choice. */
export function stripeWordsRoom(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  try { return window.matchMedia(STRIPE_WORDS_QUERY).matches; } catch { return true; }
}

/** Whether the stripes show their words now: chosen, and the room for them. */
export function stripeWordsOn(): boolean {
  return stripeWordsRoom() && stripeWordsShown();
}

/** A stripe's width now, in px. */
export function stripeWidth(): number {
  return stripeWordsOn() ? STRIPE_W.words : STRIPE_W.icons;
}

export function setStripeWords(shown: boolean): void {
  const value = shown ? "on" : "off";
  writeStored(STRIPE_WORDS_KEY, value);
  chosen = readStored(STRIPE_WORDS_KEY) === value ? null : shown;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab's choice reaches this one through the store.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STRIPE_WORDS_KEY && e.key !== null) return;
    chosen = null;
    listener();
  };
  let room: MediaQueryList | null = null;
  if (typeof window !== "undefined") {
    window.addEventListener?.("storage", onStorage);
    try { room = window.matchMedia?.(STRIPE_WORDS_QUERY) ?? null; } catch { room = null; }
    room?.addEventListener?.("change", listener);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener?.("storage", onStorage);
    room?.removeEventListener?.("change", listener);
  };
}

/** Whether the stripes show their words, kept current. */
export function useStripeWords(): boolean {
  return useSyncExternalStore(subscribe, stripeWordsOn, stripeWordsOn);
}

/** Whether the window has the room for words, kept current: where the switch
 *  between words and icons is drawn. */
export function useStripeWordsRoom(): boolean {
  return useSyncExternalStore(subscribe, stripeWordsRoom, stripeWordsRoom);
}
