import { readFile, mkdir, chmod, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { deckDataDir } from './deck-home.mjs';
import { codexSelectionPath } from './codex-selection.mjs';
import { resolveWriteTarget, writeFileAtomic } from './atomic-write.mjs';
import { pathLookup } from './exec-spec.mjs';

const BEGIN = '# >>> ccdeck Codex accounts >>>';
const END = '# <<< ccdeck Codex accounts <<<';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const supported = new Set(['zsh', 'bash', 'powershell', 'powershell5']);
export const defaultCodexShell = (env = process.env, platform = process.platform) =>
  platform === 'win32' ? 'powershell' : basename(env.SHELL ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'));

export function codexLoginCommand(home, platform = process.platform) {
  if (platform === 'win32') return `$previousCodexHome = $env:CODEX_HOME; try { $env:CODEX_HOME = ${psQuote(home)}; codex login } finally { $env:CODEX_HOME = $previousCodexHome }`;
  return `CODEX_HOME=${quote(home)} codex login`;
}
export function codexTerminalCommand(action = 'install', shell = null, platform = process.platform) {
  shell ||= defaultCodexShell(process.env, platform);
  if (!supported.has(shell) || !['install', 'uninstall'].includes(action)) return null;
  const script = fileURLToPath(new URL('../../bin/codex-profile.js', import.meta.url));
  const q = platform === 'win32' ? psQuote : quote;
  const store = deckDataDir();
  const rc = platform === 'win32' && shell.startsWith('powershell') ? ' --rc $PROFILE.CurrentUserAllHosts' : '';
  return `${platform === 'win32' ? '& ' : ''}${q(process.execPath)} ${q(script)} ${action} --shell ${shell} --store ${q(store)}${rc}`;
}

async function rcFor(shell, home, env, platform) {
  if (shell === 'zsh') return join(env.ZDOTDIR?.trim() || home, '.zshrc');
  if (shell === 'bash') {
    if (platform === 'darwin') {
      for (const file of ['.bash_profile', '.bash_login', '.profile']) {
        const path = join(home, file);
        try { await stat(path); return path; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return join(home, '.bash_profile');
    }
    return join(home, '.bashrc');
  }
  const executable = shell === 'powershell5' ? 'powershell.exe' : 'pwsh.exe';
  const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-Command', '$PROFILE.CurrentUserAllHosts'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  const rc = stdout.trim();
  if (!isAbsolute(rc)) throw new Error('Could not locate the PowerShell profile. Supply --rc $PROFILE.CurrentUserAllHosts.');
  return rc;
}

function stripIntegration(text) {
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if (start < 0 && end < 0) return text;
  if (start < 0 || end < start || text.indexOf(BEGIN, start + BEGIN.length) >= 0 || text.indexOf(END, end + END.length) >= 0) {
    throw new Error('Terminal integration markers are incomplete. Repair the shell configuration first.');
  }
  return text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, '');
}
export async function configureCodexTerminal(action, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const shell = options.shell ?? defaultCodexShell(env, platform);
  if (!supported.has(shell) || !['install', 'uninstall'].includes(action)) throw new Error('Unsupported terminal integration');
  const home = options.home ?? homedir();
  const rc = options.rc ?? await rcFor(shell, home, env, platform);
  let previous = '';
  try { previous = await readFile(rc, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let next = stripIntegration(previous);
  if (action === 'install') {
    let executable = options.executable;
    if (!executable) {
      for (const name of process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']) {
        executable = pathLookup(name, process.platform);
        if (executable) break;
      }
    }
    if (!executable) throw new Error('Install Codex before enabling terminal selection.');
    await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    const data = options.store ?? deckDataDir(undefined, env, home);
    const directory = join(data, 'codex-terminal');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of ['codex-terminal-runner.mjs', 'exec-spec.mjs']) {
      await writeFileAtomic(join(directory, name), await readFile(new URL(`./${name}`, import.meta.url), 'utf8'));
      await chmod(join(directory, name), 0o600);
    }
    const runner = join(directory, 'codex-terminal-runner.mjs');
    const file = codexSelectionPath({ store: data });
    const node = options.node ?? process.execPath;
    const line = shell.startsWith('powershell')
      ? `function global:codex { & ${psQuote(node)} ${psQuote(runner)} ${psQuote(file)} ${psQuote(executable)} @args }`
      : `codex() { command ${quote(node)} ${quote(runner)} ${quote(file)} ${quote(executable)} "$@"; }`;
    next += `${next.endsWith('\n') || next === '' ? '' : '\n'}${BEGIN}\n${line}\n${END}\n`;
  }
  await mkdir(join(rc, '..'), { recursive: true });
  const target = await resolveWriteTarget(rc);
  await writeFileAtomic(target, next);
  // Only the new integration files are private. Preserve the user's shell-file
  // permissions and unrelated settings; authentication files are never opened.
  if (action === 'install') await chmod(join(options.store ?? deckDataDir(undefined, env, home), 'codex-terminal'), 0o700);
  return { shell, rc, action };
}
