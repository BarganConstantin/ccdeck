import { memo, useEffect, useRef, useState, type PointerEvent } from "react";
import world from "../assets/radio-world.json";
import type { RadioStation } from "../radio-library";

const regions = [
  { name: "World", x: 180, y: 82, zoom: 1 },
  { name: "Europe", x: 195, y: 40, zoom: 3 },
  { name: "Americas", x: 95, y: 65, zoom: 2 },
  { name: "Asia", x: 280, y: 60, zoom: 2 },
  { name: "Africa", x: 200, y: 90, zoom: 2.4 },
  { name: "Oceania", x: 315, y: 115, zoom: 3 },
];
function clampView(x: number, y: number, zoom: number) {
  return { x: Math.max(180 / zoom, Math.min(360 - 180 / zoom, x)), y: Math.max(85 / zoom, Math.min(170 - 85 / zoom, y)), zoom };
}

const RadioMap = memo(function RadioMap({ stations, selected, onPick }: {
  stations: RadioStation[];
  selected?: RadioStation;
  onPick: (station: RadioStation) => void;
}) {
  const [view, setView] = useState({ x: 180, y: 85, zoom: 1 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; view: typeof view } | null>(null);
  const mapped = stations.filter(station => station.radio.lat !== null && station.radio.lon !== null);
  useEffect(() => {
    if (selected?.radio.lat == null || selected.radio.lon == null) return;
    setView(clampView(selected.radio.lon + 180, 90 - selected.radio.lat, 3));
  }, [selected?.id, selected?.radio.lat, selected?.radio.lon]);
  const zoom = (amount: number) => setView(current => clampView(current.x, current.y, Math.max(1, Math.min(6, current.zoom * amount))));
  const move = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = 360 / rect.width / drag.current.view.zoom;
    setView(clampView(drag.current.view.x - (event.clientX - drag.current.x) * scale, drag.current.view.y - (event.clientY - drag.current.y) * scale, drag.current.view.zoom));
  };
  const stop = () => { drag.current = null; setDragging(false); };
  return <div className="radio-map">
    <div className="radio-regions" role="group" aria-label="Explore a region">
      {regions.map(region => <button key={region.name} type="button" onClick={() => setView(clampView(region.x, region.y, region.zoom))}>{region.name}</button>)}
    </div>
    <svg className="radio-map-canvas" data-dragging={dragging || undefined} viewBox={`${view.x - 180 / view.zoom} ${view.y - 85 / view.zoom} ${360 / view.zoom} ${170 / view.zoom}`} aria-label="World map of radio stations. Select a station in the list to play it."
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, view }; setDragging(true);
      }} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}>
      <g className="radio-land" aria-hidden="true">{world.map((country, index) => <path key={`${country.code}-${index}`} d={country.path} vectorEffect="non-scaling-stroke" />)}</g>
      <g>{mapped.map(station => <g key={station.id} className={`radio-pin${selected?.id === station.id ? " selected" : ""}`} role="button" tabIndex={-1}
        aria-label={`Play ${station.name}, ${station.radio.country}`} transform={`translate(${station.radio.lon! + 180} ${90 - station.radio.lat!})`}
        onPointerDown={event => event.stopPropagation()} onClick={() => onPick(station)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick(station); } }}>
        <title>{station.name} · {station.radio.country}</title>
        <circle className="radio-pin-hit" r={6 / view.zoom} /><circle r={(selected?.id === station.id ? 2.6 : 1.7) / view.zoom} />
      </g>)}</g>
    </svg>
    <div className="radio-map-tools" role="group" aria-label="Map zoom">
      <button className="btn" type="button" aria-label="Zoom map in" onClick={() => zoom(1.5)} disabled={view.zoom >= 6}>+</button>
      <button className="btn" type="button" aria-label="Zoom map out" onClick={() => zoom(1 / 1.5)} disabled={view.zoom <= 1}>−</button>
    </div>
    <div className="radio-map-caption">{mapped.length ? `${mapped.length} stations on the map` : "Stations with a location appear here"}<a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a></div>
  </div>;
});

export default RadioMap;
