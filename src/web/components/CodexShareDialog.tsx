// Sharing Codex accounts with another deck: the header's ↗ for several, a
// row's ⋯ › Share for one. The other end pastes the code under + › Paste a
// share (CodexImportPane), as Claude's does.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../copy-text';
import { useT, type TFunction } from '../i18n';
import type { CodexProfile } from '../codex-accounts';
import { useModalDismiss, useScrimDismiss } from './use-modal-dismiss';

interface Answer { ok: boolean; blob?: string; reason?: string }
interface Props {
  /** The accounts a share starts with ticked: the row whose ⋯ opened it. */
  initial?: readonly string[];
  /** Where focus goes back to when the control that opened this is gone — a
   *  row's ⋯, whose menu closed as it opened the dialog. */
  returnFocusTo?: () => HTMLElement | null;
  profiles: CodexProfile[];
  onClose: () => void;
}

/** What a share or an import that did not finish says, without the server's
 *  own words: a reason is a code, never something to show. */
export function transferFailure(reason: string | undefined, t: TFunction) {
  if (reason === 'windows_permissions_required') return t('codex.share.needsProtection');
  if (reason === 'windows_share_protection_failed') return t('codex.share.protectionFailed');
  if (reason === 'file_auth_required') return t('codex.share.fileOnly');
  if (reason === 'unsupported_auth') return t('codex.share.chatgptOnly');
  if (reason === 'invalid_share') return t('codex.share.invalid');
  if (reason === 'selection_conflict') return t('codex.share.conflict');
  if (reason === 'windows_permissions_failed') return t('codex.share.permissions');
  if (reason === 'share_too_large') return t('codex.share.tooLarge');
  return t('codex.share.failed');
}

/** Credentials live only in this mount's memory. Nothing is exported until
 * Generate is pressed. */
export default function CodexShareDialog({ initial, returnFocusTo, profiles, onClose }: Props) {
  const t = useT();
  const [picked, setPicked] = useState<string[]>(() => [...(initial ?? [])]);
  const [blob, setBlob] = useState('');
  const [error, setError] = useState('');
  const [needsProtection, setNeedsProtection] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const primary = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useModalDismiss(onClose, { restoreFocusFallback: returnFocusTo });
  const scrim = useScrimDismiss(onClose);
  const exported = !!blob;
  const ids = picked.filter(id => profiles.some(profile => profile.id === id));

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (exported) primary.current?.focus(); }, [exported]);

  async function submit(preparePermissions = false) {
    if (pending.current || !ids.length || ids.length > 20) return;
    pending.current = true; setBusy(true); setError(''); setNeedsProtection(false);
    try {
      const response = await fetch('/api/codex-accounts-share', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, ...(preparePermissions ? { preparePermissions: true } : {}) }),
      });
      const out = await response.json().catch(() => null) as Answer | null;
      if (!alive.current) return;
      if (!response.ok || !out?.ok || typeof out.blob !== 'string') {
        setError(transferFailure(out?.reason, t));
        setNeedsProtection(out?.reason === 'windows_permissions_required');
      }
      else setBlob(out.blob);
    } catch { if (alive.current) setError(t('codex.share.failed')); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }

  return createPortal(
    <div className="modal-backdrop" {...scrim} role="presentation">
      <div ref={dialogRef} className="modal sa-modal" role="dialog" aria-modal="true" aria-labelledby="codex-transfer-title" onClick={event => event.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title"><h3 id="codex-transfer-title">{t('codex.share.title')}</h3></div>
          <div className="modal-actions"><button type="button" className="glyph-btn" onClick={onClose} aria-label={t('codex.add.close')}>×</button></div>
        </header>
        <section className="modal-body sa-body">
          <p className="sa-count">{t('codex.share.warning')}</p>
          <p className="sa-note">{t('codex.share.renewal')}</p>
          {!exported ? <>
            <p className="sa-note">{t('codex.share.choose')}</p>
            <ul className="sa-list sa-pick">
              {profiles.map(profile => <li key={profile.id}>
                <label className="sa-row"><input type="checkbox" checked={ids.includes(profile.id)} aria-disabled={busy || undefined}
                  onChange={() => { if (pending.current) return; setError(''); setNeedsProtection(false); setPicked(current => current.includes(profile.id) ? current.filter(id => id !== profile.id) : [...current, profile.id]); }} />
                  <span className="sa-who">{profile.label}</span>
                </label>
              </li>)}
            </ul>
            {profiles.length === 0 && <p className="sa-note">{t('codex.share.empty')}</p>}
          </> : <>
            <label className="sa-note" htmlFor="codex-transfer-code">{t('codex.share.copyHint')}</label>
            <textarea id="codex-transfer-code" className="ap-share-blob" rows={5} value={blob} readOnly
              maxLength={512000} spellCheck={false} autoComplete="off" autoCapitalize="off"
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', whiteSpace: 'pre-wrap', overflow: 'auto', userSelect: 'text', color: 'var(--text)', fontSize: 'calc(12px + var(--ui-text-increase, 0px))' }} />
            <p className="sa-note">{t('codex.share.noExpiry')}</p>
          </>}
          {needsProtection && <p className="sa-note">{t('codex.share.protectionNotice')}</p>}
          {error && <p className="aa-err" role="alert">{error}</p>}
          <div className="sa-actions">
            <button type="button" className="btn" onClick={onClose}>{t('codex.menu.cancel')}</button>
            {exported ? <button type="button" className="btn primary" ref={primary} onClick={async () => {
              const ok = await copyText(blob);
              if (alive.current) { setCopied(ok); if (!ok) setError(t('codex.share.copyFailed')); }
            }}>{t(copied ? 'codex.add.copied' : 'codex.share.copy')}</button>
              : <button type="button" className="btn primary" ref={primary} aria-busy={busy || undefined}
                disabled={!ids.length || ids.length > 20} onClick={() => void submit(needsProtection)}>
                {t(busy ? 'codex.share.working' : needsProtection ? 'codex.share.protect' : 'codex.share.generate')}
              </button>}
          </div>
        </section>
      </div>
    </div>, document.body,
  );
}
