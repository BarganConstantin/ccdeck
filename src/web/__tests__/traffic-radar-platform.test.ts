import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createTrafficRadar, claudePids } from '../../server/traffic-radar.mjs';
import { captureInterface, captureTool, linuxSockets, powershell, WINDOWS_PROCESSES, windowsSockets } from '../../server/traffic-radar-platform.mjs';
import { readRadarConfig } from '../../server/traffic-radar-config.mjs';
import { createTrafficCapture } from '../../server/traffic-radar-capture.mjs';
import { runCaptureTool } from '../../server/traffic-radar-helper.mjs';
import { pcap, packet, request, LOGS } from './traffic-capture-fixture.mjs';
const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(fn => fn()));
const config = async () => ({ sources: [], variables: [] });

describe('native connection observation', () => {
  it('recognizes Windows executables without reading command lines', () => {
    expect(claudePids('42 C:\\Tools\\CLAUDE.exe\r\n43 claude-native\r\n44 node.exe')).toEqual([42, 43]);
  });
  it('uses PowerShell for Windows process ownership and preserves IPv6 peers', async () => {
    const run = vi.fn(async (_file, args) => args.at(-1).includes('Get-Process') ? '42 claude\r\n' : 'p42\r\nnlocal->[2001:db8::1]:443\r\n');
    const radar = createTrafficRadar({ platform: 'win32', run, config });
    expect(await radar.read()).toMatchObject({ status: 'observing', processCount: 1, connections: [{ pid: 42, destination: '[2001:db8::1]:443', workspace: null, active: true }] });
    expect(run.mock.calls.every(([file]) => file === 'powershell.exe')).toBe(true);
    expect(run.mock.calls[1][1].at(-1)).toContain('$ids=@(42)');
    expect(run.mock.calls.flat().join(' ')).not.toContain('CommandLine');
  });
  it('preserves configuration if Windows connection inspection fails', async () => {
    const result = await createTrafficRadar({ platform: 'win32', config, run: async (_file, args) => args.at(-1).includes('Get-Process') ? '42 claude' : null }).read();
    expect(result.status).toBe('unavailable'); expect(result.config).toEqual(await config());
  });
  it('decodes Linux proc IPv4/IPv6 and restricts rows to owned established sockets', async () => {
    const row = (remote: string, inode: string, state = '01') => `0: 0100007F:1234 ${remote} ${state} 0:0 0:0 0 1000 0 ${inode}`;
    const result = await linuxSockets([42], {
      list: async () => ['3','4'],
      link: async path => path.endsWith('cwd') ? '/home/test/project' : path.endsWith('/3') ? 'socket:[100]' : '/dev/null',
      read: async path => 'header\n' + (path.endsWith('tcp6') ? row('B80D0120000000000000000001000000:01BB', '100') : [row('100200C0:10DD', '100'), row('110200C0:10DD', '200'), row('100200C0:10DD', '100', '0A')].join('\n')),
    });
    expect(result.sockets).toContain('192.0.2.16:4317');
    expect(result.sockets).toContain('[2001:db8:0:0:0:0:0:1]:443');
    expect(result.sockets).not.toContain('192.0.2.17');
    expect(result.cwd).toContain('/home/test/project');
    const radar = createTrafficRadar({ platform: 'linux', config, run: async () => '42 claude', readLinuxSockets: async () => result });
    expect((await radar.read()).connections).toHaveLength(2);
  });
  it('reports Linux permission failure rather than no traffic', async () => {
    expect((await linuxSockets([42], { list: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); } })).sockets).toBeNull();
  });
  it.each(['darwin','linux','win32'])('reads the correct managed settings on %s', async platform => {
    const paths: string[] = [];
    await readRadarConfig({ platform, home: platform === 'win32' ? 'C:\\Users\\test' : '/home/test', env: {}, readJson: async path => { paths.push(path); return {}; } });
    expect(paths[2]).toBe(platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json' : platform === 'linux' ? '/etc/claude-code/managed-settings.json' : '/Library/Application Support/ClaudeCode/managed-settings.json');
    expect(paths[0]).toBe(platform === 'win32' ? 'C:\\Users\\test\\.claude\\settings.json' : '/home/test/.claude/settings.json');
  });
});

describe('capture backends', () => {
  it('covers Linux loopback and routes with tcpdump any', async () => {
    expect(await captureInterface('127.0.0.1', 'linux')).toBe('any');
    const capture = createTrafficCapture({ platform: 'linux', findTool: async () => 'tcpdump' }); disposers.push(() => capture.dispose());
    const setup = await capture.prepare('127.0.0.1:4317', 4329);
    expect(setup.command).toContain("sudo 'tcpdump' -i 'any'");
    expect(capture.read()).toMatchObject({ platform: 'linux', shell: 'Terminal', backend: 'tcpdump' });
  });
  it('generates a PowerShell command with no binary shell pipeline', async () => {
    const capture = createTrafficCapture({ platform: 'win32', findTool: async () => 'C:\\Program Files\\Wireshark\\dumpcap.exe', findInterface: async () => '\\Device\\NPF_Loopback' }); disposers.push(() => capture.dispose());
    const setup = await capture.prepare('127.0.0.1:4317', 4329);
    expect(setup.command).toContain("--capture 'C:\\Program Files\\Wireshark\\dumpcap.exe'"); expect(setup.command).not.toContain('|');
    expect(capture.read()).toMatchObject({ shell: 'PowerShell', backend: 'dumpcap' });
  });
  it('resolves Windows adapter GUIDs and loopback separately', async () => {
    const run = vi.fn(async () => '\\Device\\NPF_{01234567-89ab-cdef-0123-456789abcdef}\r\n');
    expect(await captureInterface('127.0.0.1', 'win32', run)).toBe('\\Device\\NPF_Loopback'); expect(run).not.toHaveBeenCalled();
    expect(await captureInterface('192.0.2.16', 'win32', run)).toContain('01234567');
    expect(run.mock.calls[0][1].at(-1)).toContain('Find-NetRoute');
  });
  it.each(['darwin', 'win32'])('runs the helper as Node when ccdeck is hosted by Electron on %s', async platform => {
    const capture = createTrafficCapture({ platform, electron: true, execPath: "C:\\Node's Tools\\electron.exe", findTool: async () => platform === 'win32' ? 'dumpcap.exe' : '/usr/sbin/tcpdump', findInterface: async () => platform === 'win32' ? '\\Device\\NPF_Loopback' : 'lo0' });
    disposers.push(() => capture.dispose());
    const setup = await capture.prepare('127.0.0.1:4317', 4329);
    expect(setup.command).toContain(platform === 'win32' ? "$env:ELECTRON_RUN_AS_NODE='1'" : 'env ELECTRON_RUN_AS_NODE=1');
    if (platform === 'win32') expect(setup.command).toContain("Node''s Tools");
  });
  it.each(['win32','linux'])('explains missing capture dependencies on %s', async platform => {
    await expect(captureTool(platform, async () => null)).rejects.toThrow(platform === 'win32' ? 'Wireshark with Npcap' : 'Install tcpdump');
  });
  it('streams dumpcap binary output unchanged and kills the child when the receiver ends', async () => {
    const bytes = pcap(packet(request()));
    const capture = createTrafficCapture({ platform: 'win32', findTool: async () => 'dumpcap.exe', findInterface: async () => '\\Device\\NPF_Loopback' }); disposers.push(() => capture.dispose());
    const setup = await capture.prepare('192.0.2.16:4317', 4329);
    const token = /'([a-f0-9]{64})' 0$/.exec(setup.command)![1];
    const child = Object.assign(new EventEmitter(), { stdout: Readable.from([bytes.subarray(0, 13), bytes.subarray(13)]), kill: vi.fn() });
    const launch = vi.fn(() => child);
    await runCaptureTool({ tool: 'dumpcap.exe', interface: '\\Device\\NPF_Loopback', host: '192.0.2.16', port: 4317, base: 'http://127.0.0.1:4329', token, launch, report: () => {}, send: async (_url, init) => ({ ok: capture.ingest(token, init.body) }) });
    expect(capture.detail(capture.read().events[0].id).payload).toEqual(LOGS);
    expect(launch.mock.calls[0][1]).toContain('-P'); expect(launch.mock.calls[0][2]).toMatchObject({ shell: false }); expect(child.kill).toHaveBeenCalled();
  });
  it('validates helper arguments before any capture starts', async () => {
    const launch = vi.fn();
    await expect(runCaptureTool({ tool: 'dumpcap.exe', interface: '\\Device\\NPF_Loopback', host: '127.0.0.1', port: 4317, base: 'http://evil.example', token: 'a'.repeat(64), launch })).rejects.toThrow('local capture');
    expect(launch).not.toHaveBeenCalled();
  });
});
