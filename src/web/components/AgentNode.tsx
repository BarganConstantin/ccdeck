import React, { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Handle, Position, type NodeProps } from "reactflow";
import { sessionHue } from "../reducer";
import { fmtCost, UNPRICED_LABEL } from "../pricing";
import { otherModelIds } from "../usage-models";
// What the cost chip holds, and its tooltip with the multiplication written
// out. See card-cost.ts.
import { costChip } from "../card-cost";
import { codexApprovalTell } from "../codex-approval";
// The chip's labeller, which used to be declared in this file and moved out in
// #462 so that a pure matcher and a bare-node suite could reach it without a
// React component behind it. See model-label.ts for why the move happened with
// that fix rather than with #374's wider consolidation.
import { modelChipText, modelChipTitle as chipTitle } from "../model-label";
import {
  footDropped, footDroppable, footNotchOnResize, maxSqueeze, nextFootNotch, nextSqueeze, rowAt, squeezeOnResize,
} from "../card-row-squeeze";
// The card's words — its state, a block's sentence and label — which the
// session list, the peek and the topbar say too. See agent-copy.ts.
import { agentKindLabel, spawnBadgeTitle, subRowTitle, waitingLabel, waitingSentence } from "../agent-copy";
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
import type { AgentNodeData, PlanItem, ToolCall, WaitingBlock } from "../types";
import { useNow } from "../use-now";
import { boardNote, noteTag } from "../session-note";
import { toggleRecapDismissed, useRecapDismissed } from "../recap-note";
import { cardState, drawnState, faceSignal, stateMarkKind, type BranchSummary, type CardState } from "../node-face";
// The agent's own checklist, as one line (#2157). See agent-plan.ts.
import { planSummary, planTitle, type PlanSummary } from "../agent-plan";
import { primaryDisplayFor, toolSubject } from "../tool-skin";
// The activity chart's counting and its scale. See tool-spark.ts.
import { barHeight, BUCKETS, SPARK_H, SPARK_W, sparkWindow } from "../tool-spark";
import { AlertMark, StateMark } from "./StateMark";
import { NoteMark } from "./RecapMark";
// The words for a turn that stopped on an error. See stop-failure-copy.ts.
import { stopRowLabel, stopTooltip } from "../stop-failure-copy";
import type { StopFacts } from "../../server/stop-failure.mjs";
// Continue on a stopped background session, and the line a continue leaves
// (#2193). See StopContinue.tsx.
import { CardContinue, ContinuedRow } from "./StopContinue";

/** A card re-renders when its agent changes, not when the clock does (#873).
 *  Time reaches it through the three leaves that print it — the elapsed clock,
 *  the waiting row and the sparkline — each on a shared one-second beat, and
 *  the card itself is memoised on node data that keeps its identity until the
 *  board's revision moves. */
/** A layout effect in the browser, and nothing on the server, where the suite
 *  draws cards to markup and a layout effect only warns (as use-count-up.ts). */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

type CardData = AgentNodeData & { onOpenContext?: (sessionId: string) => void; branch?: BranchSummary };

/** The board's node: the card, with the connection handles React Flow needs. */
function AgentNode({ data }: NodeProps<CardData>) {
  return <AgentCard data={data} handles />;
}

/** The agent card itself, so the Inspector's tree draws the very card the board
 *  does (V4: the Inspector's cards are the Agent / Card). `handles` is the one
 *  difference: React Flow's handles only exist inside a flow, and the tree is
 *  not one. */
export function AgentCard({ data, handles = false }: { data: CardData; handles?: boolean }) {
  // No `selected` here. React Flow's prop is never true on this canvas, so the
  // class it set matched nothing; the frame marks a selected card's wrapper
  // with `rf-selected` instead (canvas-flow.ts) and the ring is drawn from that.
  // The state the card draws: a turn that stopped on an error rings as a
  // failure, as its word and mark say (drawnState, #2185).
  const shown = drawnState(data);
  // The word and glyph beside the name, from the same mapping the faces at a
  // distance draw their mark with (node-face.ts).
  const state = cardState(data);
  const cls = [
    "agent-node",
    `state-${shown}`,
    data.synthetic ? "synthetic" : "",
  ].filter(Boolean).join(" ");

  const inflight = data.tools.filter(t => !t.endedAt).length;
  // WHAT WENT WRONG, KEPT. The only place a failed tool call was ever drawn is
  // the burst bubble, and that layer holds four per agent and then drops the
  // oldest — so a failure was visible for four more calls and then existed
  // nowhere on the canvas. The card counts them instead, and the count does not
  // expire: the lifetime count (#1809) the detail panel reads, not the failures
  // still inside the 200-call window `tools` keeps, which forgot a long
  // session's early ones. Silent at zero, like the in-flight count: a session
  // with nothing wrong says nothing.
  const failed = data.toolErrorCount ?? 0;
  const hue = sessionHue(data.canvasSessionId ?? data.sessionId);
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
  // WHAT GIVES WAY ON A TIGHT HEAD (#2155, #2169, V4's Agent / Card): the model
  // is plain text after the name, and CSS gives it up first (its own ellipsis,
  // a much larger shrink factor than the name's; the name keeps a floor). The
  // one thing measured is the effort: it steps off the model text only when
  // that can uncut the name, i.e. the name's overflow is no larger than the
  // effort's width (card-row-squeeze.ts). The model itself is never dropped.
  // Measured, not reserved: the head is drawn whole, steps down once, and
  // starts again from the top whenever what it holds changes or the NAME gets
  // wider (a sibling went away).
  const labelRef = useRef<HTMLSpanElement>(null);
  const modelRef = useRef<HTMLSpanElement>(null);
  const squeezeMax = maxSqueeze(data);
  const [squeeze, setSqueeze] = useState(0);
  // The name's width as last observed: a state, so a name that has narrowed is
  // measured again by the render the change causes.
  const [, setLabelWidth] = useState<number | null>(null);
  // Set when the effort is dropped, so the widening that causes is not read as
  // room coming back from elsewhere.
  const droppedByMeasure = useRef(false);
  useBeforePaint(() => { setSqueeze(0); }, [data.effort, data.model, otherModels.length, data.label, data.kind, squeezeMax]);
  useBeforePaint(() => {
    // No layout read once there is nothing left to give up.
    if (squeeze >= squeezeMax) return;
    const label = labelRef.current;
    const model = modelRef.current;
    const text = model?.firstChild;
    if (!label || !text || text.nodeType !== 3 || !data.effort) return;
    // The effort part is the tail of the model text's first text node.
    const tail = ` · ${data.effort}`.length;
    const len = (text.textContent ?? "").length;
    const range = document.createRange();
    range.setStart(text, Math.max(0, len - tail));
    range.setEnd(text, len);
    const next = nextSqueeze(squeeze, {
      overflow: label.scrollWidth - label.clientWidth,
      modelOverflow: model ? model.scrollWidth - model.clientWidth : 0,
      effortWidth: range.getBoundingClientRect().width,
      max: squeezeMax,
    });
    if (next !== squeeze) { droppedByMeasure.current = true; setSqueeze(next); }
  });
  useEffect(() => {
    const el = labelRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    // Synchronously, so the head is measured again before the frame is painted
    // rather than drawn once at its old notch.
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      const change = { from: width, to: el.clientWidth, selfInflicted: droppedByMeasure.current };
      width = change.to;
      droppedByMeasure.current = false;
      flushSync(() => {
        setSqueeze(s => squeezeOnResize(s, change));
        setLabelWidth(change.to);
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const row = rowAt(squeeze);
  const modelChipTitle = data.model && (otherModels.length > 0
    ? `${chipTitle(data.model, data.effort)}\nspend on this card also covers:\n${otherModels.join("\n")}`
    : chipTitle(data.model, data.effort));
  // Two strings for the name row, chosen once. `face` is the name when the
  // session has one and the sentence when it does not, which is the common
  // case rather than the fallback: 0.2% of the transcripts on this machine
  // carry an agent-name and 4.1% carry an ai-title, and not one of them
  // carries a name without a title. See session-display.ts for the sweep.
  const naming = sessionDisplay(data.sessionName, data.sessionTitle);
  // What the session's note says — what it is doing, what came of it, or
  // Claude Code's recap once that arrives — and the plan on it, or null when it
  // says nothing. A note can hold the plan alone. See session-note.ts for the
  // whole rule.
  const board = boardNote(data);
  const note = board?.note ?? null;
  // The note opens by itself the moment there is one, and stays shut once it
  // has been closed — for THAT note: a recap, or one turn's line of one kind;
  // the next one opens again. Asked of every card, because a hook cannot wait
  // for the note (recap-note.ts).
  const noteKey = board ? board.key : null;
  const noteDismissed = useRecapDismissed(noteKey);
  const noteOpen = board != null && !noteDismissed;
  const isRecap = note?.kind === "recap";
  // The cost slot at the end of the meta row, decided once (card-cost.ts).
  const cost = costChip(data);

  // THE FOOT STAYS ONE LINE (V4): while it overflows, meta items drop in a
  // fixed order (card-row-squeeze.ts). Measured after layout like the head's
  // squeeze; reset when what the foot holds changes or the card gets wider.
  const footRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [footNotch, setFootNotch] = useState(0);
  // Bumped when the clock's width changes, which re-renders only the leaf: the
  // foot has to be measured again by the card itself.
  const [, setFootBeat] = useState(0);
  const tokenTotal = data.usage.inputTokens + data.usage.outputTokens;
  const present = { tokens: tokenTotal > 0, inflight: inflight > 0, tools: true };
  const footMax = footDroppable(present).length;
  const dropped = footDropped(footNotch, present);
  const footKey = [
    cost ? `${cost.kind}:${cost.kind === "spent" ? fmtCost(cost.total) + (cost.floor ? "+" : "") : ""}` : "",
    data.toolCount, data.toolErrorCount ?? 0, inflight, fmtTokens(tokenTotal), data.childCount, data.synthetic ? 1 : 0,
  ].join("|");
  useBeforePaint(() => { setFootNotch(0); }, [footKey]);
  useBeforePaint(() => {
    const el = footRef.current;
    if (!el || footNotch >= footMax) return;
    const overflow = el.scrollWidth - el.clientWidth;
    // Functional, so a reset queued by the effect above is not overwritten.
    setFootNotch(n => nextFootNotch(n, { overflow, max: footMax }));
  });
  useEffect(() => {
    const el = footRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    let clock = timeRef.current?.offsetWidth ?? 0;
    const ro = new ResizeObserver(() => {
      const to = el.clientWidth;
      const now = timeRef.current?.offsetWidth ?? 0;
      const from = width;
      width = to;
      const clockMoved = now !== clock;
      clock = now;
      if (to === from && !clockMoved) return;
      flushSync(() => {
        setFootNotch(n => footNotchOnResize(n, { from, to }));
        if (clockMoved) setFootBeat(b => b + 1);
      });
    });
    ro.observe(el);
    if (timeRef.current) ro.observe(timeRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    // --accent itself is built in styles.css from this hue: the token that
    // reads well on a #14161b node is not the one that reads on a white one,
    // and .tokens-meta / .spawn-badge are text.
    <div className={cls} data-alarm={state.tone === "waiting" ? "" : undefined} style={{ "--session-hue": hue } as React.CSSProperties}>
      <span className="accent-stripe" />
      {handles && <Handle type="target" position={Position.Left} style={{ background: "transparent", border: "none" }} />}

      <div className="head">
        <div className="title">
          <span className="label" title={cardTooltip} ref={labelRef}>{data.label}</span>
          {/* The model as plain mono text after the name (V4): no pill, no
              tint — the word already names the family. A Codex session with no
              model yet says Codex in the same place (#404), and only "codex"
              falls back: the reducer stamps "claude" on any event that names no
              provider, so a "Claude Code" word would print an assumption as an
              observation on every model-less node. */}
          {data.model
            ? <span className="model-text" title={modelChipTitle} ref={modelRef}>
                {modelChipText(data.model, row.effort ? data.effort : undefined)}{otherModels.length > 0 ? ` +${otherModels.length}` : ""}
              </span>
            : data.provider === "codex"
              ? <span className="model-text" title="OpenAI Codex — no model reported yet">Codex</span>
              : null}
          {data.restoredFromLog &&<span className="synth-tag" title={data.provider === "claude" ? "Restored from Claude’s busy-session registry after verifying the process identity. Earlier tool history is partial." : "Restored from a log with no recorded ending. Process status is not confirmed."}>restored</span>}
          {data.synthetic && <span className="synth-tag" title="No SessionStart captured — synthesised">?</span>}
          {/* Claude Code's ※, in the session's colour, beside the name: the
              card's own mark that a recap is there, and the switch for its
              note. The note opens by itself, so this is how it is put away
              and brought back. The click stops here, so it does not also
              select the card. */}
          {board && noteKey && (
            <button
              type="button"
              className="glyph-btn recap-pin"
              aria-label={isRecap ? "Claude Code's recap" : note ? `Session note: ${noteTag(note.kind)}` : "Session note: plan"}
              aria-expanded={noteOpen}
              title={isRecap
                ? (noteOpen ? "Hide the recap" : "Show Claude Code's recap")
                : note
                  ? (noteOpen ? "Hide this note" : "Show what this session is doing")
                  : (noteOpen ? "Hide the plan" : "Show the plan")}
              onClick={e => { e.stopPropagation(); toggleRecapDismissed(noteKey); }}
            ><NoteMark recap={isRecap} /></button>
          )}
        </div>
        <div className="head-right">
          <StateLine state={state} />
          {hasContextSignal && data.onOpenContext && (
            <ContextDonut
              currentContextTokens={currentContextTokens}
              modelId={data.model}
              contextWindow={data.contextWindow}
              onClick={() => data.onOpenContext!(data.sessionId)}
            />
          )}
        </div>
      </div>

      {/* THE TASK LINE (V4's Agent / Card): one line of what the card is for, in
          the secondary ink, cut with an ellipsis and carrying its whole text on
          hover. No new data — it is the two rows it replaces.

          A root says what Claude Code calls the session: the NAME when it has
          one, the TITLE when it does not, the same line either way. #520 drew
          the name alone, which measured across every transcript on this machine
          renders for 0.2% of them; the title reaches 4.1%, and 25.3% of the
          transcripts big enough to be a real session. It does NOT replace the
          id: both records are rewritten as the session moves and two sessions
          can hold the same one, so this is a description, not an address — the
          short id in the cluster header stays the thing that still means this
          node in five minutes. ABSENT rather than empty when there is neither:
          a Codex rollout carries no such record and a young Claude session has
          not been given one yet.

          A subagent has neither record (copying the parent's naming onto every
          child would print the same string five times on one canvas), so it
          says what it is: the kind word and the folder it works in, as the row
          this replaces drew them, with the whole row — kind, count, folder and
          model — on hover. A Codex child session is a root with a parent, and
          agentKindLabel names it "child session": it draws that word the same
          way. The kind word of an ordinary root is not drawn (its edge, its
          tooltip and the card's accessible name already say it). */}
      {data.kind === "root" && naming.face && (
        <div className="task-line" title={naming.tooltip}>
          {naming.face}
        </div>
      )}
      {!(data.kind === "root" && naming.face) && agentKindLabel(data) !== "session" && (
        <div className="task-line" title={subRowTitle(data)}>
          {agentKindLabel(data)}{data.cwdBasename ? ` · ${data.cwdBasename}` : ""}
        </div>
      )}

      {/* The turn ended on an error and has to be run again by hand (#2185):
          the head says "Failed", and this says which failure it was. Above
          the waiting row, which a stopped turn makes redundant when it is only
          the idle "your turn" — Claude Code's idle reminder a minute later is
          about the same turn. */}
      {data.kind === "root" && data.stopFailure && <StopRow data={data} stop={data.stopFailure} />}
      {/* What a continue did, once the session is no longer stopped (#2193):
          "Continued automatically 2m ago", for half an hour. */}
      {data.kind === "root" && !data.stopFailure && <ContinuedRow data={data} />}

      {/* A row of its own rather than a chip in the head. The card is 256px
          wide and the head already spends it on the name, the model and the
          state word; a fourth item there pushed the name to an ellipsis and
          still overflowed. A blocked session has earned a line. */}
      {data.waiting && !(data.stopFailure && data.waiting.kind === "idle") && <WaitingRow waiting={data.waiting} />}

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

      {/* WHAT IT IS WORKING THROUGH, in its own words (#2157): how far down
          its checklist it is and the step under way. Under the alarms, because
          a session that needs you is the more urgent fact, and over the
          figures, because this is the one row that says what the figures are
          for. Absent until the agent writes a list, so a session that keeps
          none is the card it always was. */}
      {(() => {
        const plan = planSummary(data.plan);
        return plan && data.plan ? <PlanRow plan={plan} items={data.plan.items} /> : null;
      })()}

      {(data.tools.length > 0 || (data.outputs?.length ?? 0) > 0) && (
        <ToolRateSpark tools={data.tools} outputs={data.outputs} />
      )}

      {/* THE FOOT (V4): cost · time, then the figures that stay (tools, errors,
          in-flight, tokens), a spacer, and the sub-agent count at the end. The
          deck has no per-tool icon set, so Figma's tool icons are not drawn;
          nor an agents glyph, so the count stays "→ N". Items are separated by
          a dot, and the row stays one line by dropping meta items (see .foot). */}
      <div className="foot" ref={footRef}>
        {interleave([
          cost?.kind === "unpriced" && (
            <span key="cost" className="cost-unpriced" title={cost.tt}>{UNPRICED_LABEL}</span>
          ),
          cost?.kind === "spent" && (
            <span key="cost" className="cost-meta" title={cost.tt}>
              <b>{fmtCost(cost.total)}{cost.floor ? "+" : ""}</b>
            </span>
          ),
          // A floor, and marked as one, when the deck did not see this session
          // start (#822). `startedAt` is the first event THIS page applied, and
          // a page opened late is built from the bounded replay ring, so for a
          // long session the clock started partway in — one tab read 118m
          // beside another's 12m for the same session. `synthetic` is how the
          // reducer already knows; it is the "?" beside the name.
          <span key="time" className="time" ref={timeRef} title={data.synthetic
            ? `The deck joined this session after it began, so it has run at least this long — first seen ${new Date(data.startedAt).toLocaleTimeString()}`
            : `Started ${new Date(data.startedAt).toLocaleTimeString()}`}>
            {data.synthetic ? "≥ " : ""}<Elapsed start={data.startedAt} end={data.endedAt} />
          </span>,
          // One tool, as the session list and the card's own label say it
          // (#1842).
          !dropped.has("tools") && <span key="tools"><b>{data.toolCount}</b> {data.toolCount === 1 ? "tool" : "tools"}</span>,
          failed > 0 && (
            <span key="failed" className="failed-meta" title={`${failed} tool ${failed === 1 ? "call" : "calls"} returned an error`}>
              <b>{failed}</b> err
            </span>
          ),
          inflight > 0 && !dropped.has("inflight") && <span key="inflight" className="inflight-meta"><b>{inflight}</b> in-flight</span>,
          tokenTotal > 0 && !dropped.has("tokens") && (
            <span key="tokens" className="tokens-meta" title={`in:${data.usage.inputTokens}  out:${data.usage.outputTokens}  cache-r:${data.usage.cacheReadTokens}  cache-c:${data.usage.cacheCreateTokens}${(data.usage.reasoningOutputTokens ?? 0) > 0 ? `  reasoning:${data.usage.reasoningOutputTokens}` : ""}`}>
              <b>{fmtTokens(data.usage.inputTokens + data.usage.outputTokens)}</b> tok
            </span>
          ),
        ])}
        {data.childCount > 0 && (
          <span className="spawn-badge" title={spawnBadgeTitle(data.childCount)}>→ {data.childCount}</span>
        )}
      </div>

      <NodeFace data={data} title={data.kind === "root" ? naming.face : undefined} />

      {handles && <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />}
    </div>
  );
}

export default memo(AgentNode);

/**
 * The plan as one row: a meter, the count, and the step.
 *
 * The step is the in-progress one, worded the way the agent words it while
 * doing it, or the next one waiting, said as "next:" so it is not read as under
 * way. The row ellipsises the step and never the count — the count is the half
 * that is true at a glance. The whole list is the tooltip and the details
 * panel; the meter repeats the count, so it is decoration to a screen reader,
 * which hears the count in the card's name (agentAriaLabel).
 */
function PlanRow({ plan, items }: { plan: PlanSummary; items: readonly PlanItem[] }) {
  return (
    <div className={plan.allDone ? "plan-row plan-done" : "plan-row"} title={planTitle(items)}>
      <span className="plan-meter" aria-hidden style={{ "--plan-done": plan.done / plan.total } as React.CSSProperties} />
      <span className="plan-count">{plan.done}/{plan.total}</span>
      <span className="plan-step">
        {plan.allDone || !plan.current
          ? "done"
          : <>{plan.next && <span className="plan-next">next: </span>}{plan.current}</>}
      </span>
    </div>
  );
}

/**
 * THE CARD AS IT IS DRAWN FROM A DISTANCE — the compact and overview faces.
 *
 * Not the card shrunk. The canvas scales everything inside it, so a card at
 * 0.3 draws its 12px name at under 4px however few rows it keeps; the far tier
 * this replaces kept a state pill and one character of a name. This element is
 * laid out in SCREEN pixels instead: the sheet sizes it to the card's box times
 * the zoom and scales it back by the inverse (see `.lod-face`), so it covers
 * the card exactly and its 11px type is 11px on the display at every zoom.
 *
 * Always in the tree, and `display: none` at the detail tier: the mode is an
 * attribute on the canvas, so changing it re-renders no card. What it draws is
 * the card's own data, picked down — the name, a state MARK, and the one line
 * faceSignal decides is worth an interruption. Which lines fit is the sheet's
 * call, per card, by container query against the face's own on-screen size.
 *
 * Hidden from assistive technology like the rows it stands in for: the node's
 * accessible name is agentAriaLabel, composed from the data, and says all of
 * this at every zoom.
 */
function NodeFace({ data, title }: { data: AgentNodeData & { branch?: BranchSummary }; title?: string }) {
  const alarm = data.kind === "root" && isAlarming(data.waiting);
  const signal = faceSignal(data, data.branch, {
    sayWaiting: waitingLabel,
    describeCall: t => ({ name: primaryDisplayFor(t.name).label, subject: toolSubject(t.name, t.input) }),
  });
  return (
    <div
      className="lod-face"
      data-kind={data.kind}
      data-alarm={alarm ? "" : undefined}
      data-signal={signal ? "" : undefined}
      aria-hidden
    >
      <div className="lod-id">
        <StateMark kind={stateMarkKind(drawnState(data))} />
        <span className="lod-name">{data.label}</span>
        {signal && <span className="lod-inline" data-tone={signal.tone}>{signal.short}</span>}
        {alarm && <AlertMark />}
      </div>
      {title && <div className="lod-title">{title}</div>}
      {signal && (
        <div className="lod-signal" data-tone={signal.tone}>
          <span className="lod-long">{signal.long}</span>
          <span className="lod-short">{signal.short}</span>
        </div>
      )}
    </div>
  );
}

/** The foot's items with the dot between them, none before the first or after
 *  the last, and none for an item that is absent. The dot is decoration: the
 *  items are words of their own. */
function interleave(items: (React.ReactElement | false)[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (const item of items) {
    if (!item) continue;
    if (out.length > 0) out.push(<span key={`sep-${out.length}`} className="foot-sep" aria-hidden>·</span>);
    out.push(item);
  }
  return out;
}

/** The card's clock, on its own beat (#873): the one piece of the header that
 *  changes every second, and so the only piece that re-renders every second. */
function Elapsed({ start, end }: { start: number; end?: number }) {
  const now = useNow(1000);
  return <>{elapsed(start, end, now)}</>;
}

/** The card's state: the face's own mark, then a sentence-case word, both in
 *  the state's token (V4). The mark is decoration beside the word, so the word
 *  is the channel that carries the state to a reader (1.4.1) and to the card's
 *  accessible name (agentAriaLabel). */
function StateLine({ state }: { state: CardState }) {
  return (
    <span className="state-line" data-tone={state.tone}>
      {state.mark === "alert" ? <AlertMark /> : <StateMark kind={state.mark} />}
      <span className="state-word">{state.word}</span>
    </span>
  );
}

/** The turn stopped on an error: which one, in the row's words, with what
 *  Claude Code said and what to do in the tooltip. The card's accessible name
 *  carries the same (agentAriaLabel), which is where a reader on the node hears
 *  it — a title is not announced there. The still dot is the waiting row's:
 *  nothing here is still happening. A background session's row carries its
 *  Continue button at the end (#2193); an interactive one's says to type
 *  "continue" in its terminal. */
function StopRow({ data, stop }: { data: AgentNodeData; stop: StopFacts }) {
  return (
    <div className="stop-row" title={stopTooltip(stop, data.job != null)} data-kind={stop.kind}>
      <span className="waiting-dot" aria-hidden />
      <span className="stop-said">{stopRowLabel(stop)}</span>
      <CardContinue data={data} />
    </div>
  );
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
function WaitingRow({ waiting }: { waiting: WaitingBlock }) {
  // Its own beat (#873): "blocked for 3m" counts up while the card sits still.
  const now = useNow(1000);
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
function ToolRateSpark({ tools, outputs }: { tools: ToolCall[]; outputs?: number[] }) {
  // Its own beat (#873): the window slides under a card that has not changed.
  const now = useNow(1000);
  const { counts, title } = sparkWindow(tools, outputs, now);
  const barW = SPARK_W / BUCKETS;
  return (
    <div className="tool-spark-row" title={title}>
      <svg className="tool-spark" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden>
        {counts.map((c, i) => {
          const h = barHeight(c);
          const isLatest = i === BUCKETS - 1 && c > 0;
          const isActive = c > 0;
          const cls = `tool-spark-bar${isActive ? " active" : ""}${isLatest ? " latest" : ""}`;
          return (
            <rect
              // THE LEADING BAR IS KEYED BY WHAT IT COUNTS, so React remounts
              // it the moment that count changes and the rise below plays on
              // exactly the event it is reporting. Everything behind it keeps
              // its index: those buckets are time slices sliding leftwards, and
              // remounting them would restart an animation for the passage of
              // time rather than for anything that happened.
              key={isLatest ? `landed:${c}` : i}
              x={i * barW + 0.4}
              y={SPARK_H - h}
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
