import React, { useEffect, useState } from "react";
import { copyText } from "../copy-text";
import { failureLasts, failureLine, groupDigits } from "../git-diff-parse";
import type { CommitDetail, CommitFile, CommitMessage, GitFileRef, LogCommit } from "../git-view-types";
import { FkInitials, longDate } from "./FkCommitStrip";
import FkFileTypeLabel from "./FkFileTypeLabel";
import FkStatusBadge from "./FkStatusBadge";
import { CheckGlyph, CopyGlyph } from "./GitDiffIcons";

export interface FkCommitTabProps {
  /** The selected history row's commit, refs included; null when none is. */
  commit: LogCommit | null;
  /** The same commit read whole: committer, message body, files. */
  detail: CommitDetail | null;
  loading: boolean;
  /** A parent's link pressed: select that commit in the history. */
  onJump: (sha: string) => void;
  /** A file pressed: open it in the Changes tab. */
  onOpenFile: (f: GitFileRef) => void;
  /** HEAD's branch, so its badge leads the refs and wears the check. */
  headBranch?: string | null;
  /** Why the commit could not be read, when it could not. */
  error?: string | null;
  /** Read it again, after a failed read. */
  onRetry?: () => void;
}

/** The most file rows the tab draws; the Changes tab lists them all. */
export const FILES_MAX = 1000;

/**
 * The Commit tab of the Fork look's inspector: AUTHOR and COMMITTER, each
 * with an initials avatar and the full date (one card when they are the same
 * person at the same moment); the commit's refs as neutral
 * badges, its whole SHA with a copy button, its parents as links into the
 * history; the subject and the whole message in monospace; and its files,
 * each opening in the Changes tab. Read-only, like everything in the view.
 */
export default function FkCommitTab({ commit, detail, loading, onJump, onOpenFile, headBranch = null, error = null, onRetry }: FkCommitTabProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const sha = commit?.sha ?? detail?.commit.sha ?? null;
  useEffect(() => setCopied(null), [sha]);
  const whole = detail && sha && detail.commit.sha === sha ? detail : null;

  if (!sha) return <div className="fkm is-empty"><p className="fkm-note">Select a commit to read it here.</p></div>;
  if (!whole) {
    if (loading || !error) return <div className="fkm is-empty"><p className="fkm-note is-wait" role="status">Reading the commit…</p></div>;
    return (
      <div className="fkm is-empty">
        <div className="fkm-note">
          <b>Couldn't read this commit.</b>
          <span>{failureLine(error)}</span>
          {onRetry && !failureLasts(error) && <button type="button" className="btn fkm-retry" onClick={onRetry}>Try again</button>}
        </div>
      </div>
    );
  }

  // The commit as its own read answered it: the history's record, its
  // committer and its message after the subject.
  const rec: LogCommit & CommitMessage = whole.commit;
  const author = { ...(commit?.author ?? rec.author), date: commit?.date ?? rec.date };
  const committer = rec.committer ?? author;
  const parents = rec.parents;
  const copy = async () => {
    if (await copyText(rec.sha)) {
      setCopied(rec.sha);
      window.setTimeout(() => setCopied(c => (c === rec.sha ? null : c)), 1500);
    }
  };
  const refs = commit ? refBadges(commit, headBranch) : [];
  const files = whole.files;

  return (
    <div className="fkm" role="region" aria-label={`Commit ${rec.sha.slice(0, 7)}`} tabIndex={-1}>
      <div className="fkm-ids">
        {sameIdentity(author, committer) ? <Identity role="Author and committer" who={author} /> : (
          <>
            <Identity role="Author" who={author} />
            <Identity role="Committer" who={committer} />
          </>
        )}
      </div>
      <dl className="fkm-meta">
        {refs.length > 0 && (
          <>
            <dt>Refs</dt>
            <dd className="fkm-refs">{refs.map(r => <RefBadge key={`${r.kind}:${r.name}`} r={r} />)}</dd>
          </>
        )}
        <dt>SHA</dt>
        <dd className="fkm-sha">
          <span className="fkm-sha-text">{rec.sha}</span>
          <button type="button" className="fkm-copy" onClick={copy} title={copied ? "Copied" : "Copy SHA"} aria-label={`Copy commit SHA ${rec.sha.slice(0, 7)}`}>
            {copied === rec.sha ? <CheckGlyph /> : <CopyGlyph />}
          </button>
          <span className="vis-hidden" aria-live="polite">{copied === rec.sha ? "Commit SHA copied" : ""}</span>
        </dd>
        {parents.length > 0 && (
          <>
            <dt>{parents.length === 1 ? "Parent" : "Parents"}</dt>
            <dd className="fkm-parents">
              {parents.map(p => (
                <button key={p} type="button" className="fkm-parent" onClick={() => onJump(p)} title={`Select ${p.slice(0, 7)} in the history`}>
                  {p.slice(0, 7)}
                </button>
              ))}
            </dd>
          </>
        )}
      </dl>
      <hr className="fkm-rule" />
      <div className="fkm-msg">
        <h3 className="fkm-subject">{rec.subject}</h3>
        {rec.body ? <pre className="fkm-body">{rec.body}</pre> : null}
        {rec.clipped && <p className="fkm-clipped">The message goes on past 64 KB; the rest is not shown.</p>}
      </div>
      <hr className="fkm-rule" />
      {whole.notDownloaded && (
        <p className="fkm-clipped">This partial clone does not hold these files' content, so their line counts are not known. The deck never fetches.</p>
      )}
      {files.length === 0 ? (
        <p className="fkm-clipped">No files in this commit: it changes nothing in the tree.</p>
      ) : (
        <ul className="fkm-files">
          {files.slice(0, FILES_MAX).map(f => <FileRow key={f.path} f={f} onOpen={onOpenFile} />)}
          {files.length > FILES_MAX && (
            <li className="fkm-more">And {groupDigits(files.length - FILES_MAX)} more files: the Changes tab lists them all.</li>
          )}
        </ul>
      )}
    </div>
  );
}

type Who = { name: string; email: string; date: string };

/** The same person at the same moment: one card says both, rather than two
 *  cards saying the same thing. */
export const sameIdentity = (a: Who, b: Who) => a.name === b.name && a.email === b.email && Date.parse(a.date) === Date.parse(b.date);

function Identity({ role, who }: { role: string; who: Who }) {
  return (
    <div className="fkm-id">
      <FkInitials name={who.name} email={who.email} size="card" />
      <div className="fkm-id-text">
        <span className="fkm-id-role">{role}</span>
        <span className="fkm-id-line" title={`${who.name} <${who.email}>`}>
          <span className="fkm-id-name">{who.name}</span>
          {who.email && <span className="fkm-id-mail">{who.email}</span>}
        </span>
        <span className="fkm-id-date" title={longDate(who.date)}>{longDate(who.date)}</span>
      </div>
    </div>
  );
}

function FileRow({ f, onOpen }: { f: CommitFile; onOpen: (f: GitFileRef) => void }) {
  const ref: GitFileRef = f.from !== undefined ? { path: f.path, area: "commit", from: f.from } : { path: f.path, area: "commit" };
  return (
    <li className="fkm-file">
      <button type="button" className="fkm-file-btn" onClick={() => onOpen(ref)}
        title={f.from ? `${f.path}\n${f.change === "copied" ? "copied" : "renamed"} from ${f.from}\nOpen in the Changes tab` : `${f.path}\nOpen in the Changes tab`}>
        <FkStatusBadge change={f.change} />
        <FkFileTypeLabel path={f.path} />
        <span className="fkm-file-path"><bdi>{f.path}</bdi></span>
        <span className="fkm-file-go" aria-hidden="true">
          <svg width="8" height="8" viewBox="0 0 8 8" focusable="false"><path d="M1 4h5.6M4.4 1.8 6.6 4 4.4 6.2" /></svg>
        </span>
      </button>
    </li>
  );
}

// ── refs ──────────────────────────────────────────────────────────────────

export interface RefItem {
  kind: "head" | "local" | "remote" | "tag" | "detached";
  name: string;
}

/**
 * A commit's refs as the Commit tab lists them: HEAD's branch first, then the
 * other local branches, the remote-tracking ones, the tags, each by name; a
 * detached HEAD as `HEAD`; a remote's `HEAD` pointer left out. A local branch
 * and its remote copy are two badges here.
 */
export function refBadges(c: Pick<LogCommit, "refs">, headBranch: string | null): RefItem[] {
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const out: RefItem[] = [];
  const locals = [...c.refs.local].sort(byName);
  if (c.refs.head && headBranch && locals.includes(headBranch)) out.push({ kind: "head", name: headBranch });
  else if (c.refs.head && !headBranch) out.push({ kind: "detached", name: "HEAD" });
  for (const n of locals) if (!(out[0]?.kind === "head" && n === headBranch)) out.push({ kind: "local", name: n });
  for (const n of [...c.refs.remote].sort(byName)) if (!/\/HEAD$/.test(n)) out.push({ kind: "remote", name: n });
  for (const n of [...c.refs.tags].sort(byName)) out.push({ kind: "tag", name: n });
  return out;
}

const REF_WORD: Record<RefItem["kind"], string> = {
  head: "current branch", local: "branch", remote: "remote branch", tag: "tag", detached: "detached HEAD",
};

/** One ref, Fork's badge shape in the neutral colours. */
export function RefBadge({ r }: { r: RefItem }) {
  return (
    <span className="fkm-ref" data-kind={r.kind} title={`${REF_WORD[r.kind]} ${r.name}`}>
      {r.kind === "remote" && (
        <span className="fkm-ref-cell" aria-hidden="true">
          <svg width="13" height="11" viewBox="0 0 13 11" focusable="false">
            <path d="M3.6 9.4h6a2.3 2.3 0 0 0 .3-4.6 3.2 3.2 0 0 0-6.2-.7A2.6 2.6 0 0 0 3.6 9.4z" />
          </svg>
        </span>
      )}
      <span className="fkm-ref-name">
        {r.kind === "head" && (
          <svg className="fkm-ref-check" width="10" height="9" viewBox="0 0 10 9" aria-hidden="true" focusable="false"><path d="m1.2 4.8 2.4 2.5L8.8 1.4" /></svg>
        )}
        {r.kind === "tag" && (
          <svg className="fkm-ref-tag" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" focusable="false">
            <path d="M1.4 1.4h3.8l4.4 4.4-3.8 3.8-4.4-4.4z" /><circle cx="3.7" cy="3.7" r=".6" />
          </svg>
        )}
        <span className="vis-hidden">{REF_WORD[r.kind]} </span>
        {r.name}
      </span>
    </span>
  );
}
