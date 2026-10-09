import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { renameWithRetry } from './atomic-write.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Only destinations and the opt-in survive a restart. Tokens and packets never do.
export function capturePreferences(directory = join(homedir(), '.agents-deck')) {
  let writes = Promise.resolve();
  const file = port => join(directory, `radar-monitor-${port}.json`);
  return {
    async read(port) { try { return JSON.parse(await readFile(file(port), 'utf8')); } catch { return null; } },
    write(port, value) {
      writes = writes.catch(() => {}).then(async () => {
        await mkdir(directory, { recursive: true });
        const target = file(port), temp = target + `.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
        await chmod(temp, 0o600); await renameWithRetry(temp, target);
      });
      return writes;
    },
  };
}

const activeMonitors = new Set();
const stopAtExit = () => { for (const stop of activeMonitors) stop(); };

// A child per destination keeps pcap headers and TCP decoders independent.
// Retry after a crash or adapter change; an explicit stop cancels every retry.
export function monitorDestination({ platform, tool, host, port, resolveInterface, reset, ingest, status, launch = spawn, retryMs = 3000 }) {
  let stopped = false, child = null, retry = null, heartbeat = null, ready = false;
  const stopHeartbeat = () => { clearInterval(heartbeat); heartbeat = null; };
  const retryLater = () => { if (!stopped) { retry = setTimeout(start, retryMs); retry.unref?.(); } };
  async function start() {
    if (stopped) return;
    try {
      const iface = await resolveInterface(host);
      if (stopped) return;
      if (!iface) throw new Error('interface');
      reset(iface); ready = false;
      const args = platform === 'win32'
        ? ['-i', iface, '-F', 'pcap', '-s', '0', '-f', `host ${host} and tcp port ${port}`, '-w', '-']
        : ['-i', iface, '-nn', '-U', '-s', '0', '-w', '-', `host ${host} and tcp port ${port}`];
      child = launch(tool, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
      const capturing = child;
      let ended = false, error = '', stderr = '';
      const listening = () => {
        if (ready || stopped || ended) return;
        ready = true; status(null); ingest(Buffer.alloc(0));
        heartbeat = setInterval(() => { if (!stopped) ingest(Buffer.alloc(0)); }, 1000); heartbeat.unref?.();
      };
      const end = () => {
        if (ended) return; ended = true; stopHeartbeat(); capturing.stdout.destroy(); capturing.kill();
        if (!stopped) { status(error || 'Capture disconnected. Retrying automatically.'); retryLater(); }
      };
      child.stderr.on('data', bytes => {
        stderr = (stderr + bytes.toString()).slice(-4096);
        if (/permission|access.*denied|not permitted|administrator/i.test(stderr)) error = 'Packet capture permission is required.';
        if (/listening on|Capturing on/i.test(stderr)) listening();
      });
      child.stdout.on('data', bytes => {
        if (stopped) return;
        listening();
        for (let i = 0; i < bytes.length; i += 65536) ingest(bytes.subarray(i, i + 65536));
      });
      child.stdout.on('error', end);
      child.once('error', reason => { if (['EACCES', 'EPERM'].includes(reason.code)) error = 'Packet capture permission is required.'; end(); }); child.once('exit', end);
    } catch { if (!stopped) { status('Capture interface unavailable. Retrying automatically.'); retryLater(); } }
  }
  const stop = () => {
    stopped = true; clearTimeout(retry); stopHeartbeat(); child?.stdout.destroy(); child?.kill();
    activeMonitors.delete(stop); if (!activeMonitors.size) process.removeListener("exit", stopAtExit);
  };
  if (!activeMonitors.size) process.once("exit", stopAtExit);
  activeMonitors.add(stop); void start();
  return stop;
}
