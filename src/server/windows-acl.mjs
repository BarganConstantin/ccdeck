// The Windows reader the engine's trust gate asks (pro-engine-install.mjs
// trustGate): who this process runs as and whether it is elevated, and for a
// file or folder who owns it, who may write it and whether it is a reparse
// point or has a second hard link.
//
// Everything is asked of tools Windows ships, started by their absolute path
// under %SystemRoot% (never a PATH lookup), and answered in SIDs only, so no
// language or account naming changes a result. The target path reaches
// PowerShell through an environment variable and is never part of the script
// text. Every failure is a refusal: a non-zero exit, a timeout, output over the
// bound, JSON that does not parse, a field of the wrong type or a SID of an odd
// shape all throw an error that names neither a path nor a SID.
//
// Deny rules are ignored on purpose: this reports who can be GIVEN write, and
// the gate refuses on that, so a deny rule never cancels a grant here.
//
// NOT TESTED on a real Windows machine outside the CI runner: the unit tests run
// against a stand-in for the tool calls.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { win32 as winPath } from 'node:path';

export const ACL_TIMEOUT_MS = 10_000;
export const ACL_MAX_BYTES = 64 * 1024;
const SID = /^S-1-[0-9-]+$/;
const failed = () => new Error('The Windows file permissions could not be read.');

/** The folder Windows lives in, from the environment, as an absolute drive path. */
function systemRoot(env) {
  const root = env.SystemRoot;
  if (typeof root !== 'string' || !/^[A-Za-z]:[\\/]/.test(root) || root.includes('\0') || !winPath.isAbsolute(root)) throw failed();
  return root.replace(/[\\/]+$/, '');
}

/** The default `run`: no shell, a timeout, bounded output, no console window.
 *  Resolves `{ code, stdout }`; rejects when the tool cannot start, takes too
 *  long or says too much. */
export function boundedRun(file, args, { env, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout: timeoutMs, maxBuffer: maxBytes, windowsHide: true, shell: false, encoding: 'utf8' }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout });
      if (typeof error.code === 'number') return resolve({ code: error.code, stdout: typeof stdout === 'string' ? stdout : '' });
      reject(failed());
    });
    // Windows PowerShell waits for the end of its input when stdin is a pipe,
    // even with a command to run: it gets none.
    child.stdin?.end();
  });
}

/** Splits one CSV line of double-quoted fields. */
function csvFields(line) {
  const fields = [];
  const pattern = /"((?:[^"]|"")*)"|([^,]*)/y;
  let at = 0;
  while (at <= line.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(line);
    if (!match) break;
    fields.push(match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2]);
    at = pattern.lastIndex;
    if (line[at] !== ',') break;
    at += 1;
  }
  return fields;
}

// The mandatory integrity levels: Medium is 8192, High 12288, System 16384.
const HIGH_INTEGRITY = 12288;

// The rights that let someone change what the engine runs from: write data,
// append, write extended attributes and attributes, delete, delete children,
// change permissions, take ownership, and the unmapped generic write and all.
const WRITE_MASK = 0x500d0156;
// .NET calls and language statements only, no cmdlet: with the bare
// environment the child gets, finding a cmdlet can make PowerShell search
// every module on disk. The JSON is written out by hand; it holds SIDs and a
// boolean only, and every SID is checked again here. The script goes over as
// -EncodedCommand (UTF-16LE, base64), so no quoting rule of the command line
// can change it.
export const INSPECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$p = $env:CCDECK_ACL_PATH',
  '$attributes = [System.IO.File]::GetAttributes($p)',
  'if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) { $acl = [System.IO.Directory]::GetAccessControl($p) } else { $acl = [System.IO.File]::GetAccessControl($p) }',
  '$sid = [System.Security.Principal.SecurityIdentifier]',
  '$writers = [System.Collections.Generic.List[string]]::new()',
  'foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {',
  '  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }',
  '  if (([int]$rule.PropagationFlags -band 2) -ne 0) { continue }',
  `  if (([int]$rule.FileSystemRights -band ${WRITE_MASK}) -eq 0) { continue }`,
  '  $value = $rule.IdentityReference.Value',
  '  if (-not $writers.Contains($value)) { $writers.Add($value) }',
  '}',
  '$owner = $acl.GetOwner($sid).Value',
  '$reparse = if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { \'true\' } else { \'false\' }',
  '$quoted = foreach ($w in $writers) { \'"\' + $w + \'"\' }',
  '[Console]::Out.Write(\'{"owner":"\' + $owner + \'","writers":[\' + ($quoted -join \',\') + \'],"reparsePoint":\' + $reparse + \'}\')',
].join('\n');
const ENCODED_SCRIPT = Buffer.from(INSPECT_SCRIPT, 'utf16le').toString('base64');

/**
 * `run(file, args, { env, timeoutMs, maxBytes })` resolves `{ code, stdout }`
 * and rejects when it cannot run the tool; tests hand in their own. `env` is
 * the environment the system folder is read from.
 */
export function createWindowsAcl({ run = boundedRun, env = process.env } = {}) {
  const ask = async (file, args, extra = {}) => {
    const root = systemRoot(env);
    const childEnv = { SystemRoot: root, windir: root, ...extra };
    let answer;
    try {
      answer = await run(file(root), args, { env: childEnv, timeoutMs: ACL_TIMEOUT_MS, maxBytes: ACL_MAX_BYTES });
    } catch {
      throw failed();
    }
    if (!answer || answer.code !== 0 || typeof answer.stdout !== 'string' || answer.stdout.length > ACL_MAX_BYTES) throw failed();
    return answer.stdout;
  };
  const whoami = (...args) => ask((root) => `${root}\\System32\\whoami.exe`, [...args, '/fo', 'csv', '/nh']);

  return {
    async identity() {
      const userLine = (await whoami('/user')).split(/\r?\n/).find((line) => line.trim());
      const user = userLine ? csvFields(userLine.trim())[1] : undefined;
      if (typeof user !== 'string' || !SID.test(user)) throw failed();
      let level;
      for (const line of (await whoami('/groups')).split(/\r?\n/)) {
        for (const field of csvFields(line.trim())) {
          const match = /^S-1-16-(\d+)$/.exec(field);
          if (match) { level = Number(match[1]); break; }
        }
        if (level !== undefined) break;
      }
      if (!Number.isSafeInteger(level)) throw failed();
      return { user, elevated: level >= HIGH_INTEGRITY };
    },

    async inspect(target) {
      if (typeof target !== 'string' || !target || target.includes('\0')) throw failed();
      const text = await ask(
        (root) => `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-InputFormat', 'None', '-EncodedCommand', ENCODED_SCRIPT],
        { CCDECK_ACL_PATH: target },
      );
      let info;
      try { info = JSON.parse(text); } catch { throw failed(); }
      if (!info || typeof info !== 'object' || Array.isArray(info)) throw failed();
      const { owner, writers, reparsePoint } = info;
      if (typeof owner !== 'string' || !SID.test(owner)) throw failed();
      if (!Array.isArray(writers) || writers.some((w) => typeof w !== 'string' || !SID.test(w))) throw failed();
      if (typeof reparsePoint !== 'boolean') throw failed();
      const links = (await fs.lstat(target).catch(() => { throw failed(); })).nlink;
      if (!Number.isSafeInteger(links) || links < 1) throw failed();
      return { owner, writers, reparsePoint, links };
    },
  };
}
