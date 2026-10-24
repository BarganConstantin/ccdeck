import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import { HistorySkeleton } from './ToolAuditHistory';
import { AuditCloseGlyph, Pending, PendingLines } from './ToolAuditInspector';
import type { SkillDay, SkillReport, SkillRow, SkillUse } from '../tool-audit';
import { callClock, callDay, callTime, count } from '../tool-audit-report';
import { dayOriginParts, dayOrigins, skillAgents, skillOrigins, skillParts, useOrigin } from '../skill-activity';

/** Session links reach the canvas: `sessionLabel` names a session still on it, or null. */
export interface SessionLinks { sessionLabel?: (sessionId: string) => string | null; onOpenSession?: (sessionId: string) => void }

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });

/** What one skill did: how often, who started it, where, and its latest uses. While a
 *  new period is read (`pending`) the panel keeps its place and its labels, and the
 *  numbers wait as quiet bars rather than showing the last period's. */
export default function SkillInspector({ row, details, loading, pending = false, charted = true, error, onClose, sessionLabel, onOpenSession }: SessionLinks & {
  row: SkillRow; details: SkillReport['details']; loading: boolean; pending?: boolean; charted?: boolean; error: string; onClose: () => void;
}) {
  const { namespace, short } = skillParts(row.name);
  const now = Date.now();
  const { claude, codex } = row.providers;
  const picked = row.agent + row.detected;
  const pickers = row.agent && row.detected ? 'an agent' : row.detected ? 'Codex' : 'Claude';
  // "Last used yesterday 08:23 PM": the day reads on from the words before it.
  const last = callTime(row.lastAt, now).replace(/^(Today|Yesterday)/, word => word.toLowerCase());
  // The days before counting began are left off rather than drawn as empty.
  const days = details?.history?.days.filter(day => day.status !== 'outside-history') ?? [];
  const reading = (loading || pending) && !details;
  const n = (value: ReactNode) => pending ? <Pending /> : value;
  const asides = [row.subagent ? `${row.subagent.toLocaleString()} in a subagent` : '', row.detected && row.agent ? `${row.detected.toLocaleString()} picked by Codex` : ''].filter(Boolean);
  return <section className="ta-inspector" aria-label={`${row.name} details`} id="tool-operation-inspector">
    <header className="ta-inspector-head">
      <div>
        <h3 tabIndex={-1} id="tool-operation-heading">{namespace && <span className="sa-namespace">{namespace}</span>}{short}</h3>
        <p>{pending ? <><Pending width="9em" /><br /><Pending width="12em" /></>
          : <>{claude && codex ? `${claude.toLocaleString()} by Claude, ${codex.toLocaleString()} by Codex` : `All by ${skillAgents(row)}`}<br />Last used {last}</>}</p>
      </div>
      <button type="button" className="glyph-btn" aria-label="Close details" onClick={onClose}><AuditCloseGlyph /></button>
    </header>

    <dl className="ta-facts" aria-busy={pending || undefined}>
      <div><dt>Uses</dt><dd>{n(row.uses.toLocaleString())}</dd></div>
      {!pending && row.failed > 0
        ? <div><dt>Failed</dt><dd data-bad>{row.failed.toLocaleString()}</dd></div>
        : <div><dt>Sessions</dt><dd>{n(row.sessions.toLocaleString())}</dd></div>}
      <div data-lane="agent"><dt>Picked by {pickers}</dt><dd>{n(picked.toLocaleString())}</dd></div>
      <div data-lane="typed"><dt>Typed by you</dt><dd>{n(row.typed.toLocaleString())}</dd></div>
    </dl>
    {!pending && (asides.length > 0 || row.repeats > 0) && <p className="ta-note">
      {asides.join(' · ')}
      {row.repeats > 0 && <>{asides.length > 0 && ' · '}{count(row.repeats, 'repeated run')} not counted, such as <code>/loop</code> ticks</>}
    </p>}

    {error && <p className="ta-message" role="alert">{error}</p>}
    {days.length >= 3 ? <SkillDays key={row.name} days={days} /> : reading && charted && <HistorySkeleton noun="use" />}

    {details && (details.projects.length > 0 || details.projectless > 0) && <SkillProjects details={details} />}

    <section className="ta-calls-section" aria-labelledby="sa-uses-title">
      <div className="ta-calls-head"><h4 id="sa-uses-title">Latest uses</h4></div>
      {reading && <PendingLines label="Reading uses" />}
      {details && <>
        <LatestUses uses={details.recent} now={now} sessionLabel={sessionLabel} onOpenSession={onOpenSession} />
        {!details.recent.length && <p className="ta-note">No uses in this period.</p>}
        {details.total > details.recent.length && details.recent.length > 0 && <p className="ta-note">The latest {details.recent.length} of {details.total.toLocaleString()}.</p>}
      </>}
    </section>
  </section>;
}

/** Uses per day, each day's bar split by who started them in the ring's hues, under
 *  a line at the busiest day. The words below always name the day they describe:
 *  the one under the pointer, else the latest with a use. */
function SkillDays({ days }: { days: SkillDay[] }) {
  const [shown, setShown] = useState<string | null>(null);
  const busiest = days.reduce((best, item) => item.uses > best.uses ? item : best, days[0]);
  const max = Math.max(1, busiest.uses);
  const day = days.find(item => item.date === shown) ?? [...days].reverse().find(item => item.uses > 0) ?? days.at(-1)!;
  return <section className="ta-history" aria-labelledby="sa-days-title">
    <h4 id="sa-days-title">Uses per day</h4>
    <div className="ta-history-bars sa-days-bars" role="img" onPointerLeave={() => setShown(null)} style={{ "--ta-days": days.length } as CSSProperties}
      aria-label={`Uses per day from ${dateLabel(days[0].date)} to ${dateLabel(days.at(-1)!.date)}. The busiest day was ${dateLabel(busiest.date)} with ${count(busiest.uses, 'use')}${busiest.uses ? `: ${dayOrigins(busiest)}` : ''}.`}>
      <b className="sa-days-max" aria-hidden="true">{count(max, 'use')}</b>
      {days.map(item => <span key={item.date} data-shown={item.date === day.date || undefined} onPointerEnter={() => setShown(item.date)}>
        {skillOrigins.filter(id => item[id] > 0).map(id => <i key={id} data-lane={id} style={{ "--ta-height": item[id] / max } as CSSProperties} />)}
      </span>)}
    </div>
    <div className="ta-history-axis" aria-hidden="true"><span>{dateLabel(days[0].date)}</span><span>{dateLabel(days.at(-1)!.date)}</span></div>
    {/* The words below are the chart's legend: each part wears its lane's hue. */}
    <p className="ta-note ta-history-day" aria-live="polite">{dateLabel(day.date)} · {day.uses ? <>{count(day.uses, 'use')}: {dayOriginParts(day).map((part, at) => <Fragment key={part.id}>
      {at > 0 && ', '}<span className="sa-day-part" data-lane={part.id}><i aria-hidden="true" />{part.text}</span>
    </Fragment>)}</> : 'no uses'}</p>
  </section>;
}

/** Where the skill ran, each project's share drawn under it, and what the five named
 *  leave out, so the list adds up to the uses. */
function SkillProjects({ details }: { details: NonNullable<SkillReport['details']> }) {
  const rows = [
    ...details.projects.map(project => ({ key: project.name, name: project.name, uses: project.uses, rest: false })),
    ...(details.moreProjects.projects > 0 ? [{ key: '(more)', name: count(details.moreProjects.projects, 'more project'), uses: details.moreProjects.uses, rest: true }] : []),
    ...(details.projectless > 0 ? [{ key: '(none)', name: 'No folder recorded', uses: details.projectless, rest: true }] : []),
  ];
  const total = Math.max(1, details.total);
  return <section className="sa-projects" aria-labelledby="sa-projects-title">
    <h4 id="sa-projects-title">Projects</h4>
    <ul>{rows.map(item => <li key={item.key} data-rest={item.rest || undefined}>
      <span>{item.name}</span><span>{count(item.uses, 'use')}</span>
      <b aria-hidden="true" style={{ "--sa-share": Math.max(0.02, item.uses / total) } as CSSProperties} />
    </li>)}</ul>
  </section>;
}

/** The latest uses, a day's under one date: each its time, who started it, and where. */
function LatestUses({ uses, now, sessionLabel, onOpenSession }: SessionLinks & { uses: SkillUse[]; now: number }) {
  const groups: { day: string; uses: SkillUse[] }[] = [];
  for (const use of uses) {
    const day = callDay(use.at, now), group = groups.at(-1);
    if (group?.day === day) group.uses.push(use); else groups.push({ day, uses: [use] });
  }
  return <>{groups.map(group => <div key={group.day} className="sa-use-day">
    <p className="sa-use-date">{group.day}</p>
    <ul className="ta-calls sa-uses">{group.uses.map(use => {
      const label = sessionLabel?.(use.session) ?? null;
      return <li key={use.id} data-lane={use.origin} data-state={use.state === 'failed' ? 'failed' : undefined}>
        <span className="ta-call-when">{callClock(use.at)}</span>
        <span className="sa-use-what">
          <span className="sa-use-who"><i aria-hidden="true" />{useOrigin(use)}{use.subagent ? ' · subagent' : ''}{use.state === 'failed' ? ' · failed' : ''}</span>
          {use.project && <span className="sa-use-project">{use.project}</span>}
          {label && onOpenSession && <button type="button" className="sa-session" onClick={() => onOpenSession(use.session)} title="Show this session on the canvas">{label}</button>}
        </span>
      </li>;
    })}</ul>
  </div>)}</>;
}
