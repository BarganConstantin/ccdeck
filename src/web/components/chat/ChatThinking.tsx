// The assistant's thinking: one quiet row, "Thought for 6s" (or "Thought"
// when the transcript does not tell how long), that opens what it thought,
// dimmed, when the transcript keeps the text. A block whose text was left out
// is the row alone, with nothing to open.
import { useId, useState } from "react";
import { useT } from "../../i18n";
import { ChevronRightGlyph } from "./chat-icons";
import { KitIcon } from "../kit-icons";
import ChatMarkdown from "./ChatMarkdown";
import type { ChatTurn } from "./chat-model";
import { durationText } from "./chat-rich";
import "./chat-rich.css";

type Thinking = Extract<ChatTurn, { kind: "thinking" }>;

export function thinkingLabel(turn: Thinking, t: ReturnType<typeof useT>): string {
  return turn.took !== undefined ? t("board.chat.rich.thoughtFor", { time: durationText(turn.took, t) }) : t("board.chat.rich.thought");
}

export default function ThinkingRow({ turn }: { turn: Thinking }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const label = thinkingLabel(turn, t);
  const mark = <span className="chat-tool-mark"><KitIcon name="thinking" /></span>;
  if (!turn.text) {
    return <div className="chat-tool chat-thinking" data-empty="">{mark}<span className="chat-thinking-label">{label}</span></div>;
  }
  return (
    <div className="chat-tool-call">
      <button type="button" className="chat-tool chat-tool-toggle chat-thinking" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen(was => !was)}>
        <span className="chat-disclosure"><ChevronRightGlyph /></span>
        {mark}
        <span className="chat-thinking-label">{label}</span>
      </button>
      {open && (
        <div className="chat-thinking-text" id={id}>
          <ChatMarkdown text={turn.text} />
          {turn.cut && <p className="chat-tool-output-cut">{t("board.chat.rich.thinkingCut")}</p>}
        </div>
      )}
    </div>
  );
}
