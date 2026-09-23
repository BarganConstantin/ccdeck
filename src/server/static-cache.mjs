// How the deck serves its own UI: compressed when the browser takes it, and
// cached for good when a file's name is its content (#883).
//
// Every static response went out uncompressed and marked `no-cache`, the 833 KB
// bundle included — so every reload, and every deck opened from another machine
// on the LAN, fetched the whole of it again at full size. Vite names every file
// under assets/ by a hash of its content, which means such a file can never
// change under its name: it is cached for a year and marked immutable. The files
// that name them — index.html above all — stay no-cache, because they are what
// moves when the deck upgrades itself.
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** The types worth compressing; images and fonts are compressed already. */
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".map", ".webmanifest"]);

/** Vite's output under assets/: `<name>-<hash>.<ext>`, the hash eight or more
 *  characters of base64url. */
const HASHED = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** The Cache-Control for a path relative to the web root, as the URL spells it. */
export function cacheControlFor(rel) {
  return HASHED.test(rel) ? "public, max-age=31536000, immutable" : "no-cache";
}

/** Does an Accept-Encoding header take `encoding`? A `q=0` is a refusal. */
function accepts(header, encoding) {
  for (const part of String(header ?? "").split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (name.trim().toLowerCase() !== encoding) continue;
    const q = params.map(p => p.trim()).find(p => p.startsWith("q="));
    return q ? Number(q.slice(2)) > 0 : true;
  }
  return false;
}

/** The encoding to send a file of this extension in, or null for none. Brotli
 *  first — about 15% smaller than gzip on this bundle — and gzip for the rest. */
export function pickEncoding(acceptEncoding, ext) {
  if (!COMPRESSIBLE.has(ext)) return null;
  if (accepts(acceptEncoding, "br")) return "br";
  if (accepts(acceptEncoding, "gzip")) return "gzip";
  return null;
}

/** Compressed bytes, made once per file, build and encoding. The key carries the
 *  file's mtime, so a rebuild is a new entry rather than a stale one; the set of
 *  files is the dist folder's, so the cache is as big as the build and no bigger.
 *  Quality 9 rather than 11: the first request after a build pays for it, and 11
 *  costs seconds there for a percent or two. */
const encodedCache = new Map();

export function encodedBody(filePath, mtimeMs, buf, encoding) {
  const key = `${encoding}\0${mtimeMs}\0${filePath}`;
  let out = encodedCache.get(key);
  if (!out) {
    out = encoding === "br"
      ? brotliCompressSync(buf, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 9,
            [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
          },
        })
      : gzipSync(buf, { level: 6 });
    encodedCache.set(key, out);
  }
  return out;
}
