import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// @ts-expect-error server ES module
import { assertWindowsPrivatePath, ensureWindowsPrivateDirectory, holdWindowsPrivatePath } from '../../server/codex-windows-private.mjs';

const runFile = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('Windows private path command boundary', () => {
  it('passes literal paths through -File arguments with a fixed script and bounded execution', async () => {
    const path = "C:\\Users\\O'Brien $user & test\\private";
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ path }) }));
    expect(await ensureWindowsPrivateDirectory(path, { platform: 'win32', execFile: run, timeoutMs: 999999 })).toBe(path);
    const [file, args, options] = run.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(file.toLowerCase()).toContain('\\system32\\windowspowershell\\v1.0\\powershell.exe');
    expect(args).toContain('-File'); expect(args).not.toContain('-Command');
    expect(args[args.indexOf('-TargetPath') + 1]).toBe(path);
    expect(args.filter(a => a.includes(path))).toEqual([path]);
    expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: 10000, maxBuffer: 16384 });
  });
  it.each(['relative', '\\\\server\\share\\private', 'C:\\safe:stream', 'C:\\bad\0path'])('rejects ambiguous path %s before spawning', async path => {
    const run = vi.fn();
    await expect(assertWindowsPrivatePath(path, { platform: 'win32', execFile: run })).rejects.toMatchObject({ code: 'windows_private_path_unsafe' });
    expect(run).not.toHaveBeenCalled();
  });
  it('sanitizes all helper failures and invalid replies', async () => {
    for (const execFile of [async () => { throw new Error('fictional-private-output'); }, async () => ({ stdout: '{bad-private-output' })]) {
      const error = await assertWindowsPrivatePath('C:\\private', { platform: 'win32', execFile }).catch((e: Error) => e);
      expect(error.message).toBe('windows_private_path_unsafe'); expect(error.cause).toBeUndefined();
      expect(String(error.stack)).not.toContain('fictional-private');
    }
  });
});

describe.skipIf(process.platform !== 'win32')('Windows token DACL and pinned handles (synthetic files)', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'ccd-win-private-')); roots.push(root);
    const dir = join(root, "private $literal O'Brien");
    await ensureWindowsPrivateDirectory(dir);
    return { root, dir };
  }
  it('creates a private directory, validates inherited private file ACLs and holds it against replacement', async () => {
    const { dir } = await fixture();
    expect(await assertWindowsPrivatePath(dir)).toBe(win32.toNamespacedPath(dir));
    const file = join(dir, 'synthetic.json'); await writeFile(file, '{"fictional":true}');
    expect(await assertWindowsPrivatePath(file, { kind: 'file' })).toBe(win32.toNamespacedPath(file));
    const guard = await holdWindowsPrivatePath(file, { kind: 'file' });
    try {
      expect(guard.valid()).toBe(true);
      expect(await readFile(file, 'utf8')).toContain('fictional');
      await expect(rm(file)).rejects.toThrow();
      await expect(writeFile(file, 'replacement')).rejects.toThrow();
    } finally { await guard.release(); }
  }, 30000);
  it('rejects an unsafe existing directory without repairing its ACL, and rejects junctions', async () => {
    const { root, dir } = await fixture();
    const unsafe = join(root, 'inherited'); await mkdir(unsafe);
    await expect(ensureWindowsPrivateDirectory(unsafe)).rejects.toMatchObject({ code: 'windows_private_path_unsafe' });
    const alias = join(root, 'junction'); await symlink(dir, alias, 'junction');
    await expect(assertWindowsPrivatePath(alias)).rejects.toMatchObject({ code: 'windows_private_path_unsafe' });
  }, 30000);
  it('rejects an ACL that grants Everyone access', async () => {
    const { dir } = await fixture();
    await runFile(win32.join(process.env.SystemRoot!, 'System32', 'icacls.exe'), [dir, '/grant', '*S-1-1-0:(OI)(CI)RX'], { windowsHide: true, timeout: 5000 });
    await expect(assertWindowsPrivatePath(dir)).rejects.toMatchObject({ code: 'windows_private_path_unsafe' });
  }, 30000);
});
