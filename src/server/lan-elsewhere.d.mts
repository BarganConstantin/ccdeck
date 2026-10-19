// The page's view of lan-elsewhere.mjs: the rule the accounts' rows read, the
// same one the notifier and the auto-switch tick read on the server.

/** The parts of a status row the rule reads — the engine's and the page's
 *  status rows are both this and more. */
export interface ElsewherePeer {
  fp: string;
  peerFp?: string | null;
  name?: string;
  addr?: string;
  paired?: boolean;
  offers?: { at: number; current?: { key?: string } | { hidden: true } | { other: true } | null } | null;
}

export interface ElsewhereStatus<P extends ElsewherePeer = ElsewherePeer> {
  enabled?: boolean;
  peers?: P[];
  addrs?: string[];
  aliases?: Record<string, string>;
}

export const ELSEWHERE_FRESH_MS: number;
export function decksByAccount<P extends ElsewherePeer>(
  status: ElsewhereStatus<P> | null | undefined, now: number, freshMs?: number,
): Map<string, P[]>;
export function deckName(p: ElsewherePeer, aliases?: Record<string, string>): string;
export function namesByAccount(status: ElsewhereStatus | null | undefined, now: number, freshMs?: number): Map<string, string[]>;
export function deckList(names: readonly string[]): string;
export function connectLanStatus(status: (() => unknown) | null): void;
export function elsewhereNow(now?: number): Map<string, string[]>;
