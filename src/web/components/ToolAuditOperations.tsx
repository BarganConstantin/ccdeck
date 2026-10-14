import { auditMetrics, auditMetricText, auditMetricValue, type AuditMetric, type AuditRow } from '../tool-audit';
import ToolAuditOperationButton from './ToolAuditOperationButton';
import { operationDescription, operationPurposeNote } from '../operation-glossary';
import type { SelectAuditOperation } from './ToolAuditComparison';
const columns: { key: AuditMetric; label: string }[] = [
  { key: 'calls', label: 'Calls' }, { key: 'totalMs', label: 'Associated intervals' },
  { key: 'medianMs', label: 'Median' }, { key: 'p95Ms', label: 'P95' }, { key: 'failed', label: 'Failures' },
];
export default function ToolAuditOperations({ rows, total, metric, ascending, limit, search, selected, onSort, onSelect, onMore, onClear }: {
  rows: AuditRow[]; total: number; metric: AuditMetric; ascending: boolean; limit: number; search: string;
  selected: string | null; onSort: (metric: AuditMetric) => void; onSelect: SelectAuditOperation;
  onMore: () => void; onClear: () => void;
}) {
  return <section className="ta-explorer" aria-labelledby="ta-all-operations" id="ta-all-operations-section">
    <header className="ta-explorer-head"><div><h3 id="ta-all-operations" tabIndex={-1}>All operations <span>{search ? `${rows.length} / ${total}` : total.toLocaleString()}</span></h3><p>Exact measurements. Select an operation to inspect recorded calls.</p></div>
      <div className="ta-table-sort"><label>Sort by<select aria-label="Sort operations" value={metric} onChange={event => onSort(event.target.value as AuditMetric)}>{columns.map(column => <option key={column.key} value={column.key}>{column.label}{metric === column.key ? ascending ? ' ↑' : ' ↓' : ''}</option>)}</select></label><button type="button" aria-label={ascending ? 'Sort descending' : 'Sort ascending'} onClick={() => onSort(metric)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={ascending ? 'M12 20V4m-5 5 5-5 5 5' : 'M12 4v16m-5-5 5 5 5-5'} /></svg></button></div>
    </header>
    {rows.length ? <>
      <table className="ta-operation-table" data-sort={metric}><caption className="ta-sr-only">Containing-call memberships and associated intervals; counts and intervals across operations overlap.</caption>
        <thead><tr><th scope="col">Operation</th>{columns.map(column => <th key={column.key} scope="col" data-column={column.key} aria-sort={metric === column.key ? ascending ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => onSort(column.key)} title={auditMetrics[column.key].note}>{column.label}<span aria-hidden="true">{metric === column.key ? ascending ? ' ↑' : ' ↓' : ''}</span></button></th>)}</tr></thead>
        <tbody>{rows.slice(0, limit).map(row => <tr key={row.operation} data-selected={selected === row.operation || undefined}><th scope="row"><ToolAuditOperationButton operation={row.operation} aria-label={`${row.operation}${operationDescription(row.operation) ? ". " + operationDescription(row.operation)!.purpose + " " + operationPurposeNote : ""}`} type="button" className="ta-table-operation" data-operation={row.operation} aria-haspopup="dialog" aria-expanded={selected === row.operation} aria-controls={selected === row.operation ? 'tool-operation-inspector' : undefined} onClick={event => onSelect(row.operation, event.detail === 0, event.currentTarget)}><span className="ta-operation-name">{row.operation}</span><span className="ta-table-provider">{row.providers.claude > 0 && 'Claude'}{row.providers.claude > 0 && row.providers.codex > 0 && ' + '}{row.providers.codex > 0 && 'Codex'}</span></ToolAuditOperationButton></th>{columns.map(column => <td key={column.key} data-column={column.key} data-label={column.label} className={column.key === 'failed' && row.failed ? 'ta-failures' : undefined} title={auditMetrics[column.key].note}>{auditMetricText(auditMetricValue(row, column.key), column.key)}{column.key === 'p95Ms' && row.measured < 20 && <small>{row.measured} / 20 timed</small>}</td>)}</tr>)}</tbody>
      </table>
      <footer className="ta-explorer-footer"><span>{Math.min(limit, rows.length).toLocaleString()} of {rows.length.toLocaleString()} operations</span>{rows.length > limit && <button type="button" className="ta-more" onClick={onMore}>Show 50 more</button>}</footer>
    </> : <div className="ta-message" role="status"><p>{total ? `No operations match “${search}”.` : 'No calls recorded in this period. Collection starts with new tool events; older sessions are not imported.'}</p>{search && <button type="button" className="ta-more" onClick={onClear}>Clear search</button>}</div>}
  </section>;
}
