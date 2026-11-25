// When things were said, kept out of the way: the time a message was sent,
// with its Copy, on a row that shows while the pointer or the keys are on the
// message; and at the end of an answer, how long the work took and when it
// ended ("Worked for 1m 27s · 15:56"). Times are the reader's own clock; the
// whole date is in the title.
import { useT } from "../../i18n";
import { CopyButton } from "./ChatCode";
import { clockText, durationText, fullTime, type BlockTime } from "./chat-rich";
import "./chat-rich.css";

/** A time of day as a <time>, with the whole date in its title. */
export function Clock({ at, className }: { at: number; className?: string }) {
  return <time className={className} dateTime={new Date(at).toISOString()} title={fullTime(at)}>{clockText(at)}</time>;
}

/** Under your message: when you sent it, and Copy. */
export function MessageMeta({ at, text }: { at?: number; text: string }) {
  const t = useT();
  if (at === undefined && !text) return null;
  return (
    <div className="chat-meta">
      {at !== undefined && <Clock at={at} />}
      {text && <CopyButton text={text} label={t("board.chat.rich.copyMessage")} className="chat-meta-copy" />}
    </div>
  );
}

/** The quiet line an answer ends on. */
export function TurnFooter({ time }: { time: BlockTime }) {
  const t = useT();
  return (
    <p className="chat-turn-foot">
      {time.worked !== undefined && time.worked >= 1000 && <><span>{t("board.chat.rich.worked", { time: durationText(time.worked, t) })}</span><span aria-hidden="true"> · </span></>}
      <Clock at={time.end} />
    </p>
  );
}
