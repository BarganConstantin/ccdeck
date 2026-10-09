import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrafficCapture } from '../../server/traffic-radar-capture.mjs';
import { capturePreferences, monitorDestination } from '../../server/traffic-radar-monitor.mjs';
import { pcap, packet, request, response, LOGS } from './traffic-capture-fixture.mjs';
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });
const tick = async () => { await new Promise(r => setTimeout(r, 10)); };
function child() { return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }); }

describe('continuous managed capture', () => {
  it('starts capture without a Terminal command, recovers after a crash, and cancels retry on stop', async () => {
    const children: ReturnType<typeof child>[] = [];
    const launch = vi.fn(() => { const value = child(); children.push(value); return value; });
    let iface = 'en0';
    const capture = createTrafficCapture({ managed: true, platform: 'darwin', findTool: async () => 'tcpdump', findInterface: async () => iface,
      monitor: options => monitorDestination({ ...options, launch, retryMs: 10 }) });
    cleanup.push(() => capture.dispose());
    await capture.prepare('192.0.2.16:4317', 4329); await tick();
    expect(capture.read()).toMatchObject({ managed: true, enabled: true, expiresAt: null, state: 'awaiting' });
    children[0].stderr.write('tcpdump: listening on en0');
    children[0].stdout.write(pcap(packet(request()), packet(response(), { side: 'in' })));
    const first = capture.read().events[0]; expect(first.outcome).toBe('accepted'); expect(capture.detail(first.id).payload).toEqual(LOGS);
    iface = 'en1'; children[0].emit('exit', 1); expect(capture.read().state).toBe('interrupted');
    await tick(); await tick(); expect(launch).toHaveBeenCalledTimes(2); expect(launch.mock.calls[1][1]).toContain('en1');
    children[1].stdout.write(pcap(packet(request()), packet(response(), { side: 'in' })));
    expect(capture.read().events).toHaveLength(2); expect(capture.read().sources[0].active).toBe(true);
    await capture.stop(); expect(children[1].kill).toHaveBeenCalled(); children[1].emit('exit', 0);
    await tick(); expect(launch).toHaveBeenCalledTimes(2); expect(capture.read().enabled).toBe(false);
  });
  it('reports permissions honestly and retries when capture access becomes available', async () => {
    const children: ReturnType<typeof child>[] = [];
    const capture = createTrafficCapture({ managed: true, platform: 'linux', findTool: async () => 'tcpdump', findInterface: async () => 'any', monitor: options => monitorDestination({ ...options, retryMs: 10, launch: () => { const c = child(); children.push(c); return c; } }) });
    cleanup.push(() => capture.dispose()); await capture.prepare('192.0.2.16:4317', 4329); await tick();
    children[0].stderr.write("tcpdump: You don't have permission to capture on that device"); children[0].emit('exit', 1);
    expect(capture.read().sources[0]).toMatchObject({ active: false, error: 'Packet capture permission is required.' });
    await tick(); await tick(); children[1].stderr.write('tcpdump: listening on any');
    expect(capture.read()).toMatchObject({ state: 'receiving', sources: [{ active: true, error: null }] });
  });
  it('remembers opt-in across restart, never persists packets or tokens, and remembers Stop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'radar-monitor-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const preferences = capturePreferences(directory), monitor = vi.fn(() => vi.fn());
    const make = () => createTrafficCapture({ managed: true, preferences, platform: 'darwin', findTool: async () => 'tcpdump', findInterface: async () => 'en0', monitor });
    const first = make(); cleanup.push(() => first.dispose()); const setup = await first.prepare('192.0.2.16:4317', 4329);
    const token = /'([a-f0-9]{64})'/.exec(setup.command)![1]; first.ingest(token, pcap(packet(request()))); first.dispose();
    const disk = await readFile(join(directory, 'radar-monitor-4329.json'), 'utf8');
    expect(JSON.parse(disk)).toEqual({ enabled: true, destinations: ['192.0.2.16:4317'] }); expect(disk).not.toContain(token); expect(disk).not.toContain('Synthetic');
    const second = make(); cleanup.push(() => second.dispose()); await second.resume(4329);
    expect(monitor).toHaveBeenCalledTimes(2); expect(second.read()).toMatchObject({ enabled: true, events: [] }); expect(second.accepts(token)).toBe(false);
    await second.stop(); second.dispose(); const third = make(); cleanup.push(() => third.dispose()); await third.resume(4329);
    expect(third.read().enabled).toBe(false); expect(monitor).toHaveBeenCalledTimes(2);
  });
  it('does not launch capture if Stop wins while setup is still resolving', async () => {
    let ready!: (value: string) => void; const tool = new Promise<string>(r => { ready = r; }); const monitor = vi.fn();
    const capture = createTrafficCapture({ managed: true, platform: 'darwin', findTool: () => tool, findInterface: async () => 'en0', monitor }); cleanup.push(() => capture.dispose());
    const preparing = capture.prepare('192.0.2.16:4317', 4329); await capture.stop(); ready('tcpdump');
    await expect(preparing).rejects.toThrow('cancelled'); expect(monitor).not.toHaveBeenCalled();
  });
});
