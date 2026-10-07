// A stand-in for the Fork look's sidebar, with the props the real part takes,
// so the layout around it can be drawn and used before it arrives. It is
// replaced by its own module as it lands, and adds nothing the deck look lacks.
import type { Repo } from "../git-view-types";

export interface FkSidebarProps {
  sessionId: string;
  agent: string | null;
  repo: Repo | null;
  /** The repository's stale counter: a move reads the refs again. */
  stale: number;
  view: "all" | "local";
  onView: (v: "all" | "local") => void;
  /** How many files Local Changes lists. */
  localCount: number;
  selectedSha: string | null;
  /** A ref's tip commit: the view selects it when the history lists it. */
  onJump: (sha: string) => void;
  /** Whether focus is in the sidebar. */
  focused: boolean;
}

/** The sidebar's two views, and nothing else yet. */
export function FkSidebar({ repo, view, onView, localCount }: FkSidebarProps) {
  const rows: { v: "all" | "local"; label: string }[] = [
    { v: "local", label: localCount > 0 ? `Local Changes (${localCount})` : "Local Changes" },
    { v: "all", label: "All Commits" },
  ];
  return (
    <div className="fk-ph-side">
      <div className="fk-ph-repo" title={repo?.topLevel}>{repo?.name ?? ""}</div>
      {rows.map(r => (
        <button key={r.v} type="button" className="fk-ph-nav" aria-current={view === r.v ? "true" : undefined} onClick={() => onView(r.v)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}
