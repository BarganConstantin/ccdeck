import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { readAuditReport, type AuditProvider, type SkillReport, type SkillRow } from '../tool-audit';
import { auditDay, callTime, countOf, periodIn } from '../tool-audit-report';
import { t as translate, useLanguage, useT, currentLanguage } from '../i18n';
import { rich } from '../insights-rich';
import { countingStartedLate, findSkillHighlights, originLine, originShares, skillOrigins, skillParts, skillSortLabel, skillSorts, skillSummary, sortSkills, typedCommandsNote,
  type SkillHighlight, type SkillOrigin, type SkillSort } from '../skill-activity';
import { readDetailsWidth, writeDetailsWidth } from '../tool-audit-layout';
import { useMediaQuery } from '../use-media-query';
import { useFeatureUse } from '../feature-use';
import ToolAuditDrawer from './ToolAuditDrawer';
import ToolAuditSplitter from './ToolAuditSplitter';
import SkillInspector, { type SessionLinks } from './SkillInspector';
import SkillOrigins from './SkillOrigins';

const FIRST_ROWS = 12;
const SearchGlyph = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>;
const glyph = (path: ReactNode) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>;
const highlightGlyph: Record<SkillHighlight['kind'], ReactNode> = {
  failing: glyph(<><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>),
  top: glyph(<path d="M5 20V11M12 20V4M19 20v-6" />),
  typed: glyph(<><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m10.5 15 3-6" /></>),
  quiet: glyph(<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />),
  new: glyph(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />),
};

/** What the header shows for this view: whether it is reading, and when it last did. */
export interface ReportStatus { loading: boolean; detailLoading: boolean; capturedAt: number | null; hasData: boolean }

function rowLabel(row: SkillRow) {
  return translate(row.failed ? 'insights.skills.rowFailed' : 'insights.skills.row', { name: row.name, uses: countOf(row.uses, 'use'), last: callTime(row.lastAt, Date.now(), true), failed: row.failed.toLocaleString(currentLanguage()) });
}

/** Skill activity (#2181): the Skills view of the Tool activity modal, opened
 *  from its own door on the stripe. The period and agent filters are the
 *  modal's, so both views answer for the same slice. */
export default function SkillActivity({ filters, provider, period, setPeriod, refresh, onStatus, sessionLabel, onOpenSession }: SessionLinks & {
  filters: ReactNode; provider: AuditProvider; period: string; setPeriod: (period: string) => void;
  refresh: number; onStatus: (status: ReportStatus) => void;
}) {
  useFeatureUse('skill-activity');
  const t = useT();
  const language = useLanguage();
  const [sort, setSort] = useState<SkillSort>('uses');
  const [search, setSearch] = useState('');
  const sortRef = useRef(sort); sortRef.current = sort;
  const searchRef = useRef(search); searchRef.current = search;
  const initialSelectionMade = useRef(false);
  const shownRow = useRef<SkillRow | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [origin, setOrigin] = useState<SkillOrigin | null>(null);
  const [keyboardSelection, setKeyboardSelection] = useState(false);
  const selectionOrigin = useRef<HTMLElement | null>(null);
  const [data, setData] = useState<SkillReport | null>(null);
  const [details, setDetails] = useState<SkillReport['details']>(null);
  const [loading, setLoading] = useState(true); const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(''); const [detailError, setDetailError] = useState('');
  const loadedQuery = useRef<string | null>(null); const reading = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const sideBySide = useMediaQuery('(min-width: 960px)');
  const [detailsWidth, setDetailsWidth] = useState(readDetailsWidth);
  const resizeDetails = (width: number) => { setDetailsWidth(width); writeDetailsWidth(width); };
  const query = new URLSearchParams({ view: 'skills', provider, days: period }).toString();
  const status = useRef(onStatus); status.current = onStatus;

  useEffect(() => { status.current({ loading, detailLoading, capturedAt: data?.capturedAt ?? null, hasData: !!data }); }, [loading, detailLoading, data]);

  useEffect(() => {
    const controller = new AbortController(); let live = true;
    const deadline = window.setTimeout(() => controller.abort(), 65000);
    setError('');
    // A refresh keeps the numbers on screen; a new period or agent never shows the old ones.
    if (loadedQuery.current !== query) { setData(null); setDetails(null); setShowAll(false); }
    reading.current = true; setLoading(true);
    void (async () => {
      try {
        const reply = await readAuditReport<SkillReport>(query, controller.signal);
        if (live) {
          loadedQuery.current = query; setData(reply);
          // Open on the first skill, once, as Tool activity opens on its first tool;
          // closed details stay closed through refreshes and sorting.
          const first = !initialSelectionMade.current && sortSkills(reply.rows, sortRef.current, searchRef.current).find(row => row.uses > 0);
          if (first) { initialSelectionMade.current = true; setSelected(first.name); }
          // Open details whose skill the new period lacks move to its first, rather than closing.
          else setSelected(current => !current || reply.rows.some(row => row.name === current) ? current
            : sortSkills(reply.rows, sortRef.current, searchRef.current).find(row => row.uses > 0)?.name ?? null);
        }
      } catch (e) { if (live) setError(e instanceof Error && e.name !== 'AbortError' ? e.message : t('insights.audit.err.slow')); }
      finally { window.clearTimeout(deadline); if (live) { reading.current = false; setLoading(false); } }
    })();
    return () => { live = false; controller.abort(); window.clearTimeout(deadline); reading.current = false; };
  }, [query, refresh]);

  useEffect(() => {
    setDetails(previous => previous?.name === selected && loadedQuery.current === query ? previous : null); setDetailError('');
    // `reading` and not just `loading`: a new period starts the list's read in this same commit,
    // where `loading` is still false, and the two reads would meet at the one report worker.
    if (!selected || !data || loading || reading.current) { setDetailLoading(false); return; }
    let live = true; const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 65000); setDetailLoading(true);
    void (async () => {
      try {
        const reply = await readAuditReport<SkillReport>(`${query}&skill=${encodeURIComponent(selected)}&history=1&timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, controller.signal);
        if (live) { if (!reply.details?.row) setSelected(null); else setDetails(reply.details); }
      } catch { if (live) setDetailError(t('insights.skills.err.uses')); }
      finally { window.clearTimeout(deadline); if (live) setDetailLoading(false); }
    })();
    return () => { live = false; controller.abort(); window.clearTimeout(deadline); };
  }, [selected, data, loading, query]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shares = useMemo(() => data ? originShares(data, provider) : [], [data, provider, language]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const highlights = useMemo(() => data ? findSkillHighlights(data, provider) : [], [data, provider, language]);
  // A lane that left with a new period or agent no longer filters.
  const kept = origin && shares.some(part => part.id === origin && part.uses > 0) ? origin : null;
  const rows = useMemo(() => sortSkills(data?.rows ?? [], sort, search).filter(row => !kept || row[kept] > 0), [data, sort, search, kept]);
  const visible = showAll || search ? rows : rows.slice(0, FIRST_ROWS);
  const top = rows.reduce((most, row) => Math.max(most, row.uses), 0);
  const liveRow = data?.rows.find(row => row.name === selected);
  if (liveRow) shownRow.current = liveRow;
  // Across a new period or agent the details stay open on the skill they showed, its
  // numbers held back until the new report arrives, so the panel neither closes nor moves.
  const selection = liveRow ?? (selected && !data && shownRow.current?.name === selected ? shownRow.current : undefined);
  const failures = !!data && data.failed > 0;

  const select = (name: string) => (event: MouseEvent<HTMLButtonElement>) => {
    selectionOrigin.current = event.currentTarget;
    setKeyboardSelection(event.detail === 0);
    setSelected(current => current === name ? null : name);
  };
  const closeInspector = () => {
    const name = selected; setSelected(null);
    requestAnimationFrame(() => {
      const origin = selectionOrigin.current;
      const row = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.ta-row[data-skill]') ?? []).find(button => button.dataset.skill === name);
      (origin?.isConnected && origin.checkVisibility() ? origin : row)?.focus({ preventScroll: true });
    });
  };
  const summary = data && skillSummary(data, provider, period);
  const late = data && countingStartedLate(data);
  const typedNote = data && typedCommandsNote(data, provider);

  return <div className="ta-workspace" ref={workspaceRef} data-inspecting={!!selection || undefined} style={{ "--ta-details-w": `${detailsWidth}px` } as CSSProperties}>
    <div className="ta-body"><div className="ta-report-content">
      {filters}

      {loading && !data && <div className="ta-loading" role="status" aria-label={t('insights.skills.reading')}><i /><i /><i /><i /><i /></div>}
      {error && <div className="ta-message" role="alert"><p>{data && `${t('insights.audit.lastNumbers')} `}{error}</p></div>}

      {data && summary && (data.total === 0 && data.repeats === 0 ? <div className="ta-empty">
        <h3>{t('insights.skills.empty.title', { period: periodIn(period) })}</h3>
        <p>{t(provider === 'all' ? 'insights.skills.empty.all' : provider === 'claude' ? 'insights.skills.empty.claude' : 'insights.skills.empty.codex', { since: auditDay(data.countedSince) })}</p>
        {typedNote && <p className="sa-typed-note">{typedNote}</p>}
        {period !== '90' && !late && <button type="button" className="btn" onClick={() => setPeriod('90')}>{t('insights.audit.show90')}</button>}
      </div> : <>
        <p className="ta-summary">
          {rich(t(data.total > 0 ? 'insights.skills.summary.uses' : 'insights.skills.summary.skills', { period: summary.period, who: summary.who }), { skills: <strong>{summary.skills}</strong>, uses: <strong>{summary.uses}</strong> })}{' '}
          {summary.failed > 0 && <>{rich(t('insights.skills.summary.failed'), { failed: <strong className="ta-bad">{t('insights.audit.nFailed', { n: summary.failed.toLocaleString(currentLanguage()) })}</strong> })} </>}
          {summary.repeats > 0 && rich(t('insights.skills.summary.repeats', { count: summary.repeats, n: countOf(summary.repeats, 'repeatedRun') }), { loop: <code>/loop</code> })}
        </p>
        {late && <p className="ta-note sa-since">{t('insights.skills.since', { date: auditDay(data.countedSince) })}</p>}
        {typedNote && <p className="ta-note sa-typed-note">{typedNote}</p>}
        {(!data.storageOk || data.dropped > 0 || data.corrupt > 0) && <p className="ta-warning" role="status">{t('insights.skills.warning')}{!data.storageOk && ` ${t('insights.audit.diskSpace')}`}</p>}

        {/* At a glance: what is worth a look beside who starts the skills. */}
        {(highlights.length > 0 || data.total > 0) && <div className="ta-glance" data-single={!(highlights.length > 0 && data.total > 0) || undefined}>
          {highlights.length > 0 && <section className="ta-highlights" aria-labelledby="sa-highlights-title">
            <h3 id="sa-highlights-title">{t('insights.audit.worth')}</h3>
            <ul>{highlights.map(item => <li key={item.kind}><button type="button" className="ta-highlight" data-kind={item.kind} data-skill={item.skill} aria-expanded={selected === item.skill} aria-controls={selected === item.skill ? 'tool-operation-inspector' : undefined} onClick={select(item.skill)}>
              <span className="ta-highlight-glyph">{highlightGlyph[item.kind]}</span>
              <span className="ta-highlight-text"><span><code>{skillParts(item.skill).short}</code> {item.title}</span><small>{item.detail}</small></span>
            </button></li>)}</ul>
          </section>}
          {data.total > 0 && <SkillOrigins shares={shares} total={data.total} filter={kept} onFilter={setOrigin} />}
        </div>}

        <section className="ta-tools" aria-labelledby="sa-skills-title">
          <div className="ta-tools-head">
            <h3 id="sa-skills-title">{t('insights.skills.title')} <span className="ta-count">{kept ? t('insights.skills.countOf', { n: rows.length.toLocaleString(currentLanguage()), total: data.rows.length.toLocaleString(currentLanguage()) }) : data.rows.length.toLocaleString(currentLanguage())}</span></h3>
            <label className="ta-search"><SearchGlyph /><input type="search" aria-label={t('insights.skills.find')} placeholder={t('insights.skills.find')} value={search} onChange={event => setSearch(event.target.value)} /></label>
          </div>
          <div className="uh-range ta-sorts sa-sorts" role="group" aria-label={t('insights.audit.sortBy')}>{skillSorts.map(item => <button key={item.id} type="button" className="uh-range-btn" aria-pressed={sort === item.id} onClick={() => setSort(item.id)}>{skillSortLabel(item.id)}</button>)}</div>
          <div className="ta-list-head sa-list-head" aria-hidden="true" data-sort={sort} data-failures={failures || undefined}><span>{t('insights.audit.col.name')}</span><span data-col="uses">{t('insights.skills.col.uses')}</span><span data-col="recent">{t('insights.skills.col.last')}</span>{failures && <span data-col="failed">{t('insights.audit.col.failed')}</span>}</div>
          <ul className="ta-list sa-list" ref={listRef} data-sort={sort} data-failures={failures || undefined}>{visible.map(row => {
            const { namespace, short } = skillParts(row.name);
            return <li key={row.name}><button type="button" className="ta-row" data-skill={row.name} data-selected={selected === row.name || undefined} aria-expanded={selected === row.name} aria-controls={selected === row.name ? 'tool-operation-inspector' : undefined} aria-label={rowLabel(row)} onClick={select(row.name)}>
              <span className="ta-row-name"><span className="ta-op">{namespace && <span className="sa-namespace">{namespace}</span>}{short}</span><span className="ta-desc">{[originLine(row), countOf(row.sessions, 'session'), row.repeats > 0 && countOf(row.repeats, 'repeat')].filter(Boolean).join(' · ')}</span>
                <span className="ta-bar" aria-hidden="true" style={{ "--ta-share": top && sort === 'uses' ? Math.max(0.015, row.uses / top) : 0 } as CSSProperties}>
                  {skillOrigins.filter(id => row[id] > 0).map(id => <i key={id} data-lane={id} style={{ flexGrow: row[id] }} />)}</span></span>
              <span className="ta-cell" data-col="uses">{row.uses.toLocaleString(currentLanguage())}<span className="ta-unit"> {t('insights.skills.unit.uses', { count: row.uses })}</span></span>
              <span className="ta-cell" data-col="recent"><span className="ta-unit">{t('insights.skills.unit.last')} </span>{callTime(row.lastAt, Date.now(), true)}</span>
              {failures && <span className="ta-cell" data-col="failed" data-bad={row.failed > 0 || undefined}>{row.failed ? <>{row.failed.toLocaleString(currentLanguage())}<span className="ta-unit"> {t('insights.audit.unit.failed')}</span></> : <span className="ta-zero">0<span className="ta-unit"> {t('insights.audit.unit.failed')}</span></span>}</span>}
            </button></li>;
          })}</ul>
          {!rows.length && search.trim() && <p className="ta-note ta-no-match">{t(kept ? 'insights.skills.noMatchAmong' : 'insights.skills.noMatch', { search: search.trim() })}</p>}
          {!search && !showAll && rows.length > FIRST_ROWS && <button type="button" className="btn ta-more" onClick={() => setShowAll(true)}>{t('insights.audit.showAll', { n: rows.length.toLocaleString(currentLanguage()) })}</button>}
        </section>

        <details className="ta-explain">
          <summary>{t('insights.audit.how')}</summary>
          <ul>
            <li>{rich(t('insights.skills.how.1'), { dollar: <code>$</code>, skills: <code>/skills</code> })}</li>
            <li>{rich(t('insights.skills.how.2'), { file: <code>SKILL.md</code> })}</li>
            <li>{rich(t('insights.skills.how.3'), { hook: <code>UserPromptExpansion</code>, env: <code>AGENTS_DECK_SKILL_HOOK=0</code> })}</li>
            <li>{rich(t('insights.skills.how.4'), { loop: <code>/loop</code> })}</li>
            <li>{rich(t('insights.skills.how.5'), { clear: <code>/clear</code>, model: <code>/model</code> })}</li>
            <li>{t('insights.skills.how.6')}</li>
            <li>{t('insights.skills.how.7', { since: auditDay(data.countedSince), days: data.retentionDays })}</li>
          </ul>
        </details>
      </>)}
    </div></div>
    {selection && sideBySide && <ToolAuditSplitter width={detailsWidth} workspace={workspaceRef} onCommit={resizeDetails} />}
    {selection && <ToolAuditDrawer keyboard={keyboardSelection} itemKey={selection.name} onClose={closeInspector}>
      <SkillInspector row={details?.name === selected && details.row ? details.row : selection} details={details?.name === selected ? details : null} loading={detailLoading} pending={!liveRow} charted={Number(period) >= 7} error={detailError} onClose={closeInspector} sessionLabel={sessionLabel} onOpenSession={onOpenSession} />
    </ToolAuditDrawer>}
  </div>;
}
