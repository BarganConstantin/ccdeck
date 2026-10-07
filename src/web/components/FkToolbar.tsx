// The Fork look's toolbar: Fork's 52px band, keeping only what reads. On the
// left the sidebar toggle and the agent the view is about; in the middle the
// repository box (name, branch, ahead and behind); on the right the hand-offs
// (open in an app, copy), the switch back to the deck's look and the close.
// Fork's Fetch, Pull, Push, Stash, Branch and Quick Launch are not here: the
// view never writes to a repository.
import { useEffect, useRef, type CSSProperties, type ReactNode, type Ref } from "react";

import { fitBranch } from "../git-chip";
import { pressHow, type PressHow } from "../agent-goto";

// ── glyphs: drawn here, on an 18px grid at a 1.4 stroke ─────────────────
const G = {
  sidebar: <><rect x="2.2" y="3.4" width="13.6" height="11.2" rx="2.4" /><path d="M7 3.4v11.2M3.9 6.2h1.5M3.9 8.4h1.5" /></>,
  look: <><rect x="2.2" y="3.4" width="13.6" height="11.2" rx="2.4" /><path d="M9 3.4v11.2" /></>,
  close: <path d="M5 5l8 8M13 5l-8 8" />,
  back: <path d="M10.6 4.4 6 9l4.6 4.6" />,
} as const;
export type FkGlyphName = keyof typeof G;
export function FkGlyph({ name, size = 18 }: { name: FkGlyphName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{G[name]}</svg>
  );
}

/** The repository box's two small glyphs, on a 12px grid. */
const BRANCH = (
  <svg className="fk-repo-glyph" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"
    strokeLinecap="round" aria-hidden="true" focusable="false">
    <circle cx="3.4" cy="2.6" r="1.2" /><circle cx="3.4" cy="9.4" r="1.2" /><circle cx="8.6" cy="3.8" r="1.2" />
    <path d="M3.4 3.8v4.4M8.6 5c0 2.2-2 2.6-4.6 3.3" />
  </svg>
);
const COMMIT = (
  <svg className="fk-repo-glyph" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"
    strokeLinecap="round" aria-hidden="true" focusable="false">
    <circle cx="6" cy="6" r="2" /><path d="M1 6h3M8 6h3" />
  </svg>
);

/** A toolbar tool: an 18px glyph over an 11px word, Fork's column. */
export function FkTool({ icon, label, title, onClick, className = "", pressed, extra }: {
  icon: ReactNode; label: string; title: string; onClick: (how: PressHow) => void; className?: string; pressed?: boolean; extra?: ReactNode;
}) {
  return (
    <button type="button" className={`fk-tool ${className}`} title={title} aria-label={title} aria-pressed={pressed}
      onClick={e => onClick(pressHow(e))}>
      <span className="fk-tool-icon">{icon}{extra}</span>
      <span className="fk-tool-label">{label}</span>
    </button>
  );
}

/** A branch name cut in its middle to the box it has: the ticket first and
 *  never cut inside it (git-chip.ts), the whole name in the title. Each
 *  spelling is tried in the box itself, which is set in the system face the
 *  deck cannot measure from a stated size. React's own text node is
 *  rewritten, so React keeps owning it. */
function useMiddleFit(name: string, short: string | null) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    const text = el?.firstChild;
    if (!el || !text || text.nodeType !== 3) return;
    const fit = () => {
      text.nodeValue = name;
      const room = el.clientWidth;
      if (el.scrollWidth <= room + 1 || !name.length) return;
      if (short) { text.nodeValue = short; return; }
      const fitted = fitBranch(name, t => { text.nodeValue = t; return el.scrollWidth <= room + 1; });
      text.nodeValue = fitted;
    };
    const raf = requestAnimationFrame(fit);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    ro?.observe(el.parentElement ?? el);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [name, short]);
  return ref;
}

export interface FkRepoFacts {
  name: string;
  /** A linked worktree's main repository, said after its name. */
  mainName: string | null;
  /** The box's title: the folder, or the worktree and its main repository. */
  title: string;
  branch: string;
  detached: boolean;
  shortSha: string;
  unborn: boolean;
  /** Ahead and behind the upstream, and how that was measured. */
  ahead: number;
  behind: number;
  upstreamTitle: string | null;
  /** A read is on its way. */
  loading: boolean;
}

export interface FkAgentFacts {
  name: string;
  hue: number;
  narrow: boolean;
  counts: string | null;
  title: string;
  /** The way back from a narrowed view to the whole session. */
  widen: { label: string; onWiden: () => void } | null;
}

export default function FkToolbar({ headRef, sheet, onBack, sidebarShown, onToggleSidebar, agent, repo, handoffs, onLook, onClose }: {
  headRef?: Ref<HTMLElement>;
  sheet: boolean;
  onBack: (how: PressHow) => void;
  sidebarShown: boolean;
  onToggleSidebar: () => void;
  agent: FkAgentFacts;
  repo: FkRepoFacts;
  /** The hand-off tools, open in an app and copy. */
  handoffs: ReactNode;
  onLook: () => void;
  onClose: (how: PressHow) => void;
}) {
  const branchWords = repo.unborn ? "no commits yet" : repo.detached ? `detached at ${repo.shortSha}` : repo.branch;
  const branchRef = useMiddleFit(branchWords, null);
  const counts = [repo.ahead ? `${repo.ahead}↑` : "", repo.behind ? `${repo.behind}↓` : ""].filter(Boolean).join(" ");
  return (
    <header className="fk-toolbar" ref={headRef}>
      <div className="fk-tb-start">
        {sheet && <FkTool className="fk-tool-back" icon={<FkGlyph name="back" />} label="Canvas" title="Back to the canvas" onClick={onBack} />}
        <button type="button" className="fk-sidebar-toggle" aria-pressed={sidebarShown}
          title={sidebarShown ? "Hide the sidebar" : "Show the sidebar"} aria-label={sidebarShown ? "Hide the sidebar" : "Show the sidebar"}
          onClick={onToggleSidebar}>
          <FkGlyph name="sidebar" />
        </button>
        <div className={`fk-agent${agent.narrow ? " is-narrow" : ""}`} title={agent.title} style={{ "--session-hue": agent.hue } as CSSProperties}>
          <span className="fk-agent-line">
            <i className="fk-agent-swatch" aria-hidden="true" />
            <span className="fk-agent-name">{agent.narrow ? `↳ ${agent.name}` : agent.name}</span>
            {agent.widen && (
              <button type="button" className="fk-agent-x gv-scope-x" aria-label={agent.widen.label} title="Show the whole session" onClick={agent.widen.onWiden}>
                <FkGlyph name="close" size={12} />
              </button>
            )}
          </span>
          {agent.counts && <span className="fk-agent-counts">{agent.counts}</span>}
        </div>
      </div>
      <div className="fk-repo" title={repo.title}>
        <span className="fk-repo-line">
          <b className="fk-repo-name">{repo.name}</b>
          {repo.mainName && <span className="fk-repo-of">of {repo.mainName}</span>}
          {repo.loading && <span className="fk-spin" role="status" aria-label="Reading the repository" />}
        </span>
        <span className="fk-repo-branch" title={repo.detached ? `HEAD is detached at ${repo.shortSha}` : branchWords}>
          {repo.detached ? COMMIT : BRANCH}
          <span className="fk-repo-branch-name" ref={branchRef}>{branchWords}</span>
        </span>
        {counts && <span className="fk-repo-counts" title={repo.upstreamTitle ?? undefined}>{counts}</span>}
      </div>
      <div className="fk-tb-end">
        {handoffs}
        <span className="fk-tool-sep" aria-hidden="true" />
        <FkTool icon={<FkGlyph name="look" />} label="Deck look" title="Deck look (f)" onClick={() => onLook()} />
        {!sheet && (
          <>
            <span className="fk-tool-sep" aria-hidden="true" />
            <button type="button" className="fk-close" title="Close the git view (Esc)" aria-label="Close the git view" onClick={e => onClose(pressHow(e))}>
              <FkGlyph name="close" size={16} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
