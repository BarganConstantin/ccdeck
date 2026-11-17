// The detail panel: everything the deck knows about the selected agent.
//
// Moved out of App.tsx, where it sat after `Inner` as a module-level component
// with the row it draws for each tool call. App.tsx mounts it beside the canvas
// while an agent is selected and the panel is open.
import React, { useId, useRef, useState, type ReactNode } from "react";
import SessionNameField, { RenameGlyph, useRenaming } from "./SessionNameField";
import AnchoredPopover from "./AnchoredPopover";
import { loadInspectorDetailsOpen, saveInspectorDetailsOpen } from "../inspector-tab";
import { renameFacts } from "../session-rename";
import { agentKindLabel, categoryLabel } from "../agent-copy";
import { isAlarming } from "../ambient-counts";
import { cardState } from "../node-face";
import { useLanguage, useT } from "../i18n";

import CostBar from "./CostBar";
import { mcpChipIdentity } from "../tool-skin";
import { detailCategoryFor, type DetailCategory } from "../detail-category";
import type { InspectorStatus } from "../inspector-state";
import { argIsPath, callArg } from "../inspector-time";
import { KitIcon, KitStateGlyph } from "./kit-icons";
import PathText from "./PathText";
// The detail panel used to spell both of these out inline — an elapsed clock a
// tier shorter than the agent card's, and a tool duration a decimal place
// coarser than the dialog the same row opens (#374). See duration.ts.
import { elapsed, toolDuration } from "../duration";
import { typedPrompts } from "../injected-prompt";
import { sessionNames, startedHover } from "../rail-row-copy";
import { modelChipText, modelChipTitle, modelFamily } from "../model-label";
import { fmtCost } from "../pricing";
import { promptTime } from "../relative-time";
import { noteSource, noteTag, promptLine, sessionNoteShown, type SessionNote } from "../session-note";
import { fmtTokens } from "../token-format";
import type { AgentNodeData, PlanStatus, PromptEntry, ToolCall } from "../types";
import { planSummary } from "../agent-plan";
import { agentCost, otherModelIds } from "../usage-models";
import { withKey } from "../single-key-shortcuts";
// Continue, for a turn that stopped on a login or a usage limit (#2193).
import { StopContinueSection } from "./StopContinue";

/** The title, with the Rename beside it for a session the deck can name
 *  (internal #101). Its own component, holding the renaming, because Detail
 *  calls no hook: the field takes the title's place, and a selection that
 *  moves to another session closes it unsaved. */
function HeroTitle({ agent, now }: { agent: AgentNodeData; now: number }) {
  const t = useT();
  const back = useRef<HTMLButtonElement>(null);
  const rename = renameFacts(agent);
  const renaming = useRenaming(rename?.sessionId, back);
  return (
    <>
      {/* A session by the title every surface names it by (sessionNames);
          its folder, when it started and its id's tail in the hover. */}
      {renaming.on && rename
        ? <SessionNameField facts={rename} place="hero" onDone={renaming.done} />
        : (
          <h2 className="hero-title" data-renamable={rename ? "" : undefined} onDoubleClick={rename ? renaming.start : undefined}
            title={agent.kind === "root" ? [agent.cwd ?? agent.label, startedHover(agent.startedAt, agent.sessionId, undefined, now, t)].join("\n") : agent.cwd ?? agent.label}>
            {agent.kind === "root" ? sessionNames(agent).title : agent.label}
          </h2>
        )}
      {rename && !renaming.on && (
        <button ref={back} type="button" className="glyph-btn hero-rename"
          aria-label={t("board.rename.action")} title={t("board.rename.tip")} onClick={renaming.start}>
          <RenameGlyph />
        </button>
      )}
    </>
  );
}

/** The one next step the Inspector offers for the agent it is about (V4
 *  top-10, the Inspector's next step): the button under the title block.
 *
 *  A session's root only: a subagent has no terminal of its own, and keeps
 *  what it had (nothing). None where the deck cannot open a terminal at all
 *  (`canOpen`: the Command Panel is off, or this platform has none), which is
 *  where a card's click and Enter on a Sessions row open none either.
 *
 *  - "answer": the session is stopped on a person (isAlarming, the rule the
 *    card, the top bar's count and the waiting row use). Its question is in
 *    its terminal, which is what the stage shows first (Term, every way in),
 *    so Answer puts it there with the keys in its pane. It stays for the
 *    session the stage already shows: there the same press gives that pane
 *    the keys, which is the stage's own "↵ type here".
 *  - "open": any other state (working, ready, done, failed). Not for the
 *    session the stage already shows, which is beside the Inspector with its
 *    "↵ type here" in its bar; a second way to the same pane is clutter. */
export type NextStep = "answer" | "open";
export function inspectorNextStep(
  agent: Pick<AgentNodeData, "kind" | "sessionId" | "waiting">,
  deck: { canOpen: boolean; stageSession: string | null },
): NextStep | null {
  if (agent.kind !== "root" || !deck.canOpen) return null;
  if (isAlarming(agent.waiting)) return "answer";
  return deck.stageSession === agent.sessionId ? null : "open";
}

export default function Detail({
  agent,
  now,
  onOpenTool,
  onShowSummary,
  onOpenSession,
  stageSession = null,
  onExportSession,
  onRemove,
  singleKeys = true,
  status,
}: {
  /** The state the title names (inspector-state.ts): the pane's own sentence. */
  status?: InspectorStatus;
  agent: AgentNodeData;
  now: number;
  /** Opens the tool modal on one of this agent's calls, named by both (#1483). */
  onOpenTool: (agentId: string, toolId: string) => void;
  onShowSummary?: (sessionId: string) => void;
  /** Puts a session on the stage with the keys in its pane: App's
   *  openSessionWithKeys, the very press Enter on a Sessions row makes, and
   *  what a card's click does on the Board. Absent where the deck has no
   *  terminal, and then no Answer or Open is drawn. */
  onOpenSession?: (sessionId: string) => void;
  /** The session the stage shows now (the pane in focus), or null. */
  stageSession?: string | null;
  onExportSession?: (sessionId: string) => void;
  onRemove?: () => void;
  /** Whether L reopens the session list (Settings › General's switch), so the
   *  Remove item's tooltip names it only then. A prop rather than a hook:
   *  this component calls none that cannot run outside React (tests call it
   *  as a plain function), so what keeps state is a child of its own. */
  singleKeys?: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  // The panel and the card it was opened from are on screen together, so this
  // is the card's clock rather than a second one written out here (#374). The
  // only value that moves is a span under a second, which used to read "0s"
  // beside a card reading "437ms" for the same agent.
  // A floor when the deck did not see the session start, as on the card (#822).
  const elapsedLabel = `${agent.synthetic ? "≥ " : ""}${elapsed(agent.startedAt, agent.endedAt, now)}`;

  const cost = agentCost(agent);
  const hasCost = cost.total > 0;
  const totalTokens = agent.usage.inputTokens + agent.usage.outputTokens;

  const note = sessionNoteShown(agent);
  const typed = typedPrompts(agent.prompts);
  // The prompt Now already says is not listed again under it.
  const earlier = promptsNotSaid(typed, note);
  // A plain session's root is what the panel is about, so "session" would say
  // nothing there; a subagent or a Codex child keeps its kind.
  const showKind = agentKindLabel(agent, t) !== t("board.kind.session");

  return (
    <>
      <header className="detail-hero">
        <div className="hero-line">
          {/* The state is the kit's 14px glyph (V4's Figma), and its words are the
              pane's own sentence for a session ("ready · for a first prompt"), from
              inspector-state.ts, so the Inspector never says Working beside a
              rail and a pane that say ready. Without a status given (a caller
              with no board) it is the word the card wears. */}
          <span className="hero-state" role="img" data-state={status?.glyph ?? "idle"}
            aria-label={status?.phrase ?? cardState(agent).word} title={status?.phrase ?? cardState(agent).word}>
            <KitStateGlyph name={status?.glyph ?? (agent.state === "active" ? "working" : agent.state === "err" ? "error" : "done")} />
          </span>
          {/* A session by the title every surface names it by (sessionNames);
              its folder, when it started and its id's tail in the hover. */}
          <HeroTitle agent={agent} now={now} />
          {(onExportSession || onRemove) && (
            <DetailActions agent={agent} onExportSession={onExportSession} onRemove={onRemove} singleKeys={singleKeys} />
          )}
        </div>
        <div className="hero-meta">
          {/* The card's word for it, not the reducer's (#833): "root" is
              internal vocabulary, and one thing had two names. */}
          {showKind && <><span className="hero-meta-item">{agentKindLabel(agent, t)}</span><span className="hero-sep">·</span></>}
          {/* The state in words, said once: the glyph before the name already
              names it for a screen reader. */}
          <span className="hero-meta-item" aria-hidden="true">{status?.phrase ?? cardState(agent).word.toLowerCase()}</span>
          <span className="hero-sep">·</span>
          <span className="hero-meta-item" title={t("board.detail.started", { time: new Date(agent.startedAt).toLocaleString(language) })}>
            {elapsedLabel}
          </span>
          {agent.model && (() => {
            // Same chip, same rule, as the card this panel was opened from —
            // the current model by name, and a count of the others the figure
            // above it also covers (#686). Two surfaces showing one fact have
            // to show it the same way, or the panel reads as a correction of
            // the card rather than a larger view of it.
            const others = otherModelIds(agent);
            return (
              <>
                <span className="hero-sep">·</span>
                <span
                  className="model-chip"
                  // From the model, never from the title beside it: since #686
                  // that title lists every model this panel's spend covers, and
                  // the sheet matched it by substring.
                  data-family={modelFamily(agent.model)}
                  title={others.length > 0
                    ? `${modelChipTitle(agent.model, agent.effort)}\n${t("board.detail.modelCovers")}\n${others.join("\n")}`
                    : modelChipTitle(agent.model, agent.effort)}
                >{modelChipText(agent.model, agent.effort)}{others.length > 0 ? ` +${others.length}` : ""}</span>
              </>
            );
          })()}
        </div>
        {/* The figure and its word. Its split by kind (the bar) is under
            Details now, with the token rows that key its colours: a bar of
            four colours with no legend was read as decoration (V4 top-10 #6). */}
        {hasCost && (
          <div className="hero-cost">
            <div className="hero-cost-headline">
              <span className="hero-cost-value">{fmtCost(cost.total)}</span>
              <span className="hero-cost-label">{t("board.detail.spend")}</span>
            </div>
          </div>
        )}
      </header>

      {/* THE NEXT STEP, right under the title block (V4 top-10, the
          Inspector's next step), so a Tab from the ⋯ reaches it first. One
          button for the session's state (inspectorNextStep): Answer for a
          session stopped on a person, the only Primary in the body; Open,
          Quiet, for any other. A finished session keeps Show recap beside it,
          Quiet: Claude Code's recap, which it reopens. At most the two; Export
          and Remove stay the title block's ⋯ (V4 top-10 #6), and with neither
          to offer the row is not drawn, never empty. */}
      {(() => {
        const step = inspectorNextStep(agent, { canOpen: onOpenSession !== undefined, stageSession });
        const recap = agent.kind === "root" && agent.state === "done" ? onShowSummary : undefined;
        if (!step && !recap) return null;
        // The name the title above prints, so a screen reader that lands on
        // the button hears whom it answers or opens, as the stage's keys bar
        // names the session its Answer is for.
        const name = sessionNames(agent).title;
        const answer = step === "answer";
        return (
          <div className="hero-actions">
            {step && onOpenSession && (
              <button
                type="button"
                className={answer ? "btn primary" : "btn"}
                aria-label={answer ? t("board.keys.answerLabel", { name }) : t("board.stage.open", { name })}
                onClick={() => onOpenSession(agent.sessionId)}
              >{answer ? t("board.keys.answer") : t("board.quick.verb.open")}</button>
            )}
            {recap && (
              <button
                type="button"
                className="btn"
                onClick={() => recap(agent.sessionId)}
                title={t("board.detail.recapTitle")}
              >{t("board.detail.recap")}</button>
            )}
          </div>
        );
      })()}

      {/* Continue a turn that stopped on an expired login or a usage limit
          (#2193): the button for a background session, what to type for one
          in a terminal, and what the last continue did. Above the note, which
          says why it stopped. */}
      <StopContinueSection agent={agent} />

      {/* The session's note, whole — the one surface with the room for all of
          it. The note on the canvas clamps it and the session list cuts it to
          three lines; this is where it is read. Same rule as both, from
          session-note.ts: what the session is doing or what came of it, and
          Claude Code's recap once that arrives. The heading says which. */}
      {(() => {
        if (!note) return null;
        const written = promptTime(note.at, now);
        const heading = note.kind === "recap" ? t("board.detail.recapHeading") : noteTag(note.kind).replace(/^./, c => c.toUpperCase());
        return (
          <section className="detail-section">
            <h3>{heading} <span className="section-count" title={written.title}>{written.label}</span></h3>
            <p className="detail-recap" title={noteSource(note)}>{note.text}</p>
            {note.reply && <p className="detail-recap detail-note-reply">{t("board.detail.suggestedReply", { reply: note.reply })}</p>}
          </section>
        );
      })()}

      {/* The agent's plan, every step (#2157) — the card and the session list
          carry one line of it, and this is where it is read. In the agent's
          order and its words; the step under way in the words it uses while
          doing it. Each step has a mark and a word: the mark is drawn, the word
          is the screen reader's, and "now" is also printed on the step under
          way, which is the one a reader looks for. */}
      {(() => {
        const plan = planSummary(agent.plan);
        if (!plan || !agent.plan) return null;
        return (
          <section className="detail-section">
            <h3>
              {t("board.detail.plan")}{" "}
              <span className="section-count" aria-hidden>{plan.done}/{plan.total}</span>
              <span className="vis-hidden">{t("board.detail.planDone", { done: plan.done, total: plan.total })}</span>
            </h3>
            {agent.plan.note && <p className="detail-plan-note">{agent.plan.note}</p>}
            <ol className="plan-list">
              {agent.plan.items.map((item, k) => (
                <li key={item.id ?? `${k}:${item.text}`} className="plan-item" data-status={item.status}>
                  <span className="plan-mark" aria-hidden>
                    <KitStateGlyph name={item.status === "completed" ? "done" : item.status === "in_progress" ? "working" : "idle"} />
                  </span>
                  <span className="vis-hidden">{t(PLAN_WORD[item.status])}{t("board.detail.colon")}</span>
                  <span className="plan-text">{item.status === "in_progress" && item.active ? item.active : item.text}</span>
                  {item.status === "in_progress" && <span className="plan-now" aria-hidden>{t("board.detail.now")}</span>}
                </li>
              ))}
            </ol>
          </section>
        );
      })()}

      {earlier.length > 0 && (
        <section className="detail-section">
          {/* What a person typed, listed and counted (#834). A background
              task's notice arrives on the same hook and is neither: it is not
              a prompt (owner's critique, 2026-11-11). The keys come from the
              whole typed list, so leaving the newest out moves no entry. */}
          <h3>{earlier.length < typed.length ? t("board.detail.earlierPrompts") : t("board.detail.prompts")} <span className="section-count">{earlier.length}</span></h3>
          <div className="prompts">
            {promptKeys(typed).filter(({ pr }) => earlier.includes(pr)).reverse().map(({ pr, key }) => {
              const when = promptTime(pr.at, now);
              return (
                <div className="prompt-entry" key={key}>
                  <div className="prompt-time" title={when.title}>{when.label}</div>
                  <div className="prompt-text">{pr.text}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* EVERYTHING ELSE, ONE PRESS AWAY (V4 top-10 #6). What is above is
          what a person reads: the state, the note, the plan, what they typed.
          What is below is the record: the spend by kind with its token
          counts, where the session runs and its ids, and every tool call.
          It is all still here, behind one quiet row, shut until someone opens
          it and then as they last left it. */}
      <DetailMore calls={Math.max(agent.toolCount, agent.tools.length)}>
        {(hasCost || totalTokens > 0) && (
          <section className="detail-section">
            <h3>{t("board.detail.tokens")}</h3>
            {/* The split of the spend; CostBar draws nothing for no spend. */}
            <CostBar cost={cost} />
            {totalTokens > 0 && (
              <div className="tokens-grid">
                {/* The usage panel's format, not a grouped integer (#835): side by
                    side, 111,053,708 and 177.08M read as two kinds of measure. The
                    exact count stays one hover away. Each label leads with a
                    swatch in its band's colour, so the rows are the bar's key. */}
                <div><span className="k tk-key tk-in">{t("board.tokens.in")}</span><b title={agent.usage.inputTokens.toLocaleString()}>{fmtTokens(agent.usage.inputTokens)}</b></div>
                <div><span className="k tk-key tk-out">{t("board.tokens.out")}</span><b title={agent.usage.outputTokens.toLocaleString()}>{fmtTokens(agent.usage.outputTokens)}</b></div>
                <div><span className="k tk-key tk-cr">{t("board.tokens.cacheR")}</span><b title={agent.usage.cacheReadTokens.toLocaleString()}>{fmtTokens(agent.usage.cacheReadTokens)}</b></div>
                <div><span className="k tk-key tk-cw">{t("board.tokens.cacheC")}</span><b title={agent.usage.cacheCreateTokens.toLocaleString()}>{fmtTokens(agent.usage.cacheCreateTokens)}</b></div>
              </div>
            )}
          </section>
        )}

        <section className="detail-section">
          <h3>{t("board.detail.identity")}</h3>
          <div>
            {/* From "~", and cut in the middle so the folder's own name stays. */}
            {agent.cwd && <div className="row"><span className="k">cwd</span><PathText className="v" path={agent.cwd} /></div>}
            <div className="row"><span className="k">{t("board.kind.session")}</span><span className="v">{agent.sessionId.slice(0, 12)}…</span></div>
            {agent.parentId && <div className="row"><span className="k">{t("board.detail.parent")}</span><span className="v">{agent.parentId.slice(0, 12)}…</span></div>}
          </div>
        </section>

        {/* Keyed by the agent, so a filter chosen for one is not carried to the next. */}
        <ToolCalls key={agent.id} agent={agent} onOpenTool={onOpenTool} />
      </DetailMore>
    </>
  );
}

/** The quiet row that keeps the record shut: a native disclosure, so Enter,
 *  Space and a screen reader's "collapsed" come with it. Open or shut is this
 *  viewer's, kept across the sessions they select and across reloads
 *  (inspector-tab.ts), and shut until they first open it. Its own component
 *  because tests call Detail as a plain function, where a state hook cannot
 *  run. */
export function DetailMore({ calls, children }: { calls: number; children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(loadInspectorDetailsOpen);
  return (
    <details
      className="detail-more"
      open={open}
      onToggle={e => {
        // The browser has already opened or shut it; this keeps React and the
        // store in step. A details drawn open fires one toggle as it mounts,
        // which changes nothing.
        const next = e.currentTarget.open;
        if (next === open) return;
        setOpen(next);
        saveInspectorDetailsOpen(next);
      }}
    >
      <summary>
        <KitIcon name="chevron-right" className="detail-more-chev" />
        <span>{t("common.details")}</span>
        {/* What is inside, in the words the activity spark uses: a session
            that has run tools says so without being opened. */}
        {calls > 0 && <span className="detail-more-count">{t("board.spark.tools", { count: calls })}</span>}
      </summary>
      <div className="detail-more-body">{children}</div>
    </details>
  );
}

/** Export JSON and Remove from board, in a menu off the title block's ⋯ (V4
 *  top-10 #6). They were two of three outlined buttons of equal weight at the
 *  foot of the body, under the whole tool-call list; they are verbs about the
 *  card the title names, so they hang off its line, out of the reading. The
 *  menu is AnchoredPopover's, as the stage's ⋯ and a panel's ⓘ are: arrows,
 *  Escape, Tab out and the focus hand-back come with it. */
export function DetailActions({ agent, onExportSession, onRemove, singleKeys }: {
  agent: AgentNodeData;
  onExportSession?: (sessionId: string) => void;
  onRemove?: () => void;
  singleKeys: boolean;
}) {
  const t = useT();
  const base = useId();
  const id = `${base}-more`;
  const menuId = `${base}-more-menu`;
  // Open at the first item, or (ArrowUp on the button) at the last.
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const open = menu !== null;
  const more = t("accounts.row.more");
  // Focus goes back to the ⋯ before the menu closes, so whatever the item
  // does next (a download, the card leaving the board) starts from there.
  const choose = (act: () => void) => {
    document.getElementById(id)?.focus();
    setMenu(null);
    window.requestAnimationFrame(act);
  };
  return (
    <>
      <button
        type="button"
        id={id}
        className="glyph-btn hero-more"
        aria-label={more}
        title={more}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onKeyDown={e => {
          // Down opens at the first item and Up at the last, the way a native
          // menu button does. Enter and Space are the click.
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setMenu(e.key === "ArrowUp" ? "last" : "first");
        }}
        onClick={() => setMenu(open ? null : "first")}
      >
        <KitIcon name="more" />
      </button>
      {open && (
        <AnchoredPopover anchorId={id} id={menuId} className="ap-pop" role="menu"
          labelledBy={id} start={menu} onClose={() => setMenu(null)}>
          {onExportSession && (
            <button type="button" role="menuitem" className="ap-menu-item"
              title={t("board.detail.exportTitle")}
              onClick={() => choose(() => onExportSession(agent.sessionId))}
            >{t("board.detail.export")}</button>
          )}
          {/* In the card's own menu and not in the topbar, where it was
              (#1210): beside "zoom to agent" it was one stray click from
              taking a session off the board. Not a danger item either — the
              session list brings it back, and the red stays with Clear. */}
          {onRemove && (
            <button type="button" role="menuitem" className="ap-menu-item"
              title={agent.kind === "root"
                ? t("board.detail.removeRoot", { list: withKey(t("board.detail.listLower"), "L", singleKeys) })
                : t("board.detail.removeSub", { list: withKey(t("board.detail.listUpper"), "L", singleKeys) })}
              onClick={() => choose(onRemove)}
            >{t("board.detail.remove")}</button>
          )}
        </AnchoredPopover>
      )}
    </>
  );
}

/** The typed prompts to list: all of them, less the newest when the note above
 *  them is saying it (a turn the model has not answered yet says its prompt). */
export function promptsNotSaid(typed: readonly PromptEntry[], note: Pick<SessionNote, "text"> | null): PromptEntry[] {
  let newest: PromptEntry | null = null;
  for (const p of typed) if (!newest || p.at > newest.at) newest = p;
  if (!note || !newest || promptLine(newest.text) !== note.text) return typed.slice();
  return typed.filter(p => p !== newest);
}

/** The calls, in one section: how many (live and failed beside the count), a
 *  chip per kind that keeps the list to that kind until it is pressed again,
 *  and the list, newest first. The counts are over every call (#1842); the
 *  list holds the calls the deck keeps, so a list shorter than its count says
 *  why. */
export function ToolCalls({ agent, onOpenTool }: { agent: AgentNodeData; onOpenTool: (agentId: string, toolId: string) => void }) {
  const t = useT();
  const [kind, setKind] = useState<DetailCategory | null>(null);
  const catCounts = new Map<DetailCategory, number>();
  for (const [name, n] of agent.toolCountByName ?? []) {
    const c = detailCategoryFor(name);
    catCounts.set(c, (catCounts.get(c) ?? 0) + n);
  }
  const errCount = agent.toolErrorCount ?? 0;
  const inflight = agent.tools.filter(call => !call.endedAt).length;
  const catEntries = Array.from(catCounts.entries())
    .sort((a, b) => b[1] - a[1]);
  // The one server this agent's MCP chip is counting, when there is one (#489)
  // — ToolBursts' own answer for those calls, so the chip is named and tinted
  // by the function that named and tinted the bubbles rather than by a second
  // rule that agrees with it today. null when the calls span two servers, or
  // when there are none, and the chip stays the generic category chip. Asked
  // of every tool the chip counts, not only the window's.
  const mcpChip = catCounts.has("mcp") ? mcpChipIdentity(agent.toolCountByName?.keys() ?? []) : null;
  const total = Math.max(agent.toolCount, agent.tools.length);
  const listed = kind ? agent.tools.filter(call => detailCategoryFor(call.name) === kind) : agent.tools;
  const expected = kind ? (catCounts.get(kind) ?? 0) : total;
  return (
    <section className="detail-section">
      <h3>
        {t("board.detail.toolCalls")} <span className="section-count">{total}</span>
        {(inflight > 0 || errCount > 0) && (
          <span className="activity-counters">
            {inflight > 0 && <span className="ac-item ac-live"><b>{inflight}</b> {t("board.state.live")}</span>}
            {errCount > 0 && <span className="ac-item ac-err"><b>{errCount}</b> {t("board.meta.err")}</span>}
          </span>
        )}
      </h3>
      {catEntries.length > 0 && (
        <div className="cat-strip" role="group" aria-label={t("board.detail.kinds")}>
          {catEntries.map(([c, n]) => (
            <button key={c} type="button" className="call-kind" aria-pressed={kind === c} onClick={() => setKind(k => (k === c ? null : c))}>
              <CatChip c={c} n={n} one={c === "mcp" ? mcpChip : null} />
            </button>
          ))}
        </div>
      )}
      {agent.tools.length === 0 && <div className="empty">{t("board.detail.noTools")}</div>}
      <div>
        {listed.slice().reverse().map(call => (
          <ToolRow key={call.id} call={call} cwd={agent.cwd} onClick={() => onOpenTool(agent.id, call.id)} />
        ))}
      </div>
      {agent.tools.length > 0 && listed.length < expected && <div className="empty">{t("board.detail.olderNotListed")}</div>}
    </section>
  );
}

/** One kind's chip: its word and its count ("file 18"), and the server when
 *  every MCP call went to one. */
function CatChip({ c, n, one }: { c: DetailCategory; n: number; one: ReturnType<typeof mcpChipIdentity> }) {
  const t = useT();
  // Only the mcp chip has a server behind it, and only when every one of its
  // calls went to the same one. The hue rides in as a custom property and
  // styles.css composes the colour — the lightness belongs to the theme, not
  // to JS (#330).
  const hue = one?.hue;
  const calls = t("board.detail.catCalls", { count: n, cat: categoryLabel(c, t) });
  return (
    <span
      className={`cat-chip cat-${c}${hue != null ? " mcp-hue" : ""}`}
      style={hue != null ? { "--mcp-hue": hue } as React.CSSProperties : undefined}
      title={one ? t("board.detail.catAllTo", { calls, server: one.label }) : calls}
    >
      {/* The category as a word at rest (#841): a count said nothing without a
          hover, and a title never reaches a keyboard or touch reader. The word
          is the key, the count its value ("file 18"; V4's Figma draws no
          emoji). */}
      <span className="cat-name">{categoryLabel(c, t)}</span>
      <span className="cat-count">{n}</span>
      {/* The words the tint cannot be trusted to carry alone. */}
      {one && <span className="cat-server">{one.label}</span>}
    </span>
  );
}

/** Each prompt with the key it is rendered under: the moment it was submitted,
 *  and a count after it for a second entry filed at the same millisecond.
 *
 *  Not its place in the list (#1808). The list is drawn newest first, so a new
 *  prompt took place 0 and moved every other entry down one, and React handed
 *  each entry's DOM node to a different prompt — a background task's notice is
 *  an uncontrolled <details>, so the one the user had opened shut, and the one
 *  that slid into its place opened. Not the index in `prompts` either: the list
 *  is kept in time order, so a late copy of an earlier prompt is filed among
 *  the others and moves every index after it. */
function promptKeys(prompts: readonly PromptEntry[]): { pr: PromptEntry; key: string }[] {
  const atSameMoment = new Map<number, number>();
  return prompts.map(pr => {
    const n = atSameMoment.get(pr.at) ?? 0;
    atSameMoment.set(pr.at, n + 1);
    return { pr, key: n === 0 ? String(pr.at) : `${pr.at}:${n}` };
  });
}

/** What a tool call's outcome is called, in the words this app already prints
 *  for one: ToolModal writes `in-flight…` where the duration goes while a call
 *  is open and tags its Response section `error` when it failed. A tool call is
 *  not a session, so this is deliberately not stateLabel's vocabulary — `err`
 *  is the word on a session card and `error` is the word on a tool, and those
 *  two surfaces already said it that way before #373 touched either. */
const TOOL_STATUS_LABEL = { inflight: "board.toolStatus.inflight", done: "board.toolStatus.done", err: "board.toolStatus.err" } as const;

// No `now` prop any more. It only ever fed the duration, and the duration only
// ever used it on the branch it then threw away — an open call prints a
// sentinel, and a finished one carries both of its own timestamps. The row is
// not memoised, so the tick that re-renders the panel still re-renders it.
function ToolRow({ call, cwd, onClick }: { call: ToolCall; cwd?: string; onClick: () => void }) {
  const t = useT();
  const status = call.endedAt == null ? "inflight" : call.ok === false ? "err" : "done";
  // This row is the button that opens ToolModal for this exact call, and the
  // two used to round the same milliseconds differently — "1.2s" here and
  // "1.24s" one click later (#374). The sentinel is the only thing that still
  // differs, because a list cell has no room for the word the dialog writes.
  const durLabel = toolDuration(call, "…");
  // What it ran on, never the JSON it was sent as (inspector-time.ts).
  const arg = callArg(call);
  // A path is read from the session's folder and cut in the middle, so the rows
  // under one long folder no longer all read the same; the row's hover has it whole.
  const path = argIsPath(call, arg);
  return (
    <button className="tool clickable" title={path ? arg : call.inputPreview || call.name} onClick={onClick}>
      <span className="name">
        {/* The dot said nothing here — an empty <span> that was not even marked
            decorative — so a failed call and a finished one both announced
            "Bash 1.24s" and differed by red against green, the one pair a
            red-green CVD cannot separate at all (#373). The dot is explicitly
            decoration now, because the stylesheet draws its ✓ and × with
            `content:` and generated content IS spoken by some readers: without
            aria-hidden the row would say the mark and then the word.
            The word leads, where the dot is, for the reason the session list
            gives — the accessible name is the contents in DOM order, so
            "error Bash 1.24s" is read in the order it is seen. */}
        <span className={`status-dot ${status}`} aria-hidden />
        <span className="vis-hidden">{t(TOOL_STATUS_LABEL[status])}</span>
        <span className="tool-name">{call.name}</span>
        {arg && (path ? <PathText className="tool-arg" path={arg} cwd={cwd} hint={false} /> : <span className="tool-arg">{arg}</span>)}
      </span>
      <span className="tool-dur">{durLabel}</span>
    </button>
  );
}

/** What each step's mark says, for a screen reader. */
const PLAN_WORD: Record<PlanStatus, "board.state.done" | "board.detail.now" | "board.detail.todo"> = { completed: "board.state.done", in_progress: "board.detail.now", pending: "board.detail.todo" };
