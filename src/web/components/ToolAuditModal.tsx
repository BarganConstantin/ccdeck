import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { auditDuration, readAuditReport, type AuditProvider, type AuditReport, type AuditRow } from '../tool-audit';
import { auditDay, count, failureShare, findHighlights, periodLabels, sortTools, summaryParts, toolSorts, toolSortValue, type Highlight, type ToolSort } from '../tool-audit-report';
import { operationDescription, operationName } from '../operation-glossary';
import ToolAuditDrawer from './ToolAuditDrawer';
import ToolAuditInspector from './ToolAuditInspector';
import ToolAuditSplitter from './ToolAuditSplitter';
import ToolTimeSplit from './ToolTimeSplit';
import SkillActivity, { type ReportStatus } from './SkillActivity';
import type { SessionLinks } from './SkillInspector';
import { readDetailsWidth, writeDetailsWidth } from '../tool-audit-layout';
import { useMediaQuery } from '../use-media-query';
import { useModalDismiss, useScrimDismiss } from './use-modal-dismiss';

const FIRST_ROWS = 12;
const providers: { id: AuditProvider; label: string }[] = [{ id: 'all', label: 'All agents' }, { id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }];
/** The two views, each opened by a door of its own on the right stripe (rail-items.tsx). */
export type ToolActivityView = 'tools' | 'skills';
type View = ToolActivityView;
/** Each view's title, and the stripe door that opens it — where focus goes back to. */
const viewTitle: Record<View, string> = { tools: 'Tool activity', skills: 'Skill activity' };
const viewDoor: Record<View, string> = { tools: 'tool-activity', skills: 'skill-activity' };

const RefreshGlyph = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5" /></svg>;
const SearchGlyph = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>;
const highlightGlyph: Record<Highlight['kind'], ReactNode> = {
  time: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M9.5 2.5h5" /></svg>,
  failing: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>,
  slow: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M3 17h18M6 17a6 6 0 0 1 12 0M12 17l3.5-4.5" /></svg>,
};

/** What a screen reader hears for a row: every value, with its meaning. */
function rowLabel(row: AuditRow) {
  const failed = row.failed ? `${row.failed.toLocaleString()} failed (${failureShare(row)})` : 'none failed';
  const time = row.totalMs === null ? 'not timed' : `${auditDuration(row.totalMs)} in total, usually ${auditDuration(row.medianMs)}`;
  return `${operationName(row.operation)}${operationDescription(row.operation) ? `, ${operationDescription(row.operation)}` : ''}: ${count(row.calls, 'call')}, ${time}, ${failed}`;
}

export default function ToolAuditModal({ view: door = 'tools', onClose, sessionLabel, onOpenSession }: SessionLinks & { view?: View; onClose: () => void }) {
  // Tools and Skills read the same journal for the same period and agent (#2181).
  // No tabs between them: each opens from its own door. The Skill tool's details
  // still lead on to the skills it loaded, so the view can change once open.
  const [view, setView] = useState<View>(door);
  const [provider, setProvider] = useState<AuditProvider>('all');
  const [period, setPeriod] = useState('7');
  const [skillRefresh, setSkillRefresh] = useState(0);
  const [skillStatus, setSkillStatus] = useState<ReportStatus>({ loading: true, detailLoading: false, capturedAt: null, hasData: false });
  const [sort, setSort] = useState<ToolSort>('calls');
  const [search, setSearch] = useState('');
  const sortRef = useRef(sort); sortRef.current = sort;
  const searchRef = useRef(search); searchRef.current = search;
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const initialSelectionMade = useRef(false);
  const shownRow = useRef<AuditRow | null>(null);
  const [keyboardSelection, setKeyboardSelection] = useState(false);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const selectionOrigin = useRef<HTMLElement | null>(null);
  const [data, setData] = useState<AuditReport | null>(null);
  const [details, setDetails] = useState<AuditReport['details']>(null);
  const [detailKind, setDetailKind] = useState<'recent' | 'slowest'>('recent');
  const [loading, setLoading] = useState(true); const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(''); const [detailError, setDetailError] = useState('');
  const [refresh, setRefresh] = useState(0); const busy = useRef(false); const loadedQuery = useRef<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  // Beside the list from 960px; narrower, the details stack under it or become a sheet.
  const sideBySide = useMediaQuery('(min-width: 960px)');
  const [detailsWidth, setDetailsWidth] = useState(readDetailsWidth);
  const resizeDetails = (width: number) => { setDetailsWidth(width); writeDetailsWidth(width); };
  // Read once, on the first render, while focus is still on the rail button that opened this.
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeReport = () => {
    onClose();
    requestAnimationFrame(() => {
      const original = opener;
      const fallback = Array.from(document.querySelectorAll<HTMLElement>(`[data-rail-item="${viewDoor[door]}"], [data-rail-item="more"]`)).find(element => element.checkVisibility());
      // Safari does not focus a button on click, so the opener can be <body>, which restores nothing.
      (original && original !== document.body && original.isConnected && original.checkVisibility() ? original : fallback)?.focus({ preventScroll: true });
    });
  };
  const dialogRef = useModalDismiss(closeReport, { focusRef: closeRef });
  const scrimPress = useScrimDismiss(closeReport);
  // The reader's zone, so a day in the report is a day on their calendar.
  const query = new URLSearchParams({ provider, days: period, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).toString();

  useEffect(() => {
    // One report at a time: the Skills view reads its own while it is open.
    if (view !== 'tools') return;
    const controller = new AbortController(); let live = true;
    const deadline = window.setTimeout(() => controller.abort(), 65000);
    setError('');
    // A refresh keeps the numbers on screen; a new period or agent never shows the old ones.
    if (loadedQuery.current !== query) { setData(null); setDetails(null); setShowAll(false); }
    busy.current = true; setLoading(true);
    void (async () => {
      try {
        const reply = await readAuditReport(query, controller.signal);
        if (live) {
          loadedQuery.current = query; setData(reply);
          const first = !initialSelectionMade.current && sortTools(reply.rows, sortRef.current, searchRef.current)[0];
          if (first) { initialSelectionMade.current = true; setSelected(first.operation); }
          // Open details whose tool the new period lacks move to its first, rather than closing.
          else if (selectedRef.current && !reply.rows.some(row => row.operation === selectedRef.current)) setSelected(sortTools(reply.rows, sortRef.current, searchRef.current)[0]?.operation ?? null);
        }
      } catch (e) { if (live) setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'Reading the history took too long. Try again, or keep less history in Settings.'); }
      finally { window.clearTimeout(deadline); if (live) { busy.current = false; setLoading(false); } }
    })();
    return () => { live = false; controller.abort(); window.clearTimeout(deadline); busy.current = false; };
  }, [query, refresh, view]);

  useEffect(() => {
    setDetails(previous => previous?.operation === selected && loadedQuery.current === query ? previous : null); setDetailError('');
    // `busy` and not just `loading`: back on this view, the list's read starts in this same commit,
    // where `loading` is still false, and the two reads would meet at the one report worker.
    if (!selected || !data || loading || busy.current || view !== 'tools') { setDetailLoading(false); return; }
    let live = true; const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 65000); setDetailLoading(true);
    void (async () => {
      try {
        const reply = await readAuditReport(`${query}&operation=${encodeURIComponent(selected)}&history=1`, controller.signal);
        if (live) { if (reply.details?.measurements === null) setSelected(null); else setDetails(reply.details); }
      } catch { if (live) setDetailError('Could not read the calls for this tool. Close it and open it again to retry.'); }
      finally { window.clearTimeout(deadline); if (live) setDetailLoading(false); }
    })();
    return () => { live = false; controller.abort(); window.clearTimeout(deadline); };
  }, [selected, data, loading, query, view]);

  const rows = useMemo(() => sortTools(data?.rows ?? [], sort, search), [data, sort, search]);
  const highlights = useMemo(() => data ? findHighlights(data.rows, data.totalMs) : [], [data]);
  const visible = showAll || search ? rows : rows.slice(0, FIRST_ROWS);
  const top = rows.length ? toolSortValue(rows[0], sort) ?? 0 : 0;
  const liveRow = data?.rows.find(row => row.operation === selected);
  if (liveRow) shownRow.current = liveRow;
  // Across a new period or agent the details stay open on the tool they showed, its
  // numbers held back until the new report arrives, so the panel neither closes nor moves.
  const selection = liveRow ?? (selected && !data && shownRow.current?.operation === selected ? shownRow.current : undefined);

  const select = (operation: string) => (event: MouseEvent<HTMLButtonElement>) => {
    selectionOrigin.current = event.currentTarget;
    setKeyboardSelection(event.detail === 0); setDetailKind('recent');
    setSelected(current => current === operation ? null : operation);
  };
  const closeInspector = () => {
    const operation = selected; setSelected(null);
    requestAnimationFrame(() => {
      const origin = selectionOrigin.current;
      const row = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('.ta-row[data-operation]') ?? []).find(button => button.dataset.operation === operation);
      (origin?.isConnected && origin.checkVisibility() ? origin : row ?? closeRef.current)?.focus({ preventScroll: true });
    });
  };
  const doRefresh = () => {
    if (view === 'skills') { if (!skillStatus.loading && !skillStatus.detailLoading) setSkillRefresh(value => value + 1); return; }
    if (busy.current || detailLoading) return; busy.current = true; setRefresh(value => value + 1);
  };
  const summary = data && summaryParts(data, provider, period);
  const reading = view === 'skills' ? skillStatus.loading : loading;
  const shown = view === 'skills' ? (skillStatus.hasData ? skillStatus.capturedAt : null) : data?.capturedAt ?? null;
  const filters = <div className="ta-filters">
    <div className="uh-range" role="group" aria-label="Period">{Object.entries(periodLabels).map(([days, label]) => <button key={days} type="button" className="uh-range-btn" aria-pressed={period === days} onClick={() => setPeriod(days)}>{label}</button>)}</div>
    <div className="uh-range" role="group" aria-label="Agent">{providers.map(item => <button key={item.id} type="button" className="uh-range-btn" aria-pressed={provider === item.id} onClick={() => setProvider(item.id)}>{item.label}</button>)}</div>
  </div>;

  return createPortal(<div className="modal-backdrop" role="presentation" {...scrimPress}>
    <div className="modal ta-report" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tool-audit-title" data-view={view}>
      <header className="ta-report-header">
        <h2 id="tool-audit-title">{viewTitle[view]}</h2>
        <div className="ta-actions">
          <span className="ta-freshness" role="status">{reading ? shown !== null ? 'Updating…' : 'Reading history…' : shown !== null ? `Updated ${new Date(shown).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
          <button type="button" className="glyph-btn" aria-label={view === 'skills' ? 'Refresh skill activity' : 'Refresh tool activity'} title="Refresh" data-loading={reading || undefined} aria-busy={view === 'skills' ? skillStatus.loading || skillStatus.detailLoading : loading || detailLoading} onClick={doRefresh}><RefreshGlyph /></button>
          <button type="button" ref={closeRef} className="glyph-btn" onClick={closeReport} aria-label={`Close ${viewTitle[view].toLowerCase()}`} title="Close (Esc)">×</button>
        </div>
      </header>
      <div className="ta-view-panel">
      {view === 'skills' ? <SkillActivity filters={filters} provider={provider} period={period} setPeriod={setPeriod} refresh={skillRefresh} onStatus={setSkillStatus} sessionLabel={sessionLabel} onOpenSession={onOpenSession} /> :
      <div className="ta-workspace" ref={workspaceRef} data-inspecting={!!selection || undefined} style={{ "--ta-details-w": `${detailsWidth}px` } as CSSProperties}>
        <div className="ta-body"><div className="ta-report-content">
          {filters}

          {loading && !data && <div className="ta-loading" role="status" aria-label="Reading tool history"><i /><i /><i /><i /><i /></div>}
          {error && <div className="ta-message" role="alert"><p>{data && 'Showing the last numbers. '}{error}</p><button type="button" className="btn" onClick={doRefresh}>Try again</button></div>}

          {data && summary && (data.total === 0 ? <div className="ta-empty">
            <h3>No tool calls in the last {periodLabels[period]}</h3>
            <p>ccdeck records each tool {provider === 'all' ? 'Claude Code and Codex use' : provider === 'claude' ? 'Claude Code uses' : 'Codex uses'} on this device, starting {auditDay(data.startedAt)}. Run a session and the calls show up here.</p>
            {period !== '90' && <button type="button" className="btn" onClick={() => setPeriod('90')}>Show the last 90 days</button>}
          </div> : <>
            <p className="ta-summary">
              {summary.lead} <strong>{summary.calls}</strong>
              {summary.time && <> and spent <strong>{summary.time}</strong> running them</>}.{' '}
              {summary.failed ? <><strong className="ta-bad">{summary.failed.toLocaleString()} failed</strong> ({summary.failedShare}).</> : 'None failed.'}
            </p>
            {(!data.storageOk || data.dropped > 0 || data.corrupt > 0) && <p className="ta-warning" role="status">Some calls could not be saved or read, so these numbers may be a little low.{!data.storageOk && ' Check free disk space.'}</p>}

            {/* At a glance: what is worth a look beside where the time went. */}
            {(highlights.length > 0 || data.split) && <div className="ta-glance" data-single={!(highlights.length > 0 && data.split) || undefined}>
              {highlights.length > 0 && <section className="ta-highlights" aria-labelledby="ta-highlights-title">
                <h3 id="ta-highlights-title">Worth a look</h3>
                <ul>{highlights.map(item => <li key={item.kind}><button type="button" className="ta-highlight" data-kind={item.kind} data-operation={item.operation} aria-expanded={selected === item.operation} aria-controls={selected === item.operation ? 'tool-operation-inspector' : undefined} onClick={select(item.operation)}>
                  <span className="ta-highlight-glyph">{highlightGlyph[item.kind]}</span>
                  <span className="ta-highlight-text"><span><code>{operationName(item.operation)}</code> {item.title}</span><small>{item.detail}</small></span>
                </button></li>)}</ul>
              </section>}
              {data.split && <ToolTimeSplit split={data.split} since={data.since} turnsSince={data.turnsSince} selected={selected} onPick={(operation, event) => select(operation)(event)} />}
            </div>}

            <section className="ta-tools" aria-labelledby="ta-tools-title">
              <div className="ta-tools-head">
                <h3 id="ta-tools-title">Tools and commands <span className="ta-count">{data.rows.length.toLocaleString()}</span></h3>
                <label className="ta-search"><SearchGlyph /><input type="search" aria-label="Find a tool or command" placeholder="Find a tool or command" value={search} onChange={event => setSearch(event.target.value)} /></label>
              </div>
              <div className="uh-range ta-sorts" role="group" aria-label="Sort by">{toolSorts.map(item => <button key={item.id} type="button" className="uh-range-btn" aria-pressed={sort === item.id} onClick={() => setSort(item.id)}>{item.label}</button>)}</div>
              <div className="ta-list-head" aria-hidden="true" data-sort={sort}><span>Name</span><span data-col="calls">Calls</span><span data-col="time">Total time</span><span data-col="slowest">Usually</span><span data-col="failed">Failed</span></div>
              <ul className="ta-list" data-sort={sort}>{visible.map(row => {
                const value = toolSortValue(row, sort);
                const description = operationDescription(row.operation);
                return <li key={row.operation}><button type="button" className="ta-row" data-operation={row.operation} data-selected={selected === row.operation || undefined} aria-expanded={selected === row.operation} aria-controls={selected === row.operation ? 'tool-operation-inspector' : undefined} aria-label={rowLabel(row)} onClick={select(row.operation)}>
                  <span className="ta-row-name"><span className="ta-op">{operationName(row.operation)}</span>{description && <span className="ta-desc">{description}</span>}<span className="ta-bar" aria-hidden="true" style={{ "--ta-share": top && value ? Math.max(0.015, value / top) : 0 } as CSSProperties} /></span>
                  <span className="ta-cell" data-col="calls">{row.calls.toLocaleString()}<span className="ta-unit"> {row.calls === 1 ? 'call' : 'calls'}</span></span>
                  <span className="ta-cell" data-col="time">{auditDuration(row.totalMs)}<span className="ta-unit"> total</span></span>
                  <span className="ta-cell" data-col="slowest"><span className="ta-unit">usually </span>{auditDuration(row.medianMs)}</span>
                  <span className="ta-cell" data-col="failed" data-bad={row.failed > 0 || undefined}>{row.failed ? <>{row.failed.toLocaleString()}<span className="ta-unit"> failed</span><small>{failureShare(row)}</small></> : <span className="ta-zero">0<span className="ta-unit"> failed</span></span>}</span>
                </button></li>;
              })}</ul>
              {!rows.length && <p className="ta-note ta-no-match">No tool or command matches “{search.trim()}”.</p>}
              {!search && !showAll && rows.length > FIRST_ROWS && <button type="button" className="btn ta-more" onClick={() => setShowAll(true)}>Show all {rows.length.toLocaleString()}</button>}
            </section>

            <details className="ta-explain">
              <summary>How this is counted</summary>
              <ul>
                <li>A call’s time runs from when the agent starts the tool until it reports back, so it can include waiting for your approval.</li>
                <li>Where the time went follows each Claude Code turn by the clock, from your prompt until Claude stops: this machine while a tool runs or its hooks start it, you while Claude waits for your approval or answer, and Claude for the rest. Calls that ran together count once, and a pipeline’s time goes to the command feeding it, not to the <code>tail</code> reading its output.</li>
                <li>Total time adds every call together. Calls that ran at the same time each count, so it can be more than the time that actually passed.</li>
                <li>“Usually” is the middle value: half of the calls were quicker, half took longer.</li>
                <li>A command line such as <code>git add . &amp;&amp; git commit</code> counts once for each command in it, and shares its time and result with both.</li>
                <li>Claude and Codex report times in different ways, so do not compare one with the other.</li>
                <li>Recorded on this device since {auditDay(data.startedAt)} and kept for {data.retentionDays} days. Commands are grouped by name; their arguments and output are never saved. Change this in Settings.</li>
              </ul>
            </details>
          </>)}
        </div></div>
        {selection && sideBySide && <ToolAuditSplitter width={detailsWidth} workspace={workspaceRef} onCommit={resizeDetails} />}
        {selection && <ToolAuditDrawer keyboard={keyboardSelection} itemKey={selection.operation} onClose={closeInspector}>
          <ToolAuditInspector row={details?.operation === selected && details.measurements ? details.measurements : selection} details={details?.operation === selected ? details : null} loading={detailLoading} pending={!liveRow} charted={Number(period) >= 7} error={detailError} kind={detailKind} setKind={setDetailKind} onClose={closeInspector}
            onShowSkills={selection.operation === 'Skill' ? () => { setSelected(null); setView('skills'); } : undefined} />
        </ToolAuditDrawer>}
      </div>}
      </div>
    </div>
  </div>, document.body);
}
