import { useEffect, useRef, useState } from 'react';
import { auditBytes, auditDate, type AuditStorage } from '../tool-audit';

export default function ToolAuditSettings() {
  const [storage, setStorage] = useState<AuditStorage | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'clear' | 30 | 60 | null>(null);
  const [notice, setNotice] = useState(''); const busyRef = useRef(false); const live = useRef(true);
  const read = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    const controller = new AbortController(); const timer = window.setTimeout(() => controller.abort(), 12000);
    try { const res = await fetch('/api/tool-audit/storage', { signal: controller.signal }); const reply = await res.json() as AuditStorage;
      if (!res.ok || !reply.ok) throw new Error(); if (live.current) setStorage(reply);
    } catch { if (live.current) setError('Could not read tool history storage. Try again.'); }
    finally { window.clearTimeout(timer); busyRef.current = false; if (live.current) setBusy(false); }
  };
  useEffect(() => { live.current = true; void read(); return () => { live.current = false; }; }, []);
  const change = async (action: 'clear' | 'retention', days?: number) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice(''); let changed = false;
    const controller = new AbortController(); const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch('/api/tool-audit/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'clear' ? { action, confirm: true } : { action, days }), signal: controller.signal });
      const reply = await res.json(); if (!res.ok || !reply.ok) throw new Error(); changed = true;
      if (live.current) { setConfirm(null); setNotice(action === 'clear' ? 'Tool history cleared. New calls will continue to be recorded.' : `Retention changed to ${days} days.`); }
    } catch { if (live.current) setError('Could not update tool history. Check storage permissions and try again.'); }
    finally { window.clearTimeout(timer); busyRef.current = false; if (live.current) { setBusy(false); if (changed) void read(); } }
  };
  return <section className="settings-group ta-settings" aria-labelledby="tool-history-settings-title">
    <div className="settings-caption"><h3 id="tool-history-settings-title">Tool history</h3></div>
    <p className="ta-note">Local statistics for Claude and Codex on this device. Commands are grouped by operation; raw arguments and outputs are not saved.</p>
    {storage ? <>
      <div className="ta-storage-row"><label>Keep history<select aria-label="Tool history retention" value={storage.retentionDays} disabled={busy} onChange={e => {
        const days = Number(e.target.value) as 30 | 60 | 90;
        if (days < storage.retentionDays) setConfirm(days as 30 | 60); else void change('retention', days);
      }}>{[30, 60, 90].map(days => <option key={days} value={days}>{days} days</option>)}</select></label><span className="ta-storage-size">{auditBytes(storage.bytes)} used<small>Collection since {auditDate(storage.startedAt)}</small></span></div>
      {!storage.storageOk && <p className="ta-note" role="status">Some calls could not be saved. Check free space and storage permissions.</p>}
      <div className="ta-storage-actions"><button type="button" aria-disabled={busy} onClick={() => { if (!busyRef.current) setConfirm('clear'); }}>Clear history…</button><button type="button" aria-disabled={busy} onClick={() => { void read(); }}>Refresh size</button></div>
      {confirm !== null && <div className="ta-confirm"><p>{confirm === 'clear' ? 'Delete all recorded tool statistics on this device? This cannot be undone.' : `Keep ${confirm} days? Older calls will be permanently deleted.`}</p><div><button type="button" aria-disabled={busy} onClick={() => { void change(confirm === 'clear' ? 'clear' : 'retention', typeof confirm === 'number' ? confirm : undefined); }}>{confirm === 'clear' ? 'Delete tool history' : 'Apply retention'}</button><button type="button" aria-disabled={busy} onClick={() => { if (!busyRef.current) setConfirm(null); }}>Cancel</button></div></div>}
    </> : <p className="ta-note" role="status">{busy ? 'Reading storage…' : 'Storage size unavailable.'}</p>}
    {error && <p className="ta-note" role="alert">{error} <button type="button" aria-disabled={busy} onClick={() => { void read(); }}>Retry</button></p>}
    {notice && <p className="ta-note" role="status">{notice}</p>}
  </section>;
}
