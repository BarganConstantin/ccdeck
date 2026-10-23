// What an integration panel keeps from one opening of its modal to the next
// (#2178, #2179): the item open beside the list, or that the reader closed it,
// the search, how far the list and the item were scrolled, Jira's sub-task
// rows and the breadcrumb, a merge request's section. Closing the modal
// unmounts the panel; this is how it comes back the way it was left.
//
// FOR THE PAGE'S LIFE, NOT THE BROWSER'S. Module memory, like the reads the
// panels keep (use-jira-board.ts, forge-panel.ts), so a reload or a restart
// starts fresh. The view's choices — the board or project, the tab, the
// filters, the open groups, the detail's width — are prefs.ts's and
// layout.ts's, and survive both.
//
// ONE MEMORY PER LIST. A Jira board, and each forge project and tab, keeps
// its own item and scroll, so going back to a tab finds what was open there.
// The search is the panel's (one per connection), as it is on screen.
//
// WHAT A LIST SHOWS WHEN THE READER ARRIVES — the modal opened, another tab,
// project or board chosen — is `arrive`'s: the remembered item when it is
// still in the list as drawn; nothing when the reader closed the detail
// there.

/** What one list remembers. `S` is the panel's selection: a Jira trail, a
 *  forge item. */
export interface ListMemory<S> {
  /** What the detail shows; null for nothing. */
  selection: S | null;
  /** The reader closed the detail (×, Escape, Back): it stays closed here
   *  until a row is pressed. */
  closed: boolean;
  /** How far the list and the detail were scrolled, in CSS pixels. */
  listTop: number;
  detailTop: number;
  /** Jira: the rows whose sub-tasks are shown, by key. */
  rows: Record<string, boolean>;
  /** A merge request's section (Overview, Commits…), for `selection`. */
  section: string | null;
}

/** A bound on the lists kept, the oldest dropped first: far more than a
 *  reader visits in a day. */
const MAX_LISTS = 120;

const lists = new Map<string, ListMemory<unknown>>();
const searches = new Map<string, string>();

const blank = (): ListMemory<never> => ({ selection: null, closed: false, listTop: 0, detailTop: 0, rows: {}, section: null });

/** One list's key: the connection's scope (`jira:<id>`, `gitlab:<id>`) and
 *  what the list is of — a board, or a project (null for All projects) and
 *  a tab. */
export function listKey(scope: string, ...parts: (string | null)[]): string {
  return [scope, ...parts.map(part => part ?? "*")].join("|");
}

/** What a list remembers, or null when the reader has never been there. */
export function recallList<S>(key: string): ListMemory<S> | null {
  return (lists.get(key) as ListMemory<S> | undefined) ?? null;
}

/** Adds to what a list remembers. */
export function keepList<S>(key: string, patch: Partial<ListMemory<S>>): void {
  const next = { ...(lists.get(key) ?? blank()), ...patch } as ListMemory<unknown>;
  lists.delete(key);
  lists.set(key, next);
  while (lists.size > MAX_LISTS) lists.delete(lists.keys().next().value as string);
}

/** The panel's search, per connection: "" for none. */
export function recallSearch(scope: string): string {
  return searches.get(scope) ?? "";
}

export function keepSearch(scope: string, text: string): void {
  if (text) searches.set(scope, text);
  else searches.delete(scope);
}

/** Forget everything: a test's fresh page. */
export function forgetViews(): void {
  lists.clear();
  searches.clear();
}

// ── arriving at a list ─────────────────────────────────────────────────────

/** The rows a list has drawn, as far as arriving at it needs them. */
export interface Drawn<S> {
  /** Every row that could hold the remembered item is drawn: nothing the
   *  list shows is still being read. A failed read is complete, and empty. */
  complete: boolean;
  /** Whether this item has a row on screen. */
  has: (selection: S) => boolean;
}

/** What to do on arriving at a list, and where its two scrolls go. */
export type Arrival<S> =
  /** Not yet: the rows that could hold the remembered item are on their way. */
  | { kind: "wait" }
  /** Nothing to open: the reader closed the detail here, or the item
   *  remembered is gone (merged, out of the sprint, filtered out). */
  | { kind: "none"; listTop: number }
  /** The remembered item, still in the list. */
  | { kind: "restore"; selection: S; listTop: number; detailTop: number };

/**
 * What a list shows on arrival, once its rows are drawn. A remembered item
 * still drawn comes back, with both scrolls; one that is gone leaves the
 * list at its top with nothing open. A detail the reader closed stays closed,
 * the list where it was.
 */
export function arrive<S>(memory: ListMemory<S> | null, drawn: Drawn<S>): Arrival<S> {
  if (memory?.selection == null) return { kind: "none", listTop: memory?.listTop ?? 0 };
  if (drawn.has(memory.selection)) return { kind: "restore", selection: memory.selection, listTop: memory.listTop, detailTop: memory.detailTop };
  return drawn.complete ? { kind: "none", listTop: 0 } : { kind: "wait" };
}

// ── a list's view, from arrival on ─────────────────────────────────────────

/** Where the two scrolls go; null leaves one as it is. */
export interface ScrollPlan { list: number | null; detail: number | null }

/** One list's view as the panel draws it (integrations/use-list-view.ts). */
export interface ViewState<S> {
  key: string;
  selection: S | null;
  /** The panel put `selection` there, not the reader. */
  auto: boolean;
  /** Arrival is decided: something was put back, or nothing is to be. Until
   *  then `settle` is asked again as rows are drawn; after it, what the list
   *  draws changes nothing (a filter that hides the item leaves it open). */
  settled: boolean;
  /** The scrolls to put back once this state is drawn. */
  plan: ScrollPlan | null;
}

/**
 * Arriving at a list: as the panel mounts, or on another board, project or
 * tab. With nothing open here, by the reader's choice or because nothing
 * was, there are no rows to wait for, and the list goes back to where it
 * was. A remembered item waits for them; a scroller another list left
 * behind starts at the top meanwhile.
 */
export function enter<S>(key: string, mounting: boolean): ViewState<S> {
  const memory = recallList<S>(key);
  if (memory?.selection == null) {
    return { key, selection: null, auto: false, settled: true, plan: memory || !mounting ? { list: memory?.listTop ?? 0, detail: null } : null };
  }
  return { key, selection: null, auto: false, settled: false, plan: mounting ? null : { list: 0, detail: null } };
}

/** The list has drawn rows: decide, if it is still to be. The same state
 *  back means nothing changed. */
export function settle<S>(state: ViewState<S>, drawn: Drawn<S> | null): ViewState<S> {
  if (state.settled || !drawn) return state;
  const next = arrive(recallList<S>(state.key), drawn);
  if (next.kind === "wait") return state;
  if (next.kind === "none") return { key: state.key, selection: null, auto: false, settled: true, plan: { list: next.listTop, detail: null } };
  return { key: state.key, selection: next.selection, auto: true, settled: true, plan: { list: next.listTop, detail: next.detailTop } };
}

/** The reader's own choice: a row, a link, or null for the detail closed,
 *  which the list remembers. Another item starts its page afresh: no
 *  section, at the top until it is scrolled. */
export function choose<S>(state: ViewState<S>, next: S | null, same: (a: S, b: S) => boolean): ViewState<S> {
  const changed = next == null || state.selection == null || !same(state.selection, next);
  keepList<S>(state.key, { selection: next, closed: next == null, ...(changed ? { section: null, detailTop: 0 } : {}) });
  return { key: state.key, selection: next, auto: false, settled: true, plan: null };
}
