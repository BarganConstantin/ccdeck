// An edit's change, as a card: one row per diff line, its line number in a
// gutter that stays put while the code scrolls sideways, the added and the
// removed lines tinted and keeping their + and −, and the code coloured when
// the file's extension names a language chat-highlight.ts reads. The row it
// opens from says "path  +N −M" (DiffCounts).
import { useMemo } from "react";
import { useT } from "../../i18n";
import type { ChatDiff } from "./chat-model";
import { highlightLine, languageOfPath, MAX_HIGHLIGHT_LINES, type HighlightLanguage } from "./chat-highlight";
import { tokenNodes } from "./ChatCode";
import "./chat-rich.css";

export type DiffOp = "add" | "del" | "ctx" | "gap";

/** Which way a diff line goes: added, removed, kept, or the gap between two hunks. */
export function diffOp(line: string): DiffOp {
  if (line === "…") return "gap";
  return line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
}

export interface DiffRow { op: DiffOp; sign: string; text: string; n?: number }

/** The rows of a diff, numbered when the transcript says where each hunk
 *  starts: a kept or added line by the new file, a removed one by the old. */
export function diffRows(diff: ChatDiff): DiffRow[] {
  let hunk = 0;
  let old = diff.starts?.[0]?.old;
  let now = diff.starts?.[0]?.new;
  return diff.lines.map(line => {
    const op = diffOp(line);
    if (op === "gap") {
      hunk++;
      old = diff.starts?.[hunk]?.old;
      now = diff.starts?.[hunk]?.new;
      return { op, sign: "…", text: "" };
    }
    const row: DiffRow = { op, sign: line.slice(0, 1), text: line.slice(1) };
    if (op === "del") { if (old !== undefined) row.n = old++; }
    else if (now !== undefined) {
      row.n = now++;
      if (op === "ctx" && old !== undefined) old++;
    }
    return row;
  });
}

/** "+N −M", each in its own tint, as the row's note: the words stay the note's. */
export function DiffCounts({ note }: { note: string }) {
  const counts = /^\+(\d+) −(\d+)$/.exec(note);
  if (!counts) return <>{note}</>;
  return <><span className="chat-diff-plus">+{counts[1]}</span> <span className="chat-diff-minus">−{counts[2]}</span></>;
}

/** The change, as the card's body. */
export default function DiffBlock({ diff, path }: { diff: ChatDiff; path?: string }) {
  const t = useT();
  const language: HighlightLanguage | null = path && diff.lines.length <= MAX_HIGHLIGHT_LINES ? languageOfPath(path) : null;
  const rows = useMemo(() => diffRows(diff), [diff]);
  const numbered = rows.some(row => row.n !== undefined);
  return <>
    <pre className="chat-diff" data-numbered={numbered || undefined}><code>{rows.map((row, i) => (
      <span key={i} className="chat-diff-line" data-op={row.op}>
        {numbered && <span className="chat-diff-num" aria-hidden="true" data-n={row.n ?? ""} />}
        <span className="chat-diff-sign">{row.sign}</span>
        <span className="chat-diff-text">{language && row.op !== "gap" ? tokenNodes(highlightLine(row.text, language)) : row.text}</span>
      </span>
    ))}</code></pre>
    {diff.cut && <p className="chat-diff-cut">{t("board.chat.diff.cut")}</p>}
  </>;
}
