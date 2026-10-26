// Allow capture: the one password prompt Radar asks for, once
// (traffic-radar-permission.mjs). The commands are replaced throughout, so
// nothing here asks for a password or changes the machine; the root scripts
// themselves are checked for what they do and, where a POSIX shell is at hand,
// that they parse.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askCapturePermission, linuxScript, macosScript, LAUNCH_LABEL, OSASCRIPT, PKEXEC, validUser } from '../../server/traffic-radar-permission.mjs';
import { rmTempDir } from './rm-temp-dir';

const DIR = await mkdtemp(join(tmpdir(), 'ccdeck-radar-permission-'));
afterAll(() => rmTempDir(DIR));
const FILE = join(DIR, 'radar-capture-setup.sh');
const COMMAND = `sudo sh '${FILE}'`;
const MAC = { username: 'ana', uid: 501, gid: 20 };
const LINUX = { username: 'ana', uid: 1000, gid: 1000 };
const DESKTOP = { DISPLAY: ':0' };
type Result = { ok: boolean; code?: number | string; stderr?: string; timedOut?: boolean };
const answer = (r: Result) => vi.fn(async (_file: string, _args: string[], _options?: unknown) => ({ stdout: '', stderr: '', timedOut: false, code: 0, ...r }));
const posix = process.platform !== 'win32';
const parses = (script: string) => execFileSync('sh', ['-n'], { input: script });

describe('the root scripts', () => {
  it('take only a plain login name and a real group', () => {
    for (const name of ["ana'; rm -rf /; '", 'ana bob', '', '-ana', 'a'.repeat(65), 'ana\nbob', '$(id)'])
      expect(() => macosScript(name), JSON.stringify(name)).toThrow();
    expect(validUser('ana.maria_2-x')).toBe(true);
    for (const gid of [0, -1, 1.5, NaN, '1000' as unknown as number]) expect(() => linuxScript(gid), String(gid)).toThrow();
  });

  it('on macOS, install a LaunchDaemon of ccdeck’s own that opens BPF to access_bpf, and hand this boot’s devices over now', () => {
    const script = macosScript('ana');
    expect(script).toContain("user='ana'");
    expect(script).toContain(`<string>${LAUNCH_LABEL}</string>`);
    expect(script).toContain(`/Library/LaunchDaemons/${LAUNCH_LABEL}.plist`);
    expect(script).toContain('<key>RunAtLoad</key><true/>');
    expect(script).toContain('chgrp access_bpf /dev/bpf*');
    expect(script).toContain('chmod g+rw /dev/bpf*');
    expect(script).toContain('dseditgroup -q -o create access_bpf');
    expect(script).toContain('dseditgroup -q -o edit -a "$user" -t user access_bpf');
    expect(script).toContain(`launchctl bootstrap system '/Library/LaunchDaemons/${LAUNCH_LABEL}.plist'`);
    // A new group reaches running processes only after a new login.
    expect(script.trimEnd().split('\n').at(-1)).toBe('chown "$user" /dev/bpf*');
  });

  it('on Linux, install tcpdump and setcap where missing, and let only the person’s own group capture', () => {
    const script = linuxScript(1000);
    expect(script).toContain('chgrp 1000 "$tool"');
    expect(script).toContain('chmod 0750 "$tool"');
    expect(script).toContain('setcap cap_net_raw,cap_net_admin=eip "$tool"');
    for (const manager of ['apt-get install -y', 'dnf install -y', 'zypper --non-interactive install', 'pacman -S --noconfirm --needed'])
      expect(script).toContain(manager);
    expect(script).toContain('install tcpdump tcpdump tcpdump tcpdump');
    expect(script).toContain('install libcap2-bin libcap libcap-progs libcap');
    for (const path of ['/usr/sbin/tcpdump', '/usr/bin/tcpdump', '/sbin/tcpdump']) expect(script).toContain(path);
  });

  it.skipIf(process.platform === "win32")('parse as POSIX shell, the macOS helper inside its script too', () => {
    const mac = macosScript('ana');
    parses(mac); parses(linuxScript(1000));
    parses(mac.slice(mac.indexOf("<<'CCDECK_HELPER'\n") + 18, mac.indexOf('\nCCDECK_HELPER\n')));
  });
});

describe('asking on macOS', () => {
  it('runs the script through the system password prompt and answers granted', async () => {
    const exec = answer({ ok: true });
    expect(await askCapturePermission({ platform: 'darwin', user: MAC, exec, directory: DIR })).toEqual({ outcome: 'granted' });
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0];
    expect(file).toBe(OSASCRIPT);
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain('with administrator privileges');
    expect(args.slice(2, 4)).toEqual(['--', macosScript('ana')]);
    expect(args[4]).toMatch(/Telemetry Radar/);
    expect(options).toEqual({ timeout: 300_000 });
  });
  it('answers cancelled for a closed prompt, and writes nothing', async () => {
    expect(await askCapturePermission({ platform: 'darwin', user: MAC, exec: answer({ ok: false, code: 1, stderr: 'execution error: User canceled. (-128)' }), directory: join(DIR, 'never') }))
      .toEqual({ outcome: 'cancelled' });
    await expect(stat(join(DIR, 'never'))).rejects.toThrow();
  });
  it('hands over the script where no prompt can open', async () => {
    const result = await askCapturePermission({ platform: 'darwin', user: MAC, exec: answer({ ok: false, code: 1, stderr: 'execution error: No user interaction allowed. (-1713)' }), directory: DIR });
    expect(result).toEqual({ outcome: 'unavailable', message: 'No password prompt can open in this session.', command: COMMAND });
    expect(await readFile(FILE, 'utf8')).toBe(macosScript('ana'));
    if (posix) expect((await stat(FILE)).mode & 0o777).toBe(0o600);
  });
  it('says nobody answered a prompt left open, or what macOS said', async () => {
    expect(await askCapturePermission({ platform: 'darwin', user: MAC, exec: answer({ ok: false, code: 'ETIMEDOUT', timedOut: true }), directory: DIR }))
      .toEqual({ outcome: 'failed', message: 'Nobody answered the password prompt.', command: COMMAND });
    expect(await askCapturePermission({ platform: 'darwin', user: MAC, exec: answer({ ok: false, code: 1, stderr: 'line one\nlaunchctl: Bootstrap failed: 5\n' }), directory: DIR }))
      .toEqual({ outcome: 'failed', message: 'macOS refused: launchctl: Bootstrap failed: 5.', command: COMMAND });
  });
  it('asks for no one but a signed-in, non-root user', async () => {
    const exec = answer({ ok: true });
    for (const user of [{ ...MAC, uid: 0 }, { ...MAC, username: 'a b' }])
      expect((await askCapturePermission({ platform: 'darwin', user, exec, directory: DIR })).outcome).toBe('unavailable');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('asking on Linux', () => {
  it('runs the script under pkexec and answers granted', async () => {
    const exec = answer({ ok: true });
    expect(await askCapturePermission({ platform: 'linux', env: DESKTOP, user: LINUX, exec, directory: DIR })).toEqual({ outcome: 'granted' });
    expect(exec).toHaveBeenCalledWith(PKEXEC, ['/bin/sh', '-c', linuxScript(1000)], { timeout: 300_000 });
  });
  it('opens no prompt outside a desktop session, and hands over the script', async () => {
    const exec = answer({ ok: true });
    expect(await askCapturePermission({ platform: 'linux', env: {}, user: LINUX, exec, directory: DIR }))
      .toEqual({ outcome: 'unavailable', message: 'No password prompt can open in this session.', command: COMMAND });
    expect(exec).not.toHaveBeenCalled();
    expect(await readFile(FILE, 'utf8')).toBe(linuxScript(1000));
    expect((await askCapturePermission({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, user: LINUX, exec, directory: DIR })).outcome).toBe('granted');
  });
  it('reads pkexec’s answer: dismissed, no agent, refused, or the script’s own failure', async () => {
    const ask = (r: Result) => askCapturePermission({ platform: 'linux', env: DESKTOP, user: LINUX, exec: answer(r), directory: DIR });
    expect(await ask({ ok: false, code: 126 })).toEqual({ outcome: 'cancelled' });
    const unavailable = { outcome: 'unavailable', message: 'No password prompt can open in this session.', command: COMMAND };
    expect(await ask({ ok: false, code: 'ENOENT' })).toEqual(unavailable);
    expect(await ask({ ok: false, code: 127, stderr: 'Error executing command as another user: No authentication agent found.' })).toEqual(unavailable);
    expect(await ask({ ok: false, code: 127, stderr: 'Error executing command as another user: Not authorized' }))
      .toEqual({ outcome: 'failed', message: 'The password was not accepted.', command: COMMAND });
    expect(await ask({ ok: false, code: 'ETIMEDOUT', timedOut: true }))
      .toEqual({ outcome: 'failed', message: 'Nobody answered the password prompt.', command: COMMAND });
    expect(await ask({ ok: false, code: 100, stderr: 'Reading package lists...\nE: Could not get lock /var/lib/dpkg/lock-frontend\n' }))
      .toEqual({ outcome: 'failed', message: 'The setup stopped: E: Could not get lock /var/lib/dpkg/lock-frontend.', command: COMMAND });
    expect(await ask({ ok: false, code: 4 })).toEqual({ outcome: 'failed', message: 'The setup stopped: exit 4.', command: COMMAND });
  });
  it('asks for no one but a signed-in, non-root user with a group', async () => {
    const exec = answer({ ok: true });
    for (const user of [{ ...LINUX, uid: 0 }, { ...LINUX, gid: 0 }])
      expect((await askCapturePermission({ platform: 'linux', env: DESKTOP, user, exec, directory: DIR })).outcome).toBe('unavailable');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('elsewhere, and twice at once', () => {
  it('has no step on Windows: Npcap is the person’s own to install', async () => {
    const exec = answer({ ok: true });
    expect(await askCapturePermission({ platform: 'win32', exec, directory: DIR }))
      .toEqual({ outcome: 'unavailable', message: 'Install Wireshark with Npcap to allow packet capture.' });
    expect(exec).not.toHaveBeenCalled();
  });
  it('opens one prompt for two presses, and a new one after it closed', async () => {
    let finish!: (value: Result) => void;
    const exec = vi.fn(() => new Promise<Result>(resolve => { finish = resolve; }));
    const deps = { platform: 'linux', env: DESKTOP, user: LINUX, exec, directory: DIR };
    const first = askCapturePermission(deps), second = askCapturePermission(deps);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    finish({ ok: true }); expect(await first).toEqual({ outcome: 'granted' });
    const third = askCapturePermission(deps);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
    finish({ ok: false, code: 126 }); expect(await third).toEqual({ outcome: 'cancelled' });
  });
});
