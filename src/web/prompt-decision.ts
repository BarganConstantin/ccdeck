// The Decision card for a permission prompt or a plan approval Claude Code
// shows: the rows are the screen's (screen-prompt.ts), what it asks about is
// the transcript's (the call still waiting). Pure: a prompt and the turns in,
// the card's model out.
//
// THE TITLE NAMES THE CALL. One call waits: a command (Bash) is "Allow this
// command?" with the command in mono; an edit (Edit, Write, MultiEdit,
// NotebookEdit) is "Allow this edit?" with its file; any other tool is
// "Allow {tool}?". Several calls wait, a sub-agent runs (its own calls are not
// in the transcript), or none can be told: "Allow this step?" with no line in
// mono, since the card cannot say which one the prompt is for.
//
// A PLAN IS READ IN THE CONVERSATION. The plan card above the Decision card
// draws the plan's Markdown, so this card only says where it is, or, when the
// call carried no plan, that it is in Term.
import { t as tNow, type TFunction } from "./i18n";
import type { ChatTurn } from "./components/chat/chat-model";
import type { DecisionModel, DecisionOptionModel } from "./components/decision/decision-model";
import { promptId, rowRole, type ScreenPrompt } from "./screen-prompt";

const COMMAND_TOOL = "Bash";
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type ToolTurn = Extract<ChatTurn, { kind: "tool" }>;
type PlanTurn = Extract<ChatTurn, { kind: "plan" }>;

/** The tool calls still waiting in the transcript. */
function waitingTools(turns: readonly ChatTurn[]): ToolTurn[] {
  return turns.filter((turn): turn is ToolTurn => turn.kind === "tool" && !!turn.running);
}

/** The plan still waiting for an answer, the last one. */
function waitingPlan(turns: readonly ChatTurn[]): PlanTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.kind === "plan" && turn.running) return turn;
  }
  return undefined;
}

/** Whether the transcript says Claude may be at a prompt: a call, a plan or a
 *  sub-agent waits (a sub-agent's own calls ask too), and no question card
 *  waits (that one is answered on its own card). */
export function mayPrompt(turns: readonly ChatTurn[]): boolean {
  if (turns.some(turn => turn.kind === "ask" && turn.running)) return false;
  return turns.some(turn => (turn.kind === "tool" || turn.kind === "plan" || turn.kind === "agent") && !!turn.running);
}

/** The Decision card for `prompt`, read with the transcript's `turns`. */
export function promptDecision(prompt: ScreenPrompt, turns: readonly ChatTurn[], session: string, t: TFunction = tNow): DecisionModel {
  if (prompt.kind === "plan") {
    const plan = waitingPlan(turns);
    return {
      id: promptId(prompt),
      kind: "plan",
      title: t("board.decision.title.plan"),
      caption: plan?.text ? t("board.decision.planCaption") : t("board.decision.planInTerm"),
      options: prompt.options.map(label => planRow(label, t)),
      origin: "launched",
      session,
    };
  }
  const tools = waitingTools(turns);
  // A sub-agent still running may be the one asking, about a call of its own
  // the transcript does not show: then no one call can be named.
  const agent = turns.some(turn => turn.kind === "agent" && turn.running);
  const one = tools.length === 1 && !agent ? tools[0] : undefined;
  const command = one?.name === COMMAND_TOOL;
  const title = !one ? t("board.decision.title.step")
    : command ? t("board.decision.title.command")
    : EDIT_TOOLS.has(one.name) ? t("board.decision.title.edit")
    : t("board.decision.title.tool", { tool: one.name });
  return {
    id: `${promptId(prompt)}\n${one ? `${one.name}\n${one.arg}` : ""}`,
    kind: "permission",
    title,
    ...(one?.arg ? { command: one.arg } : null),
    caption: prompt.question,
    options: prompt.options.map(label => permissionRow(label, command, t)),
    origin: "launched",
    session,
  };
}

function permissionRow(label: string, command: boolean, t: TFunction): DecisionOptionModel {
  if (rowRole("permission", label) === "locked") return { label, sub: "", locked: true, lockNote: t("board.decision.lock.rules") };
  if (/^Yes$/.test(label)) return { label, sub: t("board.decision.sub.once"), ...(command ? { runs: true } : null) };
  return { label, sub: t("board.decision.sub.no"), cancel: true };
}

function planRow(label: string, t: TFunction): DecisionOptionModel {
  const role = rowRole("plan", label);
  if (role === "words") return { label, sub: t("board.decision.sub.keepPlanning"), free: true };
  if (role === "answer") return { label, sub: t("board.decision.sub.manual") };
  return { label, sub: "", locked: true, lockNote: /^Yes\b/.test(label) ? t("board.decision.lock.mode") : t("board.decision.onlyTerm") };
}
