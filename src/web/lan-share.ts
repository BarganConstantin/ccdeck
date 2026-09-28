// What this deck offers, as the setup dialog's share boxes keep it while a
// write is out.
//
// Lifted out of LanSyncSection.tsx unchanged. The section itself calls none of
// it — LanSetupModal does, and the section was only where it had been written.
// A tick sends the whole list, and the server's copy only catches up once the
// write has landed and the next poll has returned, so the boxes draw from what
// was last sent until then: nextShared builds the next list from that, and
// settlePending decides when the server's own list is the truth again. None of
// it touches React.

/** Two lists of account keys, same members or not. Order is not meaning here:
 *  the server stores what it is sent, and the panel sends a Set. */
export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every(k => seen.has(k));
}

/**
 * The list one tick in "Share these accounts" sends.
 *
 * Built from what the dialog last SENT while that is still unconfirmed, and
 * from the server's list otherwise. `status.shared` only moves once a write has
 * landed AND the poll after it has returned, so a second tick inside that window
 * built from the server's list would silently drop the first one's account.
 */
export function nextShared(
  pending: readonly string[] | null, server: readonly string[], key: string, checked: boolean,
): string[] {
  const next = new Set(pending ?? server);
  if (checked) next.add(key); else next.delete(key);
  return [...next];
}

/**
 * What the share boxes draw from after news arrives: the list last sent, or —
 * as null — the server's own.
 *
 * `lastWrite` is the answer to the newest share write, or null when the news
 * is only a fresh read of the server's list. Three outcomes:
 *
 *   * REFUSED, or never answered: the deck stored nothing, so the server's list
 *     is the truth again and the boxes go back to it (#1175). Keeping what was
 *     sent drew an unticked login as not offered while the deck went on
 *     offering it — and the next tick re-sent the refused state with it.
 *   * The server's list MATCHES what was sent: it has caught up, and the
 *     optimistic copy is retired.
 *   * Accepted but not matching yet: kept. The server stores the list it is
 *     sent as it is, so a list that still differs after an accepted write is a
 *     read that left before the write landed — and going back to it would let
 *     the next tick build from it, which is the race `nextShared` exists for.
 *
 * Hands back the very list it was given when it keeps it, so a caller can tell
 * by identity whether a newer tick has replaced it since.
 */
export function settlePending<T extends readonly string[]>(
  pending: T | null, server: readonly string[], lastWrite: { ok: boolean } | null,
): T | null {
  if (pending == null) return null;
  if (lastWrite != null && !lastWrite.ok) return null;
  if (sameKeys(pending, server)) return null;
  return pending;
}
