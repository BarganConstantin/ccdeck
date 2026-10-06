// The Git section of the detail panel, right under its header: the first
// thing read when an agent waits on you is what it changed.
//
// Eight rows at most: the branch and where it stands against its upstream,
// the collision line when there is one, the session's last commits (two when
// a collision line is showing, three otherwise), how many files changed and
// how many of them this session edited, its first two files, a way into the
// rest, and the hand-off row. Every row opens the git view on what it names,
// with keyboard focus on it. A folder git cannot read says so in one line —
// and when `g` is pressed there, that line answers instead of a view opening.
import { useEffect, useRef, type CSSProperties, type MutableRefObject, type ReactNode } from "react";

import { goToAgentCard, pressHow } from "../agent-goto";
import { agentNameIn, collisionTarget, otherAgentName } from "../git-agent-name";
import { groupDigits } from "../git-diff-parse";
import { pathCounts } from "../git-files-model";
import { useGitOn } from "../git-pref";
import { openGitViewFrom } from "../git-view-request";
import { gitFactsFor, gitFocus, gitViewOpens, subagentKey } from "../git-view-target";
import { UNCOMMITTED, type GitFileRef } from "../git-view-types";
import {
  collisionsFor, commitMark, commitWho, shortAge, subjectParts, upstreamWords,
} from "../git-view-words";
import type { GraphState } from "../reducer";
import { sessionHue } from "../session-hue";
import type { AgentNodeData } from "../types";
import { changedFiles, madeByFocus, useGitData } from "../use-git-view";
import GitHandoffs from "./GitHandoffs";
import { CollisionLine, GvIcon, GvMark, ReadStateLine, useFittedName } from "./GitViewParts";

/** The status letter a file row shows, with its word for a screen reader. */
const STATUS_WORD: Record<string, string> = {
  M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict", T: "type changed", "?": "untracked",
};

/** A path split for drawing: the folder quieter than the file's own name. */
const splitPath = (p: string): [string, string] => {
  const at = p.lastIndexOf("/");
  return at < 0 ? ["", p] : [p.slice(0, at + 1), p.slice(at + 1)];
};

interface Props {
  agent: AgentNodeData;
  /** The session's root card, which carries its collisions. */
  root: AgentNodeData | null;
  now: number;
  stateRef: MutableRefObject<GraphState>;
}

export default function GitGlance({ agent, root, now, stateRef }: Props) {
  const gitOn = useGitOn();
  const facts = gitFactsFor(agent, root);
  const readable = gitViewOpens(facts);
  const focus = gitFocus(agent, false);
  const key = focus.agentIds ? subagentKey(agent) : null;
  const data = useGitData({ sessionId: agent.sessionId, agent: key, stale: facts?.stale ?? 0, enabled: gitOn && readable });
  const lineRef = useRef<HTMLParagraphElement>(null);
  const branchRowRef = useRef<HTMLDivElement>(null);

  // `g` on a folder git cannot read: this line answers instead of a view.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== agent.id) return;
      const el = lineRef.current;
      if (!el) return;
      el.classList.remove("gv-nudge");
      void el.offsetWidth;
      el.classList.add("gv-nudge");
    };
    window.addEventListener("gitview:unreadable", on);
    return () => window.removeEventListener("gitview:unreadable", on);
  }, [agent.id]);

  const repo = data.repo;
  const head = repo?.head;
  const detached = head ? head.detached : facts?.detached === true;
  const shortSha = head?.short ?? facts?.sha ?? "";
  const branch = head ? head.branch : facts?.branch ?? null;
  const branchName = detached ? `detached at ${shortSha}` : branch ?? "";
  const nameRef = useFittedName(branchName, branchRowRef, `${upstreamWords(data.repo)?.text}|${data.state}`);
  if (!gitOn) return null;

  // From a pointer the view slides in; from Enter or Space it opens at once.
  const open = (e: { detail: number }, hints: { sel?: string | null; file?: GitFileRef | null } = {}) =>
    openGitViewFrom(pressHow(e), { agentId: agent.id, focusInside: true, ...hints });
  const heading = (
    <h3 id={`gv-glance-${agent.id}`}>
      Git
      {readable && (data.state === "repo" || data.state === "loading") && (
        <button type="button" className="gv-open" title="Open the git view (g)" onClick={e => open(e)}>Open<kbd>g</kbd></button>
      )}
    </h3>
  );
  // A repository's section keeps one height while its read arrives and as it
  // changes, so the panel under it never jumps; a folder with no repository is
  // one line and keeps none.
  const section = (body: ReactNode, reserve = false) => (
    <section className="detail-section gv-glance" data-reserve={reserve ? "" : undefined} aria-labelledby={`gv-glance-${agent.id}`}>{heading}{body}</section>
  );

  // A folder with no repository to show: one line, the one `g` makes glow.
  const state = !readable ? facts!.state : data.state;
  if (state !== "repo" && state !== "loading") {
    return section(<ReadStateLine state={state} folder={agent.cwd ?? null} className="gv-line-empty" lineRef={lineRef} />);
  }

  const isSub = agent.kind === "subagent";
  const scopeWord = isSub ? "subagent" : "session";
  const upstream = upstreamWords(repo);
  // Other agents are named the way their cards are (git-agent-name.ts).
  const nameOf = (sessionId: string, agentId: string | null) => agentNameIn(stateRef.current.agents, sessionId, agentId);
  const collision = collisionsFor(root?.gitCollisions, focus)[0] ?? null;
  // Named as the card's own collision mark names it.
  const other = collision ? otherAgentName(nameOf, collision.with) : "";
  const own = (data.commits ?? []).filter(c => madeByFocus(c, focus));
  const showCommits = collision ? 2 : 3;
  const files = changedFiles(data.entries, data.edits, focus);
  const mine = files.filter(f => f.mine);
  const shownFiles = mine.slice(0, 2);
  const moreCommits = Math.max(0, own.length - showCommits);
  const moreFiles = Math.max(0, files.length - shownFiles.length);
  const ended = agent.state === "done" && agent.endedAt != null;
  const hue = sessionHue(agent.sessionId);

  return section(
    <>
      <div className="gv-g-branch" ref={branchRowRef} title={[agent.cwd, branchName].filter(Boolean).join(" · ")}>
        <GvIcon name={detached ? "commit" : "branch"} />
        <span className="gv-g-branch-name" ref={nameRef} data-name={branchName}>{branchName}</span>
        {head?.unborn ? <span className="gv-ahead">no commits yet</span>
          : upstream && <span className="gv-ahead" title={upstream.title}>{upstream.text}</span>}
      </div>
      {ended && (
        <p className="gv-note">
          Ended {shortAge(agent.endedAt!, now) === "now" ? "just now" : `${shortAge(agent.endedAt!, now)} ago`}. Its commits stay marked; the files are the folder as it is now.
        </p>
      )}
      {collision && (
        <CollisionLine c={collision} other={other} otherCli={null} where="glance"
          onFocus={how => goToAgentCard(collisionTarget(stateRef.current.agents, collision.with), how)} />
      )}
      {data.commits && !own.length && <p className="gv-line-empty">No commits from this {scopeWord} yet.</p>}
      {own.slice(0, showCommits).map(c => {
        const a = c.agent && "sessionId" in c.agent ? c.agent : null;
        const sub = !isSub && a?.agentId ? commitWho(c.agent, nameOf) : null;
        const { prefix, rest } = subjectParts(c.subject);
        return (
          <button type="button" key={c.sha} className="gv-g-row" title={`${c.subject} · ${c.sha.slice(0, 7)}`} onClick={e => open(e, { sel: c.sha })}>
            <GvMark level={commitMark(c.agent).level} />
            <span className="gv-g-subj">{prefix && <span className="gv-cc">{prefix} </span>}{rest}</span>
            {sub && <span className="gv-g-who">↳ {sub}</span>}
            <span className="gv-g-time" title={new Date(c.date).toLocaleString()}>{shortAge(Date.parse(c.date), now)}</span>
          </button>
        );
      })}
      {data.entries && (files.length === 0
        ? <p className="gv-line-empty">Working tree clean.</p>
        : <div className="gv-g-files-head"><b>{files.length}</b> file{files.length === 1 ? "" : "s"} changed · <b>{mine.length}</b> by this {scopeWord}</div>)}
      {shownFiles.map(f => {
        const [dir, base] = splitPath(f.path);
        const letter = f.entry.change.slice(0, 1).toUpperCase();
        const word = STATUS_WORD[letter] ?? f.entry.change;
        // The file's sides added together, as one file changed; nothing when unknown.
        const n = pathCounts(data.entries ?? [], f.path);
        return (
          <button
            type="button" key={f.path} className="gv-g-row gv-g-file" style={{ "--session-hue": hue } as CSSProperties}
            title={`${f.path} — edited by this ${scopeWord} (from its edit tools)`}
            onClick={e => open(e, { sel: UNCOMMITTED, file: { path: f.entry.path, area: f.entry.area, ...(f.entry.from ? { from: f.entry.from } : {}) } })}
          >
            <i className="gv-pip" aria-hidden="true" />
            <span className="gv-st" title={word}><span aria-hidden="true">{letter}</span><span className="vis-hidden">{word}</span></span>
            <span className="gv-path"><span className="gv-dir">{dir}</span><span className="gv-base">{base}</span></span>
            {n && (n.binary
              ? <span className="gv-g-counts"><span className="gv-g-bin" title="binary file">bin</span></span>
              : (n.added > 0 || n.removed > 0) && (
                <span className="gv-g-counts">
                  {n.added > 0 && <span className="gv-g-add">+{groupDigits(n.added)}<span className="vis-hidden"> added</span></span>}
                  {n.removed > 0 && <span className="gv-g-del">−{groupDigits(n.removed)}<span className="vis-hidden"> removed</span></span>}
                </span>
              ))}
          </button>
        );
      })}
      {(moreCommits > 0 || moreFiles > 0) && (
        <button type="button" className="gv-g-more" onClick={e => open(e)}>
          {[moreCommits ? `+${moreCommits} commit${moreCommits === 1 ? "" : "s"}` : "", moreFiles ? `+${moreFiles} more file${moreFiles === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}
          <span aria-hidden="true">·</span><kbd>g</kbd><span>open</span>
        </button>
      )}
      <GitHandoffs sessionId={agent.sessionId} agentId={agent.git ? subagentKey(agent) : null}
        branch={detached ? null : branch} sha={detached ? head?.sha ?? null : own[0]?.sha ?? null} path={agent.cwd ?? null} compact={false} />
    </>,
    true,
  );
}
