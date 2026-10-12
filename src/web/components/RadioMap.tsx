import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import world from "../assets/radio-world.json";
import type { RadioStation } from "../radio-library";
import { clampMapView, clusterRadioMarkers, mapDimensions, MAX_RADIO_ZOOM, WORLD_VIEW, zoomMapView, type RadioMapView } from "../radio-map-geometry";
import RadioIcon from "./RadioIcon";

const regions = [
  { name: "World", ...WORLD_VIEW }, { name: "Europe", x: 195, y: 40, zoom: 3.5 },
  { name: "Americas", x: 95, y: 65, zoom: 2 }, { name: "Asia", x: 280, y: 60, zoom: 2 },
  { name: "Africa", x: 200, y: 90, zoom: 2.4 }, { name: "Oceania", x: 315, y: 115, zoom: 3 },
];
const land = <g className="radio-land" aria-hidden="true">{world.map((country, index) => <path key={`${country.code}-${index}`} d={country.path} vectorEffect="non-scaling-stroke" />)}</g>;

const RadioMap = memo(function RadioMap({ stations, selected, current, playing, onInspect, locateRequest, children }: {
  stations: RadioStation[];
  selected?: RadioStation;
  current?: RadioStation;
  playing: boolean;
  onInspect: (station: RadioStation) => void;
  locateRequest: number;
  children?: ReactNode;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [rect, setRect] = useState({ width: 600, height: 430 });
  const size = useMemo(() => mapDimensions(rect.width / rect.height), [rect.width, rect.height]);
  const [view, setView] = useState(WORLD_VIEW);
  const camera = useRef(view);
  const sizeRef = useRef(size); sizeRef.current = size;
  const frame = useRef(0);
  const [region, setRegion] = useState("World");
  const [dragging, setDragging] = useState(false);
  const [cluster, setCluster] = useState<RadioStation[] | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; distance: number; view: RadioMapView } | null>(null);
  const moveCamera = useCallback((next: RadioMapView, animate = false) => {
    cancelAnimationFrame(frame.current);
    const target = clampMapView(next, sizeRef.current);
    const start = camera.current;
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { camera.current = target; setView(target); return; }
    const at = performance.now();
    const tick = (time: number) => {
      const progress = Math.min(1, (time - at) / 180), ease = 1 - (1 - progress) ** 3;
      const value = { x: start.x + (target.x - start.x) * ease, y: start.y + (target.y - start.y) * ease, zoom: start.zoom + (target.zoom - start.zoom) * ease };
      camera.current = value; setView(value);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width && entry.contentRect.height) setRect({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => moveCamera(camera.current), [size, moveCamera]);
  useEffect(() => {
    if (!locateRequest || selected?.radio.lat == null || selected.radio.lon == null) return;
    setRegion(""); setCluster(null);
    moveCamera({ x: selected.radio.lon + 180, y: 90 - selected.radio.lat, zoom: 5 }, true);
    // Location is an explicit action, rather than a camera jump on every selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateRequest, moveCamera]);
  const changeZoom = useCallback((factor: number) => { setRegion(""); setCluster(null); moveCamera(zoomMapView(camera.current, factor, sizeRef.current), true); }, [moveCamera]);
  const pointAt = (x: number, y: number) => {
    const box = svg.current!.getBoundingClientRect(), active = camera.current;
    return { x: active.x + (x - box.left - box.width / 2) * sizeRef.current.width / active.zoom / box.width, y: active.y + (y - box.top - box.height / 2) * sizeRef.current.height / active.zoom / box.height };
  };
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault(); setRegion(""); setCluster(null);
      const box = element.getBoundingClientRect(), active = camera.current, dimensions = sizeRef.current;
      const point = { x: active.x + (event.clientX - box.left - box.width / 2) * dimensions.width / active.zoom / box.width, y: active.y + (event.clientY - box.top - box.height / 2) * dimensions.height / active.zoom / box.height };
      moveCamera(zoomMapView(active, Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .005), dimensions, point));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [moveCamera]);
  const mapped = useMemo(() => stations.filter(station => station.radio.lat !== null && station.radio.lon !== null), [stations]);
  const displayed = useMemo(() => [...new Map([...mapped, ...(current?.radio.lat != null && current.radio.lon != null ? [current] : []), ...(selected?.radio.lat != null && selected.radio.lon != null ? [selected] : [])].map(station => [station.id, station])).values()], [mapped, current, selected]);
  const scale = rect.width * view.zoom / size.width;
  const markers = useMemo(() => clusterRadioMarkers(displayed, scale, [selected?.id ?? "", current?.id ?? ""]), [displayed, scale, selected?.id, current?.id]);
  const pinnedCount = displayed.length - mapped.length;
  const metrics = () => {
    const points = [...pointers.current.values()];
    return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length, distance: points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0 };
  };
  const stop = (event: PointerEvent<SVGSVGElement>) => { pointers.current.delete(event.pointerId); gesture.current = pointers.current.size ? { ...metrics(), view: camera.current } : null; setDragging(pointers.current.size > 0); };
  return <section className="radio-geography" aria-label="Geographic explorer">
    <div className="radio-map-heading"><div><span className="radio-eyebrow">Explore the world</span><h3>{region || "Your view"}</h3></div><span title="Only results with directory coordinates can be plotted. Selected and current stations stay pinned when filters exclude them.">{mapped.length} of {stations.length} on map{pinnedCount > 0 && <small>+ {pinnedCount} pinned outside results</small>}</span></div>
    <div className="radio-regions" role="group" aria-label="Explore a region">
      {regions.map(place => <button key={place.name} type="button" aria-pressed={region === place.name} onClick={() => { setRegion(place.name); setCluster(null); moveCamera(place, true); }}>{place.name}</button>)}
    </div>
    <div className="radio-map">
      <svg ref={svg} className="radio-map-canvas" data-dragging={dragging || undefined} viewBox={`${view.x - size.width / view.zoom / 2} ${view.y - size.height / view.zoom / 2} ${size.width / view.zoom} ${size.height / view.zoom}`} role="group" tabIndex={0} aria-label="Radio map" aria-describedby="radio-map-help"
        onKeyDown={event => {
          if (event.key === "+" || event.key === "=") { event.preventDefault(); changeZoom(1.5); }
          else if (event.key === "-") { event.preventDefault(); changeZoom(1 / 1.5); }
          else if (event.key === "Home") { event.preventDefault(); setRegion("World"); moveCamera(WORLD_VIEW, true); }
          else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault(); setRegion(""); const active = camera.current;
            moveCamera({ ...active, x: active.x + (event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0) * 18 / active.zoom, y: active.y + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0) * 18 / active.zoom }, true);
          }
        }}
        onDoubleClick={event => { setRegion(""); moveCamera(zoomMapView(camera.current, 2, sizeRef.current, pointAt(event.clientX, event.clientY)), true); }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          cancelAnimationFrame(frame.current); event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); gesture.current = { ...metrics(), view: camera.current }; setDragging(true); setRegion(""); setCluster(null);
        }} onPointerMove={event => {
          if (!pointers.current.has(event.pointerId) || !gesture.current) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          const start = gesture.current, next = metrics(), unit = size.width / rect.width / start.view.zoom;
          moveCamera({ x: start.view.x - (next.x - start.x) * unit, y: start.view.y - (next.y - start.y) * unit, zoom: start.distance && next.distance ? start.view.zoom * next.distance / start.distance : start.view.zoom });
        }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}>
        {land}
        <g>{markers.map(marker => {
          const grouped = marker.stations.length > 1, station = marker.stations[0], active = marker.stations.some(item => selected?.id === item.id), audible = playing && marker.stations.some(item => current?.id === item.id);
          return <g key={marker.id} className={`radio-pin${grouped ? " clustered" : ""}${active ? " selected" : ""}${audible ? " playing" : ""}`} role="button" tabIndex={-1}
            aria-label={grouped ? `Explore ${marker.stations.length} nearby stations` : `Inspect ${station.name}, ${station.radio.country}`} transform={`translate(${marker.x} ${marker.y})`}
            onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={() => {
              if (!grouped) { setCluster(null); onInspect(station); return; }
              setCluster(marker.stations); setRegion(""); moveCamera({ x: marker.x, y: marker.y, zoom: Math.min(MAX_RADIO_ZOOM, camera.current.zoom * 2) }, true);
            }}>
            <title>{grouped ? `${marker.stations.length} nearby stations · click to explore` : `${station.name} · ${station.radio.country}`}</title>
            <circle className="radio-pin-hit" r={14 / scale} />
            {audible && <circle className="radio-pin-playing" r={(grouped ? 14 : 8) / scale} />}
            <circle className="radio-pin-dot" r={(grouped ? 11 : active ? 5 : 3.2) / scale} />
            {grouped && <text textAnchor="middle" dominantBaseline="central" fontSize={10 / scale}>{marker.stations.length}</text>}
          </g>;
        })}</g>
      </svg>
      <div className="radio-map-tools" role="group" aria-label="Map zoom"><button className="btn" type="button" aria-label="Zoom map in" onClick={() => changeZoom(1.5)} disabled={view.zoom >= MAX_RADIO_ZOOM}>+</button><button className="btn" type="button" aria-label="Zoom map out" onClick={() => changeZoom(1 / 1.5)} disabled={view.zoom <= 1}>−</button></div>
      {cluster && <div className="radio-cluster-preview"><header><strong>{cluster.length} nearby stations</strong><button type="button" className="icon-btn" aria-label="Close nearby stations" onClick={() => { setCluster(null); svg.current?.focus(); }}><RadioIcon name="close" /></button></header><div>{cluster.map(station => <button key={station.id} type="button" onClick={() => { setCluster(null); onInspect(station); }}>{station.name}<span>{station.radio.country}</span></button>)}</div></div>}
      {!cluster && children}
      <div className="radio-map-caption"><span title="Positions come from the station directory and may be approximate. Stations without coordinates are available in the list.">Directory locations · approximate</span><a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a></div>
    </div>
    <p id="radio-map-help" className="radio-map-help">Drag to explore · scroll or double-click to zoom. <span className="vis-hidden">With the map focused, arrow keys pan, plus and minus zoom, and Home resets the view. Use the station list as a keyboard alternative.</span></p>
  </section>;
});
export default RadioMap;
