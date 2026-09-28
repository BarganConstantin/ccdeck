// The deck's own page: dist/web served off disk, compressed and cached by name
// (#883), with index.html standing in for any path a client-side route owns.
//
// This lived in src/server/index.mjs — the type table near the top, the
// handler after the event stream's writers. It reads nothing of the server's,
// so it moved whole; the route table still decides what reaches it. The
// handler is unchanged.
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { send } from "./http-io.mjs";
import { cacheControlFor, encodedBody, pickEncoding } from "./static-cache.mjs";

// Resolved the way index.mjs resolves its package root, from a file in the same
// directory.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB_DIST = resolve(PKG_ROOT, "dist", "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  // The type is the whole of how a browser recognises a manifest: served as
  // application/octet-stream — which is what the fallback below hands anything
  // unlisted — Chrome fetches it, declines to parse it, and offers no install,
  // with nothing in the console that names the reason.
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".woff2": "font/woff2",
  ".map":  "application/json",
};

async function serveStatic(req, res, url) {
  // Strip leading slash, default to index.html
  let rel = url.pathname.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel = `${rel}index.html`;
  const filePath = join(WEB_DIST, rel);
  if (!filePath.startsWith(WEB_DIST)) return send(res, 403, { error: "forbidden" });

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) return send(res, 404, { error: "not found" });
    const buf = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    // Compressed when the browser takes it, and cached for good when the name
    // is a content hash (#883) — see static-cache.mjs. `rel` is the URL's own
    // spelling, forward slashes on every platform, which is what the hash
    // pattern reads; `filePath` is only the cache key.
    const encoding = pickEncoding(req.headers["accept-encoding"], ext);
    const body = encoding ? encodedBody(filePath, s.mtimeMs, buf, encoding) : buf;
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": cacheControlFor(rel),
      "Vary": "Accept-Encoding",
      "Content-Length": body.length,
      ...(encoding ? { "Content-Encoding": encoding } : {}),
    });
    res.end(body);
  } catch {
    // SPA fallback to index.html for client-side routes
    try {
      const idx = await readFile(join(WEB_DIST, "index.html"));
      // Same no-cache as the normal path above, which this used to omit. It
      // matters more since the deck upgrades itself: index.html is the file
      // naming the hashed bundle, so a heuristically-cached copy sends the tab
      // back to the OLD assets after an update and the reload achieves nothing.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(idx);
    } catch {
      send(res, 404, { error: "ui not built. run `pnpm build` or `npm run build`." });
    }
  }
}

// What the route table calls. Listed rather than marked at the declaration, so
// the declaration reads as it did where it came from.
export { serveStatic };
