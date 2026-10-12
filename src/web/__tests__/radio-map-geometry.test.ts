import { describe, expect, it } from "vitest";
import { clampMapView, clusterRadioMarkers, mapDimensions, MAX_RADIO_ZOOM, WORLD_VIEW, zoomMapView } from "../radio-map-geometry";
import { resolveRadioStations } from "../radio-library";
const station = (index: number, lon: number | null, lat: number | null) => resolveRadioStations([{ id: `radio-00000000-0000-0000-0000-${String(index).padStart(12, "0")}`, name: `Fixture ${index}`, url: "https://fixture.test/stream", country: "France", countryCode: "FR", lon, lat }])[0];
describe("radio map geometry", () => {
  it("groups markers that would have overlapping touch targets without enlarging desktop clusters", () => {
    const rows = [station(1, 0, 40), station(2, 38, 40)];
    expect(clusterRadioMarkers(rows, 1)).toHaveLength(2);
    expect(clusterRadioMarkers(rows, 1, [], 44)).toHaveLength(1);
  });
  it("fits the world on wide and tall maps without cropping geography", () => {
    for (const aspect of [.25, .8, 1.5, 3, 8]) {
      const size = mapDimensions(aspect);
      expect(size.width / size.height).toBeCloseTo(aspect);
      expect(size.width).toBeGreaterThanOrEqual(360); expect(size.height).toBeGreaterThanOrEqual(170);
      expect(clampMapView({ x: -999, y: 999, zoom: 1 }, size)).toEqual(WORLD_VIEW);
    }
  });
  it("bounds camera motion and zoom at both limits", () => {
    const size = mapDimensions(2);
    const view = clampMapView({ x: -1000, y: 1000, zoom: 100 }, size);
    expect(view.zoom).toBe(MAX_RADIO_ZOOM);
    expect(view.x).toBe(size.width / MAX_RADIO_ZOOM / 2);
    expect(view.y).toBe(170 - size.height / MAX_RADIO_ZOOM / 2);
    expect(clampMapView({ ...view, zoom: .1 }, size)).toEqual(WORLD_VIEW);
  });
  it("keeps the coordinate beneath the pointer anchored when zooming", () => {
    const size = mapDimensions(2), view = { x: 180, y: 85, zoom: 3 }, point = { x: 195, y: 75 };
    const next = zoomMapView(view, 2, size, point);
    expect((point.x - view.x) * view.zoom).toBeCloseTo((point.x - next.x) * next.zoom);
    expect((point.y - view.y) * view.zoom).toBeCloseTo((point.y - next.y) * next.zoom);
  });
  it("groups overlapping markers across grid boundaries and separates them at closer zoom", () => {
    const rows = [station(1, 1, 48), station(2, 2, 48), station(3, 90, 10)];
    expect(clusterRadioMarkers(rows, 1).map(group => group.stations.length)).toEqual([2, 1]);
    expect(clusterRadioMarkers(rows, 30)).toHaveLength(3);
    expect(clusterRadioMarkers([station(4, 25.9, 20), station(5, 26.1, 20)], 1)).toHaveLength(1);
  });
  it("keeps coincident selected and current stations in a reachable chooser at every zoom", () => {
    const rows = [station(1, 2, 48), station(2, 2, 48), station(3, 2, 48)];
    const markers = clusterRadioMarkers(rows, 1, [rows[0].id, rows[1].id]);
    expect(markers).toHaveLength(1);
    expect(markers[0].stations).toHaveLength(3);
    expect(clusterRadioMarkers(rows, 100, [rows[0].id, rows[1].id])).toHaveLength(1);
  });
  it("preserves zero coordinates, excludes missing coordinates, and never duplicates a station", () => {
    const markers = clusterRadioMarkers([station(1, 0, 0), station(2, null, 0)], 1);
    expect(markers).toHaveLength(1); expect(markers[0]).toMatchObject({ x: 180, y: 90 });
    expect(markers[0].stations).toHaveLength(1);
  });
});
