import React, { useState } from "react";
import { copyText } from "../copy-text";
import { FkAvatar } from "./FkAvatar";

// The one line over the Changes tab in the git view's Fork look: who wrote
// the commit, its short SHA (a press copies it whole), when, and its subject.
// Also the dates in Fork's words, which the Commit tab shares with it.

// The avatar is the history's own (FkAvatar.tsx), so one person is one colour
// in the rows, the strip and the Commit tab.
export { AVATAR_TONES, avatarTone, initials as initialsOf } from "./FkAvatar";

const at = (d: Date, date: Intl.DateTimeFormatOptions, time: Intl.DateTimeFormatOptions, locale?: string) =>
  `${new Intl.DateTimeFormat(locale, date).format(d)} at ${new Intl.DateTimeFormat(locale, time).format(d)}`;

/** `18 Sep 2026 at 12:53`, in the reader's own order of day and month. */
export function stripDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return at(d, { dateStyle: "medium" }, { timeStyle: "short" }, locale);
}

/** `5 October 2026 at 16:50:54 GMT+3`: the Commit tab's long form. */
export function longDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return at(d, { dateStyle: "long" }, { timeStyle: "long" }, locale);
}

export interface StripCommit {
  sha: string;
  author: { name: string; email: string };
  date: string;
  subject: string;
}

/** The commit strip: avatar, author, short SHA, date, subject. */
export default function FkCommitStrip({ commit }: { commit: StripCommit | null }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!commit) return <div className="fkc-strip" aria-hidden="true" />;
  const short = commit.sha.slice(0, 7);
  const copy = async () => {
    if (await copyText(commit.sha)) {
      setCopied(commit.sha);
      window.setTimeout(() => setCopied(c => (c === commit.sha ? null : c)), 1500);
    }
  };
  return (
    <div className="fkc-strip">
      <FkAvatar name={commit.author.name} email={commit.author.email} size="strip" />
      <span className="fkc-strip-author" title={`${commit.author.name} <${commit.author.email}>`}>{commit.author.name}</span>
      <button type="button" className="fkc-strip-sha" onClick={copy} title={`Copy ${commit.sha}`} aria-label={`Copy commit SHA ${short}`}>{short}</button>
      <span className="fkc-strip-date">{stripDate(commit.date)}</span>
      <span className="fkc-strip-subject" title={commit.subject}>{commit.subject}</span>
      <span className="vis-hidden" aria-live="polite">{copied === commit.sha ? "Commit SHA copied" : ""}</span>
    </div>
  );
}
