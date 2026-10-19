// Joining shared settings, from this deck (design 4.6, "Joining shared"): what
// this deck shows against what the account's shared profile holds, and the
// choice between them. Drawn inside Settings › Account rather than over it —
// one dialog at a time (settings.ts doorOut) — and only ever from this deck:
// the console has no remote mode switch (the owner's decision).
import { useEffect, useRef, useState } from "react";
import { UI_LABELS } from "../account-ui-fields";
import { accountActions } from "../use-account";
import { selfPressAccepted, selfPressProps } from "../panel-press";

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
      <div className="account-preview" role="group" aria-label="Share settings">
        <p className="settings-row-note">{PREVIEW_COPY.failed}</p>
        <div className="account-actions"><button type="button" className="btn" onClick={onDone}>Close</button></div>
      </div>
    );
  }
  if (!preview) return <p className="settings-row-note account-preview">{PREVIEW_COPY.loading}</p>;

  const shared = preview.shared;
  return (
    <div className="account-preview" role="group" aria-label="Share settings">
      {note && <p className="settings-row-said" role="status">{note}</p>}
      {!shared ? (
        <>
          <p className="settings-row-note">{PREVIEW_COPY.none}</p>
          <div className="account-actions">
            <button type="button" className="btn" onClick={onDone} {...selfPressProps(busy)}>Cancel</button>
            <button type="button" className="btn primary" {...selfPressProps(busy)}
              onClick={() => choose({ mode: "shared", join: "publish", previewRevision: 0 })}>Publish this deck's settings</button>
          </div>
        </>
      ) : (
        <>
          {preview.differences.length === 0 ? (
            <p className="settings-row-note">{PREVIEW_COPY.same}</p>
          ) : (
            <table className="account-diff">
              <caption className="settings-row-note">
                {`Shared settings r${shared.revision}${shared.updatedBy?.name ? `, last changed on ${shared.updatedBy.name}` : ""}`}
              </caption>
              <thead><tr><th scope="col">Setting</th><th scope="col">This deck</th><th scope="col">Shared</th></tr></thead>
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
            <button type="button" className="btn" onClick={onDone} {...selfPressProps(busy)}>Cancel</button>
            <button type="button" className="btn" {...selfPressProps(busy)}
              onClick={() => choose({ mode: "shared", join: "publish", previewRevision: shared.revision })}>Use this deck's settings for all</button>
            <button type="button" className="btn primary" {...selfPressProps(busy)}
              onClick={() => choose({ mode: "shared", join: "use-shared" })}>Use shared settings</button>
          </div>
        </>
      )}
    </div>
  );
}
