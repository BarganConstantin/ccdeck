// What every part of a GitHub or GitLab panel shares (#2179): which forge and
// connection it is reading, how to ask it, the panel's Refresh counter, what
// is selected, which groups the user unfolded, and where the toolbar's
// "updated" line comes from. One context rather than the same eight props
// passed down every tab and every detail.
import { createContext, useContext, type ReactNode } from "react";
import type { ForgeKind } from "../../forge-types";
import type { ForgeApi } from "../../forge-panel";

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

/** Whether a selection is this one — for a row's selected fill. */
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
