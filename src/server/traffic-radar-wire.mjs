import { gunzipSync } from "node:zlib";
import { decodeOtlp, headerDecoder } from "./traffic-radar-codec.mjs";

const LIMIT = 262_144;
const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const PATHS = Object.fromEntries([['logs', 'Logs'], ['metrics', 'Metrics'], ['traces', 'Trace']].map(([signal, name]) => [
  `/opentelemetry.proto.collector.${signal === 'traces' ? 'trace' : signal}.v1.${name}Service/Export`, signal,
]));

export function createWireCapture({ host, port, onExport, onResponse, onIssue }) {
  let pending = Buffer.alloc(0);
  let read32, link, nanos;
  const flows = new Map();
  const issue = code => onIssue(code);
  function direction() {
    return { next: null, queue: new Map(), buffer: Buffer.alloc(0), headers: headerDecoder(), block: null };
  }
  function discard(key, code) { flows.delete(key); issue(code); }
  function payload(stream, side, bytes, at, flow, id) {
    const key = side === 'out' ? 'request' : 'response';
    stream[key] = Buffer.concat([stream[key] ?? Buffer.alloc(0), bytes]);
    if (stream[key].length > LIMIT) throw new Error('payload_limit');
    while (stream[key].length >= 5) {
      const size = stream[key].readUInt32BE(1);
      if (size > LIMIT) throw new Error('payload_limit');
      if (stream[key].length < size + 5) return;
      const compressed = stream[key][0];
      let body = stream[key].subarray(5, 5 + size);
      stream[key] = stream[key].subarray(5 + size);
      if (compressed > 1) throw new Error('unsupported_protocol');
      if (compressed) {
        if (stream[side + 'Encoding'] !== 'gzip') throw new Error('unsupported_compression');
        body = gunzipSync(body, { maxOutputLength: LIMIT });
      }
      if (!stream.signal) throw new Error('unknown_export');
      const data = decodeOtlp(stream.signal, key, body);
      if (side === 'out') {
        if (stream.eventId) throw new Error('unsupported_protocol');
        stream.eventId = onExport({ at, signal: stream.signal, destination: `${host}:${port}`, bytes: size + 5, payload: data, protobufBase64: body.toString('base64'), flow: flow.key, stream: id });
      } else {
        stream.responseDecoded = true;
        stream.partial = data.partialSuccess ?? null;
      }
    }
  }
  function finishResponse(stream, at) {
    if (!stream.eventId) return;
    const status = stream.grpcStatus;
    const partial = stream.partial;
    const rejected = partial && Object.entries(partial).find(([key]) => key.startsWith('rejected'))?.[1];
    const outcome = status === '0' && stream.httpStatus === '200' && stream.responseDecoded ? (partial?.errorMessage || (rejected && rejected !== '0') ? 'partial' : 'accepted')
      : status !== undefined && status !== '0' ? 'rejected' : 'unknown';
    onResponse(stream.eventId, { outcome, at, grpcStatus: status ?? null, rejected: rejected ?? null, message: partial?.errorMessage ?? null });
  }
  function headers(flow, side, id, bytes, end, at) {
    const values = flow[side].headers(bytes);
    const stream = flow.streams.get(id) ?? {};
    if (!flow.streams.has(id)) {
      if (flow.streams.size >= 32) throw new Error('stream_limit');
      flow.streams.set(id, stream);
    }
    if (side === 'out' && values[':path']) {
      if (values[':method'] !== 'POST' || !values['content-type']?.startsWith('application/grpc')) throw new Error('unknown_export');
      stream.signal = PATHS[values[':path']];
    }
    if (values['grpc-encoding']) stream[side + 'Encoding'] = values['grpc-encoding'];
    if (side === 'in' && values['grpc-status'] !== undefined) stream.grpcStatus = values['grpc-status'];
    if (side === 'in' && values[':status']) stream.httpStatus = values[':status'];
    if (side === 'in' && end) { finishResponse(stream, at); flow.streams.delete(id); }
  }
  function frames(flow, side, bytes, at) {
    const d = flow[side];
    d.buffer = Buffer.concat([d.buffer, bytes]);
    if (d.buffer.length > LIMIT * 2) throw new Error('stream_limit');
    if (!flow.ready) {
      if (side === 'in') return;
      if (d.buffer[0] === 22) throw new Error('encrypted');
      if (!PREFACE.subarray(0, Math.min(PREFACE.length, d.buffer.length)).equals(d.buffer.subarray(0, PREFACE.length))) throw new Error('joined_midstream');
      if (d.buffer.length < PREFACE.length) return;
      d.buffer = d.buffer.subarray(PREFACE.length);
      flow.ready = true;
      frames(flow, 'in', Buffer.alloc(0), at);
    }
    while (d.buffer.length >= 9) {
      const length = d.buffer.readUIntBE(0, 3), type = d.buffer[3], flags = d.buffer[4], id = d.buffer.readUInt32BE(5) & 0x7fffffff;
      if (length > LIMIT || type > 9) throw new Error('unsupported_protocol');
      if (d.buffer.length < length + 9) return;
      let body = d.buffer.subarray(9, 9 + length);
      d.buffer = d.buffer.subarray(9 + length);
      if (d.block && (type !== 9 || id !== d.block.id)) throw new Error('capture_gap');
      if (type === 0 || type === 1) {
        if (flags & 8) {
          const pad = body[0];
          if (pad === undefined || pad >= body.length) throw new Error('capture_gap');
          body = body.subarray(1, body.length - pad);
        }
        if (type === 1 && (flags & 32)) {
          if (body.length < 5) throw new Error('capture_gap');
          body = body.subarray(5);
        }
      }
      if (type === 1) {
        if (flags & 4) headers(flow, side, id, body, flags & 1, at);
        else d.block = { id, bytes: Buffer.from(body), end: flags & 1 };
      } else if (type === 9) {
        if (!d.block) throw new Error('capture_gap');
        d.block.bytes = Buffer.concat([d.block.bytes, body]);
        if (d.block.bytes.length > 65_536) throw new Error('stream_limit');
        if (flags & 4) { const b = d.block; d.block = null; headers(flow, side, id, b.bytes, b.end, at); }
      } else if (type === 0) {
        const stream = flow.streams.get(id);
        if (!stream) throw new Error('unknown_export');
        payload(stream, side, body, at, flow, id);
        if (side === 'in' && (flags & 1)) { finishResponse(stream, at); flow.streams.delete(id); }
      } else if (type === 3) {
        const stream = flow.streams.get(id);
        if (stream?.eventId) onResponse(stream.eventId, { outcome: 'reset', at, grpcStatus: null, rejected: null, message: null });
        flow.streams.delete(id);
      } else if (type === 7) {
        throw new Error('connection_closed');
      }
    }
    let buffered = flow.out.buffer.length + flow.in.buffer.length;
    for (const stream of flow.streams.values()) buffered += (stream.request?.length ?? 0) + (stream.response?.length ?? 0);
    if (buffered > LIMIT * 4) throw new Error('stream_limit');
  }
  function tcp(packet, at) {
    let offset = 0;
    if (link === 1) {
      if (packet.length < 14) return;
      let protocol = packet.readUInt16BE(12); offset = 14;
      for (let tag = 0; tag < 2 && [0x8100, 0x88a8].includes(protocol); tag++) {
        if (packet.length < offset + 4) return;
        protocol = packet.readUInt16BE(offset + 2); offset += 4;
      }
      if (protocol !== 0x800) { issue('unsupported_network'); return; }
    } else if ([0, 108].includes(link)) offset = 4;
    else if (link === 113) offset = 16;
    else if (link === 276) offset = 20;
    else if (link !== 101 && link !== 12) { issue('unsupported_link'); return; }
    if (packet.length < offset + 20 || packet[offset] >> 4 !== 4) { issue('unsupported_network'); return; }
    const ip = packet.subarray(offset);
    const ihl = (ip[0] & 15) * 4, total = ip.readUInt16BE(2);
    if (ihl < 20 || total < ihl || ip.length < total) { issue('capture_gap'); return; }
    if (ip[9] !== 6) return;
    if (ip.readUInt16BE(6) & 0x3fff) { issue('fragmented'); return; }
    const src = [...ip.subarray(12, 16)].join('.'), dst = [...ip.subarray(16, 20)].join('.');
    const t = ip.subarray(ihl, total);
    if (t.length < 20) { issue('capture_gap'); return; }
    const srcPort = t.readUInt16BE(0), dstPort = t.readUInt16BE(2);
    const side = dst === host && dstPort === port ? 'out' : src === host && srcPort === port ? 'in' : null;
    if (!side) return;
    const key = side === 'out' ? `${src}:${srcPort}` : `${dst}:${dstPort}`;
    for (const [k, f] of flows) if (at - f.at > 60_000) discard(k, 'idle_connection');
    let flow = flows.get(key);
    const syn = !!(t[13] & 2), ack = !!(t[13] & 16);
    if (syn && !ack) flows.delete(key);
    if (!flow || (syn && !ack)) {
      if (flows.size >= 16) discard(flows.keys().next().value, 'connection_limit');
      flow = { key, at, ready: false, out: direction(), in: direction(), streams: new Map(), ignored: false };
      flows.set(key, flow);
    }
    flow.at = at;
    const size = (t[12] >> 4) * 4;
    if (size < 20 || size > t.length) { discard(key, 'capture_gap'); return; }
    const body = t.subarray(size), d = flow[side];
    let seq = (t.readUInt32BE(4) + (syn ? 1 : 0)) >>> 0;
    if (syn && d.next === null) d.next = seq;
    if (body.length && !flow.ignored) {
      if (d.next === null) d.next = seq;
      const delta = (seq - d.next) | 0;
      if (delta > 0) {
        d.queue.set(seq, Buffer.from(body));
        let queued = 0; for (const b of d.queue.values()) queued += b.length;
        if (d.queue.size > 32 || queued > LIMIT) discard(key, 'capture_gap');
        return;
      }
      const part = delta < 0 ? body.subarray(-delta) : body;
      if (part.length) {
        d.next = (d.next + part.length) >>> 0;
        try {
          frames(flow, side, part, at);
          while (d.queue.size) {
            const next = [...d.queue.keys()].find(n => ((n - d.next) | 0) <= 0);
            if (next === undefined) break;
            const p = d.queue.get(next); d.queue.delete(next);
            const remainder = p.subarray(Math.max(0, (d.next - next) | 0));
            if (remainder.length) { d.next = (d.next + remainder.length) >>> 0; frames(flow, side, remainder, at); }
          }
        } catch (error) {
          issue(['encrypted', 'joined_midstream', 'payload_limit', 'stream_limit', 'unsupported_compression', 'unknown_export', 'connection_closed'].includes(error.message) ? error.message : 'decode_failed');
          flow.ignored = true;
          flow.out.buffer = flow.in.buffer = Buffer.alloc(0);
          flow.out.queue.clear(); flow.in.queue.clear(); flow.streams.clear();
        }
      }
    }
    if (t[13] & 5) flows.delete(key);
  }
  return {
    feed(chunk) {
      if (chunk.length > LIMIT) throw new Error('capture_chunk_limit');
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > LIMIT * 2) throw new Error('capture_buffer_limit');
      if (!read32) {
        if (pending.length < 24) return;
        const magic = pending.subarray(0, 4).toString('hex');
        if (!['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic)) throw new Error('pcap_required');
        nanos = ['4d3cb2a1', 'a1b23c4d'].includes(magic);
        read32 = magic.startsWith('a1') ? b => b.readUInt32BE() : b => b.readUInt32LE();
        link = read32(pending.subarray(20));
        if (![0, 1, 12, 101, 108, 113, 276].includes(link)) throw new Error('unsupported_link');
        pending = pending.subarray(24);
      }
      while (pending.length >= 16) {
        const size = read32(pending.subarray(8));
        if (size > LIMIT) throw new Error('packet_limit');
        if (pending.length < size + 16) return;
        const at = read32(pending) * 1000 + read32(pending.subarray(4)) / (nanos ? 1e6 : 1000);
        if (size !== read32(pending.subarray(12))) issue('capture_gap');
        else tcp(pending.subarray(16, 16 + size), at);
        pending = pending.subarray(size + 16);
      }
    },
    close() { pending = Buffer.alloc(0); flows.clear(); },
  };
}
