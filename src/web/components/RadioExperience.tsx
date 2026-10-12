import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { customFmSelection } from "../fm-stations";
import type { useClaudeFm } from "../use-claude-fm";
import { useFmPlayer } from "../use-fm-player";
import { useRadioLibrary } from "../use-radio-library";
import type { RadioStation } from "../radio-library";
import { ClaudeFmCharacter, FmPlaybackFrame, sourceLabel } from "./ClaudeFm";
import RadioIcon from "./RadioIcon";

const RadioPanel = lazy(() => import("./RadioPanel"));

export default function RadioExperience({ fm, characterEnabled }: { fm: ReturnType<typeof useClaudeFm>; characterEnabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [disabledReason, setDisabledReason] = useState("Connecting to the deck…");
  const dock = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ left: 66, bottom: 64 });
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = dock.current?.getBoundingClientRect();
      if (!rect) return;
      const next = { left: rect.left, bottom: Math.max(64, innerHeight - rect.top + 10) };
      setAnchor(current => current.left === next.left && current.bottom === next.bottom ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    const canvas = dock.current?.closest(".canvas-wrap");
    if (canvas) observer.observe(canvas);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [open]);
  const library = useRadioLibrary();
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
  const { remember } = library;
  useEffect(() => { if (selected && player.playing) remember(selected.id); }, [selected?.id, player.playing, remember]);
  const close = useCallback(() => setOpen(false), []);
  const pick = useCallback((station: RadioStation) => {
    if (!enabled) return;
    fm.addFmStation(station);
    const source = customFmSelection(station.id);
    if (source === fm.fmSource && !player.dead) player.press(); else fm.pickFmSource(source);
    fetch(`/api/radio-click?id=${encodeURIComponent(station.id)}`).catch(() => {});
  }, [enabled, fm.addFmStation, fm.fmSource, fm.pickFmSource, player.dead, player.press]);
  return <>
    {characterEnabled && <ClaudeFmCharacter player={player} source={fm.fmSource} customStation={customStation} />}
    <FmPlaybackFrame player={player} label={label} />
    <div ref={dock} className="radio-dock nodrag nopan nowheel" data-playing={player.playing || undefined}>
      <button className="radio-dock-open" type="button" onClick={() => setOpen(value => !value)} aria-label={open ? "Close radio" : `Open radio${player.playing ? ` · ${label}` : ""}`} aria-expanded={open} aria-controls={open ? "radio-panel" : undefined}><RadioIcon name="radio" /><span>{player.playing ? label : "Radio"}</span></button>
      {player.armed && <button className="radio-dock-stop" type="button" onClick={player.press} aria-label={`Stop ${label}`}><RadioIcon name="pause" /></button>}
    </div>
    {open && createPortal(<div className="radio-portal" style={{ "--radio-anchor-left": `${anchor.left}px`, "--radio-anchor-bottom": `${anchor.bottom}px` } as CSSProperties}><Suspense fallback={<div className="radio-loading nodrag nopan"><span role="status">Opening radio…</span><button type="button" className="btn" onClick={close}>Close</button></div>}><RadioPanel fm={fm} player={player} library={library} selected={selected} label={label} enabled={enabled} disabledReason={disabledReason} onPick={pick} onClose={close} /></Suspense></div>, document.body)}
  </>;
}
