// Run the same npm test command on every platform. On an elevated Windows
// runner, create user-owned fixtures through an isolated child token rather
// than relaxing the production SID/DACL checks for Administrators-owned files.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extra = process.argv.slice(2);
const windows = process.platform === 'win32';
// PowerShell 7's inherited module path cannot be loaded by Windows PowerShell
// 5.1. Let the fixed OS shell discover its own modules before launching npm.
const windowsEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
const child = windows
  ? spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('./windows-test-owner.ps1', import.meta.url)),
    '-NodePath', process.execPath,
    '-ArgumentsBase64', Buffer.from(JSON.stringify([join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'test', '--', ...extra])).toString('base64'),
    '-WorkingDirectory', process.cwd(),
  ], { env: windowsEnvironment, stdio: 'inherit', windowsHide: true, shell: false })
  : spawn('npm', ['test', '--', ...extra], { stdio: 'inherit', shell: false });
child.once('error', () => { console.error('Unable to start the CI test process.'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
