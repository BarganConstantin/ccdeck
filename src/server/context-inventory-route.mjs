// GET /api/session/skills?session=<id>
// GET /api/session/mcp-servers?session=<id>
// The Inspector's Context tab lists what a Claude Code session's project has
// installed, read-only. The skills: each one's name, where it is installed (the
// user's or the project's), its description and its SKILL.md's path. The MCP
// servers: each one's name, where it is configured and how Claude Code talks to
// it. The client sets both against the session's last /context, which says
// which skills are loaded and which servers were connected (context-inventory.ts).
//
// THE REQUEST NAMES A SESSION AND NOTHING ELSE. Where to look comes from the
// scope the enrichment passes noted for it (session-enrichment.mjs
// memoryScope): Claude Code's config dir and the session's working directory.
// No path, folder or file name is ever taken from the request.
//
// WHAT IS READ, AND HOW MUCH. `<config dir>/skills/*/SKILL.md` and
// `<cwd>/.claude/skills/*/SKILL.md`, at most SKILLS_MAX of them, and at most
// SKILL_FILE_MAX bytes of each. Each is opened non-blocking (a pipe put in its
// place cannot hang the read), must be a regular file, and its real path must
// be a SKILL.md that is the file that was opened. Only the frontmatter's `name`
// and `description` are kept, the description cut at DESCRIPTION_MAX
// characters. The rest of the file never leaves this module. An entry that
// cannot be read is left out without a word.
//
// For the servers, Claude Code's own state file (`.claude.json`: in the config
// dir when CLAUDE_CONFIG_DIR moves it, beside the home directory otherwise; see
// claude-login.mjs claudeGlobalConfigPath) and `<cwd>/.mcp.json`, each at most
// CLAUDE_JSON_MAX and MCP_JSON_MAX bytes, opened the same non-blocking way. A
// server's NAME, its SCOPE and its TRANSPORT are all that is kept: its command,
// arguments, environment, URL, headers and sign-in hold the user's secrets,
// and none of them is returned, logged or kept past the parse. A file over its
// cap, missing or not JSON is no servers.
//
// THE SAME GATES AS THE MEMORY-FILE ROUTE (memory-file-route.mjs): the path is
// in GUARDED_READS, a request that did not come from this computer is refused
// here as well, and everything refused once the request is well formed (a
// session the deck does not know, one that is not Claude Code's) is one 404.
import { constants } from "node:fs";
import { open as fsOpen, readdir as fsReaddir, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { send } from "./http-io.mjs";
import { claudeConfigDir } from "./claude-dir.mjs";
import { claudeGlobalConfigPath } from "./claude-login.mjs";
import { readHead, wholeUtf8 } from "./memory-file-route.mjs";
import { memoryScope } from "./session-enrichment.mjs";

export const SKILLS_ROUTE = "/api/session/skills";
export const MCP_SERVERS_ROUTE = "/api/session/mcp-servers";

/** The most skills one answer lists. */
export const SKILLS_MAX = 500;
/** The most entries of the two skills folders the scan looks into, skills or not. */
const SKILL_ENTRIES_MAX = 2 * SKILLS_MAX;
/** The most bytes of one SKILL.md read: its frontmatter is at the top. */
export const SKILL_FILE_MAX = 64 * 1024;
/** The longest description kept, in characters. */
export const DESCRIPTION_MAX = 1024;
const NAME_MAX = 128;
/** The most bytes of Claude Code's state file read: it keeps every project's
 *  history, and one past this is no servers rather than a long parse. */
export const CLAUDE_JSON_MAX = 16 * 1024 * 1024;
/** The most bytes of a project's .mcp.json read. */
export const MCP_JSON_MAX = 1024 * 1024;
/** The most servers one block of one file gives. */
const SERVERS_MAX = 200;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const loopback = req => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

const NOT_FOUND = { reason: "not_found" };

/** The session the request names, or null for a request of any other shape. */
function sessionOf(url) {
  const params = new URL(url, "http://localhost").searchParams;
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== "session") return null;
  const session = params.get("session");
  return SESSION_ID.test(session ?? "") ? session : null;
}

/** The gates every inventory route shares: this computer, GET, one session
 *  id, and a Claude Code session the deck knows. The scope, or null when the
 *  answer has already been sent. */
function gate(req, res, io) {
  if (!loopback(req)) { send(res, 403, { reason: "not_local" }); return null; }
  if (req.method !== "GET") { send(res, 405, { reason: "method" }); return null; }
  const session = sessionOf(req.url);
  if (!session) { send(res, 400, { reason: "bad_session" }); return null; }
  const scope = (io.scopeOf ?? memoryScope)(session);
  if (!scope || scope.provider !== "claude" || typeof scope.cwd !== "string" || !scope.cwd) {
    send(res, 404, NOT_FOUND);
    return null;
  }
  return scope;
}

// ─── The frontmatter ────────────────────────────────────────────────────────

/** At most `max` characters, never half a surrogate pair. */
function cap(text, max) {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** A block scalar's lines (`|` keeps the breaks, `>` folds them into spaces),
 *  without the indent the first line sets. */
function blockScalar(style, lines) {
  const first = lines.find(l => l.trim() !== "");
  if (first === undefined) return "";
  const indent = /^[ \t]*/.exec(first)[0].length;
  const body = lines.map(l => l.slice(Math.min(indent, /^[ \t]*/.exec(l)[0].length)));
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  if (style === "|") return body.join("\n");
  let out = "";
  for (const line of body) {
    if (line.trim() === "") out += "\n";
    else out += out === "" || out.endsWith("\n") ? line : ` ${line}`;
  }
  return out;
}

/** A quoted scalar, its continuation lines folded into it. */
function quotedScalar(raw, lines) {
  const text = [raw, ...lines.map(l => l.trim())].filter(Boolean).join(" ");
  const quote = text[0];
  if (quote === "'") {
    const m = /^'((?:[^']|'')*)'/.exec(text);
    return m ? m[1].replace(/''/g, "'") : text.slice(1);
  }
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return text.slice(1);
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

/** A plain scalar: its lines folded with spaces, a trailing comment dropped. */
function plainScalar(raw, lines) {
  return [raw, ...lines.map(l => l.trim())]
    .map(part => part.replace(/(^|\s+)#.*$/, "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * The `name` and `description` a SKILL.md's YAML frontmatter gives, each only
 * when it is there. Simple `key: value` lines, quoted or not, a value that runs
 * on over indented lines, and `|` / `>` blocks; nothing else of YAML is needed
 * for two strings, and a file whose frontmatter is not closed gives neither.
 */
export function skillFrontmatter(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(l));
  if (end < 0) return {};
  const body = lines.slice(1, end);
  const out = {};
  for (let i = 0; i < body.length; i++) {
    const m = /^(name|description)[ \t]*:(?:[ \t]+(.*))?$/.exec(body[i]);
    if (!m || Object.hasOwn(out, m[1])) continue;
    const raw = (m[2] ?? "").trim();
    let j = i + 1;
    while (j < body.length && (/^[ \t]/.test(body[j]) || body[j].trim() === "")) j++;
    const more = body.slice(i + 1, j);
    const block = /^([|>])[+-]?\d?[+-]?(?:\s+#.*)?$/.exec(raw);
    const value = block ? blockScalar(block[1], more)
      : raw.startsWith('"') || raw.startsWith("'") ? quotedScalar(raw, more)
        : plainScalar(raw, more);
    out[m[1]] = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
    i = j - 1;
  }
  return out;
}

// ─── The scan ───────────────────────────────────────────────────────────────

/**
 * The head of one SKILL.md as text, or null for a file this route will not
 * read: opened non-blocking, a regular file by the handle's own stat, its real
 * path a SKILL.md that is the same file as the one open, no NUL in what was read.
 */
async function readSkillHead(path, io) {
  const handle = await io.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return null;
    const real = await io.realpath(path);
    if (basename(real).toLowerCase() !== "skill.md") return null;
    const named = await io.stat(real, { bigint: true });
    if (named.dev !== opened.dev || named.ino !== opened.ino) return null;
    const size = Number(opened.size);
    const head = await readHead(handle, Math.min(size, SKILL_FILE_MAX));
    if (head.includes(0)) return null;
    return (size > SKILL_FILE_MAX ? wholeUtf8(head) : head).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * The skills installed in `roots` (`[{ dir, scope }]`), by folder name within
 * each, at most SKILLS_MAX of them; `truncated` when the scan stopped with
 * folders left to look in.
 */
export async function scanSkills(roots, io = {}) {
  const fs = { open: io.open ?? fsOpen, realpath: io.realpath ?? fsRealpath, stat: io.stat ?? fsStat, readdir: io.readdir ?? fsReaddir };
  const skills = [];
  let looked = 0;
  for (const { dir, scope } of roots) {
    let names;
    try { names = (await fs.readdir(dir)).filter(n => typeof n === "string" && !n.startsWith(".")).sort(); } catch { continue; }
    for (const name of names) {
      if (skills.length >= SKILLS_MAX || looked >= SKILL_ENTRIES_MAX) return { skills, truncated: true };
      looked += 1;
      const path = join(dir, name, "SKILL.md");
      let head = null;
      try { head = await readSkillHead(path, fs); } catch { head = null; }
      if (head === null) continue;
      const meta = skillFrontmatter(head);
      skills.push({
        name: cap(meta.name || name, NAME_MAX),
        scope,
        description: cap(meta.description ?? "", DESCRIPTION_MAX),
        path,
      });
    }
  }
  return { skills, truncated: false };
}

/** Where a session's skills are installed: the user's, then the project's,
 *  the second left out when it is the same folder (a session in the home
 *  directory with the config dir at ~/.claude). */
export function skillRoots(cwd, configDir = claudeConfigDir()) {
  const user = join(configDir, "skills");
  const project = join(cwd, ".claude", "skills");
  return resolve(user) === resolve(project)
    ? [{ dir: user, scope: "user" }]
    : [{ dir: user, scope: "user" }, { dir: project, scope: "project" }];
}

export async function handleSessionSkills(req, res, io = {}) {
  const scope = gate(req, res, io);
  if (!scope) return;
  try {
    const { skills, truncated } = await scanSkills(skillRoots(scope.cwd), io);
    return send(res, 200, { skills, truncated }, { "Cache-Control": "no-store" });
  } catch {
    return send(res, 404, NOT_FOUND);
  }
}

// ─── The MCP servers ────────────────────────────────────────────────────────

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

/** A JSON file, parsed, or null: not there, not a regular file, over `max`
 *  bytes, or not JSON. Opened non-blocking, as the skills are. */
async function readJsonCapped(path, max, io) {
  let handle;
  try { handle = await io.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > max) return null;
    const text = (await readHead(handle, st.size)).toString("utf8");
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** How Claude Code talks to a server, by its `type`, or stdio for one with a
 *  command and no type. Null for anything else. */
export function mcpTransport(config) {
  const type = typeof config.type === "string" ? config.type.trim().toLowerCase() : "";
  if (type === "stdio") return "stdio";
  if (type.startsWith("http")) return "http";
  if (type.startsWith("sse")) return "sse";
  if (type.startsWith("ws")) return "ws";
  if (!type && typeof config.command === "string") return "stdio";
  return null;
}

/** One `mcpServers` block as name, scope and transport, and nothing else of it. */
function serversIn(block, scope) {
  if (!isPlainObject(block)) return [];
  const out = [];
  for (const [name, config] of Object.entries(block)) {
    if (out.length >= SERVERS_MAX) break;
    if (!name || !isPlainObject(config)) continue;
    out.push({ name: cap(name, NAME_MAX), scope, transport: mcpTransport(config) });
  }
  return out;
}

/** The state file's entry for the working directory, written as Claude Code
 *  keys it (forward slashes on Windows too). */
function projectEntry(projects, cwd) {
  if (!isPlainObject(projects)) return null;
  for (const key of new Set([cwd, cwd.replace(/\\/g, "/")])) {
    if (Object.hasOwn(projects, key) && isPlainObject(projects[key])) return projects[key];
  }
  return null;
}

/**
 * The servers configured for a project: the user's (`mcpServers` at the top of
 * the state file), the local ones (`projects[<cwd>].mcpServers` in the same
 * file) and the project's (`<cwd>/.mcp.json`). One row a name, the one Claude
 * Code uses when a name is set in more than one place: local, then project,
 * then user. By name.
 */
export async function scanMcpServers(cwd, io = {}) {
  const fs = { open: io.open ?? fsOpen };
  const statePath = await (io.statePath ?? claudeGlobalConfigPath)();
  const state = await readJsonCapped(statePath, CLAUDE_JSON_MAX, fs);
  const shared = await readJsonCapped(join(cwd, ".mcp.json"), MCP_JSON_MAX, fs);
  const local = serversIn(projectEntry(isPlainObject(state) ? state.projects : null, cwd)?.mcpServers, "local");
  const project = serversIn(isPlainObject(shared) ? shared.mcpServers : null, "project");
  const user = serversIn(isPlainObject(state) ? state.mcpServers : null, "user");
  const byName = new Map();
  for (const server of [...local, ...project, ...user]) if (!byName.has(server.name)) byName.set(server.name, server);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function handleSessionMcpServers(req, res, io = {}) {
  const scope = gate(req, res, io);
  if (!scope) return;
  try {
    const servers = await scanMcpServers(scope.cwd, io);
    return send(res, 200, { servers }, { "Cache-Control": "no-store" });
  } catch {
    return send(res, 404, NOT_FOUND);
  }
}
