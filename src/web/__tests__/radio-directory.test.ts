import { describe, it, expect, vi } from "vitest";
// @ts-expect-error Server modules ship as JavaScript.
import { createRadioDirectory, normalizeRadioStation } from "../../server/radio-directory.mjs";
const uuid = "d1a54d2e-623e-4970-ab11-35f7b56c5ec3";
const row = { stationuuid: uuid, name: " Night radio ", url_resolved: "https://radio.example/listen", country: "Moldova", countrycode: "MD", geo_lat: 0, geo_long: 0, bitrate: 128 };
const discover = async () => [{ name: "test.api.radio-browser.info" }];

describe("radio directory", () => {
  it("preserves the directory HLS flag for extensionless streams without guessing formats", () => {
    expect(normalizeRadioStation({ ...row, hls: 1 })).toMatchObject({ url: row.url_resolved, hls: true });
    for (const hls of [0, undefined, "1"]) expect(normalizeRadioStation({ ...row, hls })).not.toHaveProperty("hls");
  });
  it("keeps extensionless HTTPS streams and zero coordinates, rejecting unsafe and invalid records", () => {
    expect(normalizeRadioStation(row)).toMatchObject({ id: `radio-${uuid}`, name: "Night radio", url: row.url_resolved, lat: 0, lon: 0 });
    for (const url of ["http://radio.example/listen", "https://user:secret@radio.example/listen", "file:///stream", "https://radio.example/list.pls"]) expect(normalizeRadioStation({ ...row, url_resolved: url })).toBeNull();
    expect(normalizeRadioStation({ ...row, stationuuid: "../../other" })).toBeNull();
    expect(normalizeRadioStation({ ...row, geo_lat: 100, geo_long: null })).toMatchObject({ lat: null, lon: null });
  });
  it("deduplicates a concurrent search, caches results and refreshes expired data", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([row, row])));
    const directory = createRadioDirectory({ fetchImpl, discover, now: () => now, random: () => .99 });
    const [a, b] = await Promise.all([directory.search(), directory.search()]);
    expect(a).toHaveLength(1); expect(b).toEqual(a); expect(fetchImpl).toHaveBeenCalledTimes(1);
    await directory.search(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 600_001; await directory.search(); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("uses mirror failover, a descriptive agent and encoded bounded filters", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response(JSON.stringify([row])));
    const directory = createRadioDirectory({ fetchImpl, discover, random: () => .99 });
    expect(await directory.search({ name: "jazz & soul", country: "md", language: "romanian" })).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, options] = fetchImpl.mock.calls[1];
    expect(url).toContain("name=jazz+%26+soul"); expect(url).toContain("countrycode=MD");
    expect(options.headers["User-Agent"]).toContain("ccdeck");
    expect(options.redirect).toBe("error");
  });
  it("reports a station selection once and rejects arbitrary IDs without making a request", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const directory = createRadioDirectory({ fetchImpl, discover });
    expect(await directory.click("../../foo")).toBe(false);
    await directory.click(`radio-${uuid}`); await directory.click(`radio-${uuid}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not accept an untrusted DNS mirror", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([row])));
    await createRadioDirectory({ fetchImpl, discover: async () => [{ name: "localhost" }], random: () => .99 }).search();
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/[a-z0-9-]+\.api\.radio-browser\.info\//);
  });
  it("honors the music off switch before touching the directory", async () => {
    // @ts-expect-error Server modules ship as JavaScript.
    const { handleRadioStations, handleRadioClick } = await import("../../server/music-routes.mjs");
    const old = process.env.AGENTS_DECK_NO_MUSIC;
    process.env.AGENTS_DECK_NO_MUSIC = "1";
    const chunks: string[] = [];
    const res = { writeHead: vi.fn(), end: (body: string) => chunks.push(body) };
    try {
      await handleRadioStations({ url: "/api/radio-stations" }, res);
      await handleRadioClick({ url: "/api/radio-click?id=invalid" }, res);
      expect(chunks.map(body => JSON.parse(body))).toEqual([{ ok: true, off: true, stations: [] }, { ok: true, off: true }]);
    } finally { if (old === undefined) delete process.env.AGENTS_DECK_NO_MUSIC; else process.env.AGENTS_DECK_NO_MUSIC = old; }
  });
});
