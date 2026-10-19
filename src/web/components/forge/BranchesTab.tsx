// The Branches tab (#2179): GitLab's own Branches page for one project, which
// is where the owner starts — Active branches, then the Stale ones folded.
//
// A row is the page's row: the branch name in mono with its copy button and
// its default / protected tags; under it the last commit, short sha · title ·
// how long ago; then behind | ahead against the default branch ("999+" past a
// thousand, as GitLab writes it), the pipeline's mark and word, and the open
// merge request's badge — or, when there is none, "Create merge request ↗",
// which opens the forge's own form. Behind | ahead and the pipeline travel
// together, in fixed widths, so they line up down the list at every width.
//
// ONE PRESS TARGET, TWO CONTROLS ON TOP OF IT. The row opens the branch's
// merge request when it has one and the branch otherwise, but the copy button
// and the Create link are controls of their own, and a button cannot hold
// another. So the row's button is stretched under the whole row and the two
// sit above it; the row's words stay in the list item, where a screen reader
// reads them after the button's name.
import { useMemo } from "react";
import type { ForgeBranch, ForgeKind } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import { changeBadge, ciMark, divergeCount, matchesQuery, splitBranches } from "../../forge-panel";
import {
  defaultFirst, divergeWords, listPhase, moreLabel, newChangeUrl, noMatchWords, useReportFreshness,
} from "../../forge-lists";
import { useForgePages } from "../../use-forge-read";
import type { ForgeTabProps } from "./ForgePanel";
import { sameSelection, useForge, type ForgeSelection } from "./ForgeContext";
import { Ago, Copyable, FoldGroup, ListEnd, LoadingRows, ReadFailure, StateMark } from "./ForgeParts";

export default function BranchesTab({ view, query }: ForgeTabProps) {
  const { kind, api, scope, refresh, reportFreshness } = useForge();
  // The panel picks a project before this tab draws; until then it reads nothing.
  const repo = view.repo ?? "";
  const read = useForgePages<ForgeBranch>(api, scope, repo ? "branches" : null, { repo }, refresh);
  useReportFreshness(reportFreshness, read);

  const items = useMemo(() => read.data?.items ?? [], [read.data]);
  const shown = useMemo(() => items.filter(b => matchesQuery({ name: b.name }, query)), [items, query]);
  const groups = useMemo(() => splitBranches(defaultFirst(shown)), [shown]);
  const defaultBranch = items.find(b => b.isDefault)?.name ?? null;
  const phase = listPhase(read, items.length, shown.length);

  const rows = (list: ForgeBranch[]) => (
    <ul className="fg-rows">
      {list.map(b => <BranchRow key={b.name} kind={kind} repo={repo} branch={b} defaultBranch={defaultBranch} />)}
    </ul>
  );

  return (
    <div className="fgl">
      {read.error && read.data && <ReadFailure error={read.error} onRetry={read.reload} compact />}
      {phase === "loading" && <LoadingRows label="Loading branches" />}
      {phase === "failed" && read.error && <ReadFailure error={read.error} onRetry={read.reload} />}
      {phase === "empty" && <p className="fg-empty">This {forgeWords[kind].repo.toLowerCase()} has no branches.</p>}
      {phase === "no-match" && <p className="fg-empty">{noMatchWords("branches", query)}</p>}
      {phase === "rows" && (
        <>
          <FoldGroup id="branches-active" title="Active branches" count={groups.active.length} defaultOpen>
            {groups.active.length
              ? rows(groups.active)
              : <p className="fgl-group-empty">{query.trim() ? noMatchWords("active branches", query) : "Every branch loaded so far is stale."}</p>}
          </FoldGroup>
          {groups.stale.length > 0 && (
            <FoldGroup id="branches-stale" title="Stale branches" count={groups.stale.length} defaultOpen={false}
              aside={<span className="fgl-group-note">No commits in 90 days</span>}>
              {rows(groups.stale)}
            </FoldGroup>
          )}
        </>
      )}
      {read.data && (
        <ListEnd next={read.data.next} loading={read.loadingMore} error={read.moreError} onMore={read.loadMore}
          label={moreLabel(items.length, read.data.total)} />
      )}
    </div>
  );
}

function BranchRow({ kind, repo, branch: b, defaultBranch }: {
  kind: ForgeKind; repo: string; branch: ForgeBranch; defaultBranch: string | null;
}) {
  const { selected, select } = useForge();
  const words = forgeWords[kind];
  const target: ForgeSelection = b.change
    ? { type: "change", repo, number: b.change.number }
    : { type: "branch", repo, name: b.name };
  const isSelected = sameSelection(selected, target);
  const diverge = b.isDefault ? null : divergeWords(b.behind, b.ahead, defaultBranch);
  const changeName = b.change ? `${words.changeSigil}${b.change.number}` : null;
  const badge = b.change ? changeBadge(b.change) : null;

  return (
    <li className="fgl-branch" data-selected={isSelected || undefined}>
      <button
        type="button"
        className="fgl-hit"
        aria-current={isSelected || undefined}
        aria-label={b.change ? `${b.name}, ${words.change.toLowerCase()} ${changeName}` : b.name}
        onClick={() => select(target)}
      />
      <span className="fgl-branch-name">
        <Copyable value={b.name} label="branch name"><code className="fgl-branch-code">{b.name}</code></Copyable>
        {b.isDefault && <span className="fg-badge">default</span>}
        {b.protected && <span className="fg-badge">protected</span>}
      </span>
      <span className="fg-meta fgl-commit">
        <code>{b.commit.shortSha}</code>
        <span className="fgl-dot" aria-hidden="true">·</span>
        <span className="fgl-commit-title">{b.commit.title}</span>
        {b.commit.committedAt != null && <><span className="fgl-dot" aria-hidden="true">·</span><Ago at={b.commit.committedAt} /></>}
      </span>
      <span className="fgl-stats" data-empty={(!diverge && !b.ci) || undefined}>
        <span className="fgl-diverge" data-empty={!diverge || undefined}>
          {diverge && (
            <>
              <span className="fgl-behind" aria-hidden="true">{divergeCount(b.behind)}</span>
              <span className="fgl-diverge-rule" aria-hidden="true" />
              <span aria-hidden="true">{divergeCount(b.ahead)}</span>
              <span className="fg-sr">{diverge}</span>
            </>
          )}
        </span>
        <span className="fgl-ci">{b.ci && <StateMark mark={ciMark(b.ci.state)} />}</span>
      </span>
      <span className="fgl-branch-change">
        {badge && changeName
          ? (
            <span className="fg-badge" data-tone={badge.tone} title={`${words.change} ${changeName}: ${badge.word}`}>
              <span aria-hidden="true">{badge.mark}</span> <code>{changeName}</code> {badge.word}
            </span>
          )
          : !b.isDefault && (
            <a className="fg-open fgl-create" href={newChangeUrl(kind, b)} target="_blank" rel="noreferrer noopener">
              Create {words.change.toLowerCase()} <span aria-hidden="true">↗</span>
            </a>
          )}
      </span>
    </li>
  );
}
