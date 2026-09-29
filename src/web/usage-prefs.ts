// What the usage panel remembers between reloads: the period it was reading,
// and whether its session list was open.
//
// Lifted out of components/UsagePanel.tsx unchanged. The panel reads both in a
// useState initialiser and writes them from an effect; the keys, what an
// unreadable or unknown stored value falls back to, and the spelling written
// back are all here, where a test can call them.
import { readStored, writeStored } from "./storage";
import { PERIODS, type PeriodKey } from "./usage-from-ccusage";

/** Where the chosen period lives between reloads.
 *
 *  It was the one preference in this panel that did not survive one. The deck
 *  remembers whether the panel is open and which theme it is in, and a reader
 *  who works in `month` re-selected it on every reload — which is also the
 *  slowest of the three to answer, so the cost of forgetting was paid twice.
 *
 *  Read through storage.ts rather than off `window.localStorage`: this runs
 *  inside a useState initialiser and the property access itself throws on a
 *  browser that blocks site data, which would take the panel's first render
 *  with it. And validated against PERIODS rather than cast, because the stored
 *  string is whatever was in the store — an older build's key, or a hand edit —
 *  and an unknown period would ask /api/ccusage for a range it cannot spell.
 */
const PERIOD_KEY = "agent-dag.usagePeriod";

export function loadPeriod(): PeriodKey {
  const stored = readStored(PERIOD_KEY);
  return PERIODS.some(p => p.key === stored) ? (stored as PeriodKey) : "today";
}

export function savePeriod(period: PeriodKey): void {
  writeStored(PERIOD_KEY, period);
}

/** Whether the session list is open, and it is shut until asked for.
 *
 *  It is the one unbounded block in this panel — every other section is a
 *  fixed two or three rows, or a model table that cannot exceed the models
 *  that exist — and it is the reason the panel scrolls at all. Shut, the whole
 *  panel is one screen: quota, period, money, models. The reader who wants the
 *  per-session breakdown asks for it and gets it, and their answer is
 *  remembered, so this costs them one press once rather than one press a day.
 *
 *  Defaults SHUT rather than open, which is the deliberate half of this. The
 *  section is the panel's deepest detail and its least glanceable; the figure
 *  most readers open this panel for is the one at the top.
 */
const SESSIONS_OPEN_KEY = "agent-dag.usageSessionsOpen";

export function loadSessionsOpen(): boolean {
  return readStored(SESSIONS_OPEN_KEY) === "1";
}

export function saveSessionsOpen(open: boolean): void {
  writeStored(SESSIONS_OPEN_KEY, open ? "1" : "0");
}
