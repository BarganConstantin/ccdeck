// Radar monitors by itself, always (the owner, 2026-10-23, reversing v3.44.0's
// opt-in). A fresh deck, one upgraded from 3.43.4 and one whose Settings ›
// Radar switch was off all find Claude's collector and monitor it, with no
// switch, no Start and nothing saved that keeps it off.
//
// Nothing here captures or spawns anything: the monitor, the capture tool and
// interface lookups, and Radar's process scan are replaced, so what the deck
// would have run is counted instead. HOME points inside one temp directory,
// checked before the deck's own capture is imported, so its saved preferences
// are read from and written there.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmTempDir } from './rm-temp-dir';

const { seen } = vi.hoisted(() => ({ seen: { monitors: [] as { host: string; port: number }[], tools: 0, interfaces: 0, reads: 0 } }));

vi.mock('../../server/traffic-radar-monitor.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  monitorDestination: (options: { host: string; port: number }) => { seen.monitors.push({ host: options.host, port: options.port }); return () => {}; },
}));
vi.mock('../../server/traffic-radar-platform.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  captureTool: async () => { seen.tools++; return '/usr/sbin/tcpdump'; },
  captureInterface: async () => { seen.interfaces++; return 'lo'; },
}));
// A collector in the settings and on the wire, for a deck that went looking —
// and a count of every time one did (automatic monitoring's discovery).
vi.mock('../../server/traffic-radar.mjs', () => ({
  trafficRadar: { read: async () => (seen.reads++, {
    ok: true, status: 'observing', config: { sources: [], variables: [{ key: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://192.0.2.16:4317', source: 'User settings' }] },
    connections: [{ pid: 42, destination: '192.0.2.16:4317', active: true }], alerts: [],
  }) },
}));

const DIR = await mkdtemp(join(tmpdir(), 'ccdeck-radar-default-'));
const PREV = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
if (!resolve(homedir()).startsWith(resolve(DIR))) throw new Error('sandbox escaped: homedir');
const { trafficCapture, createTrafficCapture } = await import('../../server/traffic-radar-capture.mjs');
const { capturePreferences } = await import('../../server/traffic-radar-monitor.mjs');
const { createRadarService } = await import('../../server/traffic-radar-service.mjs');
const { trafficRadar } = await import('../../server/traffic-radar.mjs');

const PREFERENCES = join(DIR, '.agents-deck');
const settle = () => new Promise(r => setTimeout(r, 20));

beforeEach(() => { seen.monitors = []; seen.tools = 0; seen.interfaces = 0; seen.reads = 0; });
afterAll(() => {
  trafficCapture.dispose();
  for (const [key, value] of Object.entries(PREV)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmTempDir(DIR);
});

describe("the deck's own capture", () => {
  it('monitors the collector by itself once the deck starts it on its port', async () => {
    expect(trafficCapture.read()).toMatchObject({ managed: true, automatic: true, enabled: false, state: 'idle', sources: [] });
    expect(seen).toEqual({ monitors: [], tools: 0, interfaces: 0, reads: 0 });
    await trafficCapture.resume(4329);
    await settle();
    expect(trafficCapture.read()).toMatchObject({ managed: true, automatic: true, featureEnabled: true, enabled: true, setupError: null });
    expect(trafficCapture.read().sources.map((s: { destination: string }) => s.destination)).toEqual(['192.0.2.16:4317']);
    expect(seen.monitors).toEqual([{ host: '192.0.2.16', port: 4317 }]);
    expect(seen.reads).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(PREFERENCES, 'radar-settings-4329.json'), 'utf8'))).toEqual({ destinations: ['192.0.2.16:4317'] });
    expect(JSON.parse(await readFile(join(PREFERENCES, 'radar-monitor-4329.json'), 'utf8'))).toMatchObject({ enabled: true, destinations: ['192.0.2.16:4317'] });
  });
});

// The monitor's own record (radar-monitor-<port>.json) is unchanged: the capture
// alone resumes only a monitor its record says is on. The service above it is
// what no longer waits for anyone.
describe("the monitor's own record", () => {
  it('on a saved preference that does not say enabled, or says it is not', async () => {
    await mkdir(PREFERENCES, { recursive: true });
    const saved = { 4401: { destinations: ['192.0.2.16:4317'] }, 4402: { enabled: false, destinations: ['192.0.2.16:4317'] } };
    for (const [port, value] of Object.entries(saved)) await writeFile(join(PREFERENCES, `radar-monitor-${port}.json`), JSON.stringify(value));
    for (const port of [4401, 4402]) {
      const capture = createTrafficCapture({ managed: true, preferences: capturePreferences(PREFERENCES), platform: 'linux' });
      await capture.resume(port);
      await settle();
      expect(capture.read(), `port ${port}`).toMatchObject({ enabled: false, state: 'idle', sources: [] });
      capture.dispose();
    }
    expect(seen).toEqual({ monitors: [], tools: 0, interfaces: 0, reads: 0 });
  });

  it('and on, as before, once the saved preference says enabled', async () => {
    await mkdir(PREFERENCES, { recursive: true });
    await writeFile(join(PREFERENCES, 'radar-monitor-4403.json'), JSON.stringify({ enabled: true, destinations: ['192.0.2.16:4317'] }));
    const capture = createTrafficCapture({ managed: true, preferences: capturePreferences(PREFERENCES), platform: 'linux' });
    await capture.resume(4403);
    expect(capture.read()).toMatchObject({ managed: true, enabled: true, state: 'awaiting' });
    expect(seen.monitors).toEqual([{ host: '192.0.2.16', port: 4317 }]);
    capture.dispose();
  });
});

// The deck's own service, its real capture and its real preference files, with
// a 20 ms poll. Nothing reads the capture in these waits, so Radar counts as
// closed: one look at resume, the next a minute later.
describe('monitoring needs nobody to turn it on', () => {
  const quiet = () => new Promise(r => setTimeout(r, 200));
  const readJson = async (name: string) => JSON.parse(await readFile(join(PREFERENCES, name), 'utf8'));
  const deck = () => createRadarService({
    capture: createTrafficCapture({ managed: true, preferences: capturePreferences(PREFERENCES), platform: 'linux' }),
    preferences: capturePreferences(PREFERENCES, 'radar-settings'), discover: () => trafficRadar.read(), pollMs: 20,
  });
  const watching = (service: ReturnType<typeof deck>) => service.read().sources.map((s: { destination: string }) => s.destination);

  it('a fresh deck finds the collector and monitors it, looking once while Radar is closed', async () => {
    const service = deck();
    await service.resume(4501); await quiet();
    expect(seen.monitors).toEqual([{ host: '192.0.2.16', port: 4317 }]);
    expect(seen.reads).toBe(1);
    expect(service.read()).toMatchObject({ automatic: true, featureEnabled: true, enabled: true });
    expect(await readJson('radar-settings-4501.json')).toEqual({ destinations: ['192.0.2.16:4317'] });
    service.dispose();
  });

  it('a deck whose Settings › Radar switch was off monitors all the same', async () => {
    await mkdir(PREFERENCES, { recursive: true });
    await writeFile(join(PREFERENCES, 'radar-settings-4502.json'), JSON.stringify({ automatic: false, destinations: [] }));
    const service = deck();
    await service.resume(4502); await quiet();
    expect(seen.monitors).toEqual([{ host: '192.0.2.16', port: 4317 }]);
    expect(watching(service)).toEqual(['192.0.2.16:4317']);
    expect(await readJson('radar-settings-4502.json')).toEqual({ destinations: ['192.0.2.16:4317'] });
    service.dispose();
  });

  it('a deck upgraded from 3.43.4 monitors the configured collector, whatever its own monitor was doing', async () => {
    await mkdir(PREFERENCES, { recursive: true });
    // What 3.43.4 left: a monitor the person started on another address (4503), one they stopped (4504).
    await writeFile(join(PREFERENCES, 'radar-monitor-4503.json'), JSON.stringify({ enabled: true, destinations: ['192.0.2.40:4317'] }));
    await writeFile(join(PREFERENCES, 'radar-monitor-4504.json'), JSON.stringify({ enabled: false, destinations: ['192.0.2.41:4317'] }));
    const started = deck(), stopped = deck();
    await started.resume(4503); await stopped.resume(4504); await quiet();
    // The started monitor came back first; the collector Claude's settings name replaced it.
    expect(seen.monitors).toEqual([{ host: '192.0.2.40', port: 4317 }, { host: '192.0.2.16', port: 4317 }, { host: '192.0.2.16', port: 4317 }]);
    expect(watching(started)).toEqual(['192.0.2.16:4317']);
    expect(watching(stopped)).toEqual(['192.0.2.16:4317']);
    started.dispose(); stopped.dispose();
  });

  it('goes back to the collector after a restart', async () => {
    const first = deck();
    await first.resume(4505); await quiet();
    expect(await readJson('radar-settings-4505.json')).toEqual({ destinations: ['192.0.2.16:4317'] });
    first.dispose();

    seen.monitors = []; seen.reads = 0;
    const second = deck();
    await second.resume(4505); await quiet();
    expect(seen.monitors).toEqual([{ host: '192.0.2.16', port: 4317 }]);
    expect(second.read()).toMatchObject({ automatic: true, featureEnabled: true, enabled: true });
    expect(watching(second)).toEqual(['192.0.2.16:4317']);
    second.dispose();
  });
});
