import React, { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Handle, Position, type NodeProps } from "reactflow";
import { fmtCost } from "../pricing";
// What the cost chip holds, and its tooltip with the multiplication written
// out. See card-cost.ts.
import { costChip } from "../card-cost";
import { codexApprovalTell } from "../codex-approval";
// The provider's printed name, the one the usage panels already print.
import { agentLabel } from "../provider-copy";
import { footDropped, footDroppable, footNotchOnResize, nextFootNotch } from "../card-row-squeeze";
// The card's words — its state, a block's sentence and label — which the
// session list, the peek and the topbar say too. See agent-copy.ts.
import { agentKindLabel, blockedToolTooltip, categoryLabel, spawnBadgeTitle, subRowTitle, waitingLabel, waitingSentence } from "../agent-copy";
import { isAlarming } from "../ambient-counts";
// The card's token count, which used to be a private three-tier `fmtTok` here —
// byte-identical to the two copies #323 deleted, and the fourth one it missed
// (#374). See token-format.ts for the tier it did not have.
import { fmtTokens } from "../token-format";
// The card's elapsed clock, which used to be declared in this file and which
// the detail panel wrote out again, one tier short. See duration.ts.
import { elapsed } from "../duration";
import { ContextDonut } from "./ContextModal";
import { contextFill } from "../context-figure";
import type { AgentNodeData, PlanItem, WaitingBlock } from "../types";
import { useNow } from "../use-now";
import { useLanguage, useT } from "../i18n";
import { drawnState, faceStatus, stateMarkKind, type BranchSummary, type CardState, type StateMarkKind } from "../node-face";
import { faceTask, lastTypedPrompt, sessionNames, twinStart, type TwinClock } from "../rail-row-copy";
// The agent's own checklist, as one line (#2157). See agent-plan.ts.
import { planSummary, planTitle, type PlanSummary } from "../agent-plan";
// The tool kinds the foot draws as icons, from the calls the card holds.
import { recentToolKinds, TOOL_KIT_ICON } from "../card-tool-icons";
import { AlertMark, StateMark } from "./StateMark";
import { KitIcon, KitStateGlyph, type KitStateName } from "./kit-icons";
import { CostChipTip } from "./CostTip";
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

type CardData = AgentNodeData & { onOpenContext?: (sessionId: string) => void; branch?: BranchSummary; twin?: TwinClock };

/** The board's node: the card, with the connection handles React Flow needs. */
function AgentNode({ data }: NodeProps<CardData>) {
  return <AgentCard data={data} handles />;
}

/** The agent card itself, so the Inspector's tree draws the very card the board
 *  does (V4: the Inspector's cards are the Agent / Card). `handles` is the one
 *  difference: React Flow's handles only exist inside a flow, and the tree is
 *  not one. */
export function AgentCard({ data, handles = false }: { data: CardData; handles?: boolean }) {
  const t = useT();
  const language = useLanguage();
  // No `selected` here. React Flow's prop is never true on this canvas, so the
  // class it set matched nothing; the frame marks a selected card's wrapper
  // with `rf-selected` instead (canvas-flow.ts) and the ring is drawn from that.
  // The state the card draws: a turn that stopped on an error rings as a
  // failure, as its word and mark say (drawnState, #2185).
  const shown = drawnState(data);
  // The word and glyph beside the name: the faces' own status at a distance
  // (node-face.ts faceStatus), so a finished card whose calls failed wears the
  // partial mark here too, and says "Done · 1 failed" (StateLine), as its row in
  // the Sessions list does.
  const state = faceStatus(data, t);
  const cls = [
    "agent-node",
    `state-${shown}`,
    // Ready for a first prompt: the reducer's state is active, but nothing is
    // at work, so the edge is the quiet one and not Working's (agent-node.css).
    state.tone === "ready" ? "ready" : "",
    data.synthetic ? "synthetic" : "",
  ].filter(Boolean).join(" ");

  const inflight = data.tools.filter(call => !call.endedAt).length;
  // WHAT WENT WRONG, KEPT. The only place a failed tool call was ever drawn is
  // the burst bubble, and that layer holds four per agent and then drops the
  // oldest — so a failure was visible for four more calls and then existed
  // nowhere on the canvas. The card counts them instead, and the count does not
  // expire: the lifetime count (#1809) the detail panel reads, not the failures
  // still inside the 200-call window `tools` keeps, which forgot a long
  // session's early ones. V4's foot has no words for it, so the count is said
  // where the foot's tool icons are hovered, beside the call count, and in the
  // card's accessible name; the Inspector prints both.
  const failed = data.toolErrorCount ?? 0;
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
  // NO MODEL ON THE CARD (V4 top-10 #2): the head is the name and the state
  // (and "Codex" on a Codex card, below), and the task line says what the
  // session is for. The model and its effort
  // were mono text after the name, the machinery rather than the work, and
  // they cut the name on every busy card; the Inspector, the Sessions list and
  // the peek still say both, with the other models a session's money came from.
  // A root's two lines keep the one name rule every surface keeps (owner's
  // critique, 2026-11-11, point 2; rail-row-copy.ts sessionNames): the head is
  // the session's name — the name it was given, else Claude Code's title, else
  // the folder — and the task line is what a person last asked it, the
  // Sessions list's second line. The card had the folder in its head and the
  // name or title on its task line, so one session read "api / retention job"
  // here and "retention job / api · Add a retention job…" in the list beside
  // it. Most sessions have no name or title (0.2% and 4.1% of the transcripts
  // on this machine, session-display.ts): their head is still the folder.
  const names = data.kind === "root" ? sessionNames(data) : null;
  const headName = names ? names.title : data.label;
  // When it started, on a card another reads like (canvas-flow.ts nodeDataFor).
  const twin = names && data.twin ? twinStart(data.startedAt, data.twin) : null;
  // The prompt's first line on the face, the whole prompt on hover. Absent
  // rather than empty when nothing was asked, or when the task is the name.
  const rootTask = names?.task ? { face: names.task, tooltip: lastTypedPrompt(data) } : null;
  // What the call that started a subagent said it is for (subagent-lifecycle.ts).
  const spawnTask = data.spawnCall?.description;
  // The cost slot at the end of the meta row, decided once (card-cost.ts).
  const cost = costChip(data);
  // The kinds of tool the session used, for the foot's icons.
  const toolKinds = recentToolKinds(data.tools);

  // THE FOOT STAYS ONE LINE (V4): while it overflows, meta items drop in a
  // fixed order (card-row-squeeze.ts). Measured after layout; reset when what
  // the foot holds changes or the card gets wider.
  const footRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [footNotch, setFootNotch] = useState(0);
  // Bumped when the clock's width changes, which re-renders only the leaf: the
  // foot has to be measured again by the card itself.
  const [, setFootBeat] = useState(0);
  const tokenTotal = data.usage.inputTokens + data.usage.outputTokens;
  const present = { tokens: tokenTotal > 0, inflight: inflight > 0 };
  const footMax = footDroppable(present).length;
  const dropped = footDropped(footNotch, present);
  const showTokens = tokenTotal > 0 && !dropped.has("tokens");
  // HOW FULL ITS CONTEXT IS, in the foot beside the token figure with its
  // percent: in the head it was a second circle beside the state mark, two
  // circles with two meanings. It stays when the squeeze drops the
  // token figure, so the warning tones never leave the card.
  const ring: React.ReactElement | false = hasContextSignal && !!data.onOpenContext && (
    <ContextDonut
      key="context"
      currentContextTokens={currentContextTokens}
      modelId={data.model}
      contextWindow={data.contextWindow}
      onClick={() => data.onOpenContext!(data.sessionId)}
    />
  );
  const footKey = [
    cost ? `${cost.kind}:${cost.kind === "spent" ? fmtCost(cost.total) + (cost.floor ? "+" : "") : ""}` : "",
    toolKinds.join(","), inflight, fmtTokens(tokenTotal), data.childCount, data.synthetic ? 1 : 0,
    ring ? Math.round(contextFill(data).pct) : "",
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
    // No colour of its own (V4 top-10 #1): the card wore its session's hashed
    // hue, a colour that said nothing. Its edge is --line, and --warn while it
    // waits on you; its rings are the deck's own --accent.
    <div className={cls} data-alarm={state.tone === "waiting" ? "" : undefined}>
      {handles && <Handle type="target" position={Position.Left} style={{ background: "transparent", border: "none" }} />}

      <div className="head">
        <div className="title">
          <span className="label" title={cardTooltip}>{headName}</span>
          {/* WHICH CLI, FOR CODEX ONLY (V4 top-10 #2). With the model text gone
              this word is the board's one way to tell a Codex card from a
              Claude one, in the place the model sat: muted, no pill. A Claude
              card, the default provider, says nothing: the reducer stamps
              "claude" on any event that names no provider, so a word for it
              would print an assumption as an observation. */}
          {data.provider === "codex" && <span className="provider-word">{agentLabel("codex")}</span>}
          {data.restoredFromLog &&<span className="synth-tag" title={data.provider === "claude" ? t("board.node.restoredRegistry") : t("board.node.restoredLog")}>{t("board.node.restored")}</span>}
          {data.synthetic && <span className="synth-tag" title={t("board.node.synthesised")}>?</span>}
        </div>
        {/* One circle here, the state's: the context ring is in the foot. */}
        <div className="head-right">
          <StateLine state={state} under={stateMarkKind(shown)} />
        </div>
      </div>

      {/* THE TASK LINE (V4's Agent / Card): what the card is for, in the
          secondary ink, on up to two lines and cut with an ellipsis after the
          second, carrying its whole text on hover. CHANGED ON PURPOSE (V4
          top-10 #2): it was one line, which cut most prompts after four words.

          A root says what a person last asked it, the task line the Sessions
          list draws under the same name (rail-row-copy.ts sessionTask). The
          session's NAME or TITLE is the head's word, not this line's (owner's
          critique, 2026-11-11, point 2). Neither is an address: both records
          are rewritten as the session moves and two sessions can hold the same
          one, so the short id stays in the cluster header's hover. ABSENT
          rather than empty when nothing was asked, or when the task is the
          name itself.

          A subagent has neither record (copying the parent's naming onto every
          child would print the same string five times on one canvas), so it
          says what the call that started it said it is for: the Task or Agent
          call's description. When no such call reached the deck it says what
          it is, the kind word and the folder it works in. The whole row — kind,
          count, folder and model — is on hover either way. A Codex child
          session is a root with a parent, and agentKindLabel names it "child
          session": it draws that word the same way. The kind word of an
          ordinary root is not drawn (its edge, its tooltip and the card's
          accessible name already say it). */}
      {/* A card that reads like another on the board, name and task
          (twinClocks), leads this line with when it started: in the head it
          cut the name to a letter. Only then: a card that reads like no other
          draws no clock (twinStart is null). */}
      {data.kind === "root" && (rootTask || twin) && (
        <div className="task-line" title={rootTask?.tooltip}>
          {twin && <span className="twin-start" title={t("board.node.started", { time: twin })}>{twin}</span>}
          {twin && rootTask ? " · " : ""}
          {rootTask?.face}
        </div>
      )}
      {!(data.kind === "root" && (rootTask || twin)) && agentKindLabel(data, t) !== "session" && (
        <div className="task-line" title={spawnTask ? `${spawnTask}\n${subRowTitle(data, t)}` : subRowTitle(data, t)}>
          {spawnTask || `${agentKindLabel(data, t)}${data.cwdBasename ? ` · ${data.cwdBasename}` : ""}`}
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
          wide and the head already spends it on the name and the state word;
          a third item there pushed the name to an ellipsis and still
          overflowed. A blocked session has earned a line. */}
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

      {/* THE FOOT (V4): up to three icons for the tool kinds the session used,
          latest first, then cost · time, then the figures that stay (in-flight,
          tokens and, on a root, the context ring with its percent), a spacer,
          and at the end the sub-agent count with its icon.
          Items are separated by a dot, and the row stays one line by dropping
          meta items (see .foot). The icons replace the activity sparkline: same
          calls, said as kinds, and their tooltip says how many calls and how
          many failed, which the foot no longer prints. No recap pin: the note
          opens by itself, its × puts it away, and the Inspector's Recap section
          reads it whole. */}
      <div className="foot" ref={footRef}>
        {toolKinds.length > 0 && (
          <span className="foot-tools" title={[
            toolKinds.map(k => categoryLabel(k, t)).join(" · "),
            t("board.toolCount", { count: data.toolCount }) + (failed > 0 ? t("board.listSep") + t("board.failedCount", { n: failed }) : ""),
          ].join("\n")}>
            {toolKinds.map(k => <KitIcon key={k} name={TOOL_KIT_ICON[k]} />)}
          </span>
        )}
        {interleave([
          cost?.kind === "unpriced" && (
            <CostChipTip key="cost" className="cost-unpriced" tip={cost.tip}>{t("insights.cost.notPriced")}</CostChipTip>
          ),
          cost?.kind === "spent" && (
            <CostChipTip key="cost" className="cost-meta" tip={cost.tip}>
              <b>{fmtCost(cost.total)}{cost.floor ? "+" : ""}</b>
            </CostChipTip>
          ),
          // A floor, and marked as one, when the deck did not see this session
          // start (#822). `startedAt` is the first event THIS page applied, and
          // a page opened late is built from the bounded replay ring, so for a
          // long session the clock started partway in — one tab read 118m
          // beside another's 12m for the same session. `synthetic` is how the
          // reducer already knows; it is the "?" beside the name.
          <span key="time" className="time" ref={timeRef} title={data.synthetic
            ? t("board.node.joinedLate", { time: new Date(data.startedAt).toLocaleTimeString(language) })
            : t("board.node.started", { time: new Date(data.startedAt).toLocaleTimeString(language) })}>
            {data.synthetic ? "≥ " : ""}<Elapsed start={data.startedAt} end={data.endedAt} />
          </span>,
          inflight > 0 && !dropped.has("inflight") && <span key="inflight" className="inflight-meta"><b>{inflight}</b> {t("board.meta.inflight")}</span>,
          showTokens && (
            <span key="tokens" className="tokens-meta" title={`${t("board.meta.tokensTitle", { input: data.usage.inputTokens, output: data.usage.outputTokens, cacheR: data.usage.cacheReadTokens, cacheC: data.usage.cacheCreateTokens })}${(data.usage.reasoningOutputTokens ?? 0) > 0 ? `  ${t("board.meta.reasoning", { n: data.usage.reasoningOutputTokens ?? 0 })}` : ""}`}>
              <b>{fmtTokens(data.usage.inputTokens + data.usage.outputTokens)}</b> {t("board.meta.tok")}
            </span>
          ),
          // With the token figure dropped, the ring is an item of its own.
          !showTokens && ring,
        ])}
        {/* Right after the token figure, with no dot: "34k tok ◔ 17%". */}
        {showTokens && ring}
        {data.childCount > 0 && (
          <span className="foot-end">
            <span className="spawn-badge" title={spawnBadgeTitle(data.childCount, t)}>{data.childCount}<KitIcon name="agents" /></span>
          </span>
        )}
      </div>

      <NodeFace data={data} task={faceTask(data)} />

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
  const t = useT();
  return (
    <div className={plan.allDone ? "plan-row plan-done" : "plan-row"} title={planTitle(items)}>
      <span className="plan-meter" aria-hidden style={{ "--plan-done": plan.done / plan.total } as React.CSSProperties} />
      <span className="plan-count">{plan.done}/{plan.total}</span>
      <span className="plan-step">
        {plan.allDone || !plan.current
          ? t("board.state.done")
          : <>{plan.next && <span className="plan-next">{t("board.plan.next")}</span>}{plan.current}</>}
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
 * one task line and the card's status (owner's critique, 2026-11-11): what a
 * person last asked the session (the Sessions list's task), else its name or
 * title, never the folder the cluster's label above already names
 * (rail-row-copy.ts faceTask); a subagent's own task, else its name. Then the
 * mark and the word, Working, Done, Waiting or, beside the partial mark,
 * "1 failed" (faceStatus).
 * Compact and overview draw the same face. A card that reads like another on
 * the board (twinClocks) adds when it started, after the word where the face
 * has two lines; never below 40%.
 *
 * The word is never cut: where it does not fit whole, the sheet lets it wrap
 * to a line the face clips, and the mark says the state alone, by its shape
 * and its colour. Where the face is tall enough the task has a line of its
 * own and the status the one under it.
 *
 * Below 40% the face is a pill (V4's Figma): the start of the same task line
 * at its left, cut with an ellipsis, and the mark at its right. The word moves
 * to the peek. CHANGED ON PURPOSE (owner's critique, round 3): the pill said
 * the card's label, which for a root is the folder its tag says right above.
 *
 * Hidden from assistive technology like the rows it stands in for: the node's
 * accessible name is agentAriaLabel, composed from the data, and says all of
 * this at every zoom. The peek beside the pointer says the word too.
 */
function NodeFace({ data, task }: { data: AgentNodeData & { branch?: BranchSummary; twin?: TwinClock }; task: string }) {
  const tr = useT();
  const alarm = data.kind === "root" && isAlarming(data.waiting);
  const status = faceStatus(data, tr);
  const twin = data.kind === "root" && data.twin ? twinStart(data.startedAt, data.twin) : null;
  return (
    <div
      className="lod-face"
      data-kind={data.kind}
      data-alarm={alarm ? "" : undefined}
      aria-hidden
    >
      <div className="lod-line" data-status={status.tone}>
        {status.mark === "alert" ? <AlertMark /> : <StateMark kind={status.mark} />}
        {task && <span className="lod-name">{task}</span>}
        {twin && <span className="lod-start">{twin}</span>}
        <span className="lod-state">{status.word}</span>
      </div>
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
 *  accessible name (agentAriaLabel).
 *
 *  A turn that finished with failed calls (the partial tone) has room here for
 *  both facts: Done in done's ink, then the face's "3 failed" in the warning's,
 *  each its own span for the sheet. The face at a distance says the count alone. */
const STATE_GLYPH: Record<CardState["tone"], KitStateName> = { active: "working", waiting: "waiting", done: "done", partial: "partial", err: "error", ready: "idle" };

function StateLine({ state, under }: { state: CardState; under: StateMarkKind }) {
  const t = useT();
  return (
    <span className="state-line" data-tone={state.tone}>
      <KitStateGlyph name={STATE_GLYPH[state.tone]} className="state-mark" kind={state.mark === "alert" ? under : state.mark} />
      {state.tone === "partial"
        ? <span className="state-word"><span className="state-done">{t("board.card.stateDone")}</span>{" · "}<span className="state-failed">{state.word}</span></span>
        : <span className="state-word">{state.word}</span>}
    </span>
  );
}

/** The turn stopped on an error: which one, in the row's words, with what
 *  Claude Code said and what to do in the tooltip. The card's accessible name
 *  carries the same (agentAriaLabel), which is where a reader on the node hears
 *  it — a title is not announced there. Text alone in the failure's hue, with
 *  no dot (V4's Agent / Card): the head's Failed mark already marks it. A
 *  background session's row carries its Continue button at the end (#2193); an
 *  interactive one's says to type "continue" in its terminal. */
function StopRow({ data, stop }: { data: AgentNodeData; stop: StopFacts }) {
  const t = useT();
  return (
    <div className="stop-row" title={stopTooltip(stop, data.job != null, t)} data-kind={stop.kind}>
      <span className="stop-said">{stopRowLabel(stop, t)}</span>
      <CardContinue data={data} />
    </div>
  );
}

/** What the session is waiting on, as V4's Agent / Card draws it: one line
 *  in the Waiting colour, with no dot and no clock (the head's alert mark says
 *  it is waiting, the foot's clock says for how long). A permission prompt reads
 *  as the call it is most likely about — "Bash · npm test -- rate-limit", the
 *  same line the session list draws, and in mono as it does, because it is a
 *  call (V4 top-10 #8) — and as Claude Code's sentence when the stream implied
 *  no call. A question reads as the question, and an idle prompt as "Your
 *  turn", both in the sans: they are words, not something to type. The tooltip
 *  keeps Claude Code's own sentence, the hedge on the guess
 *  (blockedToolTooltip) and how long it has been blocked. */
function WaitingRow({ waiting }: { waiting: WaitingBlock }) {
  const t = useT();
  // Its own beat (#873): the tooltip's "blocked for 3m" counts up while the
  // card sits still.
  const now = useNow(1000);
  const said = waitingSentence(waiting, t);
  const tool = waiting.kind === "asked" ? undefined : waiting.tool;
  const title = [
    said,
    blockedToolTooltip(waiting, said, t),
    t("board.node.blockedFor", { time: elapsed(waiting.since, undefined, now) }),
  ].filter(Boolean).join("\n");
  return (
    <div className="waiting-row" title={title}>
      <span className={`waiting-said${tool ? " mono" : ""}`}>
        {tool ? (tool.preview ? `${tool.name} · ${tool.preview}` : tool.name) : waitingLabel(waiting, t)}
      </span>
    </div>
  );
}
