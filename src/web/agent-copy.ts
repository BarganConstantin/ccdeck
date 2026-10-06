// What the deck says about an agent, in words — the ones on its card and the
// ones every other surface that describes the same agent borrows from it.
//
// These lived in AgentNode.tsx, beside the card that first said them, and the
// session list, the hover peek, the topbar readouts, the usage panel's session
// rows and the canvas's accessible names each imported a React Flow component
// to get a sentence. The words are pure — a state, a block, a node's data in
// and a string out — so they are here, where a surface can take one without
// the card behind it, and where a test can run them without React.
import type { AgentNodeData, WaitingBlock } from "./types";
import { fmtCost } from "./pricing";
import { agentCost, agentUnpricedTokens } from "./usage-models";
import { shortModel } from "./model-label";
import { guessLine } from "./notify";
import { isAlarming } from "./ambient-counts";

/** The one word this app uses for a session's state, wherever it says it.
 *
 *  It was inline in StatePill until #373, where the session list and the usage
 *  panel gained a spoken copy of the same fact — their dot carries the state
 *  and a dot cannot be read aloud. Two ternaries would have been two
 *  vocabularies waiting to disagree: a card that says `live` beside a row that
 *  says `running` is one state with two names, and a reader who uses both
 *  surfaces has to learn that they mean the same thing. Same argument, and the
 *  same shape, as waitingSentence below.
 *
 *  `err` rather than `failed` even in text nobody sees, for that reason exactly
 *  — it is the word on the card, so it is the word in the row. */
export function stateLabel(state: AgentNodeData["state"]): string {
  return state === "active" ? "live" : state === "done" ? "done" : "err";
}

/** What a blocked session says for itself, on the card, in the row and in the
 *  topbar's tooltip. CC's own sentence wherever there is one — the payload has
 *  no tool_name and no tool_input, so it is the entire truth we hold about the
 *  block, and paraphrasing it would only add a claim we cannot back. The
 *  fallback is what stops a re-wording upstream, or an older log line with no
 *  message at all, from rendering a coloured row that says nothing. One
 *  function so the three surfaces cannot drift apart, the way shortModel — now
 *  in model-label.ts, imported at the top of this file — is one for the same
 *  reason. */
export function waitingSentence(waiting: WaitingBlock): string {
  if (waiting.message) return waiting.message;
  // The fallbacks only ever show for a block whose payload carried no message,
  // which CC does not currently produce. `asked` shares idle's wording rather
  // than getting a third string: what distinguishes it is the QUESTION, and a
  // block that lost its message has no question to show.
  return waiting.kind === "permission" ? "Needs your permission" : "Waiting for your input";
}

/** The hover text on a card's → N badge: how many subagents the session has
 *  spawned, singular for one (#1776). */
export function spawnBadgeTitle(count: number): string {
  return `${count} subagent${count === 1 ? "" : "s"} spawned`;
}

/** What a screen reader says for a card (#853). React Flow names a node from
 *  its content when it is given no `ariaLabel`, so a card was heard as its
 *  whole text run together — "liveagents-deck?1622m 12ssession…", a median of
 *  89 characters — and at the far zoom tier, where the details are
 *  `visibility: hidden`, the same card suddenly announced as three words. This
 *  is composed from the data instead, so it does not change with zoom, and it
 *  says the things a reader chooses a card by, in the card's own words: name,
 *  kind, the state pill, the waiting sentence, model, tools, failures, cost. */
export function agentAriaLabel(data: AgentNodeData & { nameTail?: string }, now: number = Date.now(), selected = false, git: string | null = null): string {
  // Over the agent's whole life, like the card's "err" (#1809).
  const failed = data.toolErrorCount ?? 0;
  const cost = agentCost(data, now).total;
  return [
    // A subagent's title carries its key's tail beside a teammate of its type,
    // as the collision warnings that name it do (canvas-flow.ts).
    data.nameTail ? `${data.label} · ${data.nameTail}` : data.label,
    data.kind === "root" ? "session" : "subagent",
    stateLabel(data.state),
    isAlarming(data.waiting) ? waitingSentence(data.waiting!) : null,
    // A file another live agent also edited, as the card's mark says it — the
    // one git fact the zoomed-out face keeps (git-card-mark.ts).
    git,
    data.model ? shortModel(data.model) : null,
    `${data.toolCount} ${data.toolCount === 1 ? "tool" : "tools"}`,
    failed > 0 ? `${failed} failed` : null,
    cost > 0 ? `${fmtCost(cost)}${agentUnpricedTokens(data, now) > 0 ? "+" : ""}` : null,
    selected ? "selected" : null,
  ].filter(Boolean).join(", ");
}

/** The same guess, worded for a surface with room to hedge — and worded against
 *  the sentence it will sit under.
 *
 *  "Likely" is not padding and does not come out. The deck infers this from
 *  where the notification sat in the stream rather than from anything CC said
 *  (types.ts spells out why), so a surface that prints it flat is claiming more
 *  than the deck knows — and the one place a user would catch the deck lying is
 *  the place they are deciding whether to approve a command.
 *
 *  `guessLine` — the one wording function, in notify.ts — because the tooltip
 *  prints CC's
 *  sentence directly above this, and that sentence usually already names the
 *  tool: "…to use Bash" over "Likely on: Bash · rm -rf" repeats a word and
 *  pushes the command further from the eye. The notification body had this
 *  fixed first and the tooltip did not, which left the same block reading two
 *  different ways depending on where you saw it. One rule, both surfaces. */
export function blockedToolTooltip(waiting: WaitingBlock, said: string): string | null {
  const label = guessLine(waiting, said);
  return label ? `Likely on: ${label}` : null;
}

/** The visible label, which is CC's sentence for a permission block and a
 *  quieter one for an idle block.
 *
 *  "Claude is waiting for your input" is accurate and reads as an emergency,
 *  and it is the kind that fires most — three of every four blocks on this
 *  machine's log. What it actually describes is a turn that ended and has not
 *  been picked back up, sitting on a node that already reads `done` two columns
 *  away. So the visible half says whose move it is and the verbatim sentence
 *  stays in the tooltip, where it is still the only human wording the payload
 *  gives us and still exactly what CC said. A permission block is genuinely
 *  urgent and keeps its sentence untouched. */
export function waitingLabel(waiting: WaitingBlock): string {
  // The sentence for both alarming kinds, "Your turn" only for idle. An `asked`
  // block's message IS the question — "paycore needs your input: merge both
  // branches to main, or just one?" — which is the single most useful string
  // this card can carry, and "Your turn" would throw it away on the one surface
  // with room for it. Idle keeps the short label because CC's sentence there is
  // the contentless "Claude is waiting for your input".
  return waiting.kind === "idle" ? "Your turn" : waitingSentence(waiting);
}
