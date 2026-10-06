import React, { memo } from "react";
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
import { shortModel, modelFamily } from "../model-label";
// The card's words — its state, a block's sentence and label — which the
// session list, the peek and the topbar say too. See agent-copy.ts.
import { spawnBadgeTitle, stateLabel, waitingLabel, waitingSentence } from "../agent-copy";
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
import type { AgentNodeData, ToolCall, WaitingBlock } from "../types";
import { useNow } from "../use-now";
import { noteTag, sessionNoteShown } from "../session-note";
import { toggleRecapDismissed, useRecapDismissed } from "../recap-note";
import { faceSignal, stateMarkKind, type BranchSummary } from "../node-face";
import { primaryDisplayFor, toolSubject } from "../tool-skin";
// The activity chart's counting and its scale. See tool-spark.ts.
import { barHeight, BUCKETS, SPARK_H, SPARK_W, sparkWindow } from "../tool-spark";
import { AlertMark, StateMark } from "./StateMark";
import { NoteMark } from "./RecapMark";

/** A card re-renders when its agent changes, not when the clock does (#873).
 *  Time reaches it through the three leaves that print it — the elapsed clock,
 *  the waiting row and the sparkline — each on a shared one-second beat, and
 *  the card itself is memoised on node data that keeps its identity until the
 *  board's revision moves. */
function AgentNode({ data }: NodeProps<AgentNodeData & { onOpenContext?: (sessionId: string) => void; branch?: BranchSummary }>) {
  // No `selected` here. React Flow's prop is never true on this canvas, so the
  // class it set matched nothing; the frame marks a selected card's wrapper
  // with `rf-selected` instead (canvas-flow.ts) and the ring is drawn from that.
  const cls = [
    "agent-node",
    `state-${data.state}`,
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
  // What the session's note says — what it is doing, what came of it, or
  // Claude Code's recap once that arrives — or null when it says nothing. See
  // session-note.ts for the whole rule.
  const note = sessionNoteShown(data);
  // The note opens by itself the moment there is one, and stays shut once it
  // has been closed — for THAT note: a recap, or one turn's line of one kind;
  // the next one opens again. Asked of every card, because a hook cannot wait
  // for the note (recap-note.ts).
  const noteKey = note ? note.key : null;
  const noteDismissed = useRecapDismissed(noteKey);
  const noteOpen = note != null && !noteDismissed;
  const isRecap = note?.kind === "recap";
  // The cost slot at the end of the meta row, decided once (card-cost.ts).
  const cost = costChip(data);

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
          {/* Claude Code's ※, in the session's colour, beside the name: the
              card's own mark that a recap is there, and the switch for its
              note. The note opens by itself, so this is how it is put away
              and brought back. The click stops here, so it does not also
              select the card. */}
          {note && noteKey && (
            <button
              type="button"
              className="glyph-btn recap-pin"
              aria-label={isRecap ? "Claude Code's recap" : `Session note: ${noteTag(note.kind)}`}
              aria-expanded={noteOpen}
              title={isRecap
                ? (noteOpen ? "Hide the recap" : "Show Claude Code's recap")
                : (noteOpen ? "Hide this note" : "Show what this session is doing")}
              onClick={e => { e.stopPropagation(); toggleRecapDismissed(noteKey); }}
            ><NoteMark recap={isRecap} /></button>
          )}
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
          {/* A floor, and marked as one, when the deck did not see this session
              start (#822). `startedAt` is the first event THIS page applied, and
              a page opened late is built from the bounded replay ring, so for a
              long session the clock started partway in — one tab read 118m
              beside another's 12m for the same session. `synthetic` is how the
              reducer already knows; it is the "?" beside the name. */}
          <div className="time" title={data.synthetic
            ? `The deck joined this session after it began, so it has run at least this long — first seen ${new Date(data.startedAt).toLocaleTimeString()}`
            : `Started ${new Date(data.startedAt).toLocaleTimeString()}`}>
            {data.synthetic ? "≥ " : ""}<Elapsed start={data.startedAt} end={data.endedAt} />
          </div>
        </div>
      </div>

      <div className="sub">
        {data.kind === "root" ? "session" : "subagent"}
        {data.childCount > 0 && (
          <span className="spawn-badge" title={spawnBadgeTitle(data.childCount)}>→ {data.childCount}</span>
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
      {data.waiting && <WaitingRow waiting={data.waiting} />}

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
        <ToolRateSpark tools={data.tools} outputs={data.outputs} />
      )}

      <div className="meta">
        {/* One tool, as the session list and the card's own label say it
            (#1842). */}
        <span><b>{data.toolCount}</b> {data.toolCount === 1 ? "tool" : "tools"}</span>
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
        {cost?.kind === "unpriced" && (
          <span className="cost-unpriced" title={cost.tt}>
            {UNPRICED_LABEL}
          </span>
        )}
        {cost?.kind === "spent" && (
          <span className="cost-meta" title={cost.tt}>
            <b>{fmtCost(cost.total)}{cost.floor ? "+" : ""}</b>
          </span>
        )}
      </div>

      <NodeFace data={data} title={data.kind === "root" ? naming.face : undefined} />

      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </div>
  );
}

export default memo(AgentNode);

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
        <StateMark kind={stateMarkKind(data.state)} />
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

/** The card's clock, on its own beat (#873): the one piece of the header that
 *  changes every second, and so the only piece that re-renders every second. */
function Elapsed({ start, end }: { start: number; end?: number }) {
  const now = useNow(1000);
  return <>{elapsed(start, end, now)}</>;
}

function StatePill({ state }: { state: AgentNodeData["state"] }) {
  return <span className={`state-pill state-${state}`}>{stateLabel(state)}</span>;
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
