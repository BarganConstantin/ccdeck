// The ccdeck account as the feedback doors need it: whether a send can go as
// the account, the address it would go as, how many conversations hold a
// reply nobody has read — the Feedback button's dot and the dialog's tabs —
// and whether replies are also mailed, which the dialog's words follow.
//
// IN THE MAIN BUNDLE, AND NOTHING OF THE ACCOUNT IN IT. The topbar and the
// dialog are drawn on every deck, and this is all they read, so it imports
// nothing: on a deck with the account off it stays null forever and nothing
// changes on screen. What fills it is the account's own chunk —
// components/AccountBridge.tsx, mounted only while the account is on — which
// publishes the account's view here whenever it changes, and null when it
// goes. account-flag-off.test.ts holds the imports to that.
import { useSyncExternalStore } from "react";

export interface FeedbackAccount {
  /** A send can go as the account: the deck is connected and has its token. */
  connected: boolean;
  /** The address it goes as, once the deck has said. */
  email: string | null;
  /** Conversations with a team item the person has not seen. */
  unread: number;
  /** When the latest team item was written: a change is a new reply. */
  latestAt: string | null;
  /** Whether the team's replies are also mailed: false while the API sends no
   *  mail, and then nothing on screen says "by email". Left out, they are. */
  mail?: boolean;
}

let current: FeedbackAccount | null = null;
const listeners = new Set<() => void>();

const same = (a: FeedbackAccount | null, b: FeedbackAccount | null) =>
  a === b || (a !== null && b !== null && a.connected === b.connected && a.email === b.email
    && a.unread === b.unread && a.latestAt === b.latestAt && a.mail === b.mail);

/** The account's side: what the doors should show now, or null for none. A
 *  publish that changes nothing wakes nobody. */
export function publishFeedbackAccount(next: FeedbackAccount | null): void {
  const value = next === null ? null : {
    connected: next.connected === true,
    email: typeof next.email === "string" && next.email !== "" ? next.email : null,
    unread: Number.isInteger(next.unread) && next.unread > 0 ? next.unread : 0,
    latestAt: typeof next.latestAt === "string" ? next.latestAt : null,
    mail: next.mail !== false,
  };
  if (same(current, value)) return;
  current = value;
  for (const listener of listeners) listener();
}

/** What was last published, outside React: the crash pane reads it before
 *  the tree that published it unmounts. */
export function readFeedbackAccount(): FeedbackAccount | null {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The account as the doors draw it, or null while there is none. */
export function useFeedbackAccount(): FeedbackAccount | null {
  return useSyncExternalStore(subscribe, readFeedbackAccount, readFeedbackAccount);
}

/** Whether replies to a send as the account are also mailed. */
export function mailsReplies(account: FeedbackAccount | null): boolean {
  return account?.mail !== false;
}

/** How many unread conversations the dot stands for: none unless connected. */
export function unreadOf(account: FeedbackAccount | null): number {
  return account?.connected ? account.unread : 0;
}
