// An npm registry made of a function, holding one ccusage and the native
// package for the machine running the suite — for the tests of the deck's own
// download of ccusage (ccusage-registry.mjs), so that none of them reaches the
// real registry.
//
// The tarballs are written the way npm writes them: a `package/` top
// directory, ustar headers, gzip, and a published sha512 that matches.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export type TarEntry = { name: string; body?: string; type?: string; mode?: number; link?: string };

export function tarHeader(name: string, size: number, type: string, mode: number, link = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(link, 157, 100, "utf8");
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

/** A gzipped tar of `entries`, as npm packs one. */
export function tgz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    const type = e.type ?? "0";
    const sized = type === "0" || type === "x" || type === "L";
    parts.push(tarHeader(e.name, sized ? body.length : 0, type, e.mode ?? 0o644, e.link));
    if (sized) parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** A pax extended header naming `path`, the way node-tar writes a long name. */
export function pax(path: string): TarEntry {
  const rest = ` path=${path}\n`;
  let len = rest.length + 2;
  while (`${len}${rest}`.length !== len) len++;
  return { name: "PaxHeader", type: "x", body: `${len}${rest}` };
}

export const sri = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** ccusage's native package for the machine running the suite, and the path of
 *  the binary inside it — the same names ccusage's own cli.js uses. */
export const NATIVE = `@ccusage/ccusage-${process.platform}-${process.arch}`;
export const NATIVE_BIN = process.platform === "win32" ? "bin/ccusage.exe" : "bin/ccusage";

export const REGISTRY = "https://reg.test";

/**
 * A registry holding one ccusage and its native package for this machine.
 *
 * `tamper` swaps a tarball's bytes after its integrity was published, and
 * `status` answers every request with that status. `asked` is every URL
 * requested, in order.
 */
export function fakeRegistry({ version = "20.1.0", tamper = "" as "" | "main" | "native", status = 200 } = {}) {
  const main = tgz([
    { name: "package/package.json", body: JSON.stringify({ name: "ccusage", version, bin: { ccusage: "./src/cli.js" } }) },
    { name: "package/src/cli.js", body: "// cli\n", mode: 0o755 },
  ]);
  const native = tgz([
    { name: "package/package.json", body: JSON.stringify({ name: NATIVE, version }) },
    { name: `package/${NATIVE_BIN}`, body: "binary", mode: 0o755 },
  ]);
  const served: Record<string, Buffer> = {
    [`${REGISTRY}/t/main.tgz`]: tamper === "main" ? tgz([{ name: "package/evil.js", body: "x" }]) : main,
    [`${REGISTRY}/t/native.tgz`]: tamper === "native" ? tgz([{ name: "package/evil", body: "x" }]) : native,
  };
  const latest = {
    name: "ccusage", version,
    dist: { tarball: `${REGISTRY}/t/main.tgz`, integrity: sri(main) },
    optionalDependencies: { [NATIVE]: version, "@ccusage/ccusage-other-arch": version },
  };
  const docs: Record<string, unknown> = {
    [`${REGISTRY}/ccusage/latest`]: latest,
    [`${REGISTRY}/ccusage/${version}`]: latest,
    [`${REGISTRY}/${NATIVE.replace("/", "%2F")}/${version}`]: {
      name: NATIVE, version,
      dist: { tarball: `${REGISTRY}/t/native.tgz`, integrity: sri(native) },
    },
  };
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(String(url));
    if (status !== 200) return new Response("nope", { status });
    if (url in docs) return new Response(JSON.stringify(docs[url]), { headers: { "content-type": "application/json" } });
    if (url in served) return new Response(new Uint8Array(served[url]));
    return new Response("not found", { status: 404 });
  };
  return { fetch, asked, base: REGISTRY };
}
