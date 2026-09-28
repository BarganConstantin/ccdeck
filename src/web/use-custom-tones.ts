// Custom notification sounds: the clips somebody imported or recorded, which
// tone points at which, and every way one is added, renamed, chosen or removed.
//
// Lifted out of App.tsx's `Inner` as the UPPER of the two layers the tones split
// into. It depends on the lower layer, use-tone-prefs.ts, in exactly one
// direction: when a clip a tone points at is deleted or falls back, that tone's
// built-in figure is reset through `setTonePrefs`. The settings layer never
// touches anything here, which is why the split holds.
//
// The two setters are private now, and that is the point of this file rather
// than its line count. Before, anything in five thousand lines could call
// `setCustomSelections` and skip the storage write-through and the ref sync that
// every operation below performs. Now only these operations can write, so the
// write-through is guaranteed rather than a convention.
import { useCallback, useEffect, useState, type MutableRefObject } from "react";

import { clearCustomAssetSelections, createCustomVoice, CUSTOM_AUDIO_KEYS, deleteCustomNotificationAsset,
         importCustomAudio, libraryFullReason, listCustomNotificationAssets, readCustomSelections,
         renameCustomNotificationAsset, saveCustomNotificationAsset, summarizeCustomAsset,
         type CustomAssetSummary, type CustomSelections } from "./notification-audio";
import type { createChimePlayer } from "./chime-player";
import { CHIME_ORDER, DEFAULT_FIGURE_ID, DEFAULT_LEVEL, FIGURE_KEYS, type Chime } from "./sound";
import { readStored, removeStored, writeStored } from "./storage";
import { useMirroredRef } from "./use-mirrored-ref";
import type { TonePrefsControls } from "./use-tone-prefs";

type ChimePlayer = ReturnType<typeof createChimePlayer>;

/** What this layer needs from the component and from the tone settings below it. */
export interface CustomTonesDeps {
  chimesRef: MutableRefObject<ChimePlayer | null>;
  setTonePrefs: TonePrefsControls["setTonePrefs"];
  tonePrefsRef: TonePrefsControls["tonePrefsRef"];
  previewTone: TonePrefsControls["previewTone"];
}

export function useCustomTones({ chimesRef, setTonePrefs, tonePrefsRef, previewTone }: CustomTonesDeps) {
  // Custom sounds are selected independently from the built-in figure. Keeping
  // the figure intact gives every custom choice a deterministic local fallback
  // without changing the shape #711 stores and tests.
  const [customSelections, setCustomSelections] = useState<CustomSelections>(() => readCustomSelections(readStored));
  const customSelectionsRef = useMirroredRef(customSelections);
  // The listing only — names, kinds and lengths. A clip's bytes stay in the
  // store until the player asks for the one it is about to play (loadCustom).
  const [customAssets, setCustomAssets] = useState<CustomAssetSummary[]>([]);

  const clearCustomOnly = useCallback((chime: Chime) => {
    setCustomSelections(prev => {
      const next = { ...prev, [chime]: null };
      customSelectionsRef.current = next;
      return next;
    });
    removeStored(CUSTOM_AUDIO_KEYS[chime]);
  }, []);

  const fallbackCustom = useCallback((chime: Chime, expectedId?: string) => {
    const selected = customSelectionsRef.current[chime];
    if (expectedId && selected !== expectedId) return;
    clearCustomOnly(chime);
    setTonePrefs(prev => {
      const next = { ...prev, [chime]: { ...prev[chime], figure: DEFAULT_FIGURE_ID } };
      tonePrefsRef.current = next;
      return next;
    });
    writeStored(FIGURE_KEYS[chime], DEFAULT_FIGURE_ID);
  }, [clearCustomOnly]);
  const fallbackCustomRef = useMirroredRef(fallbackCustom);

  useEffect(() => {
    let live = true;
    void listCustomNotificationAssets().then(assets => {
      if (!live) return;
      setCustomAssets(assets);
      const ids = new Set(assets.map(asset => asset.id));
      for (const chime of CHIME_ORDER) {
        const selected = customSelectionsRef.current[chime];
        if (selected && !ids.has(selected)) fallbackCustomRef.current(chime, selected);
      }
    }, () => { /* storage unavailable: keep the stored selection for a later retry */ });
    return () => { live = false; };
  }, []);

  /** The trailing timer for the tone a changed setting plays back. */

  const selectCustomTone = useCallback((chime: Chime, id: string) => {
    if (!customAssets.some(asset => asset.id === id)) return;
    const next = { ...customSelectionsRef.current, [chime]: id };
    customSelectionsRef.current = next;
    setCustomSelections(next);
    writeStored(CUSTOM_AUDIO_KEYS[chime], id);
    previewTone(chime, true);
  }, [customAssets, previewTone]);

  const importNotificationAudio = useCallback(async (file: File) => {
    const full = libraryFullReason(customAssets.length);
    if (full) throw new Error(full);
    const Ctx = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw new Error("This browser cannot decode audio files.");
    const decoder = new Ctx();
    try {
      const asset = await importCustomAudio(file, bytes => decoder.decodeAudioData(bytes));
      await saveCustomNotificationAsset(asset);
      // The row, not the clip: keeping the bytes here would be the boot load
      // this state stopped holding, one import at a time.
      const row = summarizeCustomAsset(asset);
      setCustomAssets(prev => [...prev.filter(item => item.id !== row.id), row]);
    } finally {
      void decoder.close?.();
    }
  }, [customAssets.length]);

  const createNotificationVoice = useCallback(async (input: {
    name: string; text: string; voiceURI: string; rate: number; pitch: number;
  }) => {
    const full = libraryFullReason(customAssets.length);
    if (full) throw new Error(full);
    const asset = createCustomVoice(input);
    await saveCustomNotificationAsset(asset);
    const row = summarizeCustomAsset(asset);
    setCustomAssets(prev => [...prev.filter(item => item.id !== row.id), row]);
  }, [customAssets.length]);

  const renameCustomAsset = useCallback(async (id: string, name: string) => {
    const current = customAssets.find(asset => asset.id === id);
    const nextName = name.trim().slice(0, 80);
    if (!current || !nextName || nextName === current.name) return;
    // By id, not by writing this row back: the row has no bytes to write.
    await renameCustomNotificationAsset(id, nextName);
    setCustomAssets(prev => prev.map(asset => asset.id === id ? { ...asset, name: nextName } : asset));
  }, [customAssets]);

  const deleteCustomAsset = useCallback(async (id: string) => {
    await deleteCustomNotificationAsset(id);
    setCustomAssets(prev => prev.filter(asset => asset.id !== id));
    const before = customSelectionsRef.current;
    const after = clearCustomAssetSelections(before, id);
    customSelectionsRef.current = after;
    setCustomSelections(after);
    const affected = CHIME_ORDER.filter(chime => before[chime] === id);
    for (const chime of affected) {
      removeStored(CUSTOM_AUDIO_KEYS[chime]);
      writeStored(FIGURE_KEYS[chime], DEFAULT_FIGURE_ID);
    }
    if (affected.length > 0) {
      setTonePrefs(prev => {
        const next = { ...prev };
        for (const chime of affected) next[chime] = { ...next[chime], figure: DEFAULT_FIGURE_ID };
        tonePrefsRef.current = next;
        return next;
      });
    }
  }, []);

  const previewCustomAsset = useCallback((id: string) => {
    const selectedTone = CHIME_ORDER.find(chime => customSelectionsRef.current[chime] === id);
    const level = selectedTone ? tonePrefsRef.current[selectedTone].level : DEFAULT_LEVEL;
    chimesRef.current?.unlock();
    chimesRef.current?.previewCustom(id, level);
  }, []);

  return { customSelections, customSelectionsRef, customAssets, clearCustomOnly, fallbackCustomRef,
           selectCustomTone, importNotificationAudio, createNotificationVoice, renameCustomAsset,
           deleteCustomAsset, previewCustomAsset };
}
