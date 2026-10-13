import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { customFmSelection } from "../fm-stations";
import type { useClaudeFm } from "../use-claude-fm";
import { useFmPlayer } from "../use-fm-player";
import { useRadioLibrary } from "../use-radio-library";
import type { Character } from "../character";
import { nextAvailableRadioStation, type RadioStation } from "../radio-library";
import { scheduleRadioFailover } from "../radio-failover";
import { useScrimDismiss } from "./use-modal-dismiss";
import { ClaudeFmCharacter, FmPlaybackFrame, sourceLabel } from "./ClaudeFm";
import { RadioOpening } from "./RadioLoading";

const RadioPanel = lazy(() => import("./RadioPanel"));

export default function RadioExperience({ fm, characterEnabled, character, open, onClose }: { fm: ReturnType<typeof useClaudeFm>; characterEnabled: boolean; character: Character; open: boolean; onClose: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [disabledReason, setDisabledReason] = useState("Connecting to the deck…");
  const library = useRadioLibrary();
  const [queue, setQueue] = useState<RadioStation[] | null>(null);
  const failedStations = useRef(new Set<string>());
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/music-config", { signal: controller.signal }).then(response => response.ok ? response.json() : null)
      .then(answer => { if (!controller.signal.aborted) { setEnabled(answer?.enabled === true); setDisabledReason(answer ? "Music is turned off on this deck." : "Cannot reach the deck. Reopen Radio when it reconnects."); } }).catch(() => { if (!controller.signal.aborted) setDisabledReason("Cannot reach the deck. Reopen Radio when it reconnects."); });
    return () => controller.abort();
  }, [open]);
  const customStation = fm.customFmStations.find(station => customFmSelection(station.id) === fm.fmSource);
  const selected = customStation?.radio ? customStation as RadioStation : undefined;
  const player = useFmPlayer({ volume: fm.fmVolume, muted: fm.fmMuted, source: fm.fmSource, playRequest: fm.fmPlayRequest, customStation, enabled, onAvailabilityChange: fm.markFmStationAvailability });
  const label = sourceLabel(fm.fmSource, customStation);
  const autoNext = enabled && selected && player.dead && fm.fmPlayRequest > 0
    ? nextAvailableRadioStation(queue ?? library.catalogue, selected.id, failedStations.current) : null;
  const { remember } = library;
  useEffect(() => { if (selected && player.playing) remember(selected.id); }, [selected?.id, player.playing, remember]);
  const close = onClose;
  const scrimPress = useScrimDismiss(onClose);
  const pick = useCallback((station: RadioStation, automatic = false) => {
    if (!enabled) return;
    if (!automatic) failedStations.current.clear();
    const source = customFmSelection(station.id);
    const same = source === fm.fmSource;
    if (same && player.armed && !player.dead) { player.press(); return; }
    const refreshedMedia = same && !!customStation && (customStation.url !== station.url || customStation.radio?.hls !== station.radio.hls);
    fm.addFmStation(station, true);
    if (same && !player.dead && !refreshedMedia) player.press(); else fm.pickFmSource(source, refreshedMedia);
    fetch(`/api/radio-click?id=${encodeURIComponent(station.id)}`).catch(() => {});
  }, [enabled, customStation, fm.addFmStation, fm.fmSource, fm.pickFmSource, player.armed, player.dead, player.press]);
  useEffect(() => {
    if (player.playing && !player.dead) failedStations.current.clear();
  }, [player.playing, player.dead]);
  useEffect(() => {
    if (!enabled || !selected || !player.dead || fm.fmPlayRequest === 0) return;
    // Cancel on a manual selection, recovery, music-off, or unmount. Playback
    // lives here so closing the explorer does not cancel station failover.
    return scheduleRadioFailover(queue ?? library.catalogue, selected.id, failedStations.current, station => pick(station, true));
  }, [enabled, selected?.id, player.dead, fm.fmPlayRequest, queue, library.catalogue, pick]);
  return <>
    {characterEnabled && <ClaudeFmCharacter character={character} player={player} source={fm.fmSource} customStation={customStation} />}
    <FmPlaybackFrame player={player} label={label} />
    {open && createPortal(<div className="modal-backdrop radio-backdrop" {...scrimPress}><Suspense fallback={<RadioOpening onClose={close} />}><RadioPanel fm={fm} player={player} library={library} selected={selected} label={label} enabled={enabled} disabledReason={disabledReason} autoNext={autoNext?.name} onPick={pick} onQueueChange={setQueue} onClose={close} /></Suspense></div>, document.body)}
  </>;
}
