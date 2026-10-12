import { useEffect, useMemo, useRef, useState } from "react";
import { FM_SOURCE_OPTIONS } from "../appearance";
import { customFmSelection, type FmSelection } from "../fm-stations";
import { dailyStation, matchesRadio, resolveRadioStations, surpriseStation, type RadioStation } from "../radio-library";
import type { useClaudeFm } from "../use-claude-fm";
import type { FmPlayer } from "../use-fm-player";
import type { useRadioLibrary } from "../use-radio-library";
import { containPopoverKeys } from "../shortcuts";
import world from "../assets/radio-world.json";
import RadioIcon from "./RadioIcon";
import RadioMap from "./RadioMap";
import VolumeRow from "./VolumeRow";
import { useModalDismiss } from "./use-modal-dismiss";

const countries = [...new Map(world.filter(country => /^[A-Z]{2}$/.test(country.code)).map(country => [country.code, country.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
const genres = ["ambient", "classical", "electronic", "jazz", "lofi", "pop", "rock", "news"];
const cleanLabel = (label: string) => label.replace(/^[^\p{L}\p{N}]+/u, "");

export default function RadioPanel({ fm, player, library, selected, label, enabled, disabledReason, onPick, onClose }: {
  fm: ReturnType<typeof useClaudeFm>;
  player: FmPlayer;
  library: ReturnType<typeof useRadioLibrary>;
  selected?: RadioStation;
  label: string;
  enabled: boolean;
  disabledReason: string;
  onPick: (station: RadioStation) => void;
  onClose: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const panel = useModalDismiss<HTMLDivElement>(onClose, { focusRef: searchRef, popover: true });
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("");
  const [genre, setGenre] = useState("");
  const [language, setLanguage] = useState("");
  const [collection, setCollection] = useState("discover");
  const [results, setResults] = useState(library.catalogue);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const { updateCatalogue } = library;

  useEffect(() => {
    if (!enabled || collection !== "discover") return;
    const controller = new AbortController();
    setLoading(true); setError(false);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ name: query, country, tag: genre, language });
      fetch(`/api/radio-stations?${params}`, { signal: controller.signal })
        .then(response => response.ok ? response.json() : Promise.reject(new Error("unavailable")))
        .then(answer => {
          if (controller.signal.aborted) return;
          if (!answer.ok || answer.off) throw new Error("unavailable");
          const stations = resolveRadioStations(answer.stations);
          setResults(stations);
          if (!query && !country && !genre && !language) updateCatalogue(stations);
        })
        .catch(() => { if (!controller.signal.aborted) setError(true); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query || language ? 350 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, query, country, genre, language, collection, retry, updateCatalogue]);

  const saved = useMemo(() => fm.customFmStations.filter((station): station is RadioStation => !!station.radio), [fm.customFmStations]);
  const stations = useMemo(() => {
    const pool = new Map([...library.catalogue, ...results, ...saved].map(station => [station.id, station]));
    const ids = collection === "favorites" ? library.favorites : library.recent;
    const rows = collection === "discover" ? results : ids.flatMap(id => pool.get(id) ?? []);
    return rows.filter(station => matchesRadio(station, query, country, genre, language));
  }, [collection, library.catalogue, library.favorites, library.recent, results, saved, query, country, genre, language]);
  const day = new Date().toLocaleDateString("en-CA");
  const today = useMemo(() => dailyStation(library.catalogue, day), [library.catalogue, day]);
  const favorite = selected && library.favorites.includes(selected.id);
  const status = !enabled ? disabledReason : player.dead ? "This station could not be played. Try again or choose another." : player.armed && !player.playing ? "Connecting…" : player.playing ? "Playing" : "Paused";
  const resetFilters = () => { setQuery(""); setCountry(""); setGenre(""); setLanguage(""); };
  const pickBuiltIn = (source: FmSelection) => {
    if (source === fm.fmSource && !player.playing) player.press(); else fm.pickFmSource(source);
  };
  return <div ref={panel} id="radio-panel" className="radio-panel nodrag nopan nowheel" role="dialog" aria-labelledby="radio-title" onKeyDown={containPopoverKeys}>
    <header className="radio-header"><div><h2 id="radio-title">Radio</h2><p>Find your next place to listen.</p></div><button type="button" className="icon-btn" aria-label="Close radio" onClick={onClose}><RadioIcon name="close" /></button></header>
    <RadioMap stations={stations} selected={selected} onPick={onPick} />
    <section className="radio-now" aria-label="Current station">
      <div className="radio-art" aria-hidden="true"><RadioIcon name={selected ? "globe" : "radio"} /><span>{selected?.radio.countryCode || "FM"}</span></div>
      <div className="radio-now-meta"><strong title={label}>{label}</strong><span>{selected ? [selected.radio.region, selected.radio.country].filter(Boolean).join(", ") : "Your music on ccdeck"}</span><span role="status" className={player.dead ? "radio-error" : ""}>{status}</span></div>
      {selected && <button className="icon-btn" type="button" aria-label={favorite ? "Remove station from favorites" : "Save station to favorites"} aria-pressed={!!favorite} onClick={() => library.toggleFavorite(selected.id)}><RadioIcon name="heart" /></button>}
      <button className="radio-play" type="button" disabled={!enabled || (!player.probe && !player.dead)} aria-label={`${player.armed ? "Stop" : "Play"} ${label}`} onClick={() => player.dead ? selected ? onPick(selected) : fm.pickFmSource(fm.fmSource) : player.press()}><RadioIcon name={player.armed ? "pause" : "play"} /></button>
    </section>
    <div className="radio-controls"><button type="button" className="btn" disabled={!enabled || stations.filter(station => station.id !== selected?.id).length === 0} onClick={() => { const station = surpriseStation(stations, selected?.id); if (station) onPick(station); }}><RadioIcon name="shuffle" /> Surprise me</button><VolumeRow id="radio-volume" value={fm.fmVolume} onLevel={fm.setFmVolume} /><button type="button" className="btn radio-mute" aria-pressed={fm.fmMuted} onClick={() => fm.setFmMuted(muted => !muted)}>{fm.fmMuted ? "Unmute" : "Mute"}</button></div>
    <div className="radio-collections" role="group" aria-label="Station collection">
      {[["discover", "Discover"], ["favorites", `Favorites${library.favorites.length ? ` · ${library.favorites.length}` : ""}`], ["recent", "Recent"]].map(([value, text]) => <button type="button" key={value} aria-pressed={collection === value} onClick={() => setCollection(value)}>{text}</button>)}
    </div>
    <div className="radio-search"><RadioIcon name="search" /><label className="vis-hidden" htmlFor="radio-search">Search stations</label><input ref={searchRef} id="radio-search" type="search" placeholder="Search station names…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="radio-filters">
      <label><span className="vis-hidden">Country</span><select value={country} onChange={event => setCountry(event.target.value)}><option value="">All countries</option>{countries.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
      <label><span className="vis-hidden">Genre</span><select value={genre} onChange={event => setGenre(event.target.value)}><option value="">All sounds</option>{genres.map(value => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></label>
      <label><span className="vis-hidden">Language</span><input placeholder="Language" value={language} onChange={event => setLanguage(event.target.value)} /></label>
    </div>
    <div className="radio-list" aria-label="Stations" aria-busy={loading && collection === "discover"}>
      {!enabled && <p className="radio-empty">{disabledReason}</p>}
      {enabled && collection === "discover" && error && <p className="radio-empty" role="status">The station directory is unavailable.{stations.length > 0 ? " You can still play the saved catalogue." : " Your saved stations and streams are still available."} <button type="button" className="btn" onClick={() => setRetry(value => value + 1)}>Try again</button></p>}
      {enabled && loading && collection === "discover" && <p className="radio-list-note" role="status">Finding stations…</p>}
      {enabled && today && collection === "discover" && !query && !country && !genre && !language && <button type="button" className="radio-daily" onClick={() => onPick(today)}><RadioIcon name="globe" /><span><strong>Today’s station</strong><span>{today.name} · {today.radio.country}</span></span><RadioIcon name="play" /></button>}
      {enabled && stations.map(station => {
        const active = selected?.id === station.id;
        const unavailable = fm.unavailableFmStations.has(station.id);
        return <div className={`radio-station${active ? " active" : ""}`} key={station.id}>
          <button type="button" className="radio-station-pick" aria-label={`Play ${station.name}, ${station.radio.country}`} aria-current={active || undefined} onClick={() => onPick(station)}><span className="radio-station-code">{station.radio.countryCode || "FM"}</span><span><strong>{station.name}</strong><span>{unavailable ? "Unavailable · select to retry" : [station.radio.country, station.radio.tags.split(",").slice(0, 2).join(", ")].filter(Boolean).join(" · ")}</span></span><RadioIcon name={active && player.playing ? "pause" : "play"} /></button>
          <button type="button" className="icon-btn" aria-pressed={library.favorites.includes(station.id)} aria-label={`${library.favorites.includes(station.id) ? "Unsave" : "Save"} ${station.name}`} onClick={() => { fm.addFmStation(station); library.toggleFavorite(station.id); }}><RadioIcon name="heart" /></button>
        </div>;
      })}
      {enabled && !stations.length && !(loading && collection === "discover") && <div className="radio-empty"><p>{collection === "favorites" ? "Save a station with the heart to find it here." : collection === "recent" ? "Stations you listen to will appear here." : error ? "Choose one of your streams below while the directory reconnects." : "No stations match these filters."}</p>{(query || country || genre || language) && <button type="button" className="btn" onClick={resetFilters}>Clear filters</button>}</div>}
      {enabled && collection === "discover" && !query && !country && !genre && !language && <section className="radio-own"><h3>Your streams</h3>{FM_SOURCE_OPTIONS.map(source => <button key={source.value} type="button" className="radio-own-station" aria-current={fm.fmSource === source.value || undefined} onClick={() => pickBuiltIn(source.value)}>{cleanLabel(source.label)}<RadioIcon name="play" /></button>)}{fm.customFmStations.filter(station => !station.radio).map(station => <button key={station.id} type="button" className="radio-own-station" onClick={() => pickBuiltIn(customFmSelection(station.id))}>{station.name}<RadioIcon name="play" /></button>)}</section>}
    </div>
    <footer className="radio-footer"><span>{stations.length} stations{stations.length === 300 ? " · refine your search for more" : ""}</span><a href="https://www.radio-browser.info/" target="_blank" rel="noreferrer">Radio Browser</a></footer>
  </div>;
}
