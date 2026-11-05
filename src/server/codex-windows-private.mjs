// Windows has no POSIX UID/O_NOFOLLOW contract. The fixed PowerShell helper
// checks the current token SID and a handle's DACL, never path-supplied code.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';

const runFile = promisify(execFile);
const helper = fileURLToPath(new URL('./codex-windows-private.ps1', import.meta.url));
const unsafe = () => Object.assign(new Error('windows_private_path_unsafe'), { code: 'windows_private_path_unsafe' });
// The first Windows PowerShell invocation compiles the fixed Win32 helper.
// Compilation on a contended Windows host can exceed ten seconds. This only
// bounds helper startup; the ACL/reparse checks and native RPC limits stay intact.
const deadline = options => Math.max(1, Math.min(30000, options.timeoutMs ?? 30000));
function command(path, operation, options) {
  if ((options.platform ?? process.platform) !== 'win32' || typeof path !== 'string'
    || !/^(?:[a-z]:\\|\\\\\?\\[a-z]:\\)/i.test(path) || /[\x00-\x1f"<>|]/.test(path)
    || path.replace(/^\\\\\?\\/, '').slice(2).includes(':')) throw unsafe();
  const kind = options.kind ?? 'directory';
  if (!['directory', 'file', 'socket'].includes(kind)) throw unsafe();
  // Use the OS copy, not a powershell.exe supplied by PATH or the profile cwd.
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return { file: win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Operation', operation, '-TargetPath', path, '-Kind', kind] };
}
function result(stdout) {
  const value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (typeof value.path !== 'string' || !value.path || value.path.includes('\0')) throw unsafe();
  return value;
}
async function check(path, operation, options) {
  try {
    const spec = command(path, operation, options);
    const output = await (options.execFile ?? runFile)(spec.file, spec.args,
      { timeout: deadline(options), maxBuffer: 16 * 1024, windowsHide: true, shell: false });
    return result(output.stdout);
  } catch { throw unsafe(); }
}
/** Create with a protected inheritable current-user DACL atomically. Existing
 * directories must already be private; their permissions are never repaired.
 * execFile is an async (file, args, options) => { stdout } test seam.
 */
export const ensureWindowsPrivateDirectory = async (path, options = {}) => (await check(path, 'ensure', { ...options, kind: 'directory' })).path;
// Only the explicit Share repair may tighten an existing profile.
export const protectWindowsCodexLogin = async (path, options = {}) => (await check(path, 'protect-login', { ...options, kind: 'directory' })).path;
// The caller validates the native identity before using this local snapshot.
// Do not use check()/result(): login material must never become path metadata.
export async function snapshotWindowsCodexLogin(path, options = {}) {
  try {
    const spec = command(path, 'snapshot-login', { ...options, kind: 'directory' });
    const output = await (options.execFile ?? runFile)(spec.file, spec.args,
      { timeout: deadline(options), maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false });
    return JSON.parse(output.stdout.replace(/^\uFEFF/, ''));
  } catch { throw unsafe(); }
}
export const assertWindowsPrivatePath = async (path, options = {}) => (await check(path, 'check', options)).path;
export async function inspectWindowsPrivateSocket(path, options = {}) {
  const value = await check(path, 'check', { ...options, kind: 'socket' });
  if (typeof value.generation !== 'string' || !/^\d+(?::\d+){4}$/.test(value.generation)) throw unsafe();
  return value;
}

/** Pin the checked directory (and a regular file, when requested) until release.
 * The helper holds handles without FILE_SHARE_DELETE; file guards also exclude
 * writers. A bounded startup and lifetime prevent abandoned helpers lingering.
 */
export async function holdWindowsPrivatePath(path, options = {}) {
  let child;
  try {
    const spec = command(path, 'hold', options);
    child = (options.spawnChild ?? spawn)(spec.file, spec.args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    let alive = true;
    child.on('exit', () => { alive = false; });
    child.on('error', () => { alive = false; });
    child.stdin.on('error', () => {});
    const captured = await new Promise((ready, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(unsafe()), deadline(options));
      const finish = fn => value => { clearTimeout(timer); fn(value); };
      child.once('error', finish(() => reject(unsafe())));
      child.once('exit', finish(() => reject(unsafe())));
      child.stdout.on('data', data => {
        output += data.toString('utf8');
        if (output.length > 16 * 1024) { clearTimeout(timer); reject(unsafe()); }
        else if (output.includes('\n')) {
          try { finish(ready)(result(output)); } catch { finish(reject)(unsafe()); }
        }
      });
    });
    let released = false, expired = false, releasing;
    const release = () => {
      if (released) return releasing;
      released = true; clearTimeout(lifetime);
      releasing = new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(resolve, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.stdin.destroy(); child.kill();
      });
      return releasing;
    };
    // Covers cold native startup and the subsequent bounded ACL rechecks.
    const lifetime = setTimeout(() => { expired = true; release(); }, 120000); lifetime.unref();
    return { path: captured.path, generation: captured.generation, valid: () => alive && !released && !expired && child.exitCode === null && child.signalCode === null,
      release };
  } catch { child?.stdin?.destroy(); child?.kill(); throw unsafe(); }
}
