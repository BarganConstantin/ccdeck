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
import { SettingRow, SettingsGroup } from "./SettingsParts";
import { useT } from "../i18n";
import { formatNumber } from "../i18n/format";
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
  const t = useT();
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
  const importRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  // An armed delete stands down on its own, the way the unpairs do.
  useEffect(() => {
    if (!armedDelete) return;
    const timer = window.setTimeout(() => setArmedDelete(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [armedDelete]);

  const runCustom = async (work: () => Promise<void>) => {
    setCustomError("");
    try { await work(); }
    catch (error) { setCustomError(error instanceof Error ? error.message : t("settings.sounds.custom.saveFail")); }
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
    // One group in the shared shape (SettingsParts.tsx, #2176): the ways to add
    // a sound as rows, a name and what it takes on the left and the one verb on
    // the right, then the sounds already added as rows of the same list. They
    // were two cards side by side and a disclosure under them, a third shape in
    // a section whose tones above are rows.
    <SettingsGroup
      id="sm-custom-title"
      title={t("settings.sounds.custom.title")}
      note={t("settings.sounds.custom.note")}
      aside={<span className="settings-caption-count">{t("settings.sounds.custom.count", { count: customCount, max: MAX_CUSTOM_ASSETS })}</span>}
      className="sm-custom"
      settingId="custom-sounds"
    >
      {full && <p className="settings-row settings-row-status" id="sm-custom-full">{fullReason}</p>}
      <SettingRow
        as="div"
        settingId="custom-import"
        name={t("settings.sounds.custom.import")}
        note={t("settings.sounds.custom.importNote")}
        control={
          <button
            ref={importRef}
            type="button"
            className="btn sm-custom-action"
            {...fullProps}
            onClick={() => { if (!full) pickerRef.current?.click(); }}
          >
            {t("settings.sounds.custom.chooseFile")}
          </button>
        }
      >
        <input
          ref={pickerRef}
          type="file"
          hidden
          accept="audio/wav,audio/x-wav,audio/mpeg,audio/mp3,audio/ogg,.wav,.mp3,.ogg"
          onChange={e => {
            const file = e.target.files?.[0];
            e.currentTarget.value = "";
            if (file && !full) void runCustom(() => onImportCustom(file));
          }}
        />
      </SettingRow>
      <SettingRow
        as="div"
        settingId="custom-record"
        name={t("settings.sounds.custom.record")}
        note={recording ? t("settings.sounds.custom.recording") : t("settings.sounds.custom.upTo5")}
        control={recording ? (
          <button type="button" className="btn sm-custom-action" onClick={stopRecording}>{t("settings.sounds.custom.stopSave")}</button>
        ) : (
          <button type="button" className="btn sm-custom-action" {...fullProps} onClick={() => void startRecording()}>{t("settings.sounds.custom.recordBtn")}</button>
        )}
      />

      <SpokenVoiceForm full={full} fullProps={fullProps} runCustom={runCustom} onCreateVoice={onCreateVoice} />

      {customAssets.map(asset => (
        <div className="sm-custom-item" key={asset.id}>
          <input
            className="ap-manage-input"
            aria-label={t("settings.sounds.custom.rename", { name: asset.name })}
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
          <span>{asset.kind === "audio" ? `${formatNumber(asset.duration, 1)}s` : t("settings.sounds.custom.voice")}</span>
          {/* Named for the sound, not only the verb: a list of eight
              rows read aloud as "Play, Delete, Play, Delete" says
              nothing about which one a press would act on. */}
          <button type="button" className="btn sm-custom-icon" aria-label={t("settings.sounds.custom.playName", { name: asset.name })} onClick={() => onPreviewCustom(asset.id)}>{t("settings.sounds.custom.play")}</button>
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
            aria-label={armedDelete === asset.id ? t("settings.sounds.custom.confirmName", { name: asset.name }) : t("settings.sounds.custom.deleteName", { name: asset.name })}
            title={armedDelete === asset.id ? t("settings.sounds.custom.deleteAgain") : t("settings.sounds.custom.deleteTip")}
          >
            {armedDelete === asset.id ? t("settings.sounds.custom.confirm") : t("settings.sounds.custom.delete")}
          </button>
        </div>
      ))}
      {customError && <p className="settings-row settings-row-status sm-custom-error" role="alert">{customError}</p>}
    </SettingsGroup>
  );
}
