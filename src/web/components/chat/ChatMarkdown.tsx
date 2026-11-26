import { Fragment, type ReactNode } from "react";
import { useT } from "../../i18n";
import { parseChatInline, type ChatInline } from "./chat-inline";
import ChatCode from "./ChatCode";

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[\t ]+(.+)$/;
const LIST_ITEM = /^ {0,3}(?:([-+*])|([0-9]{1,9})[.)])[\t ]+(.*)$/;
const QUOTE = /^ {0,3}>[\t ]?(.*)$/;
const RULE = /^ {0,3}(?:-[\t ]*){3,}$|^ {0,3}(?:\*[\t ]*){3,}$|^ {0,3}(?:_[\t ]*){3,}$/;
// A table's second line: a cell of dashes per column, a colon where it is aligned.
// Read on the trimmed line, so no run of spaces is tried two ways.
const TABLE_RULE = /^\|?[\t ]*:?-+:?[\t ]*(?:\|[\t ]*:?-+:?[\t ]*)*\|?$/;
/** The most columns a table is drawn with; a row past it keeps its first cells. */
const MAX_COLUMNS = 20;

function fenceAt(line: string) {
  const match = FENCE.exec(line);
  // A backtick in a backtick fence's info string is ordinary prose.
  return match && !(match[1][0] === "`" && match[2].includes("`")) ? match : null;
}

/** A table row's cells: split on the pipes outside code spans and escapes, the outer pipes dropped. */
export function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let code = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") { cell += "\\|"; i++; continue; }
    if (c === "`") {
      let n = 0;
      while (line[i + n] === "`") n++;
      code = code === n ? 0 : code === 0 ? n : code;
      cell += "`".repeat(n);
      i += n - 1;
      continue;
    }
    if (c === "|" && !code) { cells.push(cell); cell = ""; continue; }
    cell += c;
  }
  cells.push(cell);
  const trimmed = line.trim();
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|") && cells.length) cells.pop();
  return cells.map(c => c.trim());
}

/** Whether `lines[i]` opens a table: a row with a pipe, then its rule with as many columns. */
function tableAt(lines: string[], i: number): boolean {
  const head = lines[i];
  const rule = lines[i + 1];
  if (rule === undefined || !head.includes("|") || !TABLE_RULE.test(rule.trim()) || !rule.includes("-")) return false;
  const columns = tableCells(head).length;
  return columns > 0 && tableCells(rule).length === columns && (columns > 1 || head.trim().startsWith("|"));
}

function renderInline(nodes: ChatInline[]): ReactNode[] {
  return nodes.map((node, i) => {
    if (node.kind === "code") return <code key={i}>{node.text}</code>;
    if (node.kind === "bold") return <strong key={i}>{renderInline(node.kids)}</strong>;
    if (node.kind === "italic") return <em key={i}>{renderInline(node.kids)}</em>;
    if (node.kind === "strike") return <del key={i}>{renderInline(node.kids)}</del>;
    if (node.kind === "link") {
      return <a key={i} href={node.href} target="_blank" rel="noopener noreferrer">{renderInline(node.kids)}</a>;
    }
    return <Fragment key={i}>{node.text.split("\n").map((line, j) => (
      <Fragment key={j}>{j > 0 && <br />}{line}</Fragment>
    ))}</Fragment>;
  });
}

const inline = (text: string) => renderInline(parseChatInline(text));
const startsBlock = (line: string) => fenceAt(line) || HEADING.test(line) || LIST_ITEM.test(line) || QUOTE.test(line) || RULE.test(line);
type Align = "left" | "center" | "right" | undefined;

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : undefined;
}

/** A GitHub table, scrolled sideways inside the message when it is wider. */
function Table({ head, align, rows }: { head: string[]; align: Align[]; rows: string[][] }) {
  const t = useT();
  return (
    <div className="chat-table-wrap" role="region" aria-label={t("board.chat.rich.table")} tabIndex={0}>
      <table className="chat-table">
        <thead><tr>{head.map((cell, i) => <th key={i} data-align={align[i]}>{inline(cell)}</th>)}</tr></thead>
        {rows.length > 0 && <tbody>{rows.map((row, r) => (
          <tr key={r}>{head.map((_, i) => <td key={i} data-align={align[i]}>{inline(row[i] ?? "")}</td>)}</tr>
        ))}</tbody>}
      </table>
    </div>
  );
}

/** The transcript's Markdown: block structure, bold, italics, strikethrough,
 *  inline code, links (http, https and mailto only, opened in a new tab),
 *  GitHub tables and code blocks with their language and a Copy button. Raw
 *  HTML stays literal; all content goes through React text. */
export default function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const key = i;
    const fence = fenceAt(lines[i]);
    if (fence) {
      const marker = fence[1];
      const closes = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[\\t ]*$`);
      const language = fence[2].trim().split(/\s+/)[0];
      const start = ++i;
      while (i < lines.length && !closes.test(lines[i])) i++;
      // Keep the newline before a closing fence, and every character of an
      // unfinished stream. The opening/closing fence lines are not code.
      const code = lines.slice(start, i).join("\n") + (i < lines.length && i > start ? "\n" : "");
      blocks.push(<ChatCode key={key} code={code} language={language || undefined} />);
      if (i < lines.length) i++;
      continue;
    }

    const heading = HEADING.exec(lines[i]);
    if (heading) {
      const Tag = heading[1].length <= 2 ? "h2" : heading[1].length === 3 ? "h3" : "h4";
      blocks.push(<Tag key={key}>{inline(heading[2].replace(/[\t ]+#+[\t ]*$/, "").trimEnd())}</Tag>);
      i++;
      continue;
    }

    if (RULE.test(lines[i])) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }

    if (tableAt(lines, i)) {
      const head = tableCells(lines[i]).slice(0, MAX_COLUMNS);
      const align = tableCells(lines[i + 1]).slice(0, MAX_COLUMNS).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !startsBlock(lines[i])) rows.push(tableCells(lines[i++]));
      blocks.push(<Table key={key} head={head} align={align} rows={rows} />);
      continue;
    }

    const list = LIST_ITEM.exec(lines[i]);
    if (list) {
      const ordered = list[2] !== undefined;
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i]);
        if (!item || (item[2] !== undefined) !== ordered) break;
        const itemKey = i++;
        const content = [item[3]];
        // Wrapped list text is common in transcripts. Other block markers
        // always end this item rather than being swallowed as continuation.
        while (i < lines.length && /^[\t ]{2,}\S/.test(lines[i]) && !startsBlock(lines[i])) {
          content.push(lines[i++].trimStart());
        }
        items.push(<li key={itemKey}>{inline(content.join("\n"))}</li>);
      }
      blocks.push(ordered
        ? <ol key={key} start={Number(list[2]) === 1 ? undefined : Number(list[2])}>{items}</ol>
        : <ul key={key}>{items}</ul>);
      continue;
    }

    if (QUOTE.test(lines[i])) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const quote = QUOTE.exec(lines[i]);
        if (!quote) break;
        quoted.push(quote[1]);
        i++;
      }
      blocks.push(<blockquote key={key}>{quoted.join("\n").split(/\n[\t ]*\n/).map((paragraph, j) => (
        <p key={j}>{inline(paragraph)}</p>
      ))}</blockquote>);
      continue;
    }

    const paragraph = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !tableAt(lines, i)) paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }

  return <div className="chat-markdown">{blocks}</div>;
}
