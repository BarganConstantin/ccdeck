import { useState, type CSSProperties, type MouseEvent } from 'react';
import { currentLanguage, useT } from '../i18n';
import { auditDuration, type TimeSplit } from '../tool-audit';
import { auditDay, countOf } from '../tool-audit-report';
import { donutArcs, glanceTime, laneFact, laneParts, laneShares, slowDays, stopsLine, type Lane } from '../time-split';

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(currentLanguage(), { timeZone: 'UTC', month: 'short', day: 'numeric' });
const Caret = () => <svg className="tt-caret" width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 5 4 4 4-4" /></svg>;

/** Where the Claude Code turns' time went, beside Worth a look: a ring of three
 *  lanes — Claude, this machine, you — and a legend that says each one's share and
 *  what it mostly was, so the answer is there on opening. Pressing a lane opens
 *  what it is made of across the report beneath: the commands that held this
 *  machine, Claude's replies day by day, the approvals that waited on you. A command
 *  opens in the list below, as it does from "Worth a look". */
export default function ToolTimeSplit({ split, since, turnsSince, selected, onPick }: {
  split: TimeSplit; since: number; turnsSince?: number; selected: string | null;
  onPick: (operation: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState<Lane | null>(null);
  // What the level shows, kept through its close so it folds away instead of vanishing.
  const [shown, setShown] = useState<Lane | null>(null);
  const [hot, setHot] = useState<Lane | null>(null);
  const parts = laneShares(split);
  const toggle = (lane: Lane) => { setOpen(current => current === lane ? null : lane); setShown(lane); };
  const lane = parts.find(part => part.id === shown) ?? null;
  const focus = parts.find(part => part.id === (hot ?? open)) ?? null;
  const partial = turnsSince !== undefined && turnsSince > since;
  const scope = partial ? t('insights.split.scopeSince', { turns: countOf(split.turns, 'turn'), date: auditDay(turnsSince!) }) : countOf(split.turns, 'turn');
  const head = <div className="tt-head"><h3 id="tt-title">{t('insights.split.title')}</h3>{split.turns > 0 && <span className="tt-scope">{scope}</span>}</div>;

  if (!split.turns) return <section className="tt" aria-labelledby="tt-title">{head}
    <div className="tt-card"><p className="ta-note tt-empty">{partial ? t('insights.split.emptySince', { date: auditDay(turnsSince!) }) : t('insights.split.empty')}</p></div>
  </section>;

  return <>
    <section className="tt" aria-labelledby="tt-title" data-focus={focus?.id}>
      {head}
      <div className="tt-card" onPointerLeave={() => setHot(null)}>
        <div className="tt-donut">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            {donutArcs(parts).map(arc => <circle key={arc.id} className="tt-arc" data-lane={arc.id} data-on={focus?.id === arc.id || undefined} cx="60" cy="60" r="52" pathLength={100}
              style={{ strokeDasharray: `${arc.length} ${100 - arc.length}`, strokeDashoffset: -arc.from }} onPointerEnter={() => setHot(arc.id)} onClick={() => toggle(arc.id)} />)}
          </svg>
          <div className="tt-center" aria-hidden="true">
            {focus ? <><strong>{focus.share}</strong><span>{focus.label}</span></> : <><strong>{glanceTime(split.totalMs)}</strong><span>{t('insights.split.total')}</span></>}
          </div>
        </div>
        <ul className="tt-lanes">
          {parts.map(part => <li key={part.id}>
            <button type="button" className="tt-lane" data-lane={part.id} aria-expanded={open === part.id} aria-controls="tt-level"
              aria-label={t('insights.split.laneAria', { label: part.label, share: part.share, time: auditDuration(part.ms), fact: laneFact(split, part.id) })}
              onClick={() => toggle(part.id)} onPointerEnter={() => setHot(part.id)} onFocus={() => setHot(part.id)} onBlur={() => setHot(null)}>
              <i aria-hidden="true" /><span className="tt-lane-name">{part.label}</span><strong>{part.share}</strong>
              <span className="tt-lane-time">{glanceTime(part.ms)}</span><Caret />
              <span className="tt-lane-fact">{laneFact(split, part.id)}</span>
            </button>
          </li>)}
        </ul>
      </div>
    </section>
    <div className="tt-fold" data-open={open ? '' : undefined}>
      {/* Folded, the level is still there to fold away, and out of reach: React 18 has no `inert` prop. */}
      <div className="tt-level" id="tt-level" ref={element => { if (element) element.inert = !open; }} aria-label={lane ? t('insights.split.inDetail', { label: lane.label }) : undefined} role="region">
        {lane && <div key={lane.id} className="tt-level-body" data-lane={lane.id}>
          <div className="tt-level-head"><i aria-hidden="true" /><strong>{lane.label}</strong><span>{t('insights.split.levelHead', { time: auditDuration(lane.ms), share: lane.share })}</span></div>
          <p className="ta-note tt-hint">{lane.hint}</p>
          {lane.id === 'claude' ? <ClaudeLevel split={split} /> : <PartsLevel split={split} lane={lane.id} selected={selected} onPick={onPick} />}
        </div>}
      </div>
    </div>
  </>;
}

function PartsLevel({ split, lane, selected, onPick }: {
  split: TimeSplit; lane: 'machine' | 'you'; selected: string | null;
  onPick: (operation: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const rows = laneParts(split, lane, all ? Infinity : 6);
  const most = Math.max(1, ...rows.map(row => row.ms));
  const asks = lane === 'you' && rows.some(row => row.inTable && !['AskUserQuestion', 'ExitPlanMode'].includes(row.operation));
  return <>
    <ul className="tt-parts">
      {rows.map(row => {
        const body = <>
          <span className="tt-part-name"><span className={row.inTable ? 'ta-op' : undefined}>{row.label}{row.more && <Caret />}</span>{row.detail && <span className="ta-desc">{row.detail}</span>}
            <span className="tt-part-bar" aria-hidden="true" style={{ "--tt-share": Math.max(0.015, row.ms / most) } as CSSProperties} /></span>
          <span className="ta-cell">{auditDuration(row.ms)}<small>{row.share}</small></span>
        </>;
        return <li key={row.operation || row.label}>
          {row.inTable ? <button type="button" className="tt-part" data-selected={selected === row.operation || undefined} aria-expanded={selected === row.operation}
            aria-label={t(lane === 'machine' ? 'insights.split.partAria.machine' : 'insights.split.partAria.you', { label: row.label, time: auditDuration(row.ms), share: row.share })} onClick={event => onPick(row.operation, event)}>{body}</button>
            : row.more ? <button type="button" className="tt-part" data-rest aria-expanded={false} aria-label={t('insights.split.showMore', { label: row.label, time: auditDuration(row.ms), share: row.share })}
              onClick={event => { const list = event.currentTarget.closest('ul'); setAll(true); requestAnimationFrame(() => list?.querySelectorAll<HTMLElement>('.tt-part')[rows.length - 1]?.focus()); }}>{body}</button>
            : <div className="tt-part" data-static>{body}</div>}
        </li>;
      })}
    </ul>
    {asks && <p className="ta-note tt-tip">{t('insights.split.tip')}</p>}
  </>;
}

function ClaudeLevel({ split }: { split: TimeSplit }) {
  const t = useT();
  const { replies } = split;
  const slow = slowDays(split);
  const stops = stopsLine(split.stops);
  const days = replies.days;
  const most = Math.max(1, ...days.map(day => day.medianMs ?? 0));
  const [shown, setShown] = useState<string | null>(null);
  const day = days.find(item => item.date === shown);
  const slowSet = new Set(slow.map(item => item.date));
  return <>
    <dl className="ta-facts tt-facts">
      <div><dt>{t('insights.split.f.answers')}</dt><dd>{auditDuration(replies.medianMs)}</dd></div>
      <div><dt>{t('insights.split.f.slowest')}</dt><dd>{replies.p90Ms === null ? '—' : t('insights.split.f.over', { time: auditDuration(replies.p90Ms) })}</dd></div>
      <div><dt>{t('insights.split.f.longest')}</dt><dd>{auditDuration(replies.maxMs)}</dd></div>
      <div><dt>{t('insights.split.f.replies')}</dt><dd>{replies.count.toLocaleString(currentLanguage())}</dd></div>
    </dl>
    {days.length >= 2 && <div className="tt-days">
      <div className="tt-days-bars" role="img" style={{ "--ta-days": days.length, "--tt-usual": (replies.medianMs ?? 0) / most } as CSSProperties} onPointerLeave={() => setShown(null)}
        aria-label={t('insights.split.daysAria', { from: dateLabel(days[0].date), to: dateLabel(days.at(-1)!.date), note: slow.length ? t('insights.split.slowOn', { days: slow.map(item => dateLabel(item.date)).join(t('insights.split.listSep')) }) : t('insights.split.noSlow') })}>
        {days.map(item => <span key={item.date} data-slow={slowSet.has(item.date) || undefined} data-shown={item.date === shown || undefined} onPointerEnter={() => setShown(item.date)}>
          <i style={{ "--ta-height": (item.medianMs ?? 0) / most } as CSSProperties} /></span>)}
        <b className="tt-usual" aria-hidden="true" />
      </div>
      <div className="ta-history-axis" aria-hidden="true"><span>{dateLabel(days[0].date)}</span><span>{dateLabel(days.at(-1)!.date)}</span></div>
      <p className="ta-note tt-days-note" aria-live="polite">{day ? `${dateLabel(day.date)} · ${day.count ? `${countOf(day.count, 'reply')} · ${t('insights.audit.hist.usually', { time: auditDuration(day.medianMs) })}` : t('insights.split.noReplies')}`
        : slow.length ? t('insights.split.slowDays', { days: slow.map(item => `${dateLabel(item.date)} (${auditDuration(item.medianMs)})`).join(t('insights.split.listSep')), usual: auditDuration(replies.medianMs) })
        : t('insights.split.noSlowUsual', { usual: auditDuration(replies.medianMs) })}</p>
    </div>}
    {stops && <p className="ta-note tt-stops">{stops}</p>}
  </>;
}
