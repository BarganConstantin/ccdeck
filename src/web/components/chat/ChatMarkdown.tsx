import { Fragment, type ReactNode } from "react";
import { parseInline, type Inline } from "../../inline-markdown";

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[\t ]+(.+)$/;
const LIST_ITEM = /^ {0,3}(?:([-+*])|([0-9]{1,9})[.)])[\t ]+(.*)$/;
const QUOTE = /^ {0,3}>[\t ]?(.*)$/;

function fenceAt(line: string) {
  const match = FENCE.exec(line);
  // A backtick in a backtick fence's info string is ordinary prose.
  return match && !(match[1][0] === "`" && match[2].includes("`")) ? match : null;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    if (node.kind === "code") return <code key={i}>{node.text}</code>;
    if (node.kind === "bold") return <strong key={i}>{renderInline(node.kids)}</strong>;
    return <Fragment key={i}>{node.text.split("\n").map((line, j) => (
      <Fragment key={j}>{j > 0 && <br />}{line}</Fragment>
    ))}</Fragment>;
  });
}

const inline = (text: string) => renderInline(parseInline(text));
const startsBlock = (line: string) => fenceAt(line) || HEADING.test(line) || LIST_ITEM.test(line) || QUOTE.test(line);

/** A small transcript subset: block structure, bold and inline code. Links and
 *  raw HTML deliberately stay literal; all content goes through React text. */
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
      blocks.push(<pre key={key}><code data-language={language || undefined}>{code}</code></pre>);
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
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }

  return <div className="chat-markdown">{blocks}</div>;
}
