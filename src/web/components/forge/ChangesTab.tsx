// The Merge requests tab (#2179) — Pull requests on GitHub: GitLab's Merge
// requests dashboard, for one project or across all of them.
//
// Open / Merged / Closed with the forge's counts, then All (the default) /
// Mine / Review requests, then the sort — created, newest first, or last
// updated. All three are the panel's remembered view, so the list reopens the
// way it was left. A row is the dashboard's row: the title (a draft marked),
// `!iid · created 3h ago by Author` under it (the project's path too when the
// list is across projects), and on the right the pipeline's mark, Approved,
// the reviewers with how each one stands, the comment count, and when it last
// moved — or was merged or closed.
//
// REVIEW REQUESTS ARE SPLIT THE WAY A REVIEWER READS THEM: still waiting for
// me first, the ones I already approved folded under them.
//
// The comment count, the labels and the people stack are drawn the same way
// on the Issues tab, which takes them from here.
import { useId, useMemo, useState } from "react";
import type { ChangeCounts, ChangeFilter, ChangeState, ForgeChange, ForgeKind, ForgeLabel, ForgeReviewer, ForgeUser } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import { changeBadge, ciMark, matchesQuery, reviewerMark, splitReviews, type Mark } from "../../forge-panel";
import {
  changeMoment, countWords, draftTitle, emptyChangesWords, itemLabel, labelColor, listPhase, moreLabel, noMatchWords,
  useReportFreshness,
} from "../../forge-lists";
import { useForgePages, useForgeRead } from "../../use-forge-read";
import type { ForgeTabProps } from "./ForgePanel";
import { sameSelection, useForge } from "./ForgeContext";
import { IntegrationAvatarStack } from "../IntegrationAvatar";
import { Ago, Badge, Face, FoldGroup, ListEnd, LoadingRows, ReadFailure, StateMark, useFaceOf } from "./ForgeParts";
import { CheckGlyph } from "../integration-glyphs";
import { ChevronGlyph, StateGlyph } from "./ForgeGlyphs";
import AnchoredPopover from "../AnchoredPopover";

const STATES: { state: ChangeState; label: string }[] = [
  { state: "open", label: "Open" },
  { state: "merged", label: "Merged" },
  { state: "closed", label: "Closed" },
];

const FILTERS: { filter: ChangeFilter; label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "mine", label: "Mine" },
  { filter: "review", label: "Review requests" },
];

const DRAFT: Mark = changeBadge({ state: "open", draft: true, approved: false });
const APPROVED: Mark = changeBadge({ state: "open", draft: false, approved: true });

export default function ChangesTab({ view, setView, query }: ForgeTabProps) {
  const { kind, api, scope, refresh, reportFreshness } = useForge();
  const words = forgeWords[kind];
  const repo = view.repo ?? undefined;
  const acrossRepos = view.repo == null;
  const read = useForgePages<ForgeChange>(api, scope, "changes", { repo, filter: view.filter, state: view.state, sort: view.sort }, refresh);
  const counts = useForgeRead<ChangeCounts>(api, scope, "change-counts", { repo, filter: view.filter }, refresh);
  useReportFreshness(reportFreshness, read);

  const items = useMemo(() => read.data?.items ?? [], [read.data]);
  const shown = useMemo(
    () => items.filter(c => matchesQuery({ key: c.key, title: c.title, name: c.sourceBranch, number: c.number }, query)),
    [items, query],
  );
  const phase = listPhase(read, items.length, shown.length);
  const reviews = view.filter === "review" && view.state === "open" ? splitReviews(shown) : null;
  const noun = words.changes.toLowerCase();

  const rows = (list: ForgeChange[]) => (
    <ul className="fg-rows">
      {list.map(c => <ChangeRow key={c.key} kind={kind} change={c} acrossRepos={acrossRepos} />)}
    </ul>
  );

  return (
    <div className="fgl">
      <div className="fgl-controls">
        <div className="uh-range fgl-seg" role="group" aria-label={`${words.changes} by state`}>
          {STATES.map(({ state, label }) => {
            const count = countWords(counts.data?.[state]);
            return (
              <button key={state} type="button" className="uh-range-btn" aria-pressed={view.state === state} onClick={() => setView({ state })}>
                {label}{count && <span className="fgl-seg-count">{count}</span>}
              </button>
            );
          })}
        </div>
        {/* Which ones: a strip where the list has room, one menu button named
            by the current choice where it does not (a phone, or the column
            beside an open item). Both are drawn and the list's width shows
            one, so the choice never moves when the pane is resized. */}
        <div className="uh-range fgl-seg fgl-scope-seg" role="group" aria-label={`Which ${noun}`}>
          {FILTERS.map(({ filter, label }) => (
            <button key={filter} type="button" className="uh-range-btn" aria-pressed={view.filter === filter} onClick={() => setView({ filter })}>
              {label}
            </button>
          ))}
        </div>
        <ScopeMenu filter={view.filter} noun={noun} onChange={filter => setView({ filter })} />
        <SortToggle sort={view.sort} onChange={sort => setView({ sort })} />
      </div>

      {read.error && read.data && <ReadFailure error={read.error} onRetry={read.reload} compact />}
      {phase === "loading" && <LoadingRows label={`Loading ${noun}`} />}
      {phase === "failed" && read.error && <ReadFailure error={read.error} onRetry={read.reload} />}
      {phase === "empty" && <p className="fg-empty">{emptyChangesWords(kind, { state: view.state, filter: view.filter, acrossRepos })}</p>}
      {phase === "no-match" && <p className="fg-empty">{noMatchWords(noun, query)}</p>}
      {phase === "rows" && (reviews
        ? (
          <>
            <FoldGroup id="reviews-waiting" title="Waiting for my review" count={reviews.waiting.length} defaultOpen>
              {reviews.waiting.length
                ? rows(reviews.waiting)
                : <p className="fgl-group-empty">{query.trim() ? noMatchWords(`${noun} waiting for you`, query) : "Nothing loaded is waiting for you; you approved every one."}</p>}
            </FoldGroup>
            {reviews.approved.length > 0 && (
              <FoldGroup id="reviews-approved" title="Approved by me" count={reviews.approved.length} defaultOpen={false}>
                {rows(reviews.approved)}
              </FoldGroup>
            )}
          </>
        )
        : <div className="fgl-flat">{rows(shown)}</div>)}
      {read.data && (
        <ListEnd pages={read} label={moreLabel(items.length, read.data.total)} />
      )}
    </div>
  );
}

/** All / Mine / Review requests as one button and its menu, for a narrow
 *  list: the button says the current choice, the menu checks it. */
function ScopeMenu({ filter, noun, onChange }: { filter: ChangeFilter; noun: string; onChange: (filter: ChangeFilter) => void }) {
  const id = useId();
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const current = FILTERS.find(f => f.filter === filter) ?? FILTERS[0];
  const trigger = `${id}-trigger`;
  const pick = (next: ChangeFilter) => {
    onChange(next);
    setMenu(null);
    document.getElementById(trigger)?.focus({ preventScroll: true });
  };
  return (
    <span className="fgl-scope" id={`${id}-layer`}>
      <button
        id={trigger}
        type="button"
        className="btn fgl-scope-trigger"
        aria-label={`Which ${noun}: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={menu != null}
        aria-controls={menu ? `${id}-menu` : undefined}
        onClick={() => setMenu(m => (m ? null : "first"))}
        onKeyDown={e => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setMenu(e.key === "ArrowUp" ? "last" : "first");
        }}
      >
        {current.label}
        <ChevronGlyph />
      </button>
      {menu && (
        <AnchoredPopover anchorId={trigger} portalRootId={`${id}-layer`} id={`${id}-menu`} className="ap-pop fgl-scope-pop" role="menu"
          labelledBy={trigger} start={menu} onClose={() => setMenu(null)}>
          {FILTERS.map(f => (
            <button key={f.filter} type="button" role="menuitem" className="ap-menu-item fgl-scope-item"
              aria-current={f.filter === filter || undefined} onClick={() => pick(f.filter)}>
              <span className="fgl-scope-check" aria-hidden="true">{f.filter === filter && <CheckGlyph />}</span>
              {f.label}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </span>
  );
}

/** Created or Updated, newest first. On a narrow list only its glyph shows;
 *  its name says the rest, and its tooltip says it to the pointer. */
function SortToggle({ sort, onChange }: { sort: "created" | "updated"; onChange: (sort: "created" | "updated") => void }) {
  const next = sort === "created" ? "updated" : "created";
  return (
    <button
      type="button"
      className="btn fgl-sort"
      title={`Newest ${sort} first. Sort by ${next} instead.`}
      aria-label={`Sorted by ${sort === "created" ? "date created" : "last updated"}, newest first. Sort by ${next === "created" ? "date created" : "last updated"} instead.`}
      onClick={() => onChange(next)}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
        <path d="M2 3h8M3.5 6h5M5 9h2" />
      </svg>
      <span className="fgl-sort-word">{sort === "created" ? "Created" : "Updated"}</span>
    </button>
  );
}

function ChangeRow({ kind, change: c, acrossRepos }: { kind: ForgeKind; change: ForgeChange; acrossRepos: boolean }) {
  const { selected, select } = useForge();
  const target = { type: "change" as const, repo: c.repo, number: c.number };
  const isSelected = sameSelection(selected, target);
  const moment = changeMoment(c);
  const author = c.author ? c.author.name || c.author.login : null;
  return (
    <li>
      <button
        type="button"
        className="fg-row fgl-row ig-row"
        data-selected={isSelected || undefined}
        aria-current={isSelected || undefined}
        onClick={() => select(target)}
      >
        <span className="fg-row-title fgl-title">
          {c.draft && <Badge mark={DRAFT} />}
          <span className="fgl-title-text">{draftTitle(c.title, c.draft)}</span>
          <Labels labels={c.labels} />
        </span>
        <span className="fgl-side">
          {c.ci && <StateMark mark={ciMark(c.ci.state)} />}
          {c.state === "open" && c.approved && <Badge mark={APPROVED} />}
          <Reviewers reviewers={c.reviewers} />
          <CommentCount count={c.comments} />
        </span>
        <span className="fg-meta fgl-meta">
          <code>{itemLabel(forgeWords[kind].changeSigil, c, acrossRepos)}</code>
          {c.createdAt != null && <> · created <Ago at={c.createdAt} /></>}
          {author && <> by {author}</>}
        </span>
        <span className="fgl-when">{moment.at != null && <><span className="fgl-when-verb">{moment.verb} </span><Ago at={moment.at} /></>}</span>
      </button>
    </li>
  );
}

/** The reviewers' faces, each with how they stand: a check approved, a plus
 *  over a minus for changes requested, a speech bubble commented. A pending
 *  review has no mark, only its word. A
 *  screen reader hears the same list in words — "Reviewers: Bob, approved;
 *  Carol, pending" — because a plain span cannot carry a label of its own. */
function Reviewers({ reviewers }: { reviewers: ForgeReviewer[] }) {
  if (!reviewers.length) return null;
  return (
    <span className="fgl-people">
      <span className="fg-sr">{reviewers.length === 1 ? "Reviewer: " : "Reviewers: "}</span>
      {reviewers.slice(0, 3).map((r, i) => {
        const m = reviewerMark(r.state);
        return (
          <span key={r.login} className="fgl-reviewer" data-tone={m.tone} title={`${r.name || r.login}: ${m.word}`}>
            {i > 0 && <span className="fg-sr">; </span>}
            <Face user={r} />
            <span className="fg-sr">{r.name || r.login}</span>
            {r.state !== "pending" && <span className="fgl-reviewer-mark" aria-hidden="true"><StateGlyph name={m.mark} size={9} weight={1.8} /></span>}
            <span className="fg-sr">, {m.word}</span>
          </span>
        );
      })}
      <More count={reviewers.length - 3} />
    </span>
  );
}

/** A few faces in a row (assignees), then "+N": the integrations' shared
 *  stack, which a screen reader hears as one picture named with every name,
 *  "Assigned to Alice, Bob and Carol". */
export function People({ users, label }: { users: ForgeUser[]; label: string }) {
  const faceOf = useFaceOf();
  if (!users.length) return null;
  return <IntegrationAvatarStack label={label} people={users.map(u => ({ key: u.login, ...faceOf(u) }))} />;
}

/** "+2" for the eye, "and 2 more" for the ear. */
function More({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <>
      <span className="fgl-people-more" aria-hidden="true">+{count}</span>
      <span className="fg-sr"> and {count} more</span>
    </>
  );
}

/** How many comments, beside a speech mark; nothing for none. */
export function CommentCount({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="fgl-comments" title={`${count} ${count === 1 ? "comment" : "comments"}`}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 3.5h11v7.5h-6l-3 2.5v-2.5h-2z" />
      </svg>
      {count.toLocaleString("en-US")}
      <span className="fg-sr"> {count === 1 ? "comment" : "comments"}</span>
    </span>
  );
}

/** The forge's labels: the name, with its colour as a dot (data, not theme). */
export function Labels({ labels }: { labels: ForgeLabel[] }) {
  if (!labels.length) return null;
  return (
    <span className="fgl-labels">
      {labels.slice(0, 4).map(l => {
        const color = labelColor(l.color);
        return (
          <span key={l.name} className="fgl-label" title={l.name}>
            {color && <i className="fgl-label-dot" style={{ background: color }} aria-hidden="true" />}
            <span className="fgl-label-name">{l.name}</span>
          </span>
        );
      })}
      {labels.length > 4 && <span className="fgl-label" title={labels.slice(4).map(l => l.name).join(", ")}>+{labels.length - 4}</span>}
    </span>
  );
}
