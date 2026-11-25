// The one-time offer, inside Chat, to have the deck raise a system alert when a
// session needs you. Notifications are off until somebody turns them on
// (deck-prefs.mjs), and that stays so: the offer only says where the switch is,
// once, and is gone for good when it is taken up or dismissed.
//
// What it reads is the notifications state App.tsx already holds
// (use-os-notifications.ts), published here so the Workspace pane can draw the
// offer without that state being threaded down to it.
import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage";
import type { NotifyPermission } from "./notify";

/** Set once the offer was taken up or dismissed. */
export const NOTIFY_OFFER_KEY = "agent-dag.alertOffer";

export interface NotifyOfferState {
  /** The browser has notifications at all. */
  supported: boolean;
  permission: NotifyPermission;
  /** The deck's own switch. */
  on: boolean;
  /** Turned off at launch (AGENTS_DECK_NO_NOTIFY): the offer cannot help. */
  vetoed: boolean;
  /** The desktop app raises its own and has no use for the browser's. */
  desktop: boolean;
  /** Turns the switch on and asks the browser, on the reader's press. */
  turnOn(): void;
}

const OFF: NotifyOfferState = { supported: false, permission: "denied", on: false, vetoed: false, desktop: false, turnOn: () => {} };

let state: NotifyOfferState = OFF;
let dismissed: boolean | null = null;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; for (const l of [...listeners]) l(); };

/** App.tsx says what the notifications are now. */
export function publishNotifyOffer(next: NotifyOfferState): void {
  const same = state.supported === next.supported && state.permission === next.permission && state.on === next.on
    && state.vetoed === next.vetoed && state.desktop === next.desktop && state.turnOn === next.turnOn;
  state = next;
  if (!same) changed();
}

function isDismissed(): boolean {
  dismissed ??= readStored(NOTIFY_OFFER_KEY) === "1";
  return dismissed;
}

/** The offer goes for good. */
export function dismissNotifyOffer(): void {
  dismissed = true;
  writeStored(NOTIFY_OFFER_KEY, "1");
  changed();
}

/** Whether the offer is worth making: alerts can be had and are not on yet,
 *  the browser has not refused them, and nobody has answered the offer. */
export function offerWanted(s: NotifyOfferState, answered: boolean): boolean {
  if (answered || !s.supported || s.vetoed || s.desktop) return false;
  if (s.permission === "denied") return false;
  return !s.on || s.permission !== "granted";
}

/** The offer as the pane draws it: null when there is none to make. */
export function useNotifyOffer(): NotifyOfferState | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return offerWanted(state, isDismissed()) ? state : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const getVersion = () => version;

/** Tests: the state as at load. */
export function resetNotifyOffer(): void {
  state = OFF;
  dismissed = null;
  changed();
}
