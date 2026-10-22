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
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmTempDir } from './rm-temp-dir';

const { seen } = vi.hoisted(() => ({ seen: { monitors: [] as { host: string; port: number }[], tools: 0, interfaces: 0 } }));

vi.mock('../../server/traffic-radar-monitor.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  monitorDestination: (options: { host: string; port: number }) => { seen.monitors.push({ host: options.host, port: options.port }); return () => {}; },
}));
vi.mock('../../server/traffic-radar-platform.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  captureTool: async () => { seen.tools++; return '/usr/sbin/tcpdump'; },
  captureInterface: async () => { seen.interfaces++; return 'lo'; },
}));
// A collector in the settings and on the wire, for a deck that went looking.
vi.mock('../../server/traffic-radar.mjs', () => ({
  trafficRadar: { read: async () => ({
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

const PREFERENCES = join(DIR, '.agents-deck');
const settle = () => new Promise(r => setTimeout(r, 20));

beforeEach(() => { seen.monitors = []; seen.tools = 0; seen.interfaces = 0; });
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
    expect(seen).toEqual({ monitors: [], tools: 0, interfaces: 0 });
    expect(existsSync(join(PREFERENCES, 'radar-monitor-4329.json')), 'nothing saved for a deck nobody opted in').toBe(false);
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
    expect(seen).toEqual({ monitors: [], tools: 0, interfaces: 0 });
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
