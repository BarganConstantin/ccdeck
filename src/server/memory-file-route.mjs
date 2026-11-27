// GET /api/session/memory-file?session=<id>&provider=<claude|codex>&path=<path>
// The Inspector's Context tab shows one memory file a session has in scope
// (CLAUDE.md, CLAUDE.local.md, an auto-memory file, or AGENTS.md for Codex),
// read-only, as plain text.
//
// THE PATH IS ONLY A NAME TO LOOK UP. The memory scan (memory-files.mjs) runs
// again for the session's working directory on every request, and the request
// is answered only when its path is one the scan lists now, written the same
// way, or `~/` and the rest of a listed path under the home directory (how
// Claude Code's /context prints a user file). What is opened is the listed
// path, never one built from the request. The session id is a key into the
// scope the enrichment passes noted (session-enrichment.mjs memoryScope).
//
// THE SAME ANSWER FOR EVERYTHING REFUSED once the request is well formed: a
// session the deck does not know, a path not listed, a file gone, one that is
// not a regular file, one whose real path is not a .md file (CLAUDE.md is
// often a link to AGENTS.md, which is fine; a link to anything else is not),
// one swapped between the check and the open, or one with a NUL byte in what
// was read. All 404 `not_found`, so the route never says which files exist.
//
// THE SAME GATES AS THE TRANSCRIPT ROUTE (session-transcript-routes.mjs): the
// path is in GUARDED_READS, and a request that did not come from this computer
// is refused here as well, so a paired deck never reads these files.
//
// BOUNDED. At most MEMORY_FILE_MAX bytes are read; a larger file is answered
// with its start, cut back to the last whole UTF-8 character, and
// `truncated: true`.
import { constants } from "node:fs";
import { open as fsOpen, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { send } from "./http-io.mjs";
import { claudeConfigDir } from "./claude-dir.mjs";
import { CODEX_HOME } from "./codex-dir.mjs";
import { scanAgentsMdFiles, scanClaudeMdFiles } from "./memory-files.mjs";
import { memoryScope } from "./session-enrichment.mjs";

export const MEMORY_FILE_ROUTE = "/api/session/memory-file";

/** The most bytes of one memory file the route reads. */
export const MEMORY_FILE_MAX = 256 * 1024;

const MAX_PATH = 4096;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEYS = new Set(["session", "provider", "path"]);

const loopback = req => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

const NOT_FOUND = { reason: "not_found" };

/** The request's parts, or `{ reason }` for one refused before anything is looked up. */
function memoryQuery(params) {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !KEYS.has(key))) return { reason: "bad_session" };
  const session = params.get("session");
  const provider = params.get("provider") ?? "claude";
  if (!SESSION_ID.test(session ?? "") || (provider !== "claude" && provider !== "codex")) return { reason: "bad_session" };
  const path = params.get("path");
  if (!path || path.length > MAX_PATH) return { reason: "bad_path" };
  return { session, provider, path };
}

/** The listed path the request names, or null. Exact, or `~/` for the home directory. */
function listedPath(listed, asked, home) {
  if (listed.includes(asked)) return asked;
  if (!asked.startsWith("~/")) return null;
  const expanded = join(home, asked.slice(2));
  return listed.includes(expanded) ? expanded : null;
}

/** Which kind of memory file this is, by where it sits. Auto memory first: it
 *  lives under the config dir too. */
export function memoryFileScope(path, provider, codexHome = CODEX_HOME) {
  // The scan joins the home with the file name, so the listed path is compared
  // in that spelling rather than with a home that may end in a separator.
  if (provider === "codex") return path === join(codexHome, "AGENTS.md") ? "user" : "project";
  const cfg = claudeConfigDir();
  const parts = relative(join(cfg, "projects"), path).split(sep);
  if (parts.length === 3 && parts[0] && parts[0] !== ".." && parts[1] === "memory") return "auto";
  if (dirname(path) === cfg) return "user";
  if (basename(path) === "CLAUDE.local.md") return "local";
  return "project";
}

/** The first `want` bytes of an open file; fewer when it shrank under the read. */
async function readHead(handle, want) {
  const buf = Buffer.alloc(want);
  let got = 0;
  while (got < want) {
    const { bytesRead } = await handle.read(buf, got, want - got, got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/** `buf` without a character the cut split: back to the lead byte of the last
 *  one, dropped when its continuation bytes are not all there. */
export function wholeUtf8(buf) {
  let lead = buf.length - 1;
  while (lead >= 0 && buf.length - lead <= 3 && (buf[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return buf.subarray(0, 0);
  const byte = buf[lead];
  const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return buf.length - lead >= size ? buf : buf.subarray(0, lead);
}

/**
 * The listed file's size, text and whether it was cut, or null for one this
 * route will not read. Opened first (a link is followed: CLAUDE.md -> AGENTS.md
 * is common) and non-blocking, so a pipe put in its place cannot hang the read;
 * the handle's own stat must be a regular file, and the real path must be a
 * .md file that is the same file as the one open.
 */
async function readMemoryFile(path, io) {
  const handle = await io.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return null;
    const real = await io.realpath(path);
    if (!real.toLowerCase().endsWith(".md")) return null;
    const named = await io.stat(real, { bigint: true });
    if (named.dev !== opened.dev || named.ino !== opened.ino) return null;
    const size = Number(opened.size);
    const truncated = size > MEMORY_FILE_MAX;
    const head = await readHead(handle, Math.min(size, MEMORY_FILE_MAX));
    if (head.includes(0)) return null;
    return { size, text: (truncated ? wholeUtf8(head) : head).toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}

export async function handleMemoryFile(req, res, io = {}) {
  if (!loopback(req)) return send(res, 403, { reason: "not_local" });
  if (req.method !== "GET") return send(res, 405, { reason: "method" });
  const query = memoryQuery(new URL(req.url, "http://localhost").searchParams);
  if (query.reason) return send(res, 400, { reason: query.reason });
  const { session, provider } = query;
  try {
    const scope = (io.scopeOf ?? memoryScope)(session);
    if (!scope || scope.provider !== provider) return send(res, 404, NOT_FOUND);
    const codexHome = scope.codexHome ?? CODEX_HOME;
    const files = provider === "codex"
      ? await scanAgentsMdFiles(scope.cwd, codexHome)
      : await scanClaudeMdFiles(scope.cwd);
    const path = listedPath(files.map(f => f.path), query.path, homedir());
    if (!path) return send(res, 404, NOT_FOUND);
    const read = await readMemoryFile(path, {
      open: io.open ?? fsOpen, realpath: io.realpath ?? fsRealpath, stat: io.stat ?? fsStat,
    });
    if (!read) return send(res, 404, NOT_FOUND);
    return send(res, 200, {
      path,
      name: basename(path),
      scope: memoryFileScope(path, provider, codexHome),
      bytes: read.size,
      text: read.text,
      truncated: read.truncated,
    }, { "Cache-Control": "no-store" });
  } catch {
    return send(res, 404, NOT_FOUND);
  }
}
