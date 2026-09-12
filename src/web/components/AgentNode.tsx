import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { sessionHue } from "../reducer";
import { billedInputTokens, cacheWriteBreakdown, costForUsage, fmtCost, fmtCostRate, ratesForModel, UNPRICED_LABEL } from "../pricing";
// Tokens are priced at the model that produced them. See usage-models.ts for
// what the last-wins multiplication this replaces was measured to cost (#686).
import { agentCost, agentUnpricedTokens, otherModelIds, usageByModelEntries, type UsageBearing } from "../usage-models";
import { codexApprovalTell } from "../codex-approval";
// The chip's labeller, which used to be declared in this file and moved out in
// #462 so that a pure matcher and a bare-node suite could reach it without a
// React component behind it. See model-label.ts for why the move happened with
// that fix rather than with #374's wider consolidation.
import { shortModel, modelFamily } from "../model-label";
import { guessLine } from "../notify";
import { isAlarming } from "../ambient-counts";
// The card's token count, which used to be a private three-tier `fmtTok` here —
// byte-identical to the two copies #323 deleted, and the fourth one it missed
// (#374). See token-format.ts for the tier it did not have.
import { fmtTokens } from "../token-format";
// The card's elapsed clock, which used to be declared in this file and which
// the detail panel wrote out again, one tier short. See duration.ts.
import { elapsed } from "../duration";
// Which naming record reaches the face of the card and which stays in the
// tooltip. Shared with the cluster header rather than decided twice, because
// the column cap in #521 is only sound while both surfaces show the same field.
import { sessionDisplay } from "../session-display";
import { ContextDonut } from "./ContextModal";

/** Multi-line breakdown for the cost chip tooltip — shows the actual
 *  multiplication so the user can verify pricing is sane.
 *  e.g. "input  725 × $5/M     = $0.00"
 *
 *  Every row must multiply out to the figure printed beside it, and the rows
 *  must sum to the total: this tooltip exists only to be checked by hand, so a
 *  row whose operands don't produce its own result is worse than no row. */
export function costBreakdownTooltip(usage: TokenUsage, modelId: string | undefined): string {
  const rates = ratesForModel(modelId);
  // This branch was unreachable until #400: the only element carrying this
  // tooltip was gated on the same ratesForModel call that returns null here, so
  // the graceful answer existed and could never be read. It names the model now
  // because that is the one thing the reader needs in order to act on it — the
  // sentence is otherwise a claim about nothing, and the id is what goes in the
  // issue asking for the row.
  if (!rates) {
    return `model: ${modelId}\nno published rate in this build — the tokens are counted, the dollars are not`;
  }
  const fmtN = (n: number) => n.toLocaleString();
  const fmtR = (r: number) => `$${r}/MTok`;
  const c = costForUsage(usage, modelId);
  const cw = cacheWriteBreakdown(usage, rates);
  // Cache writes are billed per TTL — 2× input for a 1-hour entry, 1.25× for a
  // 5-minute one — so once a transcript reports both, one multiplication can't
  // reproduce the total the chip shows. Split the row rather than print a
  // product that doesn't check out.
  const cacheWriteRows = cw.tokens1h > 0
    ? [
        `cache w5m${fmtN(cw.tokens5m).padStart(14)}  × ${fmtR(rates.cacheWrite).padEnd(11)} = ${fmtCost(cw.usd5m)}`,
        `cache w1h${fmtN(cw.tokens1h).padStart(14)}  × ${fmtR(rates.cacheWrite1h ?? rates.cacheWrite).padEnd(11)} = ${fmtCost(cw.usd1h)}`,
      ]
    : [`cache w  ${fmtN(cw.tokens5m).padStart(14)}  × ${fmtR(rates.cacheWrite).padEnd(11)} = ${fmtCost(cw.usd5m)}`];
  // Codex reports a single `input_tokens` that already contains the cached
  // prefix, and only the remainder is billed at the input rate — so the raw
  // count printed here disagreed with its own dollar column by ~10x on a
  // multi-turn session. Print the tokens the rate is applied to, and relabel
  // the row when that differs from what the agent reported so the missing
  // tokens are visibly the ones on the cache-read line below.
  const inputTokens = billedInputTokens(usage, modelId);
  const inputLabel = inputTokens === usage.inputTokens ? "input" : "uncached";
  return [
    `model: ${modelId}`,
    `${inputLabel.padEnd(9)}${fmtN(inputTokens).padStart(14)}  × ${fmtR(rates.input).padEnd(11)} = ${fmtCost(c.input)}`,
    `output   ${fmtN(usage.outputTokens).padStart(14)}  × ${fmtR(rates.output).padEnd(11)} = ${fmtCost(c.output)}`,
    `cache r  ${fmtN(usage.cacheReadTokens).padStart(14)}  × ${fmtR(rates.cacheRead).padEnd(11)} = ${fmtCost(c.cacheRead)}`,
    ...cacheWriteRows,
    `─────────────────────────────────────────`,
    `total                                 = ${fmtCost(c.total)}`,
  ].join("\n");
}

/** The same tooltip for a whole agent, one section per model its tokens came
 *  from (#686).
 *
 *  One section is the common case and renders byte-identically to what this card
 *  has always shown — a session on one model has one rate card, and a footer
 *  under a single block would be arithmetic about nothing. Two or more sections
 *  earn the footer, because that line is the only place on the card where the
 *  figure in the chip can be checked by hand: neither block's own total is it,
 *  and without the footer a reader has no way to see that the two were added
 *  rather than one of them chosen — which is precisely the mistake this whole
 *  change is about. */
function agentCostTooltip(a: UsageBearing): string {
  const entries = usageByModelEntries(a);
  if (entries.length <= 1) return costBreakdownTooltip(a.usage, a.model);
  return [
    ...entries.map(e => costBreakdownTooltip(e.usage, e.model)),
    `═════════════════════════════════════════`,
    `all models                            = ${fmtCost(agentCost(a).total)}`,
  ].join("\n");
}
import type { AgentNodeData, TokenUsage, ToolCall, WaitingBlock } from "../types";

export default function AgentNode({ data, selected }: NodeProps<AgentNodeData & { now: number; onOpenContext?: (sessionId: string) => void }>) {
  const now = data.now ?? Date.now();
  const cls = [
    "agent-node",
    `state-${data.state}`,
    data.synthetic ? "synthetic" : "",
    selected ? "selected" : "",
  ].filter(Boolean).join(" ");

  const inflight = data.tools.filter(t => !t.endedAt).length;
  // WHAT WENT WRONG, KEPT. The only place a failed tool call was ever drawn is
  // the burst bubble, and that layer holds four per agent and then drops the
  // oldest — so a failure was visible for four more calls and then existed
  // nowhere on the canvas. The card counts them instead, in the shape the
  // in-flight count already uses, and the count does not expire. Silent at
  // zero, like the in-flight one: a session with nothing wrong says nothing.
  const failed = data.tools.filter(t => t.ok === false).length;
  const hue = sessionHue(data.sessionId);
  const currentContextTokens = data.context?.currentContextTokens ?? 0;
  const hasContextSignal = data.kind === "root" && currentContextTokens > 0;
  // The sentence Claude Code titles the session with, in the tooltip the card
  // already had. It reads like "Inspect repository to understand current state"
  // — far past what 260px of card can show, which is the whole reason it is
  // here and not on the face of the card. The cwd stays the first line because
  // that is what this tooltip has always answered. A Codex card, and a Claude
  // one whose transcript has no title record yet, get the cwd alone exactly as
  // before rather than a second line that says nothing.
  const cardTooltip = data.sessionTitle
    ? (data.cwd ? `${data.cwd}\n${data.sessionTitle}` : data.sessionTitle)
    : data.cwd;
  // What the model chip says when this session's money came from more than one
  // model (#686). The chip keeps naming the CURRENT model, because that is the
  // question it has always answered and the only one that is about what happens
  // next — `/model` changes what the next turn runs on, not what the last twenty
  // ran on. What it could not say before is that the dollars beside it are not
  // all that model's: `+1` says so on the face of the card, and the tooltip
  // names the others, so a reader who sees $7.50 under a Sonnet chip is not left
  // to conclude the deck priced a million Opus tokens at Sonnet's rate.
  const otherModels = otherModelIds(data);
  const modelChipTitle = otherModels.length > 0
    ? `${data.model}\nspend on this card also covers:\n${otherModels.join("\n")}`
    : data.model;
  // Two strings for the name row, chosen once. `face` is the name when the
  // session has one and the sentence when it does not, which is the common
  // case rather than the fallback: 0.2% of the transcripts on this machine
  // carry an agent-name and 4.1% carry an ai-title, and not one of them
  // carries a name without a title. See session-display.ts for the sweep.
  const naming = sessionDisplay(data.sessionName, data.sessionTitle);

  return (
    // --accent itself is built in styles.css from this hue: the token that
    // reads well on a #14161b node is not the one that reads on a white one,
    // and .tokens-meta / .spawn-badge are text.
    <div className={cls} style={{ "--session-hue": hue } as React.CSSProperties}>
      <span className="accent-stripe" />
      <Handle type="target" position={Position.Left} style={{ background: "transparent", border: "none" }} />

      <div className="head">
        <div className="title">
          <StatePill state={data.state} />
          <span className="label" title={cardTooltip}>{data.label}</span>
          {data.synthetic && <span className="synth-tag" title="No SessionStart captured — synthesised">?</span>}
        </div>
        <div className="head-right">
          {hasContextSignal && data.onOpenContext && (
            <ContextDonut
              currentContextTokens={currentContextTokens}
              modelId={data.model}
              contextWindow={data.contextWindow}
              onClick={() => data.onOpenContext!(data.sessionId)}
            />
          )}
          <div className="time" title={`Started ${new Date(data.startedAt).toLocaleTimeString()}`}>
            {elapsed(data.startedAt, data.endedAt, now)}
          </div>
        </div>
      </div>

      <div className="sub">
        {data.kind === "root" ? "session" : "subagent"}
        {data.childCount > 0 && (
          <span className="spawn-badge" title={`${data.childCount} subagents spawned`}>→ {data.childCount}</span>
        )}
        {data.cwdBasename && data.kind === "subagent" ? ` · ${data.cwdBasename}` : ""}
        {/* The chip README.md names as how the two CLIs are told apart, on the
            nodes that have no model to put in it (#404). `provider` has been
            carried on every node since Codex support landed and read by nothing
            in the UI, so a Claude and a Codex session in one repo were two cards
            separated by a session-id suffix and nothing else — and the model
            chip, the documented workaround, is absent on synthetic nodes, on
            subagents with no model event, and on every root before its first
            ModelObserved.

            Only "codex" falls back, deliberately. The reducer stamps "claude" as
            the DEFAULT for any event that names no provider — that is how events
            recorded before the field existed replay — so a "Claude Code" chip
            would print an assumption as an observation, on every model-less node
            of the commonest deck. A "codex" stamp is only ever set from a rollout
            this deck actually read. */}
        {data.model
          /* TINTED FROM THE MODEL, NOT FROM THE TOOLTIP. The sheet used to
             match `[title*="opus"]`, and since #686 this tooltip lists every
             model the card's spend covers — so a session that switched from
             Sonnet to Opus matched two equal-specificity rules and took the
             last one, drawing "Opus 5 +1" in Sonnet blue. */
          ? <span className="model-chip" data-family={modelFamily(data.model)} title={modelChipTitle}>
              {shortModel(data.model)}{otherModels.length > 0 ? ` +${otherModels.length}` : ""}
            </span>
          : data.provider === "codex"
            ? <span className="model-chip" title="OpenAI Codex — no model reported yet">Codex</span>
            : null}
      </div>

      {/* What Claude Code calls this session, on a row of its own for the
          reason the row below restates: the header is full at 260px, and the
          meta row above would have to ellipsis the model chip away to fit a
          slug that runs to 29 characters.

          The NAME when the session has one, the TITLE when it does not, and the
          same row either way. #520 drew the name alone, which measured across
          every transcript on this machine renders for 0.2% of them; the title
          reaches 4.1%, and 25.3% of the transcripts big enough to be a real
          session. There is no transcript here with a name and no title, so the
          title is not the degraded mode — for 96% of the sessions with anything
          to say at all it is the only record there is.

          Root only. Both records name a SESSION; a subagent has neither, and
          copying the parent naming onto every child would print the same string
          five times on one canvas.

          It does NOT replace the id. Both records are rewritten as the session
          moves and two sessions can hold the same one, so this is a
          description, not an address — the short id in the cluster header stays
          the thing that still means this node in five minutes. Mutable fact on
          the card, stable one on the frame around it.

          ABSENT rather than empty when there is neither: a Codex rollout
          carries no such record and a young Claude session has not been given
          one yet, so this row does not render for either and both keep exactly
          the shape they have today. */}
      {data.kind === "root" && naming.face && (
        <div className="session-name" title={naming.tooltip}>
          {naming.face}
        </div>
      )}

      {/* A row of its own rather than a chip in the title. The card is 260px
          wide and the header already spends it on the state pill, the workspace
          name and the elapsed clock; a fourth item there pushed the label to an
          ellipsis and still overflowed. A blocked session has earned a line. */}
      {data.waiting && <WaitingRow waiting={data.waiting} now={now} />}

      {/* The same slot, for the sessions that can never fill it (#398). A Codex
          session emits no notification and its rollout carries no approval
          record, so `data.waiting` is structurally always null here and this
          card, the sidebar, the topbar count, the tab title and the favicon are
          all silent whether or not the session is parked on a prompt.

          Rendering nothing let that silence read as "all clear", which is the
          one reading it cannot support. So the card says what it does not know,
          in the place the answer would have gone — the shape #416 gave a model
          with no published rate. It is deliberately NOT an inference that the
          session is blocked: codex-approval.ts holds why that inference is
          unsound and why nothing here reaches the alarm counters. It also stays
          quiet on the common case — a session at approval_policy "never" cannot
          be blocked at all — so it is rare enough to be worth reading. */}
      {(() => {
        const tell = codexApprovalTell(data);
        if (!tell) return null;
        return (
          <div className="approval-blind-row" title={tell.detail}>
            <span className="approval-blind-dot" aria-hidden />
            <span className="approval-blind-said">{tell.label}</span>
          </div>
        );
      })()}

      {(data.tools.length > 0 || (data.outputs?.length ?? 0) > 0) && (
        <ToolRateSpark tools={data.tools} outputs={data.outputs} now={now} />
      )}

      <div className="meta">
        <span><b>{data.toolCount}</b> tools</span>
        {failed > 0 && (
          <span className="failed-meta" title={`${failed} tool ${failed === 1 ? "call" : "calls"} returned an error`}>
            <b>{failed}</b> err
          </span>
        )}
        {inflight > 0 && <span className="inflight-meta"><b>{inflight}</b> in-flight</span>}
        {(data.usage.inputTokens + data.usage.outputTokens) > 0 && (
          <span className="tokens-meta" title={`in:${data.usage.inputTokens}  out:${data.usage.outputTokens}  cache-r:${data.usage.cacheReadTokens}  cache-c:${data.usage.cacheCreateTokens}${(data.usage.reasoningOutputTokens ?? 0) > 0 ? `  reasoning:${data.usage.reasoningOutputTokens}` : ""}`}>
            <b>{fmtTokens(data.usage.inputTokens + data.usage.outputTokens)}</b> tok
          </span>
        )}
        {data.model && (() => {
          // An unpriced model says so, in the slot the money would have used.
          // The gate here used to be `ratesForModel(data.model) &&`, which took
          // the whole element away the moment the lookup failed: a gpt-5.1-codex
          // card showed `412.3k tok` and then nothing, indistinguishable from a
          // session that had spent nothing, and the tooltip written for exactly
          // this case sat behind the failing call. The marker only appears once
          // there are tokens to price — a card with no usage yet has nothing to
          // be unpriced about, and would otherwise carry this the whole time it
          // was starting up.
          const rates = ratesForModel(data.model);
          const c = agentCost(data);
          // The two questions this branch asks have come apart (#686). `rates`
          // is about the model the card is ON — the one in the chip, the one the
          // next turn will use. `c.total` is about money already spent, which can
          // be real on a card whose current model has no published rate, and
          // zero on a card whose current model has one. So the marker is for the
          // agent with no priced spend AT ALL; an agent with some gets its
          // figure, and the `+` beside it says the figure is a floor because
          // some of its tokens reached no rate card — the same thing the "+" on
          // the usage panel's session rows has always meant.
          const unpricedTok = agentUnpricedTokens(data);
          if (!rates && c.total <= 0) {
            if ((data.usage.inputTokens + data.usage.outputTokens) <= 0) return null;
            return (
              <span className="cost-unpriced" title={agentCostTooltip(data)}>
                {UNPRICED_LABEL}
              </span>
            );
          }
          if (c.total <= 0) return null;
          const elapsedSec = Math.max(0, ((data.endedAt ?? now) - data.startedAt) / 1000);
          const rate = data.state === "active" ? fmtCostRate(c.total, elapsedSec) : null;
          const tt = agentCostTooltip(data) + (rate ? `\nburn: ${rate}` : "");
          // THE BURN RATE IS IN THE TOOLTIP AND NOWHERE ELSE NOW. The row is
          // flex, no-wrap, inside `overflow: hidden`, with 232px of content;
          // five items at 11px measure about 290px, so the live card — the one
          // case where a rate means anything — pushed its last item off the
          // right edge and said nothing about it. The rate was that item. It is
          // also derived from two figures printed 20px away, so of the five it
          // is the one whose removal costs a reader the least: the row now fits
          // in the state it used to break in, and the card loses a type size.
          return (
            <span className="cost-meta" title={tt}>
              <b>{fmtCost(c.total)}{unpricedTok > 0 ? "+" : ""}</b>
            </span>
          );
        })()}
      </div>

      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </div>
  );
}

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

function StatePill({ state }: { state: AgentNodeData["state"] }) {
  return <span className={`state-pill state-${state}`}>{stateLabel(state)}</span>;
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

/** The session is blocked on a human — and on which of the two chores that is.
 *  A dot alone would not carry it: a permission prompt is a decision a session
 *  cannot proceed without, an idle prompt is a finished turn waiting for your
 *  next instruction, and those are not the same errand. So the sentence carries
 *  it and the hue and the dot reinforce it — and only the permission variant
 *  pings: a stalled session is interrupt-driven and rare, which is the case a
 *  pulse is for, and a session that finished and is resting is neither. The
 *  ping is .ap-pulse, the emitter the accounts panel
 *  already uses, so the app keeps one idiom for "still asking" and one
 *  reduced-motion answer for it. */
function WaitingRow({ waiting, now }: { waiting: WaitingBlock; now: number }) {
  // The pulse and the amber belong to a session that is STOPPED until a human
  // answers, which is both `permission` and `asked` — the same set `isAlarming`
  // names, and it has to stay the same set or the card would contradict the
  // topbar chip beside it. Idle keeps the quiet dot: a finished turn is not an
  // interruption.
  const alarming = isAlarming(waiting);
  const said = waitingSentence(waiting);
  return (
    <div
      className={alarming ? "waiting-row permission" : "waiting-row idle"}
      title={`${said}\nBlocked for ${elapsed(waiting.since, undefined, now)} — the answer goes in the terminal, not here.`}
    >
      {alarming
        ? <span className="ap-pulse" aria-hidden />
        : <span className="waiting-dot" aria-hidden />}
      <span className="waiting-said">{waitingLabel(waiting)}</span>
      <b>{elapsed(waiting.since, undefined, now)}</b>
    </div>
  );
}

/** Sparkline of tool starts per bucket over the last 60s. Most-recent
 *  bucket lives on the right and is highlighted while it's the active one. */
/** The activity chart.
 *
 *  IT USED TO COUNT ONLY TOOL CALLS, and that is why a working card read as an
 *  idle one. Between a tool's result and the next tool's call the model is
 *  reading, reasoning and writing — 16.5% of measured time on this machine,
 *  more than the time spent inside the tools themselves — and the chart drew a
 *  flat line through all of it. A chart labelled `60s` on a card whose only
 *  other movement is a clock is the element a reader checks to answer "is this
 *  thing doing anything", and it was answering no while the answer was yes.
 *
 *  It counts both now. A tool call is one mark and a completed block of the
 *  model's own output is another, so the line moves whenever the session does
 *  and is flat only when the session genuinely is. */
function ToolRateSpark({ tools, outputs, now }: { tools: ToolCall[]; outputs?: number[]; now: number }) {
  const WINDOW_MS = 60_000;
  const BUCKETS = 24;
  const BUCKET_MS = WINDOW_MS / BUCKETS;
  const counts: number[] = new Array(BUCKETS).fill(0);
  let total = 0;
  const mark = (at: number) => {
    const age = now - at;
    if (age < 0 || age >= WINDOW_MS) return;
    const idx = BUCKETS - 1 - Math.floor(age / BUCKET_MS);
    if (idx >= 0 && idx < BUCKETS) {
      counts[idx] += 1;
      total += 1;
    }
  };
  for (const t of tools) mark(t.startedAt);
  for (const at of outputs ?? []) mark(at);
  // ONE SCALE FOR EVERY CARD ON THE CANVAS. This used to be
  // `Math.max(1, ...counts)` — each card normalised to its own busiest bucket,
  // so a session at one call per bucket and a session at twelve drew the
  // IDENTICAL chart. Two charts that cannot be told apart are not comparing
  // anything, and comparing sessions is the only reason a graph exists rather
  // than a list.
  //
  // A fixed ceiling rather than the canvas maximum, which was the other way to
  // make them comparable and is worse: the busiest card would set the scale for
  // all of them, so every chart on screen would silently redraw when an
  // unrelated session spiked, and a card nobody touched would appear to calm
  // down. A constant means a bar height is the same quantity in every card, at
  // every moment, whatever else is on the canvas. Four calls in a 2.5s bucket
  // is a hard-working agent; above that the bar sits full and the tooltip
  // carries the real figure, which is where the exact number always lived.
  const FULL_SCALE = 4;
  const observedPeak = Math.max(0, ...counts);
  const W = 132;
  const H = 14;
  const barW = W / BUCKETS;
  const peakRate = observedPeak / (BUCKET_MS / 1000);
  // Says what it counted rather than naming only half of it — the chart moving
  // on a card with no tool call in a minute is otherwise a reader's puzzle.
  const toolMarks = tools.filter(t => now - t.startedAt >= 0 && now - t.startedAt < WINDOW_MS).length;
  const blockMarks = total - toolMarks;
  const parts = [
    toolMarks > 0 ? `${toolMarks} tool ${toolMarks === 1 ? "call" : "calls"}` : "",
    blockMarks > 0 ? `${blockMarks} ${blockMarks === 1 ? "block" : "blocks"} of thinking and writing` : "",
  ].filter(Boolean);
  const title = total === 0
    ? "nothing in the last 60s"
    : `${parts.join(" · ")} in last 60s · peak ${peakRate.toFixed(1)}/s`;
  return (
    <div className="tool-spark-row" title={title}>
      <svg className="tool-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
        {counts.map((c, i) => {
          const h = c === 0 ? 1.5 : Math.max(1.5, Math.min(1, c / FULL_SCALE) * H);
          const isLatest = i === BUCKETS - 1 && c > 0;
          const isActive = c > 0;
          const cls = `tool-spark-bar${isActive ? " active" : ""}${isLatest ? " latest" : ""}`;
          return (
            <rect
              key={i}
              x={i * barW + 0.4}
              y={H - h}
              width={Math.max(0.5, barW - 1)}
              height={h}
              rx={0.8}
              className={cls}
            />
          );
        })}
      </svg>
      <span className="tool-spark-label">60s</span>
    </div>
  );
}
