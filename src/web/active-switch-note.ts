/** Keep a panel switch confirmation only while its account remains active.
 * An unavailable roster cannot establish that the account has changed. */
export function activeSwitchNote<T extends { num: number }>(
  note: T | null,
  accounts: readonly { num: number; active: boolean }[] | undefined,
): T | null {
  if (!note || !accounts) return note;
  return accounts.some(account => account.num === note.num && account.active) ? note : null;
}
