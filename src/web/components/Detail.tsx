// The detail panel: everything the deck knows about the selected agent.
//
// Moved out of App.tsx, where it sat after `Inner` as a module-level component
// with the row it draws for each tool call. App.tsx mounts it beside the canvas
// while an agent is selected and the panel is open.
import React from "react";

import CostBar from "./CostBar";
import { mcpChipIdentity } from "../tool-skin";
import { DETAIL_CAT_EMOJI, DETAIL_CAT_LABEL, detailCategoryFor, type DetailCategory } from "../detail-category";
// The detail panel used to spell both of these out inline — an elapsed clock a
// tier shorter than the agent card's, and a tool duration a decimal place
// coarser than the dialog the same row opens (#374). See duration.ts.
import { elapsed, toolDuration } from "../duration";
import { injectedPrompt, typedPrompts } from "../injected-prompt";
import { shortModel, modelFamily } from "../model-label";
import { fmtCost } from "../pricing";
import { promptTime } from "../relative-time";
import { recapShown } from "../session-recap";
import { fmtTokens } from "../token-format";
import type { AgentNodeData, ToolCall } from "../types";
import { agentCost, otherModelIds } from "../usage-models";

export default function Detail({
  agent,
  now,
  onOpenTool,
  onShowSummary,
  onExportSession,
  onRemove,
}: {
  agent: AgentNodeData;
  now: number;
  /** Opens the tool modal on one of this agent's calls, named by both (#1483). */
  onOpenTool: (agentId: string, toolId: string) => void;
  onShowSummary?: (sessionId: string) => void;
  onExportSession?: (sessionId: string) => void;
  onRemove?: () => void;
}) {
  // The panel and the card it was opened from are on screen together, so this
  // is the card's clock rather than a second one written out here (#374). The
  // only value that moves is a span under a second, which used to read "0s"
  // beside a card reading "437ms" for the same agent.
  // A floor when the deck did not see the session start, as on the card (#822).
  const elapsedLabel = `${agent.synthetic ? "≥ " : ""}${elapsed(agent.startedAt, agent.endedAt, now)}`;

  const cost = agentCost(agent);
  const hasCost = cost.total > 0;
  const totalTokens = agent.usage.inputTokens + agent.usage.outputTokens;

  // Bucket tools by category for the activity strip
  const catCounts = new Map<DetailCategory, number>();
  for (const t of agent.tools) {
    const c = detailCategoryFor(t.name);
    catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
  }
  const errCount = agent.tools.filter(t => t.ok === false).length;
  const inflight = agent.tools.filter(t => !t.endedAt).length;
  const catEntries = Array.from(catCounts.entries())
    .sort((a, b) => b[1] - a[1]);
  // The one server this agent's MCP chip is counting, when there is one (#489)
  // — ToolBursts' own answer for those calls, so the chip is named and tinted
  // by the function that named and tinted the bubbles rather than by a second
  // rule that agrees with it today. null when the calls span two servers, or
  // when there are none, and the chip stays the generic category chip.
  const mcpChip = catCounts.has("mcp") ? mcpChipIdentity(agent.tools.map(t => t.name)) : null;

  return (
    <>
      <header className="detail-hero">
        <div className="hero-line">
          <span className={`state-pill state-${agent.state}`}>
            {agent.state === "active" ? "live" : agent.state}
          </span>
          <h2 className="hero-title" title={agent.cwd ?? agent.label}>{agent.label}</h2>
        </div>
        <div className="hero-meta">
          {/* The card's word for it, not the reducer's (#833): "root" is
              internal vocabulary, and one thing had two names. */}
          <span className="hero-meta-item">{agent.kind === "root" ? "session" : "subagent"}</span>
          <span className="hero-sep">·</span>
          <span className="hero-meta-item" title={`started ${new Date(agent.startedAt).toLocaleString()}`}>
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
                    ? `${agent.model}\nspend on this panel also covers:\n${others.join("\n")}`
                    : agent.model}
                >{shortModel(agent.model)}{others.length > 0 ? ` +${others.length}` : ""}</span>
              </>
            );
          })()}
        </div>
        {hasCost && (
          <div className="hero-cost">
            <div className="hero-cost-headline">
              <span className="hero-cost-value">{fmtCost(cost.total)}</span>
              <span className="hero-cost-label">spend</span>
            </div>
            <CostBar cost={cost} />
          </div>
        )}
        <div className="hero-actions">
          {agent.kind === "root" && agent.state === "done" && onShowSummary && (
            <button
              type="button"
              className="btn hero-action-btn"
              onClick={() => onShowSummary(agent.sessionId)}
              title="Reopen the end-of-session recap modal"
            >Show recap</button>
          )}
          {onExportSession && (
            <button
              type="button"
              className="btn hero-action-btn"
              onClick={() => onExportSession(agent.sessionId)}
              title="Download this session as JSON"
            >Export JSON</button>
          )}
          {/* Here and not in the topbar, where it was (#1210): beside "zoom to
              agent" it was one stray click from taking a session off the board,
              and at 1440px it wrapped the bar onto a second line. In the panel
              it sits with the other verbs about this one card. Not a danger
              button either — the session list brings it back, and the red stays with Clear. */}
          {onRemove && (
            <button
              type="button"
              className="btn hero-action-btn"
              onClick={onRemove}
              title={agent.kind === "root"
                ? "Take this session's cards off the board (Delete). The session carries on; the session list (L) brings it back"
                : "Take this card and the ones under it off the board (Delete). The session list (L) brings it back"}
            >Remove from board</button>
          )}
        </div>
      </header>

      {/* Claude Code's recap, whole — the one surface with the room for all of
          it. The card clamps it to two lines and the session list to three;
          this is where it is read. Same rule as both, from session-recap.ts. */}
      {(() => {
        const recap = recapShown(agent);
        if (!recap) return null;
        const written = promptTime(recap.at, now);
        return (
          <section className="detail-section">
            <h3>Recap <span className="section-count" title={written.title}>{written.label}</span></h3>
            <p className="detail-recap">{recap.text}</p>
          </section>
        );
      })()}

      {agent.tools.length > 0 && (
        <section className="detail-section">
          <h3>Activity</h3>
          <div className="activity-row">
            <div className="activity-counters">
              <span className="ac-item"><b>{agent.toolCount}</b> calls</span>
              {inflight > 0 && <span className="ac-item ac-live"><b>{inflight}</b> live</span>}
              {errCount > 0 && <span className="ac-item ac-err"><b>{errCount}</b> err</span>}
            </div>
            <div className="cat-strip">
              {catEntries.map(([c, n]) => {
                // Only the mcp chip has a server behind it, and only when every
                // one of its calls went to the same one. The hue rides in as a
                // custom property and styles.css composes the colour — the
                // lightness belongs to the theme, not to JS (#330).
                const one = c === "mcp" ? mcpChip : null;
                const hue = one?.hue;
                const calls = `${n} ${DETAIL_CAT_LABEL[c]} call${n === 1 ? "" : "s"}`;
                return (
                  <span
                    className={`cat-chip cat-${c}${hue != null ? " mcp-hue" : ""}`}
                    key={c}
                    style={hue != null ? { "--mcp-hue": hue } as React.CSSProperties : undefined}
                    title={one ? `${calls}, all to ${one.label}` : calls}
                  >
                    {/* The category as a word at rest (#841): an emoji and a
                        count said nothing without a hover, and a title never
                        reaches a keyboard or touch reader. The word is the
                        key, the count its value; the emoji is decoration now. */}
                    <span className="cat-emoji" aria-hidden>{DETAIL_CAT_EMOJI[c]}</span>
                    <span className="cat-name">{DETAIL_CAT_LABEL[c]}</span>
                    <span className="cat-count">{n}</span>
                    {/* The words the tint cannot be trusted to carry alone. */}
                    {one && <span className="cat-server">{one.label}</span>}
                  </span>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {totalTokens > 0 && (
        <section className="detail-section">
          <h3>Tokens</h3>
          <div className="tokens-grid">
            {/* The usage panel's format, not a grouped integer (#835): side by
                side, 111,053,708 and 177.08M read as two kinds of measure. The
                exact count stays one hover away. */}
            <div><span className="k">in</span><b title={agent.usage.inputTokens.toLocaleString()}>{fmtTokens(agent.usage.inputTokens)}</b></div>
            <div><span className="k">out</span><b title={agent.usage.outputTokens.toLocaleString()}>{fmtTokens(agent.usage.outputTokens)}</b></div>
            <div><span className="k">cache r</span><b title={agent.usage.cacheReadTokens.toLocaleString()}>{fmtTokens(agent.usage.cacheReadTokens)}</b></div>
            <div><span className="k">cache c</span><b title={agent.usage.cacheCreateTokens.toLocaleString()}>{fmtTokens(agent.usage.cacheCreateTokens)}</b></div>
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3>Identity</h3>
        <div>
          {agent.cwd && <div className="row"><span className="k">cwd</span><span className="v" title={agent.cwd}>{agent.cwd}</span></div>}
          <div className="row"><span className="k">session</span><span className="v">{agent.sessionId.slice(0, 12)}…</span></div>
          {agent.parentId && <div className="row"><span className="k">parent</span><span className="v">{agent.parentId.slice(0, 12)}…</span></div>}
        </div>
      </section>

      {agent.prompts.length > 0 && (
        <section className="detail-section">
          {/* The count is what was typed (#834). A background task's notice
              is listed as the event it is, collapsed, in its place in time. */}
          <h3>Prompts <span className="section-count">{typedPrompts(agent.prompts).length}</span></h3>
          <div className="prompts">
            {agent.prompts.slice().reverse().map((pr, i) => {
              const t = promptTime(pr.at, now);
              const injected = injectedPrompt(pr.text);
              if (injected) {
                return (
                  <details className="prompt-entry prompt-injected" key={i}>
                    <summary>
                      <span className="prompt-time" title={t.title}>{t.label}</span>
                      <span className="prompt-injected-label">{injected.label}</span>
                    </summary>
                    {injected.detail && <div className="prompt-injected-detail">{injected.detail}</div>}
                  </details>
                );
              }
              return (
                <div className="prompt-entry" key={i}>
                  <div className="prompt-time" title={t.title}>{t.label}</div>
                  <div className="prompt-text">{pr.text}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3>Tool calls <span className="section-count">{agent.tools.length}</span></h3>
        {agent.tools.length === 0 && <div className="empty">No tool calls yet.</div>}
        <div>
          {agent.tools.slice().reverse().map(t => (
            <ToolRow key={t.id} t={t} onClick={() => onOpenTool(agent.id, t.id)} />
          ))}
        </div>
      </section>
    </>
  );
}

/** What a tool call's outcome is called, in the words this app already prints
 *  for one: ToolModal writes `in-flight…` where the duration goes while a call
 *  is open and tags its Response section `error` when it failed. A tool call is
 *  not a session, so this is deliberately not stateLabel's vocabulary — `err`
 *  is the word on a session card and `error` is the word on a tool, and those
 *  two surfaces already said it that way before #373 touched either. */
const TOOL_STATUS_LABEL = { inflight: "in-flight", done: "done", err: "error" } as const;

// No `now` prop any more. It only ever fed the duration, and the duration only
// ever used it on the branch it then threw away — an open call prints a
// sentinel, and a finished one carries both of its own timestamps. The row is
// not memoised, so the tick that re-renders the panel still re-renders it.
function ToolRow({ t, onClick }: { t: ToolCall; onClick: () => void }) {
  const status = t.endedAt == null ? "inflight" : t.ok === false ? "err" : "done";
  // This row is the button that opens ToolModal for this exact call, and the
  // two used to round the same milliseconds differently — "1.2s" here and
  // "1.24s" one click later (#374). The sentinel is the only thing that still
  // differs, because a list cell has no room for the word the dialog writes.
  const durLabel = toolDuration(t, "…");
  return (
    <button className="tool clickable" title={t.inputPreview || t.name} onClick={onClick}>
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
        <span className="vis-hidden">{TOOL_STATUS_LABEL[status]}</span>
        {t.name}
      </span>
      <span style={{ color: "var(--muted)" }}>{durLabel}</span>
    </button>
  );
}
