// Historical usage modal, powered by the `ccusage` CLI (via /api/ccusage).
// Shows daily cost + token usage as a stacked bar chart (one bar per day,
// segmented by model), a totals strip, a model legend, and a click-to-select
// per-day detail panel. No charting library — bars are plain divs.
//
// Inspired by the task-board project's ccusage modal, reimplemented in
// agent-dag's idiom (plain CSS, no Tailwind/framer-motion).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { fmtCost } from "../pricing";
import { commandOutput, explainCcusageFailure } from "../admin-failure";
import { usageView } from "../usage-view";
import { fmtTokens } from "../token-format";
import { shortModel } from "../model-label";
import { agentLabel, usageSubtitle } from "../provider-copy";
import { agentColor, agentTotals, sharePct } from "../usage-agents";
import type { Providers } from "../providers";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { useFocusRescue } from "./use-focus-rescue";
import { selfPressProps } from "../panel-press";
import { byCost, dayLabelStep, historyTotals, legendOf, modelColor, percentOf } from "../usage-history";
// The ccusage run behind the chart, and the rules for which answer it keeps.
import { useCcusage } from "../use-ccusage";
import UsageDayDetail from "./UsageDayDetail";
import { RefreshGlyph } from "./action-glyphs";

const PRESETS = [7, 14, 30, 90];

// ── component ─────────────────────────────────────────────────────────────
interface Props {
  onClose: () => void;
  /** Which CLIs this deck watches, from /api/health (#402). Used for the
   *  subtitle, and only until a run has landed — see usageSubtitle, which
   *  prefers what ccusage actually read over what the deck was started for. */
  providers: Providers;
}

export default function UsageHistoryModal({ onClose, providers }: Props) {
  const [rangeDays, setRangeDays] = useState(30);
  const [selected, setSelected] = useState<string | null>(null);
  const { landed, loading, reload } = useCcusage(rangeDays);

  // The × rather than the first control: this header opens with a four-button
  // range strip, and a dialog that hands the keyboard "7d" as its greeting
  // reads as a setting to change rather than a thing to read or leave. Every
  // other modal on the deck starts on its dismiss control too.
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  const scrimPress = useScrimDismiss(onClose);

  const view = usageView({
    loading,
    want: rangeDays,
    answer: landed && { range: landed.range, ok: landed.resp.ok === true, days: landed.resp.days?.length ?? 0 },
  });
  const [pageHidden, setPageHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    if (view.phase !== "busy") return;
    const changed = () => setPageHidden(document.hidden);
    changed();
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, [view.phase]);
  // Only a "chart" verdict means a non-empty response for the range on screen,
  // so nothing below can render another range's bars, totals or legend.
  const days = view.phase === "chart" ? landed!.resp.days ?? [] : [];
  // A retry that works takes the error branch, and Try again with it, away
  // under the press (#1762). Focus goes to ↻, the same re-run, which every
  // phase keeps on screen.
  const reloadRef = useRef<HTMLButtonElement>(null);
  const rescueRetry = useFocusRescue(view.phase !== "error", reloadRef);
  const maxCost = useMemo(() => days.reduce((m, d) => Math.max(m, d.totalCost), 0), [days]);

  // #539 gave every day in the chart a 24px floor, which makes the chart a
  // horizontal scroller at any preset that asks for more days than fit: 90d is
  // 2160px of bars inside a 724px box. A scroller left where the browser puts
  // it opens at scrollLeft 0 — three months ago — and the day this panel is
  // opened to read is today, at the far right. So each time a range's days
  // land, the chart is parked on its newest column.
  // Layout effect rather than an ordinary one: it runs before the browser
  // paints, so the chart never shows a frame of the oldest thirty days and then
  // jumps. Keyed on `days`, whose identity changes exactly when a new response
  // for a new range is on screen; at 7d, 14d and 30d there is nothing to scroll
  // and `scrollLeft` clamps to 0 on its own.
  const chartRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = chartRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [days]);

  // Aggregate totals + per-model cost across the range.
  const { totalCost, totalTok, inOut, cacheRead, modelCosts } = useMemo(() => historyTotals(days), [days]);

  const legend = useMemo(() => legendOf(modelCosts), [modelCosts]);

  // Who spent it, across the whole range. Empty on a ccusage too old to answer
  // `--by-agent`, and one entry long on a machine that only runs one CLI —
  // which is why the strip below is drawn only for two or more. See
  // usage-agents.ts for the roll-up and why it lives outside this file.
  const agents = useMemo(() => agentTotals(days), [days]);
  const split = agents.length > 1;

  const selectedDay = selected ? days.find(d => d.period === selected) ?? null : null;
  const labelStep = dayLabelStep(days.length);

  return (
    <div className="modal-backdrop" {...scrimPress} role="presentation">
      <div ref={dialogRef} className="modal uh-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Usage history">
        <header className="uh-head">
          <div className="uh-titlewrap">
            <div className="uh-title">Usage history</div>
            {/* This line used to be the constant "via ccusage · local Claude /
                Codex logs", which is the sentence #431 opens with: it named two
                CLIs and the chart below then added them together. It is derived
                now — from the agents the run came back with when there are any,
                and from `providers` until then. Both halves matter: the deck
                must not tell a Claude-only machine about Codex before any data
                exists, and it must not deny a CLI whose spend is on screen. */}
            {/* While a re-run of the range on screen is out, the line says so
                in words (#1289). The answer under it used to fade to
                --dim-stale, every total and label with it; only the chart's
                marks dim now, so the state needs a word, and this line is the
                one that already says where the figures come from. The same
                words the busy branch prints, so a reader meets one phrase for
                one wait. */}
            <div className="uh-sub">{view.stale ? "running ccusage…" : usageSubtitle(providers, agents.map(a => a.id))}</div>
          </div>
          {/* Not a tablist (#381). role="tab" is a promise about keyboard
              behaviour — one tab stop for the whole strip, arrow keys between
              the members, and each tab pointing at a tabpanel it controls —
              and this strip implements none of the three: every button is its
              own tab stop and there is no panel, only the same chart redrawn
              over a different range. A screen reader told to expect arrow keys
              that do nothing is worse off than one told nothing.
              Not a radiogroup either, which is the obvious swap and carries
              exactly the same unmet contract: radio in a radiogroup is arrow
              keys and a roving tabindex too. group + aria-pressed is the shape
              the canvas category chips already use, for the reason spelled out
              at that bar in App.tsx — it names the set, states each member, and
              promises no keyboard model that is not here. */}
          <div className="uh-range" role="group" aria-label="Range">
            {PRESETS.map(p => (
              <button
                key={p}
                type="button"
                // No `on` class beside it any more (#583). The selected chip is
                // drawn from `[aria-pressed="true"]` now, which is the icon
                // buttons' idiom: one fact, styled and announced, so a chip
                // cannot look selected while the tree says nothing.
                aria-pressed={rangeDays === p}
                className="uh-range-btn"
                onClick={() => { setRangeDays(p); setSelected(null); }}
              >{p}d</button>
            ))}
          </div>
          <button
            ref={reloadRef}
            className="glyph-btn uh-reload"
            onClick={reload}
            /* #620: `disabled={loading}` disabled the control the press came
               from — `reload` sets `loading` synchronously — and a modal's Tab
               trap only mops up afterwards, at the FIRST control rather than
               where the reader was. Busy, enabled, and `load` refuses the
               second run. */
            {...selfPressProps(loading)}
            title="Re-run ccusage"
            aria-label="Reload"
          >{loading ? "…" : <RefreshGlyph />}</button>
          <button ref={closeRef} className="glyph-btn uh-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {view.phase === "busy" ? (
          /* A decorative local-files-to-report illustration, not sample data or
             measured progress. Reserve the chart's room while ccusage runs. */
          <div className="uh-status uh-status-wait" role="status" aria-label="Reading usage history" aria-busy="true" data-paused={pageHidden || undefined}>
            <span className="uh-wait-word">
              <svg className="uh-reading-art" viewBox="0 0 240 96" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <g className="uh-reading-files"><path d="M25 24v-7a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v43" /><rect x="17" y="24" width="36" height="51" rx="4" /><path d="M25 36h19M25 44h19M25 52h13M25 64h7" /></g>
                <path className="uh-reading-link" d="M69 49h59" />
                <g className="uh-reading-packets"><rect x="76" y="46" width="6" height="6" rx="1.5" /><rect x="76" y="46" width="6" height="6" rx="1.5" /><rect x="76" y="46" width="6" height="6" rx="1.5" /></g>
                <g className="uh-reading-report"><rect x="145" y="18" width="76" height="57" rx="5" /><path d="M154 28h21M154 64h57M154 38v26M163 39h47M163 49h47" /><circle cx="209" cy="28" r="2" /></g>
              </svg>
              <strong className="uh-reading-title">Reading usage history</strong>
              <span className="uh-reading-note">Gathering costs and tokens from local logs…</span>
              {!landed && <span className="uh-reading-hint">The first run may download ccusage.</span>}
            </span>
            <span className="uh-wait-axis" aria-hidden />
          </div>
        ) : view.phase === "error" ? (
          // The reason map says what happened; ccusage's own line is evidence,
          // one hover away, because it is what the user pastes into an issue.
          <div className="uh-status uh-err" title={commandOutput(landed!.resp) || undefined}>
            {explainCcusageFailure(landed!.resp, "ccusage did not report usage")}
            <div>
              {/* #620, and this one is the whole of the error branch: a
                  failed run leaves `phase: "error"` with `stale: loading`, so
                  the button stays mounted and simply went disabled under its
                  own press. The word already says it is trying. */}
              <button className="btn uh-retry" onClick={() => { rescueRetry(); reload(); }} {...selfPressProps(loading)}>
                {loading ? "trying…" : "Try again"}
              </button>
            </div>
          </div>
        ) : view.phase === "empty" ? (
          <div className={`uh-status${view.stale ? " uh-stale" : ""}`} aria-busy={view.stale || undefined}>
            no usage in this range
          </div>
        ) : (
          // One wrapper so the whole chart dims together while a newer run for
          // this same range is in flight: these are the right range's numbers,
          // but they are not the final word yet. What dims is the marks inside
          // it — bars, segments, swatches — and never the words (#1289); the
          // subtitle above says what is running.
          <div className={view.stale ? "uh-stale" : undefined} aria-busy={view.stale || undefined}>
            <div className="uh-totals">
              <Stat label="total cost"   val={fmtCost(totalCost)} accent />
              <Stat label="tokens"       val={fmtTokens(totalTok)} />
              <Stat label="input+output" val={fmtTokens(inOut)} />
              <Stat label="cache reads"  val={fmtTokens(cacheRead)} />
            </div>

            {/* The split, and the reason this issue exists (#431). It sits
                directly under the total it decomposes so the merged number and
                its parts are readable at once, without a mode switch and
                without a second chart — the panel is already dense, and the
                issue rules both of those out for that reason.

                Drawn ONLY for two or more CLIs. A machine that has only ever
                run Claude Code gets no bar and no key, which is the same panel
                it has today; so does a range answered by a ccusage too old to
                know `--by-agent`, because agentTotals comes back empty for it.

                WIDTH, since #369 pinned this modal's geometry and #462 had to
                retrofit an ellipsis onto the one column here that had no
                overflow protection. Neither shape below has a column to
                overflow: the bar is `width: 100%` of the content box and its
                segments are percentages of that, and the key is a wrapping flex
                row modelled on `.uh-legend`. The content box is 724px — the
                modal is `min(760px, 100%)` less 18px of padding a side — and a
                key entry is about 165px (an 8px dot, a name, a cost and a
                share, at 11px), so the two entries this normally has occupy
                under half a line and even six CLIs simply wrap. That matters
                more than it looks: ccusage reads sixteen sources, so the count
                here is not bounded at two by anything, and a fixed grid would
                have been a geometry bug waiting for the first reader who runs
                OpenCode. */}
            {split && (
              // group, and the name on the group rather than on the bar. The
              // bar is the one thing here with nothing of its own to say: every
              // figure it draws is printed as text in the key directly below
              // it, so labelling it would have a screen reader read the same
              // two numbers twice, and leaving it unlabelled but unhidden would
              // put an unnamed generic element between the totals and the
              // chart. Hidden, it is what it looks like — a picture of the key.
              // Not role="img" for it, which is what CostBar uses for a bar
              // that IS the only statement of its figures; the difference is
              // whether anything else on screen says the same thing.
              <div className="uh-agents" role="group" aria-label="Cost by CLI">
                <div className="uh-agent-bar" aria-hidden="true">
                  {agents.map(a => (
                    <span
                      key={a.id}
                      className="uh-agent-seg"
                      style={{ width: `${percentOf(a.cost, totalCost)}%`, background: agentColor(a.id) }}
                    />
                  ))}
                </div>
                <div className="uh-agent-keys">
                  {agents.map(a => (
                    // The raw ccusage id in the `title`, the way the model
                    // legend below carries the raw model id: the printed name
                    // is this deck's word for the CLI and the id is what the
                    // reader would type at `ccusage <agent> daily` to check it.
                    <span key={a.id} className="uh-agent-key" title={`${a.id} · ${fmtTokens(a.tokens)} tokens`}>
                      <span className="uh-legend-dot" style={{ background: agentColor(a.id) }} />
                      {agentLabel(a.id)}
                      <span className="uh-agent-cost">{fmtCost(a.cost)}</span>
                      {/* The percentage is not redundant with the bar, it is
                          what the bar cannot say. A measured range from a
                          machine running both was $662.05 against $0.01, where
                          the Codex segment is a fraction of a pixel; sharePct
                          prints "<0.1%" for it rather than "0.0%", so a CLI
                          that spent a little is never shown as one that spent
                          nothing. */}
                      <span className="uh-agent-share">{sharePct(a.cost, totalCost)}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* role="group", not role="img" (#381). role="img" declares that
                the subtree is one graphic, so every descendant is pruned from
                the accessibility tree — but pruning the tree does not empty the
                tab order, so what this actually produced was up to ninety
                focusable buttons that announced nothing at all when they took
                focus. That is the same shape as the tool-bubble finding in
                #367: reachable and silent, which is worse than either being
                unreachable or being read out.
                group keeps the only thing the role was really being used for —
                the bars are named as one set rather than as loose controls —
                and leaves each day to speak for itself below. */}
            <div ref={chartRef} className="uh-chart" role="group" aria-label="Daily cost by model">
              {days.map((d, i) => {
                const h = percentOf(d.totalCost, maxCost);
                const isSel = d.period === selected;
                // The bar's only text is `06-14`, a day with no month and no
                // figure. The tooltip has carried the whole answer all along;
                // this is that same sentence where a name is read from, and it
                // is built from the same two values rather than a second copy.
                const dayLabel = `${d.period}, ${fmtCost(d.totalCost)}`;
                return (
                  <button
                    key={d.period}
                    className={`uh-bar-col${isSel ? " sel" : ""}`}
                    onClick={() => setSelected(isSel ? null : d.period)}
                    /* A toggle, and pressed is the honest word for it: clicking
                       the selected day clears the breakdown below rather than
                       navigating anywhere, exactly like the canvas category
                       chips this deck already models. */
                    aria-pressed={isSel}
                    aria-label={dayLabel}
                    title={`${d.period} · ${fmtCost(d.totalCost)}`}
                    /* THE DAYS LAND OLDEST FIRST, which is the one stagger this
                       chart can justify: left to right is not a decorative
                       sweep here, it is the order they were lived in, and it is
                       the axis the columns are drawn against.
                       The step is divided rather than fixed so 90 days take the
                       same time as 7 — a per-column delay would have made the
                       longest range the slowest to appear, which is backwards.
                       Capped at 10ms so a short range still reads as a sequence
                       rather than as one block. 200ms of span plus the 340ms a
                       column takes puts the whole arrival at ~540ms, which is
                       the band this reference reserves for an authored entrance
                       and lands well inside it after a 2.4-second wait. */
                    style={{
                      flexBasis: `${100 / days.length}%`,
                      "--uh-i": i,
                      "--uh-step": `${Math.min(10, 200 / Math.max(days.length, 1))}ms`,
                    } as CSSProperties}
                  >
                    <div className="uh-bar" style={{ height: `${Math.max(h, d.totalCost > 0 ? 2 : 0)}%` }}>
                      {byCost(d.modelBreakdowns).map(mb => {
                        const seg = percentOf(mb.cost, d.totalCost);
                        return (
                          <div
                            key={mb.modelName}
                            className="uh-bar-seg"
                            style={{ height: `${seg}%`, background: modelColor(mb.modelName) }}
                          />
                        );
                      })}
                    </div>
                    {(days.length - 1 - i) % labelStep === 0 && <span className="uh-bar-label">{d.period.slice(5)}</span>}
                  </button>
                );
              })}
            </div>

            {/* The raw id in a `title`, on both surfaces here, matching what
                UsagePanel and AgentNode already do. #462 found these two were
                the only places printing a model label with no way back to the
                id — and they are the two whose whole job is comparing spend
                across models, so a reader who wants to know exactly which
                `gpt-5.4-*` a row is has to be able to ask. The label is
                unambiguous again as of that fix; the tooltip is what makes the
                exact id, dates and namespace included, recoverable without it. */}
            <div className="uh-legend">
              {legend.map(([m, c]) => (
                <span key={m} className="uh-legend-item" title={m}>
                  <span className="uh-legend-dot" style={{ background: modelColor(m) }} />
                  {shortModel(m)} <span className="uh-legend-cost">{fmtCost(c)}</span>
                </span>
              ))}
            </div>

            {selectedDay && <UsageDayDetail selectedDay={selectedDay} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, val, accent }: { label: string; val: string; accent?: boolean }) {
  return (
    <div className="uh-stat">
      <span className={`uh-stat-val${accent ? " accent" : ""}`}>{val}</span>
      <span className="uh-stat-label">{label}</span>
    </div>
  );
}
