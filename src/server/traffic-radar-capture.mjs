import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { createWireCapture } from "./traffic-radar-wire.mjs";

const WINDOW = 300_000;
const DURATION = 600_000;
const MAX_CHARS = 4_000_000;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function captureDestination(value) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(String(value));
  if (!match || isIP(match[1]) !== 4 || +match[2] < 1 || +match[2] > 65535) throw new Error('Choose an IPv4 address and TCP port.');
  return { host: match[1], port: +match[2] };
}
async function networkInterface(host) {
  return new Promise(resolve => execFile('/sbin/route', ['-n', 'get', host], { timeout: 2000, maxBuffer: 16_384 }, (error, stdout) => {
    const name = !error && /interface:\s+([a-zA-Z0-9_.:-]{1,32})/.exec(stdout)?.[1];
    resolve(name || null);
  }));
}
function summary(payload, signal) {
  const group = signal === 'traces' ? 'Spans' : signal === 'logs' ? 'Logs' : 'Metrics';
  const item = signal === 'traces' ? 'spans' : signal === 'logs' ? 'logRecords' : 'metrics';
  const records = (payload['resource' + group] ?? []).flatMap(r => (r['scope' + group] ?? []).flatMap(s => s[item] ?? []));
  const fields = new Set();
  for (const record of records) for (const a of record.attributes ?? []) {
    if (/prompt/i.test(a.key)) fields.add('Prompt');
    if (/response|completion/i.test(a.key)) fields.add('Response');
    if (/tool/i.test(a.key)) fields.add('Tool');
  }
  return { count: records.length, name: String(records[0]?.eventName || records[0]?.name || signal).slice(0, 200), content: [...fields] };
}
export function createTrafficCapture({ now = Date.now, platform = process.platform, findInterface = networkInterface, wire = createWireCapture } = {}) {
  let session = null, parser = null, timer = null, nextId = 1, chars = 0;
  const events = new Map();
  function prune() {
    for (const [id, event] of events) if (now() - event.observedAt > WINDOW) { events.delete(id); chars -= event.chars; }
    if (session?.token && now() >= session.expiresAt) stop('expired');
    else if (['receiving', 'capturing'].includes(session?.state) && now() - session.lastInputAt > 5000) stop('interrupted');
    if (!session?.token && !events.size && timer) { clearInterval(timer); timer = null; }
  }
  function stop(state = 'stopped') {
    if (session) { session.state = state; session.token = null; session.command = null; }
    parser?.close(); parser = null;
  }
  function addExport(value) {
    const text = JSON.stringify(value.payload);
    const cost = text.length + value.protobufBase64.length;
    if (cost > 1_000_000) { session.issues.payload_limit = (session.issues.payload_limit ?? 0) + 1; return null; }
    const id = nextId++;
    while (events.size >= 100 || (chars + cost > MAX_CHARS && events.size)) {
      const first = events.keys().next().value; chars -= events.get(first).chars; events.delete(first);
    }
    events.set(id, { ...value, id, observedAt: now(), chars: cost, ...summary(value.payload, value.signal), outcome: 'unconfirmed', response: null });
    chars += cost;
    return id;
  }
  return {
    async prepare(destination, localPort) {
      if (platform !== 'darwin') throw new Error('Passive capture setup is available on macOS.');
      const { host, port } = captureDestination(destination);
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('Local ccdeck port unavailable.');
      const name = await findInterface(host);
      if (!name || !/^[a-zA-Z0-9_.:-]{1,32}$/.test(name)) throw new Error('Network interface unavailable. Check the destination and retry.');
      stop(); events.clear(); chars = 0;
      const token = randomBytes(32).toString('hex');
      const helper = fileURLToPath(new URL('./traffic-radar-helper.mjs', import.meta.url));
      const filter = `host ${host} and tcp port ${port}`;
      const command = `sudo /usr/sbin/tcpdump -i ${quote(name)} -nn -U -s 0 -w - ${quote(filter)} | ${quote(process.execPath)} ${quote(helper)} ${quote(`http://127.0.0.1:${localPort}`)} ${quote(token)}`;
      session = { id: randomBytes(8).toString('hex'), state: 'awaiting', destination: `${host}:${port}`, interface: name, startedAt: now(), expiresAt: now() + DURATION, lastInputAt: null, token, command, bytes: 0, issues: {} };
      parser = wire({ host, port, onExport: addExport, onResponse: (id, response) => {
        const event = events.get(id);
        if (event) { event.response = response; event.outcome = response.outcome; }
      }, onIssue: code => { session.issues[code] = (session.issues[code] ?? 0) + 1; } });
      if (!timer) { timer = setInterval(prune, 1000); timer.unref?.(); }
      return { command, expiresAt: session.expiresAt, sessionId: session.id };
    },
    accepts(token) {
      prune();
      return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && !!session?.token
        && timingSafeEqual(Buffer.from(token), Buffer.from(session.token));
    },
    ingest(token, chunk) {
      if (!this.accepts(token)) return false;
      if (chunk.length > 262_144) throw new Error('Capture chunk too large.');
      session.lastInputAt = now();
      if (chunk.length) session.state = 'capturing';
      else if (session.state === 'awaiting') session.state = 'receiving';
      session.bytes += chunk.length;
      try { parser.feed(chunk); } catch { stop('error'); return false; }
      return true;
    },
    read() {
      prune();
      return { ok: true, sessionId: session?.id ?? null, state: session?.state ?? 'idle', destination: session?.destination ?? null, interface: session?.interface ?? null,
        startedAt: session?.startedAt ?? null, expiresAt: session?.expiresAt ?? null, lastInputAt: session?.lastInputAt ?? null,
        bytes: session?.bytes ?? 0, issues: { ...session?.issues },
        events: [...events.values()].reverse().map(({ payload, protobufBase64, chars, flow, ...event }) => event),
      };
    },
    detail(id) { prune(); const event = events.get(id); return event ? { payload: event.payload, protobufBase64: event.protobufBase64 } : null; },
    stop,
    clear() { events.clear(); chars = 0; },
    dispose() { stop(); events.clear(); if (timer) clearInterval(timer); timer = null; },
  };
}
export const trafficCapture = createTrafficCapture();
