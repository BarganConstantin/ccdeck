// What the accounts panel remembers between reloads about the accounts behind
// its fold (#1579): the order they are listed in, and which of them are open.
//
// Both used to live in the panel's state and so lasted exactly as long as the
// panel did: close it, or reload, and the list was back in slot order with
// every row shut. The fold ITSELF still shuts every time the panel opens — see
// `restOpen` in AccountsPanel.tsx for why a fold that remembered being open
// would never fold again — so what is kept is how the rows behind it look,
// not whether they are shown.
//
// Per browser, in localStorage, like the usage panel's period and the other
// view choices this deck keeps: how a list is ordered on this screen is a
// preference about this screen.
//
// Read through storage.ts, for the reason usage-prefs.ts gives: these run in
// a useState initialiser, and the property access itself throws on a browser
// that blocks site data. And validated rather than cast — the stored string is
// whatever was in the store.
import { readStored, writeStored } from "./storage";
import { NONE_OPEN, SLOT_ORDER, type Openness } from "./other-accounts-order";

const ORDER_KEY = "agent-dag.otherAccountsOrder";
const OPEN_KEY = "agent-dag.otherAccountsOpen";

/** The stored order, or slot order. Checked against the choices the roster
 *  offers once the roster is here — see validOrder. */
export function loadOrder(): string {
  const stored = readStored(ORDER_KEY);
  return typeof stored === "string" && stored.length > 0 && stored.length <= 64 ? stored : SLOT_ORDER;
}

export function saveOrder(order: string): void {
  writeStored(ORDER_KEY, order);
}

/** Which rows are open, or none: anything that does not parse as an
 *  Openness is a store written by something else. */
export function loadOpenness(): Openness {
  const raw = readStored(OPEN_KEY);
  if (!raw) return NONE_OPEN;
  try {
    const v = JSON.parse(raw);
    if ((v?.mode === "some" || v?.mode === "all") && Array.isArray(v.keys) && v.keys.every((k: unknown) => typeof k === "string")) {
      return { mode: v.mode, keys: v.keys.slice(0, 200) };
    }
  } catch { /* not JSON: fall through */ }
  return NONE_OPEN;
}

export function saveOpenness(state: Openness): void {
  writeStored(OPEN_KEY, JSON.stringify(state));
}
