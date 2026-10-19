import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { readAuditReport, type AuditProvider, type SkillReport, type SkillRow } from '../tool-audit';
import { auditDay, callTime, count, periodLabels } from '../tool-audit-report';
import { countingStartedLate, skillAgents, skillParts, skillSorts, skillSummary, sortSkills, type SkillSort } from '../skill-activity';
import { readDetailsWidth, writeDetailsWidth } from '../tool-audit-layout';
import { useMediaQuery } from '../use-media-query';
import { useFeatureUse } from '../feature-use';
import ToolAuditDrawer from './ToolAuditDrawer';
import ToolAuditSplitter from './ToolAuditSplitter';
import SkillInspector, { type SessionLinks } from './SkillInspector';

const FIRST_ROWS = 12;
const SearchGlyph = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>;

/** What the header shows for this view: whether it is reading, and when it last did. */
export interface ReportStatus { loading: boolean; detailLoading: boolean; capturedAt: number | null; hasData: boolean }

function rowLabel(row: SkillRow) {
  return `${row.name}: ${count(row.uses, 'use')}, last used ${callTime(row.lastAt)}${row.failed ? `, ${row.failed.toLocaleString()} failed` : ''}`;
}

/** Skill activity (#2181): the Skills tab of the Tool activity modal. The period
 *  and agent filters are the modal's, so both tabs answer for the same slice. */
export default function SkillActivity({ filters, provider, period, setPeriod, refresh, onStatus, sessionLabel, onOpenSession }: SessionLinks & {
  filters: ReactNode; provider: AuditProvider; period: string; setPeriod: (period: string) => void;
  refresh: number; onStatus: (status: ReportStatus) => void;
}) {
  useFeatureUse('skill-activity');
  const [sort, setSort] = useState<SkillSort>('uses');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [keyboardSelection, setKeyboardSelection] = useState(false);
  const selectionOrigin = useRef<HTMLElement | null>(null);
  const [data, setData] = useState<SkillReport | null>(null);
  const [details, setDetails] = useState<SkillReport['details']>(null);
  const [loading, setLoading] = useState(true); const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(''); const [detailError, setDetailError] = useState('');
  const loadedQuery = useRef<string | null>(null);
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
    setLoading(true);
    void (async () => {
      try {
        const reply = await readAuditReport<SkillReport>(query, controller.signal);
        if (live) {
          loadedQuery.current = query; setData(reply);
          setSelected(current => current && reply.rows.some(row => row.name === current) ? current : null);
        }
      } catch (e) { if (live) setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'Reading the history took too long. Try again, or keep less history in Settings.'); }
      finally { window.clearTimeout(deadline); if (live) setLoading(false); }
    })();
    return () => { live = false; controller.abort(); window.clearTimeout(deadline); };
  }, [query, refresh]);

  useEffect(() => {
    setDetails(previous => previous?.name === selected && loadedQuery.current === query ? previous : null); setDetailError('');
    if (!selected || !data || loading) { setDetailLoading(false); return; }
    let live = true; const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 65000); setDetailLoading(true);
    void (async () => {
      try {
        const reply = await readAuditReport<SkillReport>(`${query}&skill=${encodeURIComponent(selected)}&history=1&timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, controller.signal);
        if (live) { if (!reply.details?.row) setSelected(null); else setDetails(reply.details); }
      } catch { if (live) setDetailError('Could not read the uses of this skill. Close it and open it again to retry.'); }
      finally { window.clearTimeout(deadline); if (live) setDetailLoading(false); }
    })();
    return () => { live = false; controller.abort(); window.clearTimeout(deadline); };
  }, [selected, data, loading, query]);

  const rows = useMemo(() => sortSkills(data?.rows ?? [], sort, search), [data, sort, search]);
  const visible = showAll || search ? rows : rows.slice(0, FIRST_ROWS);
  const top = rows.reduce((most, row) => Math.max(most, row.uses), 0);
  const selection = data?.rows.find(row => row.name === selected);
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

  return <div className="ta-workspace" ref={workspaceRef} data-inspecting={!!selection || undefined} style={{ "--ta-details-w": `${detailsWidth}px` } as CSSProperties}>
    <div className="ta-body"><div className="ta-report-content">
      {filters}

      {loading && !data && <div className="ta-loading" role="status" aria-label="Reading skill history"><i /><i /><i /><i /><i /></div>}
      {error && <div className="ta-message" role="alert"><p>{data && 'Showing the last numbers. '}{error}</p></div>}

      {data && summary && (data.total === 0 && data.repeats === 0 ? <div className="ta-empty">
        <h3>No skills used in the last {periodLabels[period]}</h3>
        <p>ccdeck counts each skill {provider === 'all' ? 'Claude Code and Codex load' : provider === 'claude' ? 'Claude Code loads' : 'Codex loads'} on this device, starting {auditDay(data.countedSince)}. Sessions from before that are not imported. Use a skill and it shows up here.</p>
        {period !== '90' && !late && <button type="button" className="btn" onClick={() => setPeriod('90')}>Show the last 90 days</button>}
      </div> : <>
        <p className="ta-summary">
          {summary.lead} <strong>{summary.skills}</strong>{data.total > 0 && <> <strong>{summary.uses}</strong></>}.{' '}
          {summary.failed > 0 && <><strong className="ta-bad">{summary.failed.toLocaleString()} failed</strong>. </>}
          {summary.repeats > 0 && <>{count(summary.repeats, 'repeated run')}, such as <code>/loop</code> ticks, {summary.repeats === 1 ? 'is' : 'are'} left out.</>}
        </p>
        {late && <p className="ta-note sa-since">Counting started {auditDay(data.countedSince)}, so the days before it are empty rather than unused.</p>}
        {(!data.storageOk || data.dropped > 0 || data.corrupt > 0) && <p className="ta-warning" role="status">Some uses could not be saved or read, so these numbers may be a little low.{!data.storageOk && ' Check free disk space.'}</p>}

        <section className="ta-tools" aria-labelledby="sa-skills-title">
          <div className="ta-tools-head">
            <h3 id="sa-skills-title">Skills <span className="ta-count">{data.rows.length.toLocaleString()}</span></h3>
            <label className="ta-search"><SearchGlyph /><input type="search" aria-label="Find a skill" placeholder="Find a skill" value={search} onChange={event => setSearch(event.target.value)} /></label>
          </div>
          <div className="uh-range ta-sorts" role="group" aria-label="Sort by">{skillSorts.map(item => <button key={item.id} type="button" className="uh-range-btn" aria-pressed={sort === item.id} onClick={() => setSort(item.id)}>{item.label}</button>)}</div>
          <div className="ta-list-head sa-list-head" aria-hidden="true" data-sort={sort} data-failures={failures || undefined}><span>Name</span><span data-col="uses">Uses</span><span data-col="recent">Last used</span>{failures && <span data-col="failed">Failed</span>}</div>
          <ul className="ta-list sa-list" ref={listRef} data-sort={sort} data-failures={failures || undefined}>{visible.map(row => {
            const { namespace, short } = skillParts(row.name);
            return <li key={row.name}><button type="button" className="ta-row" data-skill={row.name} data-selected={selected === row.name || undefined} aria-expanded={selected === row.name} aria-controls={selected === row.name ? 'tool-operation-inspector' : undefined} aria-label={rowLabel(row)} onClick={select(row.name)}>
              <span className="ta-row-name"><span className="ta-op">{namespace && <span className="sa-namespace">{namespace}</span>}{short}</span><span className="ta-desc">{skillAgents(row)} · {count(row.sessions, 'session')}{row.repeats > 0 ? ` · ${count(row.repeats, 'repeat')}` : ''}</span><span className="ta-bar" aria-hidden="true" style={{ "--ta-share": top && sort === 'uses' ? Math.max(0.015, row.uses / top) : 0 } as CSSProperties} /></span>
              <span className="ta-cell" data-col="uses">{row.uses.toLocaleString()}<span className="ta-unit"> {row.uses === 1 ? 'use' : 'uses'}</span></span>
              <span className="ta-cell" data-col="recent"><span className="ta-unit">last </span>{callTime(row.lastAt)}</span>
              {failures && <span className="ta-cell" data-col="failed" data-bad={row.failed > 0 || undefined}>{row.failed ? <>{row.failed.toLocaleString()}<span className="ta-unit"> failed</span></> : <span className="ta-zero">0<span className="ta-unit"> failed</span></span>}</span>}
            </button></li>;
          })}</ul>
          {!rows.length && <p className="ta-note ta-no-match">No skill matches “{search.trim()}”.</p>}
          {!search && !showAll && rows.length > FIRST_ROWS && <button type="button" className="btn ta-more" onClick={() => setShowAll(true)}>Show all {rows.length.toLocaleString()}</button>}
        </section>

        <details className="ta-explain">
          <summary>How this is counted</summary>
          <ul>
            <li>A use is a skill loaded into an agent: Claude calling its Skill tool, a slash command you type, or a skill you pick in Codex with <code>$</code> or <code>/skills</code>. Custom commands count as skills.</li>
            <li>When Codex picks a skill itself, it only reads the skill’s <code>SKILL.md</code> or runs one of its scripts. That counts once per turn, only for a skill Codex listed for the session, and shows as detected.</li>
            <li>Typed commands are counted from a Claude Code that reports them to its hooks (<code>UserPromptExpansion</code>); with an older one only the skills Claude calls itself are counted.</li>
            <li>The same command run again in one session with the same arguments, such as a <code>/loop</code> tick, is a repeat and stays out of the ranking.</li>
            <li>Built-in commands such as <code>/clear</code> or <code>/model</code>, MCP prompts and a skill’s name typed inside a message are not uses. Skills that are installed but never ran do not appear.</li>
            <li>Failures are shown only when Claude reports that loading a skill failed; Codex reports none.</li>
            <li>Recorded on this device since {auditDay(data.countedSince)} and kept with the tool history for {data.retentionDays} days. The skill’s name, the session and the project folder’s name are saved; arguments and paths never are. Change this in Settings.</li>
          </ul>
        </details>
      </>)}
    </div></div>
    {selection && sideBySide && <ToolAuditSplitter width={detailsWidth} workspace={workspaceRef} onCommit={resizeDetails} />}
    {selection && <ToolAuditDrawer keyboard={keyboardSelection} itemKey={selection.name} onClose={closeInspector}>
      <SkillInspector row={details?.name === selected && details.row ? details.row : selection} details={details?.name === selected ? details : null} loading={detailLoading} error={detailError} onClose={closeInspector} sessionLabel={sessionLabel} onOpenSession={onOpenSession} />
    </ToolAuditDrawer>}
  </div>;
}
