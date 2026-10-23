// What every part of a GitHub or GitLab panel shares (#2179): which forge and
// connection it is reading, how to ask it, the panel's Refresh counter, what
// is selected, which groups the user unfolded, where the toolbar's "updated"
// line comes from, and what the list on show remembers (view-memory.ts): the
// rows each tab draws, and a merge request's section. One context rather than
// the same eight props passed down every tab and every detail.
import { createContext, useContext, useRef, type ReactNode } from "react";
import type { ForgeKind } from "../../forge-types";
import type { ForgeApi } from "../../forge-panel";
import { useBeforePaint } from "../../integrations/use-list-view";

export type ForgeSelection =
  | { type: "change"; repo: string; number: number }
  | { type: "branch"; repo: string; name: string }
  | { type: "pipeline"; repo: string; id: string }
  | { type: "issue"; repo: string; number: number };

export interface ForgeConnectionInfo {
  id: string;
  name: string;
  baseUrl: string;
  account?: { login: string; name: string | null; avatarUrl: string | null } | null;
}

export interface Freshness {
  loadedAt: number | null;
  loading: boolean;
  stale: boolean;
}

export interface ForgeContextValue {
  kind: ForgeKind;
  connection: ForgeConnectionInfo;
  /** `kind:connId` — keys every kept answer to this connection. */
  scope: string;
  api: ForgeApi;
  /** The deck's proxied address for an image at this absolute URL, or null
   *  when it should be drawn as a link. */
  asset: (absoluteUrl: string) => string | null;
  /** Bumped by the toolbar's Refresh: every read on screen asks again. */
  refresh: number;
  selected: ForgeSelection | null;
  select: (selection: ForgeSelection | null) => void;
  isOpen: (group: string) => boolean;
  toggle: (group: string) => void;
  /** The list on screen says how fresh it is; the toolbar draws it. */
  reportFreshness: (f: Freshness) => void;
  onReconnect: () => void;
  narrow: boolean;
  /** The list on show, this project and tab (view-memory.ts `listKey`). */
  listKey: string;
  /** Each tab says which rows it draws (useReportRows), so the panel can put
   *  the remembered item back when it is still there. */
  reportRows: (rows: ForgeRows) => void;
  /** The section a merge request's page opens on: the one it was left on
   *  when it is the page put back, else none. Read as the page mounts. */
  recallSection: () => string | null;
  /** The reader chose a section of the page on show. */
  keepSection: (section: string) => void;
}

/** What a tab has drawn: its rows' items, in order, folded groups left out. */
export interface ForgeRows {
  /** The list they belong to (`listKey` when they were drawn). */
  key: string;
  /** Nothing the tab shows is still being read; a failed read is complete. */
  complete: boolean;
  items: ForgeSelection[];
}

const Ctx = createContext<ForgeContextValue | null>(null);

export function ForgeProvider({ value, children }: { value: ForgeContextValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useForge(): ForgeContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useForge outside a forge panel");
  return v;
}

/** Tells the panel which rows a tab draws, once they are on screen and
 *  before the browser paints them, so an item put back arrives with them. */
export function useReportRows(items: ForgeSelection[], complete: boolean): void {
  const { listKey, reportRows } = useForge();
  const latest = useRef(items);
  latest.current = items;
  const drawn = items.map(selectionKey).join("\n");
  useBeforePaint(() => {
    reportRows({ key: listKey, complete, items: latest.current });
  }, [reportRows, listKey, complete, drawn]);
}

/** Whether a selection is this one — for a row's selected fill. */
/** One string per item, the same for the same item: "change:acme/web:12". */
export function selectionKey(s: ForgeSelection): string {
  switch (s.type) {
    case "change":
    case "issue":
      return `${s.type}:${s.repo}:${s.number}`;
    case "branch":
      return `branch:${s.repo}:${s.name}`;
    case "pipeline":
      return `pipeline:${s.repo}:${s.id}`;
  }
}

export function sameSelection(a: ForgeSelection | null, b: ForgeSelection): boolean {
  if (!a || a.type !== b.type || a.repo !== b.repo) return false;
  switch (b.type) {
    case "change":
    case "issue":
      return (a as { number: number }).number === b.number;
    case "branch":
      return (a as { name: string }).name === b.name;
    case "pipeline":
      return (a as { id: string }).id === b.id;
  }
}
