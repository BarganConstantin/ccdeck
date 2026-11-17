// What the accounts panel remembers between reloads about the accounts behind
// its fold (#1579): which of them are open.
//
// It used to live in the panel's state and so lasted exactly as long as the
// panel did: close it, or reload, and every row was shut. The ORDER is no
// longer a choice to remember — the list stands in availability order
// (internal #94, other-accounts-order.ts) — so the order once stored under
// `agent-dag.otherAccountsOrder` is simply not read any more. The fold ITSELF still shuts every time the panel opens — see
// `restOpen` in AccountsPanel.tsx for why a fold that remembered being open
// would never fold again — so what is kept is how the rows behind it look,
// not whether they are shown.
//
// Per browser, in localStorage, like the usage panel's period and the other
// view choices this deck keeps: which rows are open on this screen is a
// preference about this screen.
//
// Read through storage.ts, for the reason usage-prefs.ts gives: these run in
// a useState initialiser, and the property access itself throws on a browser
// that blocks site data. And validated rather than cast — the stored string is
// whatever was in the store.
import { readStored, writeStored } from "./storage";
import { NONE_OPEN, type Openness } from "./other-accounts-order";

const OPEN_KEY = "agent-dag.otherAccountsOpen";

/** Which rows are open, or none: anything that does not parse as an
 *  Openness is a store written by something else. `scope` keeps a second
 *  column's rows (Codex's) apart from this one's. */
export function loadOpenness(scope = ""): Openness {
  const raw = readStored(OPEN_KEY + scope);
  if (!raw) return NONE_OPEN;
  try {
    const v = JSON.parse(raw);
    if ((v?.mode === "some" || v?.mode === "all") && Array.isArray(v.keys) && v.keys.every((k: unknown) => typeof k === "string")) {
      return { mode: v.mode, keys: v.keys.slice(0, 200) };
    }
  } catch { /* not JSON: fall through */ }
  return NONE_OPEN;
}

/** Written without the `slot:` keys: an account with no address is named by
 *  where it stands, and whoever stands there next time the deck opens is not
 *  who was opened — #542, across a reload. Those rows are remembered for as
 *  long as the page is open, as they always were. */
export function saveOpenness(state: Openness, scope = ""): void {
  writeStored(OPEN_KEY + scope, JSON.stringify({ mode: state.mode, keys: state.keys.filter(k => !k.startsWith("slot:")) }));
}
