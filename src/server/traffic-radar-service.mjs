import { CaptureSetupError } from './traffic-radar-platform.mjs';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export function radarTargets(snapshot) {
  // A running Claude's launch environment names a collector as settings do.
  const variables = [...(snapshot?.config?.variables ?? []), ...(snapshot?.environment ?? [])];
  const configured = [], named = [];
  for (const { key, value } of variables) {
    if (!key.endsWith('ENDPOINT')) continue;
    let url;
    try { url = new URL(value); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    if (isIP(url.hostname) === 4) configured.push(`${url.hostname}:${port}`);
    // A name is looked up before capture (resolveCollector); an IPv6 literal,
    // which URL keeps in brackets, is neither.
    else if (url.hostname && !url.hostname.startsWith('[')) named.push(`${url.hostname}:${port}`);
  }
  // An arbitrary Claude HTTPS connection is not evidence of a collector, nor an
  // attempt nothing has answered.
  const observed = (snapshot?.connections ?? []).filter(c => c.active === true && !c.connecting && /:4317$/.test(c.destination) && isIP(c.destination.slice(0, c.destination.lastIndexOf(':'))) === 4).map(c => c.destination);
  return { configured: [...new Set(configured)], named: [...new Set(named)], observed: [...new Set(observed)] };
}

/** A collector named by host, such as otel.example.com:4317, as the IPv4
 *  address Claude reaches it at. Capture filters on an address, and with no
 *  destination picker any more a name is the only way such a collector is
 *  found. A lookup that fails or hangs past `ms` names nothing. */
export async function resolveCollector(target, find = lookup, ms = 2000) {
  const at = target.lastIndexOf(':');
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(resolve, ms, null); timer.unref?.(); });
  try {
    const found = await Promise.race([find(target.slice(0, at), { family: 4 }).catch(() => null), late]);
    return found && isIP(found.address) === 4 ? `${found.address}:${target.slice(at + 1)}` : null;
  } finally { clearTimeout(timer); }
}

const savedDestinations = value => Array.isArray(value)
  ? value.filter(v => typeof v === 'string' && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)).slice(0, 8) : [];

/** Radar monitors by itself, always: there is no switch and no Start (the
 *  owner, 2026-10-23, reversing v3.44.0's opt-in). The service finds Claude
 *  Code's collector — configured endpoints first, named ones looked up, then the
 *  collectors it remembers and active OTLP/gRPC connections on port 4317 — and
 *  keeps capture on it, retrying while none is found or capture is not ready.
 *
 *  Discovery samples Claude's processes (ps and lsof, /proc, or PowerShell), so
 *  every deck pays for it: it runs every `pollMs` only while Radar is open,
 *  which the page shows by reading the capture, and every `idleMs` otherwise.
 *  `radar-settings-<port>.json` keeps the collectors found, so a restart goes
 *  back to them; a monitor started by hand in an earlier release resumes too,
 *  and is where discovery looks first when no setting names a collector. */
export function createRadarService({ capture, preferences, discover, resolve = resolveCollector, pollMs = 5000, idleMs = 60000, openMs = 15000, now = Date.now }) {
  let port = null, remembered = [], timer = null, disposed = false;
  let syncing = null, setupError = null, syncedAt = -Infinity, readAt = -Infinity;
  const save = () => preferences.write(port, { destinations: remembered });
  async function sync() {
    if (disposed || !port) return;
    if (syncing) return syncing;
    syncedAt = now();
    syncing = (async () => {
      try {
        const { configured, named, observed } = radarTargets(await discover());
        const looked = (await Promise.all(named.map(target => resolve(target)))).filter(Boolean);
        if (disposed) return;
        const settings = [...configured, ...looked];
        const targets = [...new Set(settings.length ? settings : [...remembered, ...observed])].sort().slice(0, 8);
        if (!targets.length) { setupError = null; return; }
        const current = capture.read();
        const existing = (current.sources ?? []).map(s => s.destination).sort();
        if (current.enabled && JSON.stringify(existing) === JSON.stringify(targets)) { setupError = null; return; }
        await capture.prepare(targets, port);
        // A setup that lands after the deck shut the service down must not
        // leave a monitor running, or one that resumes after a restart.
        if (disposed) { await capture.stop('stopped', false); return; }
        remembered = targets;
        setupError = null;
        await save();
      } catch (error) {
        if (!disposed) setupError = error instanceof CaptureSetupError ? error.message : 'Monitoring setup failed. Retrying automatically.';
      }
    })().finally(() => { syncing = null; });
    return syncing;
  }
  const tick = () => { if (now() - readAt < openMs || now() - syncedAt >= idleMs) void sync(); };
  return {
    ...capture,
    async resume(requestedPort) {
      port = requestedPort;
      const saved = await preferences.read(port);
      if (disposed) return;
      remembered = savedDestinations(saved?.destinations);
      await capture.resume(port);
      if (disposed) return;
      if (!remembered.length) remembered = savedDestinations((capture.read().sources ?? []).map(s => s.destination));
      clearInterval(timer);
      timer = setInterval(tick, pollMs); timer.unref?.();
      return sync();
    },
    /** Start capture again now: permission was just granted (traffic-radar-permission.mjs). */
    async retry() {
      setupError = null;
      const running = (capture.read().sources ?? []).map(s => s.destination);
      if (!running.length || disposed || !port) return sync();
      try { await capture.prepare(running, port); }
      catch (error) { setupError = error instanceof CaptureSetupError ? error.message : 'Monitoring setup failed. Retrying automatically.'; }
    },
    read() {
      // Radar is open: look now rather than waiting out the idle interval.
      readAt = now();
      if (now() - syncedAt >= pollMs) void sync();
      const value = capture.read();
      return { ...value, automatic: true, featureEnabled: true, setupError,
        state: setupError && !value.enabled ? 'error' : value.state };
    },
    dispose() { disposed = true; clearInterval(timer); timer = null; capture.dispose(); },
  };
}
