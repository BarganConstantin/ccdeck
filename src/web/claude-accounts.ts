// What the deck's two account routes answer, as the accounts panel reads them:
// the roster from /api/claude-accounts and the auto-switch policy from
// /api/cswap-auto.
//
// Moved out of AccountsPanel.tsx unchanged, because the panel is no longer the
// only file that draws them — its rows are their own component — and a type the
// row and the panel both read belongs to neither of them.
import { type Repair } from "./account-issue";

export interface Lane {
  id: string;
  label: string;
  pct: number;
  resetAt: number | null;   // unix seconds
}

export interface Account {
  num: number;
  email: string | null;
  alias: string | null;
  org: string | null;
  active: boolean;
  disabled: boolean;
  lanes: Lane[];
  headroom: number | null;
  fetchedAt: number | null;  // unix ms
  nextAt: number | null;     // unix ms — claude-swap's next planned read
  stale: boolean;
  error: string | null;
  staleCopy?: boolean;
  /** How the deck's own re-capture of a `staleCopy` row is going. */
  repair?: Repair | null;
  stopped?: boolean;
  collector?: string | null;
  /** The other half of an account's identity. A slot number is not one:
   *  claude-swap assigns them max+1 per store, so the account that is 4 here
   *  is 2 on another machine. LAN sync matches on this pair. */
  orgUuid?: string | null;
  /** Whether claude-swap's STORED COPY works on this machine — which is not
   *  the same question as whether the user is signed in (#721). The copy is
   *  what a share carries and what a peer's copy heals, so both kinds of
   *  trouble read as not alive. */
  alive?: boolean;
  /** "ccdeck_signin" when the deck's own `+ → Sign in` added this account;
   *  null for a share, Local network, or an account the deck found (#1893). */
  origin?: "ccdeck_signin" | null;
  /** The incident a deck-signed-in account is in once claude-swap has refused
   *  its login since that sign-in, or null. `key` and `since` name it; see
   *  account-origins.mjs. */
  reauth?: Reauth | null;
}

/** One re-sign-in incident, as the roster names it (#1893). */
export interface Reauth {
  /** The account's identity, `email@@orgUuid` — the key LAN sync uses. */
  key: string;
  /** When the login was last known to work: the later of its last good read
   *  and its last sign-in here. Together with `key`, the incident's name. */
  since: number;
  /** Somebody answered this very incident with "Not now". */
  dismissed: boolean;
}

export interface AccountsData {
  ok: boolean;
  accounts?: Account[];
  activeNum?: number | null;
  reason?: string;
  hint?: string;
  /** `cswap_refused` only: the version that answered, and what was asked for. */
  version?: string;
  want?: string | null;
  fetchedAt?: number;
}

export interface AutoTick {
  at: number;
  event: string;
  reason?: string | null;
  detail?: string | null;
  to?: number | null;
}

export interface AutoStatus {
  ok: boolean;
  enabled: boolean;
  external: boolean;          // the user runs their own `cswap auto` loop
  lastTick: AutoTick | null;
  settings: Record<string, { value: string | null; isDefault: boolean }>;
}
