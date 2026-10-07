import React from "react";
import { changeMark } from "../git-files-model";

// A file's change in the git view's Fork look: a 14px square in the change's
// colour with a glyph in it — M (T for a type change), a drawn + for an added
// or untracked file, a drawn − for a deleted one, → for a rename or a copy, a
// triangle with ! for a conflict. The colour never carries it alone: the
// glyph does for the eye and the word does for a screen reader.

/** The badge each change is drawn as. Fork treats untracked as added. */
export type FkStatusKind = "modified" | "added" | "untracked" | "deleted" | "renamed" | "conflict";

const KIND: Record<string, FkStatusKind> = {
  modified: "modified",
  typechange: "modified",
  added: "added",
  untracked: "untracked",
  deleted: "deleted",
  renamed: "renamed",
  copied: "renamed",
  conflict: "conflict",
};

export const fkStatusKind = (change: string): FkStatusKind => KIND[change] ?? "modified";

function Glyph({ kind, change }: { kind: FkStatusKind; change: string }) {
  if (kind === "added" || kind === "untracked") {
    return <svg className="fk-st-mark" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false"><path d="M4 .8v6.4M.8 4h6.4" /></svg>;
  }
  if (kind === "deleted") {
    return <svg className="fk-st-mark" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false"><path d="M.8 4h6.4" /></svg>;
  }
  if (kind === "renamed") {
    return <svg className="fk-st-mark" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false"><path d="M.8 4h6.2M4.6 1.6 7 4 4.6 6.4" /></svg>;
  }
  return <span className="fk-st-letter" aria-hidden="true">{change === "typechange" ? "T" : "M"}</span>;
}

/** The status square for `change` (git's word: modified, added, …). */
export default function FkStatusBadge({ change }: { change: string }) {
  const kind = fkStatusKind(change);
  const { word } = changeMark(change);
  if (kind === "conflict") {
    return (
      <span className="fk-st" data-st="conflict">
        <svg className="fk-st-tri" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
          <path className="fk-st-tri-fill" d="M7 1.4c.4 0 .7.2.9.5l5.3 9.4c.4.7-.1 1.5-.9 1.5H1.7c-.8 0-1.3-.8-.9-1.5l5.3-9.4c.2-.3.5-.5.9-.5z" />
          <path className="fk-st-tri-ink" d="M7 5v3.6M7 10.6v.1" />
        </svg>
        <span className="vis-hidden">{word}</span>
      </span>
    );
  }
  return (
    <span className="fk-st" data-st={kind}>
      <Glyph kind={kind} change={change} />
      <span className="vis-hidden">{word}</span>
    </span>
  );
}
