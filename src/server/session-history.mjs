import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
import { claudeTranscriptRoots } from "./transcript-gate.mjs";
import { rolloutNameId } from "./codex-dir.mjs";
import { sessionMeta } from "./codex-translate.mjs";
import { readCodexNames } from "./codex-names.mjs";
import { readCodexSelection } from "./codex-selection.mjs";
import { deckNameFor } from "./session-deck-names.mjs";
import { send } from "./http-io.mjs";

export const SESSION_HISTORY_ROUTE = "/api/session/history";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_FILES = 2000;
const MAX_ENTRIES = 20000;
const PAGE = 30;
const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const clean = value => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160) : "";
const canonical = path => realpath(path).catch(() => null);
const activeClaudeRoot = () => join(claudeConfigDir(), "projects");

// The terminal engine inherits the deck's Codex home. When a different
// profile is selected, do not silently resume any rollout under the wrong login.
async function activeCodexHome(selection) {
  return selection?.available && selection.home === selection.originalHome ? canonical(selection.originalHome) : null;
}

async function* directories(root, depth, accept, budget) {
  if (budget.entries <= 0) return;
  if (depth === 0) { yield root; return; }
  let handle;
  try { handle = await opendir(root); } catch { return; }
  const next = [];
  try {
    for await (const entry of handle) {
      if (--budget.entries < 0) break;
      if (entry.isDirectory() && accept(entry.name)) next.push(entry.name);
    }
  } catch { /* A directory can disappear after a scan starts. */ }
  for (const name of next.sort().reverse()) {
    yield* directories(join(root, name), depth - 1, accept, budget);
  }
}

async function collect(root, provider, source, budget, files) {
  const base = await canonical(root);
  if (!base) return;
  const accept = provider === "codex" ? name => /^\d{2}(?:\d{2})?$/.test(name) : () => true;
  for await (const dir of directories(base, provider === "codex" ? 3 : 1, accept, budget)) {
    let handle;
    try {
      if (await canonical(dir) !== dir) continue;
      handle = await opendir(dir);
    } catch { continue; }
    try {
      for await (const entry of handle) {
        if (--budget.entries < 0) return;
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const id = provider === "codex" ? rolloutNameId(entry.name) : entry.name.slice(0, -6);
        if (!id || !UUID.test(id)) continue;
        const path = join(dir, entry.name);
        const info = await lstat(path).catch(() => null);
        if (!info?.isFile() || info.nlink !== 1) continue;
        files.push({ provider, id: id.toLowerCase(), path, info, source });
      }
    } catch { /* Keep the rows found before a directory disappeared. */ }
  }
}

async function bytes(file, stat, offset, size) {
  const buffer = Buffer.alloc(size);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
  const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
  if (offset) lines.shift();
  if (offset + bytesRead < stat.size) lines.pop();
  return lines;
}

function json(line) {
  try { return JSON.parse(line); } catch { return null; }
}

async function metadata(candidate, codexNames) {
  const { provider, id, info, path } = candidate;
  let file;
  try {
    if (await canonical(dirname(path)) !== dirname(path)) return null;
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const current = await file.stat();
    if (!current.isFile() || current.nlink !== 1 || current.ino !== info.ino || current.dev !== info.dev) return null;
    const head = await bytes(file, current, 0, Math.min(HEAD_BYTES, current.size));
    let cwd, title;
    if (provider === "claude") {
      const tailStart = Math.max(0, current.size - TAIL_BYTES);
      const tail = current.size > HEAD_BYTES ? await bytes(file, current, tailStart, current.size - tailStart) : [];
      for (const line of [...head, ...tail]) {
        const row = json(line);
        if (row?.sessionId?.toLowerCase?.() !== id) continue;
        if (row.type === "custom-title") title = clean(row.customTitle) || title;
        if (!cwd && typeof row.cwd === "string" && isAbsolute(row.cwd)) cwd = row.cwd;
      }
    } else {
      const meta = head.map(json).map(sessionMeta).find(row => row?.id?.toLowerCase?.() === id);
      cwd = meta?.cwd;
      title = codexNames?.get(id);
    }
    if (typeof cwd !== "string" || cwd.length > 4096 || cwd.includes("\0") || !isAbsolute(cwd)) return null;
    return { provider, id, cwd, title: deckNameFor(provider, id) ?? title ?? (basename(cwd) || cwd), updatedAt: info.mtimeMs };
  } catch { return null; }
  finally { await file?.close(); }
}

/** A short-lived metadata snapshot, independent of the live board and its event log. */
export function createSessionHistoryReader({
  claudeRoots = claudeTranscriptRoots,
  selection = readCodexSelection,
  readNames = readCodexNames,
  activeClaude = activeClaudeRoot,
  now = Date.now,
} = {}) {
  let snapshot;
  let expires = 0;
  async function scan() {
    const files = [], roots = await claudeRoots();
    const claudeActive = await canonical(activeClaude());
    const codex = await selection().catch(() => null);
    const codexHome = await activeCodexHome(codex);
    const claudeBudget = { entries: MAX_ENTRIES }, codexBudget = { entries: MAX_ENTRIES };
    const seenRoots = new Set();
    for (const root of roots) {
      const base = await canonical(root);
      if (!base || seenRoots.has(base)) continue;
      seenRoots.add(base);
      await collect(base, "claude", { canResume: base === claudeActive }, claudeBudget, files);
    }
    seenRoots.clear();
    for (const home of codex?.homes?.slice(0, 32) ?? []) {
      const base = await canonical(home);
      if (!base || seenRoots.has(base)) continue;
      seenRoots.add(base);
      await collect(join(base, "sessions"), "codex", { home: base, canResume: base === codexHome }, codexBudget, files);
    }
    files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || a.id.localeCompare(b.id));
    const names = new Map();
    const rows = new Map();
    for (const file of files.slice(0, MAX_FILES)) {
      const key = `${file.provider}:${file.id}`;
      if (rows.get(key)?.available) continue;
      const home = file.source.home;
      if (home && !names.has(home)) names.set(home, await readNames(home));
      const row = await metadata(file, names.get(home));
      if (!row || (rows.has(key) && !file.source.canResume)) continue;
      rows.set(key, { ...row, available: file.source.canResume, root: file.source.home ?? claudeActive, path: file.path, ino: file.info.ino, dev: file.info.dev });
    }
    return { rows: [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt), limited: files.length > MAX_FILES || claudeBudget.entries <= 0 || codexBudget.entries <= 0 };
  }
  return () => {
    if (!snapshot || now() >= expires) {
      expires = Infinity;
      snapshot = scan().finally(() => { expires = now() + 15_000; });
    }
    return snapshot;
  };
}

const readHistory = createSessionHistoryReader();
export async function canResumeSavedSession(req, ref, { read = readHistory, selection = readCodexSelection } = {}) {
  if (!LOCAL.has(req.socket.remoteAddress)) return false;
  const { rows } = await read();
  const match = rows.find(row => row.provider === ref.provider && row.id === ref.sessionId && row.cwd === ref.cwd);
  if (!match?.available) return false;
  const current = ref.provider === "codex"
    ? await activeCodexHome(await selection().catch(() => null))
    : await canonical(activeClaudeRoot());
  if (current === null || current !== match.root || await canonical(dirname(match.path)) !== dirname(match.path)) return false;
  const info = await lstat(match.path).catch(() => null);
  return !!info?.isFile() && info.nlink === 1 && info.ino === match.ino && info.dev === match.dev;
}

export async function handleSessionHistory(req, res, url, { read = readHistory, check = stat } = {}) {
  if (!LOCAL.has(req.socket.remoteAddress)) return send(res, 403, { ok: false });
  const provider = url.searchParams.get("provider") ?? "all";
  const query = clean(url.searchParams.get("q")).toLowerCase();
  const offset = Number(url.searchParams.get("offset") ?? "0");
  if (!["all", "claude", "codex"].includes(provider) || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FILES) {
    return send(res, 400, { ok: false });
  }
  const { rows, limited } = await read();
  const match = rows.filter(row => (provider === "all" || row.provider === provider)
    && (!query || row.title.toLowerCase().includes(query) || row.cwd.toLowerCase().includes(query)));
  const page = await Promise.all(match.slice(offset, offset + PAGE).map(async ({ available, root: _root, path: _path, ino: _ino, dev: _dev, ...row }) => ({
    ...row, unavailable: !available ? "profile" : await check(row.cwd).then(info => info.isDirectory(), () => false) ? null : "folder",
  })));
  return send(res, 200, { ok: true, rows: page, next: offset + PAGE < match.length ? offset + PAGE : null, limited });
}
