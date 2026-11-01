// Settings › Data: the tool history this deck records (tool-audit.mjs) — how
// long it is kept, how much room it takes, and the way to empty it.
//
// In the shared rows (SettingsParts.tsx, #2176) rather than the label-over-
// select and the free-floating buttons it had in General: the retention is a
// row with its select on the right, the size is a row with its reading on the
// right and Refresh beside it, and Clear is the last row, as a destructive
// action goes last in every settings window this one follows. Shortening the
// retention or clearing still asks first, in the row that asked.
import { useEffect, useRef, useState } from 'react';
import { auditBytes, auditDate, type AuditStorage } from '../tool-audit';
import { SettingRow, SettingsGroup } from './SettingsParts';
import { useT } from '../i18n';

export const TOOL_HISTORY_NOTE = 'Local statistics for Claude and Codex on this device. Commands are grouped by operation; raw arguments and outputs are not saved.';

export default function ToolAuditSettings() {
  const t = useT();
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
    } catch { if (live.current) setError(t('settings.tools.readFail')); }
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
      if (live.current) { setConfirm(null); setNotice(action === 'clear' ? t('settings.tools.cleared') : t('settings.tools.retentionChanged', { days: days ?? 0 })); }
    } catch { if (live.current) setError(t('settings.tools.updateFail')); }
    finally { window.clearTimeout(timer); busyRef.current = false; if (live.current) { setBusy(false); if (changed) void read(); } }
  };
  // Its own row, under the row that asked, so the question stands where the
  // press was and the list keeps one shape.
  const confirmation = confirm !== null && <div className="settings-row settings-row-wide ta-confirm" role="group" aria-label={t('settings.tools.confirm')}>
    <p>{confirm === 'clear' ? t('settings.tools.confirmClear') : t('settings.tools.confirmKeep', { days: confirm })}</p>
    <div><button type="button" className="btn danger" aria-busy={busy} onClick={() => { void change(confirm === 'clear' ? 'clear' : 'retention', typeof confirm === 'number' ? confirm : undefined); }}>{confirm === 'clear' ? t('settings.tools.deleteBtn') : t('settings.tools.applyBtn')}</button><button type="button" className="btn" aria-busy={busy} onClick={() => { if (!busyRef.current) setConfirm(null); }}>{t('settings.tools.cancel')}</button></div>
  </div>;
  return <SettingsGroup id="tool-history-settings-title" title={t('settings.tools.title')} note={t('settings.tools.note')} className="ta-settings">
    {storage ? <>
      <SettingRow settingId="tool-history-retention" name={t('settings.tools.keep')} nameId="ta-keep-label" note={t('settings.tools.keepNote')} control={<select className="sm-select" aria-labelledby="ta-keep-label" value={storage.retentionDays} aria-busy={busy} onChange={e => {
        if (busyRef.current) return;
        const days = Number(e.target.value) as 30 | 60 | 90;
        if (days < storage.retentionDays) setConfirm(days as 30 | 60); else void change('retention', days);
      }}>{[30, 60, 90].map(days => <option key={days} value={days}>{t('settings.tools.days', { count: days })}</option>)}</select>} />
      {typeof confirm === 'number' && confirmation}
      <SettingRow as="div" settingId="tool-history-size" name={t('settings.tools.space')} note={t('settings.tools.since', { date: auditDate(storage.startedAt) })} control={<>
        <span className="settings-read">{auditBytes(storage.bytes)}</span>
        <button type="button" className="btn" aria-busy={busy} onClick={() => { void read(); }}>{t('settings.tools.refresh')}</button>
      </>} />
      <SettingRow as="div" settingId="tool-history-clear" name={t('settings.tools.clear')} note={t('settings.tools.clearNote')} control={
        <button type="button" className="btn danger" aria-busy={busy} onClick={() => { if (!busyRef.current) setConfirm('clear'); }}>{t('settings.tools.clearBtn')}</button>
      } />
      {confirm === 'clear' && confirmation}
      {!storage.storageOk && <SettingRow as="div" name={t('settings.tools.unsaved')} note={t('settings.tools.unsavedNote')} />}
    </> : <SettingRow as="div" name={busy ? t('settings.tools.reading') : t('settings.tools.unavailable')} />}
    {error && <div className="settings-row" role="alert"><span className="settings-row-name">{error}</span><span className="settings-row-control"><button type="button" className="btn" aria-busy={busy} onClick={() => { void read(); }}>{t('settings.tools.retry')}</button></span></div>}
    {notice && <p className="settings-row settings-row-status" role="status">{notice}</p>}
  </SettingsGroup>;
}
