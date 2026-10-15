// Controlled hook runner: actual player code, simulated React/Audio/HLS/frame.
// Used by fm-player-lifecycle.test.ts; no browser or external stream assumed.
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

async function createHarness(repo, initial) {
  const repoRequire = createRequire(path.join(repo, 'package.json'));
  const { build } = repoRequire('esbuild');
  const { outputFiles } = await build({
    absWorkingDir: repo,
    entryPoints: ['src/web/use-fm-player.ts'],
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [{ name: 'audit-stubs', setup(b) {
      b.onResolve({ filter: /^(react|hls\.js)$|feature-use$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents:
        a.path === 'react' ? 'module.exports=globalThis.hooks' :
        a.path === 'hls.js' ? 'export default globalThis.Hls' :
        'export function useFeatureUse(){}' }));
    } }],
  });
  let props = initial, cells = [], index = 0, pending = [], dirty = true;
  let output, now = 0, timerId = 0, disposed = false;
  const timers = new Map(), listeners = new Set();
  const audio = [], hls = [], commands = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(v) {
      const i = index++;
      cells[i] ??= { value: typeof v === 'function' ? v() : v };
      return [cells[i].value, update => {
        if (disposed) return;
        const next = typeof update === 'function' ? update(cells[i].value) : update;
        if (!Object.is(next, cells[i].value)) { cells[i].value = next; dirty = true; }
      }];
    },
    useRef(v) { return cells[index++] ??= { current: v }; },
    useMemo(f, deps) {
      const i = index++;
      if (!cells[i] || !equal(cells[i].deps, deps)) cells[i] = { value: f(), deps };
      return cells[i].value;
    },
    useCallback(f, deps) { return hooks.useMemo(() => f, deps); },
    useEffect(f, deps) {
      const i = index++;
      if (!cells[i] || !equal(cells[i].deps, deps)) {
        cells[i] = { deps, cleanup: cells[i]?.cleanup };
        pending.push(() => { cells[i].cleanup?.(); cells[i].cleanup = f(); });
      }
    },
  };
  class Audio extends EventTarget {
    constructor() { super(); audio.push(this); this.plays = 0; this.pauses = 0; }
    play() { this.plays++; return Promise.resolve(); }
    pause() { this.pauses++; }
    removeAttribute() {}
    load() {}
    canPlayType() { return ''; }
  }
  class Hls {
    static Events = { ERROR: 'error', MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'parsed' };
    static isSupported() { return true; }
    constructor() { hls.push(this); this.events = new Map(); }
    on(e, f) { this.events.set(e, f); }
    emit(e, data = {}) { this.events.get(e)?.(e, data); }
    attachMedia(player) { this.player = player; this.emit('attached'); }
    loadSource(url) { this.url = url; }
    destroy() { this.destroyed = true; this.events.clear(); }
  }
  const context = {
    hooks, Hls, Audio, URL, DOMException, module: { exports: {} },
    setTimeout(f, ms) { timers.set(++timerId, { f, at: now + ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    window: {
      addEventListener(e, f) { if (e === 'message') listeners.add(f); },
      removeEventListener(e, f) { if (e === 'message') listeners.delete(f); },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(outputFiles[0].text, context);
  function flush() {
    if (disposed) return;
    for (let n = 0; dirty && n < 30; n++) {
      dirty = false; index = 0;
      output = context.module.exports.useFmPlayer(props);
      const effects = pending; pending = []; effects.forEach(f => f());
    }
    assert.equal(dirty, false, 'render loop did not settle');
  }
  function mountFrame() {
    output.frame.current = { contentWindow: {
      postMessage(json) { commands.push(JSON.parse(json)); },
    } };
    return output.frame.current.contentWindow;
  }
  flush();
  return {
    get p() { return output; }, audio, hls, commands, flush, mountFrame,
    get timerCount() { return timers.size; },
    get listenerCount() { return listeners.size; },
    update(next) { props = { ...props, ...next }; dirty = true; flush(); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); flush(); for (let n = 0; n < 20; n++) { await Promise.resolve(); flush(); } },
    press() { output.press(); flush(); },
    event(type, i = audio.length - 1) { audio[i].dispatchEvent(new Event(type)); flush(); },
    message(data, options = {}) {
      if (!output.frame.current) mountFrame();
      for (const f of [...listeners]) f({
        origin: options.origin ?? 'https://www.youtube-nocookie.com',
        source: options.source ?? output.frame.current.contentWindow, data,
      });
      flush();
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].f(); flush();
      }
      now = end;
    },
    dispose() { cells.forEach(c => c?.cleanup?.()); disposed = true; },
  };
}

module.exports = { createHarness };
