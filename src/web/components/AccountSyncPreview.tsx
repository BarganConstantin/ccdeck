// Joining shared settings, from this deck (design 4.6, "Joining shared"): what
// this deck shows against what the account's shared profile holds, and the
// choice between them. Drawn inside Settings › Account rather than over it —
// one dialog at a time (settings.ts doorOut) — and only ever from this deck:
// the console has no remote mode switch (the owner's decision).
import { useEffect, useRef, useState } from "react";
import { UI_LABELS } from "../account-ui-fields";
import { accountActions } from "../use-account";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { useT } from "../i18n";

type Preview = Awaited<ReturnType<typeof accountActions.preview>>;

/** A setting's value as a person reads it. */
export function shownValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (key === "hideFinishedAfter") return value === 0 ? "Never" : `${value} min`;
  return String(value);
}

export const PREVIEW_COPY = {
  loading: "Comparing this deck with your shared settings…",
  failed: "Could not read the shared settings. Try again in a moment.",
  none: "There are no shared settings in this account yet. Publish this deck's, and your other decks can join them.",
  same: "This deck already shows the shared settings.",
  stale: "The shared settings changed while you were looking. Here they are again.",
};

export default function AccountSyncPreview({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState("");

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
      if (out?.error === "revision_conflict") { setNote(PREVIEW_COPY.stale); load(); return; }
      if (out?.error) { setNote(PREVIEW_COPY.failed); return; }
      onDone();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <div className="account-preview" role="group" aria-label={t("settings.account.shareLabel")}>
        <p className="settings-row-note">{PREVIEW_COPY.failed}</p>
        <div className="account-actions"><button type="button" className="btn" onClick={onDone}>{t("common.close")}</button></div>
      </div>
    );
  }
  if (!preview) return <p className="settings-row-note account-preview">{PREVIEW_COPY.loading}</p>;

  const shared = preview.shared;
  return (
    <div className="account-preview" role="group" aria-label={t("settings.account.shareLabel")}>
      {note && <p className="settings-row-said" role="status">{note}</p>}
      {!shared ? (
        <>
          <p className="settings-row-note">{PREVIEW_COPY.none}</p>
          <div className="account-actions">
            <button type="button" className="btn" onClick={onDone} {...selfPressProps(busy)}>{t("common.cancel")}</button>
            <button type="button" className="btn primary" {...selfPressProps(busy)}
              onClick={() => choose({ mode: "shared", join: "publish", previewRevision: 0 })}>{t("settings.account.publishDeck")}</button>
          </div>
        </>
      ) : (
        <>
          {preview.differences.length === 0 ? (
            <p className="settings-row-note">{PREVIEW_COPY.same}</p>
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
                    <th scope="row">{UI_LABELS[d.key] ?? d.key}</th>
                    <td>{shownValue(d.key, d.local)}</td>
                    <td>{shownValue(d.key, d.shared)}</td>
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
