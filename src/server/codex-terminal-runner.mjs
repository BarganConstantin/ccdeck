// Copied with exec-spec.mjs into the durable terminal integration directory.
// No dependency on an npx cache, running server, or OAuth credential store.
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSpec } from './exec-spec.mjs';

export async function terminalCodexHome(file, env = process.env) {
  if (env.CODEX_HOME?.trim()) return env.CODEX_HOME;
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Codex account selection cannot be read. Repair it in ccdeck before launching.');
  }
  const selected = state?.profiles?.find(p => p.id === state.selectedProfileId);
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 1
    || !selected || typeof selected.home !== 'string' || !isAbsolute(selected.home)) {
    throw new Error('Codex account selection is invalid. Repair it in ccdeck before launching.');
  }
  let canonical;
  try {
    canonical = await realpath(selected.home);
    if (!(await stat(canonical)).isDirectory()) throw new Error();
  } catch { throw new Error('The selected Codex profile is unavailable. Restore it or select another in ccdeck.'); }
  if (createHash('sha256').update(canonical).digest('hex').slice(0, 20) !== selected.id) {
    throw new Error('The selected Codex profile changed location. Select it again in ccdeck.');
  }
  if (selected.managed) {
    const root = await realpath(join(dirname(file), 'codex-profiles'));
    if (dirname(canonical) !== root || !/^[a-f0-9]{32}$/.test(canonical.slice(root.length + 1))) {
      throw new Error('The selected Codex profile is invalid. Repair it in ccdeck before launching.');
    }
  }
  return selected.home;
}

export async function runSelectedCodex(file, executable, args, { env = process.env } = {}) {
  const home = await terminalCodexHome(file, env);
  const spec = spawnSpec(executable, args);
  const child = spawn(spec.file, spec.args, { ...spec.opts, stdio: 'inherit', env: home ? { ...env, CODEX_HOME: home } : env });
  // Terminal Ctrl+C already reaches both processes. Keep the wrapper alive
  // until the child exits; forwarding would deliver the signal twice.
  const hold = () => {};
  process.on('SIGINT', hold);
  const stop = () => child.kill('SIGTERM');
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code: code ?? (signal === 'SIGINT' ? 130 : 143), signal }));
    });
  } finally {
    process.removeListener('SIGINT', hold);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGHUP', stop);
  }
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1]).catch(() => null)) {
  const [file, executable, ...args] = process.argv.slice(2);
  if (!file || !executable) { console.error('Codex terminal integration is incomplete. Reinstall it from ccdeck.'); process.exitCode = 1; }
  else {
    try {
      let forwarded = args;
      if (args[0] === '--ccdeck-args-base64') {
        if (args.length !== 2) throw new Error('Invalid terminal argument envelope');
        forwarded = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8'));
        if (!Array.isArray(forwarded) || forwarded.some(arg => typeof arg !== 'string')) throw new Error('Invalid terminal argument envelope');
      }
      process.exitCode = (await runSelectedCodex(file, executable, forwarded)).code;
    }
    catch { console.error('Could not start the selected Codex account. Check the selection in ccdeck or reinstall terminal integration.'); process.exitCode = 1; }
  }
}
