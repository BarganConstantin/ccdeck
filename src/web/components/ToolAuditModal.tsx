import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { auditDuration, readAuditReport, type AuditProvider, type AuditReport, type AuditRow } from '../tool-audit';
import { auditDay, countOf, failureShare, findHighlights, periodIn, periodLabel, periodLabels, sortTools, summaryParts, toolSortLabel, toolSorts, toolSortValue, type Highlight, type ToolSort } from '../tool-audit-report';
import { ownMessage } from '../own-error';
import { t as translate, useLanguage, useT, currentLanguage } from '../i18n';
import { rich } from '../insights-rich';
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
const providers: { id: AuditProvider; label: string }[] = [{ id: 'all', label: translate('insights.audit.agents.all') }, { id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }];
const agentLabel = (id: AuditProvider) => id === 'all' ? translate('insights.audit.agents.all') : id === 'claude' ? 'Claude' : 'Codex';
/** The two views, each opened by a door of its own on the right stripe (rail-items.tsx). */
export type ToolActivityView = 'tools' | 'skills';
type View = ToolActivityView;
/** Each view's title, and the stripe door that opens it — where focus goes back to. */
const viewTitle = (view: View) => translate(view === 'tools' ? 'insights.audit.title.tools' : 'insights.audit.title.skills');
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
  const failed = row.failed ? translate('insights.audit.row.failed', { n: row.failed.toLocaleString(currentLanguage()), share: failureShare(row) ?? '' }) : translate('insights.audit.row.noneFailed');
  const time = row.totalMs === null ? translate('insights.audit.row.notTimed') : translate('insights.audit.row.timed', { total: auditDuration(row.totalMs), usual: auditDuration(row.medianMs) });
  const description = operationDescription(row.operation);
  return translate('insights.audit.row.label', { name: operationName(row.operation), description: description ? `, ${description}` : '', calls: countOf(row.calls, 'call'), time, failed });
}

export default function ToolAuditModal({ view: door = 'tools', onClose, sessionLabel, onOpenSession }: SessionLinks & { view?: View; onClose: () => void }) {
  // Tools and Skills read the same journal for the same period and agent (#2181).
  // No tabs between them: each opens from its own door. The Skill tool's details
  // still lead on to the skills it loaded, so the view can change once open.
  const t = useT();
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
      } catch (e) { if (live) setError(ownMessage(e, t('insights.audit.err.slow'))); }
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
      } catch { if (live) setDetailError(t('insights.audit.err.calls')); }
      finally { window.clearTimeout(deadline); if (live) setDetailLoading(false); }
    })();
    return () => { live = false; controller.abort(); window.clearTimeout(deadline); };
  }, [selected, data, loading, query, view]);

  const rows = useMemo(() => sortTools(data?.rows ?? [], sort, search), [data, sort, search]);
  const language = useLanguage();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const highlights = useMemo(() => data ? findHighlights(data.rows, data.totalMs) : [], [data, language]);
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
    <div className="uh-range" role="group" aria-label={t('insights.audit.period')}>{Object.keys(periodLabels).map(days => <button key={days} type="button" className="uh-range-btn" aria-pressed={period === days} onClick={() => setPeriod(days)}>{periodLabel(days)}</button>)}</div>
    <div className="uh-range" role="group" aria-label={t('insights.audit.agent')}>{providers.map(item => <button key={item.id} type="button" className="uh-range-btn" aria-pressed={provider === item.id} onClick={() => setProvider(item.id)}>{agentLabel(item.id)}</button>)}</div>
  </div>;

  return createPortal(<div className="modal-backdrop" role="presentation" {...scrimPress}>
    <div className="modal ta-report" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tool-audit-title" data-view={view}>
      <header className="modal-head ta-report-header">
        <h2 id="tool-audit-title">{viewTitle(view)}</h2>
        <div className="ta-actions">
          <span className="ta-freshness" role="status">{reading ? shown !== null ? t('insights.audit.updating') : t('insights.audit.reading') : shown !== null ? t('insights.audit.updated', { time: new Date(shown).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }) }) : ''}</span>
          <button type="button" className="glyph-btn" aria-label={view === 'skills' ? t('insights.audit.refresh.skills') : t('insights.audit.refresh.tools')} title={t('insights.audit.refresh')} data-loading={reading || undefined} aria-busy={view === 'skills' ? skillStatus.loading || skillStatus.detailLoading : loading || detailLoading} onClick={doRefresh}><RefreshGlyph /></button>
          <button type="button" ref={closeRef} className="glyph-btn" onClick={closeReport} aria-label={view === 'skills' ? t('insights.audit.close.skills') : t('insights.audit.close.tools')} title={t('insights.audit.closeEsc')}>×</button>
        </div>
      </header>
      <div className="ta-view-panel">
      {view === 'skills' ? <SkillActivity filters={filters} provider={provider} period={period} setPeriod={setPeriod} refresh={skillRefresh} onStatus={setSkillStatus} sessionLabel={sessionLabel} onOpenSession={onOpenSession} /> :
      <div className="ta-workspace" ref={workspaceRef} data-inspecting={!!selection || undefined} style={{ "--ta-details-w": `${detailsWidth}px` } as CSSProperties}>
        <div className="ta-body"><div className="ta-report-content">
          {filters}

          {loading && !data && <div className="ta-loading" role="status" aria-label={t('insights.audit.readingTools')}><i /><i /><i /><i /><i /></div>}
          {error && <div className="ta-message" role="alert"><p>{data && `${t('insights.audit.lastNumbers')} `}{error}</p><button type="button" className="btn" onClick={doRefresh}>{t('insights.audit.tryAgain')}</button></div>}

          {data && summary && (data.total === 0 ? <div className="ta-empty">
            <h3>{t('insights.audit.empty.title', { period: periodIn(period) })}</h3>
            <p>{t(provider === 'all' ? 'insights.audit.empty.all' : provider === 'claude' ? 'insights.audit.empty.claude' : 'insights.audit.empty.codex', { since: auditDay(data.startedAt) })}</p>
            {period !== '90' && <button type="button" className="btn" onClick={() => setPeriod('90')}>{t('insights.audit.show90')}</button>}
          </div> : <>
            <p className="ta-summary">
              {rich(t(summary.time ? 'insights.audit.summary.timed' : 'insights.audit.summary.untimed', { period: summary.period, who: summary.who }), { calls: <strong>{summary.calls}</strong>, time: <strong>{summary.time}</strong> })}{' '}
              {summary.failed ? rich(t(summary.failedShare ? 'insights.audit.summary.failedShare' : 'insights.audit.summary.failedOnly', { share: summary.failedShare ?? '' }), { failed: <strong className="ta-bad">{t('insights.audit.nFailed', { n: summary.failed.toLocaleString(currentLanguage()) })}</strong> }) : t('insights.audit.noneFailed')}
            </p>
            {(!data.storageOk || data.dropped > 0 || data.corrupt > 0) && <p className="ta-warning" role="status">{t('insights.audit.warning')}{!data.storageOk && ` ${t('insights.audit.diskSpace')}`}</p>}

            {/* At a glance: what is worth a look beside where the time went. */}
            {(highlights.length > 0 || data.split) && <div className="ta-glance" data-single={!(highlights.length > 0 && data.split) || undefined}>
              {highlights.length > 0 && <section className="ta-highlights" aria-labelledby="ta-highlights-title">
                <h3 id="ta-highlights-title">{t('insights.audit.worth')}</h3>
                <ul>{highlights.map(item => <li key={item.kind}><button type="button" className="ta-highlight" data-kind={item.kind} data-operation={item.operation} aria-expanded={selected === item.operation} aria-controls={selected === item.operation ? 'tool-operation-inspector' : undefined} onClick={select(item.operation)}>
                  <span className="ta-highlight-glyph">{highlightGlyph[item.kind]}</span>
                  <span className="ta-highlight-text"><span><code>{operationName(item.operation)}</code> {item.title}</span><small>{item.detail}</small></span>
                </button></li>)}</ul>
              </section>}
              {data.split && <ToolTimeSplit split={data.split} since={data.since} turnsSince={data.turnsSince} selected={selected} onPick={(operation, event) => select(operation)(event)} />}
            </div>}

            <section className="ta-tools" aria-labelledby="ta-tools-title">
              <div className="ta-tools-head">
                <h3 id="ta-tools-title">{t('insights.audit.tools')} <span className="ta-count">{data.rows.length.toLocaleString(currentLanguage())}</span></h3>
                <label className="ta-search"><SearchGlyph /><input type="search" aria-label={t('insights.audit.find')} placeholder={t('insights.audit.find')} value={search} onChange={event => setSearch(event.target.value)} /></label>
              </div>
              <div className="uh-range ta-sorts" role="group" aria-label={t('insights.audit.sortBy')}>{toolSorts.map(item => <button key={item.id} type="button" className="uh-range-btn" aria-pressed={sort === item.id} onClick={() => setSort(item.id)}>{toolSortLabel(item.id)}</button>)}</div>
              <div className="ta-list-head" aria-hidden="true" data-sort={sort}><span>{t('insights.audit.col.name')}</span><span data-col="calls">{t('insights.audit.col.calls')}</span><span data-col="time">{t('insights.audit.col.time')}</span><span data-col="slowest">{t('insights.audit.col.usually')}</span><span data-col="failed">{t('insights.audit.col.failed')}</span></div>
              <ul className="ta-list" data-sort={sort}>{visible.map(row => {
                const value = toolSortValue(row, sort);
                const description = operationDescription(row.operation);
                return <li key={row.operation}><button type="button" className="ta-row" data-operation={row.operation} data-selected={selected === row.operation || undefined} aria-expanded={selected === row.operation} aria-controls={selected === row.operation ? 'tool-operation-inspector' : undefined} aria-label={rowLabel(row)} onClick={select(row.operation)}>
                  <span className="ta-row-name"><span className="ta-op">{operationName(row.operation)}</span>{description && <span className="ta-desc">{description}</span>}<span className="ta-bar" aria-hidden="true" style={{ "--ta-share": top && value ? Math.max(0.015, value / top) : 0 } as CSSProperties} /></span>
                  <span className="ta-cell" data-col="calls">{row.calls.toLocaleString(currentLanguage())}<span className="ta-unit"> {t('insights.audit.unit.calls', { count: row.calls })}</span></span>
                  <span className="ta-cell" data-col="time">{auditDuration(row.totalMs)}<span className="ta-unit"> {t('insights.audit.unit.total')}</span></span>
                  <span className="ta-cell" data-col="slowest"><span className="ta-unit">{t('insights.audit.unit.usually')} </span>{auditDuration(row.medianMs)}</span>
                  <span className="ta-cell" data-col="failed" data-bad={row.failed > 0 || undefined}>{row.failed ? <>{row.failed.toLocaleString(currentLanguage())}<span className="ta-unit"> {t('insights.audit.unit.failed')}</span><small>{failureShare(row)}</small></> : <span className="ta-zero">0<span className="ta-unit"> {t('insights.audit.unit.failed')}</span></span>}</span>
                </button></li>;
              })}</ul>
              {!rows.length && <p className="ta-note ta-no-match">{t('insights.audit.noMatch', { search: search.trim() })}</p>}
              {!search && !showAll && rows.length > FIRST_ROWS && <button type="button" className="btn ta-more" onClick={() => setShowAll(true)}>{t('insights.audit.showAll', { n: rows.length.toLocaleString(currentLanguage()) })}</button>}
            </section>

            <details className="ta-explain">
              <summary>{t('insights.audit.how')}</summary>
              <ul>
                <li>{t('insights.audit.how.1')}</li>
                <li>{rich(t('insights.audit.how.2'), { tail: <code>tail</code> })}</li>
                <li>{t('insights.audit.how.3')}</li>
                <li>{t('insights.audit.how.4')}</li>
                <li>{rich(t('insights.audit.how.5'), { example: <code>git add . &amp;&amp; git commit</code> })}</li>
                <li>{t('insights.audit.how.6')}</li>
                <li>{t('insights.audit.how.7', { since: auditDay(data.startedAt), days: data.retentionDays })}</li>
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
