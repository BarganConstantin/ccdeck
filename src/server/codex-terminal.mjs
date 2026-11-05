import { createRequire } from 'node:module';
import { readFile, mkdir, chmod, access, stat, cp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { deckDataDir } from './deck-home.mjs';
import { codexSelectionPath } from './codex-selection.mjs';
import { resolveWriteTarget, writeFileAtomic } from './atomic-write.mjs';
import { pathLookup } from './exec-spec.mjs';
import { hookRuntime } from './app-host.mjs';

const BEGIN = '# >>> ccdeck Codex accounts >>>';
const END = '# <<< ccdeck Codex accounts <<<';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const psNodeMode = command => `$ccdeckPreviousNodeMode = $env:ELECTRON_RUN_AS_NODE; try { $env:ELECTRON_RUN_AS_NODE = '1'; ${command} } finally { $env:ELECTRON_RUN_AS_NODE = $ccdeckPreviousNodeMode }`;
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
  const command = `${platform === 'win32' ? '& ' : ''}${q(hookRuntime())} ${q(script)} ${action} --shell ${shell} --store ${q(store)}${rc}`;
  return platform === 'win32' ? `& { ${psNodeMode(command)} }` : `ELECTRON_RUN_AS_NODE=1 ${command}`;
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
  return powershellProfile(shell);
}

async function powershellProfile(shell) {
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
    // Keep Node's package lookup inside the durable helper. An unrelated
    // package.json above the data directory must not prevent startup.
    const manifest = join(directory, 'package.json');
    await writeFileAtomic(manifest, JSON.stringify({ private: true, type: 'module' }) + '\n');
    await chmod(manifest, 0o600);
    for (const name of ['codex-terminal-runner.mjs', 'exec-spec.mjs', 'account-engine.mjs', 'codex-engine-adapter.mjs', 'codex-handoff.mjs',
      'codex-interactive-engine.mjs', 'codex-engine-config.mjs', 'codex-engine-rpc.mjs', 'codex-engine-bridge.mjs',
      'codex-auto.mjs', 'codex-selection.mjs', 'codex-profiles.mjs', 'codex-lan-identity.mjs', 'codex-native-account.mjs',
      'codex-auth.mjs', 'codex-dir.mjs', 'deck-home.mjs', 'claude-dir.mjs', 'atomic-write.mjs', 'brand.mjs', 'exec-children.mjs']) {
      await writeFileAtomic(join(directory, name), await readFile(new URL(`./${name}`, import.meta.url), 'utf8'));
      await chmod(join(directory, name), 0o600);
    }
    // Keep the RFC6455 implementation and its MIT notice with the durable helper.
    const wsPackage = dirname(createRequire(import.meta.url).resolve('ws/package.json'));
    await cp(wsPackage, join(directory, 'node_modules', 'ws'), { recursive: true, force: true });
    const runner = join(directory, 'codex-terminal-runner.mjs');
    const file = codexSelectionPath({ store: data });
    const node = options.node ?? hookRuntime(env);
    const line = shell.startsWith('powershell')
      // Windows PowerShell's native argv conversion strips embedded quotes and
      // empty arguments. Transport strings as JSON/base64, then spawn normally.
      ? `function global:codex { $ccdeckCodexArgs = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject ([string[]]@($args)) -Compress))); ${psNodeMode(`& ${psQuote(node)} ${psQuote(runner)} ${psQuote(file)} ${psQuote(executable)} --ccdeck-args-base64 $ccdeckCodexArgs`)} }`
      : `codex() { ELECTRON_RUN_AS_NODE=1 command ${quote(node)} ${quote(runner)} ${quote(file)} ${quote(executable)} "$@"; }`;
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

/**
 * For `--uninstall`: take the block Enable terminal selection wrote out of every
 * shell profile it may be in, and the helper it calls with it.
 *
 * Nothing records which shell the person set it up in (they ran the command
 * themselves), so every profile `rcFor` can pick is read: zsh's in ZDOTDIR and
 * in the home folder, bash's on Linux and the three macOS picks the first of
 * (an earlier setup may have picked another), and on Windows both PowerShells'.
 * Left behind, the block outlives ccdeck: `codex` runs through a helper that
 * the desktop app's removal takes away, and it no longer starts.
 *
 * A file whose markers are incomplete is not touched and is named, and so is a
 * PowerShell whose profile could not be asked for. The helper goes only when
 * every profile was read and none still holds a block, since a block left
 * anywhere still calls it. Answers { removed, refused, kept, helper, directory }.
 */
export async function removeCodexTerminalEverywhere(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const store = options.store ?? deckDataDir(undefined, env, home);
  const profileOf = options.powershellProfile ?? powershellProfile;
  const candidates = [];
  const zdot = env.ZDOTDIR?.trim();
  if (zdot) candidates.push(join(zdot, '.zshrc'));
  candidates.push(...['.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'].map(name => join(home, name)));
  const removed = [], refused = [];
  if (platform === 'win32') {
    for (const shell of ['powershell', 'powershell5']) {
      try { candidates.push(await profileOf(shell)); }
      // A PowerShell that is not installed has no profile to clean.
      catch (error) {
        if (error?.code !== 'ENOENT') refused.push({ path: shell === 'powershell5' ? 'the Windows PowerShell profile' : 'the PowerShell profile', why: error?.message ?? String(error) });
      }
    }
  }
  for (const rc of new Set(candidates)) {
    let text;
    try { text = await readFile(rc, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') refused.push({ path: rc, why: error.message });
      continue;
    }
    if (!text.includes(BEGIN) && !text.includes(END)) continue;
    try {
      await writeFileAtomic(await resolveWriteTarget(rc), stripIntegration(text));
      removed.push(rc);
    } catch (error) {
      refused.push({ path: rc, why: error.message });
    }
  }
  const directory = join(store, 'codex-terminal');
  let helper = false;
  const kept = refused.length > 0;
  if (!kept) {
    try {
      await stat(directory);
      await rm(directory, { recursive: true, force: true });
      helper = true;
    } catch (error) {
      if (error.code !== 'ENOENT') refused.push({ path: directory, why: error.message });
    }
  }
  return { removed, refused, kept, helper, directory };
}
