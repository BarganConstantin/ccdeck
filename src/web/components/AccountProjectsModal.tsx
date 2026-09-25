// Where one account spent its work — the "Projects" report opened from an
// account card's ⋯ menu.
//
// The server tallies only TOKENS per (project, day, model) for this account;
// the dollars are computed here, with the board's own pricing table
// (costForUsage), so cost never lives in two places and the numbers match the
// rest of the deck. Attribution is per message and starts at the version that
// began recording which account was active — everything before that is honestly
// unattributable, shown apart so a total is never quietly inflated.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmtCost } from "../pricing";
import { fmtTokens } from "../token-format";
import { reconcile, type Counters, type CcCell } from "../account-projects-reconcile";
import { copyText } from "../copy-text";
import { homeRelativePath, projectParentLabel } from "../account-project-paths";
import { useModalDismiss } from "./use-modal-dismiss";
import { emptyWindowSentence, showsDayChart, widerWindow, windowPhrase } from "../account-projects-window";

interface ProjectRow { path: string; name: string; models: Record<string, Counters> }
interface DailyEntry {
  day: string;
  projects: Array<{ path: string; models: Record<string, Counters> }>;
  unattributed: Record<string, Counters> | null;
}
interface Report {
  ok?: boolean;
  trackedSince: number | null;
  days: number;
  projects: ProjectRow[];
  unattributed: Record<string, Counters> | null;
  daily?: DailyEntry[];
}

/** The windows, and their chip labels. 0 = everything tracked. */
const WINDOWS: Array<{ days: number; label: string }> = [
  { days: 1, label: "Today" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 0, label: "All" },
];

/** Enough distinct hues to read a stacked bar; projects past the palette reuse
 *  it, but the tail is collapsed long before that (MAX_ROWS). These are the
 *  deck's shared usage-chart tokens — declared in both themes — so a colour
 *  literal never reaches an inline style (usage-series-contrast.test.ts). */
const PALETTE = [
  "var(--usage-blue)", "var(--usage-green)", "var(--usage-amber)", "var(--usage-purple)",
  "var(--usage-indigo)", "var(--usage-red)", "var(--usage-orange)", "var(--usage-zinc)",
];
const UNATTRIBUTED_COLOR = "var(--usage-zinc)";
const MAX_ROWS = 6;
/** How long a Copy reads `Copied` — the deck's other copy buttons' moment. */
const COPIED_MS = 1_600;

/** Format a local date as the `YYYYMMDD` /api/ccusage insists on. */
function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** fmtCost with thousands grouping for the whole-dollar tier, so a five-figure
 *  Unattributed reads `$1,897` and not `$1897`. Local to this modal — the shared
 *  fmtCost is used app-wide and left untouched. */
function fmtCostGrouped(usd: number): string {
  const s = fmtCost(usd);
  const m = /^\$(\d{4,})$/.exec(s);   // only the "$1897" integer tier needs it
  return m ? `$${Number(m[1]).toLocaleString("en-US")}` : s;
}

/** A share as a compact percent: `61%`, `0.16%`, `<0.01%`. */
function pctLabel(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const p = (part / whole) * 100;
  if (p < 0.01) return "<0.01%";
  if (p < 1) return `${p.toFixed(2)}%`;
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}


/** A `YYYY-MM-DD` day as a compact `M/D` axis label. */
function dayLabel(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${Number(m[1])}/${Number(m[2])}` : day;
}

/** Which day columns get a printed label: the ends, and an even scatter
 *  between, so a 60-day axis is not a wall of overlapping dates. */
function labelledDays(count: number): (i: number) => boolean {
  const step = Math.max(1, Math.ceil(count / 6));
  return i => i === 0 || i === count - 1 || i % step === 0;
}

/** A row ready to draw: priced, named, coloured. `other` folds the small tail;
 *  `unattributed` is the accountless bucket, shown apart from the bar. */
interface Priced { key: string; label: string; path?: string; parentLabel?: string; cost: number; tokens: number; color: string; muted?: boolean; members?: Array<{ path: string; label: string; parentLabel?: string; cost: number; tokens: number }> }

function niceDate(ms: number | null): string {
  if (!ms) return "";
  try { return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return ""; }
}

export default function AccountProjectsModal({ num, name, onClose }: { num: number; name: string; onClose: () => void }) {
  const [days, setDays] = useState(1);
  const [report, setReport] = useState<Report | null>(null);
  // The window the report on screen belongs to. While another window loads,
  // the last report stays up, dimmed, rather than the modal collapsing to a
  // Loading line and jumping back open.
  const [shownDays, setShownDays] = useState(days);
  // The raw ccusage range for the window — the dollar authority. Null while
  // loading or when ccusage could not be reached (then pricing.ts stands in).
  // Per-model and per-day-per-model costs are derived from it in the memo.
  const [ccRange, setCcRange] = useState<unknown>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // THE LAST COPY, AND WHETHER IT LANDED. A Copy that says nothing leaves the
  // reader pasting to find out; the button reads `Copied` for a moment and the
  // status line below says it to a screen reader, which a word changing on a
  // button does not reliably do (WCAG 4.1.3).
  const [copied, setCopied] = useState<{ path: string; label: string; ok: boolean } | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; window.clearTimeout(copiedTimer.current); }, []);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setSelectedDay(null);   // a new window is a fresh chart
    setExpandedRows(new Set());
    // The window the tally used: today back N-1 days (60 for "all", matching
    // the rollup's retention). ccusage is asked for the same span so the two
    // agree day-for-day.
    const span = days === 0 ? 60 : days;
    const since = ymd(new Date(Date.now() - (span - 1) * 86_400_000));
    const until = ymd(new Date());
    const rep = fetch(`/api/account-projects?num=${num}&days=${days}`, { credentials: "same-origin" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
    // ccusage is best-effort: a failure leaves us on pricing.ts rather than
    // blocking the report on a subprocess.
    const usage = fetch(`/api/ccusage?since=${since}&until=${until}`, { credentials: "same-origin" })
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    Promise.all([rep, usage])
      .then(([j, u]: [Report, unknown]) => {
        if (id !== reqId.current) return;
        setReport(j);
        setShownDays(days);
        const range = u as { ok?: unknown } | null;
        setCcRange(range && range.ok !== false ? range : null);
        setLoading(false);
      })
      .catch((e: Error) => { if (id === reqId.current) { setError(e.message || "Could not load"); setReport(null); setLoading(false); } });
  }, [num, days]);

  // One reconciliation, per day, aggregated — so period, project, day and
  // selected-day totals are the same dollars summed different ways and cannot
  // disagree. See the block comments for the invariant.
  const view = useMemo(() => {
    const now = Date.now();
    if (!report) return null;

    // ── ccusage: the dollar authority, per (day, model), Claude only ─────────
    // Only Claude model breakdowns are read, so Codex cost never reconciles into
    // a project nor into the window total.
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const ccByDayModel = new Map<string, CcCell>();   // `${day}|${model}` -> { cost, tokens }
    if (ccRange) {
      const daysArr = Array.isArray((ccRange as { days?: unknown }).days) ? (ccRange as { days: Array<Record<string, unknown>> }).days : [];
      for (const d of daysArr) {
        const period = typeof d.period === "string" ? d.period : "";
        const mbs = Array.isArray(d.modelBreakdowns) ? (d.modelBreakdowns as Array<Record<string, unknown>>) : [];
        for (const b of mbs) {
          const mn = typeof b.modelName === "string" ? b.modelName : "";
          if (!period || !/claude/i.test(mn)) continue;
          const key = `${period}|${mn}`;
          const cur = ccByDayModel.get(key);
          const u = cur ? cur.usage : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cacheCreate1hTokens: 0, cacheCreate5mTokens: 0 };
          u.inputTokens += num(b.inputTokens);
          u.outputTokens += num(b.outputTokens);
          u.cacheReadTokens += num(b.cacheReadTokens);
          u.cacheCreateTokens += num(b.cacheCreationTokens);
          if (cur) cur.cost += num(b.cost);
          else ccByDayModel.set(key, { cost: num(b.cost), usage: u });
        }
      }
    }
    // The reconciliation math lives in a pure, tested module: our tokens priced
    // at ccusage's own per-token rate, per day, so nothing inflates or leaks in.
    const rec = reconcile(report.daily ?? [], report.unattributed, ccByDayModel, now);

    // Names, with a colliding basename told apart by its parent.
    const nameOf = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path || "(unknown)";
    const seen = new Map<string, number>();
    for (const a of rec.projects) seen.set(nameOf(a.path), (seen.get(nameOf(a.path)) ?? 0) + 1);
    const labelFor = (path: string): string => {
      const base = nameOf(path);
      if ((seen.get(base) ?? 0) <= 1) return base;
      const parent = path.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2, -1)[0];
      return parent ? `${parent}/${base}` : base;
    };

    const projectLabels = rec.projects.map(a => ({ path: a.path, label: labelFor(a.path) }));
    const rowFor = (a: (typeof rec.projects)[number]) => ({
      path: a.path,
      label: labelFor(a.path),
      parentLabel: projectParentLabel(a.path, projectLabels),
      cost: a.cost,
      tokens: a.tokens,
    });
    const otherColor = PALETTE[MAX_ROWS % PALETTE.length];
    const colorForPath = new Map<string, string>();
    const rows: Priced[] = [];
    const head = rec.projects.slice(0, MAX_ROWS);
    const tail = rec.projects.slice(MAX_ROWS);
    head.forEach((a, i) => {
      colorForPath.set(a.path, PALETTE[i % PALETTE.length]);
      rows.push({ key: a.path, ...rowFor(a), color: PALETTE[i % PALETTE.length] });
    });
    if (tail.length) {
      rows.push({
        key: "__other__",
        label: `Other · ${tail.length} project${tail.length > 1 ? "s" : ""}`,
        cost: tail.reduce((sum, a) => sum + a.cost, 0),
        tokens: tail.reduce((sum, a) => sum + a.tokens, 0),
        color: otherColor,
        muted: true,
        members: tail.map(rowFor),
      });
    }

    const totalCost = rec.totalCost;
    const totalTokens = rec.totalTokens;
    const basis = totalCost > 0 ? "cost" : "tokens";
    const denom = basis === "cost" ? totalCost : totalTokens;

    // The per-day chart maps the reconciled per-project day costs onto colours.
    const colorOrder = rows.map(r => r.color);
    const chart = rec.perDay.map(d => {
      const costByColor = new Map<string, number>();
      for (const [path, cost] of d.byPath) {
        const color = colorForPath.get(path) ?? otherColor;
        costByColor.set(color, (costByColor.get(color) ?? 0) + cost);
      }
      return { day: d.day, total: d.total, costByColor };
    });
    const maxDay = chart.reduce((m, d) => Math.max(m, d.total), 0);

    return { rows, totalCost, totalTokens, basis, denom, un: rec.unattributed, reconciled: rec.reconciled, chart, maxDay, colorOrder };
  }, [report, ccRange]);

  // The row shows the `~` form; the clipboard gets the absolute path. The fold
  // is by shape, and a pasted `~` resolves to the home of whoever pastes it —
  // see account-project-paths.ts.
  const copyLocation = (path: string, label: string) => {
    void copyText(path).then(ok => {
      if (!alive.current) return;
      window.clearTimeout(copiedTimer.current);
      setCopied({ path, label, ok });
      copiedTimer.current = window.setTimeout(() => { if (alive.current) setCopied(null); }, COPIED_MS);
    });
  };
  const copyWord = (path: string) => (copied?.ok && copied.path === path ? "Copied" : "Copy");

  const trackedNote = report?.trackedSince
    ? `Tracked since ${niceDate(report.trackedSince)}`
    : "Tracking starts with this version";
  const windowWord = windowPhrase(shownDays);
  const wider = widerWindow(shownDays);
  const refreshing = loading && !!report;

  // Portalled to <body>: the report is opened from inside AccountsPanel, and a
  // dialog left in the panel's subtree is laid out by it (panel-modal-portal).
  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal ap-proj-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="ap-proj-title ap-proj-sub">
        <header className="ap-proj-head">
          <div className="ap-proj-titlewrap">
            <div className="ap-proj-title" id="ap-proj-title">Projects</div>
            <div className="ap-proj-sub" id="ap-proj-sub" title={name}>{name}</div>
          </div>
          {/* The usage modal's range strip, reused so the two read the same. */}
          <div className="uh-range" role="group" aria-label="Range">
            {WINDOWS.map(w => (
              <button key={w.days} type="button" className="uh-range-btn"
                aria-pressed={days === w.days}
                onClick={() => setDays(w.days)}>{w.label}</button>
            ))}
          </div>
          <button ref={closeRef} className="glyph-btn ap-proj-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className={`ap-proj-body${refreshing ? " refreshing" : ""}`} aria-busy={loading}>
          {loading && !report && <div className="ap-proj-state">Loading…</div>}
          {!loading && error && <div className="ap-proj-state ap-proj-error">Couldn’t load this report: {error}</div>}

          {!error && view && (
            <>
              {view.rows.length === 0 ? (
                <div className="ap-proj-state">
                  {emptyWindowSentence(shownDays)}
                  {wider != null && (
                    <div className="ap-proj-widen-wrap">
                      <button type="button" className="ap-proj-copy" onClick={() => setDays(wider)}>
                        Show {windowPhrase(wider)}
                      </button>
                    </div>
                  )}
                  <div className="ap-proj-note">{trackedNote}. Only work from this version onward can be tied to an account.</div>
                </div>
              ) : (
                <>
                  {/* Proportion at a glance: 100% of this account's spend on the window. */}
                  <div className="ap-proj-bar" role="img"
                    aria-label={`Share of ${fmtCost(view.totalCost)} across ${view.rows.length} projects`}>
                    {view.rows.map(r => {
                      const val = view.basis === "cost" ? r.cost : r.tokens;
                      const pct = view.denom > 0 ? (val / view.denom) * 100 : 0;
                      if (pct <= 0) return null;
                      return <span key={r.key} className="ap-proj-seg"
                        style={{ width: `${pct}%`, background: r.color }}
                        title={`${r.label} · ${fmtCost(r.cost)} · ${pctLabel(r.cost, view.totalCost)}${r.tokens ? ` · ${fmtTokens(r.tokens)} tokens` : ""}`} />;
                    })}
                  </div>

                  <div className="ap-proj-totals">
                    <span className="ap-proj-total-cost">{fmtCost(view.totalCost)}</span>
                    <span className="ap-proj-total-tok">{fmtTokens(view.totalTokens)} tokens</span>
                    <span className="ap-proj-total-win">· {windowWord}</span>
                  </div>

                  {showsDayChart(shownDays, view.chart.length) && (
                    <div className="ap-proj-days">
                      <div className="ap-proj-days-cap">By day{view.chart.length > 1 ? " · click a bar" : ""}</div>
                      <div className="ap-proj-days-plot" role="img"
                        aria-label={`Spend across ${view.chart.length} day${view.chart.length > 1 ? "s" : ""}`}>
                        {view.chart.map(d => {
                          const h = view.maxDay > 0 ? (d.total / view.maxDay) * 100 : 0;
                          const on = selectedDay === d.day;
                          const parts = view.rows.map(r => ({ label: r.label, c: d.costByColor.get(r.color) ?? 0 })).filter(x => x.c > 0);
                          const spoken = `${niceDate(Date.parse(`${d.day}T00:00:00`))}, ${fmtCost(d.total)}. ${parts.map(p => `${p.label} ${fmtCost(p.c)}`).join(", ")}`;
                          return (
                            <button key={d.day} type="button" className={`ap-proj-day${on ? " selected" : ""}`}
                              aria-pressed={on} aria-label={spoken} title={`${d.day} · ${fmtCost(d.total)}`}
                              onClick={() => setSelectedDay(s => (s === d.day ? null : d.day))}>
                              <span className="ap-proj-col" style={{ height: `${h}%` }}>
                                {view.colorOrder.map((color, k) => {
                                  const c = d.costByColor.get(color) ?? 0;
                                  if (c <= 0 || d.total <= 0) return null;
                                  return <span key={k} className="ap-proj-colseg"
                                    style={{ height: `${(c / d.total) * 100}%`, background: color }} />;
                                })}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {(() => { const show = labelledDays(view.chart.length); return (
                        <div className="ap-proj-days-axis" aria-hidden="true">
                          {view.chart.map((d, i) => (
                            <div key={d.day} className="ap-proj-axis-cell">{show(i) ? dayLabel(d.day) : ""}</div>
                          ))}
                        </div>
                      ); })()}
                      {(() => {
                        const d = selectedDay ? view.chart.find(x => x.day === selectedDay) : null;
                        if (!d) return null;
                        const parts = view.rows.map(r => ({ r, c: d.costByColor.get(r.color) ?? 0 })).filter(x => x.c > 0);
                        return (
                          <div className="ap-proj-day-detail">
                            <div className="ap-proj-day-detail-head">
                              <span>{niceDate(Date.parse(`${d.day}T00:00:00`))}</span>
                              <span className="ap-proj-day-detail-total">{fmtCost(d.total)}</span>
                            </div>
                            {parts.map(({ r, c }) => (
                              <div key={r.key} className="ap-proj-day-detail-row">
                                <span className="ap-proj-dot" style={{ background: r.color }} aria-hidden="true" />
                                <span className="ap-proj-day-detail-name">{r.label}</span>
                                <span className="ap-proj-day-detail-cost">{fmtCost(c)}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  <ul className="ap-proj-list">
                    {view.rows.map((r, i) => {
                      const val = view.basis === "cost" ? r.cost : r.tokens;
                      const pct = view.denom > 0 ? (val / view.denom) * 100 : 0;
                      const expanded = expandedRows.has(r.key);
                      // aria-controls only while the region is on the page: an
                      // IDREF to nothing is a dangling pointer (#800).
                      const detailsId = `ap-proj-details-${i}`;
                      const hasDetails = expanded && (!!r.path || !!r.members);
                      // Other opens a list of projects, not a location, and its
                      // label is already "Other · N projects" — so it says what
                      // it opens rather than echoing that.
                      const infoLabel = r.members
                        ? `${expanded ? "Hide" : "Show"} the ${r.members.length} project${r.members.length > 1 ? "s" : ""} folded into Other`
                        : `${expanded ? "Hide" : "Show"} location for ${r.label}`;
                      return (
                        <li key={r.key} className={`ap-proj-row${r.muted ? " muted" : ""}${expanded ? " expanded" : ""}`}>
                          <span className="ap-proj-dot" style={{ background: r.color }} aria-hidden="true" />
                          <span className="ap-proj-name">
                            {r.label}{r.parentLabel && <span className="ap-proj-parent"> · in {r.parentLabel}</span>}
                          </span>
                          <span className="ap-proj-track" title={`${pctLabel(r.cost, view.totalCost)} of tracked cost`}>
                            <span className="ap-proj-fill" style={{ width: `${pct}%`, background: r.color }} />
                          </span>
                          <span className="ap-proj-cost">{fmtCost(r.cost)}</span>
                          <span className="ap-proj-tok">{fmtTokens(r.tokens)}</span>
                          <button type="button" className="glyph-btn ap-proj-info" aria-expanded={expanded}
                            aria-controls={hasDetails ? detailsId : undefined}
                            aria-label={infoLabel}
                            onClick={() => setExpandedRows(prev => {
                              const next = new Set(prev);
                              if (next.has(r.key)) next.delete(r.key); else next.add(r.key);
                              return next;
                            })}>ⓘ</button>
                          {expanded && r.path && (
                            <div className="ap-proj-details" id={detailsId}>
                              <code className="ap-proj-path">{homeRelativePath(r.path)}</code>
                              <button type="button" className="ap-proj-copy"
                                aria-label={`${copyWord(r.path)} location for ${r.label}`}
                                onClick={() => copyLocation(r.path!, r.label)}>{copyWord(r.path)}</button>
                            </div>
                          )}
                          {expanded && r.members && (
                            <div className="ap-proj-details ap-proj-other-members" id={detailsId}>
                              {r.members.map(member => (
                                <div key={member.path} className="ap-proj-other-member">
                                  <div className="ap-proj-other-name">{member.label}{member.parentLabel && <span className="ap-proj-parent"> · in {member.parentLabel}</span>}</div>
                                  <code className="ap-proj-path">{homeRelativePath(member.path)}</code>
                                  <span className="ap-proj-cost">{fmtCost(member.cost)}</span>
                                  <span className="ap-proj-tok">{fmtTokens(member.tokens)}</span>
                                  <button type="button" className="ap-proj-copy"
                                    aria-label={`${copyWord(member.path)} location for ${member.label}`}
                                    onClick={() => copyLocation(member.path, member.label)}>{copyWord(member.path)}</button>
                                </div>
                              ))}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                  {view.un && (
                    <div className="ap-proj-unattributed">
                      <span className="ap-proj-dot" style={{ background: UNATTRIBUTED_COLOR }} aria-hidden="true" />
                      <div className="ap-proj-un-labels">
                        <span className="ap-proj-un-title">Unattributed usage</span>
                        <span className="ap-proj-un-tag">Excluded from the project totals</span>
                      </div>
                      <span className="ap-proj-un-cost">{fmtCostGrouped(view.un.cost)}</span>
                      <span className="ap-proj-un-tok">{fmtTokens(view.un.tokens)}</span>
                      <div className="ap-proj-note">Work no account could be tied to — from before tracking, or a gap.</div>
                    </div>
                  )}

                  {/* Always on the page, so the text arriving is what is announced. */}
                  <div className="vis-hidden" role="status" aria-atomic="true">
                    {copied && (copied.ok
                      ? `Copied the location of ${copied.label}`
                      : `Could not copy the location of ${copied.label} — select it and copy it by hand`)}
                  </div>

                  <div className="ap-proj-foot">
                    {view.reconciled ? "Dollars from ccusage · split by activity" : "Dollars estimated · ccusage unavailable"} · {trackedNote}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
