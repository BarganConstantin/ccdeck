import React, { useState } from "react";
import { copyText } from "../copy-text";

// The one line over the Changes tab in the git view's Fork look: who wrote
// the commit, its short SHA (a press copies it whole), when, and its subject.
// Also the pieces the Commit tab shares with it: the initials avatar and the
// dates in Fork's words.

/** The five avatar tones, picked by a stable hash of the lower-cased e-mail
 *  (the name when there is none), so one person is one colour everywhere. */
export const AVATAR_TONES = 5;

export function avatarTone(name: string, email: string): number {
  const key = (email.trim() || name.trim()).toLowerCase();
  // FNV-1a, 32-bit: the same answer in every browser and on every run.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % AVATAR_TONES;
}

/** Up to two initials: the first letters of the first two words, else the
 *  first letter of the one word there is. Never a picture: the deck fetches
 *  no avatars. */
export function initialsOf(name: string): string {
  const words = name.replace(/\[bot\]$/i, "").split(/[\s._-]+/).filter(w => /\p{L}|\p{N}/u.test(w));
  const first = (w: string) => Array.from(w.replace(/^[^\p{L}\p{N}]+/u, ""))[0] ?? "";
  const letters = words.slice(0, 2).map(first).join("");
  return (letters || "?").toLocaleUpperCase();
}

/** The initials square: 18px in the strip, 42px in the Commit tab. */
export function FkInitials({ name, email, size }: { name: string; email: string; size: "strip" | "card" }) {
  return (
    <span className="fkm-ava" data-size={size} data-tone={avatarTone(name, email)} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

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
      <FkInitials name={commit.author.name} email={commit.author.email} size="strip" />
      <span className="fkc-strip-author" title={`${commit.author.name} <${commit.author.email}>`}>{commit.author.name}</span>
      <button type="button" className="fkc-strip-sha" onClick={copy} title={`Copy ${commit.sha}`} aria-label={`Copy commit SHA ${short}`}>{short}</button>
      <span className="fkc-strip-date">{stripDate(commit.date)}</span>
      <span className="fkc-strip-subject" title={commit.subject}>{commit.subject}</span>
      <span className="vis-hidden" aria-live="polite">{copied === commit.sha ? "Commit SHA copied" : ""}</span>
    </div>
  );
}
