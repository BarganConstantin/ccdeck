import { CaptureSetupError } from './traffic-radar-platform.mjs';
import { isIP } from 'node:net';

export function radarTargets(snapshot) {
  // A running Claude's launch environment names a collector as settings do.
  const variables = [...(snapshot?.config?.variables ?? []), ...(snapshot?.environment ?? [])];
  const configured = variables.filter(v => v.key.endsWith('ENDPOINT')).flatMap(({ value }) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && isIP(url.hostname) === 4
        ? [`${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`] : [];
    } catch { return []; }
  });
  // An arbitrary Claude HTTPS connection is not evidence of a collector, nor an
  // attempt nothing has answered.
  const observed = (snapshot?.connections ?? []).filter(c => c.active === true && !c.connecting && /:4317$/.test(c.destination) && isIP(c.destination.slice(0, c.destination.lastIndexOf(':'))) === 4).map(c => c.destination);
  return { configured: [...new Set(configured)], observed: [...new Set(observed)] };
}

const savedDestinations = value => Array.isArray(value)
  ? value.filter(v => typeof v === 'string' && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)).slice(0, 8) : [];

/** Own the automatic-monitoring preference independently of whether capture is ready yet.
 *
 *  AUTOMATIC MONITORING IS OPT-IN. `enabled` here is Settings › Radar's switch,
 *  kept in its own file (`preferences`, radar-settings-<port>.json) and on only
 *  where that file says `automatic: true`. A fresh deck, and a deck upgraded
 *  from a release that never wrote the file, has it off: nothing is discovered,
 *  nothing is retried, and the capture behaves exactly as it did before, with
 *  the person choosing a destination and starting it in Radar's Monitor view
 *  (`capture.prepare`/`capture.stop`, which keep their own radar-monitor-<port>
 *  .json opt-in and resume a monitor the person started, as they always did).
 *  Only while the switch is on does the service find the collector itself and
 *  retry every `pollMs`. */
export function createRadarService({ capture, preferences, discover, pollMs = 5000 }) {
  let enabled = false, port = null, remembered = [], revision = 0, timer = null, disposed = false;
  let ready = Promise.resolve(), syncing = null, setupError = null;
  const settings = () => ({ ok: true, enabled, setupError });
  const save = () => preferences.write(port, { automatic: enabled, destinations: remembered });
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
        // Stopped with its opt-in saved off: a setup that lands after the switch
        // went off must not leave a monitor that resumes after a restart.
        if (operation !== revision || !enabled || disposed) { await capture.stop('stopped', !disposed); return; }
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
        enabled = saved?.automatic === true;
        remembered = savedDestinations(saved?.destinations);
        if (enabled) startLoop();
        // Off: the capture's own opt-in, as before — a monitor resumes only
        // where the person started one and did not stop it.
        else await capture.resume(port);
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
      if (next) {
        // A monitor the person started by hand is where automatic monitoring
        // looks first when Claude's settings name no collector.
        const running = (capture.read().sources ?? []).map(s => s.destination);
        if (running.length) remembered = savedDestinations(running);
      } else { setupError = null; await capture.stop(); }
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
      // Off: the Monitor view's own Start, unchanged.
      if (!enabled) return capture.prepare(destination, requestedPort);
      const operation = ++revision;
      const result = await capture.prepare(destination, requestedPort);
      if (operation !== revision || !enabled || disposed) { await capture.stop('stopped', !disposed); throw new Error('Radar setup was cancelled.'); }
      remembered = Array.isArray(destination) ? destination : [destination];
      await save();
      return result;
    },
    // Off, Stop monitoring is the Monitor view's, as before; on, stopping is
    // turning automatic monitoring off.
    stop(...args) { return enabled ? this.setEnabled(false) : capture.stop(...args); },
    read() {
      const value = capture.read();
      if (!enabled) return { ...value, automatic: false };
      return { ...value, automatic: true, featureEnabled: true, setupError,
        state: setupError && !value.enabled ? 'error' : value.state };
    },
    dispose() { disposed = true; revision++; stopLoop(); capture.dispose(); },
  };
}
