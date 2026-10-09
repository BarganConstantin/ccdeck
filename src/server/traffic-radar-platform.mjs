// OS-specific inspection stays here; the Radar history and decoder share one model.
import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export function systemCommand(file, args) {
  return new Promise(resolve => execFile(file, args, { timeout: 8000, maxBuffer: 262144, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
    if (!error || (file === '/usr/sbin/lsof' && error.code === 1 && !stdout && !stderr)) resolve(stdout);
    else resolve(null);
  }));
}
export const powershell = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + script];
export const WINDOWS_PROCESSES = "Get-Process | Where-Object { $_.ProcessName -in @('claude','claude-native') } | ForEach-Object { '{0} {1}' -f $_.Id,$_.ProcessName }";
export function windowsSockets(pids) {
  return `$ids=@(${pids.join(',')}); Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Established' -and $_.OwningProcess -in $ids } | ForEach-Object { $peer=$_.RemoteAddress; if($peer.Contains(':')){$peer='['+$peer+']'}; 'p'+$_.OwningProcess; 'nlocal->'+$peer+':'+$_.RemotePort }`;
}

// /proc avoids an ss/lsof dependency and reads socket ownership only for selected Claude PIDs.
export async function linuxSockets(pids, { read = readFile, list = readdir, link = readlink } = {}) {
  const sockets = [], cwd = [];
  let unavailable = false;
  await Promise.all(pids.map(async pid => {
    try {
      const descriptors = await list(`/proc/${pid}/fd`);
      const owned = new Set((await Promise.all(descriptors.map(fd => link(`/proc/${pid}/fd/${fd}`).catch(() => ''))))
        .map(value => /^socket:\[(\d+)\]$/.exec(value)?.[1]).filter(Boolean));
      for (const family of ['tcp', 'tcp6']) {
        const table = await read(`/proc/${pid}/net/${family}`, 'utf8');
        for (const row of table.trim().split('\n').slice(1)) {
          const fields = row.trim().split(/\s+/);
          if (fields[3] !== '01' || !owned.has(fields[9])) continue;
          const [hex, port] = fields[2].split(':');
          const bytes = Buffer.from(hex, 'hex');
          for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
          const address = family === 'tcp' ? [...bytes].join('.') : '[' + Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':') + ']';
          sockets.push(`p${pid}\nnlocal->${address}:${parseInt(port, 16)}`);
        }
      }
      const path = await link(`/proc/${pid}/cwd`).catch(() => null);
      if (path) cwd.push(`p${pid}\nn${path}`);
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unavailable = true; }
  }));
  return { sockets: unavailable ? null : sockets.join('\n'), cwd: cwd.join('\n') };
}
export function captureInterfaceValid(name, platform) {
  return typeof name === 'string' && (platform === 'win32'
    ? /^\\Device\\NPF_(?:Loopback|\{[a-fA-F0-9-]{36}\})$/.test(name)
    : /^[a-zA-Z0-9_.:-]{1,32}$/.test(name));
}
export async function captureInterface(host, platform, run = systemCommand) {
  if (platform === 'linux') return 'any'; // tcpdump's cooked capture includes loopback and every routed adapter.
  if (platform === 'darwin') {
    const text = await run('/sbin/route', ['-n', 'get', host]);
    return /interface:\s+([a-zA-Z0-9_.:-]{1,32})/.exec(text ?? '')?.[1] ?? null;
  }
  if (platform === 'win32') {
    if (host.startsWith('127.')) return '\\Device\\NPF_Loopback';
    const text = await run('powershell.exe', powershell(`$route=Find-NetRoute -RemoteIPAddress '${host}'; $index=($route | Select-Object -First 1).InterfaceIndex; $adapter=Get-NetAdapter -IncludeHidden | Where-Object { $_.ifIndex -eq $index } | Select-Object -First 1; '\\Device\\NPF_{'+$adapter.InterfaceGuid.ToString().Trim('{}')+'}'`));
    return text?.trim() ?? null;
  }
  return null;
}
export function dumpcapPath(env = process.env, exists = existsSync) {
  for (const root of [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files']) {
    if (!root) continue;
    const file = win32.join(root, 'Wireshark', 'dumpcap.exe');
    if (exists(file)) return file;
  }
  return 'dumpcap.exe'; // Custom installs may expose it on PATH.
}
export class CaptureSetupError extends Error {}
export async function captureTool(platform, run = systemCommand) {
  const file = platform === 'win32' ? dumpcapPath() : platform === 'darwin' ? '/usr/sbin/tcpdump' : 'tcpdump';
  if (await run(file, [platform === 'win32' ? '-v' : '--version']) === null)
    throw new CaptureSetupError(platform === 'win32' ? 'Install Wireshark with Npcap to capture traffic, then retry. Configuration and file inspection work without it.' : 'Install tcpdump to capture traffic, then retry. Configuration and file inspection work without it.');
  if (platform === 'win32' && await run(file, ['-D']) === null)
    throw new CaptureSetupError('Npcap interfaces are unavailable. Check that Npcap is installed and its capture permissions allow this user.');
  return file;
}
