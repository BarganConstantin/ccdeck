import ToolAuditHistory from './ToolAuditHistory';
import { AuditCloseGlyph } from './ToolAuditInspector';
import type { SkillReport, SkillRow } from '../tool-audit';
import { callTime, count } from '../tool-audit-report';
import { originParts, originWord, skillAgents, skillParts, useAgent } from '../skill-activity';

/** Session links reach the canvas: `sessionLabel` names a session still on it, or null. */
export interface SessionLinks { sessionLabel?: (sessionId: string) => string | null; onOpenSession?: (sessionId: string) => void }

/** What one skill did: how often, how, where, and its latest uses. */
export default function SkillInspector({ row, details, loading, error, onClose, sessionLabel, onOpenSession }: SessionLinks & {
  row: SkillRow; details: SkillReport['details']; loading: boolean; error: string; onClose: () => void;
}) {
  const { namespace, short } = skillParts(row.name);
  const now = Date.now();
  const origins = originParts(row);
  const { claude, codex } = row.providers;
  return <section className="ta-inspector" aria-label={`${row.name} details`} id="tool-operation-inspector">
    <header className="ta-inspector-head">
      <div>
        <h3 tabIndex={-1} id="tool-operation-heading">{namespace && <span className="sa-namespace">{namespace}</span>}{short}</h3>
        <p>{claude && codex ? `${claude.toLocaleString()} by Claude, ${codex.toLocaleString()} by Codex` : `All by ${skillAgents(row)}`}</p>
      </div>
      <button type="button" className="glyph-btn" aria-label="Close details" onClick={onClose}><AuditCloseGlyph /></button>
    </header>

    <dl className="ta-facts">
      <div><dt>Uses</dt><dd>{row.uses.toLocaleString()}</dd></div>
      <div><dt>Sessions</dt><dd>{row.sessions.toLocaleString()}</dd></div>
      <div><dt>Last used</dt><dd className="sa-fact-time">{callTime(row.lastAt, now)}</dd></div>
      {row.failed > 0
        ? <div><dt>Failed</dt><dd data-bad>{row.failed.toLocaleString()}</dd></div>
        : <div><dt>Projects</dt><dd>{row.projects.toLocaleString()}</dd></div>}
    </dl>
    {(origins.length > 0 || row.repeats > 0) && <p className="ta-note">
      {origins.join(' · ')}
      {row.repeats > 0 && <>{origins.length > 0 && ' · '}{count(row.repeats, 'repeated run')} not counted, such as <code>/loop</code> ticks</>}
    </p>}

    {error && <p className="ta-message" role="alert">{error}</p>}
    {details?.history && <ToolAuditHistory key={row.name} noun="use" history={{ days: details.history.days.map(day => ({ date: day.date, calls: day.uses, status: day.status === 'outside-history' ? 'outside-history' : day.uses ? 'measured' : 'no-calls' })) }} />}

    {details && details.projects.length > 0 && <section className="sa-projects" aria-labelledby="sa-projects-title">
      <h4 id="sa-projects-title">Projects</h4>
      <ul>{details.projects.map(project => <li key={project.name}><span>{project.name}</span><span>{count(project.uses, 'use')}</span></li>)}</ul>
    </section>}

    <section className="ta-calls-section" aria-labelledby="sa-uses-title">
      <div className="ta-calls-head"><h4 id="sa-uses-title">Latest uses</h4></div>
      {loading && !details && <p className="ta-note" role="status">Reading uses…</p>}
      {details && <>
        <ul className="ta-calls sa-uses">{details.recent.map(use => {
          const label = sessionLabel?.(use.session) ?? null;
          return <li key={use.id} data-state={use.state === 'failed' ? 'failed' : undefined}>
            <span className="ta-call-when">{callTime(use.at, now)}</span>
            <span className="ta-call-who">{useAgent(use)} · {originWord[use.origin]}{use.subagent ? ' · subagent' : ''}{use.state === 'failed' ? ' · failed' : ''}</span>
            <span className="sa-use-where">
              {use.project && <span className="sa-use-project">{use.project}</span>}
              {label && onOpenSession
                ? <button type="button" className="sa-session" onClick={() => onOpenSession(use.session)} title="Show this session on the canvas">{label}</button>
                : <span className="sa-session-gone">not on the canvas</span>}
            </span>
          </li>;
        })}</ul>
        {!details.recent.length && <p className="ta-note">No uses in this period.</p>}
        {details.total > details.recent.length && details.recent.length > 0 && <p className="ta-note">The latest {details.recent.length} of {details.total.toLocaleString()}.</p>}
      </>}
    </section>
  </section>;
}
