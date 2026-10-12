import type { RadioStation } from "./radio-library";

export interface RadioMapView { x: number; y: number; zoom: number }
export interface MapDimensions { width: number; height: number }
export interface RadioMarker { id: string; x: number; y: number; stations: RadioStation[] }
export const MAX_RADIO_ZOOM = 12;
export const WORLD_VIEW: RadioMapView = { x: 180, y: 85, zoom: 1 };

export function mapDimensions(aspect: number): MapDimensions {
  const ratio = Math.max(.5, Math.min(4, aspect || 2));
  return { width: Math.max(360, 170 * ratio), height: Math.max(170, 360 / ratio) };
}
export function clampMapView(view: RadioMapView, size: MapDimensions): RadioMapView {
  const zoom = Math.max(1, Math.min(MAX_RADIO_ZOOM, view.zoom));
  const bound = (position: number, extent: number, half: number) => half >= extent / 2 ? extent / 2 : Math.max(half, Math.min(extent - half, position));
  return { x: bound(view.x, 360, size.width / zoom / 2), y: bound(view.y, 170, size.height / zoom / 2), zoom };
}
export function zoomMapView(view: RadioMapView, factor: number, size: MapDimensions, point = { x: view.x, y: view.y }): RadioMapView {
  const zoom = Math.max(1, Math.min(MAX_RADIO_ZOOM, view.zoom * factor));
  return clampMapView({ x: point.x - (point.x - view.x) * view.zoom / zoom, y: point.y - (point.y - view.y) * view.zoom / zoom, zoom }, size);
}

/** Group nearby directory coordinates by screen distance. Isolated selected/
 * current stations stay separate; coincident pins stay reachable in a chooser. */
export function clusterRadioMarkers(stations: readonly RadioStation[], pixelsPerUnit: number, independent: readonly string[] = []): RadioMarker[] {
  const threshold = 26 / Math.max(.01, pixelsPerUnit);
  const protectedIds = new Set(independent);
  const points = stations.filter(station => station.radio.lat !== null && station.radio.lon !== null)
    .map(station => ({ station, x: station.radio.lon! + 180, y: 90 - station.radio.lat! }));
  // A protected pin must not cover a cluster at the same screen position.
  for (const point of points) {
    if (protectedIds.has(point.station.id) && points.some(other => other !== point && Math.hypot(point.x - other.x, point.y - other.y) < threshold)) protectedIds.delete(point.station.id);
  }
  const parent = points.map((_, index) => index);
  const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]));
  const grid = new Map<string, number[]>();
  points.forEach((point, index) => {
    if (protectedIds.has(point.station.id)) return;
    const gx = Math.floor(point.x / threshold), gy = Math.floor(point.y / threshold);
    for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
      for (const other of grid.get(`${x}:${y}`) ?? []) {
        if (Math.hypot(point.x - points[other].x, point.y - points[other].y) < threshold) parent[root(index)] = root(other);
      }
    }
    const key = `${gx}:${gy}`;
    grid.set(key, [...(grid.get(key) ?? []), index]);
  });
  const groups = new Map<number, typeof points>();
  points.forEach((point, index) => { const key = root(index); groups.set(key, [...(groups.get(key) ?? []), point]); });
  return [...groups.values()].map(group => ({ id: group.map(point => point.station.id).sort().join("|"), x: group.reduce((sum, point) => sum + point.x, 0) / group.length, y: group.reduce((sum, point) => sum + point.y, 0) / group.length, stations: group.map(point => point.station) }))
    .sort((a, b) => Number(a.stations.some(station => protectedIds.has(station.id))) - Number(b.stations.some(station => protectedIds.has(station.id))));
}
