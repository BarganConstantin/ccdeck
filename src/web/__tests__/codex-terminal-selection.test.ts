import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCodexProfile, readCodexSelection, selectCodexProfile } from '../../server/codex-selection.mjs';
import { configureCodexTerminal, codexLoginCommand, codexTerminalCommand } from '../../server/codex-terminal.mjs';
import { terminalCodexHome } from '../../server/codex-terminal-runner.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-terminal-'));
  roots.push(root);
  const original = join(root, 'original');
  const store = join(root, 'store');
  await mkdir(original);
  const options = { store, env: { CODEX_HOME: original } };
  const added = await addCodexProfile({ label: 'Work', operationId: 'add-work' }, options);
  const current = await readCodexSelection(options);
  const selected = await selectCodexProfile({ id: added.id, expectedRevision: current.revision, operationId: 'select-work' }, options);
  return { root, original, store, options, selected, file: join(store, 'codex-accounts.json') };
}

describe('durable terminal selection', () => {
  it('resolves the persisted default without a running deck and honors explicit overrides', async () => {
    const f = await fixture();
    expect(await terminalCodexHome(f.file, {})).toBe(f.selected.home);
    expect(await terminalCodexHome(f.file, { CODEX_HOME: f.original })).toBe(f.original);
    expect(await terminalCodexHome(join(f.root, 'absent.json'), {})).toBeNull();
  });
  it('fails closed for a corrupt registry or unavailable selected home', async () => {
    const f = await fixture();
    await rm(f.selected.home, { recursive: true });
    await expect(terminalCodexHome(f.file, {})).rejects.toThrow('unavailable');
    await writeFile(f.file, '{broken');
    await expect(terminalCodexHome(f.file, {})).rejects.toThrow('cannot be read');
  });
  it('installs a self-contained launcher, forwards exact arguments, and removes only its shell block', async () => {
    const f = await fixture();
    // Windows PowerShell dot-sources .ps1 files; extensionless paths launch externally.
    const rc = join(f.root, process.platform === 'win32' ? 'shell-profile.ps1' : 'shell-profile');
    const existing = process.platform === 'win32' ? '# User configuration\n$env:MY_SETTING="preserved"\n' : '# User configuration\nexport MY_SETTING="preserved"\n';
    await writeFile(rc, existing);
    const shell = process.platform === 'win32' ? 'powershell' : 'bash';
    const options = { ...f.options, rc, shell, executable: process.execPath };
    await configureCodexTerminal('install', options);
    const first = await readFile(rc, 'utf8');
    await configureCodexTerminal('install', options);
    expect(await readFile(rc, 'utf8')).toBe(first);
    const runner = join(f.store, 'codex-terminal', 'codex-terminal-runner.mjs');
    const env = { ...process.env };
    delete env.CODEX_HOME;
    const strange = 'spaces "quotes" & dollar $ and apostrophe\'';
    const out = execFileSync(process.execPath, [runner, f.file, process.execPath, '-e', 'console.log(JSON.stringify({home:process.env.CODEX_HOME,args:process.argv.slice(1)}))', '--', strange], { env, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({ home: f.selected.home, args: [strange] });
    const args = ['-e', 'console.log(JSON.stringify({home:process.env.CODEX_HOME,args:process.argv.slice(1)}))', '--', strange];
    let shellOutput;
    if (process.platform === 'win32') {
      const script = join(f.root, 'launch.ps1');
      const exact = [strange, '', 'trailing\\', 'é unicode', 'line\nbreak'];
      const encoded = Buffer.from(JSON.stringify([...args.slice(0, -1), ...exact])).toString('base64');
      await writeFile(script, `. '${rc.replaceAll("'", "''")}'\n$probeArgs = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))\ncodex @probeArgs\nexit $LASTEXITCODE\n`);
      for (const executable of ['pwsh', 'powershell.exe']) {
        shellOutput = execFileSync(executable, ['-NoProfile', '-File', script], { env, encoding: 'utf8' });
        expect(JSON.parse(shellOutput)).toEqual({ home: f.selected.home, args: exact });
      }
    } else {
      shellOutput = execFileSync('bash', ['-c', 'source "$1"; shift; codex "$@"', 'qa', rc, ...args], { env, encoding: 'utf8' });
    }
    if (process.platform !== 'win32') expect(JSON.parse(shellOutput)).toEqual({ home: f.selected.home, args: [strange] });
    await configureCodexTerminal('uninstall', options);
    expect(await readFile(rc, 'utf8')).toBe(existing);
    // The copied helper remains usable after removal of the shell block and
    // has no import of an npx-cache or package installation path.
    expect(await readFile(runner, 'utf8')).not.toContain('ccdeck-codex-accounts');
  });
  it('preserves the child exit code', async () => {
    const f = await fixture();
    const runner = fileURLToPath(new URL('../../server/codex-terminal-runner.mjs', import.meta.url));
    try { execFileSync(process.execPath, [runner, f.file, process.execPath, '-e', 'process.exit(17)'], { stdio: 'pipe' }); }
    catch (error) { expect((error as { status: number }).status).toBe(17); return; }
    throw new Error('Expected exit code 17');
  });
  it('decodes the PowerShell envelope exactly and preserves explicit home and exit code', async () => {
    const f = await fixture();
    const runner = join(f.store, 'codex-terminal', 'codex-terminal-runner.mjs');
    await configureCodexTerminal('install', { ...f.options, rc: join(f.root, 'generated.ps1'), shell: 'powershell5', executable: process.execPath });
    const exact = ['', 'spaces "quotes" & $ apostrophe\'', 'trailing\\', 'é unicode', 'line\nbreak'];
    const args = ['-e', 'console.log(JSON.stringify({home:process.env.CODEX_HOME,args:process.argv.slice(1)}))', '--', ...exact];
    const invoke = (values: string[]) => [runner, f.file, process.execPath, '--ccdeck-args-base64', Buffer.from(JSON.stringify(values)).toString('base64')];
    const env = { ...process.env, CODEX_HOME: f.original };
    expect(JSON.parse(execFileSync(process.execPath, invoke(args), { env, encoding: 'utf8' }))).toEqual({ home: f.original, args: exact });
    expect(() => execFileSync(process.execPath, invoke(['-e', 'process.exit(17)']), { env, stdio: 'pipe' })).toThrow(expect.objectContaining({ status: 17 }));
    expect(() => execFileSync(process.execPath, [runner, f.file, process.execPath, '--ccdeck-args-base64', Buffer.from('{}').toString('base64')], { env, stdio: 'pipe' })).toThrow(expect.objectContaining({ status: 1 }));
  });
  it('quotes official login commands for both shell families', () => {
    expect(codexLoginCommand("/profiles/it's work", 'linux')).toContain("'\\''");
    expect(codexLoginCommand("C:\\profiles\\it's work", 'win32')).toContain("it''s work");
    expect(codexLoginCommand('/profiles/a', 'linux')).toContain('codex login');
  });
  it('carries the server registry into setup commands and uses the current PowerShell profile', () => {
    expect(codexTerminalCommand('install', 'bash')).toContain('--store ');
    expect(codexTerminalCommand('install', 'powershell', 'win32')).toContain('--rc $PROFILE.CurrentUserAllHosts');
    expect(codexTerminalCommand('uninstall', 'powershell5', 'win32')).toContain('--rc $PROFILE.CurrentUserAllHosts');
  });
  it('preserves the effective macOS Bash login file instead of shadowing it', async () => {
    const f = await fixture();
    const profile = join(f.root, '.profile');
    await writeFile(profile, '# Existing login settings\n');
    const result = await configureCodexTerminal('install', { ...f.options, home: f.root, platform: 'darwin', shell: 'bash', executable: process.execPath });
    expect(result.rc).toBe(profile);
    expect(await readFile(profile, 'utf8')).toContain('# Existing login settings');
    await expect(readFile(join(f.root, '.bash_profile'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await configureCodexTerminal('uninstall', { ...f.options, home: f.root, platform: 'darwin', shell: 'bash' });
    expect(await readFile(profile, 'utf8')).toBe('# Existing login settings\n');
  });
});
