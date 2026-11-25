// What a tool row says about its answer: what it counted ("182 lines"), how a
// command ended (an exit chip, or Interrupted), one line of what it printed
// while the row is closed, and the output itself once it is opened, with how
// much of it is left out. And the head of a run of calls, summed up by kind.
import { useT } from "../../i18n";
import type { ChatOutput, ChatTurn } from "./chat-model";
import { exitState, isCommand, linesLeft, outputPreview, statText, workSummary } from "./chat-rich";
import "./chat-rich.css";

type Tool = Extract<ChatTurn, { kind: "tool" }>;

/** The row's own figures and chips, drawn after its argument: what the
 *  answer counted, then how a command ended. A failed command with an exit
 *  code wears its code where "Failed" would be. */
export function ToolFacts({ turn }: { turn: Tool }) {
  const t = useT();
  const stat = turn.note ? "" : statText(turn.stat, t);
  const state = exitState(turn);
  return <>
    {stat && <span className="chat-tool-note chat-tool-stat">{stat}</span>}
    {state === "interrupted" && <span className="chat-exit" data-state="interrupted">{t("board.chat.notice.interrupted")}</span>}
    {(state === "ok" || state === "failed") && (
      <span className="chat-exit" data-state={state} title={t("board.chat.rich.exitTitle", { code: turn.exit! })}>
        {t("board.chat.rich.exit", { code: turn.exit! })}
      </span>
    )}
  </>;
}

/** Whether the row's "Failed" is said by its exit chip instead. */
export const failedByExit = (turn: Tool) => turn.error !== undefined && exitState(turn) === "failed";

/** One line of a command's output, under its closed row; nothing for any other call. */
export function ToolPreview({ turn }: { turn: Tool }) {
  const line = !turn.running && isCommand(turn) ? outputPreview(turn.output) : "";
  return line ? <span className="chat-tool-preview" aria-hidden="true">{line}</span> : null;
}

/** The output, wrapped and scrolled inside itself, and how much was left out. */
export function ToolOutputBlock({ output }: { output: ChatOutput }) {
  const t = useT();
  const left = linesLeft(output);
  return <>
    {output.text && <pre className="chat-tool-output" aria-label={t("board.chat.rich.output")}><code>{output.text}</code></pre>}
    {output.cut && <p className="chat-tool-output-cut">{left > 0 ? t("board.chat.rich.outputCut", { count: left }) : t("board.chat.rich.outputTrimmed")}</p>}
  </>;
}

/** "Ran 3 commands · read 2 files · edited 1 file": a run of calls by kind. */
export function WorkSummary({ turns }: { turns: readonly ChatTurn[] }) {
  const t = useT();
  return <span className="chat-work">{workSummary(turns, t)}</span>;
}
