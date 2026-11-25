// Groups of the Sessions list shut by a press on their header, so a person can
// keep a long Done out of the way and look at a few Pinned sessions.
//
// THE HEADER IS THE CONTROL. Every group but Pinned draws its header as one
// button, the chevron first: open it points down, shut it points right, and the
// label and the count stay where they were either way. Shut, the group draws
// none of its rows. Opened again, it draws what it drew before: the rows its
// share of the budget allows, then "N more" (rail-model.ts foldPlan). Shutting
// a group lets its "N more" go, so it always opens at its budget.
//
// A GROUP FOLDED AWAY WHOLE by the budget (every row behind "N more", with no
// room left above it) already had its header as the button that opens it. It
// still does: it reads as shut, and a press opens all of it, as it always has.
//
// PINNED NEVER SHUTS. A pin is a person asking for that row on top; it has no
// fold of its own either (rail-model.ts).
//
// A SESSION THAT NEEDS YOU IS NEVER KEPT BEHIND A SHUT HEADER. One that starts
// waiting on you (a permission, a question) inside a shut group opens that
// group again (reopenedBy, below). In practice that group is Needs you, where
// rank() sorts every such session; while the pointer or the keyboard holds
// the list's order, the row can still be drawn in the group it was in, and
// that group opens instead. Sessions that already waited when the group was
// shut, or when the page loaded, do not open it: the group says how many it
// holds, and the top bar counts them too.
//
// STORED per browser under one agent-dag.* key, as the groups' names (not
// their numbers, which say where a group is drawn and could move): a view
// choice like the usage panel's period (usage-prefs.ts). Nothing stored, a
// blocked store or anything unreadable is every group open, as before.
import { readStored, writeStored } from "./storage";
import { RAIL_PINNED, type RailGroup, type RailSection, type Slot } from "./rail-model";

export const LIST_COLLAPSED_KEY = "agent-dag.listCollapsed";

/** The groups' names in storage. Done · new is drawn under Done's header and
 *  shuts with it, so its own name is never written. */
const NAMES: Readonly<Record<RailGroup, string>> = { 0: "needs", 1: "new", 2: "working", 3: "done", 4: "ready" };
const BY_NAME = new Map(Object.entries(NAMES).map(([g, name]) => [name, Number(g) as RailGroup]));

/** Whether a person can shut this place of the list: every group but Pinned. */
export function canShut(section: RailSection): section is RailGroup {
  return section !== RAIL_PINNED;
}

/** The groups left shut, or none. */
export function loadCollapsed(): ReadonlySet<RailGroup> {
  const raw = readStored(LIST_COLLAPSED_KEY);
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(value.flatMap(name => (typeof name === "string" && BY_NAME.has(name) ? [BY_NAME.get(name)!] : [])));
  } catch { return new Set(); }
}

export function saveCollapsed(groups: ReadonlySet<RailGroup>): void {
  writeStored(LIST_COLLAPSED_KEY, JSON.stringify([...groups].sort().map(g => NAMES[g])));
}

/** `groups` with `group` shut or open: the SAME set when nothing changes. */
export function withShut(groups: ReadonlySet<RailGroup>, group: RailGroup, shut: boolean): ReadonlySet<RailGroup> {
  if (groups.has(group) === shut) return groups;
  const next = new Set(groups);
  if (shut) next.add(group); else next.delete(group);
  return next;
}

/** A group as its header sees it: shut by a person, how many rows its budget
 *  draws (`shown`), how many wait behind its "N more" (`rest`), and whether
 *  that fold is open. */
export interface GroupFold { shut: boolean; shown: number; rest: number; open: boolean }

/** Whether a group draws any of its rows: what the header's aria-expanded
 *  says. Not when a person shut it, nor when the budget folded it away whole
 *  and its fold is not open. */
export function groupExpanded(f: GroupFold): boolean {
  return !f.shut && (f.shown > 0 || (f.rest > 0 && f.open));
}

/** What a press on the header leaves: an open group shut, its fold let go;
 *  a shut one open, at its budget, or whole when its budget draws nothing
 *  (the press that opened a group folded away whole always did). */
export function pressHeader(f: GroupFold): { shut: boolean; open: boolean } {
  if (groupExpanded(f)) return { shut: true, open: false };
  return { shut: false, open: f.shown === 0 && f.rest > 0 };
}

/** The shut groups a session that needs you has newly come into, to open
 *  again. `waiting` are the drawn rows that need you now, each in the group it
 *  is drawn in; `before` the ids that needed you at the last look, or null on
 *  the first, which only takes note. */
export function reopenedBy(shut: ReadonlySet<RailGroup>, waiting: readonly Slot[], before: ReadonlySet<string> | null): RailGroup[] {
  if (!before) return [];
  const out: RailGroup[] = [];
  for (const s of waiting) {
    if (!canShut(s.group) || !shut.has(s.group) || before.has(s.id) || out.includes(s.group)) continue;
    out.push(s.group);
  }
  return out;
}
