// Joining shared settings, from this deck (design 4.6, "Joining shared"): what
// this deck shows against what the account's shared profile holds, and the
// choice between them. Drawn inside Settings › Account rather than over it —
// one dialog at a time (settings.ts doorOut) — and only ever from this deck:
// the console has no remote mode switch (the owner's decision).
import { useEffect, useRef, useState } from "react";
import { uiLabelOf } from "../account-ui-fields";
import { accountActions } from "../use-account";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { useT, type MessageKey, type TFunction } from "../i18n";

type Preview = Awaited<ReturnType<typeof accountActions.preview>>;

/** A setting's value as a person reads it, in the language `tr` speaks. */
export function shownValue(tr: TFunction, key: string, value: unknown): string {
  if (value === null || value === undefined) return tr("settings.account.notSet");
  if (typeof value === "boolean") return tr(value ? "settings.claude.effect.on" : "settings.claude.effect.off");
  if (key === "hideFinishedAfter") return value === 0 ? tr("settings.board.never") : tr("settings.board.minutes", { n: String(value) });
  return String(value);
}

/** The sentences this panel says, as keys read with `t` where they are drawn. */
export const PREVIEW_MSGS: Record<"loading" | "failed" | "none" | "same" | "stale", MessageKey> = {
  loading: "settings.account.preview.loading",
  failed: "settings.account.preview.failed",
  none: "settings.account.preview.none",
  same: "settings.account.preview.same",
  stale: "settings.account.preview.stale",
};

export default function AccountSyncPreview({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<MessageKey | "">("");

  const load = () => {
    setFailed(false);
    accountActions.preview()
      .then(p => { if (p?.error) setFailed(true); else setPreview(p); })
      .catch(() => setFailed(true));
  };
  useEffect(load, []);

  const choose = async (body: Parameters<typeof accountActions.setMode>[0]) => {
    // Busy, never disabled (#620): the second press is refused here.
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const out = await accountActions.setMode(body);
      if (out?.error === "revision_conflict") { setNote(PREVIEW_MSGS.stale); load(); return; }
      if (out?.error) { setNote(PREVIEW_MSGS.failed); return; }
      onDone();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <div className="account-preview" role="group" aria-label={t("settings.account.shareLabel")}>
        <p className="settings-row-note">{t(PREVIEW_MSGS.failed)}</p>
        <div className="account-actions"><button type="button" className="btn" onClick={onDone}>{t("common.close")}</button></div>
      </div>
    );
  }
  if (!preview) return <p className="settings-row-note account-preview">{t(PREVIEW_MSGS.loading)}</p>;

  const shared = preview.shared;
  return (
    <div className="account-preview" role="group" aria-label={t("settings.account.shareLabel")}>
      {note && <p className="settings-row-said" role="status">{t(note)}</p>}
      {!shared ? (
        <>
          <p className="settings-row-note">{t(PREVIEW_MSGS.none)}</p>
          <div className="account-actions">
            <button type="button" className="btn" onClick={onDone} {...selfPressProps(busy)}>{t("common.cancel")}</button>
            <button type="button" className="btn primary" {...selfPressProps(busy)}
              onClick={() => choose({ mode: "shared", join: "publish", previewRevision: 0 })}>{t("settings.account.publishDeck")}</button>
          </div>
        </>
      ) : (
        <>
          {preview.differences.length === 0 ? (
            <p className="settings-row-note">{t(PREVIEW_MSGS.same)}</p>
          ) : (
            <table className="account-diff">
              <caption className="settings-row-note">
                {shared.updatedBy?.name
                  ? t("settings.account.sharedRevisionBy", { revision: shared.revision, name: shared.updatedBy.name })
                  : t("settings.account.sharedRevision", { revision: shared.revision })}
              </caption>
              <thead><tr><th scope="col">{t("settings.account.colSetting")}</th><th scope="col">{t("settings.account.colThisDeck")}</th><th scope="col">{t("settings.account.colShared")}</th></tr></thead>
              <tbody>
                {preview.differences.map(d => (
                  <tr key={d.key}>
                    <th scope="row">{uiLabelOf(t, d.key) ?? d.key}</th>
                    <td>{shownValue(t, d.key, d.local)}</td>
                    <td>{shownValue(t, d.key, d.shared)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="account-actions">
            <button type="button" className="btn" onClick={onDone} {...selfPressProps(busy)}>{t("common.cancel")}</button>
            <button type="button" className="btn" {...selfPressProps(busy)}
              onClick={() => choose({ mode: "shared", join: "publish", previewRevision: shared.revision })}>{t("settings.account.useDeckForAll")}</button>
            <button type="button" className="btn primary" {...selfPressProps(busy)}
              onClick={() => choose({ mode: "shared", join: "use-shared" })}>{t("settings.account.useShared")}</button>
          </div>
        </>
      )}
    </div>
  );
}
