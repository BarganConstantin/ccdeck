// The sound menu's custom sounds (#1207): a file imported, a clip recorded, a
// line of text the browser speaks, and the list of what has been added.
//
// Lifted out of SoundMenu.tsx with everything only it uses — the voice form
// (SpokenVoiceForm.tsx), the recorder (use-clip-recorder.ts), the two-press
// Delete and the error they share — so the menu reads as the switches and the
// two tones, and this as the one section that adds and removes sounds. Which
// sound each tone plays stays with the menu's own select; this is handed the
// library and the callbacks that change it.
import { useEffect, useRef, useState } from "react";
import { armedPress, focusDropped } from "../panel-press";
import { CONFIRM_GAP_MS } from "./LanSyncSection";
import { useClipRecorder } from "../use-clip-recorder";
import SpokenVoiceForm from "./SpokenVoiceForm";
import {
  MAX_CUSTOM_ASSETS,
  deleteFocusTarget,
  libraryFullReason,
  type CustomAssetSummary,
} from "../notification-audio";

export interface CustomSoundsProps {
  customAssets: CustomAssetSummary[];
  onImportCustom: (file: File) => Promise<void>;
  onCreateVoice: (input: { name: string; text: string; voiceURI: string; rate: number; pitch: number }) => Promise<void>;
  onRenameCustom: (id: string, name: string) => Promise<void>;
  onPreviewCustom: (id: string) => void;
  onDeleteCustom: (id: string) => Promise<void>;
}

export default function CustomSoundsSection({
  customAssets, onImportCustom, onCreateVoice, onRenameCustom, onPreviewCustom, onDeleteCustom,
}: CustomSoundsProps) {
  const [customError, setCustomError] = useState("");
  // The ceiling, said where sounds are added and before any work is done. It
  // used to arrive as an error after the fact — after a 4.4-second recording,
  // or a voice form filled in — which is the person doing the work for the
  // refusal. The controls that add stay focusable and say aria-disabled rather
  // than `disabled`: the import field and Stop & save both hold focus at the
  // moment the 24th sound lands, and a control disabled under focus drops it to
  // <body> (#518).
  const customCount = customAssets.length;
  const fullReason = libraryFullReason(customCount);
  const full = fullReason !== null;
  const fullProps = full ? { "aria-disabled": true, "aria-describedby": "sm-custom-full" } : {};
  /** Which sound's Delete is armed, by id. Nothing brings a deleted sound back,
   *  so it costs two presses — the LAN unpair's rule (#1175), one row at a time. */
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  /** When it was armed, so a double-click cannot be its own confirmation. */
  const deleteArmedAt = useRef(0);
  /** Each row's Delete, and the import field, for where focus goes once a row
   *  is gone (deleteFocusTarget). */
  const deleteRefs = useRef(new Map<string, HTMLButtonElement>());
  const importRef = useRef<HTMLInputElement>(null);
  // An armed delete stands down on its own, the way the unpairs do.
  useEffect(() => {
    if (!armedDelete) return;
    const t = window.setTimeout(() => setArmedDelete(null), 4_000);
    return () => window.clearTimeout(t);
  }, [armedDelete]);

  const runCustom = async (work: () => Promise<void>) => {
    setCustomError("");
    try { await work(); }
    catch (error) { setCustomError(error instanceof Error ? error.message : "Custom audio could not be saved."); }
  };

  const pressDelete = (id: string, pressed: HTMLButtonElement) => {
    const now = Date.now();
    const press = armedPress({
      armedFor: armedDelete, target: id, armedAt: deleteArmedAt.current, now, gapMs: CONFIRM_GAP_MS,
    });
    if (press === "arm") { setArmedDelete(id); deleteArmedAt.current = now; return; }
    // A double-click is one decision, not two.
    if (press === "ignore") return;
    setArmedDelete(null);
    // Chosen before the row goes, from the list as it stands at the press.
    const next = deleteFocusTarget(customAssets.map(asset => asset.id), id);
    void runCustom(async () => {
      await onDeleteCustom(id);
      // Only when focus is still on the pressed Delete or has already fallen
      // to <body>: somebody who tabbed on meanwhile is left where they went.
      const active = document.activeElement;
      if (active !== pressed && !focusDropped(active?.tagName ?? null)) return;
      (next ? deleteRefs.current.get(next) : importRef.current)?.focus();
    });
  };

  const { recording, startRecording, stopRecording } = useClipRecorder({ full, setCustomError, runCustom, onImportCustom });

  return (
    <section className="sm-custom" aria-labelledby="sm-custom-title">
      <div className="sm-custom-head">
        <h3 className="sm-tone-name" id="sm-custom-title">Custom sounds</h3>
        <span>{customCount} of {MAX_CUSTOM_ASSETS}, kept on this machine</span>
      </div>
      {full && <p className="sm-note" id="sm-custom-full">{fullReason}</p>}
      <div className="sm-custom-actions">
        <label className="sm-custom-card sm-file">
          <span className="sm-custom-card-copy">
            <strong>Import audio</strong>
            <span>WAV, MP3 or OGG</span>
          </span>
          <span className="btn sm-custom-action" aria-hidden="true">Choose file</span>
          <input
            ref={importRef}
            type="file"
            accept="audio/wav,audio/x-wav,audio/mpeg,audio/mp3,audio/ogg,.wav,.mp3,.ogg"
            {...fullProps}
            // A click that would open the picker, from the card or its
            // caption, opens nothing while the library is full.
            onClick={e => { if (full) e.preventDefault(); }}
            onChange={e => {
              const file = e.target.files?.[0];
              e.currentTarget.value = "";
              if (file && !full) void runCustom(() => onImportCustom(file));
            }}
          />
        </label>

        <div className="sm-custom-card">
          <span className="sm-custom-card-copy">
            <strong>Record a clip</strong>
            <span>{recording ? "Recording…" : "Up to 5 seconds"}</span>
          </span>
          {recording ? (
            <button type="button" className="btn sm-custom-action" onClick={stopRecording}>Stop &amp; save</button>
          ) : (
            <button type="button" className="btn sm-custom-action" {...fullProps} onClick={() => void startRecording()}>Record</button>
          )}
        </div>
      </div>

      <SpokenVoiceForm full={full} fullProps={fullProps} runCustom={runCustom} onCreateVoice={onCreateVoice} />

      {customAssets.length > 0 && (
        <div className="sm-custom-list">
          {customAssets.map(asset => (
            <div className="sm-custom-item" key={asset.id}>
              <input
                className="ap-manage-input"
                aria-label={`Rename ${asset.name}`}
                defaultValue={asset.name}
                maxLength={80}
                onBlur={e => {
                  // A name cannot be blank, so a cleared field goes back to
                  // the one it had rather than showing a name nothing saved.
                  if (!e.target.value.trim()) { e.target.value = asset.name; return; }
                  void runCustom(() => onRenameCustom(asset.id, e.target.value));
                }}
                onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
              />
              <span>{asset.kind === "audio" ? `${asset.duration.toFixed(1)}s` : "Voice"}</span>
              {/* Named for the sound, not only the verb: a list of eight
                  rows read aloud as "Play, Delete, Play, Delete" says
                  nothing about which one a press would act on. */}
              <button type="button" className="btn sm-custom-icon" aria-label={`Play ${asset.name}`} onClick={() => onPreviewCustom(asset.id)}>Play</button>
              {/* Two presses, because nothing brings a deleted sound back:
                  the first arms, a second inside four seconds deletes. And
                  it hands focus on, since the row it sat in goes with it. */}
              <button
                type="button"
                ref={el => { if (el) deleteRefs.current.set(asset.id, el); else deleteRefs.current.delete(asset.id); }}
                className={`btn sm-custom-icon${armedDelete === asset.id ? " armed" : ""}`}
                // A held key repeats at about half a second, past the gap,
                // while the finger has never come up: one decision.
                onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
                onClick={e => pressDelete(asset.id, e.currentTarget)}
                aria-label={armedDelete === asset.id ? `Confirm deleting ${asset.name}` : `Delete ${asset.name}`}
                title={armedDelete === asset.id ? "Press again to delete this sound. It cannot be brought back." : "Delete this sound"}
              >
                {armedDelete === asset.id ? "Confirm" : "Delete"}
              </button>
            </div>
          ))}
        </div>
      )}
      {customError && <p className="sm-custom-error" role="alert">{customError}</p>}
    </section>
  );
}
