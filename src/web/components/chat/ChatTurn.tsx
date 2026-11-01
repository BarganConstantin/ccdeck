// The pieces of a conversation, one per kind of line (the kit's Chat parts):
// what you typed, what the assistant said, a tool call, the record of an
// answer, and the divider that says what happened since you looked.
//
// NEW LINES APPEAR WITH NO MOTION. A line is drawn where it belongs and that is
// all; there is no entrance, no highlight, no scroll animation.
import {
  ChevronRightGlyph, FileGlyph, SearchGlyph, ToolTerminalGlyph,
} from "./chat-icons";
import type { ChatSince, ChatTurn as Turn } from "./chat-model";

export function YourMessage({ text }: { text: string }) {
  return <div className="chat-you"><p className="chat-you-text">{text}</p></div>;
}

export function AssistantText({ text }: { text: string }) {
  return <p className="chat-said">{text}</p>;
}

const MARKS = { file: FileGlyph, search: SearchGlyph, terminal: ToolTerminalGlyph } as const;

export function ToolRow({ turn }: { turn: Extract<Turn, { kind: "tool" }> }) {
  const Mark = MARKS[turn.mark ?? (turn.name === "Bash" ? "terminal" : turn.name === "Explore" ? "search" : "file")];
  return (
    <div className="chat-tool" data-running={turn.running || undefined}>
      <span className="chat-tool-chev"><ChevronRightGlyph /></span>
      <span className="chat-tool-mark"><Mark /></span>
      <span className="chat-tool-name">{turn.name}</span>
      <span className="chat-tool-arg">{turn.arg}</span>
      {turn.note && <span className="chat-tool-note">{turn.note}</span>}
    </div>
  );
}

/** "You answered  1 · Yes, run it  ·  6m 42s after it asked": the text is the
 *  host's, spaces and all, and is drawn as given. */
export function RecordLine({ text }: { text: string }) {
  return <p className="chat-record">{text}</p>;
}

/** "Since you looked · 4 tool calls · now asking". */
export function sinceText(since: ChatSince): string {
  const calls = `${since.toolCalls} tool ${since.toolCalls === 1 ? "call" : "calls"}`;
  return `Since you looked · ${calls} · ${since.label}`;
}

export function SinceDivider({ since }: { since: ChatSince }) {
  return (
    <div className="chat-since" role="separator" aria-label={sinceText(since)}>
      <span className="chat-since-line" aria-hidden="true" />
      <span className="chat-since-text" aria-hidden="true">{sinceText(since)}</span>
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
