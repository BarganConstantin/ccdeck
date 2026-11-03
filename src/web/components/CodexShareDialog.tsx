import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../copy-text';
import { useT, type TFunction } from '../i18n';
import type { CodexProfile } from '../codex-accounts';
import { useModalDismiss, useScrimDismiss } from './use-modal-dismiss';

interface Answer { ok: boolean; blob?: string; reason?: string; results?: { id: string; status: string }[] }
interface Props {
  mode: 'export' | 'import';
  profiles: CodexProfile[];
  revision: number;
  onImported: () => void;
  onClose: () => void;
}
function failure(reason: string | undefined, t: TFunction) {
  if (reason === 'file_auth_required') return t('codex.share.fileOnly');
  if (reason === 'unsupported_auth') return t('codex.share.chatgptOnly');
  if (reason === 'invalid_share') return t('codex.share.invalid');
  if (reason === 'selection_conflict') return t('codex.share.conflict');
  if (reason === 'windows_permissions_failed') return t('codex.share.permissions');
  if (reason === 'share_too_large') return t('codex.share.tooLarge');
  return t('codex.share.failed');
}

/** Credentials live only in this mount's memory. Nothing is exported until
 * Generate is pressed, and nothing is imported until Import is pressed. */
export default function CodexShareDialog({ mode, profiles, revision, onImported, onClose }: Props) {
  const t = useT();
  const [picked, setPicked] = useState<string[]>([]);
  const [blob, setBlob] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const primary = useRef<HTMLButtonElement | null>(null);
  const dialog = useModalDismiss(onClose, { focusRef: mode === 'import' ? field : undefined });
  const scrim = useScrimDismiss(onClose);
  const exported = mode === 'export' && !!answer?.blob;
  const imported = mode === 'import' && answer?.ok === true;
  const title = t(mode === 'export' ? 'codex.share.title' : 'codex.share.importTitle');
  const ids = picked.filter(id => profiles.some(profile => profile.id === id));

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (exported || imported) primary.current?.focus(); }, [exported, imported]);

  async function submit() {
    if (pending.current || (mode === 'export' ? !ids.length || ids.length > 20 : !blob.trim())) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const response = await fetch(mode === 'export' ? '/api/codex-accounts-share' : '/api/codex-accounts-import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'export' ? { ids } : { blob: blob.trim(), expectedRevision: revision }),
      });
      const out = await response.json().catch(() => null) as Answer | null;
      if (!alive.current) return;
      if (!response.ok || !out?.ok || (mode === 'export' && typeof out.blob !== 'string')) setError(failure(out?.reason, t));
      else {
        setAnswer(out);
        if (mode === 'export') setBlob(out.blob!);
        else { setBlob(''); onImported(); }
      }
    } catch { if (alive.current) setError(t('codex.share.failed')); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }

  return createPortal(
    <div className="modal-backdrop" {...scrim} role="presentation">
      <div ref={dialog} className="modal sa-modal" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title"><h3>{title}</h3></div>
          <div className="modal-actions"><button type="button" className="glyph-btn" onClick={onClose} aria-label={t('codex.add.close')}>×</button></div>
        </header>
        <section className="modal-body sa-body">
          <p className="sa-count">{t('codex.share.warning')}</p>
          <p className="sa-note">{t('codex.share.renewal')}</p>
          {imported ? <>
            <p className="sa-count" role="status">{t('codex.share.imported', {
              added: answer.results?.filter(result => result.status === 'imported').length ?? 0,
              skipped: answer.results?.filter(result => result.status === 'already_imported').length ?? 0,
            })}</p>
            <p className="sa-note">{t('codex.share.isolated')}</p>
            <div className="sa-actions"><button type="button" className="btn primary" ref={primary} onClick={onClose}>{t('codex.add.done')}</button></div>
          </> : <>
            {mode === 'export' && !exported ? <>
              <p className="sa-note">{t('codex.share.choose')}</p>
              <ul className="sa-list sa-pick">
                {profiles.map(profile => <li key={profile.id}>
                  <label className="sa-row"><input type="checkbox" checked={ids.includes(profile.id)} disabled={busy}
                    onChange={() => setPicked(current => current.includes(profile.id) ? current.filter(id => id !== profile.id) : [...current, profile.id])} />
                    <span className="sa-who">{profile.label}</span>
                  </label>
                </li>)}
              </ul>
              {profiles.length === 0 && <p className="sa-note">{t('codex.share.empty')}</p>}
            </> : <>
              <label className="sa-note" htmlFor="codex-transfer-code">{t(exported ? 'codex.share.copyHint' : 'codex.share.pasteHint')}</label>
              <textarea id="codex-transfer-code" ref={field} className="ap-share-blob" rows={5} value={blob} readOnly={exported}
                maxLength={512000} spellCheck={false} autoComplete="off" autoCapitalize="off"
                style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', whiteSpace: 'pre-wrap', overflow: 'auto', userSelect: 'text', color: 'var(--text)', fontSize: 'calc(12px + var(--ui-text-increase, 0px))' }}
                onChange={event => { if (!pending.current) { setBlob(event.target.value); setError(''); } }} />
              <p className="sa-note">{t(exported ? 'codex.share.noExpiry' : 'codex.share.isolated')}</p>
            </>}
            {error && <p className="aa-err" role="alert">{error}</p>}
            <div className="sa-actions">
              <button type="button" className="btn" onClick={onClose}>{t('codex.menu.cancel')}</button>
              {exported ? <button type="button" className="btn primary" ref={primary} onClick={async () => {
                const ok = await copyText(blob);
                if (alive.current) { setCopied(ok); if (!ok) setError(t('codex.share.copyFailed')); }
              }}>{t(copied ? 'codex.add.copied' : 'codex.share.copy')}</button>
                : <button type="button" className="btn primary" ref={primary} aria-busy={busy || undefined}
                  disabled={mode === 'export' ? !ids.length || ids.length > 20 : !blob.trim()} onClick={() => void submit()}>
                  {t(busy ? 'codex.share.working' : mode === 'export' ? 'codex.share.generate' : 'codex.share.import')}
                </button>}
            </div>
          </>}
        </section>
      </div>
    </div>, document.body,
  );
}
