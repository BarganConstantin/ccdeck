// Radar monitoring is opt-in. A deck nobody switched it on for starts with no
// packet capture: no capture tool looked up, no monitor launched and nothing
// written. A saved preference turns it on only when it says `enabled: true`.
//
// Nothing here captures or spawns anything: the monitor, the capture tool and
// interface lookups, and Radar's process scan are replaced, so a deck that did
// start monitoring by itself would be seen doing so and nothing would run.
// HOME points inside one temp directory, checked before the deck's own capture
// is imported, so its saved preferences are read from and written there.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
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

describe('Radar monitoring is off until someone turns it on', () => {
  it("on the deck's own capture, before and after the deck starts it on its port", async () => {
    expect(trafficCapture.read()).toMatchObject({ managed: true, enabled: false, state: 'idle', sources: [] });
    await trafficCapture.resume(4329);
    await settle();
    expect(trafficCapture.read()).toMatchObject({ managed: true, enabled: false, state: 'idle', sources: [], events: [] });
    expect(seen).toEqual({ monitors: [], tools: 0, interfaces: 0, reads: 0 });
    expect(existsSync(join(PREFERENCES, 'radar-monitor-4329.json')), 'nothing saved for a deck nobody opted in').toBe(false);
    expect(existsSync(join(PREFERENCES, 'radar-settings-4329.json')), 'no automatic switch saved either').toBe(false);
    expect(await trafficCapture.settings()).toEqual({ ok: true, enabled: false, setupError: null });
    expect(trafficCapture.read()).toMatchObject({ automatic: false });
  });

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

// Settings › Radar's automatic monitoring (v3.44.0) is opt-in as well: the deck's
// own service, its real capture and its real preference files, with a 20 ms
// retry so a deck that looked for a collector by itself would be seen doing it
// many times over in the waits below.
describe('automatic monitoring is off until someone turns it on, and stays as they leave it', () => {
  const quiet = () => new Promise(r => setTimeout(r, 200));
  const readJson = async (name: string) => JSON.parse(await readFile(join(PREFERENCES, name), 'utf8'));
  const deck = () => createRadarService({
    capture: createTrafficCapture({ managed: true, preferences: capturePreferences(PREFERENCES), platform: 'linux' }),
    preferences: capturePreferences(PREFERENCES, 'radar-settings'), discover: () => trafficRadar.read(), pollMs: 20,
  });

  it('a fresh deck looks for no collector and retries nothing', async () => {
    const service = deck();
    await service.resume(4501); await quiet();
    expect(seen).toEqual({ monitors: [], tools: 0, interfaces: 0, reads: 0 });
    expect(await service.settings()).toMatchObject({ enabled: false });
    expect(existsSync(join(PREFERENCES, 'radar-settings-4501.json'))).toBe(false);
    service.dispose();
  });

  it('a deck upgraded from 3.43.4 keeps the monitor it had, and looks for nothing else', async () => {
    await mkdir(PREFERENCES, { recursive: true });
    // What 3.43.4 left: a monitor the person started (4502), one they stopped (4503).
    await writeFile(join(PREFERENCES, 'radar-monitor-4502.json'), JSON.stringify({ enabled: true, destinations: ['192.0.2.40:4317'] }));
    await writeFile(join(PREFERENCES, 'radar-monitor-4503.json'), JSON.stringify({ enabled: false, destinations: ['192.0.2.41:4317'] }));
    const started = deck(), stopped = deck();
    await started.resume(4502); await stopped.resume(4503); await quiet();
    expect(seen.monitors).toEqual([{ host: '192.0.2.40', port: 4317 }]);
    expect(seen.reads).toBe(0);
    expect(started.read()).toMatchObject({ automatic: false, enabled: true });
    expect(stopped.read()).toMatchObject({ automatic: false, enabled: false, state: 'idle' });
    for (const port of [4502, 4503]) expect(existsSync(join(PREFERENCES, `radar-settings-${port}.json`))).toBe(false);
    started.dispose(); stopped.dispose();
  });

  it('turning it on monitors the collector by itself; off stops it; each survives a restart', async () => {
    const first = deck();
    await first.resume(4504);
    expect(await first.setEnabled(true)).toMatchObject({ ok: true, enabled: true });
    await quiet();
    expect(seen.reads).toBeGreaterThan(0);
    expect(seen.monitors).toEqual([{ host: '192.0.2.16', port: 4317 }]);
    expect(await readJson('radar-settings-4504.json')).toEqual({ automatic: true, destinations: ['192.0.2.16:4317'] });
    first.dispose();

    seen.monitors = []; seen.reads = 0;
    const second = deck();
    await second.resume(4504);
    expect(second.read()).toMatchObject({ automatic: true, featureEnabled: true });
    expect(seen.monitors).toEqual([{ host: '192.0.2.16', port: 4317 }]);
    expect(await second.setEnabled(false)).toMatchObject({ ok: true, enabled: false });
    expect(await readJson('radar-settings-4504.json')).toMatchObject({ automatic: false });
    expect(await readJson('radar-monitor-4504.json')).toMatchObject({ enabled: false });
    seen.reads = 0; await quiet();
    expect(seen.reads).toBe(0);
    second.dispose();

    seen.monitors = []; seen.tools = 0; seen.interfaces = 0;
    const third = deck();
    await third.resume(4504); await quiet();
    expect(seen).toEqual({ monitors: [], tools: 0, interfaces: 0, reads: 0 });
    expect(third.read()).toMatchObject({ automatic: false, enabled: false });
    third.dispose();
  });
});
