import { CaptureSetupError } from './traffic-radar-platform.mjs';
import { isIP } from 'node:net';

export function radarTargets(snapshot) {
  const configured = (snapshot?.config?.variables ?? []).filter(v => v.key.endsWith('ENDPOINT')).flatMap(({ value }) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && isIP(url.hostname) === 4
        ? [`${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`] : [];
    } catch { return []; }
  });
  // An arbitrary Claude HTTPS connection is not evidence of a collector.
  const observed = (snapshot?.connections ?? []).filter(c => c.active === true && /:4317$/.test(c.destination) && isIP(c.destination.slice(0, c.destination.lastIndexOf(':'))) === 4).map(c => c.destination);
  return { configured: [...new Set(configured)], observed: [...new Set(observed)] };
}

/** Own the feature preference independently of whether capture is ready yet. */
export function createRadarService({ capture, preferences, discover, pollMs = 5000 }) {
  let enabled = true, port = null, remembered = [], revision = 0, timer = null, disposed = false;
  let ready = Promise.resolve(), syncing = null, setupError = null;
  const settings = () => ({ ok: true, enabled, setupError });
  const save = () => preferences.write(port, { enabled, destinations: remembered });
  const stopLoop = () => { clearInterval(timer); timer = null; };
  const startLoop = () => {
    stopLoop();
    if (enabled && !disposed) { timer = setInterval(() => void sync(), pollMs); timer.unref?.(); }
  };
  async function sync() {
    if (!enabled || disposed || !port) return;
    if (syncing) return syncing;
    const operation = revision;
    syncing = (async () => {
      try {
        const { configured, observed } = radarTargets(await discover());
        if (operation !== revision || !enabled || disposed) return;
        const targets = [...new Set(configured.length ? configured : [...remembered, ...observed])].sort().slice(0, 8);
        if (!targets.length) { setupError = null; return; }
        const current = capture.read();
        const existing = (current.sources ?? []).map(s => s.destination).sort();
        if (current.enabled && JSON.stringify(existing) === JSON.stringify(targets)) { setupError = null; return; }
        await capture.prepare(targets, port);
        if (operation !== revision || !enabled || disposed) { await capture.stop('stopped', false); return; }
        remembered = targets;
        setupError = null;
        await save();
      } catch (error) {
        if (operation === revision && enabled && !disposed) setupError = error instanceof CaptureSetupError ? error.message : 'Monitoring setup failed. Retrying automatically.';
      }
    })().finally(() => { syncing = null; });
    return syncing;
  }
  return {
    ...capture,
    resume(requestedPort) {
      port = requestedPort;
      const operation = ++revision;
      ready = (async () => {
        const saved = await preferences.read(port);
        if (operation !== revision || disposed) return;
        enabled = saved?.enabled !== false;
        remembered = Array.isArray(saved?.destinations) ? saved.destinations.filter(v => typeof v === 'string' && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)).slice(0, 8) : [];
        if (!enabled) await capture.stop("stopped", false);
        startLoop();
      })();
      return ready.then(sync);
    },
    async settings() { await ready; return settings(); },
    async setEnabled(next) {
      if (typeof next !== 'boolean') throw new Error('Radar enabled must be a boolean.');
      await ready;
      if (!port || disposed) throw new Error('Radar is not ready.');
      const previous = enabled, operation = ++revision;
      enabled = next;
      stopLoop();
      if (!next) { setupError = null; await capture.stop('stopped', false); }
      try { await save(); }
      catch (error) {
        if (operation === revision) { enabled = previous; startLoop(); if (enabled) void sync(); }
        throw error;
      }
      if (operation === revision && enabled) {
        startLoop();
        // A slow older setup must finish/cancel before starting a new one.
        if (syncing) void syncing.then(sync); else void sync();
      }
      return settings();
    },
    async prepare(destination, requestedPort) {
      await ready;
      if (!enabled) throw new Error('Enable Radar in Settings first.');
      const operation = ++revision;
      const result = await capture.prepare(destination, requestedPort);
      if (operation !== revision || !enabled || disposed) { await capture.stop('stopped', false); throw new Error('Radar setup was cancelled.'); }
      remembered = Array.isArray(destination) ? destination : [destination];
      await save();
      return result;
    },
    stop() { return this.setEnabled(false); },
    read() {
      const value = capture.read();
      return { ...value, automatic: true, featureEnabled: enabled, setupError,
        state: !enabled ? 'stopped' : setupError && !value.enabled ? 'error' : value.state };
    },
    dispose() { disposed = true; revision++; stopLoop(); capture.dispose(); },
  };
}
