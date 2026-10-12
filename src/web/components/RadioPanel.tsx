import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const genres = ["ambient", "classical", "electronic", "jazz", "lofi", "pop", "rock", "news"];
const cleanLabel = (label: string) => label.replace(/^[^\p{L}\p{N}]+/u, "");
const stationMetadata = (station: RadioStation) => [station.radio.country, station.radio.tags.split(",").filter(Boolean).slice(0, 2).join(", ")].filter(Boolean).join(" · ");

export default function RadioPanel({ fm, player, library, selected: current, label, enabled, disabledReason, onPick, onClose }: {
  fm: ReturnType<typeof useClaudeFm>; player: FmPlayer; library: ReturnType<typeof useRadioLibrary>;
  selected?: RadioStation; label: string; enabled: boolean; disabledReason: string;
  onPick: (station: RadioStation) => void; onClose: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusInspection = useRef(false);
  const panel = useModalDismiss<HTMLDivElement>(onClose, { focusRef: searchRef });
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("");
  const [genre, setGenre] = useState("");
  const [language, setLanguage] = useState("");
  const [collection, setCollection] = useState("discover");
  const [results, setResults] = useState(library.catalogue);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [inspected, setInspected] = useState<RadioStation>();
  const [locateRequest, setLocateRequest] = useState(0);
  const [mobileView, setMobileView] = useState("stations");
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
  const countries = useMemo(() => [...new Map([...world.filter(country => /^[A-Z]{2}$/.test(country.code)).map(country => [country.code, country.name] as const), ...[...library.catalogue, ...results, ...saved].filter(station => /^[A-Z]{2}$/.test(station.radio.countryCode)).map(station => [station.radio.countryCode, station.radio.country] as const)]).entries()].sort((a, b) => a[1].localeCompare(b[1])), [library.catalogue, results, saved]);
  const stations = useMemo(() => {
    const pool = new Map([...library.catalogue, ...results, ...saved].map(station => [station.id, station]));
    const ids = collection === "favorites" ? library.favorites : library.recent;
    const rows = collection === "discover" ? results : ids.flatMap(id => pool.get(id) ?? []);
    return rows.filter(station => matchesRadio(station, query, country, genre, language));
  }, [collection, library.catalogue, library.favorites, library.recent, results, saved, query, country, genre, language]);
  const day = new Date().toLocaleDateString("en-CA");
  const today = useMemo(() => dailyStation(library.catalogue, day), [library.catalogue, day]);
  const hasFilters = !!(query || country || genre || language);
  const currentFavorite = current && library.favorites.includes(current.id);
  const showFailure = player.dead && (!!current || fm.fmPlayRequest > 0);
  const state = !enabled ? "disabled" : showFailure ? "failed" : player.armed && !player.playing ? "connecting" : player.playing ? "playing" : "paused";
  const status = !enabled ? disabledReason : showFailure ? "Stream unavailable · retry or choose another" : player.dead ? "Choose a station to start listening" : player.armed && !player.playing ? player.buffering ? "Buffering…" : "Connecting…" : player.playing ? "Playing live" : "Paused";
  const resetFilters = () => { setQuery(""); setCountry(""); setGenre(""); setLanguage(""); };
  const toggleFavorite = (station: RadioStation) => { fm.addFmStation(station); library.toggleFavorite(station.id); };
  const inspect = useCallback((station: RadioStation) => {
    setInspected(station);
    if (window.matchMedia("(max-width: 840px)").matches) {
      focusInspection.current = true;
      setMobileView("map");
    }
  }, []);
  useEffect(() => {
    if (!focusInspection.current) return;
    focusInspection.current = false;
    panel.current?.querySelector<HTMLButtonElement>(".radio-inspector-actions button")?.focus({ preventScroll: true });
  }, [inspected, mobileView, panel]);
  const pick = (station: RadioStation) => { setInspected(station); onPick(station); };
  const clearInspection = () => {
    setInspected(undefined);
    panel.current?.querySelector<SVGSVGElement>(".radio-map-canvas")?.focus();
  };
  useEffect(() => {
    if (!inspected || !listRef.current) return;
    const list = listRef.current, row = list.querySelector<HTMLElement>(`[data-station-id="${CSS.escape(inspected.id)}"]`);
    if (!row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [inspected?.id]);
  const pickBuiltIn = (source: FmSelection) => {
    if (source === fm.fmSource && !player.dead) player.press(); else fm.pickFmSource(source);
  };
  const manualStations = fm.customFmStations.filter(station => !station.radio);
  return <div ref={panel} id="radio-panel" className="radio-panel nodrag nopan nowheel" role="dialog" aria-modal="true" aria-labelledby="radio-title" onKeyDown={containPopoverKeys}>
    <header className="radio-header">
      <div className="radio-heading"><RadioIcon name="radio" /><h2 id="radio-title">Radio <span>Explorer</span></h2></div>
      <span className="radio-header-note">A soundtrack for your workspace</span>
      <button type="button" className="icon-btn" aria-label="Close radio" onClick={onClose}><RadioIcon name="close" /></button>
    </header>
    <div className="radio-player" data-state={state}>
      <section className="radio-now" aria-label="Current station">
        <div className="radio-art" aria-hidden="true"><RadioIcon name={current ? "globe" : "radio"} /><span>{current?.radio.countryCode || "FM"}</span></div>
        <div className="radio-now-meta"><span className="radio-eyebrow">{player.playing ? "On air" : "Current station"}</span><strong title={label}>{label}</strong><span>{current ? [current.radio.region, current.radio.country].filter(Boolean).join(", ") : "Your music on ccdeck"}</span><span role="status" className={`radio-playback-status ${showFailure ? "radio-error" : ""}`}><i aria-hidden="true" />{status}</span></div>
        {current && <button className="icon-btn" type="button" aria-label={currentFavorite ? "Remove station from favorites" : "Save station to favorites"} aria-pressed={!!currentFavorite} onClick={() => toggleFavorite(current)}><RadioIcon name="heart" /></button>}
        <button className="radio-play" type="button" disabled={!enabled || (!player.probe && !player.dead)} aria-label={`${player.dead ? "Retry" : player.armed ? "Pause" : "Play"} ${label}`} onClick={() => player.dead ? current ? pick(current) : fm.pickFmSource(fm.fmSource) : player.press()}><RadioIcon name={player.armed ? "pause" : "play"} /></button>
      </section>
      <div className="radio-controls"><VolumeRow id="radio-volume" value={fm.fmVolume} onLevel={fm.setFmVolume} /><button type="button" className="btn radio-mute" aria-pressed={fm.fmMuted} onClick={() => fm.setFmMuted(muted => !muted)}>{fm.fmMuted ? "Unmute" : "Mute"}</button><button type="button" className="btn radio-surprise" disabled={!enabled || !stations.some(station => station.id !== current?.id)} onClick={() => { const station = surpriseStation(stations, current?.id); if (station) pick(station); }}><RadioIcon name="shuffle" /> Surprise me</button></div>
    </div>
    <div className="radio-mobile-view" role="group" aria-label="Explorer view"><button type="button" aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}><RadioIcon name="globe" />Map</button><button type="button" aria-pressed={mobileView === "stations"} onClick={() => setMobileView("stations")}><RadioIcon name="search" />Stations</button></div>
    <div className="radio-workspace" data-view={mobileView}>
      <RadioMap stations={enabled ? stations : []} selected={inspected} current={current} playing={player.playing} onInspect={inspect} locateRequest={locateRequest}>
        {inspected && <section className="radio-inspector" aria-label="Station details">
          <div className="radio-inspector-title"><span className="radio-station-code">{inspected.radio.countryCode || "FM"}</span><div><span className="radio-eyebrow">{inspected.id === current?.id && player.playing ? "Playing live" : "Selected station"}</span><strong>{inspected.name}</strong><span>{stationMetadata(inspected)}</span></div><button type="button" className="icon-btn" aria-label="Clear station selection" onClick={clearInspection}><RadioIcon name="close" /></button></div>
          <div className="radio-inspector-actions"><button type="button" className="btn primary" disabled={!enabled} onClick={() => pick(inspected)}><RadioIcon name={inspected.id === current?.id && player.armed ? "pause" : "play"} />{inspected.id === current?.id && player.armed ? "Pause" : fm.unavailableFmStations.has(inspected.id) ? "Retry stream" : "Play station"}</button><button type="button" className="btn" aria-pressed={library.favorites.includes(inspected.id)} onClick={() => toggleFavorite(inspected)}><RadioIcon name="heart" />{library.favorites.includes(inspected.id) ? "Saved" : "Save"}</button>{inspected.radio.lat !== null && inspected.radio.lon !== null ? <button type="button" className="icon-btn radio-locate" aria-label="Locate selected station on map" title="Locate on map" onClick={() => setLocateRequest(value => value + 1)}><RadioIcon name="globe" /></button> : <span className="radio-no-location">No directory coordinates</span>}</div>
        </section>}
      </RadioMap>
      <section className="radio-discovery" aria-label="Station discovery">
        <div className="radio-collections" role="group" aria-label="Station collection">{[["discover", "Discover"], ["favorites", `Favorites${library.favorites.length ? ` · ${library.favorites.length}` : ""}`], ["recent", "Recent"]].map(([value, text]) => <button type="button" key={value} aria-pressed={collection === value} onClick={() => setCollection(value)}>{text}</button>)}</div>
        <div className="radio-search"><RadioIcon name="search" /><label className="vis-hidden" htmlFor="radio-search">Search stations</label><input ref={searchRef} id="radio-search" type="search" placeholder="Search station names…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}><RadioIcon name="close" /></button>}</div>
        <div className="radio-filters"><label><span className="vis-hidden">Country</span><select value={country} onChange={event => setCountry(event.target.value)}><option value="">All countries</option>{countries.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label><label><span className="vis-hidden">Genre</span><select value={genre} onChange={event => setGenre(event.target.value)}><option value="">All sounds</option>{genres.map(value => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></label><label><span className="vis-hidden">Language</span><input placeholder="Language" value={language} onChange={event => setLanguage(event.target.value)} /></label></div>
        <div className="radio-results-heading"><span>{loading && collection === "discover" ? "Updating stations…" : `${stations.length} stations`}</span>{hasFilters && <button type="button" className="radio-reset" onClick={resetFilters}>Clear filters</button>}</div>
        <div ref={listRef} className="radio-list" aria-label="Stations" aria-busy={loading && collection === "discover"}>
          {!enabled && <p className="radio-empty" role="status">{disabledReason}</p>}
          {enabled && collection === "discover" && error && <div className="radio-directory-error" role="status"><strong>Directory unavailable</strong><p>{stations.length ? "The saved catalogue is still available." : "Try your favorites or existing streams."}</p><button type="button" className="btn" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
          {enabled && loading && collection === "discover" && !stations.length && <div className="radio-skeleton" role="status" aria-label="Finding stations">{[0, 1, 2, 3, 4].map(index => <div key={index}><i /><span /><span /></div>)}</div>}
          {enabled && today && collection === "discover" && !hasFilters && <button type="button" className="radio-daily" onClick={() => pick(today)}><span><span className="radio-eyebrow">Today’s station</span><strong>{today.name}</strong><span>{today.radio.country}</span></span><RadioIcon name="play" /></button>}
          {enabled && stations.map(station => {
            const selected = inspected?.id === station.id, active = current?.id === station.id, audible = active && player.playing, unavailable = fm.unavailableFmStations.has(station.id);
            return <div className={`radio-station${selected ? " selected" : ""}${active ? " current" : ""}${audible ? " playing" : ""}`} key={station.id} data-station-id={station.id}>
              <button type="button" className="radio-station-pick" aria-label={`Inspect ${station.name}, ${station.radio.country}`} aria-pressed={selected} onClick={() => inspect(station)}><span className="radio-station-code">{station.radio.countryCode || "FM"}</span><span><strong>{station.name}</strong><span>{unavailable ? "Stream unavailable · retry" : stationMetadata(station)}</span>{active && !unavailable && <span className="radio-row-state">{audible ? "Playing live" : player.armed ? player.buffering ? "Buffering…" : "Connecting…" : "Paused"}</span>}</span></button>
              <button type="button" className="icon-btn radio-row-play" aria-label={`${active && player.armed ? "Pause" : unavailable ? "Retry" : "Play"} ${station.name}, ${station.radio.country}`} onClick={() => pick(station)}><RadioIcon name={active && player.armed ? "pause" : "play"} /></button>
              <button type="button" className="icon-btn" aria-pressed={library.favorites.includes(station.id)} aria-label={`${library.favorites.includes(station.id) ? "Unsave" : "Save"} ${station.name}`} onClick={() => toggleFavorite(station)}><RadioIcon name="heart" /></button>
            </div>;
          })}
          {enabled && !stations.length && !(loading && collection === "discover") && <div className="radio-empty"><RadioIcon name={collection === "favorites" ? "heart" : "search"} /><strong>{collection === "favorites" ? hasFilters ? "No favorites match" : "Keep your favorite frequencies" : collection === "recent" ? hasFilters ? "No recent stations match" : "Your listening trail starts here" : error ? "Your streams are ready below" : "No stations match"}</strong><p>{hasFilters ? "Try a different name or clear the filters." : collection === "favorites" ? "Save a station with the heart to find it here." : collection === "recent" ? "Stations you play will appear here." : "Choose a different country, sound or language."}</p>{hasFilters && <button type="button" className="btn" onClick={resetFilters}>Clear filters</button>}</div>}
          {enabled && collection === "discover" && !hasFilters && <details className="radio-own"><summary>Your streams <span>{FM_SOURCE_OPTIONS.length + manualStations.length}</span></summary>{FM_SOURCE_OPTIONS.map(source => <button key={source.value} type="button" className="radio-own-station" aria-current={fm.fmSource === source.value || undefined} onClick={() => pickBuiltIn(source.value)}>{cleanLabel(source.label)}<RadioIcon name={fm.fmSource === source.value && player.armed ? "pause" : "play"} /></button>)}{manualStations.map(station => <button key={station.id} type="button" className="radio-own-station" onClick={() => pickBuiltIn(customFmSelection(station.id))}>{station.name}<RadioIcon name="play" /></button>)}</details>}
        </div>
        {stations.length === 300 && <p className="radio-directory-limit">Showing 300 results · search or filter to discover more</p>}
      </section>
    </div>
    <footer className="radio-footer"><span>Music keeps playing when you close Radio.</span><a href="https://www.radio-browser.info/" target="_blank" rel="noreferrer">Stations by Radio Browser ↗</a></footer>
  </div>;
}
