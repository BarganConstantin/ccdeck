// Pasting a Codex share: the second tab of Add a Codex account, where Claude's
// "Paste a share" is. It was a dialog of its own behind a header icon, which
// gave the Codex header a control Claude's does not have; the `+` now offers
// both ways in, as it does on Claude's side.
//
// The pasted text is a live login. It lives only in this mount's memory, and
// nothing is sent until Import is pressed.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useT } from '../i18n';
import { transferFailure } from './CodexShareDialog';

interface Answer { ok: boolean; reason?: string; results?: { id: string; status: string }[] }
interface Props {
  /** The roster revision the import is checked against, so a list that changed
   *  under the paste is refused rather than written over. */
  revision: number;
  /** The import landed: the roster is read again. */
  onImported: () => void;
  /** Done after the import: the dialog closes. */
  onDone: () => void;
  /** The field, for the dialog to focus when the tab is picked by a press. */
  fieldRef?: RefObject<HTMLTextAreaElement>;
}

export default function CodexImportPane({ revision, onImported, onDone, fieldRef }: Props) {
  const t = useT();
  const [blob, setBlob] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const ownField = useRef<HTMLTextAreaElement>(null);
  const field = fieldRef ?? ownField;
  const done = useRef<HTMLButtonElement | null>(null);
  const imported = answer?.ok === true;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // The field that held focus has gone, so focus lands on what ends the dialog.
  useEffect(() => { if (imported) done.current?.focus(); }, [imported]);

  async function submit() {
    if (pending.current || !blob.trim()) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/codex-accounts-import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blob: blob.trim(), expectedRevision: revision }),
      });
      const out = await response.json().catch(() => null) as Answer | null;
      if (!alive.current) return;
      if (!response.ok || !out?.ok) setError(transferFailure(out?.reason, t));
      else { setAnswer(out); setBlob(''); onImported(); }
    } catch { if (alive.current) setError(t('codex.share.failed')); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }

  if (imported) {
    return (
      <div className="aa-step">
        <p className="aa-note" role="status">{t('codex.share.imported', {
          added: answer.results?.filter(result => result.status === 'imported').length ?? 0,
          skipped: answer.results?.filter(result => result.status === 'already_imported').length ?? 0,
        })}</p>
        <p className="aa-note">{t('codex.share.isolated')}</p>
        <div className="aa-actions"><button type="button" className="btn primary" ref={done} onClick={onDone}>{t('codex.add.done')}</button></div>
      </div>
    );
  }
  return (
    <div className="aa-step">
      <h4>{t('accounts.add.pasteTitle')}</h4>
      <label className="aa-note" htmlFor="codex-import-code">{t('codex.share.pasteHint')}</label>
      <textarea id="codex-import-code" ref={field} className="ap-share-blob" rows={4} value={blob}
        maxLength={512000} spellCheck={false} autoComplete="off" autoCapitalize="off"
        style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', whiteSpace: 'pre-wrap', overflow: 'auto', userSelect: 'text', color: 'var(--text)', fontSize: 'calc(12px + var(--ui-text-increase, 0px))' }}
        onChange={event => { if (!pending.current) { setBlob(event.target.value); setError(''); } }} />
      {error && <p className="aa-err" role="alert">{error}</p>}
      <div className="aa-actions">
        <button type="button" className="btn primary" aria-busy={busy || undefined} disabled={!blob.trim()}
          onClick={() => void submit()}>{t(busy ? 'codex.share.working' : 'codex.share.import')}</button>
      </div>
      <p className="aa-note">{t('codex.share.isolated')}</p>
      <p className="aa-note">{t('codex.share.renewal')}</p>
    </div>
  );
}
