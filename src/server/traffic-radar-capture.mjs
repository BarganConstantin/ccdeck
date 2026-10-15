import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { captureInterface, captureInterfaceValid, captureTool, CaptureSetupError } from './traffic-radar-platform.mjs';
import { monitorDestination, capturePreferences } from "./traffic-radar-monitor.mjs";
import { createWireCapture } from "./traffic-radar-wire.mjs";

const WINDOW = 24 * 60 * 60 * 1000;
const MAX_EXPORTS = 2000;

const MAX_CHARS = 32 * 1024 * 1024;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
export function captureDestination(value) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(String(value));
  if (!match || isIP(match[1]) !== 4 || +match[2] < 1 || +match[2] > 65535) throw new Error('Choose an IPv4 address and TCP port.');
  return { host: match[1], port: +match[2] };
}
export function exportSummary(payload, signal) {
  const group = signal === 'traces' ? 'Spans' : signal === 'logs' ? 'Logs' : 'Metrics';
  const item = signal === 'traces' ? 'spans' : signal === 'logs' ? 'logRecords' : 'metrics';
  const records = (payload['resource' + group] ?? []).flatMap(r => (r['scope' + group] ?? []).flatMap(s => s[item] ?? []));
  const fields = new Set(), sessionIds = new Set();
  const collect = attributes => {
    for (const a of attributes ?? []) if (['session.id', 'session_id'].includes(a.key)) {
      const id = a.value?.stringValue;
      if (typeof id === 'string' && id.length > 0 && id.length <= 200) sessionIds.add(id);
    }
  };
  for (const resource of payload['resource' + group] ?? []) {
    collect(resource.resource?.attributes);
    for (const scope of resource['scope' + group] ?? []) for (const record of scope[item] ?? []) {
      collect(record.attributes);
      for (const kind of ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'])
        for (const point of record[kind]?.dataPoints ?? []) collect(point.attributes);
    }
  }
  for (const record of records) for (const a of record.attributes ?? []) {
    if (/prompt/i.test(a.key)) fields.add('Prompt');
    if (/response|completion/i.test(a.key)) fields.add('Response');
    if (/tool/i.test(a.key)) fields.add('Tool');
  }
  return { count: records.length, name: String(records[0]?.eventName || records[0]?.name || signal).slice(0, 200), content: [...fields], sessionIds: [...sessionIds] };
}
export function createTrafficCapture({ now = Date.now, platform = process.platform, findInterface = host => captureInterface(host, platform), findTool = () => captureTool(platform), wire = createWireCapture, execPath = process.execPath, electron = !!process.versions.electron, managed = false, preferences = null, monitor = monitorDestination } = {}) {
  let session = null, parsers = [], timer = null, nextId = 1, chars = 0, evictedExports = 0;
  const events = new Map();
  let observations = [];
  let monitors = [], localPort = null, generation = 0;
  const persist = enabled => preferences && localPort ? preferences.write(localPort, { enabled, destinations: session?.sources.map(s => s.destination) ?? [] }) : Promise.resolve();
  function prune() {
    observations = observations.filter(entry => now() - entry.observedAt <= WINDOW);
    for (const [id, event] of events) if (now() - event.observedAt > WINDOW) { events.delete(id); chars -= event.chars; }
    if (session?.token && session.sources.some(s => s.lastInputAt !== null) &&
      session.sources.filter(s => s.lastInputAt !== null).every(s => now() - s.lastInputAt > 5000)) session.state = 'interrupted';
    if (!session?.token && !events.size && !observations.length && timer) { clearInterval(timer); timer = null; }
  }
  function stop(state = 'stopped', save = true) {
    generation++;
    for (const cancel of monitors) cancel(); monitors = [];
    const saved = save ? persist(false) : Promise.resolve();
    if (session) { session.state = state; session.token = null; for (const source of session.sources) source.command = null; }
    for (const parser of parsers) parser.close(); parsers = [];
    return saved;
  }
  function addExport(value) {
    const text = JSON.stringify(value.payload);
    const cost = Buffer.byteLength(text, 'utf8') + Buffer.byteLength(value.protobufBase64, 'utf8');
    if (cost > 1_000_000) { session.issues.payload_limit = (session.issues.payload_limit ?? 0) + 1; return null; }
    const id = nextId++;
    while (events.size >= MAX_EXPORTS || (chars + cost > MAX_CHARS && events.size)) {
      const first = events.keys().next().value; chars -= events.get(first).chars; events.delete(first);
      evictedExports++;
    }
    events.set(id, { ...value, id, observedAt: now(), chars: cost, ...exportSummary(value.payload, value.signal), outcome: 'unconfirmed', response: null });
    chars += cost;
    return id;
  }
  const api = {
    async prepare(destination, requestedPort) {
      const operation = ++generation;
      if (!['darwin', 'linux', 'win32'].includes(platform)) throw new CaptureSetupError('Live capture is available on macOS, Linux and Windows.');
      const targets = [...new Set((Array.isArray(destination) ? destination : [destination]).map(String))];
      if (!targets.length || targets.length > 8) throw new Error('Choose between one and eight destinations.');
      const addresses = targets.map(captureDestination);
      if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) throw new Error('Local ccdeck port unavailable.');
      const tool = await findTool();
      const names = await Promise.all(addresses.map(({ host }) => findInterface(host)));
      if (names.some(name => !captureInterfaceValid(name, platform))) throw new Error('Network interface unavailable. Check the destination and retry.');
      if (operation !== generation) throw new CaptureSetupError("Monitoring setup was cancelled.");
      stop("stopped", false); const activeGeneration = generation; localPort = requestedPort;
      prune();
      const token = randomBytes(32).toString('hex');
      const helper = fileURLToPath(new URL('./traffic-radar-helper.mjs', import.meta.url));
      const sources = addresses.map(({ host, port }, index) => {
        const filter = `host ${host} and tcp port ${port}`;
        let command = platform === 'win32'
          ? `& ${psQuote(execPath)} ${psQuote(helper)} --capture ${psQuote(tool)} ${psQuote(names[index])} ${psQuote(host)} ${port} ${psQuote(`http://127.0.0.1:${localPort}`)} ${psQuote(token)} ${index}`
          : `sudo ${quote(tool)} -i ${quote(names[index])} -nn -U -s 0 -w - ${quote(filter)} | ${quote(execPath)} ${quote(helper)} ${quote(`http://127.0.0.1:${localPort}`)} ${quote(token)} ${quote(index)}`;
        if (electron) command = platform === 'win32'
          ? `& { $previous=$env:ELECTRON_RUN_AS_NODE; try { $env:ELECTRON_RUN_AS_NODE='1'; ${command} } finally { $env:ELECTRON_RUN_AS_NODE=$previous } }`
          : command.replace(`| ${quote(execPath)}`, `| env ELECTRON_RUN_AS_NODE=1 ${quote(execPath)}`);
        return { destination: `${host}:${port}`, interface: names[index], command, lastInputAt: null, bytes: 0 };
      });
      session = { id: randomBytes(8).toString('hex'), state: 'awaiting', destination: sources[0].destination, interface: sources[0].interface,
        sources, startedAt: now(), expiresAt: null, lastInputAt: null, token, bytes: 0, issues: {} };
      const parser = ({ host, port }) => wire({ host, port, onExport: addExport, onResponse: (id, response) => {
        const event = events.get(id);
        if (event) { event.response = response; event.outcome = response.outcome; }
      }, onObservation: value => { observations.unshift({ id: nextId++, ...value, observedAt: now() }); observations = observations.slice(0, MAX_EXPORTS); }, onIssue: code => { session.issues[code] = (session.issues[code] ?? 0) + 1; } });
      parsers = addresses.map(parser);
      await persist(true);
      if (activeGeneration !== generation) throw new CaptureSetupError("Monitoring setup was cancelled.");
      if (managed) monitors = addresses.map(({ host, port }, index) => monitor({ platform, tool, host, port, resolveInterface: findInterface,
        reset: iface => { parsers[index]?.close(); parsers[index] = parser({ host, port }); session.sources[index].interface = iface; },
        ingest: bytes => api.ingest(token, bytes, index),
        status: error => { const source = session.sources[index]; source.error = error; if (error) { source.lastInputAt = null; session.state = 'interrupted'; } },
      }));
      if (!timer) { timer = setInterval(prune, 1000); timer.unref?.(); }
      return { command: sources[0].command, commands: sources.map(({ command, destination }) => ({ command, destination })), expiresAt: session.expiresAt, sessionId: session.id };
    },
    async resume(port) {
      const operation = generation;
      localPort = port;
      const saved = await preferences?.read(port);
      if (operation !== generation) return;
      if (saved?.enabled && Array.isArray(saved.destinations)) {
        try { await api.prepare(saved.destinations, port); }
        catch { session = { state: "error", sources: [], issues: {}, token: null }; }
      }
    },
    accepts(token) {
      prune();
      return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && !!session?.token
        && timingSafeEqual(Buffer.from(token), Buffer.from(session.token));
    },
    ingest(token, chunk, source = 0) {
      if (!this.accepts(token)) return false;
      if (chunk.length > 262_144) throw new Error('Capture chunk too large.');
      if (!Number.isInteger(source) || !parsers[source]) return false;
      session.sources[source].lastInputAt = now();
      session.sources[source].bytes += chunk.length;
      session.lastInputAt = now();
      if (chunk.length && (!managed || session.sources[source].bytes > 24)) session.state = 'capturing';
      else if (['awaiting', 'interrupted'].includes(session.state)) session.state = 'receiving';
      session.bytes += chunk.length;
      try { parsers[source].feed(chunk); } catch { void stop('error').catch(() => {}); return false; }
      return true;
    },
    read() {
      prune();
      return { ok: true, managed, enabled: !!session?.token, platform, backend: platform === 'win32' ? 'dumpcap' : 'tcpdump', shell: platform === 'win32' ? 'PowerShell' : 'Terminal', sessionId: session?.id ?? null, state: session?.state ?? 'idle', destination: session?.destination ?? null, interface: session?.interface ?? null,
        startedAt: session?.startedAt ?? null, expiresAt: session?.expiresAt ?? null, lastInputAt: session?.lastInputAt ?? null,
        sources: session?.sources.map(({ command, ...source }) => ({ ...source, active: source.lastInputAt !== null && now() - source.lastInputAt <= 5000 && !!session.token })) ?? [],
        observations: [...observations],
        retention: { windowMs: WINDOW, maxExports: MAX_EXPORTS, payloadBudgetBytes: MAX_CHARS, evictedExports },
        bytes: session?.bytes ?? 0, issues: { ...session?.issues },
        events: [...events.values()].reverse().map(({ payload, protobufBase64, chars, flow, ...event }) => event),
      };
    },
    detail(id) { prune(); const event = events.get(id); return event ? { payload: event.payload, protobufBase64: event.protobufBase64 } : null; },
    stop,
    clear() { events.clear(); observations = []; chars = 0; evictedExports = 0; },
    dispose() { stop("stopped", false); events.clear(); observations = []; if (timer) clearInterval(timer); timer = null; },
  };
  return api;
}
export const trafficCapture = createTrafficCapture({ managed: true, preferences: capturePreferences() });
