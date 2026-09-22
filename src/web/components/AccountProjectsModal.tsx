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
import { costForUsage, fmtCost } from "../pricing";
import { fmtTokens } from "../token-format";
import { modelRows } from "../usage-from-ccusage";
import { bareModelId } from "../model-id";
import type { TokenUsage } from "../types";
import { useModalDismiss } from "./use-modal-dismiss";

/** The compact per-model token counters the server sends. */
interface Counters { i: number; o: number; cr: number; cc: number; c1h: number; c5m: number }
interface ProjectRow { path: string; name: string; models: Record<string, Counters> }
interface Report {
  ok?: boolean;
  trackedSince: number | null;
  days: number;
  projects: ProjectRow[];
  unattributed: Record<string, Counters> | null;
}

/** The windows, and their chip labels. 0 = everything tracked. */
const WINDOWS: Array<{ days: number; label: string }> = [
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

function toUsage(c: Counters): TokenUsage {
  return {
    inputTokens: c.i, outputTokens: c.o,
    cacheReadTokens: c.cr, cacheCreateTokens: c.cc,
    cacheCreate1hTokens: c.c1h, cacheCreate5mTokens: c.c5m,
  };
}

/** Count a project's billed tokens. */
function tokensOf(models: Record<string, Counters>): number {
  let t = 0;
  for (const c of Object.values(models)) t += c.i + c.o + c.cr + c.cc;  // c1h/c5m are a split OF cc, not extra
  return t;
}

/**
 * Price a project's model spread, with the dollars anchored to ccusage.
 *
 * ccusage is the one cost authority on the machine, so its per-model total for
 * the window is the truth; `scale` carries `ccusageCost / ourCost` per model.
 * pricing.ts then only decides the SPLIT between projects within a model (a
 * ratio, robust even when its absolute rates have drifted from ccusage). A
 * model ccusage did not price — or a failed fetch — has scale 1, so the report
 * falls back to pricing.ts alone rather than showing nothing.
 */
function priceModels(models: Record<string, Counters>, scale: Map<string, number>, now: number): { cost: number; tokens: number } {
  let cost = 0;
  for (const [model, c] of Object.entries(models)) {
    cost += costForUsage(toUsage(c), model, now).total * (scale.get(model) ?? 1);
  }
  return { cost, tokens: tokensOf(models) };
}

/** Format a local date as the `YYYYMMDD` /api/ccusage insists on. */
function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** A row ready to draw: priced, named, coloured. `other` folds the small tail;
 *  `unattributed` is the accountless bucket, shown apart from the bar. */
interface Priced { key: string; label: string; title?: string; cost: number; tokens: number; color: string; muted?: boolean }

function niceDate(ms: number | null): string {
  if (!ms) return "";
  try { return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return ""; }
}

export default function AccountProjectsModal({ num, name, onClose }: { num: number; name: string; onClose: () => void }) {
  const [days, setDays] = useState(7);
  const [report, setReport] = useState<Report | null>(null);
  // ccusage's per-model cost for the window, the dollar authority we anchor to.
  // Null while loading or when ccusage could not be reached (then pricing.ts
  // stands in). A Map from model id to its window cost.
  const [ccByModel, setCcByModel] = useState<Map<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
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
        const range = u as { ok?: unknown } | null;
        if (range && range.ok !== false) {
          const m = new Map<string, number>();
          for (const row of modelRows(range)) m.set(row.model, row.cost);
          setCcByModel(m);
        } else setCcByModel(null);
        setLoading(false);
      })
      .catch((e: Error) => { if (id === reqId.current) { setError(e.message || "Could not load"); setLoading(false); } });
  }, [num, days]);

  // Price, sort, disambiguate colliding basenames, and collapse the tail.
  const view = useMemo(() => {
    const now = Date.now();
    if (!report) return null;

    // The dollar scale per model: ccusage's window cost over our pricing.ts
    // cost for the same model, so each model's total lands on ccusage exactly.
    // Codex never enters — our tally holds only Claude models, and only those
    // are looked up.
    const scale = new Map<string, number>();
    if (ccByModel) {
      const ourByModel = new Map<string, number>();
      const add = (models: Record<string, Counters>) => {
        for (const [m, c] of Object.entries(models)) ourByModel.set(m, (ourByModel.get(m) ?? 0) + costForUsage(toUsage(c), m, now).total);
      };
      for (const p of report.projects) add(p.models);
      if (report.unattributed) add(report.unattributed);
      for (const [m, ourTotal] of ourByModel) {
        const cc = ccByModel.get(m) ?? ccByModel.get(bareModelId(m));
        if (cc != null && ourTotal > 0) scale.set(m, cc / ourTotal);
      }
    }
    const reconciled = scale.size > 0;

    const priced = report.projects
      .map(p => ({ p, ...priceModels(p.models, scale, now) }))
      .sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens));

    // Two projects with the same folder name are told apart by their parent.
    const seen = new Map<string, number>();
    for (const r of priced) seen.set(r.p.name, (seen.get(r.p.name) ?? 0) + 1);
    const labelFor = (p: ProjectRow): string => {
      if ((seen.get(p.name) ?? 0) <= 1) return p.name;
      const parent = p.path.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2, -1)[0];
      return parent ? `${parent}/${p.name}` : p.name;
    };

    const rows: Priced[] = [];
    const head = priced.slice(0, MAX_ROWS);
    const tail = priced.slice(MAX_ROWS);
    head.forEach((r, i) => rows.push({
      key: r.p.path, label: labelFor(r.p), title: r.p.path,
      cost: r.cost, tokens: r.tokens, color: PALETTE[i % PALETTE.length],
    }));
    if (tail.length) {
      rows.push({
        key: "__other__",
        label: `Other · ${tail.length} project${tail.length > 1 ? "s" : ""}`,
        cost: tail.reduce((s, r) => s + r.cost, 0),
        tokens: tail.reduce((s, r) => s + r.tokens, 0),
        color: PALETTE[MAX_ROWS % PALETTE.length],
        muted: true,
      });
    }

    const totalCost = rows.reduce((s, r) => s + r.cost, 0);
    const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
    // The bar shares by cost, or by tokens when nothing here is priced.
    const basis = totalCost > 0 ? "cost" : "tokens";
    const denom = basis === "cost" ? totalCost : totalTokens;

    const un = report.unattributed ? priceModels(report.unattributed, scale, now) : null;
    return { rows, totalCost, totalTokens, basis, denom, un, reconciled };
  }, [report, ccByModel]);

  const trackedNote = report?.trackedSince
    ? `Tracked since ${niceDate(report.trackedSince)}`
    : "Tracking starts with this version";
  const windowWord = days === 0 ? "all time" : `the last ${days} days`;

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

        <div className="ap-proj-body">
          {loading && <div className="ap-proj-state">Loading…</div>}
          {!loading && error && <div className="ap-proj-state ap-proj-error">Couldn’t load this report: {error}</div>}

          {!loading && !error && view && (
            <>
              {view.rows.length === 0 ? (
                <div className="ap-proj-state">
                  No work attributed to this account in {windowWord}.
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
                        title={`${r.label} · ${fmtCost(r.cost)}`} />;
                    })}
                  </div>

                  <div className="ap-proj-totals">
                    <span className="ap-proj-total-cost">{fmtCost(view.totalCost)}</span>
                    <span className="ap-proj-total-tok">{fmtTokens(view.totalTokens)} tokens</span>
                    <span className="ap-proj-total-win">· {windowWord}</span>
                  </div>

                  <ul className="ap-proj-list">
                    {view.rows.map(r => {
                      const val = view.basis === "cost" ? r.cost : r.tokens;
                      const pct = view.denom > 0 ? (val / view.denom) * 100 : 0;
                      return (
                        <li key={r.key} className={`ap-proj-row${r.muted ? " muted" : ""}`}>
                          <span className="ap-proj-dot" style={{ background: r.color }} aria-hidden="true" />
                          <span className="ap-proj-name" title={r.title ?? r.label}>{r.label}</span>
                          <span className="ap-proj-track" aria-hidden="true">
                            <span className="ap-proj-fill" style={{ width: `${pct}%`, background: r.color }} />
                          </span>
                          <span className="ap-proj-cost">{fmtCost(r.cost)}</span>
                          <span className="ap-proj-tok">{fmtTokens(r.tokens)}</span>
                        </li>
                      );
                    })}
                  </ul>

                  {view.un && (view.un.cost > 0 || view.un.tokens > 0) && (
                    <div className="ap-proj-unattributed">
                      <span className="ap-proj-dot" style={{ background: UNATTRIBUTED_COLOR }} aria-hidden="true" />
                      <span className="ap-proj-name">Unattributed</span>
                      <span className="ap-proj-cost">{fmtCost(view.un.cost)}</span>
                      <span className="ap-proj-tok">{fmtTokens(view.un.tokens)}</span>
                      <div className="ap-proj-note">
                        Work no account could be tied to — from before tracking, or a gap. Not counted in the totals above.
                      </div>
                    </div>
                  )}

                  <div className="ap-proj-foot">
                    {view.reconciled ? "Dollars from ccusage, split by activity" : "Dollars estimated (ccusage unavailable)"} · {trackedNote}
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
