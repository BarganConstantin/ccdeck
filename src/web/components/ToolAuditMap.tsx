import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AuditCloseGlyph } from './ToolAuditInspector';
import { auditDuration, type AuditRow } from '../tool-audit';
import { auditMapClusters, auditMapData, type AuditMapMetric, type AuditMapScale } from '../tool-audit-map';

export default function ToolAuditMap({ rows, search, selected, hovered, metric, setMetric, scale, setScale, mixedClocks, onHover, onSelect }: {
  rows: AuditRow[]; search: string; selected: string | null; hovered: string | null;
  metric: AuditMapMetric; setMetric: (metric: AuditMapMetric) => void;
  scale: AuditMapScale; setScale: (scale: AuditMapScale) => void; mixedClocks: boolean;
  onHover: (operation: string | null) => void;
  onSelect: (operation: string, keyboard: boolean, origin: HTMLElement | SVGElement) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  const [shortViewport, setShortViewport] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-height: 650px)');
    const update = () => setShortViewport(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const element = frame.current; if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(230, element.clientWidth)));
    observer.observe(element); setWidth(Math.max(230, element.clientWidth));
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setActive(null); setPinned(false); onHover(null); }, [rows, metric, scale]); // parent callback is state setter
  const height = shortViewport ? width < 450 ? 170 : 210 : width < 450 ? 240 : 310;
  const margin = { left: 58, right: 22, top: 26, bottom: 44 };
  const plotWidth = width - margin.left - margin.right, plotHeight = height - margin.top - margin.bottom;
  const data = useMemo(() => auditMapData(rows, metric, scale), [rows, metric, scale]);
  const clusters = useMemo(() => auditMapClusters(data.points, plotWidth, plotHeight), [data, plotWidth, plotHeight]);
  const query = search.trim().toLowerCase();
  const matches = (row: AuditRow) => row.operation.toLowerCase().includes(query);
  const current = clusters.find(cluster => cluster.key === active);
  const emphasized = selected ?? hovered;
  const labels = Array.from(new Set([
    data.points.reduce<typeof data.points[number] | undefined>((top, point) => !top || point.row.calls > top.row.calls ? point : top, undefined)?.row.operation,
    data.points.reduce<typeof data.points[number] | undefined>((top, point) => !top || point.interval > top.interval ? point : top, undefined)?.row.operation,
  ].filter(Boolean)));
  let previousTick = Infinity;
  const yTicks = data.y.ticks.slice().reverse().filter(value => {
    const y = margin.top + (1 - data.y.position(value)) * plotHeight;
    if (Math.abs(previousTick - y) < 20 && value !== 0) return false;
    previousTick = y; return true;
  });
  const activate = (key: string, operation: string | null) => { setActive(key); onHover(operation); };
  const keyboardStep = (event: KeyboardEvent<SVGGElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nodes = Array.from(frame.current?.querySelectorAll<SVGGElement>('.ta-map-node') ?? []);
    const index = nodes.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1
      : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + nodes.length) % nodes.length;
    nodes[next]?.focus();
  };
  return <section className="ta-map" aria-label="Operation performance map">
    <header className="ta-map-header"><h3>Frequency × interval</h3><div>
      <label><span className="ta-sr-only">Map interval</span><select aria-label="Map interval" value={metric} onChange={event => setMetric(event.target.value as AuditMapMetric)}><option value="medianMs">Median interval</option><option value="p95Ms">P95 interval</option></select></label>
      <label><span className="ta-sr-only">Y scale</span><select aria-label="Y scale" value={scale} onChange={event => setScale(event.target.value as AuditMapScale)}><option value="auto">Auto scale</option><option value="linear">Linear</option><option value="log">Log · zero-safe</option></select></label>
    </div></header>
    <p className="ta-map-scope">{mixedClocks ? shortViewport ? 'Mixed clocks · filter Provider' : 'Mixed provider clocks · filter Provider for consistent timing' : shortViewport ? 'Shared containing-call intervals' : 'Containing-call intervals · shared, not isolated executions'}</p>
    <div className="ta-map-frame" ref={frame} onMouseLeave={() => { if (!pinned && !frame.current?.contains(document.activeElement)) { setActive(null); onHover(null); } }}>
      <svg className="ta-map-svg" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Containing-call frequency versus ${metric === 'medianMs' ? 'median' : 'P95'} observed interval. Y scale: ${data.y.kind === 'log' ? 'log of one plus milliseconds, zero included' : 'linear'}. Arrow keys navigate points; Enter inspects. Exact values are also in Operations.`}>
        <text className="ta-map-axis-title" x={margin.left} y={14}>Observed call interval · {data.y.kind === 'log' ? 'log(1 + ms)' : 'linear'}</text>
        {yTicks.map(value => { const y = margin.top + (1 - data.y.position(value)) * plotHeight; return <g key={value} aria-hidden="true"><line className="ta-map-grid" x1={margin.left} x2={width - margin.right} y1={y} y2={y} /><text className="ta-map-tick" x={margin.left - 10} y={y + 4} textAnchor="end">{auditDuration(value)}</text></g>; })}
        {data.x.ticks.map(value => { const x = margin.left + data.x.position(value) * plotWidth; return <g key={value} aria-hidden="true"><line className="ta-map-grid" x1={x} x2={x} y1={margin.top} y2={height - margin.bottom} /><text className="ta-map-tick" x={x} y={height - margin.bottom + 20} textAnchor="middle">{value.toLocaleString()}</text></g>; })}
        <text className="ta-map-axis-title" x={margin.left + plotWidth / 2} y={height - 3} textAnchor="middle">Containing calls · nonadditive</text>
        {clusters.map(cluster => {
          const single = cluster.points.length === 1 ? cluster.points[0] : null;
          const selectedPoint = cluster.points.find(point => point.row.operation === emphasized);
          const match = cluster.points.some(point => matches(point.row));
          const failed = cluster.points.some(point => point.row.failed > 0);
          const x = margin.left + cluster.x * plotWidth, y = margin.top + cluster.y * plotHeight;
          const inspect = (keyboard: boolean, origin: SVGGElement) => {
            activate(cluster.key, single?.row.operation ?? null);
            if (single) onSelect(single.row.operation, keyboard, origin); else {
              setPinned(true);
              if (keyboard) requestAnimationFrame(() => frame.current?.querySelector<HTMLButtonElement>('.ta-map-member')?.focus());
            }
          };
          return <g key={cluster.key} className="ta-map-node" transform={`translate(${x} ${y})`} role="button" tabIndex={0}
            data-map-operation={single?.row.operation} data-map-cluster={single ? undefined : cluster.key} data-map-key={cluster.key} data-map-members={JSON.stringify(cluster.points.map(point => point.row.operation))} data-active={!!selectedPoint || active === cluster.key || undefined} data-dim={query && !match || undefined}
            aria-label={single ? `${single.row.operation}: ${single.row.calls} containing calls, ${auditDuration(single.interval)} ${metric === 'medianMs' ? 'median' : 'P95'} interval, ${single.row.failed} reported failures` : `${cluster.points.length} nearby operations; open exact member values`}
            onMouseEnter={() => activate(cluster.key, single?.row.operation ?? null)} onFocus={() => activate(cluster.key, single?.row.operation ?? null)}
            onClick={event => inspect(event.detail === 0, event.currentTarget)} onKeyDown={event => { keyboardStep(event); if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(true, event.currentTarget); } }}>
            <circle className="ta-map-hit" r="12" />
            {(selectedPoint || active === cluster.key) && <circle className="ta-map-ring" r={single ? 12 : 16} />}
            {single ? failed ? <path className="ta-map-failure" d="M0-7 7 0 0 7-7 0Z" /> : <circle className="ta-map-point" r="5" /> : <><circle className={failed ? 'ta-map-cluster ta-map-cluster-failure' : 'ta-map-cluster'} r="10" /><text className="ta-map-count" y="4" textAnchor="middle">{cluster.points.length}</text>{failed && <path className="ta-map-cluster-flag" d="M8-13 12-9 8-5 4-9Z" />}</>}
            {single && labels.includes(single.row.operation) && !query && <text className="ta-map-label" x={x > width / 2 ? -10 : 10} y={y < 55 ? 18 : -11} textAnchor={x > width / 2 ? 'end' : 'start'}>{single.row.operation.length > 24 ? `${single.row.operation.slice(0, 23)}…` : single.row.operation}</text>}
          </g>;
        })}
        {!data.points.length && <text className="ta-map-empty" x={width / 2} y={height / 2} textAnchor="middle">{rows.length ? 'No eligible measured intervals' : 'No recorded operations'}</text>}
      </svg>
      {current && <div className="ta-map-tooltip" role="region" aria-label="Map point details" style={{ left: Math.max(0, Math.min(width - Math.min(270, width), margin.left + current.x * plotWidth + 12)), top: Math.max(0, Math.min(height - 240, margin.top + current.y * plotHeight + 12)), width: Math.min(270, width) }}>
        <header><strong>{current.points.length > 1 ? `${current.points.length} nearby operations` : current.points[0].row.operation}</strong><button type="button" className="glyph-btn" aria-label="Dismiss point details" onClick={() => { setActive(null); setPinned(false); onHover(null); }}><AuditCloseGlyph /></button></header>
        {current.points.length > 1 && <p>Grouped by screen proximity, not combined statistics.</p>}
        <div className="ta-map-members">{current.points.slice().sort((a, b) => Number(matches(b.row)) - Number(matches(a.row))).map(point => <button type="button" key={point.row.operation} className="ta-map-member" onMouseEnter={() => onHover(point.row.operation)} onClick={event => { const origin = Array.from(frame.current?.querySelectorAll<SVGGElement>('.ta-map-node') ?? []).find(node => node.dataset.mapKey === current.key); onSelect(point.row.operation, event.detail === 0, origin ?? event.currentTarget); setActive(null); setPinned(false); }}>
          {current.points.length > 1 && <strong>{point.row.operation}</strong>}<span>{point.row.calls.toLocaleString()} calls · {auditDuration(point.interval)} {metric === 'medianMs' ? 'median' : 'P95'}</span><small>{point.row.measured} timed · {point.row.failed} reported failures{point.row.shared > 0 && ' · shared interval'}</small>
        </button>)}</div>
      </div>}
    </div>
    <footer className="ta-map-legend"><span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4" className="ta-map-point" /></svg> Operation</span><span><svg width="14" height="14" aria-hidden="true"><path className="ta-map-failure" d="M7 1 13 7 7 13 1 7Z" /></svg> Reported failure</span><span>Numbered points group neighbours</span>{query && <span>{rows.filter(matches).length} search matches · full map retained</span>}</footer>
    {data.excluded.length > 0 && <details className="ta-map-excluded"><summary>{data.excluded.length} not plotted · {metric === 'p95Ms' ? 'missing P95 or fewer than 20 timings' : 'no measured median'}</summary><p>Unknown intervals are not zero. All operations remain in Operations.</p><ul>{data.excluded.map(row => <li key={row.operation}><button type="button" onClick={event => onSelect(row.operation, event.detail === 0, event.currentTarget)}>{row.operation}</button><span>{row.measured} timed / {row.calls} calls</span></li>)}</ul></details>}
  </section>;
}
