import { useState, type CSSProperties, type MouseEvent } from 'react';
import { auditDuration, type TimeSplit } from '../tool-audit';
import { auditDay, count } from '../tool-audit-report';
import { laneParts, laneShares, slowDays, stopsLine, type Lane, type LaneShare } from '../time-split';

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
const Caret = () => <svg className="tt-caret" width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 5 4 4 4-4" /></svg>;

/** Where each lane sits along the bar, in percent, for the line that ties a level to it. */
function extents(parts: LaneShare[]) {
  const total = parts.reduce((sum, part) => sum + part.ms, 0) || 1;
  let from = 0;
  return Object.fromEntries(parts.map(part => { const x = from; from += part.ms / total * 100; return [part.id, { x, w: part.ms / total * 100 }]; })) as Record<Lane, { x: number; w: number }>;
}

/** Where the Claude Code turns' time went, as one bar: Claude, this machine, you.
 *  Pressing a lane opens what it is made of beneath it, drawn out of its place on
 *  the bar: the commands that held this machine, Claude's replies day by day, the
 *  approvals that waited on you. A command opens in the list below, as it does from
 *  "Worth a look". */
export default function ToolTimeSplit({ split, since, turnsSince, selected, onPick }: {
  split: TimeSplit; since: number; turnsSince?: number; selected: string | null;
  onPick: (operation: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [open, setOpen] = useState<Lane | null>(null);
  // What the level shows, kept through its close so it folds away instead of vanishing.
  const [shown, setShown] = useState<Lane | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const parts = laneShares(split);
  const place = extents(parts);
  const toggle = (lane: Lane) => { setOpen(current => current === lane ? null : lane); setShown(lane); setHot(null); };
  const lane = parts.find(part => part.id === shown) ?? null;
  const partial = turnsSince !== undefined && turnsSince > since;
  const scope = `${count(split.turns, 'Claude Code turn')}${partial ? ` since ${auditDay(turnsSince!)}` : ''}`;

  if (!split.turns) return <section className="tt" aria-labelledby="tt-title">
    <div className="tt-head"><h3 id="tt-title">Where the time went</h3></div>
    <p className="ta-note tt-empty">Shows how long Claude, this machine and you each took, once a Claude Code turn ends{partial ? ` — measured from ${auditDay(turnsSince!)}` : ''}.</p>
  </section>;

  return <section className="tt" aria-labelledby="tt-title" data-open={open ?? undefined}>
    <div className="tt-head"><h3 id="tt-title">Where the time went</h3><span className="tt-scope">{scope}</span></div>
    <div className="tt-bar" aria-hidden="true">
      {parts.map(part => <span key={part.id} className="tt-seg" data-lane={part.id} data-open={open === part.id || undefined} style={{ flexGrow: part.ms }} onClick={() => toggle(part.id)} />)}
    </div>
    <div className="tt-keys" role="group" aria-label="Where the time went">
      {parts.map(part => <button key={part.id} type="button" className="tt-key" data-lane={part.id} aria-expanded={open === part.id} aria-controls="tt-level" onClick={() => toggle(part.id)}
        aria-label={`${part.label}: ${part.share}, ${auditDuration(part.ms)}`}>
        <i aria-hidden="true" /><span className="tt-key-name">{part.label}</span><strong>{part.share}</strong><span className="tt-key-time">{auditDuration(part.ms)}</span><Caret />
      </button>)}
    </div>
    <div className="tt-fold" data-open={open ? '' : undefined}>
      {/* Folded, the level is still there to fold away, and out of reach: React 18 has no `inert` prop. */}
      <div className="tt-level" id="tt-level" ref={element => { if (element) element.inert = !open; }} aria-label={lane ? `${lane.label}, in detail` : undefined} role="region">
        {lane && <div key={lane.id} className="tt-level-body" data-lane={lane.id} style={{ "--tt-x": place[lane.id].x, "--tt-w": place[lane.id].w / 100 } as CSSProperties}>
          <svg className="tt-link" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">
            <polygon points={`${place[lane.id].x},0 ${place[lane.id].x + place[lane.id].w},0 100,14 0,14`} />
          </svg>
          <p className="ta-note tt-hint">{lane.hint}</p>
          {lane.id === 'claude' ? <ClaudeLevel split={split} /> : <PartsLevel split={split} lane={lane.id} selected={selected} hot={hot} setHot={setHot} onPick={onPick} />}
        </div>}
      </div>
    </div>
  </section>;
}

function PartsLevel({ split, lane, selected, hot, setHot, onPick }: {
  split: TimeSplit; lane: 'machine' | 'you'; selected: string | null; hot: string | null; setHot: (key: string | null) => void;
  onPick: (operation: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [all, setAll] = useState(false);
  const rows = laneParts(split, lane, all ? Infinity : 6);
  const most = Math.max(1, ...rows.map(row => row.ms));
  const asks = lane === 'you' && rows.some(row => row.inTable && !['AskUserQuestion', 'ExitPlanMode'].includes(row.operation));
  const key = (row: { operation: string; label: string }) => row.operation || row.label;
  return <>
    <div className="tt-sub" aria-hidden="true" onPointerLeave={() => setHot(null)}>
      {rows.map(row => <span key={key(row)} data-hot={hot === key(row) || undefined} data-rest={!row.operation || undefined} style={{ flexGrow: row.ms }} onPointerEnter={() => setHot(key(row))} />)}
    </div>
    <ul className="tt-parts" onPointerLeave={() => setHot(null)}>
      {rows.map(row => {
        const body = <>
          <span className="tt-part-name"><span className={row.inTable ? 'ta-op' : undefined}>{row.label}{row.more && <Caret />}</span>{row.detail && <span className="ta-desc">{row.detail}</span>}
            <span className="tt-part-bar" aria-hidden="true" style={{ "--tt-share": Math.max(0.015, row.ms / most) } as CSSProperties} /></span>
          <span className="ta-cell">{auditDuration(row.ms)}<small>{row.share}</small></span>
        </>;
        return <li key={key(row)} data-hot={hot === key(row) || undefined} onPointerEnter={() => setHot(key(row))}>
          {row.inTable ? <button type="button" className="tt-part" data-selected={selected === row.operation || undefined} aria-expanded={selected === row.operation}
            aria-label={`${row.label}: ${auditDuration(row.ms)}, ${row.share} of ${lane === 'machine' ? 'this machine’s' : 'your'} time`} onClick={event => onPick(row.operation, event)}>{body}</button>
            : row.more ? <button type="button" className="tt-part" data-rest aria-expanded={false} aria-label={`Show ${row.label}: ${auditDuration(row.ms)}, ${row.share}`}
              onClick={event => { const list = event.currentTarget.closest('ul'); setAll(true); requestAnimationFrame(() => list?.querySelectorAll<HTMLElement>('.tt-part')[rows.length - 1]?.focus()); }}>{body}</button>
            : <div className="tt-part" data-static>{body}</div>}
        </li>;
      })}
    </ul>
    {asks && <p className="ta-note tt-tip">Allow a command you trust in Settings › Claude Code, and Claude stops asking for it.</p>}
  </>;
}

function ClaudeLevel({ split }: { split: TimeSplit }) {
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
      <div><dt>Usually answers in</dt><dd>{auditDuration(replies.medianMs)}</dd></div>
      <div><dt>Slowest 1 in 10</dt><dd>{replies.p90Ms === null ? '—' : `over ${auditDuration(replies.p90Ms)}`}</dd></div>
      <div><dt>Longest</dt><dd>{auditDuration(replies.maxMs)}</dd></div>
      <div><dt>Replies</dt><dd>{replies.count.toLocaleString()}</dd></div>
    </dl>
    {days.length >= 2 && <div className="tt-days">
      <div className="tt-days-bars" role="img" style={{ "--ta-days": days.length, "--tt-usual": (replies.medianMs ?? 0) / most } as CSSProperties} onPointerLeave={() => setShown(null)}
        aria-label={`Claude's usual reply per day, from ${dateLabel(days[0].date)} to ${dateLabel(days.at(-1)!.date)}. ${slow.length ? `Slower than usual on ${slow.map(item => dateLabel(item.date)).join(', ')}.` : 'No day was clearly slower than usual.'}`}>
        {days.map(item => <span key={item.date} data-slow={slowSet.has(item.date) || undefined} data-shown={item.date === shown || undefined} onPointerEnter={() => setShown(item.date)}>
          <i style={{ "--ta-height": (item.medianMs ?? 0) / most } as CSSProperties} /></span>)}
        <b className="tt-usual" aria-hidden="true" />
      </div>
      <div className="ta-history-axis" aria-hidden="true"><span>{dateLabel(days[0].date)}</span><span>{dateLabel(days.at(-1)!.date)}</span></div>
      <p className="ta-note tt-days-note" aria-live="polite">{day ? `${dateLabel(day.date)} · ${day.count ? `${count(day.count, 'reply')} · usually ${auditDuration(day.medianMs)}` : 'no replies'}`
        : slow.length ? `Slower than usual on ${slow.map(item => `${dateLabel(item.date)} (${auditDuration(item.medianMs)})`).join(', ')} — the line is your usual ${auditDuration(replies.medianMs)}.`
        : `No day was clearly slower than your usual ${auditDuration(replies.medianMs)}.`}</p>
    </div>}
    {stops && <p className="ta-note tt-stops">{stops}</p>}
  </>;
}
