import hpack from "hpack.js";
import protobuf from "protobufjs/light.js";
import schema from "./traffic-radar-otlp.json";
import Long from "long";

protobuf.util.Long = Long;
protobuf.configure();
protobuf.Reader.recursionLimit = 32;
const root = protobuf.Root.fromJSON(schema);
const types = { logs: "Logs", metrics: "Metrics", traces: "Trace" };
export function decodeOtlp(signal, direction, bytes) {
  const group = signal === "traces" ? "trace" : signal;
  const name = `opentelemetry.proto.collector.${group}.v1.Export${types[signal]}Service${direction === "request" ? "Request" : "Response"}`;
  const type = root.lookupType(name);
  return type.toObject(type.decode(bytes), { longs: String, bytes: String, enums: String, json: true });
}

export function headerDecoder() {
  const decoder = hpack.decompressor.create({ table: { maxSize: 4096 } });
  let error = null;
  decoder.on("error", value => { error = value; });
  return bytes => {
    if (error) throw new Error("headers_unavailable");
    decoder.write(bytes);
    decoder.execute();
    if (error) throw new Error("headers_unavailable");
    const headers = Object.create(null);
    let header;
    while ((header = decoder.read()) !== null) {
      if ([":method", ":path", ":status", "grpc-status", "grpc-encoding", "content-type"].includes(header.name)) headers[header.name] = header.value;
    }
    return headers;
  };
}
