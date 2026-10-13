import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FM_VOLUME_STEP } from "../appearance";
import { customFmId, type FmSelection } from "../fm-stations";
import { adjacentRadioStation, dailyStation, matchesRadio, resolveRadioStations, surpriseStation, type RadioStation } from "../radio-library";
import type { useClaudeFm } from "../use-claude-fm";
import type { FmPlayer } from "../use-fm-player";
import type { useRadioLibrary } from "../use-radio-library";
import { containPopoverKeys } from "../shortcuts";
import world from "../assets/radio-world.json";
import RadioIcon from "./RadioIcon";
import RadioCountryFlag from "./RadioCountryFlag";
import RadioMap from "./RadioMap";
import RadioLoading from "./RadioLoading";
import RadioDiscoveryToolbar from "./RadioDiscoveryToolbar";
import { workspaceStreams, filterWorkspaceStreams, discoverySummary, type RadioCollection } from "../radio-discovery";
import VolumeRow from "./VolumeRow";
import { useModalDismiss } from "./use-modal-dismiss";

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
  const scrollPositions = useRef<Record<RadioCollection, number>>({ discover: 0, favorites: 0, recent: 0 });
  const workspaceRef = useRef<HTMLElement>(null);
  const revealRequested = useRef(false);
  const radioScroll = useRef(0);
  const [workspaceOpen, setWorkspaceOpen] = useState<Record<RadioCollection, boolean>>({ discover: false, favorites: true, recent: true });
  const [searchExpansion, setSearchExpansion] = useState<boolean | null>(null);
  const [keyboardOpened] = useState(() => document.activeElement?.matches(":focus-visible") ?? false);
  const panel = useModalDismiss<HTMLDivElement>(onClose, { focusRef: searchRef });
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("");
  const [genre, setGenre] = useState("");
  const [language, setLanguage] = useState("");
  const [collection, setCollection] = useState<RadioCollection>("discover");
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
    if (country === "GLOBAL") { setResults([]); setLoading(false); setError(false); return; }
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
    const rows = collection === "discover" ? results.map(station => pool.get(station.id) ?? station) : ids.flatMap(id => pool.get(id) ?? []);
    return rows.filter(station => matchesRadio(station, query, country, genre, language));
  }, [collection, library.catalogue, library.favorites, library.recent, results, saved, query, country, genre, language]);
  useEffect(() => { onQueueChange(stations); }, [stations, onQueueChange]);
  const previousStation = adjacentRadioStation(stations, current?.id, -1);
  const nextStation = adjacentRadioStation(stations, current?.id, 1);
  const navigating = !enabled || (collection === "discover" && loading);
  const day = new Date().toLocaleDateString("en-CA");
  const today = useMemo(() => {
    const station = dailyStation(library.catalogue, day);
    return station ? { ...station, name: saved.find(savedStation => savedStation.id === station.id)?.name ?? station.name } : null;
  }, [library.catalogue, day, saved]);
  const hasFilters = !!(query || country || genre || language);
  const currentId = current?.id ?? customFmId(fm.fmSource) ?? fm.fmSource;
  const currentFavorite = library.favorites.includes(currentId);
  const showFailure = player.dead && (!!current || fm.fmPlayRequest > 0);
  const todayActive = today?.id === current?.id;
  const todayUnavailable = !!today && (fm.unavailableFmStations.has(today.id) || (todayActive && showFailure));
  const state = !enabled ? "disabled" : showFailure ? "failed" : player.armed && !player.playing ? "connecting" : player.playing ? "playing" : "paused";
  const status = !enabled ? disabledReason : showFailure ? autoNext ? `Stream unavailable · trying ${autoNext} next…` : "Stream unavailable · retry or choose another" : player.dead ? "Choose a station to start listening" : player.armed && !player.playing ? player.buffering ? "Buffering…" : "Connecting…" : player.playing ? "Playing live" : "Paused";
  const resetFilters = () => { setCountry(""); setGenre(""); setLanguage(""); };
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
  const allStreams = useMemo(() => workspaceStreams(fm.customFmStations), [fm.customFmStations]);
  const ownStreams = useMemo(() => filterWorkspaceStreams(allStreams, query, { country, genre, language }, collection, collection === "favorites" ? library.favorites : library.recent), [allStreams, query, country, genre, language, collection, library.favorites, library.recent]);
  const visibleOwnCount = ownStreams.length;
  const knownIds = new Set([...allStreams.map(stream => stream.id), ...saved.map(station => station.id), ...library.catalogue.map(station => station.id), ...results.map(station => station.id)]);
  const favoriteCount = library.favorites.filter(id => knownIds.has(id)).length;
  const metadata = [...library.catalogue, ...results, ...saved];
  const genreOptions = [...new Set(metadata.flatMap(station => station.radio.tags.split(",")).map(value => value.trim().toLowerCase()).filter(Boolean))].sort().map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));
  const languageOptions = [...new Set(metadata.flatMap(station => station.radio.language.split(",")).map(value => value.trim().toLowerCase()).filter(Boolean))].sort().map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));
  const changeCollection = (next: RadioCollection) => {
    scrollPositions.current[collection] = listRef.current?.scrollTop ?? 0;
    setCollection(next);
  };
  useLayoutEffect(() => { if (listRef.current) listRef.current.scrollTop = scrollPositions.current[collection]; }, [collection]);
  useEffect(() => {
    scrollPositions.current = { discover: 0, favorites: 0, recent: 0 };
    if (listRef.current) listRef.current.scrollTop = 0;
    setSearchExpansion(null);
  }, [query, country, genre, language]);
  const streamSearchScope = !!query || country === "GLOBAL" || (!stations.length && !loading);
  const streamsExpanded = searchExpansion ?? (streamSearchScope ? visibleOwnCount > 0 : workspaceOpen[collection]);
  const toggleWorkspace = () => {
    const next = !streamsExpanded;
    if (next) { radioScroll.current = listRef.current?.scrollTop ?? 0; revealRequested.current = true; }
    else if (listRef.current) listRef.current.scrollTop = radioScroll.current;
    if (streamSearchScope) setSearchExpansion(next);
    else setWorkspaceOpen(previous => ({ ...previous, [collection]: next }));
  };
  useLayoutEffect(() => {
    if (streamsExpanded && revealRequested.current && workspaceRef.current) {
      revealRequested.current = false;
      workspaceRef.current.scrollIntoView({ block: "start", behavior: "instant" });
      const activeRow = workspaceRef.current.querySelector<HTMLElement>(`[data-stream-id="${CSS.escape(currentId)}"]`);
      activeRow?.scrollIntoView({ block: "nearest", behavior: "instant" });
      if (panel.current?.dataset.keyboardInteraction) (activeRow ?? workspaceRef.current).querySelector<HTMLButtonElement>(".radio-station-pick")?.focus({ preventScroll: true });
    }
  }, [streamsExpanded, visibleOwnCount]);
  const hasMetadataFilters = !!(country || genre || language);
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
        <button className="icon-btn radio-favorite" type="button" aria-label={currentFavorite ? "Remove station from favorites" : "Save station to favorites"} aria-pressed={!!currentFavorite} onClick={() => current ? toggleFavorite(current) : library.toggleFavorite(currentId)}><RadioIcon name="heart" /></button>
      </div>
      <div className="radio-controls"><VolumeRow id="radio-volume" step={FM_VOLUME_STEP} value={fm.fmVolume} onLevel={fm.setFmVolume} /><button type="button" className="btn radio-player-button radio-mute" aria-pressed={fm.fmMuted} onClick={() => fm.setFmMuted(muted => !muted)} title={fm.fmMuted ? "Unmute radio" : "Mute radio"}><RadioIcon name={fm.fmMuted ? "muted" : "volume"} />{fm.fmMuted ? "Unmute" : "Mute"}</button><button type="button" className="btn radio-player-button" disabled={!enabled || !stations.some(station => station.id !== current?.id)} onClick={() => { const station = surpriseStation(stations, current?.id); if (station) pick(station); }}><RadioIcon name="shuffle" /> Surprise me</button></div>
    </div>
    <div className="radio-mobile-view" role="group" aria-label="Explorer view"><button type="button" className="radio-view" aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}><RadioIcon name="globe" />Map</button><button type="button" className="radio-view" aria-pressed={mobileView === "stations"} onClick={() => setMobileView("stations")}><RadioIcon name="search" />Stations</button></div>
    <div className="radio-workspace" data-view={mobileView}>
      <RadioMap stations={enabled ? stations : []} selected={current} current={current} playing={player.playing} onPick={pick} />
      <section className="radio-discovery" aria-label="Station discovery">
        <RadioDiscoveryToolbar collection={collection} favoriteCount={favoriteCount} onCollectionChange={changeCollection} query={query} onQueryChange={setQuery} searchRef={searchRef}
          filters={{ country, genre, language }} onFilterChange={(name, value) => { if (name === "country") setCountry(value); else if (name === "genre") setGenre(value); else setLanguage(value); }}
          countryOptions={[{ value: "", label: "All countries" }, { value: "GLOBAL", label: "Global streams" }, ...countries.map(([value, label]) => ({ value, label }))]}
          genreOptions={[{ value: "", label: "All genres & topics" }, ...genreOptions]}
          languageOptions={[{ value: "", label: "Any language" }, ...languageOptions]} />
        <div className="radio-results-heading vis-hidden" role="status" aria-live="polite" aria-atomic="true"><span>{enabled ? discoverySummary(stations.length, visibleOwnCount) : disabledReason}</span>{loading && collection === "discover" && <span>Updating…</span>}</div>
        <div ref={listRef} id="radio-station-results" className="radio-list" role="tabpanel" aria-labelledby={`radio-tab-${collection}`} tabIndex={0} aria-busy={loading && collection === "discover"}>
          {!enabled && <p className="radio-empty" role="status">{disabledReason}</p>}
          {enabled && (stations.length > 0 || (collection === "discover" && (loading || error))) && <section aria-labelledby="radio-directory-heading">
            <div className="radio-source-heading"><RadioIcon name="radio" /><h3 id="radio-directory-heading">Radio stations</h3><span>{loading && collection === "discover" ? "Updating…" : `${stations.length} available`}</span></div>
            <p className="radio-source-help">Radio Browser · {stations.filter(station => station.radio.lat != null && station.radio.lon != null).length} of {stations.length} have map locations</p>
          {enabled && collection === "discover" && error && <div className="radio-directory-error" role="status"><strong>Directory unavailable</strong><p>{stations.length ? "The saved catalogue is still available." : "Try your favorites or workspace streams."}</p><button type="button" className="btn" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
          {enabled && loading && collection === "discover" && !stations.length && <RadioLoading />}
          {enabled && today && collection === "discover" && !hasFilters && <button type="button" className="radio-daily" aria-current={todayActive || undefined} aria-pressed={todayActive && player.armed && !todayUnavailable} aria-label={`${todayUnavailable ? "Retry" : todayActive && player.armed ? "Pause" : "Play"} today’s station: ${today.name}${today.radio.country ? `, ${today.radio.country}` : ""}`} onClick={() => pick(today)}><span className="radio-station-code" aria-hidden="true"><RadioCountryFlag code={today.radio.countryCode} /></span><span className="radio-daily-copy"><strong title={today.name}>{today.name}</strong><span className="radio-daily-meta">Today’s station{today.radio.country && <> · {today.radio.country}</>}</span></span><RadioIcon name={todayActive && player.armed && !todayUnavailable ? "pause" : "play"} /></button>}
          {enabled && stations.map(station => {
            const active = current?.id === station.id, audible = active && player.playing, unavailable = fm.unavailableFmStations.has(station.id) || (active && showFailure);
            return <div className={`radio-station${active ? " selected current" : ""}${audible ? " playing" : ""}`} key={station.id} data-station-id={station.id}>
              <button type="button" className="radio-station-pick" aria-current={active || undefined} aria-label={`${unavailable ? "Retry" : active && player.armed ? "Pause" : "Play"} ${station.name}, ${station.radio.country}`} aria-pressed={active && player.armed && !unavailable} onClick={() => pick(station)}><span className="radio-station-code" aria-hidden="true"><RadioCountryFlag code={station.radio.countryCode} /></span><span className="radio-station-copy"><strong title={station.name}>{station.name}</strong><span className="radio-station-meta"><span>{unavailable ? "Stream unavailable · retry" : stationMetadata(station) || "No station details"}</span>{active && !unavailable && <span className="radio-row-state"> · {audible ? "Playing live" : player.armed ? player.buffering ? "Buffering…" : "Connecting…" : "Paused"}</span>}</span></span></button>
              <button type="button" className="icon-btn radio-row-play" aria-label={`${unavailable ? "Retry" : active && player.armed ? "Pause" : "Play"} ${station.name}, ${station.radio.country}`} onClick={() => pick(station)}><RadioIcon name={active && player.armed && !unavailable ? "pause" : "play"} /></button>
              <button type="button" className="icon-btn radio-favorite" aria-pressed={library.favorites.includes(station.id)} aria-label={`${library.favorites.includes(station.id) ? "Unsave" : "Save"} ${station.name}`} onClick={() => toggleFavorite(station)}><RadioIcon name="heart" /></button>
            </div>;
          })}
          </section>}
          {enabled && allStreams.length > 0 && <section ref={workspaceRef} id="radio-workspace-streams" className="radio-own" hidden={!streamsExpanded} aria-labelledby="radio-streams-heading"><div className="radio-source-heading"><RadioIcon name="headphones" /><h3 id="radio-streams-heading">Workspace streams</h3><span>{visibleOwnCount}</span></div><p className="radio-source-help">YouTube and custom streams · not on the map</p>{visibleOwnCount === 0 && <div className="radio-empty"><strong>{hasFilters ? "No workspace streams match" : collection === "favorites" ? "No saved workspace streams" : "No recent workspace streams"}</strong><p>{hasFilters ? "Clear search and filters to browse workspace streams." : "Play or save a workspace stream to find it here."}</p><button type="button" className="btn" onClick={() => {
              setQuery(""); resetFilters(); setSearchExpansion(null);
              if (collection !== "discover") changeCollection("discover");
              setWorkspaceOpen(previous => ({ ...previous, discover: true, [collection]: true }));
              revealRequested.current = true;
              requestAnimationFrame(() => (workspaceRef.current?.querySelector<HTMLButtonElement>(`[data-stream-id="${CSS.escape(currentId)}"] .radio-station-pick`) ?? workspaceRef.current?.querySelector<HTMLButtonElement>(".radio-station-pick"))?.focus({ preventScroll: true }));
            }}>{collection === "discover" ? "Show all streams" : "Browse workspace streams"}</button></div>}{ownStreams.map(source => {
            const active = fm.fmSource === source.selection, unavailable = active && showFailure;
            return <div className={`radio-station${active ? " current" : ""}${active && player.playing ? " playing" : ""}`} key={source.selection} data-stream-id={source.id}>
              <button type="button" className="radio-own-station radio-station-pick" aria-current={active || undefined} aria-label={`${unavailable ? "Retry" : active && player.armed ? "Pause" : "Play"} ${source.name}`} onClick={() => pickBuiltIn(source.selection)}><span className="radio-station-code radio-own-icon"><RadioIcon name={source.icon} /></span><span className="radio-station-copy"><strong>{source.name}</strong><span className="radio-station-meta"><span>{unavailable ? "Stream unavailable · retry" : source.metadata}</span>{active && !unavailable && <span className="radio-row-state"> · {player.playing ? "Playing live" : player.armed ? player.buffering ? "Buffering…" : "Connecting…" : "Paused"}</span>}</span></span></button>
              <button type="button" className="icon-btn radio-row-play" aria-label={`${unavailable ? "Retry" : active && player.armed ? "Pause" : "Play"} ${source.name} stream`} onClick={() => pickBuiltIn(source.selection)}><RadioIcon name={active && player.armed && !unavailable ? "pause" : "play"} /></button>
              <button type="button" className="icon-btn radio-favorite" aria-pressed={library.favorites.includes(source.id)} aria-label={`${library.favorites.includes(source.id) ? "Unsave" : "Save"} ${source.name}`} onClick={() => library.toggleFavorite(source.id)}><RadioIcon name="heart" /></button>
            </div>;
          })}</section>}
          {enabled && !stations.length && !visibleOwnCount && !streamsExpanded && !((loading || error) && collection === "discover") && <div className="radio-empty"><RadioIcon name={collection === "favorites" ? "heart" : "search"} /><strong>{collection === "favorites" ? hasFilters ? "No favorites match" : "Keep your favorite frequencies" : collection === "recent" ? hasFilters ? "No recent stations match" : "Your listening trail starts here" : "No stations match"}</strong><p>{hasFilters ? "Try a different name or clear the filters." : collection === "favorites" ? "Save a station with the heart to find it here." : collection === "recent" ? "Stations you play will appear here." : "Search another name or change the filters."}</p>{hasMetadataFilters ? <button type="button" className="btn" onClick={resetFilters}>Clear filters</button> : query && <button type="button" className="btn" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>Clear search</button>}</div>}
        </div>
        {enabled && allStreams.length > 0 && <button type="button" className="radio-workspace-toggle" aria-expanded={streamsExpanded} aria-controls="radio-workspace-streams" onClick={toggleWorkspace}><RadioIcon name="headphones" /><span>Workspace streams</span><span className="radio-tab-count">{visibleOwnCount}</span>{hasFilters && visibleOwnCount === 0 ? <span className="radio-tab-count">Filtered</span> : !current && player.playing && <span className="radio-row-state">Playing</span>}<RadioIcon name="back" /></button>}
      </section>
    </div>
  </div>;
}
