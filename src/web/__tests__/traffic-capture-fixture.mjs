import hpack from 'hpack.js';
import protobuf from 'protobufjs/light.js';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const root = protobuf.Root.fromJSON(JSON.parse(readFileSync(new URL('../../server/traffic-radar-otlp.json', import.meta.url), 'utf8')));
const words = { logs: 'Logs', metrics: 'Metrics', traces: 'Trace' };
export function proto(signal, payload, response = false) {
  const type = root.lookupType(`opentelemetry.proto.collector.${signal === 'traces' ? 'trace' : signal}.v1.Export${words[signal]}Service${response ? 'Response' : 'Request'}`);
  return Buffer.from(type.encode(type.fromObject(payload)).finish());
}
export const LOGS = { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'synthetic-test' } }] }, scopeLogs: [{ scope: { name: 'test-instrumentation' }, logRecords: [{ eventName: 'claude_code.user_prompt', body: { stringValue: 'Synthetic fixture — not real user traffic' }, attributes: [{ key: 'prompt', value: { stringValue: 'Explain this synthetic example.' } }, { key: 'session.id', value: { stringValue: 'fixture-session' } }] }] }] }] };
export function grpc(body, compressed = false) {
  const bytes = compressed ? gzipSync(body) : body;
  const header = Buffer.alloc(5); header[0] = +compressed; header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
export function frame(type, flags, stream, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(9); header.writeUIntBE(body.length, 0, 3); header[3] = type; header[4] = flags; header.writeUInt32BE(stream, 5);
  return Buffer.concat([header, body]);
}
export function headers(values) {
  const encoder = hpack.compressor.create({ table: { maxSize: 4096 } });
  encoder.write(Object.entries(values).map(([name, value]) => ({ name, value })));
  return encoder.read();
}
export function request(signal = 'logs', payload = LOGS, compressed = false) {
  return Buffer.concat([Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'), frame(4, 0, 0), frame(1, 4, 1, headers({ ':method': 'POST', ':path': `/opentelemetry.proto.collector.${signal === 'traces' ? 'trace' : signal}.v1.${words[signal]}Service/Export`, 'content-type': 'application/grpc', ...(compressed ? { 'grpc-encoding': 'gzip' } : {}) })), frame(0, 1, 1, grpc(proto(signal, payload), compressed))]);
}
export function response(signal = 'logs', partial = null, status = '0') {
  return Buffer.concat([frame(4, 0, 0), frame(1, 4, 1, headers({ ':status': '200', 'content-type': 'application/grpc' })), frame(0, 0, 1, grpc(proto(signal, partial ? { partialSuccess: partial } : {}, true))), frame(1, 5, 1, headers({ 'grpc-status': status }))]);
}
export function packet(bytes, { side = 'out', seq = 1000, flags = 24, at = 1700000000000, source = '192.0.2.10', host = '192.0.2.16', port = 4317 } = {}) {
  const eth = Buffer.alloc(14); eth.writeUInt16BE(0x800, 12);
  const ip = Buffer.alloc(20); ip[0] = 0x45; ip[9] = 6; ip.writeUInt16BE(40 + bytes.length, 2);
  const src = side === 'out' ? source : host, dst = side === 'out' ? host : source;
  Buffer.from(src.split('.').map(Number)).copy(ip, 12); Buffer.from(dst.split('.').map(Number)).copy(ip, 16);
  const tcp = Buffer.alloc(20); tcp.writeUInt16BE(side === 'out' ? 50000 : port); tcp.writeUInt16BE(side === 'out' ? port : 50000, 2); tcp.writeUInt32BE(seq >>> 0, 4); tcp[12] = 0x50; tcp[13] = flags;
  const data = Buffer.concat([eth, ip, tcp, bytes]);
  const record = Buffer.alloc(16); record.writeUInt32LE(Math.floor(at / 1000)); record.writeUInt32LE((at % 1000) * 1000, 4); record.writeUInt32LE(data.length, 8); record.writeUInt32LE(data.length, 12);
  return Buffer.concat([record, data]);
}
export function pcap(...packets) {
  const h = Buffer.alloc(24); h.writeUInt32LE(0xa1b2c3d4); h.writeUInt16LE(2, 4); h.writeUInt16LE(4, 6); h.writeUInt32LE(262144, 16); h.writeUInt32LE(1, 20);
  return Buffer.concat([h, ...packets]);
}
