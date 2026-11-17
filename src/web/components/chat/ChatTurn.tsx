// The pieces of a conversation, one per kind of line (the kit's Chat parts):
// what you typed, what the assistant said, a tool call, the record of an
// answer, and the divider that says what happened since you looked.
//
// NEW LINES APPEAR WITH NO MOTION. A line is drawn where it belongs and that is
// all; there is no entrance, no highlight, no scroll animation.
import {
  ChevronRightGlyph, FileGlyph, SearchGlyph, ToolTerminalGlyph,
} from "./chat-icons";
import { t as tNow, useT, type TFunction } from "../../i18n";
import type { ChatSince, ChatTurn as Turn } from "./chat-model";
import ProviderAvatar from "../ProviderAvatar";
import ChatMarkdown from "./ChatMarkdown";
import { useEffect, useState } from "react";
import { copyText } from "../../copy-text";
import { CopyGlyph } from "../terminal/stage-icons";

export function YourMessage({ text }: { text: string }) {
  const t = useT();
  return <div className="chat-you"><span className="chat-author">{t("board.chat.you")}</span><p className="chat-you-text">{text.replace(/\r\n?/g, "\n")}</p></div>;
}

export function AssistantText({ text }: { text: string }) {
  return <div className="chat-said"><ChatMarkdown text={text} /></div>;
}

const MARKS = { file: FileGlyph, search: SearchGlyph, terminal: ToolTerminalGlyph } as const;

export function ToolRow({ turn }: { turn: Extract<Turn, { kind: "tool" }> }) {
  const Mark = MARKS[turn.mark ?? (turn.name === "Bash" ? "terminal" : turn.name === "Explore" ? "search" : "file")];
  const content = <>
    <span className="chat-tool-mark"><Mark /></span>
    <span className="chat-tool-name">{turn.name}</span>
    <span className="chat-tool-arg" title={turn.arg}>{turn.arg}</span>
    {turn.note && <span className="chat-tool-note">{turn.note}</span>}
  </>;
  if (!turn.arg) return <div className="chat-tool" data-running={turn.running || undefined}>{content}</div>;
  return (
    <details className="chat-tool-call">
    <summary className="chat-tool" data-running={turn.running || undefined}>
      <span className="chat-disclosure"><ChevronRightGlyph /></span>
      {content}
    </summary>
    <pre className="chat-tool-input"><code>{turn.arg}</code></pre>
    </details>
  );
}

/** The disclosure contains the actual calls; it never implies unseen output. */
export function ToolGroup({ turns }: { turns: Extract<Turn, { kind: "tool" }>[] }) {
  const t = useT();
  const running = turns.some(turn => turn.running);
  return <details className="chat-activity" open={running || undefined}>
    <summary className="chat-activity-head">
      <span className="chat-disclosure"><ChevronRightGlyph /></span>
      <span>{t("board.chat.tools", { count: turns.length })}</span>
      {running && <span className="chat-activity-running">{t("board.chat.running")}</span>}
    </summary>
    <div className="chat-activity-calls">{turns.map((turn, i) => <ToolRow key={i} turn={turn} />)}</div>
  </details>;
}

/** Chat currently reads Claude transcripts only. Identify each response once. */
export function AssistantBlock({ turns }: { turns: Turn[] }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const answer = turns.filter((turn): turn is Extract<Turn, { kind: "assistant" }> => turn.kind === "assistant").map(turn => turn.text).join("\n\n");
  useEffect(() => setCopied(false), [answer]);
  const parts: { index: number; turns: Turn[] }[] = [];
  turns.forEach((turn, index) => {
    const last = parts.at(-1);
    if (turn.kind === "tool" && last?.turns[0]?.kind === "tool") last.turns.push(turn);
    else parts.push({ index, turns: [turn] });
  });
  return <section className="chat-response" aria-label="Claude Code">
    <div className="chat-response-author"><ProviderAvatar provider="claude" /><span>Claude Code</span>
      {answer && <button type="button" className="glyph-btn chat-copy" title={t(copied ? "board.stage.copied" : "board.stage.copy")}
        aria-label={t(copied ? "board.stage.copied" : "board.stage.copy")}
        onClick={() => { void copyText(answer).then(ok => setCopied(ok)); }}><CopyGlyph /></button>}
    </div>
    <div className="chat-response-content">{parts.map(part => {
      const first = part.turns[0];
      return first.kind === "tool"
        ? <ToolGroup key={part.index} turns={part.turns as Extract<Turn, { kind: "tool" }>[]} />
        : <TurnRow key={part.index} turn={first} />;
    })}</div>
  </section>;
}

/** "You answered  1 · Yes, run it  ·  6m 42s after it asked": the text is the
 *  host's, spaces and all, and is drawn as given. */
export function RecordLine({ text }: { text: string }) {
  return <p className="chat-record">{text}</p>;
}

/** "Since you looked · 4 tool calls · now asking". */
export function sinceText(since: ChatSince, t: TFunction = tNow): string {
  return t("board.chat.since", { count: since.toolCalls, label: since.label });
}

export function SinceDivider({ since }: { since: ChatSince }) {
  const text = sinceText(since, useT());
  return (
    <div className="chat-since" role="separator" aria-label={text}>
      <span className="chat-since-line" aria-hidden="true" />
      <span className="chat-since-text" aria-hidden="true">{text}</span>
      <span className="chat-since-line" aria-hidden="true" />
    </div>
  );
}

export function TurnRow({ turn }: { turn: Turn }) {
  switch (turn.kind) {
    case "user": return <YourMessage text={turn.text} />;
    case "assistant": return <AssistantText text={turn.text} />;
    case "tool": return <ToolRow turn={turn} />;
    case "record": return <RecordLine text={turn.text} />;
  }
}
