import { useEffect, useMemo, useRef, useState } from "react";
import { FM_SOURCE_OPTIONS, FM_VOLUME_STEP, type FmSource } from "../appearance";
import { customFmSelection, type FmSelection } from "../fm-stations";
import { adjacentRadioStation, dailyStation, matchesRadio, resolveRadioStations, surpriseStation, type RadioStation } from "../radio-library";
import type { useClaudeFm } from "../use-claude-fm";
import type { FmPlayer } from "../use-fm-player";
import type { useRadioLibrary } from "../use-radio-library";
import { containPopoverKeys } from "../shortcuts";
import world from "../assets/radio-world.json";
import RadioIcon, { type RadioIconName } from "./RadioIcon";
import RadioCountryFlag from "./RadioCountryFlag";
import RadioMap from "./RadioMap";
import RadioLoading from "./RadioLoading";
import RadioFilter from "./RadioFilter";
import VolumeRow from "./VolumeRow";
import { useModalDismiss } from "./use-modal-dismiss";

const genres = ["ambient", "classical", "electronic", "jazz", "lofi", "pop", "rock", "news"];
const cleanLabel = (label: string) => label.replace(/^[^\p{L}\p{N}]+/u, "");
const streamIcons: Record<FmSource, RadioIconName> = {
  "claude-fm": "headphones", "lofi-relax": "book", "lofi-game": "gamepad",
  "lofi-vibe": "sunset", "lofi-sleep": "moon", "radio-mix": "radio",
  "best-of-nostalgia": "cassette", "good-life-radio": "palm", "cafe-music-bgm": "coffee",
};
const stationMetadata = (station: RadioStation) => [station.radio.country, station.radio.tags.split(",").filter(Boolean).slice(0, 2).join(", ")].filter(Boolean).join(" · ");

export default function RadioPanel({ fm, player, library, selected: current, label, enabled, disabledReason, autoNext, onPick, onQueueChange, onClose }: {
  fm: ReturnType<typeof useClaudeFm>; player: FmPlayer; library: ReturnType<typeof useRadioLibrary>;
  selected?: RadioStation; label: string; enabled: boolean; disabledReason: string;
  onPick: (station: RadioStation) => void; onClose: () => void;
  onQueueChange: (stations: RadioStation[]) => void;
  autoNext?: string;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [keyboardOpened] = useState(() => document.activeElement?.matches(":focus-visible") ?? false);
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
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 840px)").matches);
  const [mobileView, setMobileView] = useState("stations");
  const { updateCatalogue } = library;
  useEffect(() => {
    const media = window.matchMedia("(max-width: 840px)");
    const resize = () => setNarrow(media.matches);
    media.addEventListener("change", resize);
    return () => { media.removeEventListener("change", resize); };
  }, []);

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
    const names = new Map(saved.map(station => [station.id, station.name]));
    const pool = new Map([...saved, ...library.catalogue, ...results].map(station => [station.id, { ...station, name: names.get(station.id) ?? station.name }]));
    const ids = collection === "favorites" ? library.favorites : library.recent;
    const rows = collection === "discover" ? results : ids.flatMap(id => pool.get(id) ?? []);
    return rows.filter(station => matchesRadio(station, query, country, genre, language));
  }, [collection, library.catalogue, library.favorites, library.recent, results, saved, query, country, genre, language]);
  useEffect(() => { onQueueChange(stations); }, [stations, onQueueChange]);
  const previousStation = adjacentRadioStation(stations, current?.id, -1);
  const nextStation = adjacentRadioStation(stations, current?.id, 1);
  const navigating = !enabled || (collection === "discover" && loading);
  const day = new Date().toLocaleDateString("en-CA");
  const today = useMemo(() => dailyStation(library.catalogue, day), [library.catalogue, day]);
  const hasFilters = !!(query || country || genre || language);
  const currentFavorite = current && library.favorites.includes(current.id);
  const showFailure = player.dead && (!!current || fm.fmPlayRequest > 0);
  const state = !enabled ? "disabled" : showFailure ? "failed" : player.armed && !player.playing ? "connecting" : player.playing ? "playing" : "paused";
  const status = !enabled ? disabledReason : showFailure ? autoNext ? `Stream unavailable · trying ${autoNext} next…` : "Stream unavailable · retry or choose another" : player.dead ? "Choose a station to start listening" : player.armed && !player.playing ? player.buffering ? "Buffering…" : "Connecting…" : player.playing ? "Playing live" : "Paused";
  const resetFilters = () => { setQuery(""); setCountry(""); setGenre(""); setLanguage(""); };
  const toggleFavorite = (station: RadioStation) => { fm.addFmStation(station); library.toggleFavorite(station.id); };
  const pick = onPick;
  const playCurrent = () => {
    if (current) {
      const fresh = results.find(station => station.id === current.id) ?? library.catalogue.find(station => station.id === current.id) ?? current;
      onPick({ ...fresh, name: current.name });
    } else if (player.dead) fm.pickFmSource(fm.fmSource);
    else player.press();
  };
  useEffect(() => {
    if (!current || !listRef.current) return;
    const list = listRef.current, row = list.querySelector<HTMLElement>(`[data-station-id="${CSS.escape(current.id)}"]`);
    if (!row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [current?.id]);
  const pickBuiltIn = (source: FmSelection) => {
    if (source === fm.fmSource && !player.dead) player.press(); else fm.pickFmSource(source);
  };
  const manualStations = fm.customFmStations.filter(station => !station.radio);
  // These streams have no directory country/language metadata. Keep them
  // first on Discover, and searchable even when the directory is unavailable.
  const ownStreams = (!country || country === "GLOBAL") && !genre && !language ? [
    ...FM_SOURCE_OPTIONS.map(source => ({
      value: source.value,
      id: source.value,
      metadata: "Global · YouTube",
      icon: streamIcons[source.value],
      name: `${source.group?.includes("Lofi Girl") ? "Lofi Girl · " : ""}${cleanLabel(source.label)}`,
    })),
    ...manualStations.map(station => ({ value: customFmSelection(station.id), name: station.name, id: station.id, metadata: "Global · Your stream", icon: "radio" as const })),
  ].filter(source => `${source.name} ${source.metadata}`.toLowerCase().includes(query.trim().toLowerCase()))
    .filter(source => collection === "discover" || (collection === "favorites" ? library.favorites : library.recent).includes(source.id))
    .sort((a, b) => collection === "recent" ? library.recent.indexOf(a.id) - library.recent.indexOf(b.id) : 0) : [];
  const visibleOwnCount = ownStreams.length;
  return <div ref={panel} id="radio-panel" className="radio-panel nodrag nopan nowheel" role="dialog" aria-modal="true" aria-labelledby="radio-title"
    data-keyboard-interaction={keyboardOpened || undefined}
    onKeyDownCapture={event => { event.currentTarget.dataset.keyboardInteraction = "true"; }}
    onPointerDownCapture={event => { delete event.currentTarget.dataset.keyboardInteraction; }}
    onWheelCapture={event => { delete event.currentTarget.dataset.keyboardInteraction; }}
    onKeyDown={containPopoverKeys}>
    <header className="radio-header">
      <div className="radio-heading"><RadioIcon name="radio" /><h2 id="radio-title">Radio <span>Explorer</span></h2></div>
      <span className="radio-header-note">A soundtrack for your workspace</span>
      <button type="button" className="icon-btn" aria-label="Close radio" onClick={onClose}><RadioIcon name="close" /></button>
    </header>
    <div className="radio-player" data-state={state}>
      <section className="radio-now" aria-label="Current station">
        <div className="radio-art" aria-hidden="true"><RadioCountryFlag code={current?.radio.countryCode} /></div>
        <div className="radio-now-meta"><strong title={label}>{label}</strong><div className="radio-now-details"><span className="radio-now-location">{current ? [current.radio.region, current.radio.country].filter(Boolean).join(", ") : "Your music on ccdeck"}</span><span role="status" aria-label={status} title={status} className={`radio-playback-status ${showFailure ? "radio-error" : ""}`}><i aria-hidden="true" />{narrow && showFailure ? "Unavailable" : status}</span></div></div>
      </section>
      <div className="radio-player-actions">
        <div className="radio-transport" role="group" aria-label="Station playback">
          <button className="icon-btn" type="button" aria-label="Previous station" title={previousStation ? `Previous station: ${previousStation.name}` : "No previous station"} disabled={navigating || !previousStation} onClick={() => { if (previousStation) pick(previousStation); }}><RadioIcon name="previous" /></button>
          <button className="radio-play" type="button" disabled={!enabled || (!player.probe && !player.dead)} aria-label={`${player.dead ? "Retry" : player.armed ? "Pause" : "Play"} ${label}`} onClick={playCurrent}><RadioIcon name={player.armed ? "pause" : "play"} /></button>
          <button className="icon-btn" type="button" aria-label="Next station" title={nextStation ? `Next station: ${nextStation.name}` : "No next station"} disabled={navigating || !nextStation} onClick={() => { if (nextStation) pick(nextStation); }}><RadioIcon name="next" /></button>
        </div>
        {current && <button className="icon-btn radio-favorite" type="button" aria-label={currentFavorite ? "Remove station from favorites" : "Save station to favorites"} aria-pressed={!!currentFavorite} onClick={() => toggleFavorite(current)}><RadioIcon name="heart" /></button>}
      </div>
      <div className="radio-controls"><VolumeRow id="radio-volume" step={FM_VOLUME_STEP} value={fm.fmVolume} onLevel={fm.setFmVolume} /><button type="button" className="btn radio-player-button radio-mute" aria-pressed={fm.fmMuted} onClick={() => fm.setFmMuted(muted => !muted)} title={fm.fmMuted ? "Unmute radio" : "Mute radio"}><RadioIcon name={fm.fmMuted ? "muted" : "volume"} />{fm.fmMuted ? "Unmute" : "Mute"}</button><button type="button" className="btn radio-player-button" disabled={!enabled || !stations.some(station => station.id !== current?.id)} onClick={() => { const station = surpriseStation(stations, current?.id); if (station) pick(station); }}><RadioIcon name="shuffle" /> Surprise me</button></div>
    </div>
    <div className="radio-mobile-view" role="group" aria-label="Explorer view"><button type="button" className="radio-view" aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}><RadioIcon name="globe" />Map</button><button type="button" className="radio-view" aria-pressed={mobileView === "stations"} onClick={() => setMobileView("stations")}><RadioIcon name="search" />Stations</button></div>
    <div className="radio-workspace" data-view={mobileView}>
      <RadioMap stations={enabled ? stations : []} selected={current} current={current} playing={player.playing} onPick={pick} />
      <section className="radio-discovery" aria-label="Station discovery">
        <div className="radio-collections" role="group" aria-label="Station collection">{[["discover", "Discover"], ["favorites", `Favorites${library.favorites.length ? ` · ${library.favorites.length}` : ""}`], ["recent", "Recent"]].map(([value, text]) => <button type="button" className="radio-collection" key={value} aria-pressed={collection === value} onClick={() => setCollection(value)}>{text}</button>)}</div>
        <div className="radio-search"><RadioIcon name="search" /><label className="vis-hidden" htmlFor="radio-search">Search stations</label><input ref={searchRef} id="radio-search" type="search" placeholder="Search station names…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><RadioIcon name="close" /></button>}</div>
        <div className="radio-filters" role="group" aria-label="Station filters">
          <RadioFilter label="Country" value={country} onChange={setCountry} options={[{ value: "", label: "All countries" }, { value: "GLOBAL", label: "Global" }, ...countries.map(([value, label]) => ({ value, label }))]} />
          <RadioFilter label="Sound" value={genre} onChange={setGenre} options={[{ value: "", label: "All sounds" }, ...genres.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))]} />
          <RadioFilter label="Language" value={language} onChange={setLanguage} allowCustom options={[{ value: "", label: "Any language" }, ...[...new Set([...library.catalogue, ...results, ...saved].flatMap(station => station.radio.language.split(",")).map(value => value.trim().toLowerCase()).filter(Boolean))].sort().map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))]} />
        </div>
        <div className="radio-results-heading" role="status" aria-live="polite" aria-atomic="true"><span>{loading && collection === "discover" ? "Updating stations…" : `${stations.length + visibleOwnCount} ${hasFilters ? "matching" : collection === "discover" ? "available" : collection === "favorites" ? "saved" : "recent"} stations`}</span>{hasFilters && <button type="button" className="radio-reset" onClick={resetFilters}>Clear filters</button>}</div>
        <div ref={listRef} className="radio-list" role="region" aria-label="Stations" aria-busy={loading && collection === "discover"}>
          {enabled && visibleOwnCount > 0 && <details className="radio-own" open><summary>Workspace streams <span>{visibleOwnCount}</span></summary>{ownStreams.map(source => {
            const active = fm.fmSource === source.value;
            return <div className={`radio-station${active ? " current" : ""}${active && player.playing ? " playing" : ""}`} key={source.value}>
              <button type="button" className="radio-own-station radio-station-pick" aria-current={active || undefined} aria-label={`${active && player.armed ? "Pause" : "Play"} ${source.name}`} onClick={() => pickBuiltIn(source.value)}><span className="radio-station-code radio-own-icon"><RadioIcon name={source.icon} /></span><span className="radio-station-copy"><strong>{source.name}</strong><span className="radio-station-meta"><span>{source.metadata}</span>{active && <span className="radio-row-state"> · {player.playing ? "Playing live" : player.armed ? player.buffering ? "Buffering…" : "Connecting…" : "Paused"}</span>}</span></span></button>
              <button type="button" className="icon-btn radio-row-play" aria-label={`${active && player.armed ? "Pause" : "Play"} ${source.name} stream`} onClick={() => pickBuiltIn(source.value)}><RadioIcon name={active && player.armed ? "pause" : "play"} /></button>
              <button type="button" className="icon-btn radio-favorite" aria-pressed={library.favorites.includes(source.id)} aria-label={`${library.favorites.includes(source.id) ? "Unsave" : "Save"} ${source.name}`} onClick={() => library.toggleFavorite(source.id)}><RadioIcon name="heart" /></button>
            </div>;
          })}</details>}
          {!enabled && <p className="radio-empty" role="status">{disabledReason}</p>}
          {enabled && collection === "discover" && error && <div className="radio-directory-error" role="status"><strong>Directory unavailable</strong><p>{stations.length ? "The saved catalogue is still available." : "Try your favorites or workspace streams."}</p><button type="button" className="btn" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
          {enabled && loading && collection === "discover" && !stations.length && <RadioLoading />}
          {enabled && today && collection === "discover" && !hasFilters && <button type="button" className="radio-daily" aria-label={`${today.id === current?.id && player.armed ? "Pause" : fm.unavailableFmStations.has(today.id) ? "Retry" : "Play"} today’s station: ${today.name}${today.radio.country ? `, ${today.radio.country}` : ""}`} onClick={() => pick(today)}><span className="radio-daily-label">Today’s station</span><strong>{today.name}</strong>{today.radio.country && <span className="radio-daily-country">{today.radio.country}</span>}<RadioIcon name={today.id === current?.id && player.armed ? "pause" : "play"} /></button>}
          {enabled && stations.map(station => {
            const active = current?.id === station.id, audible = active && player.playing, unavailable = fm.unavailableFmStations.has(station.id);
            return <div className={`radio-station${active ? " selected current" : ""}${audible ? " playing" : ""}`} key={station.id} data-station-id={station.id}>
              <button type="button" className="radio-station-pick" aria-label={`${active && player.armed ? "Pause" : unavailable ? "Retry" : "Play"} ${station.name}, ${station.radio.country}`} aria-pressed={active && player.armed} onClick={() => pick(station)}><span className="radio-station-code" aria-hidden="true"><RadioCountryFlag code={station.radio.countryCode} /></span><span className="radio-station-copy"><strong title={station.name}>{station.name}</strong><span className="radio-station-meta"><span>{unavailable ? "Stream unavailable · retry" : stationMetadata(station) || "No station details"}</span>{active && !unavailable && <span className="radio-row-state"> · {audible ? "Playing live" : player.armed ? player.buffering ? "Buffering…" : "Connecting…" : "Paused"}</span>}</span></span></button>
              <button type="button" className="icon-btn radio-row-play" aria-label={`${active && player.armed ? "Pause" : unavailable ? "Retry" : "Play"} ${station.name}, ${station.radio.country}`} onClick={() => pick(station)}><RadioIcon name={active && player.armed ? "pause" : "play"} /></button>
              <button type="button" className="icon-btn radio-favorite" aria-pressed={library.favorites.includes(station.id)} aria-label={`${library.favorites.includes(station.id) ? "Unsave" : "Save"} ${station.name}`} onClick={() => toggleFavorite(station)}><RadioIcon name="heart" /></button>
            </div>;
          })}
          {enabled && !stations.length && !visibleOwnCount && !(loading && collection === "discover") && <div className="radio-empty"><RadioIcon name={collection === "favorites" ? "heart" : "search"} /><strong>{collection === "favorites" ? hasFilters ? "No favorites match" : "Keep your favorite frequencies" : collection === "recent" ? hasFilters ? "No recent stations match" : "Your listening trail starts here" : "No stations match"}</strong><p>{hasFilters ? "Try a different name or clear the filters." : collection === "favorites" ? "Save a station with the heart to find it here." : collection === "recent" ? "Stations you play will appear here." : "Choose a different country, sound or language."}</p>{hasFilters && <button type="button" className="btn" onClick={resetFilters}>Clear filters</button>}</div>}
        </div>
      </section>
    </div>
  </div>;
}
